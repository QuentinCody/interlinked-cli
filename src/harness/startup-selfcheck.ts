// ===========================================
// Startup self-check — refuse to serve a broken build
// ===========================================
// Cause (1) of the 2026-08-16 restart storm. `dist` was rebuilt from a red tree
// — a stopped agent left `lifecycle-stop-warnings.ts` calling a symbol it never
// imported, and tsup transpiles without typechecking, so the build SUCCEEDED.
// The daemon then started, bound its socket, wrote a `listening` row, and threw
// on specific event paths. Every affected tool call read as "harness
// unreachable"; every blocked caller asked for a restart; the loop ran for
// hours. The build was bad from the first second and nothing said so.
//
// The fix is a smoke test the daemon runs on ITSELF, after it is listening: one
// synthetic PreToolUse Edit through the real evaluation pipeline. If that
// throws, the build cannot serve, and a daemon that cannot serve must die
// LOUDLY — with a named ledger row — so the supervisor's backoff sees a
// consistent failure instead of the operator seeing an endless churn of
// daemons that look fine.
//
// Three deliberate limits:
//  - Only a THROW is fatal. A `block` verdict is a working pipeline (the gate
//    did its job), and a SLOW answer is a busy machine, not a bad build.
//    Exiting on either would turn a hiccup into an outage, which is the
//    opposite of what this exists to prevent (`feedback_safety_continuity`).
//  - The probe is dry_run, so no evaluator that persists may record anything
//    for it — the `harness test --write` lesson.
//  - One event shape cannot cover every path (the symbol that actually broke
//    lived on the Stop path). This catches the class where the module graph
//    itself is broken, which is the common case and the cheap one.

import type { DaemonLedgerEvent } from "./daemon-ledger.js";
import type { HarnessDecision } from "./types.js";

/** Reserved session id — never a real agent's, so session state, activity rows,
 *  and trajectory counters can all recognise and ignore the probe. */
export const SELF_CHECK_SESSION_ID = "__interlinked_selfcheck__";

/** Ledger reason for the fatal case. Not in `PLANNED_EXIT_REASONS`, so it
 *  classifies `unknown` rather than masquerading as an orderly shutdown. */
export const SELF_CHECK_FAILED_REASON = "startup-selfcheck-failed";

/** Exit code. 78 = EX_CONFIG (sysexits) — the same code the framed-socket
 *  startup guard uses for "this daemon cannot serve, do not retry blindly". */
export const SELF_CHECK_EXIT_CODE = 78;

/** Budget for the probe. Exceeding it is a WARNING, never a failure. */
export const SELF_CHECK_TIMEOUT_MS = 100;

/** Cap on the recorded failure detail — the ledger is a tail-read artifact, and
 *  a full stack would push older rows out of every reader's window. */
const MAX_DETAIL_CHARS = 500;

/**
 * The synthetic event line, in the raw wire shape the socket delivers.
 *
 * Deliberately tiny: a two-character edit to a path under `.interlinked/`, the
 * repo's own tool-state dir. That keeps the probe well inside its budget while
 * still traversing parse → dispatch → pre-tool pipeline, which is where a
 * broken module graph blows up.
 */
export function buildSelfCheckEventLine(cwd: string, nowMs: number): string {
	return JSON.stringify({
		hook_event: "PreToolUse",
		session_id: SELF_CHECK_SESSION_ID,
		agent_source: "claude",
		tool_name: "Edit",
		tool_input: {
			file_path: `${cwd}/.interlinked/startup-selfcheck.probe.txt`,
			old_string: "a",
			new_string: "b",
		},
		cwd,
		dry_run: true,
		timestamp: new Date(nowMs).toISOString(),
	});
}

interface StartupSelfCheckDeps {
	cwd: string;
	/** The daemon's real event entry point. */
	evaluate: (line: string, protocol: "raw" | "framed") => Promise<HarnessDecision>;
	log: (message: string) => void;
	recordEvent?: (event: DaemonLedgerEvent) => void;
	exit?: (code: number) => void;
	now?: () => number;
	timeoutMs?: number;
}

/** Resolves `"timeout"` when the budget lapses first. The probe promise is NOT
 *  cancelled — it is left to settle unobserved, with its rejection already
 *  swallowed by the caller, so a late failure cannot kill a serving daemon. */
function withBudget(
	probe: Promise<HarnessDecision>,
	timeoutMs: number,
): Promise<HarnessDecision | "timeout"> {
	return Promise.race([
		probe,
		new Promise<"timeout">((resolve) => {
			const timer = setTimeout(() => resolve("timeout"), timeoutMs);
			if (typeof timer.unref === "function") timer.unref();
		}),
	]);
}

/**
 * Run the probe. Returns true when the daemon may serve.
 *
 * On a throw it records the ledger row and calls `exit` — the caller does not
 * need to act on the return value in production, but it is the unit-test seam
 * and it lets an embedder decide differently.
 */
export async function runStartupSelfCheck(deps: StartupSelfCheckDeps): Promise<boolean> {
	const nowMs = (deps.now ?? Date.now)();
	const line = buildSelfCheckEventLine(deps.cwd, nowMs);
	try {
		// The probe is started INSIDE the try so a synchronous throw — the shape a
		// missing import actually produces at call time — is caught too.
		const probe = deps.evaluate(line, "raw");
		// A late rejection must not become an unhandled rejection once the budget
		// has already let the daemon proceed.
		probe.catch(() => {}); /* fire and forget: a post-budget rejection is reported by the timeout log, and must never kill a daemon already serving */
		const outcome = await withBudget(probe, deps.timeoutMs ?? SELF_CHECK_TIMEOUT_MS);
		if (outcome === "timeout") {
			deps.log(
				"Startup self-check did not finish inside its budget — serving anyway (a slow machine is not a broken build).",
			);
		}
		return true;
	} catch (err) {
		// The rare legitimate `instanceof Error`: this does not DISPATCH on an
		// error subtype, it only asks "is there a message to quote?" before
		// falling back to String(). Nothing branches on which error it is.
		const detail = err instanceof Error ? `${err.message}` : String(err);
		deps.log(`FATAL: startup self-check threw — this build cannot serve. ${detail}`);
		(deps.recordEvent ?? (() => {}))({
			at: nowMs,
			pid: process.pid,
			event: "exit",
			reason: SELF_CHECK_FAILED_REASON,
			detail: detail.slice(0, MAX_DETAIL_CHARS),
		});
		(deps.exit ?? ((code: number) => process.exit(code)))(SELF_CHECK_EXIT_CODE);
		return false;
	}
}
