// interlinked-tdd: exempt
// ===========================================
// interlinked harness — restart socket/pid cleanup (extracted from harness-lifecycle-helpers.ts)
// ===========================================
//
// Leaf helpers for stopping a harness before a restart and sweeping stale
// socket/pid files left by a previous crash. Moved verbatim to keep the
// parent file under the per-file line cap; behavior is byte-identical.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
	type ProcessIdentityReader,
	readHarnessProcessIdentity,
} from "../harness/daemon-process-identity.js";
import { classifyDaemonSocket } from "../harness/session-paths.js";
import type { HarnessSocketState } from "../harness/socket-readiness.js";
import { c } from "../lib/formatter.js";
import { type getOutputMode, outputError } from "../lib/output.js";
import {
	type DaemonControlDeps,
	reapOrphanHarnessesVerified,
	stopAllDaemons,
} from "./harness-daemon-control.js";
import { getPidPath, getSocketPath, isHarnessRunning } from "./harness-process.js";

/**
 * Stop a running harness for a restart: SIGTERM, wait, then escalate to SIGKILL
 * if it ignores the term. Owns its own stderr nudges (normal mode only) and the
 * survived-SIGKILL fatal error. Returns the prior pid (for the JSON payload) and
 * whether the daemon survived SIGKILL — when `survived` is true the caller must
 * abort the restart.
 *
 * Behavior-identical to the inline block it replaces: the `Sending termination
 * signals` rule blocks an agent from running `kill -9` itself, so owning the
 * escalation here is what makes `harness restart` actually restart.
 */
export async function stopRunningHarnessForRestart(
	cwd: string,
	mode: ReturnType<typeof getOutputMode>,
): Promise<{ oldPid: number | undefined; survived: boolean }> {
	// Finding #22 (2026-08-16): the old single-pid path here read only the RAW
	// pid file, so a framed daemon (harness-default.pid) survived the "stop"
	// holding its socket, and the fresh start exited anti-stomp — a restart
	// that un-restarts. `stopAllDaemons` is the stop verb's own path: it
	// enumerates raw + framed/session pid files AND orphans, protects this
	// process's ancestors, and owns the TERM→wait→KILL escalation.
	const status = isHarnessRunning(cwd);
	const priorPid = status.running ? status.pid : undefined;
	// spareAncestralDaemons:false — an automatic handover spawns THIS restart
	// from the daemon it must replace, so that daemon is our ancestor; sparing
	// it turned every automatic handover into a silent "already running" no-op
	// (review 2026-08-29, live-reproduced). Targets are verified daemons only.
	const { stopped, survived } = await stopAllDaemons(cwd, { spareAncestralDaemons: false });
	if (stopped.length === 0 && survived.length === 0) {
		return { oldPid: undefined, survived: false };
	}
	const oldPid = priorPid ?? stopped[0];
	if (survived.length > 0) {
		outputError(
			mode,
			`PID(s) ${survived.join(", ")} survived SIGKILL — possibly kernel-protected. Investigate manually.`,
		);
		return { oldPid, survived: true };
	}
	if (mode === "normal") {
		process.stderr.write(c.dim(`Stopped harness (was PID ${stopped.join(", ")})\n`));
	}
	return { oldPid, survived: false };
}

/**
 * Resilience pass before respawn: sweep orphan daemons and remove stale socket /
 * pid files left by a previous crash. Without this a stale pid+sock pair can make
 * the new daemon double-bind on the socket or confuse `isHarnessRunning` callers.
 * Run on the happy path too — a fresh restart should never inherit dirt.
 *
 * LIVENESS-VERIFIED (2026-08-16). This was one of the last two reapers that
 * still picked victims straight out of `ps`, so a healthy daemon this repo's
 * pid file did not name was SIGTERM'd by every restart — exactly the kill that
 * opens the guard gap the 2026-08-15 storm fed on. It now goes through
 * `reapOrphanHarnessesVerified`, which probes each candidate's socket first and
 * protects whatever answers. Async for that probe; callers must await.
 */
type RestartSocketState = HarnessSocketState | "probe_failed";

interface RestartCleanupDeps extends DaemonControlDeps {
	classifySocket?: (socketPath: string) => Promise<HarnessSocketState>;
	fileExists?: (path: string) => boolean;
	readText?: (path: string) => string;
	unlinkFile?: (path: string) => void;
	runningStatus?: (cwd: string) => ReturnType<typeof isHarnessRunning>;
	identify?: ProcessIdentityReader;
}

async function confirmedRestartSocketState(
	socketPath: string,
	classify: (socketPath: string) => Promise<HarnessSocketState>,
): Promise<RestartSocketState> {
	try {
		const first = await classify(socketPath);
		if (first !== "absent") return first;
		return classify(socketPath);
	} catch {
		return "probe_failed";
	}
}

async function removeConfirmedStaleSocket(
	socketPath: string,
	deps: RestartCleanupDeps,
): Promise<RestartSocketState> {
	const fileExists = deps.fileExists ?? existsSync;
	if (!fileExists(socketPath)) return "absent";
	const state = await confirmedRestartSocketState(
		socketPath,
		deps.classifySocket ?? classifyDaemonSocket,
	);
	if (state !== "absent" || !fileExists(socketPath)) return state;
	try {
		(deps.unlinkFile ?? unlinkSync)(socketPath);
	} catch {
		/* intentional: best-effort cleanup after two absent classifications */
	}
	return state;
}

function readTextOrNull(path: string, readText: (path: string) => string): string | null {
	try {
		return readText(path);
	} catch {
		return null;
	}
}

function runningPidNeedsMetadata(
	cwd: string,
	socketState: RestartSocketState,
	deps: RestartCleanupDeps,
): boolean {
	const status = (deps.runningStatus ?? isHarnessRunning)(cwd);
	if (!status.running) return false;
	if (socketState !== "absent" || status.pid === undefined) return true;
	return (deps.identify ?? readHarnessProcessIdentity)(cwd, status.pid) !== null;
}

function removeConfirmedStalePid(
	cwd: string,
	pidPath: string,
	socketState: RestartSocketState,
	deps: RestartCleanupDeps,
): void {
	const fileExists = deps.fileExists ?? existsSync;
	if (!fileExists(pidPath) || runningPidNeedsMetadata(cwd, socketState, deps)) return;
	const readText = deps.readText ?? ((path: string) => readFileSync(path, "utf8"));
	const snapshot = readTextOrNull(pidPath, readText);
	if (snapshot === null || readTextOrNull(pidPath, readText) !== snapshot) return;
	try {
		(deps.unlinkFile ?? unlinkSync)(pidPath);
	} catch {
		/* intentional: best-effort cleanup of unchanged stale metadata */
	}
}

export async function cleanStaleRestartFiles(
	cwd: string,
	deps: RestartCleanupDeps = {},
): Promise<void> {
	await reapOrphanHarnessesVerified(cwd, {}, deps);
	const socketPath = getSocketPath(cwd);
	const socketState = await removeConfirmedStaleSocket(socketPath, deps);
	const stalePidPath = getPidPath(cwd);
	removeConfirmedStalePid(cwd, stalePidPath, socketState, deps);
}
