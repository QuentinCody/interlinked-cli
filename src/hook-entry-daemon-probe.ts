// ===========================================
// Cold-fallback freshness probe — ask the socket before declaring an outage
// ===========================================
// The cold gate decided "the daemon is gone" from FILES: a pid file, a socket
// file, a ledger tail. On 2026-08-15 that produced a false outage of the worst
// kind — a Write refused with "last daemon (pid 50829) exited 276s ago:
// startup-failed" at the same moment a live daemon under a DIFFERENT pid was
// answering Bash gate checks on the same repo. The evidence was stale in two
// ways at once: the ledger row was three exits old, and no one had asked the
// socket.
//
// So the block now costs one connect. If ANY daemon socket for this repo
// accepts within the budget, there is no outage and nothing is blocked — the
// original RPC simply lost a race or hit a busy event loop. Only when nothing
// answers does the fail-closed block stand.
//
// The budget is deliberately small: this runs on the hook path, and a healthy
// Unix-domain accept is sub-millisecond. A daemon too busy to accept in 250ms
// is a daemon whose block would be wrong for a different reason — but the
// existing "alive pid + socket present ⇒ allow" branch already covers that
// case before we get here.

import { isDaemonSocketServing, daemonSocketPaths } from "./harness/session-paths.js";
import type { UnifiedHookEvent } from "./harness/unified-event.js";
import {
	coldDaemonUnreachableBlockReason,
	daemonRecoveryRoot,
	findRepoRoot,
} from "./hook-entry-daemon-gate.js";

/** Connect budget for the freshness probe. */
const FRESH_PROBE_TIMEOUT_MS = 250;

export interface FreshnessProbeDeps {
	listSockets?: (root: string) => string[];
	probe?: (socketPath: string) => Promise<boolean>;
	/** Forwarded to the sync gate: where the loud `INTERLINKED_ALLOW_NO_DAEMON=1`
	 *  bypass notice goes. Defaults to stderr inside the gate. */
	warn?: (message: string) => void;
}

/** True when SOME daemon socket for `root` accepts a connection right now. */
async function daemonAnswersNow(
	root: string,
	deps: FreshnessProbeDeps = {},
): Promise<boolean> {
	const list = deps.listSockets ?? daemonSocketPaths;
	const probe =
		deps.probe ?? ((p: string) => isDaemonSocketServing(p, { timeout_ms: FRESH_PROBE_TIMEOUT_MS }));
	for (const socketPath of list(root)) {
		if (await probe(socketPath)) return true;
	}
	return false;
}

/**
 * The cold daemon-down decision, with one fresh socket probe before it stands.
 *
 * Delegates the whole policy (escape hatches, disable marker, alive-but-slow
 * allow, message wording) to the sync gate — this only adds the "…but check
 * whether it is actually down" step, and only on the block path, so the happy
 * path pays nothing.
 */
/** @deprecated Compatibility/test surface for the retired blanket outage
 * block. Do not call this from a hook runtime. */
export async function coldDaemonUnreachableBlockReasonFresh(
	event: UnifiedHookEvent,
	cwd: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	deps: FreshnessProbeDeps = {},
): Promise<string | null> {
	const reason = coldDaemonUnreachableBlockReason(
		event,
		cwd,
		env,
		deps.warn ? { warn: deps.warn } : {},
	);
	if (reason === null) return null;
	const root = findRepoRoot(cwd ?? event.context.cwd);
	if (root === null) return reason;
	return (await daemonAnswersNow(root, deps)) ? null : reason;
}

/** Recovery trigger for every hook phase, with the same fresh socket proof as
 * the pre-tool legacy gate. A stale pid/ledger/socket snapshot must not launch
 * a competing daemon when any socket is actually serving. */
export async function daemonRecoveryRootFresh(
	event: UnifiedHookEvent,
	cwd: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	deps: FreshnessProbeDeps = {},
): Promise<string | null> {
	const root = daemonRecoveryRoot(event, cwd, env);
	if (root === null) return null;
	return (await daemonAnswersNow(root, deps)) ? null : root;
}
