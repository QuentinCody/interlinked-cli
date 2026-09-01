// interlinked-tdd: exempt
// ===========================================
// Hook-entry cold fail-closed gates — block-reason computation
// ===========================================
// The pure "should the cold path BLOCK this event?" helpers, extracted from
// hook-entry.ts (leaf cluster: depends only on its own logic + imports; the
// main file imports the five `cold*BlockReason` entry points back). Each
// returns the block reason string, or null when the event is benign / not the
// shape that gate guards. No daemon state — these run when the socket is
// unreachable, so they must mirror the daemon's deterministic checks exactly.

import { existsSync, statSync } from "node:fs";
import { join as joinPath } from "node:path";
import { evaluatePackageInstall } from "./harness/evaluator/package-install-guard.js";
import { loadAllowlist } from "./harness/package-allowlist.js";
import { parseInstallCommands } from "./harness/package-install-parser.js";
import { checkLargeFileLineCountWrite } from "./harness/pre-checks.js";
import type { UnifiedHookEvent } from "./harness/unified-event.js";
import {
	checkGraphShardWrite,
	checkMergeConflictWrite,
	type ColdWriteDeps,
	type ColdWriteToolInput,
} from "./lib/hook-template-chunks/cold-write-guards.js";
import { checkDestructiveCommand } from "./lib/hook-template-chunks/destructive-command-guard.js";
import type { JsonObject } from "./lib/json-types.js";

// Unified phase tag (a subset of UnifiedPhase). Local copy of the constant in
// hook-entry.ts so this leaf module does not import back from the main file
// (which would be a circular import).
const PHASE_PRE_TOOL = "pre-tool";

// Discriminator values for UnifiedAction. Same rationale as above.
const ACTION_TOOL_CALL = "tool_call";
const ACTION_SHELL_COMMAND = "shell_command";
const ACTION_FILE_OPERATION = "file_operation";

// Target-path extraction, the write-tool name set, the apply_patch header
// parsing and the shard-freshness probe all moved to
// `src/lib/hook-template-chunks/cold-write-guards.ts`. They were duplicated
// there as JS inside the generated-hook template string; both hook paths now
// call the SAME functions, and the .mjs embeds their serialized source.

// What `colColdToolName` returns when the unified event is a generic
// file_operation (no specific tool name). "edit" matches the normalized form
// the shared write guards recognize.
const FILE_OPERATION_DEFAULT_TOOL = "edit";

function colColdToolName(event: UnifiedHookEvent): string | null {
	const action = event.action;
	if (action.kind === ACTION_TOOL_CALL) return action.tool_name;
	if (action.kind === ACTION_FILE_OPERATION) return FILE_OPERATION_DEFAULT_TOOL;
	return null;
}

/** Resolve `event.context.cwd`, tolerating a malformed/missing `context`
 *  (the static `UnifiedHookEvent` type marks it required, but this cold path
 *  runs precisely when normal validation may not have — see the
 *  "falls back to process.cwd() when event.context is absent" test). Reads
 *  through `unknown` and narrows explicitly rather than relying on `?.`/`??`
 *  against the (honest-elsewhere) required type. */
function resolveColdCwd(event: UnifiedHookEvent): string {
	const rawContext: unknown = event.context;
	if (
		typeof rawContext === "object" &&
		rawContext !== null &&
		typeof (rawContext as { cwd?: unknown }).cwd === "string"
	) {
		return (rawContext as { cwd: string }).cwd;
	}
	return process.cwd();
}

/** Filesystem functions handed to the shared write guards. The .mjs supplies
 *  its own; here they are this module's real `node:fs` / `node:path` imports. */
const COLD_WRITE_DEPS: ColdWriteDeps = { existsSync, statSync, join: joinPath };

/** Cold fail-closed gate for the graph-prediction protocol. Runs the SAME
 *  `checkGraphShardWrite` the generated .mjs hook runs inline (embedded there
 *  via `COLD_WRITE_GUARDS_SOURCE`), so the two hook paths block the identical
 *  set — daemon up or down. A generic `file_operation` action carries its path
 *  directly, so it is presented to the shared gate as an `edit` tool call. */
export function coldGraphShardBlockReason(event: UnifiedHookEvent): string | null {
	if (event.phase !== PHASE_PRE_TOOL) return null;
	const toolName = colColdToolName(event);
	if (!toolName) return null;
	const cwd = resolveColdCwd(event);
	const verdict = checkGraphShardWrite(toolName, coldWriteToolInput(event), cwd, COLD_WRITE_DEPS);
	return verdict ? verdict.reason : null;
}

/** The tool_input the shared write guards read, for either action shape. */
function coldWriteToolInput(event: UnifiedHookEvent): ColdWriteToolInput {
	const action = event.action;
	if (action.kind === ACTION_FILE_OPERATION) {
		return typeof action.path === "string" ? { file_path: action.path } : {};
	}
	if (action.kind !== ACTION_TOOL_CALL) return {};
	// Every field of ColdWriteToolInput is optional-unknown, so the untyped
	// tool_input object structurally satisfies it without a cast; the guards
	// type-check each value they read.
	return action.tool_input ?? {};
}

/** Cold fail-closed gate: refuse a file write whose content carries
 *  merge-conflict markers. A file with `<<<<<<<` / `=======` / `>>>>>>>`
 *  markers is a guaranteed parse error; the daemon blocks it at
 *  write-content-guards check A1, so the cold path must too — otherwise a
 *  daemon outage silently lets broken content through.
 *
 *  Runs the SAME `checkMergeConflictWrite` the generated .mjs hook runs inline
 *  (embedded there via `COLD_WRITE_GUARDS_SOURCE`), so the two hook paths block
 *  the identical set. Returns the block reason, or null when the write is
 *  clean / not a file write. */
export function coldMergeConflictBlockReason(event: UnifiedHookEvent): string | null {
	if (event.phase !== PHASE_PRE_TOOL) return null;
	const action = event.action;
	if (action.kind !== ACTION_TOOL_CALL) return null;
	const toolName = colColdToolName(event);
	if (!toolName) return null;
	// SAFETY: every field of ColdWriteToolInput is optional-unknown, so any
	// tool_input object satisfies it; the guard type-checks each value it reads.
	const ti = (action.tool_input ?? {}) as ColdWriteToolInput;
	const verdict = checkMergeConflictWrite(toolName, ti);
	return verdict ? verdict.reason : null;
}

// Shell-command tool names across runners — normalized (Claude Code
// lowercases via normalizeToolName, Cursor lowercases) and raw forms.
// Over-inclusion is harmless: a non-shell tool here simply has no
// `.command` and yields null.
const COLD_BASH_TOOL_NAMES = new Set([
	"bash",
	"Bash",
	"shell",
	"Shell",
	"run_command",
	"local_shell",
]);

/** Cold fail-closed gate: refuse a destructive shell command (`rm -rf`,
 *  force push, `DROP TABLE`, ...) when the daemon is unreachable. Runs the
 *  SAME `checkDestructiveCommand` the generated .mjs hook runs inline as its
 *  primary guard, so the two hook paths block the identical set — daemon up
 *  or down. Returns the block reason, or null when the command is benign. */
export function coldDestructiveCommandBlockReason(event: UnifiedHookEvent): string | null {
	if (event.phase !== PHASE_PRE_TOOL) return null;
	const action = event.action;

	let command = "";
	if (action.kind === ACTION_SHELL_COMMAND) {
		// Cursor's beforeShellExecution produces shell_command actions with the
		// command string directly on `action.command` — no tool_name gating needed.
		command = action.command;
	} else if (action.kind === ACTION_TOOL_CALL) {
		if (!COLD_BASH_TOOL_NAMES.has(action.tool_name)) return null;
		const ti = (action.tool_input ?? {}) as { command?: unknown };
		command = typeof ti.command === "string" ? ti.command : "";
	} else {
		return null;
	}

	if (!command) return null;
	const verdict = checkDestructiveCommand(command);
	return verdict ? verdict.reason : null;
}

/** Cold fail-closed gate: refuse a package-install shell command when the
 *  daemon is unreachable. Mirrors the daemon-side `evaluatePackageInstall`
 *  by loading the same `.interlinked/package-allowlist.json` and running
 *  the same parser, so the .mjs path and hook-entry cold path block the
 *  identical set whether the daemon is up or down. Returns the block
 *  reason, or null when the command is benign / approved / not an install.
 *  Bypass via INTERLINKED_DISABLE_PACKAGE_GUARD=1.
 *
 *  This is the one cold gate NOT shared with the generated .mjs hook, and that
 *  is deliberate: the .mjs may not import, so it cannot carry the parser or the
 *  allowlist loader and instead refuses every install verb
 *  (`lib/hook-template-chunks/package-install-cold-guard.ts`). Sharing either
 *  implementation would change enforcement — this path would stop honoring
 *  approved packages, or the .mjs would have to run code it cannot reach. */
export function coldPackageInstallBlockReason(event: UnifiedHookEvent): string | null {
	if (process.env.INTERLINKED_DISABLE_PACKAGE_GUARD === "1") return null;
	if (event.phase !== PHASE_PRE_TOOL) return null;
	const action = event.action;
	let command = "";
	if (action.kind === ACTION_SHELL_COMMAND) {
		command = action.command;
	} else if (action.kind === ACTION_TOOL_CALL) {
		if (!COLD_BASH_TOOL_NAMES.has(action.tool_name)) return null;
		const ti = (action.tool_input ?? {}) as { command?: unknown };
		command = typeof ti.command === "string" ? ti.command : "";
	} else {
		return null;
	}
	if (!command) return null;
	const installCommands = parseInstallCommands(command);
	if (installCommands.length === 0) return null;
	const cwd = resolveColdCwd(event) || process.cwd();
	const allowlist = loadAllowlist(cwd);
	const decision = evaluatePackageInstall(installCommands, cwd, allowlist);
	if (!decision || decision.decision !== "block") return null;
	return decision.reason ?? "package install blocked by supply-chain allowlist";
}

/** Cold fail-closed gate: refuse a Write/Edit/MultiEdit that would grow (or create)
 *  a hand-written code file past the per-file line cap when the daemon is
 *  unreachable. Runs the SAME pure `checkLargeFileLineCountWrite` the daemon uses —
 *  file content + the committed `.interlinked/large-files-baseline.json`, no daemon
 *  state — so the cap holds whether the daemon is up or down. This closes the gap
 *  that let an over-cap edit slip through when the socket blipped: the line cap is
 *  a quality gate, but it's deterministic and daemon-independent, so it belongs in
 *  the cold path alongside the destructive-command and supply-chain guards. */
export function coldLargeFileBlockReason(event: UnifiedHookEvent): string | null {
	if (event.phase !== PHASE_PRE_TOOL) return null;
	const action = event.action;
	if (action.kind !== ACTION_TOOL_CALL) return null;
	const cwd = resolveColdCwd(event) || process.cwd();
	// `checkLargeFileLineCountWrite` self-filters: it returns null for any input
	// that isn't a file-write shape (no file_path / unknown tool), so no tool-name
	// gate is needed here.
	// SAFETY: tool_input is runner-supplied JSON (parsed, not typed); the check
	// type-tests every field it reads, so any object shape is sound to pass.
	const result = checkLargeFileLineCountWrite((action.tool_input ?? {}) as JsonObject, cwd);
	return result?.block ?? null;
}
