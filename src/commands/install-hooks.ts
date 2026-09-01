// ===========================================
// interlinked install-hooks — multi-runner installer (Phase D)
// ===========================================
// Adapter-multiplexing installer. Distinct from `interlinked enable` — that
// command handles the legacy 2-runner Claude+Copilot pipeline and the
// .interlinked/ config scaffold. `install-hooks` targets the adapter-based
// runtime introduced in Phase A–C and uses the installer-manifest.json for
// precise uninstall.

import { existsSync, mkdirSync, readSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installHooks, manifestPath } from "../harness/installer.js";
import { ALL_PRESETS, isKnownMode, type ModeName } from "../harness/modes.js";
import type { RunnerId } from "../harness/unified-event.js";
import { resolveHookBinaryPath } from "../lib/hooks.js";
import { nonNull } from "../lib/non-null.js";
import { refreshInstalledHooks, reportRefresh } from "./install-hooks-refresh.js";
import { writeMode } from "./mode.js";

export interface InstallHooksOptions {
	runner?: string;
	scope?: string;
	cloud?: string;
	tokenEnv?: string;
	binary?: string;
	dryRun?: boolean;
	json?: boolean;
	/** balanced | strict | lenient — skips the interactive prompt when set. */
	mode?: string;
	/** Re-render already-installed hooks from the manifest; implies
	 *  --preserve-mode. See install-hooks-refresh.ts. */
	refresh?: boolean;
	/** Never write the enforcement mode (or cloud config) — hooks only. */
	preserveMode?: boolean;
}

const VALID_RUNNERS = new Set<RunnerId>([
	"claude-code",
	"copilot-cli",
	"cursor",
	"gemini-cli",
	"codex",
	"opencode",
	"opencode2",
	"pi",
]);
const VALID_SCOPES = new Set(["user", "project", "local"]);
const VALID_CLOUD_PRODUCTS = new Set(["guardrails", "agent-ci"]);

export async function installHooksCommand(options: InstallHooksOptions): Promise<void> {
	const runnerSelection = parseRunners(options.runner);
	if (runnerSelection.unknown.length > 0) {
		reportUnknownRunners(runnerSelection.unknown, options.json === true);
		return;
	}
	const optionError = explicitOptionError(options);
	if (optionError !== null) {
		reportInvalidOption(optionError, options.json === true);
		return;
	}
	const cwd = process.cwd();
	const runners = runnerSelection.runners;
	const scope = parseScope(options.scope);
	const dryRun = options.dryRun === true;
	const binaryPath = resolve(
		options.binary ?? resolveHookBinaryPath(cwd, { writeFallback: !dryRun }),
	);

	// --refresh: the hooks-only repair path (manifest-scoped, snapshot +
	// rollback, never touches mode/cloud). Owned by install-hooks-refresh.ts.
	if (options.refresh === true) {
		reportRefresh(
			refreshInstalledHooks({ cwd, binaryPath, runners, dryRun }),
			options.json === true,
		);
		return;
	}
	const preserveMode = options.preserveMode === true;

	// Resolve enforcement mode: explicit flag > interactive prompt > balanced.
	// null = --preserve-mode: hooks only, the mode file is never written.
	const resolvedMode = preserveMode ? null : resolveMode(options);

	const result = installHooks({ cwd, binaryPath, runners, scope, dryRun });

	const modeWriteSucceeded = applyRequestedMode(cwd, resolvedMode, dryRun);

	if (options.cloud && !dryRun && !preserveMode) {
		writeCloudConfig(cwd, options.cloud, options.tokenEnv);
	}

	// `ok` used to be the literal `true` — it described the command reaching its
	// end, not the install working. A Codex `postInstall` throw was caught,
	// logged and dropped, so an installation whose hooks never fire reported
	// success. It now mirrors `InstallResult.ok`, and the process exits non-zero
	// so a script or CI step sees the failure too.
	const commandOk = reportInstallFailure(result, resolvedMode, modeWriteSucceeded);

	if (options.json) {
		const payload = {
			ok: commandOk,
			dry_run: dryRun,
			entries: result.entries,
			skipped: result.skipped,
			post_install_failures: result.post_install_failures,
			manifest_path: result.manifest_path,
			purged: result.purged,
			foreign: result.foreign,
			orphans_cleaned: result.orphans_cleaned,
			mode: resolvedMode ?? "preserved",
			cloud: options.cloud ?? null,
		};
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}

	printHuman(result, dryRun, resolvedMode, modeWriteSucceeded);
}

function applyRequestedMode(cwd: string, mode: ModeName | null, dryRun: boolean): boolean {
	if (dryRun || mode === null) return true;
	return writeMode(cwd, mode, false);
}

function reportInstallFailure(
	result: ReturnType<typeof installHooks>,
	mode: ModeName | null,
	modeWriteSucceeded: boolean,
): boolean {
	const ok = result.ok && modeWriteSucceeded;
	if (ok) return true;
	for (const failure of result.post_install_failures) {
		process.stderr.write(
			`[interlinked] ${failure.runner}: hooks are NOT active — post-install step failed: ${failure.reason}\n`,
		);
	}
	if (!modeWriteSucceeded) {
		process.stderr.write(
			`[interlinked] hooks were written, but mode ${mode ?? "preserved"} was NOT applied; install-hooks is incomplete.\n`,
		);
	}
	process.exitCode = 1;
	return false;
}

/** Explicit --mode wins. In a TTY with no flag, prompt. Otherwise default
 *  to balanced. Unknown values fall back to balanced with a stderr warning. */
function resolveMode(options: InstallHooksOptions): ModeName {
	if (options.mode) {
		if (isKnownMode(options.mode)) return options.mode;
	}
	if (options.json || !process.stdin.isTTY) return "balanced";
	return promptForMode();
}

function promptForMode(): ModeName {
	process.stdout.write("\nPick an enforcement mode:\n");
	for (let i = 0; i < ALL_PRESETS.length; i++) {
		const p = ALL_PRESETS[i];
		const label = nonNull(p).name === "balanced" ? `${nonNull(p).name} (default)` : nonNull(p).name;
		process.stdout.write(`  ${i + 1}. ${label.padEnd(18)} ${nonNull(p).description}\n`);
	}
	process.stdout.write("\nEnter a number, a name, or press Enter for the default.\n> ");
	const raw = readStdinLine();
	return parseModeChoice(raw);
}

export function parseModeChoice(raw: string): ModeName {
	const trimmed = raw.trim().toLowerCase();
	if (trimmed.length === 0) return "balanced";
	const n = Number.parseInt(trimmed, 10);
	if (Number.isFinite(n) && n >= 1 && n <= ALL_PRESETS.length) {
		return nonNull(ALL_PRESETS[n - 1]).name;
	}
	if (isKnownMode(trimmed)) return trimmed;
	return "balanced";
}

function readStdinLine(): string {
	const buf = Buffer.alloc(4096);
	let read = 0;
	try {
		read = readSync(0, buf, 0, 4096, null);
	} catch {
		return "";
	}
	return buf.toString("utf-8", 0, read);
}

interface RunnerSelection {
	runners: RunnerId[];
	unknown: string[];
}

function parseRunners(raw: string | undefined): RunnerSelection {
	if (raw === undefined || raw === "all") return { runners: [], unknown: [] };
	const parts = raw.split(",").map((s) => s.trim());
	const out: RunnerId[] = [];
	const unknown: string[] = [];
	for (const part of parts) {
		if (VALID_RUNNERS.has(part as RunnerId)) {
			out.push(part as RunnerId);
		} else {
			unknown.push(part);
		}
	}
	return { runners: out, unknown };
}

/** Reject an invalid explicit selection before `[]` can reach the installer,
 * where an empty list deliberately means "all runners". */
function reportUnknownRunners(unknown: string[], json: boolean): void {
	const message = `unknown runner${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}; no hooks were installed`;
	process.exitCode = 1;
	process.stderr.write(`[interlinked] ${message}\n`);
	if (json) {
		process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
	}
}

function explicitOptionError(options: InstallHooksOptions): string | null {
	if (options.scope !== undefined && !VALID_SCOPES.has(options.scope)) {
		return `unknown scope ${JSON.stringify(options.scope)}; expected user, project, or local`;
	}
	if (options.mode !== undefined && !isKnownMode(options.mode)) {
		return `unknown mode ${JSON.stringify(options.mode)}; expected balanced, strict, or lenient`;
	}
	return null;
}

function reportInvalidOption(message: string, json: boolean): void {
	process.exitCode = 1;
	process.stderr.write(`[interlinked] ${message}; no files were changed\n`);
	if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
}

function parseScope(raw: string | undefined): "user" | "project" | "local" {
	return raw === "user" || raw === "local" ? raw : "project";
}

function writeCloudConfig(cwd: string, product: string, tokenEnv: string | undefined): void {
	if (!VALID_CLOUD_PRODUCTS.has(product)) {
		process.stderr.write(
			`[interlinked] warning: unknown cloud product ${product}; skipping cloud opt-in\n`,
		);
		return;
	}
	const cfgDir = join(cwd, ".interlinked");
	if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
	const payload = {
		enabled: true,
		product,
		portal_url:
			product === "guardrails"
				? "https://portal.interlinked.dev/mcp"
				: "https://portal.interlinked.dev/agent-ci",
		token_source: tokenEnv ? { env: tokenEnv } : null,
		zdr: false,
		redactors_before_send: ["secrets", "paths"],
	};
	writeFileSync(join(cfgDir, "cloud.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

function printHuman(
	result: {
		ok: boolean;
		post_install_failures: Array<{ runner: string; reason: string }>;
		entries: Array<{ runner: string; settings_path: string; added_paths: string[] }>;
		skipped: Array<{ runner: string; reason: string }>;
		manifest_path: string;
		purged: number;
		foreign: number;
		orphans_cleaned: string[];
	},
	dryRun: boolean,
	mode: ModeName | null,
	modeWriteSucceeded: boolean,
): void {
	const verb = dryRun ? "would install" : "installed";
	process.stdout.write(`[interlinked] ${verb} hooks for ${result.entries.length} runner(s)\n`);
	for (const e of result.entries) {
		process.stdout.write(
			`  ${e.runner.padEnd(14)} → ${e.settings_path} (${e.added_paths.length} path(s))\n`,
		);
	}
	// An entry whose post-install step failed is NOT a working install: the
	// settings fragment landed, but the runner ignores it. Say so on the same
	// listing rather than letting the count above imply success.
	for (const f of result.post_install_failures) {
		process.stdout.write(`  ${f.runner.padEnd(14)} INCOMPLETE — hooks inactive: ${f.reason}\n`);
	}
	for (const s of result.skipped) {
		process.stdout.write(`  ${s.runner.padEnd(14)} skipped: ${s.reason}\n`);
	}
	// Idempotency accounting: stale prior registrations the install cleaned up.
	if (result.purged > 0) {
		process.stdout.write(`  purged ${result.purged} stale hook registration(s)\n`);
	}
	if (result.orphans_cleaned.length > 0) {
		process.stdout.write(
			`  cleaned a prior install in ${result.orphans_cleaned.length} other file(s)\n`,
		);
	}
	if (result.foreign > 0) {
		process.stdout.write(
			`  left ${result.foreign} hook registration(s) owned by other projects in place\n`,
		);
	}
	process.stdout.write(`manifest: ${manifestPath(process.cwd())}\n`);
	if (!dryRun) {
		process.stdout.write(
			mode === null
				? "mode: preserved (not written \u2014 --preserve-mode)\n"
				: modeWriteSucceeded
					? `mode: ${mode}  (change anytime: interlinked mode <name>)\n`
					: `mode: NOT APPLIED (requested ${mode})\n`,
		);
	}
}
