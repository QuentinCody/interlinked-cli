// ===========================================
// Cursor IDE — Install/Uninstall
// ===========================================
// Cursor's `.cursor/hooks.json` shape is its own — `{ version: 1, hooks: {
// eventName: [{ command, type?, timeout?, failClosed?, matcher? }] } }`. The
// hook entry is a flat object (no `matcher` + nested `hooks: [...]` like
// Claude/Codex). `failClosed: true` is set so Cursor blocks the action if
// our hook crashes — this matches the security posture of the other clients
// where harness-down is fail-open at the destructive-pattern level (inline
// fallback) but fail-closed at the rule-evaluation level. For destructive
// rules in particular, fail-closed is the right default: if the harness
// can't reason about a Bash/MCP call, surface that to the user rather than
// silently allowing.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHookCommand, isPlainObject } from "./hook-installers-shared.js";
import { isInterlinkedHookEntry } from "./hook-ownership.js";
import { CLIENT_CURSOR, INTERLINKED_MARKER } from "./hook-types.js";
import { nonNull } from "./non-null.js";

// Cursor IDE hook events. Cursor exposes the richest hook surface of the
// supported clients (per https://cursor.com/docs/hooks): per-tool gates
// (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`), file-
// edit observation (`afterFileEdit`), prompt + lifecycle hooks
// (`beforeSubmitPrompt`, `sessionStart`, `sessionEnd`, `stop`), plus
// generic `preToolUse`/`postToolUse` aliases. We register the high-signal
// ones — destructive guard rules ride on `beforeShellExecution` (Bash) and
// `beforeMCPExecution` (MCP tools), and the lifecycle events feed activity
// + reservations + harness session state.
//
// `afterShellExecution` / `afterMCPExecution` are intentionally omitted: they
// don't add signal beyond `postToolUse`, and registering more hooks burns
// Cursor's per-event timeout budget.
/** Public API — consumed by `src/lib/hooks.ts`. */
export const CURSOR_HOOK_EVENTS = [
	"sessionStart",
	"sessionEnd",
	"beforeSubmitPrompt",
	"beforeShellExecution",
	"beforeMCPExecution",
	// Cursor has shipped both spellings across builds; install both so the
	// harness remains active regardless of which contract the local IDE emits.
	"beforeMcpToolExecution",
	"beforeReadFile",
	"afterFileEdit",
	"stop",
	"preToolUse",
	"postToolUse",
	// Tool failures: surface to error_history + activity feed.
	"postToolUseFailure",
	// Subagent (Task tool) lifecycle — parity with Claude's SubagentStop.
	"subagentStart",
	"subagentStop",
	// Compaction observation — parity with Claude's PreCompact.
	"preCompact",
] as const;

// Cursor events where a hook crash should block the action (fail-closed).
// These are the gates that, if our hook can't run, an unguarded destructive
// command might land on the user. Lifecycle/observation events (sessionStart,
// afterFileEdit, postToolUse, ...) stay fail-open so a flaky hook doesn't
// break the user's session.
/**
 * Public API — exported so the contract test in
 * `src/lib/__tests__/hook-installers-shell.test.ts` can iterate every
 * fail-closed event and assert the generated command actually exits
 * non-zero on missing/crashed script. Without that pairing, an editor
 * adding a new event here without a matching command-shape change would
 * silently leave it fail-open.
 */
export const CURSOR_FAIL_CLOSED_EVENTS = new Set<string>([
	"beforeShellExecution",
	"beforeMCPExecution",
	"beforeMcpToolExecution",
	"beforeReadFile",
	"preToolUse",
	// Subagent spawn — denying spawn is a gate; if the hook crashes we'd
	// rather block the subagent than allow an unguarded one to launch.
	"subagentStart",
]);

function getCursorHooksPath(cwd: string): string {
	return join(cwd, ".cursor", "hooks.json");
}

interface CursorHookEntry {
	command: string;
	type?: string;
	timeout?: number;
	failClosed?: boolean;
	matcher?: string;
}

interface CursorConfig {
	version: number;
	hooks: Record<string, CursorHookEntry[]>;
}

// `.cursor/hooks.json` is user/editor-authored disk state, not something we
// control — a hand-edited or partially-written file can carry an entry with
// no `command` field (or a non-string one). The old `as Record<string,
// CursorHookEntry[]>` cast asserted `command: string` unconditionally, which
// made every later `.command` access "provably safe" to the type checker
// while actually crashing at runtime on a malformed entry. Validate each
// entry instead so the `CursorHookEntry[]` type this function returns is
// honest — a filtered-out malformed entry is simply not carried forward,
// matching "start over" behavior already used for unparsable JSON above.
function parseCursorHookEntry(raw: unknown): CursorHookEntry | null {
	if (!isPlainObject(raw) || typeof raw.command !== "string") return null;
	const entry: CursorHookEntry = { command: raw.command };
	if (typeof raw.type === "string") entry.type = raw.type;
	if (typeof raw.timeout === "number") entry.timeout = raw.timeout;
	if (typeof raw.failClosed === "boolean") entry.failClosed = raw.failClosed;
	if (typeof raw.matcher === "string") entry.matcher = raw.matcher;
	return entry;
}

function parseCursorConfigShape(raw: unknown): CursorConfig | null {
	if (!isPlainObject(raw)) return null;
	const rawHooks = isPlainObject(raw.hooks) ? raw.hooks : {};
	const hooks: Record<string, CursorHookEntry[]> = {};
	for (const [eventName, entries] of Object.entries(rawHooks)) {
		if (!Array.isArray(entries)) {
			// A non-array value under a hook event key is malformed input we
			// don't own the shape of — preserve it untouched rather than
			// dropping it. Both call sites already guard with
			// `Array.isArray(entries)` before treating this as hook entries.
			(hooks as Record<string, unknown>)[eventName] = entries;
			continue;
		}
		hooks[eventName] = entries
			.map(parseCursorHookEntry)
			.filter((entry): entry is CursorHookEntry => entry !== null);
	}
	return { version: 1, hooks };
}

function safeReadCursorConfig(path: string): CursorConfig | null {
	if (!existsSync(path)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		/* intentional: malformed hooks.json — caller starts over */
		return null;
	}
	return parseCursorConfigShape(raw);
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Install Interlinked hooks into Cursor's `.cursor/hooks.json`.
 *
 * `failClosed: true` is set on guard-relevant hooks (`beforeShellExecution`,
 * `beforeMCPExecution`, `beforeReadFile`, `preToolUse`) so a hook crash
 * blocks the action. Lifecycle / observation hooks (`sessionStart`,
 * `afterFileEdit`, `postToolUse`, etc.) leave `failClosed` unset (fail-open)
 * because they don't gate execution and a hook crash there should not
 * derail the user's session.
 */
export function installCursorHooks(cwd: string, hookScriptPath: string): void {
	const hooksPath = getCursorHooksPath(cwd);
	const dir = dirname(hooksPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const hookCommand = buildHookCommand(hookScriptPath, CLIENT_CURSOR);

	const config = safeReadCursorConfig(hooksPath) || { version: 1, hooks: {} };

	for (const eventName of CURSOR_HOOK_EVENTS) {
		if (!config.hooks[eventName]) config.hooks[eventName] = [];
		const entries = config.hooks[eventName];

		const existing = entries.find((e) => e.command.includes(INTERLINKED_MARKER));
		if (existing) {
			if (existing.command !== hookCommand) {
				existing.command = hookCommand;
			}
			const expectedFailClosed = CURSOR_FAIL_CLOSED_EVENTS.has(eventName);
			if ((existing.failClosed || false) !== expectedFailClosed) {
				existing.failClosed = expectedFailClosed;
			}
			continue;
		}

		const entry: CursorHookEntry = { command: hookCommand, type: "command" };
		if (CURSOR_FAIL_CLOSED_EVENTS.has(eventName)) {
			entry.failClosed = true;
		}
		entries.push(entry);
	}

	config.version = 1;
	writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Remove Interlinked hooks from Cursor's hooks.json. Deletes the file
 * entirely if no other hooks remain.
 */
export function uninstallCursorHooks(cwd: string): boolean {
	const hooksPath = getCursorHooksPath(cwd);
	const config = safeReadCursorConfig(hooksPath);
	if (!config?.hooks) return false;

	let changed = false;
	for (const eventName of Object.keys(config.hooks)) {
		const entries = config.hooks[eventName];
		if (!Array.isArray(entries)) continue;

		const filtered = entries.filter((e) => !isInterlinkedHookEntry(e));
		if (filtered.length !== entries.length) {
			config.hooks[eventName] = filtered;
			changed = true;
		}
	}

	if (changed) {
		const hasHooks = Object.values(config.hooks).some(
			(arr) => Array.isArray(arr) && arr.length > 0,
		);
		if (!hasHooks) {
			rmSync(hooksPath, { force: true });
		} else {
			// Drop empty arrays so the file is minimal post-uninstall.
			for (const k of Object.keys(config.hooks)) {
				if (nonNull(config.hooks[k]).length === 0) delete config.hooks[k];
			}
			writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
		}
	}

	return changed;
}
