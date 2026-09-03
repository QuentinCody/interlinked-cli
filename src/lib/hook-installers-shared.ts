// ===========================================
// Hook Installers — Shared helpers
// ===========================================
// Common machinery used by every per-client installer in
// `hook-installers-<client>.ts`: JSON file read/write, the hook-entry
// upsert + matcher logic, the shell command builder, and the generic
// hook-file cleaner. Split into its own module (rather than living in the
// `hook-installers.ts` barrel) so the client modules can import it without
// a circular dependency back through the barrel — the same pattern
// `hook-types.ts` uses to keep `hooks.ts` and the installers decoupled.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { documentContainsInterlinkedHook, isInterlinkedHookEntry } from "./hook-ownership.js";
import { readJsonObject } from "./json-file.js";
import { hookTimeoutSecondsFor } from "./hook-timeouts.js";
import {
	CLIENT_CLAUDE,
	CLIENT_CODEX,
	CLIENT_COPILOT,
	CLIENT_CURSOR,
	CLIENT_GEMINI,
	findProjectRoot,
	type HookEntry,
	INTERLINKED_MARKER,
} from "./hook-types.js";
import type { JsonObject } from "./json-types.js";
import type { ClientName } from "./settings.js";

// PostToolUse matcher — capture every tool's result for full observability.
// Empty string = match every tool. The tradeoff: Claude Code shows "N
// PostToolUse hooks ran" once per tool in the turn (Read + Edit = "2 hooks
// ran"), which is mildly noisy in the UI. We accept that noise because:
//   (1) without it, Bash stdout/stderr, Read file contents, Grep results,
//       WebFetch responses are all lost — there's no other event that
//       carries them;
//   (2) the hook script fast-paths non-mutating tools — it appendLocal()s
//       the result and exits without contacting the harness, so the
//       per-tool latency cost is ~0.1 ms.
// `apply_patch` is Codex CLI's primary file-edit tool; with matcher="" it
// matches naturally alongside Edit/Write/MultiEdit. The hook script's
// internal known-read-only set decides which successful events may skip quality
// pipeline.
const POST_TOOL_USE_MATCHER = "";

// Event names that carry a tool matcher. The matcher is intentionally empty,
// so all completed tools are observable; the generated hook fast-paths only
// its explicit read-only allowlist.
const SCOPED_MATCHER_EVENTS = new Set(["PostToolUse", "AfterTool"]);

// Per-event hook timeouts live in ./hook-timeouts.ts — the single source both
// this legacy installer and the adapter fragment renderer consume.

// Helpers for conditionals — avoid bare `typeof x === "string"` / `"object"`
// forms which the harness flags as `magic_literal_in_conditional`.
export function isPlainObject(v: unknown): v is JsonObject {
	return v instanceof Object && !Array.isArray(v);
}
export function isNonEmptyString(v: unknown): v is string {
	return v === String(v) && v.length > 0;
}

// ===========================================
// Shared Hook Entry Helper
// ===========================================

interface InstallHookEntryOptions {
	timeout?: number;
	async?: boolean;
	statusMessage?: string;
	additionalContextLimit?: number;
}

// `hooks[eventName]` is unvalidated JSON read off disk — a hand-edited or
// legacy settings.json entry may be missing `hooks` entirely, or carry a
// `command` field that isn't a string. `HookEntry` describes the shape we
// WRITE, not what we can trust when scanning existing entries, so scanning
// uses this looser shape instead of asserting the strict one.
interface RawHookEntry {
	matcher?: unknown;
	hooks?: Array<{
		type?: unknown;
		command?: unknown;
		timeout?: unknown;
		async?: unknown;
		statusMessage?: unknown;
		additionalContextLimit?: unknown;
	}>;
}

function hasInterlinkedCommand(h: { command?: unknown }): boolean {
	return typeof h.command === "string" && h.command.includes(INTERLINKED_MARKER);
}

export function installHookEntry(
	hooks: JsonObject,
	eventName: string,
	command: string,
	options: InstallHookEntryOptions = {},
): void {
	if (!hooks[eventName]) hooks[eventName] = [];
	const entries = hooks[eventName] as RawHookEntry[];

	// Check if already installed
	const existing = entries.find((entry) => entry.hooks?.some(hasInterlinkedCommand));

	const timeout = options.timeout ?? hookTimeoutSecondsFor(eventName);
	if (existing) {
		reconcileExistingEntry(existing, eventName, command, timeout, options);
		return;
	}

	entries.push({
		matcher: getHookMatcher(eventName),
		hooks: [buildInstalledHandler(command, timeout, options)],
	});
}

function buildInstalledHandler(
	command: string,
	timeout: number | undefined,
	options: InstallHookEntryOptions,
): HookEntry["hooks"][number] {
	const handler: HookEntry["hooks"][number] = { type: "command", command };
	if (timeout !== undefined) handler.timeout = timeout;
	applyHandlerMetadata(handler, options);
	return handler;
}

/** Reconcile an already-installed entry in place: a stale command path, the
 *  per-event timeout (idempotent upgrade — entries written before timeouts
 *  existed gain one; policy changes propagate), and the matcher. */
function reconcileExistingEntry(
	existing: RawHookEntry,
	eventName: string,
	command: string,
	timeout: number | undefined,
	options: InstallHookEntryOptions,
): void {
	// Update command if it points to a stale path (e.g. .claude/hooks/ → .interlinked/hooks/)
	const hook = existing.hooks?.find(hasInterlinkedCommand);
	if (hook && hook.command !== command) {
		hook.command = command;
	}
	if (hook && timeout !== undefined && hook.timeout !== timeout) {
		hook.timeout = timeout;
	}
	if (hook) applyHandlerMetadata(hook, options);
	// Update the tool-event matcher when the install rules change.
	const expectedMatcher = getHookMatcher(eventName);
	if (existing.matcher !== expectedMatcher) {
		existing.matcher = expectedMatcher;
	}
}

function applyHandlerMetadata(
	hook: { async?: unknown; statusMessage?: unknown; additionalContextLimit?: unknown },
	options: InstallHookEntryOptions,
): void {
	if (options.async !== undefined) hook.async = options.async;
	if (options.statusMessage) hook.statusMessage = options.statusMessage;
	if (options.additionalContextLimit !== undefined) {
		hook.additionalContextLimit = options.additionalContextLimit;
	}
}

function getHookMatcher(eventName: string): string {
	return SCOPED_MATCHER_EVENTS.has(eventName) ? POST_TOOL_USE_MATCHER : "";
}

// ===========================================
// JSON File Helpers
// ===========================================

/**
 * Read a settings file as a JSON object, or null when it is missing,
 * malformed, or not an object. Alias of the shared `readJsonObject` — the
 * name stays because the four installer modules and their tests import it.
 */
export const readJsonFile = readJsonObject;

function serializeJsonFile(data: JsonObject): string {
	return `${JSON.stringify(data, null, 2)}\n`;
}

export function writeJsonFile(path: string, data: JsonObject): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const next = serializeJsonFile(data);
	if (existsSync(path)) {
		try {
			const current = readFileSync(path, "utf-8");
			if (current === next) return;
		} catch (_err) {
			/* intentional: unreadable file — fall through and attempt rewrite */
		}
	}
	writeFileSync(path, next);
}

// The runner label embedded in INTERLINKED_RUNNER for each client — "" for
// clients (or an absent client) that don't get the env-prefix treatment.
function runnerLabelFor(client?: ClientName): string {
	if (client === CLIENT_CLAUDE) return "claude-code";
	if (client === CLIENT_COPILOT) return "copilot-cli";
	if (client === CLIENT_GEMINI) return "gemini-cli";
	if (client === CLIENT_CODEX) return "codex";
	if (client === CLIENT_CURSOR) return "cursor";
	return "";
}

// Absolute paths are already stable — keep the shell snippet short.
function absoluteHookCommand(escapedPath: string, envPrefix: string, isCursorFailClosed: boolean): string {
	if (isCursorFailClosed) {
		// `exec` replaces the shell with node so node's exit code (0 on
		// allow, non-zero on a crash) is what Cursor sees. A missing
		// script file falls through to an explicit `exit 1` — Cursor
		// treats that as a fail-closed denial, which is what the user
		// asked for when they enabled `failClosed: true`.
		return `if test -f "${escapedPath}"; then ${envPrefix}exec node "${escapedPath}"; else exit 1; fi`;
	}
	return `test -f "${escapedPath}" && ${envPrefix}node "${escapedPath}" || true`;
}

// Project-local installs write a relative path like
// `.interlinked/hooks/interlinked-activity.mjs`. The hook may fire from
// a nested cwd inside the repo, so walk upward until the script is found.
//
// CRITICAL: this single-line shell snippet must parse under POSIX sh,
// bash AND zsh — Codex CLI invokes hooks via the user's configured
// shell. `do; if` and `then; ACTION` (semicolon between a keyword and
// its body) are syntax errors in bash/sh/dash; only zsh tolerates
// them. So we glue `do`/`then` directly to the next statement with a
// space rather than building the body via `.join("; ")`. See
// `hook-installers-shell.test.ts` for a regression test that actually
// invokes bash on the generated string.
function relativeHookCommand(escapedPath: string, envPrefix: string, isCursorFailClosed: boolean): string {
	if (isCursorFailClosed) {
		return (
			`HOOK_SCRIPT_REL="${escapedPath}"; ` +
			`HOOK_DIR="$PWD"; ` +
			`while :; do ` +
			`if test -f "$HOOK_DIR/$HOOK_SCRIPT_REL"; then ` +
			`${envPrefix}exec node "$HOOK_DIR/$HOOK_SCRIPT_REL"; ` +
			`fi; ` +
			`NEXT_HOOK_DIR=$(dirname "$HOOK_DIR"); ` +
			`test "$NEXT_HOOK_DIR" = "$HOOK_DIR" && exit 1; ` +
			`HOOK_DIR="$NEXT_HOOK_DIR"; ` +
			`done`
		);
	}
	return (
		`HOOK_SCRIPT_REL="${escapedPath}"; ` +
		`HOOK_DIR="$PWD"; ` +
		`while :; do ` +
		`if test -f "$HOOK_DIR/$HOOK_SCRIPT_REL"; then ` +
		`${envPrefix}node "$HOOK_DIR/$HOOK_SCRIPT_REL" || true; ` +
		`break; ` +
		`fi; ` +
		`NEXT_HOOK_DIR=$(dirname "$HOOK_DIR"); ` +
		`test "$NEXT_HOOK_DIR" = "$HOOK_DIR" && break; ` +
		`HOOK_DIR="$NEXT_HOOK_DIR"; ` +
		`done`
	);
}

export function buildHookCommand(hookScriptPath: string, client?: ClientName): string {
	const escapedPath = hookScriptPath.replace(/(["\\`$])/g, "\\$1");
	const runner = runnerLabelFor(client);
	const envPrefix =
		client && runner ? `INTERLINKED_CLIENT="${client}" INTERLINKED_RUNNER="${runner}" ` : "";

	// Cursor is the one client where hook startup/runtime failures must
	// propagate as a non-zero exit so its `failClosed: true` setting
	// actually fails closed. For every other client we keep the historic
	// fail-open shape (`|| true` / `break` on missing script) so a
	// transient error in observation hooks doesn't derail the session.
	const isCursorFailClosed = client === CLIENT_CURSOR;

	if (hookScriptPath.startsWith("/")) {
		return absoluteHookCommand(escapedPath, envPrefix, isCursorFailClosed);
	}
	return relativeHookCommand(escapedPath, envPrefix, isCursorFailClosed);
}

export function cleanJsonHookFile(cwdOrPath: string): boolean {
	const settingsPath = cwdOrPath;
	if (!existsSync(settingsPath)) return false;

	const settings = readJsonFile(settingsPath);
	if (!settings?.hooks || !isPlainObject(settings.hooks)) return false;

	const hooks = settings.hooks;
	let changed = false;

	for (const eventName of Object.keys(hooks)) {
		const entries = hooks[eventName];
		if (!Array.isArray(entries)) continue;

		const filtered = entries.filter((entry) => !isInterlinkedHookEntry(entry));
		if (filtered.length !== entries.length) {
			hooks[eventName] = filtered.length > 0 ? filtered : undefined;
			changed = true;
		}
	}

	if (!changed) return false;

	if (Object.values(hooks).every((v) => v === undefined)) {
		delete settings.hooks;
	}

	writeJsonFile(settingsPath, settings);
	return true;
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (re-exported via the
 * `hook-installers.ts` barrel) and the Claude installer.
 *
 * Walk up from cwd to the git root checking if any ancestor already has
 * interlinked hooks in the given settings file. Returns the ancestor path
 * if found, or null if no parent has hooks.
 */
export function findParentWithHooks(cwd: string, settingsSubpath: string): string | null {
	const gitRoot = findProjectRoot(cwd);
	let dir = dirname(cwd);
	const stopAt = gitRoot || parse(cwd).root;

	while (dir.length >= stopAt.length) {
		const settingsPath = join(dir, settingsSubpath);
		if (existsSync(settingsPath)) {
			try {
				// PARSE, then walk (review 2026-08-30 final pass): the command
				// recognizer takes one shell command, never a JSON document.
				const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
				if (documentContainsInterlinkedHook(parsed)) {
					return dir;
				}
			} catch (_err) {
				/* intentional: settings file unreadable/unparseable — keep walking up */
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}
