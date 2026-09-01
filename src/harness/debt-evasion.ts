// ===========================================
// Debt-evasion visibility — inline-exec after a debt-focus block
// ===========================================
// The write gates can only govern code that arrives through a watched channel.
// Interpreter inline-exec (`node -e`, `python -c`, code piped or heredoc'd
// into an interpreter) is the unwatched one: after a debt-focus block, running
// the same code inline "complies" while the guarantees silently vanish
// (observed live 2026-07-17 — a blocked scratch/ Write re-run as `node -e`).
// Blocking would violate the zero-FP pre_block contract (plenty of legitimate
// one-liners), so this is VISIBILITY only: count inline-exec Bash commands
// that run after this session experienced a debt wander-block, and reflect
// the count once at Stop. Observation here, decisions elsewhere — the same
// contract as the obligation ledger.

import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "./types.js";

/** The one session-lookup capability {@link noteWanderBlockDecision} needs —
 *  narrow so tests never have to build a ServerRuntime. */
interface SessionLookup {
	get(sessionId: string): SessionTrajectory | undefined;
}

/** Interpreter inline-exec shapes: eval flags, code piped INTO an interpreter,
 *  or a heredoc feeding one. Deliberately narrow — this is a visibility
 *  signal, not a gate: a missed exotic form is fine; a false positive trains
 *  agents to ignore the reflection. */
const INLINE_EXEC_PATTERNS: readonly RegExp[] = [
	/(?:^|[;&|(\s])(?:node|deno|bun)\s+(?:-e|--eval|-p|--print)\b/,
	/(?:^|[;&|(\s])python3?\s+-c\b/,
	/(?:^|[;&|(\s])(?:ruby|perl)\s+-e\b/,
	/\|\s*(?:node|python3?|ruby|perl)\b\s*$/,
	/(?:^|[;&|(\s])(?:node|python3?)\b[^|;&]*<<-?\s*['"]?\w+/,
];

/** True for a Bash command that executes interpreter code inline. */
export function isInlineExecCommand(command: string): boolean {
	return INLINE_EXEC_PATTERNS.some((rx) => rx.test(command));
}

/** Mark that this session just received a debt-focus wander block. */
export function markDebtWanderBlocked(session: SessionTrajectory, atMs: number): void {
	session.debt_wander_blocked_at_ms = atMs;
}

/** Observe a coverage-gate outcome: a debt-focus wander block arms this
 *  session's inline-exec counter; every other outcome (allow / null / other
 *  blocks) is a no-op. Called unconditionally by the gate phase so the logic
 *  lives HERE, fully unit-testable against the narrow {@link SessionLookup} —
 *  not buried in a branch only a live suite run can reach. */
export function noteWanderBlockDecision(
	sessions: SessionLookup,
	event: HarnessEvent,
	decision: HarnessDecision | null,
	atMs: number,
): void {
	if (decision?.decision !== "block" || decision.rule_id !== "per-edit-coverage-debt") return;
	const session = sessions.get(event.session_id);
	if (session) markDebtWanderBlocked(session, atMs);
}

/** Count a Bash inline-exec that runs AFTER this session was debt-blocked.
 *  Wired into `SessionTracker.recordEvent` alongside the other track* calls. */
export function trackDebtEvasion(session: SessionTrajectory, event: HarnessEvent): void {
	if (session.debt_wander_blocked_at_ms === undefined) return;
	if (event.tool_name !== "Bash") return;
	const raw = event.tool_input?.command;
	const command = typeof raw === "string" ? raw : "";
	if (!command || !isInlineExecCommand(command)) return;
	session.inline_exec_after_debt_block = (session.inline_exec_after_debt_block ?? 0) + 1;
}

/** Stop-reflection line; null when the session never showed the pattern. */
export function formatDebtEvasionStopLine(session: SessionTrajectory): string | null {
	const n = session.inline_exec_after_debt_block ?? 0;
	if (n === 0) return null;
	return (
		`[interlinked:debt-evasion] Ran ${n} inline script(s) (node -e / python -c / ` +
		`piped heredoc) after a debt-focus block this session. Inline exec is invisible ` +
		`to the write gates — land probe code in scratch/ (gitignored, quality-gated) ` +
		`or keep working the debted pair instead.`
	);
}
