// ===========================================
// interlinked mode — show / preview / switch enforcement mode
// ===========================================
// Usage:
//   interlinked mode                    # show current mode + effective checks
//   interlinked mode <name>             # switch mode (writes shared config)
//   interlinked mode <name> --diff      # preview what would change, don't write
//   interlinked mode <name> --local     # write to gitignored personal override
//   interlinked mode <name> --force     # skip confirmation prompts

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CheckAction, CheckPolicy, CheckPolicyFile } from "../harness/check-policy.js";
import { loadCheckPolicy } from "../harness/check-policy.js";
import { CHECK_REGISTRY } from "../harness/check-registry/registry.js";
import type { CheckRegistration } from "../harness/check-registry/types.js";
import {
	ALL_PRESETS,
	getPreset,
	isKnownMode,
	type ModeName,
	type ModePreset,
} from "../harness/modes.js";
import { mergeIntoGuardRules } from "../harness/rules/guard-rules-write.js";
import type { JsonObject } from "../lib/json-types.js";

export interface ModeCommandOptions {
	diff?: boolean;
	local?: boolean;
	force?: boolean;
	json?: boolean;
}

export async function modeCommand(
	name: string | undefined,
	options: ModeCommandOptions,
): Promise<void> {
	const cwd = process.cwd();

	if (!name) {
		showCurrent(cwd, options);
		return;
	}

	if (!isKnownMode(name)) {
		fail(`unknown mode: ${name}. Known: ${ALL_PRESETS.map((p) => p.name).join(", ")}`, options);
		return;
	}

	const preset = getPreset(name);
	if (!preset && name !== "custom") {
		fail(`no preset defined for ${name}`, options);
		return;
	}

	if (!previewApproved(cwd, name, preset, options)) return;

	if (!writeMode(cwd, name, options.local === true)) {
		fail(`mode ${name} not applied — see the error above; neither file was changed`, options);
		return;
	}
	reportModeApplied(cwd, name, options);
}

/** Render the current → target preview when the invocation asks for one, then
 *  ask before writing. False means stop: `--diff` is preview-only, and an
 *  unconfirmed prompt aborts. */
function previewApproved(
	cwd: string,
	name: ModeName,
	preset: ModePreset | null,
	options: ModeCommandOptions,
): boolean {
	if (!options.diff && (options.force || options.json)) return true;
	const changes = computeDiff(cwd, name, preset);
	renderDiff(name, changes, options);
	if (options.diff) return false;
	if (!options.force && !confirm(`\nApply ${name} mode?`)) {
		process.stdout.write("Aborted.\n");
		return false;
	}
	return true;
}

/** Report the applied mode in the invocation's output format. */
function reportModeApplied(cwd: string, name: ModeName, options: ModeCommandOptions): void {
	if (options.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					ok: true,
					mode: name,
					scope: options.local ? "local" : "shared",
					path: policyPath(cwd, options.local === true),
				},
				null,
				2,
			)}\n`,
		);
		return;
	}
	const scope = options.local ? "personal override" : "shared config";
	process.stdout.write(`[interlinked] Mode set to ${name} (${scope}).\n`);
}

// -----------------------------------------------------------------------------
// Show current
// -----------------------------------------------------------------------------

function showCurrent(cwd: string, options: ModeCommandOptions): void {
	const policy = loadCheckPolicy(cwd);
	const teamExists = existsSync(policyPath(cwd, false));
	const localExists = existsSync(policyPath(cwd, true));
	if (options.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					mode: policy.mode,
					shared_path: teamExists ? policyPath(cwd, false) : null,
					local_path: localExists ? policyPath(cwd, true) : null,
					available_modes: ALL_PRESETS.map((p) => ({
						name: p.name,
						description: p.description,
					})),
				},
				null,
				2,
			)}\n`,
		);
		return;
	}
	process.stdout.write(`Current: ${policy.mode}\n`);
	process.stdout.write("Source : ");
	if (localExists) {
		process.stdout.write(`${policyPath(cwd, true)} (personal override)\n`);
	} else if (teamExists) {
		process.stdout.write(`${policyPath(cwd, false)} (shared config)\n`);
	} else {
		process.stdout.write("built-in default (no config file)\n");
	}
	renderEffectiveActions(policy);
	process.stdout.write("\nAvailable modes:\n");
	for (const p of ALL_PRESETS) {
		process.stdout.write(`  ${p.name.padEnd(10)} ${p.description}\n`);
	}
	process.stdout.write("\nSwitch: interlinked mode <name> [--diff] [--local]\n");
}

function renderEffectiveActions(policy: CheckPolicy): void {
	const counts: Record<CheckAction, number> = {
		silent: 0,
		info: 0,
		warn_after: 0,
		warn_before: 0,
		ratchet: 0,
		ask: 0,
		block_preview: 0,
		auto_fix: 0,
	};
	for (const check of CHECK_REGISTRY) {
		const action = policy.checks[check.id]?.action ?? policy.defaults.action;
		counts[action]++;
	}
	process.stdout.write("\nEffective per-check action counts:\n");
	for (const key of Object.keys(counts) as CheckAction[]) {
		if (counts[key] > 0) process.stdout.write(`  ${key.padEnd(14)} ${counts[key]}\n`);
	}
}

// -----------------------------------------------------------------------------
// Diff current → target
// -----------------------------------------------------------------------------

interface ActionChange {
	check_id: string;
	from: CheckAction;
	to: CheckAction;
}

function computeDiff(
	cwd: string,
	targetMode: ModeName,
	targetPreset: ModePreset | null,
): ActionChange[] {
	const currentPolicy = loadCheckPolicy(cwd);
	const out: ActionChange[] = [];
	const targetOverrides = targetPreset?.check_overrides ?? {};
	const targetDefault: CheckAction =
		targetPreset?.default_action ?? currentPolicy.defaults.action;
	for (const check of CHECK_REGISTRY) {
		const currentAction =
			currentPolicy.checks[check.id]?.action ?? currentPolicy.defaults.action;
		const targetAction = targetOverrides[check.id] ?? targetDefault;
		if (currentAction !== targetAction) {
			out.push({ check_id: check.id, from: currentAction, to: targetAction });
		}
	}
	// Void-reference silences the unused warning on targetMode — it's kept
	// in the signature for future per-mode messaging (e.g., different
	// summaries for strict vs lenient).
	void targetMode;
	return out;
}

function renderDiff(
	targetMode: ModeName,
	changes: ActionChange[],
	options: ModeCommandOptions,
): void {
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ mode: targetMode, changes }, null, 2)}\n`);
		return;
	}
	if (changes.length === 0) {
		process.stdout.write(`Switching to ${targetMode} would not change any check actions.\n`);
		return;
	}
	process.stdout.write(`Switching to ${targetMode} would change ${changes.length} check(s):\n`);
	for (const c of changes) {
		const label = describeCheck(c.check_id);
		process.stdout.write(
			`  ${c.check_id.padEnd(28)} ${c.from.padEnd(12)} -> ${c.to.padEnd(12)} ${label}\n`,
		);
	}
}

function describeCheck(id: string): string {
	const found: CheckRegistration | undefined = CHECK_REGISTRY.find((c) => c.id === id);
	return found?.name ?? "";
}

// -----------------------------------------------------------------------------
// Write mode
// -----------------------------------------------------------------------------

function policyPath(cwd: string, local: boolean): string {
	return join(cwd, ".interlinked", local ? "check-policy.local.json" : "check-policy.json");
}

/** Bytes + mode of one file, or null when absent — for the rollback. */
type ModeFileSnapshot = { content: string; fileMode: number } | null;

function snapshotModeFile(path: string): ModeFileSnapshot {
	if (!existsSync(path)) return null;
	return { content: readFileSync(path, "utf-8"), fileMode: statSync(path).mode };
}

function restoreModeFile(path: string, snap: ModeFileSnapshot): void {
	if (snap === null) {
		if (existsSync(path)) unlinkSync(path);
		return;
	}
	const tmp = `${path}.mode-restore.tmp`;
	writeFileSync(tmp, snap.content);
	chmodSync(tmp, snap.fileMode);
	renameSync(tmp, path);
}

/** The check-policy half of a mode switch (merge-preserving). */
function writeCheckPolicyFile(cwd: string, mode: ModeName, local: boolean): void {
	const path = policyPath(cwd, local);
	const dir = join(cwd, ".interlinked");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	let existing: CheckPolicyFile = { version: 1 };
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf-8")) as CheckPolicyFile;
		} catch {
			existing = { version: 1 };
		}
	}
	existing.version = existing.version ?? 1;
	existing.mode = mode;
	writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
}

/** TRANSACTIONAL two-file write (review 2026-08-30, both directions): the
 *  guard-posture half goes first — a refusal there leaves check-policy
 *  untouched — and a FAILED check-policy write afterwards restores the guard
 *  file from its snapshot, so the two files never split into a half-applied
 *  mode. Rollback covers HANDLED failures; an OS crash mid-write cannot run
 *  the in-memory restore. Returns false (nonzero exit code) when nothing
 *  effective was written. */
export function writeMode(cwd: string, mode: ModeName, local: boolean): boolean {
	const guardPath = join(
		cwd,
		".interlinked",
		local ? "guard-rules.local.json" : "guard-rules.json",
	);
	const guardBefore = snapshotModeFile(guardPath);
	if (!applyModeGuardOverrides(cwd, mode, local)) {
		process.exitCode = 1;
		return false;
	}
	try {
		writeCheckPolicyFile(cwd, mode, local);
		return true;
	} catch (err) {
		// Inverse direction: the guard half landed but check-policy failed —
		// restore the guard file so the posture never splits.
		restoreModeFile(guardPath, guardBefore);
		process.stderr.write(
			`[interlinked] mode ${mode}: check-policy write failed (${err instanceof Error ? err.message : String(err)}) — guard changes rolled back; neither file was changed.\n`,
		);
		process.exitCode = 1;
		return false;
	}
}

/** A mode is a POSTURE, not just check severities: apply the preset's
 *  philosophy-dependent gates (TDD, per-edit coverage, session-end nudges)
 *  into the guard-rules file of the SAME tier as the check-policy write —
 *  `--local` keeps a personal mode switch out of the committed team file
 *  (review 2026-08-30: it used to edit shared policy). Merge-preserving;
 *  later hand edits win until the mode is re-applied; "custom" applies
 *  nothing. Returns false on a refused merge (malformed target file) so the
 *  caller can abort BEFORE the check-policy half lands. */
function applyModeGuardOverrides(cwd: string, mode: ModeName, local: boolean): boolean {
	const preset = getPreset(mode);
	const overrides = preset?.guard_overrides;
	if (!overrides) return true;
	// SAFETY: ModeGuardOverrides is a plain nested record of booleans/strings —
	// structurally a JsonObject; TS can't see that through the interface name.
	const r = mergeIntoGuardRules(cwd, overrides as JsonObject, local ? "local" : "team");
	if (!r.ok) {
		process.stderr.write(
			`[interlinked] mode ${mode}: NOT applied (${r.error}) — fix ${r.path} and re-run interlinked mode ${mode}. Neither file was changed.\n`,
		);
		return false;
	}
	return true;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function fail(message: string, options: ModeCommandOptions): void {
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ ok: false, reason: message })}\n`);
	} else {
		process.stderr.write(`[interlinked] ${message}\n`);
	}
	process.exitCode = 1;
}

function confirm(prompt: string): boolean {
	// Non-interactive environments (CI, hooks) never confirm. Use --force
	// to bypass when scripting.
	if (!process.stdin.isTTY) return false;
	process.stdout.write(`${prompt} [y/N] `);
	const input = readLineSync();
	return /^y(es)?$/i.test(input.trim());
}

function readLineSync(): string {
	// Minimal blocking readline for a yes/no prompt. Deliberately avoids
	// a readline dependency to keep the CLI single-file-compile-friendly.
	const bufSize = 4096;
	const buf = Buffer.alloc(bufSize);
	let read = 0;
	try {
		read = readSync(0, buf, 0, bufSize, null);
	} catch {
		return "";
	}
	return buf.toString("utf-8", 0, read);
}
