// ===========================================
// Daemon startup guard — reach "listening" or die loudly
// ===========================================
// `installCrashResilience()` keeps the daemon alive through an uncaught error
// BY DESIGN (guard continuity — see ./crash-resilience.ts). That contract is
// right only for a daemon that is actually serving. Applied to a failure that
// happens BEFORE any socket is bound it produces the worst state the system
// can be in: a process that is alive, holds the pid file every anti-stomp
// check reads, and answers nothing. A fresh-eyes audit (2026-08-14, F1)
// reproduced exactly that three times — the daemon logged "exiting so
// auto-revive can spawn a working daemon", then its own uncaughtException
// handler cancelled the exit one line later, and both `interlinked harness
// status` and `interlinked doctor` reported the resulting ~110 MB zombie as
// healthy.
//
// So startup has a different contract from steady state, and this module owns
// it. Two halves:
//
//  - `createStartupGuard()` — the latch. It knows which listeners THIS
//    protocol mode must bind (raw / framed / both), records the ledger's
//    `listening` row the moment the last one reports, and answers
//    `isStartupComplete()` for the crash-resilience handler. Before it flips,
//    an uncaught error is a STARTUP failure and is fatal; after it flips, the
//    survive-for-continuity behavior is restored unchanged.
//  - `startFramedDaemonOrExit()` — the framed bind, with BOTH of its failure
//    modes routed to a terminal contract. An ownership conflict is an
//    already-decided race (anti-stomp: log, ledger row, exit 0); anything
//    else is a genuine startup failure (exit `EXIT_STARTUP_FAILED`). Neither
//    rethrows: a throw out of the top-level await is precisely what reached
//    the survive handler and produced the zombie.

import { type DaemonLedgerEvent, recordDaemonEvent } from "../daemon-ledger.js";
import { consumeHandoverAttemptEnv } from "../handover-churn.js";
import { releaseStartupLock } from "../startup-lock.js";
import {
	DaemonOwnershipConflictError,
	type SessionDaemonHandle,
	type SessionDaemonOptions,
	startSessionDaemon,
} from "../session-daemon.js";
import { type AntiStompDeps, loseAntiStompRace } from "./anti-stomp.js";
import { type CrashResilienceOptions, installCrashResilience } from "./crash-resilience.js";

/** Exit code for "the daemon never reached a listening state". Deliberately
 *  distinct from 0 (graceful shutdown, and the anti-stomp loser's exit) and 1
 *  (generic crash / raw-listen legacy path) so a supervisor — or a human
 *  reading `daemon-events.jsonl` — can tell a failed BIND from every other way
 *  a daemon can leave. 78 is sysexits' EX_CONFIG: the environment, not the
 *  code, is what refused. */
export const EXIT_STARTUP_FAILED = 78;

/** The ledger `reason` written for every startup failure. Readers print
 *  unknown reasons verbatim, so this is additive. Module-private on purpose:
 *  consumers read the ledger ROWS, never this constant. */
const STARTUP_FAILED_REASON = "startup-failed";

export interface StartupGuardOptions {
	cwd: string;
	/** Whether this protocol mode binds the legacy raw socket. */
	runRaw: boolean;
	/** Whether this protocol mode binds the framed session socket. */
	runFramed: boolean;
	logAlways: (msg: string) => void;
	/** Test seam — defaults to the real `process.exit`. */
	exit?: (code: number) => void;
	/** Test seam — defaults to appending to `.interlinked/daemon-events.jsonl`. */
	recordEvent?: (evt: DaemonLedgerEvent) => void;
	/** Test seam — release the startup lease transferred to this daemon after
	 *  it either becomes ready or terminates during startup. */
	releaseStartup?: () => void;
	/** Test seam — defaults to `installCrashResilience`. Creating the guard
	 *  ARMS the process-level handlers with it, because the two are one
	 *  policy: "survive once serving, die loudly before". Splitting them let
	 *  the daemon run with survive-always semantics during startup, which is
	 *  the bug (F1). */
	install?: (opts: CrashResilienceOptions) => void;
	/** Test seam — the handover attempt id this daemon was spawned to serve.
	 *  Defaults to consuming (read + clear) {@link consumeHandoverAttemptEnv}
	 *  from the real process env; stamped on the `listening` row so the churn
	 *  counter can pair it with the parent's `spawned` row in either order. */
	attemptId?: string;
}

/** Structurally satisfies `CrashResilienceOptions`, so the guard can be handed
 *  straight to `installCrashResilience()`. */
export interface StartupGuard extends CrashResilienceOptions {
	/** Report that one listener is now bound. When the LAST one reports, the
	 *  daemon is serving: the ledger gets its `listening` row and uncaught
	 *  errors go back to being survivable. */
	note: (which: "raw" | "framed") => void;
	/** Terminal: log, record the exit row, exit non-zero. Never returns
	 *  normally (the injected `exit` seam may, in tests). */
	fail: (what: string, err: unknown) => void;
	isStartupComplete: () => boolean;
	onStartupFailure: (kind: string, err: unknown) => void;
}

/** First line of an error's stack/message — the ledger `detail` should stay
 *  one grep-able line, while the full stack goes to the log. */
function firstLine(text: string): string {
	return text.split("\n")[0] ?? text;
}

function describeError(err: unknown): string {
	if (err instanceof Error) return err.stack ?? err.message;
	return String(err);
}

export function createStartupGuard(opts: StartupGuardOptions): StartupGuard {
	const exit = opts.exit ?? ((code: number) => process.exit(code));
	const recordEvent =
		opts.recordEvent ?? ((evt: DaemonLedgerEvent) => recordDaemonEvent(opts.cwd, evt));
	const releaseStartup = opts.releaseStartup ?? (() => releaseStartupLock(opts.cwd));
	// A listener this mode does not run is "already bound" — nothing to wait for.
	const bound = { raw: !opts.runRaw, framed: !opts.runFramed };
	let complete = false;
	// Consumed (read + cleared) at guard creation, BEFORE any handover this
	// daemon might itself spawn later copies process.env — see handover-churn.
	const attemptId = opts.attemptId ?? consumeHandoverAttemptEnv();

	const note = (which: "raw" | "framed"): void => {
		bound[which] = true;
		if (complete || !bound.raw || !bound.framed) return;
		complete = true;
		try {
			recordEvent({
				at: Date.now(),
				pid: process.pid,
				event: "listening",
				...(attemptId !== undefined ? { attempt_id: attemptId } : {}),
			});
		} finally {
			releaseStartup();
		}
	};

	const fail = (what: string, err: unknown): void => {
		const detail = describeError(err);
		opts.logAlways(
			`[interlinked] FATAL during startup (${what}): ${detail} — exiting ${EXIT_STARTUP_FAILED}. ` +
				"A daemon that never bound its socket must NOT stay resident: it would hold the pid " +
				"file while answering nothing, and every diagnostic would call it healthy. " +
				"Auto-revive (or `interlinked harness start`) will spawn a working replacement.",
		);
		try {
			recordEvent({
				at: Date.now(),
				pid: process.pid,
				event: "exit",
				reason: STARTUP_FAILED_REASON,
				detail: `${what}: ${firstLine(detail)}`,
				// A startup-failed exit is TERMINAL for the attempt that spawned this
				// daemon — the id on the row resolves it in the churn reducer, so the
				// backstop never waits on a daemon that already died pre-listening.
				...(attemptId !== undefined ? { attempt_id: attemptId } : {}),
			});
		} finally {
			try {
				releaseStartup();
			} finally {
				exit(EXIT_STARTUP_FAILED);
			}
		}
	};

	const guard: StartupGuard = {
		note,
		fail,
		isStartupComplete: () => complete,
		onStartupFailure: (kind: string, err: unknown) => fail(kind, err),
	};
	(opts.install ?? installCrashResilience)(guard);
	return guard;
}

interface FramedStartupDeps {
	cwd: string;
	antiStomp: AntiStompDeps;
	startup: StartupGuard;
}

/**
 * Start the framed session daemon, resolving BOTH failure modes here instead
 * of throwing out of server.ts's top-level await.
 *
 * Returns the handle on success, or null when a failure path already
 * terminated the process (the null exists for the test seams, where `exit` is
 * injected and returns).
 */
export async function startFramedDaemonOrExit(
	opts: SessionDaemonOptions,
	deps: FramedStartupDeps,
): Promise<SessionDaemonHandle | null> {
	try {
		const handle = await startSessionDaemon(opts);
		deps.startup.note("framed");
		return handle;
	} catch (err) {
		if (err instanceof DaemonOwnershipConflictError) {
			// Sibling daemon won the session's ownership race — see ./anti-stomp.ts.
			loseAntiStompRace({
				ownerPid: err.ownerPid,
				detail: `the framed session "${opts.session_id}"`,
				cwd: deps.cwd,
				deps: deps.antiStomp,
			});
			return null;
		}
		deps.startup.fail(`framed session "${opts.session_id}" startup`, err);
		return null;
	}
}

// The post-listen smoke test belongs to this module's job — "may this daemon
// serve?" — but lives in its own file so it is unit-testable without a socket.
// Re-exported here so `server.ts` reaches every startup gate through ONE import
// (that file sits at its grandfathered line cap and cannot grow by one).
export { runStartupSelfCheck } from "../startup-selfcheck.js";
