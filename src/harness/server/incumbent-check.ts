// ===========================================
// Stale-state recovery at bind — connect before you conclude
// ===========================================
// The daemon used to decide who owns the socket from the PID FILE, and only
// looked at the socket when a live foreign pid was found. Two failures came out
// of that, both measured 2026-08-15:
//
//  1. A stale `harness.sock` left by a killed daemon (no pid file, or a pid
//     file naming a recycled pid) made every newcomer's bind fail with
//     EADDRINUSE, exit `startup-failed`, and leave the corpse in place — so the
//     NEXT newcomer failed identically. Minutes of "harness pid present, no
//     live daemon" with nothing serving: a deadlock the system could not leave
//     on its own.
//  2. The inverse: a genuinely healthy incumbent whose pid file had been
//     cleaned got its socket unlinked out from under it.
//
// Both disappear once the question is asked of the SOCKET instead of the pid
// table: perform the expected Interlinked protocol round-trip. A valid response
// proves an incumbent is serving (defer, exit 0, never signal it). A refused
// connection proves nobody is home; an accepting but silent/unrelated listener
// is occupied-unready and is never unlinked without verified ownership.
// PIDs stay advisory — they name who to reap, never whether to reap.

import { existsSync } from "node:fs";
import { classifyDaemonSocket, liveForeignDaemonPid } from "../session-paths.js";
import type { HarnessSocketState } from "../socket-readiness.js";
import {
	type AntiStompDeps,
	antiStompDepsFor,
	loseAntiStompRace,
	reapZombieIncumbent,
} from "./anti-stomp.js";
import { removeFileIfExists } from "./socket-lifecycle.js";

// Re-exported so a starting daemon takes its whole bind-time policy — the
// incumbent verdict AND the loser contract the framed path also needs — from
// one module.
export { antiStompDepsFor } from "./anti-stomp.js";

type IncumbentVerdict =
	/** A live listener accepted a connection. Defer to it; do NOT bind or signal. */
	| { kind: "serving"; pid: number | null }
	/** A socket file existed but nothing answered. The corpse was removed; bind. */
	| { kind: "stale"; pid: number | null }
	/** A listener accepted but did not prove the Interlinked protocol. */
	| { kind: "occupied_unready"; pid: number | null }
	/** No socket file at all — a clean start. */
	| { kind: "clear" };

export interface IncumbentDeps {
	fileExists: (path: string) => boolean;
	/** Classifies protocol readiness separately from an absent pathname. Must
	 * fail safe to occupied-unready on ambiguity. */
	probe: (path: string) => Promise<HarnessSocketState>;
	/** PID of a live, foreign process holding `pidPath`, else null. */
	liveForeignPid: (pidPath: string) => number | null;
	removeFile: (path: string) => void;
	log: (msg: string) => void;
}

/**
 * Decide what a starting daemon should do about whatever already occupies its
 * socket path, and clear the corpse when there is one.
 *
 * Side effect by design: on the `stale` verdict the dead socket file (and a pid
 * file naming a process that is gone) are unlinked here, so the caller's bind
 * cannot hit EADDRINUSE against a file nobody owns. A pid file naming a LIVE
 * process is left in place — the caller reaps that process explicitly.
 */
export async function resolveIncumbent(
	socketPath: string,
	pidPath: string,
	deps: IncumbentDeps,
): Promise<IncumbentVerdict> {
	const pid = deps.liveForeignPid(pidPath);
	if (!deps.fileExists(socketPath)) {
		// A live daemon pid without its raw socket is the deaf-zombie class this
		// arbitration exists to recover. A framed-only process does not claim
		// the raw pid path, so it cannot legitimately reach this branch.
		return pid === null ? { kind: "clear" } : { kind: "stale", pid };
	}

	let socketState: HarnessSocketState;
	try {
		socketState = await deps.probe(socketPath);
	} catch {
		// A throw from the probe itself is not proof of death. Fail safe:
		// defer, exactly as the pre-2026-08 behavior did.
		socketState = "occupied_unready";
	}
	if (socketState === "ready") return { kind: "serving", pid };
	// A process accepting connections without completing the Interlinked
	// protocol is never proof of a stale pathname, even when a pid file also
	// exists. Treating that combination as stale would authorize signalling a
	// live but unrelated (or merely slow) process after an ambiguous probe.
	if (socketState === "occupied_unready") return { kind: "occupied_unready", pid };

	deps.log(
		`[interlinked] ${socketPath} exists but refuses connections — removing the stale socket ` +
			`${pid === null ? "(no live owner)" : `(pid ${pid} is alive but not serving)`} and binding.`,
	);
	// Do not unlink a live owner's pathname before the caller has verified and
	// stopped that exact process. Its delayed shutdown could otherwise erase a
	// successor that already rebound the same path.
	if (pid === null) deps.removeFile(socketPath);
	// A pid file whose process is gone is the other half of the corpse: leaving
	// it made `harness status` and the hook's cold gate report a daemon that
	// does not exist. A LIVE pid stays — the caller reaps that one by signal.
	if (pid === null) deps.removeFile(pidPath);
	return { kind: "stale", pid };
}

async function confirmedSocketState(path: string): Promise<HarnessSocketState> {
	const first = await classifyDaemonSocket(path);
	if (first !== "occupied_unready") return first;
	return classifyDaemonSocket(path);
}

interface SettleIncumbentArgs {
	socketPath: string;
	pidPath: string;
	cwd: string;
	logAlways: (msg: string) => void;
	/** Test seam — defaults to this daemon's own loser contract (log, ledger
	 *  row, exit 0). Owned here so the caller needs one import, not two. */
	antiStomp?: AntiStompDeps;
	/** Test seam — defaults to the real fs/socket probe wiring. */
	deps?: IncumbentDeps;
	/** Test seam for identity-bound process termination. */
	reap?: typeof reapZombieIncumbent;
}

async function handleStalePid(
	args: SettleIncumbentArgs,
	deps: IncumbentDeps,
	pid: number,
): Promise<void> {
	const outcome = await (args.reap ?? reapZombieIncumbent)({
		pid,
		cwd: args.cwd,
		logAlways: args.logAlways,
	});
	if (outcome !== "gone") {
		throw new Error(`Daemon PID ${pid} could not be stopped with verified identity.`);
	}
	// The socket failed two protocol probes, so it is not a usable incumbent.
	// An unverified pid is left unsignalled, but stale path metadata must not
	// prevent the replacement from binding.
	deps.removeFile(args.socketPath);
	deps.removeFile(args.pidPath);
}

/**
 * The daemon's whole pre-bind decision, in one call: resolve the incumbent,
 * defer (exit 0) to one that answers, reap one that is alive but deaf.
 *
 * Lives here rather than inline in server.ts so the policy is testable and so
 * server.ts holds under its line cap. Returns the verdict for tests; in
 * production the `serving` branch does not return at all (it exits).
 */
export async function settleIncumbentAtBind(args: SettleIncumbentArgs): Promise<IncumbentVerdict> {
	const deps: IncumbentDeps = args.deps ?? {
		fileExists: existsSync,
		probe: confirmedSocketState,
		liveForeignPid: liveForeignDaemonPid,
		removeFile: removeFileIfExists,
		log: args.logAlways,
	};
	const verdict = await resolveIncumbent(args.socketPath, args.pidPath, deps);
	if (verdict.kind === "serving") {
		loseAntiStompRace({
			ownerPid: verdict.pid ?? 0,
			detail: "the raw socket",
			cwd: args.cwd,
			deps: args.antiStomp ?? antiStompDepsFor(args.cwd, args.logAlways),
		});
	} else if (verdict.kind === "occupied_unready") {
		throw new Error(`A listener occupies ${args.socketPath} but did not prove the Interlinked protocol.`);
	} else if (verdict.kind === "stale" && verdict.pid !== null) {
		await handleStalePid(args, deps, verdict.pid);
	}
	return verdict;
}
