import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configuredHeapMb } from "./harness/memory-ceiling.js";
import { acquireStartupLock, transferStartupLock } from "./harness/startup-lock.js";
import {
	recordSupervisorSpawn,
	supervisorSpawnAllowed,
} from "./harness/supervisor-backoff.js";
import { findRepoRoot } from "./lib/interlinked-root.js";
import { readGuardDisable } from "./lib/guard-state.js";

/** Outcome of a self-heal attempt (also the unit-test surface). */
export type SelfHealResult = "spawned" | "locked" | "skipped" | "backoff";

/** Why a self-heal did (or did not) launch. `SelfHealResult` remains the
 * compatibility surface; the hook entry uses this detail so it never claims a
 * recovery is underway when no launch was attempted. */
export type SelfHealDisposition =
	| "launch-attempted"
	| "startup-lock-held"
	| "retry-backoff"
	| "self-heal-disabled"
	| "no-project"
	| "guard-disabled"
	| "server-artifact-missing"
	| "spawn-failed";

export interface SelfHealAttempt {
	result: SelfHealResult;
	disposition: SelfHealDisposition;
	launchAttempted: boolean;
}

// The self-heal throttle IS the daemon startup mutex (harness/startup-lock.ts)
// — deliberately the SAME lock the `interlinked harness start` command takes.
// Two separate throttles meant a hook self-heal and a CLI start could both
// spawn a daemon in the same second, which is one half of the 2026-08-15
// restart storm. The old mtime-based check was also check-then-act: N hooks
// firing together all read "no recent lock" and all spawned. O_EXCL cannot do
// that. The lock is NOT released here — the winner's boot is protected until
// the TTL lapses.

/** Injectable dependencies so the spawn path is unit-testable without actually
 * launching a daemon. Defaults wire the real fs/child_process. */
export interface SelfHealDeps {
	resolveServerPath?: () => string | null;
	/** Returns the detached child's PID. An absent/invalid PID cannot safely
	 * receive the cross-process startup lease and is treated as a failed spawn. */
	spawnDaemon?: (serverPath: string, root: string) => number | undefined;
	/** Test seam for the backoff clock. */
	now?: () => number;
	/** A simulated event must not move the real supervisor's spawn ladder — the
	 * `harness test --write` lesson (a read-only probe that mutated a ledger). */
	dryRun?: boolean;
}

/** Resolve the daemon entry (`dist/harness/server.js`) relative to this bundled
 * module. Returns null when it can't be found (caller stays fail-closed).
 * fileURLToPath + existsSync do not throw for a valid module URL, so no guard. */
function selfHealServerPath(): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "harness", "server.js"),
		join(here, "..", "harness", "server.js"),
		join(here, "dist", "harness", "server.js"),
	];
	return candidates.find((path) => existsSync(path)) ?? null;
}

/** Detached spawn of the daemon from the EXISTING dist — never rebuilds (a
 * rebuild on the hook path is what destabilizes sibling daemons). */
function spawnDaemonDetached(serverPath: string, root: string): number | undefined {
	const child = spawn(
		process.execPath,
		[
			// Same V8 heap regulator every spawn path applies (memory-ceiling.ts:
			// configuredHeapMb()) — a self-healed daemon must not come back
			// with the unbounded default and resume the no-GC balloon.
			`--max-old-space-size=${configuredHeapMb()}`,
			"--expose-gc",
			serverPath,
			"--cwd",
			root,
			"--protocol",
			"dual",
			"--session-id",
			"default",
		],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
	return child.pid;
}

/** Spawn the daemon detached, under an already-held startup lock. Split out of
 * {@link attemptDaemonSelfHeal} so its try/catch + dep-resolution branches
 * don't push the caller past the complexity ratchet. Never throws. */
function spawnGuardedDaemon(
	serverPath: string,
	root: string,
	deps: SelfHealDeps,
): SelfHealAttempt {
	try {
		const childPid = (deps.spawnDaemon ?? spawnDaemonDetached)(serverPath, root);
		if (childPid === undefined) {
			return { result: "skipped", disposition: "spawn-failed", launchAttempted: true };
		}
		if (!transferStartupLock(root, { childPid })) {
			// We lost or could not persist the single-flight lease. Do not leave an
			// uncoordinated child running beside whichever process now owns it.
			try {
				process.kill(childPid, "SIGTERM");
			} catch {
				/* intentional: the child may already have exited */
			}
			return { result: "skipped", disposition: "spawn-failed", launchAttempted: true };
		}
		return { result: "spawned", disposition: "launch-attempted", launchAttempted: true };
	} catch {
		return { result: "skipped", disposition: "spawn-failed", launchAttempted: true };
	}
}

/** Take the startup mutex, spawn, and count the attempt against the backoff
 * ladder. Only a spawn we actually performed counts — losing the mutex means
 * someone else is booting, which is not our attempt. */
interface SpawnUnderMutexArgs {
	serverPath: string;
	root: string;
	deps: SelfHealDeps;
	nowMs: number;
}

function spawnUnderMutexWithBackoff({
	serverPath,
	root,
	deps,
	nowMs,
}: SpawnUnderMutexArgs): SelfHealAttempt {
	const lock = acquireStartupLock(root);
	if (!lock.acquired) {
		return { result: "locked", disposition: "startup-lock-held", launchAttempted: false };
	}
	const result = spawnGuardedDaemon(serverPath, root, deps);
	if (result.result === "spawned") {
		recordSupervisorSpawn(root, nowMs, deps.dryRun === true ? { dryRun: true } : {});
	}
	return result;
}

/** Best-effort respawn of the daemon for `cwd`'s repo. The cross-process
 * startup lock and supervisor backoff make this safe for concurrent hooks. */
export function attemptDaemonSelfHealDetailed(
	cwd: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	deps: SelfHealDeps = {},
): SelfHealAttempt {
	if (env.INTERLINKED_NO_SELF_HEAL === "1") {
		return { result: "skipped", disposition: "self-heal-disabled", launchAttempted: false };
	}
	const root = findRepoRoot(cwd ?? process.cwd());
	if (!root) return { result: "skipped", disposition: "no-project", launchAttempted: false };
	if (readGuardDisable(join(root, ".interlinked"))) {
		return { result: "skipped", disposition: "guard-disabled", launchAttempted: false };
	}
	const serverPath = (deps.resolveServerPath ?? selfHealServerPath)();
	if (!serverPath) {
		return { result: "skipped", disposition: "server-artifact-missing", launchAttempted: false };
	}
	const now = (deps.now ?? Date.now)();
	if (!supervisorSpawnAllowed(root, now)) {
		return { result: "backoff", disposition: "retry-backoff", launchAttempted: false };
	}
	return spawnUnderMutexWithBackoff({ serverPath, root, deps, nowMs: now });
}

/** Back-compatible scalar result for existing callers. New user-facing code
 * should prefer {@link attemptDaemonSelfHealDetailed} so its message describes
 * what actually happened. */
export function attemptDaemonSelfHeal(
	cwd: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	deps: SelfHealDeps = {},
): SelfHealResult {
	return attemptDaemonSelfHealDetailed(cwd, env, deps).result;
}
