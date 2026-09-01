// ===========================================
// Setup wizard — interactive runner + real dependency wiring
// ===========================================
// The prompt layer over setup-wizard.ts's pure decision flow. Kept in a
// sibling so the composition contract stays unit-testable (setup-wizard.test.ts
// pins order/arguments through the deps seam) while this file owns the two
// things tests cannot: readline and the real commands.
//
// Every question is one line + a recommended default; Enter accepts. The
// whole flow is the ~90-second budget the onboarding directive set — a user
// who accepts all six decisions gets the recommended install (all detected
// runners, strict mode, diff scope, shipped caps, adopt now, local-only).

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { formatMetricDefaultRow, METRIC_DEFS } from "../harness/metric-caps.js";
import { ALL_PRESETS } from "../harness/modes.js";
import { c } from "../lib/formatter.js";
import { detectClients } from "../lib/settings.js";
import { adoptCommand } from "./adopt.js";
import { capsSetAction } from "./caps.js";
import { enableCommand } from "./enable.js";
import { modeCommand } from "./mode.js";
import {
	applyWizardChoices,
	describePostureReceipt,
	choicesFromNonInteractive,
	DEFAULT_WIZARD_CHOICES,
	describeWizardPlan,
	moveSelection,
	parseWizardCapOverrides as parseCapOverrides,
	parseWizardYesNo as parseYesNo,
	WIZARD_COPY,
	type WizardChoices,
	type WizardDeadCode,
	type WizardDeps,
	type WizardMode,
	writeDeadCodeConfig,
	writeScopeConfig,
} from "./setup-wizard.js";

/** The real composition: each step is the command that owns that decision. */
export function realWizardDeps(): WizardDeps {
	return {
		enable: (opts) => enableCommand(opts),
		// --force: the wizard already confirmed the whole plan in one place; a
		// second per-step confirmation inside `mode` would double-ask.
		applyMode: (name) => modeCommand(name, { force: true }),
		setCap: async (metric, value) => {
			await capsSetAction(metric, String(value), {});
		},
		adopt: () => adoptCommand({}),
		writeScope: writeScopeConfig,
		writeDeadCode: writeDeadCodeConfig,
	};
}

// parseYesNo / parseCapOverrides live in setup-wizard.ts (parseWizardYesNo /
// parseWizardCapOverrides) so the browser demo executes the same rules.

/**
 * Arrow-key single-select over `items`, rendered in place (ANSI cursor-up
 * rewrites). ↑/↓ move with wrap-around via the shared {@link moveSelection}
 * (the browser demo runs the SAME function, so navigation cannot drift);
 * Enter confirms; a letter jumps to the first item whose label starts with
 * it; Ctrl+C exits like readline would. Non-TTY stdin falls back to the
 * caller's text prompt so scripted runs keep working.
 *
 * MANUAL PROBE (needs a real TTY): run `interlinked` in an unconfigured repo
 * and drive step 2 with the arrow keys; the highlighted row must wrap
 * top↔bottom and Enter must pick the highlighted row, not the default.
 */
async function selectFromList(args: {
	labels: string[];
	renderLine: (index: number, selected: boolean) => string;
	initial: number;
}): Promise<number> {
	const { labels, renderLine, initial } = args;
	const draw = (sel: number, first: boolean): void => {
		if (!first) process.stdout.write(`\x1b[${labels.length}A`);
		for (let i = 0; i < labels.length; i++) {
			process.stdout.write(`\x1b[2K${renderLine(i, i === sel)}\n`);
		}
	};
	return new Promise((resolvePick) => {
		let sel = initial;
		draw(sel, true);
		process.stdout.write(c.dim(`   ${WIZARD_COPY.selectHint}\n`));
		// `@types/node` types `process.stdin` as `tty.ReadStream`, which
		// declares `setRawMode` required — but at runtime stdin is a plain
		// `net.Socket` (no `setRawMode`) whenever it isn't a real TTY (piped
		// input, CI, non-interactive test runs). Re-type it honestly here so
		// the `?.` guards below stay meaningful instead of reading as dead code.
		const stdin: Omit<NodeJS.ReadStream, "setRawMode"> & {
			setRawMode?: (mode: boolean) => NodeJS.ReadStream;
		} = process.stdin;
		const wasRaw = stdin.isRaw === true;
		stdin.setRawMode?.(true);
		stdin.resume();
		const onData = (buf: Buffer): void => {
			const s = buf.toString("utf-8");
			const finish = (): void => {
				stdin.removeListener("data", onData);
				stdin.setRawMode?.(wasRaw);
				resolvePick(sel);
			};
			if (s === "\r" || s === "\n") return finish();
			if (s === "\x03") {
				stdin.setRawMode?.(wasRaw);
				process.exit(130);
			}
			let next = sel;
			if (s === "\x1b[A") next = moveSelection(sel, -1, labels.length);
			else if (s === "\x1b[B") next = moveSelection(sel, 1, labels.length);
			else if (/^[a-z]$/i.test(s)) {
				const hit = labels.findIndex((l) => l.toLowerCase().startsWith(s.toLowerCase()));
				if (hit >= 0) next = hit;
			}
			if (next !== sel) {
				sel = next;
				process.stdout.write("\x1b[1A"); // step back over the hint line
				draw(sel, false);
				process.stdout.write(c.dim(`   ${WIZARD_COPY.selectHint}\n`));
			}
		};
		stdin.on("data", onData);
	});
}

/** Render one mode row; shared shape between initial paint and re-paints. */
function modeRow(index: number, selected: boolean): string {
	const p = ALL_PRESETS[index];
	if (!p) return "";
	const name = p.name.padEnd(9);
	const marker = selected ? c.green("› ") : "  ";
	return `  ${marker}${selected ? c.green(name) : name} ${c.dim(p.description)}`;
}

const SCOPE_LABELS: string[] = ["diff", "whole-file"];

/** Render one scope row from the single-sourced copy. */
function scopeRow(index: number, selected: boolean): string {
	const label = index === 0 ? "diff      " : "whole-file";
	const detail =
		index === 0 ? WIZARD_COPY.steps.scope.diffLine : WIZARD_COPY.steps.scope.wholeFileLine;
	const marker = selected ? c.green("› ") : "  ";
	return `  ${marker}${selected ? c.green(label) : label} ${c.dim(detail)}`;
}

/** Arrow selection needs a real TTY with raw-mode support. */
function canArrowSelect(): boolean {
	return Boolean(process.stdin.isTTY) && typeof process.stdin.setRawMode === "function";
}

async function askModeSelect(choices: WizardChoices): Promise<void> {
	const initial = Math.max(
		0,
		ALL_PRESETS.findIndex((p) => p.name === DEFAULT_WIZARD_CHOICES.mode),
	);
	const picked = await selectFromList({
		labels: ALL_PRESETS.map((p) => p.name),
		renderLine: modeRow,
		initial,
	});
	const preset = ALL_PRESETS[picked];
	// SAFETY: preset names are the WizardMode union (ALL_PRESETS is its source).
	if (preset) choices.mode = preset.name as WizardMode;
}

async function askModeTyped(rl: AskInterface, choices: WizardChoices): Promise<void> {
	for (let i = 0; i < ALL_PRESETS.length; i++) console.log(modeRow(i, false));
	const raw = await rl.question(WIZARD_COPY.steps.mode.prompt(DEFAULT_WIZARD_CHOICES.mode));
	const v = raw.trim().toLowerCase();
	// SAFETY: membership in ALL_PRESETS (whose names are the WizardMode union)
	// is checked on the same value before the narrow.
	if (ALL_PRESETS.some((p) => p.name === v)) choices.mode = v as WizardMode;
}


async function askRunners(rl: AskInterface, cwd: string, choices: WizardChoices): Promise<void> {
	const detected = detectClients(cwd).filter((cl) => cl.exists);
	if (detected.length === 0) {
		console.log(
			`${WIZARD_COPY.steps.runners.n}) ${c.dim(WIZARD_COPY.steps.runners.noneDetected)}`,
		);
		return;
	}
	const detectedNames = detected.map((cl) => cl.name);
	console.log(
		`${WIZARD_COPY.steps.runners.n}) ${WIZARD_COPY.steps.runners.title}  ${c.dim(`${WIZARD_COPY.steps.runners.detectedPrefix}${detectedNames.join(", ")}`)}`,
	);
	const raw = await rl.question(WIZARD_COPY.steps.runners.prompt(detectedNames));
	const v = raw.trim();
	if (v && !/^(y|yes)$/i.test(v)) {
		choices.runners = v
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}
}

async function askMode(rl: AskInterface, choices: WizardChoices): Promise<void> {
	console.log(`${WIZARD_COPY.steps.mode.n}) ${WIZARD_COPY.steps.mode.title}`);
	if (canArrowSelect()) return askModeSelect(choices);
	return askModeTyped(rl, choices);
}

async function askScope(rl: AskInterface, choices: WizardChoices): Promise<void> {
	console.log(`${WIZARD_COPY.steps.scope.n}) ${WIZARD_COPY.steps.scope.title}`);
	if (canArrowSelect()) {
		const picked = await selectFromList({ labels: SCOPE_LABELS, renderLine: scopeRow, initial: 0 });
		if (SCOPE_LABELS[picked] === "whole-file") choices.scope = "whole-file";
		return;
	}
	console.log(scopeRow(0, false));
	console.log(scopeRow(1, false));
	const raw = await rl.question(WIZARD_COPY.steps.scope.prompt);
	if (raw.trim().toLowerCase() === "whole-file") choices.scope = "whole-file";
}

async function askCaps(rl: AskInterface, choices: WizardChoices): Promise<void> {
	console.log(`${WIZARD_COPY.steps.caps.n}) ${WIZARD_COPY.steps.caps.title}`);
	for (const d of METRIC_DEFS) {
		console.log(`    ${formatMetricDefaultRow(d)}`);
	}
	const raw = await rl.question(WIZARD_COPY.steps.caps.prompt);
	const v = raw.trim();
	if (v && !/^(y|yes)$/i.test(v)) choices.caps = parseCapOverrides(v);
}

async function askAdopt(rl: AskInterface, choices: WizardChoices): Promise<void> {
	console.log(`${WIZARD_COPY.steps.adopt.n}) ${WIZARD_COPY.steps.adopt.title}`);
	console.log(c.dim(`   ${WIZARD_COPY.steps.adopt.detail}`));
	const raw = await rl.question(WIZARD_COPY.steps.adopt.prompt);
	choices.adopt = parseYesNo(raw, true);
}

const DEADCODE_OPTIONS: readonly WizardDeadCode[] = ["flag", "delete", "off"];

function deadcodeRow(index: number, selected: boolean): string {
	const copy = WIZARD_COPY.steps.deadcode;
	const line = [copy.flagLine, copy.deleteLine, copy.offLine][index] ?? "";
	return selected ? c.bold(`  ▸ ${line}`) : `    ${line}`;
}

async function askDeadCode(rl: AskInterface, choices: WizardChoices): Promise<void> {
	console.log(`${WIZARD_COPY.steps.deadcode.n}) ${WIZARD_COPY.steps.deadcode.title}`);
	if (canArrowSelect()) {
		const picked = await selectFromList({
			labels: DEADCODE_OPTIONS as string[],
			renderLine: deadcodeRow,
			initial: 0,
		});
		choices.deadCode = DEADCODE_OPTIONS[picked] ?? "flag";
		return;
	}
	console.log(deadcodeRow(0, false));
	console.log(deadcodeRow(1, false));
	console.log(deadcodeRow(2, false));
	const raw = await rl.question(WIZARD_COPY.steps.deadcode.prompt);
	const v = raw.trim().toLowerCase();
	if (v === "delete" || v === "off") choices.deadCode = v;
}

/** The readline slice the questions consume — injectable in principle. */
interface AskInterface {
	question(prompt: string): Promise<string>;
}

/**
 * The interactive flow: five questions, plan confirmation, apply, next steps.
 * Composes only through {@link applyWizardChoices} so behavior stays identical
 * to the tested path.
 */
export async function runSetupWizardInteractive(cwd: string = process.cwd()): Promise<void> {
	console.log(c.bold(WIZARD_COPY.banner));
	console.log(c.dim(`${WIZARD_COPY.bannerHint}\n`));

	const rl = createInterface({ input, output });
	const choices: WizardChoices = { ...DEFAULT_WIZARD_CHOICES, caps: {} };
	try {
		await askRunners(rl, cwd, choices);
		await askMode(rl, choices);
		await askScope(rl, choices);
		await askCaps(rl, choices);
		await askAdopt(rl, choices);
		await askDeadCode(rl, choices);

		console.log(`\n${c.bold(WIZARD_COPY.planHeader)}`);
		for (const line of describeWizardPlan(choices)) console.log(line);
		const goRaw = await rl.question(WIZARD_COPY.applyPrompt);
		if (!parseYesNo(goRaw, true)) {
			console.log(WIZARD_COPY.aborted);
			return;
		}
	} finally {
		rl.close();
	}

	const result = await applyWizardChoices(cwd, choices, realWizardDeps());
	for (const failure of result.failures) {
		console.log(c.yellow(`  step failed (re-runnable): ${failure}`));
	}

	console.log(c.green(`\n${WIZARD_COPY.complete}`));
	console.log(`\n${c.bold(WIZARD_COPY.receiptHeader)}`);
	for (const line of describePostureReceipt(choices)) console.log(c.dim(line));
	console.log(`\n${c.bold(WIZARD_COPY.tourHeader)}`);
	for (const line of WIZARD_COPY.tour) console.log(c.dim(line));
	const [firstStep, ...restSteps] = WIZARD_COPY.nextSteps;
	console.log(`\n${firstStep}`);
	for (const line of restSteps) console.log(c.dim(line));
}

/** Non-TTY bootstrap: env-driven, never prompts, never fails on bad input. */
export async function runSetupWizardNonInteractive(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): Promise<void> {
	const choices = choicesFromNonInteractive({
		...(env.INTERLINKED_MODE !== undefined && { mode: env.INTERLINKED_MODE }),
		...(env.INTERLINKED_SCOPE !== undefined && { scope: env.INTERLINKED_SCOPE }),
		...(env.INTERLINKED_ADOPT !== undefined && { adopt: env.INTERLINKED_ADOPT }),
		...(env.INTERLINKED_CLIENTS !== undefined && { runners: env.INTERLINKED_CLIENTS }),
		...(env.INTERLINKED_SYNC_MODE !== undefined && { syncMode: env.INTERLINKED_SYNC_MODE }),
	});
	console.log(c.dim("[interlinked] No config found. Bootstrapping (local-first defaults)…"));
	const result = await applyWizardChoices(cwd, choices, realWizardDeps());
	for (const failure of result.failures) {
		console.log(c.yellow(`[interlinked] step failed (re-runnable): ${failure}`));
	}
	console.log(c.dim(`[interlinked] ${WIZARD_COPY.receiptHeader}`));
	for (const line of describePostureReceipt(choices)) console.log(c.dim(line));
	console.log(c.dim(`[interlinked] ${WIZARD_COPY.tourHeader}`));
	for (const line of WIZARD_COPY.tour) console.log(c.dim(line));
}
