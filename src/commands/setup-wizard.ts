// ===========================================
// Setup wizard — the harness-first onboarding decision flow
// ===========================================
// The product a new user is adopting is the LOCAL HARNESS (CLAUDE.md Goal 1),
// but the legacy first-run wizard asked only server-era questions (URL, sync,
// login) and silently inherited every opinionated default. This module is the
// decision surface: four questions that define how the harness treats the
// repo — runners, enforcement mode, review scope, caps — plus the brownfield
// floor (`adopt`). It COMPOSES the existing single-purpose machinery
// (`enable`, `mode`, `caps set`, `adopt`) rather than re-implementing any of
// it: each answer routes to the command a user would later use to change that
// answer, so the wizard teaches its own escape hatches.
//
// Operator directive (2026-08-16): onboarding must let people "simply and
// quickly make the decisions for how they want the agent to work the codebase
// going forward, including but not limited to hooks." Time budget ~90s; Enter
// accepts the recommended default at every step; a failing step reports and
// continues (a half-onboarded repo with hooks installed beats an aborted
// wizard — every step is individually re-runnable).
//
// Local-first: the sync default here is "local" (offline-only). The remote
// server is dormant (CLAUDE.md: "the local harness is the product") and a new
// adopter should never be asked to think about it — `interlinked login` /
// `enable --server` remain for the users who want it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { METRIC_DEFS } from "../harness/metric-caps.js";
import { getPreset } from "../harness/modes.js";
import { DEFAULT_STRUCTURAL_CHECKS } from "../harness/rules/default-structural.js";
import { mergeIntoGuardRules } from "../harness/rules/guard-rules-write.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";

/** The review-scope decision: judge only the edited region, or whole files. */
export type WizardScope = "diff" | "whole-file";

/** The dead-code decision (operator directive 2026-08-17): "flag" reports
 *  unused imports/exports on every edit (default), "delete" additionally
 *  instructs the agent to remove them, "off" disables the per-edit checks.
 *  The whole-repo sweep is always available as `interlinked deadcode`. */
export type WizardDeadCode = "flag" | "delete" | "off";

/** Enforcement-mode names accepted by the wizard (mirrors harness/modes.ts). */
const WIZARD_MODES = ["strict", "lenient", "balanced"] as const;
export type WizardMode = (typeof WIZARD_MODES)[number];

export function parseWizardMode(value: unknown): WizardMode | undefined {
	return WIZARD_MODES.find((mode) => mode === value);
}

export interface WizardChoices {
	/** Runner client ids to hook, or null = every detected client. */
	runners: string[] | null;
	mode: WizardMode;
	scope: WizardScope;
	/** Cap overrides by `interlinked caps` metric key; empty = ship defaults. */
	caps: Record<string, number>;
	/** Seed tighten-only baselines from the repo's current state (brownfield). */
	adopt: boolean;
	/** Per-edit dead-code posture; the repo sweep stays a separate verb. */
	deadCode: WizardDeadCode;
	/** Sync mode passed to enable; local-first by design (server is dormant). */
	syncMode: "local" | "realtime" | "manual";
}

export const DEFAULT_WIZARD_CHOICES: WizardChoices = {
	runners: null,
	mode: "strict",
	scope: "diff",
	caps: {},
	adopt: true,
	deadCode: "flag",
	syncMode: "local",
};

/** Injected-deps seam: each step is the existing command it composes, so tests
 *  pin the composition (order + arguments) without mocking modules. */
export interface WizardDeps {
	enable: (opts: { clients?: string; syncMode: string }) => Promise<void>;
	applyMode: (name: WizardMode) => Promise<void>;
	setCap: (metric: string, value: number) => Promise<void>;
	adopt: () => Promise<void>;
	writeScope: (cwd: string, scope: WizardScope) => void;
	writeDeadCode: (cwd: string, action: WizardDeadCode) => void;
}

export interface WizardApplyResult {
	/** Human-readable step failures; the wizard continues past each. */
	failures: string[];
}

/**
 * Apply the decisions, each step independently: enable (hooks) → mode →
 * scope → caps → adopt. Caps run BEFORE adopt on purpose — adopt seeds
 * baselines against the caps in force, so a user who tightened `lines` gets
 * a grandfather list computed against their number, not ours. A throwing
 * step is recorded and the remaining steps still run: every step is
 * individually re-runnable afterward, so partial progress is strictly
 * better than none.
 */
export async function applyWizardChoices(
	cwd: string,
	choices: WizardChoices,
	deps: WizardDeps,
): Promise<WizardApplyResult> {
	const failures: string[] = [];
	const step = async (label: string, run: () => Promise<void> | void): Promise<void> => {
		try {
			await run();
		} catch (err) {
			failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	await step("enable (hooks)", () =>
		deps.enable({
			...(choices.runners && choices.runners.length > 0
				? { clients: choices.runners.join(",") }
				: {}),
			syncMode: choices.syncMode,
		}),
	);
	await step("mode", () => deps.applyMode(choices.mode));
	await step("scope", () => deps.writeScope(cwd, choices.scope));
	await step("dead code", () => deps.writeDeadCode(cwd, choices.deadCode));
	for (const [metric, value] of Object.entries(choices.caps)) {
		await step(`cap ${metric}`, () => deps.setCap(metric, value));
	}
	if (choices.adopt) {
		await step("adopt (baseline floor)", () => deps.adopt());
	}
	return { failures };
}

/**
 * Write the review-scope decision into `.interlinked/guard-rules.json`
 * (shared, committed — the same file the daemon's rules loader merges).
 * Merge-preserving: only `diff_aware.enabled` moves; every other key —
 * including a nested pre-existing `diff_aware` sub-setting — survives.
 */
export function writeScopeConfig(cwd: string, scope: WizardScope): void {
	// Delegates to the ONE merge-preserving guard-rules.json writer (2026-08-17
	// — this function used to carry its own merge and the policy-drift check
	// caught the clone). Contract change with the delegation: a MALFORMED
	// existing file now refuses and throws (preserving the evidence for the
	// user) instead of rewriting cleanly; the wizard's per-step failure report
	// surfaces the thrown message and every step stays re-runnable.
	const r = mergeIntoGuardRules(cwd, { diff_aware: { enabled: scope === "diff" } });
	if (!r.ok) throw new Error(`scope not written: ${r.error}`);
}

/** True when the shared guard-rules.json already runs the FULL structural
 *  family — then the dead-code write must not scope its siblings off. */
function sharedStructuralFamilyOn(cwd: string): boolean {
	const path = join(cwd, ".interlinked", "guard-rules.json");
	if (!existsSync(path)) return false;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isJsonObject(parsed) || !isJsonObject(parsed.structural_checks)) return false;
		return parsed.structural_checks.enabled === true;
	} catch (err) {
		void err; // malformed file → treat as family-off; the merge writer reports it
		return false;
	}
}

/** The structural_checks patch for one dead-code posture. Enabling dead-code
 *  detection must NOT drag in the other ~25 structural checks (their latency
 *  and volume are a separate decision), so when the family is currently off,
 *  every other boolean sub-check is pinned false — derived from
 *  DEFAULT_CONFIG live, so a future check is covered automatically. */
function deadCodePatch(cwd: string, action: WizardDeadCode): JsonObject {
	if (action === "off") {
		return { structural_checks: { dead_imports: false, dead_exports: false } };
	}
	const structural: JsonObject = {};
	if (!sharedStructuralFamilyOn(cwd)) {
		const keep = new Set(["enabled", "dead_imports", "dead_exports"]);
		for (const [key, value] of Object.entries(DEFAULT_STRUCTURAL_CHECKS)) {
			if (typeof value === "boolean" && !keep.has(key)) structural[key] = false;
		}
	}
	structural.enabled = true;
	structural.dead_imports = true;
	structural.dead_exports = true;
	structural.dead_code_action = action;
	return { structural_checks: structural };
}

/** Write the dead-code posture into the shared guard-rules.json (the per-edit
 *  half; the whole-repo sweep stays the separate `interlinked deadcode`). */
export function writeDeadCodeConfig(cwd: string, action: WizardDeadCode): void {
	const r = mergeIntoGuardRules(cwd, deadCodePatch(cwd, action));
	if (!r.ok) throw new Error(`dead-code posture not written: ${r.error}`);
}

/**
 * Arrow-key selection movement shared by the terminal runner and the browser
 * demo: wrap-around in both directions, clamped to the list. Single-sourced
 * so the two surfaces cannot disagree about how ↑/↓ behave.
 */
// interlinked: defer same_typed_primitive_params -- (index, delta, length) is the idiomatic signature for modular index math; a struct param would obscure the two call sites (TUI keyhandler, demo keydown)
export function moveSelection(index: number, delta: number, length: number): number {
	if (length <= 0) return 0;
	return (((index + delta) % length) + length) % length;
}

/** Yes/no answer parsing shared by the terminal runner and the browser demo —
 *  exported so both surfaces execute the SAME acceptance rules. */
export function parseWizardYesNo(raw: string, defaultValue: boolean): boolean {
	const v = raw.trim().toLowerCase();
	if (!v) return defaultValue;
	if (["y", "yes", "1", "true"].includes(v)) return true;
	if (["n", "no", "0", "false"].includes(v)) return false;
	return defaultValue;
}

/** Parse "cyclomatic=15,lines=400"-style cap overrides; invalid pairs drop.
 *  Shared by the terminal runner and the browser demo (single-source rule). */
export function parseWizardCapOverrides(raw: string): Record<string, number> {
	const caps: Record<string, number> = {};
	for (const pair of raw.split(",")) {
		const [k, val] = pair.split("=").map((s) => s.trim());
		const n = Number(val);
		if (k && Number.isFinite(n)) caps[k] = n;
	}
	return caps;
}

/** Non-interactive mapping (flags/env → choices). Unknown values degrade to
 *  the recommended defaults — a non-TTY bootstrap must never fail on input. */
export function choicesFromNonInteractive(
	raw: Partial<Record<"mode" | "scope" | "adopt" | "runners" | "syncMode" | "deadCode", string>>,
): WizardChoices {
	const mode = parseWizardMode(raw.mode) ?? DEFAULT_WIZARD_CHOICES.mode;
	const scope: WizardScope =
		raw.scope === "diff" || raw.scope === "whole-file" ? raw.scope : DEFAULT_WIZARD_CHOICES.scope;
	const adopt =
		raw.adopt === undefined ? DEFAULT_WIZARD_CHOICES.adopt : !/^(false|no|0)$/i.test(raw.adopt);
	const runners = raw.runners
		? raw.runners
				.split(",")
				.map((r) => r.trim())
				.filter((r) => r.length > 0)
		: null;
	const syncMode =
		raw.syncMode === "realtime" || raw.syncMode === "manual"
			? raw.syncMode
			: DEFAULT_WIZARD_CHOICES.syncMode;
	const deadCode: WizardDeadCode =
		raw.deadCode === "delete" || raw.deadCode === "off"
			? raw.deadCode
			: DEFAULT_WIZARD_CHOICES.deadCode;
	return { runners, mode, scope, caps: {}, adopt, deadCode, syncMode };
}

/**
 * Every user-facing string the wizard renders, in one exported structure.
 * SINGLE-SOURCE CONTRACT (2026-08-16, operator drift requirement): the
 * terminal runner (setup-wizard-run.ts) renders its prompts FROM this object,
 * and the browser demo generator (scripts/gen-onboarding-demo.mts) bundles
 * this same module — so the demo and the TUI cannot disagree on copy without
 * one of them failing its tests. Add or change wizard text HERE only.
 */
export const WIZARD_COPY = {
	banner: "Interlinked setup — 6 quick decisions",
	bannerHint: "Enter accepts the recommended default at every step.",
	selectHint: "↑/↓ choose · Enter confirm",
	steps: {
		runners: {
			n: 1,
			title: "Agent runners to hook",
			detectedPrefix: "detected: ",
			prompt: (ids: string[]) => `   Hook all detected? [Y] or list ids (${ids.join(",")}): `,
			noneDetected:
				"No agent runners detected — hooks install when one appears (interlinked enable).",
		},
		mode: {
			n: 2,
			title: "Enforcement mode:",
			prompt: (recommended: string) => `   Mode [${recommended}]: `,
		},
		scope: {
			n: 3,
			title: "Review scope:",
			diffLine: "judge only what the agent changes (recommended)",
			wholeFileLine: "judge every touched file in full — stricter, noisier on legacy code",
			prompt: "   Scope [diff]: ",
		},
		caps: {
			n: 4,
			title: "Quality caps + coverage goal (shipped defaults):",
			prompt: "   Accept all? [Y] or overrides like cyclomatic=15,coverage=90: ",
		},
		adopt: {
			n: 5,
			title: "Baselines — your repo as it is today becomes the floor;",
			detail: "interlinked only stops it getting worse (tighten-only ratchets).",
			prompt: "   Seed baselines from current state now? [Y/n]: ",
		},
		deadcode: {
			n: 6,
			title: "Dead code:",
			flagLine: "flag — report unused imports/exports on every edit (recommended)",
			deleteLine: "delete — also instruct the agent to remove them in the same edit",
			offLine: "off — per-edit checks silent; `interlinked deadcode` sweep still works",
			prompt: "   Dead code [flag]: ",
		},
	},
	planHeader: "Plan",
	applyPrompt: "\nApply? [Y/n]: ",
	aborted: "Aborted — nothing was written.",
	complete: "Setup complete.",
	receiptHeader: "Now enforced — every line names the command that changes it:",
	tourHeader: "What Interlinked runs for you from here:",
	tour: [
		"  every delivered hook event judged live — current check and guard counts: interlinked harness checks",
		"  TDD: a new source file asks for its failing companion test first (strict blocks, balanced warns)",
		"  coverage: adopt seeds today's % as the floor; every edit holds-or-raises it toward your goal",
		"  mutation testing: `interlinked mutation` ratchets survivor scores per file; deep-audit lane, not per-edit by default",
		"  dead code: unused imports/exports flagged per edit (or set delete); `interlinked deadcode` sweeps the whole repo; mutation adjudication catches behaviorally inert code",
		"  `interlinked verify` — the local CI mirror: types, lint, secrets, deps + the default check set",
		"  session end: a ranked stop digest and `interlinked status` scorecard, not a wall of warnings",
		"  agent skills installed per runner teach these gates from inside the agent's own context",
		"  everything local — no server, no account; `interlinked query` reads what it records",
	],
	nextSteps: [
		"Make any edit in your agent — the harness judges it live.",
		"  interlinked status     scorecard (edits judged, findings, blocks)",
		"  interlinked mode       switch enforcement mode any time",
		"  interlinked disable    non-destructive stand-down (full removal: disable --uninstall)",
	],
} as const;

/** Render the decisions as a short confirmation plan — the user sees exactly
 *  what will happen (and which command owns each decision later) before it
 *  does. */
export function describeWizardPlan(choices: WizardChoices): string[] {
	const lines: string[] = [];
	lines.push(
		`  Runners: ${choices.runners ? choices.runners.join(", ") : "all detected"}  (change: interlinked enable --clients …)`,
	);
	lines.push(`  Mode: ${choices.mode}  (change: interlinked mode <name>)`);
	lines.push(
		`  Scope: ${choices.scope === "diff" ? "diff — judge only what the agent changes" : "whole-file — judge every touched file in full"}`,
	);
	const capEntries = Object.entries(choices.caps);
	lines.push(
		capEntries.length === 0
			? "  Caps: shipped defaults  (view: interlinked caps)"
			: `  Caps: ${capEntries.map(([k, v]) => `${k}=${v}`).join(", ")}  (change: interlinked caps set)`,
	);
	lines.push(
		choices.adopt
			? "  Baselines: adopt now — your repo today is the floor; interlinked only stops it getting worse"
			: "  Baselines: skipped  (run later: interlinked adopt)",
	);
	lines.push(`  Dead code: ${describeDeadCodeChoice(choices.deadCode)}`);
	return lines;
}

/** One phrase per dead-code posture — shared by the plan and the receipt. */
function describeDeadCodeChoice(deadCode: WizardDeadCode): string {
	if (deadCode === "delete")
		return "flag per edit + instruct the agent to delete  (change: rerun the wizard)";
	if (deadCode === "off") return "per-edit checks off  (sweep any time: interlinked deadcode)";
	return "flag per edit — unused imports/exports reported  (sweep: interlinked deadcode)";
}

/** One receipt line per cap: overrides win; coverage renders as a GOAL the
 *  ratchets climb toward (default 100), never as a bound. */
function capReceiptBits(caps: WizardChoices["caps"]): string[] {
	return METRIC_DEFS.map((d) => {
		const value = caps[d.key] ?? d.defaultValue;
		if (d.stricter !== "higher") return `${d.key} ≤ ${value}`;
		return value === 0 ? `${d.key} goal off (ratchet only)` : `${d.key} goal ${value} %`;
	});
}

/**
 * The posture receipt — printed AFTER the wizard applies, one line per thing
 * now enforced, each naming the command that changes it. Discoverability at
 * the moment curiosity strikes, instead of twenty onboarding questions
 * (operator decision 2026-08-17). Pure so the browser demo renders the SAME
 * receipt from the same module.
 */
export function describePostureReceipt(choices: WizardChoices): string[] {
	const preset = getPreset(choices.mode);
	const lines: string[] = [];
	lines.push(`  mode ${choices.mode} — ${preset?.description ?? "user-defined policy"}`);
	for (const p of preset?.posture ?? []) lines.push(`    · ${p}`);
	lines.push("    change: interlinked mode strict|balanced|lenient  (preview first: --diff)");
	lines.push(`  caps: ${capReceiptBits(choices.caps).join(" · ")}`);
	lines.push("    change: interlinked caps set <metric> <value>  ·  meanings: interlinked caps explain");
	lines.push(
		choices.scope === "diff"
			? "  scope: diff — only what the agent changes is judged  (rerun the wizard to widen)"
			: "  scope: whole-file — every touched file judged in full  (rerun the wizard to narrow)",
	);
	lines.push(
		choices.adopt
			? "  baselines: seeded from today's state; ratchets only tighten  (re-seed: interlinked adopt)"
			: "  baselines: NOT seeded — run interlinked adopt before the strict gates bite",
	);
	lines.push(
		choices.adopt
			? "  installs: current deps pre-approved; new packages need interlinked allowlist add <eco> <pkg>"
			: "  installs: fail-closed allowlist — pre-approve current deps: interlinked allowlist snapshot --by you",
	);
	lines.push(`  dead code: ${describeDeadCodeChoice(choices.deadCode)}`);
	lines.push(
		"  always on: destructive-command, secrets, and install rails; per-check tuning lives in .interlinked/check-policy.json",
	);
	return lines;
}
