// ===========================================
// Hook client deadline routing
// ===========================================
// How long the thin client (hook-entry.ts) waits for the daemon's verdict,
// per event. This is a TRANSPORT failsafe for a hung daemon, NOT the daemon's
// work budget: the daemon answers the instant it has a verdict, so a fast
// event returns in ~1ms regardless of the ceiling. If the client gives up
// FIRST it cold-fallback-ALLOWS — so any ceiling set below the daemon's real
// work window silently discards the verdict after the cost was already paid.
// Extracted from hook-entry.ts (2026-07-17) when the commit-gate branch pushed
// that file toward its line cap; hook-entry.ts re-exports `isCodeEditEvent` for
// its existing test importers.
//
// The one invariant across all three surfaces (daemon budget < client deadline
// < Claude Code hook grant): the client must be able to outwait any verdict the
// daemon will actually produce, and Claude Code must be able to outwait the
// client. Grants live in lib/hook-timeouts.ts (PreToolUse 240s / PostToolUse
// 120s); the client deadlines here sit below them.

import { isGitPushCommand, parseGitCommit } from "./harness/evaluator/commit-parse.js";
import { DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS } from "./harness/legacy-client.js";
import { asShellCommand, type UnifiedHookEvent } from "./harness/unified-event.js";

const PHASE_PRE_TOOL = "pre-tool";
const ACTION_TOOL_CALL = "tool_call";
const ACTION_FILE_OPERATION = "file_operation";

/**
 * Ceiling for non-PreToolUse events (PostToolUse + Stop/SessionStart/etc.). A
 * MAX wait, not a fixed delay: the daemon answers the instant it has a verdict,
 * so a small repo returns in ~1ms regardless. It only bites on a BIG repo where
 * the PostToolUse quality pass (tsc + biome + inline checks) is slow — on
 * mcp-client-bio a WARM edit measured ~2–3s. A truly-down daemon still fails
 * fast via the separate connect timeout, so raising this only lets a
 * slow-but-working daemon finish (warnings defer to next turn if it does time
 * out — e.g. the ~8s cold-start tsgo load on the first edit after a restart).
 * Raised 5s → 60s with the 2026-07-17 per-edit-tests directive: the PostToolUse
 * quality pass should LAND as feedback, not be clipped mid-run (the installer
 * grants the hook 120s, so this ceiling stays the binding one).
 */
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/**
 * Client wait ceiling for a code-edit PreToolUse. A Write/Edit can trigger the
 * daemon's per-edit coverage/CRAP overlay, which runs to its `budget_ms` — how
 * long that may take is the DAEMON's policy (the budget gate), not this
 * constant's: the client ceiling is a transport failsafe for a hung daemon and
 * must sit comfortably ABOVE any sane budget. Observed live 2026-07-17 when a
 * 30s ceiling met a 30.1s run (and, earlier, the 2026-05-era 5s ceiling met the
 * 25s budget — the two were never reconciled, found 2026-06-12). Raised 30s →
 * 180s 2026-07-17 (guard-rules.json pins budget_ms high; the verdict MUST
 * arrive). Sits below the 240s PreToolUse hook grant.
 */
const COVERAGE_EDIT_PRE_TOOL_TIMEOUT_MS = 180_000;

/**
 * Client wait ceiling for a `git commit` / `git push` PreToolUse. A commit runs
 * the daemon's COMMIT gate — the FULL suite + coverage + CRAP (server-side
 * `COMMIT_RUN_TIMEOUT_MS` = 600s), the outflow anchor deferred per-edit work
 * lands on. Before 2026-07-17 a commit was a plain Bash event, so it inherited
 * the 5s legacy ceiling (below) and the client cold-fallback-ALLOWED before any
 * real suite finished — the commit gate never blocked on any repo whose suite
 * exceeded 5s (the whole point of the gate, silently defeated). Set to 220s:
 * the largest verdict deliverable under the 240s PreToolUse hook grant. A suite
 * that needs MORE than ~220s is the cloud-offload boundary (a synchronous hook
 * cannot outwait Claude Code's own kill), not something a bigger local ceiling
 * fixes.
 */
const COMMIT_PRE_TOOL_TIMEOUT_MS = 220_000;

// Stored NORMALIZED (lowercased, underscores stripped) so every naming style
// maps in: Claude/Codex camelCase `MultiEdit`/`NotebookEdit` AND snake_case
// `multi_edit`/`notebook_edit`/`apply_patch` all collapse to the same key.
const EDIT_TOOL_NAMES = new Set(["write", "edit", "multiedit", "applypatch", "notebookedit"]);

/** A PreToolUse whose tool could trigger the per-edit coverage overlay. */
export function isCodeEditEvent(event: UnifiedHookEvent): boolean {
	const action = event.action as { kind?: string; tool_name?: string };
	if (action.kind === ACTION_FILE_OPERATION) return true;
	return (
		action.kind === ACTION_TOOL_CALL &&
		EDIT_TOOL_NAMES.has((action.tool_name ?? "").toLowerCase().replace(/_/g, ""))
	);
}

/**
 * A PreToolUse Bash `git commit` / `git push` — the events that trigger the
 * slow server-side commit / push gates. Uses the shared, quote/comment-aware
 * git parsers (single source with the server-side gates), so `# git push` in a
 * comment and a quoted `"git commit"` do not qualify for the long deadline.
 */
export function isCommitOrPushEvent(event: UnifiedHookEvent): boolean {
	const shell = asShellCommand(event);
	if (!shell) return false;
	const command = shell.command;
	return parseGitCommit(command)?.isCommit === true || isGitPushCommand(command);
}

/**
 * The client's wait ceiling for an event. PreToolUse edits wait for the overlay
 * verdict (180s); PreToolUse commits/pushes wait for the full-suite gate
 * (220s); other PreToolUse (Read/Grep/plain Bash) answer in ~1ms so keep the
 * snappy 5s legacy ceiling; everything else gets the 60s default.
 */
/**
 * UserPromptSubmit ceiling. The 60s default violated this file's own invariant
 * (client deadline < hook grant) for exactly one event: Claude Code grants the
 * user-prompt hook 30s, so a slow daemon — heap-spike thrash, or queued behind
 * a heavy PostToolUse on the single event loop — made the client outwait the
 * grant and the runner killed the hook ("timed out after 30s — output
 * discarded") with the USER eating all 30s of keystroke latency. This is the
 * one hook a human is synchronously waiting on; its work is context injection,
 * nice-to-have by definition. On timeout the prompt proceeds without it.
 */
const USER_PROMPT_TIMEOUT_MS = 3_000;
const PHASE_USER_PROMPT = "user-prompt";

export function defaultTimeoutForPhase(event: UnifiedHookEvent): number {
	if (event.phase === PHASE_USER_PROMPT) return USER_PROMPT_TIMEOUT_MS;
	if (event.phase !== PHASE_PRE_TOOL) return DEFAULT_HOOK_TIMEOUT_MS;
	if (isCodeEditEvent(event)) return COVERAGE_EDIT_PRE_TOOL_TIMEOUT_MS;
	if (isCommitOrPushEvent(event)) return COMMIT_PRE_TOOL_TIMEOUT_MS;
	return DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS;
}
