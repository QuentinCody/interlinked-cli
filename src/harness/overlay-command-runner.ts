import { hasErrorCode } from "./check-engine/tool-errors.js";
// ===========================================
// Overlay command runner — generic argv over a proposed-edit overlay
// ===========================================
// The P4 spike seam (docs/design/overlay-exec-runtime-oracles.md §2): run an
// arbitrary bounded command against a shadow tree, returning raw
// {exitCode, stdout, stderr, timedOut}. This is the generic layer the
// coverage/mutation runners specialize — coverage-runner.ts parses the result
// as coverage, mutation/cloud-runner.ts ships it to a Sandbox. A runtime
// oracle (leak probe, flake rerun, sanitizer smoke) needs neither of those
// contracts, only "run this argv against the proposed bytes, within budget".
//
// CRITICAL: this does NOT build its own overlay. `createCoverageOverlay`
// cpSync-mirrors the whole tree (~hundreds of ms + disk); a second overlay
// doubles that and the 24GB-leak exposure that made sweepStaleOverlays
// necessary. Jobs compose inside ONE overlay lifetime — the caller owns the
// overlay and passes its root here. See §2 "the mistake not to make".
//
// (Bin-resolution + bounded-spawn logic is duplicated from coverage-runner.ts
// rather than shared: that file sits at the 500-line cap, so extracting a
// shared module is deferred — noted in the design doc §2 "two small blockers".)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** Grace before SIGKILL when a timed-out child ignores SIGTERM. */
const KILL_GRACE_MS = 5_000;
/** Poll interval while a signalled process group is being reaped. */
const GROUP_REAP_POLL_MS = 20;
/** Signals that would end this process with the detached child's group still running. */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];


interface OverlaySpawnOutcome {
	stdout: string;
	stderr: string;
	/** Exit code; null on signal-kill / timeout / launch failure. */
	status: number | null;
	/** Launch/timeout error (ENOENT, ETIMEDOUT, …); resolves, never rejects. */
	error?: Error;
}

/** Injectable spawn (async, never rejects) so tests never run a real process. */
export type OverlaySpawnFn = (
	command: string,
	args: string[],
	options: { cwd: string; timeout: number; env?: Record<string, string> },
) => Promise<OverlaySpawnOutcome>;

/** Structured result of one overlay command run. */
interface OverlayCommandRunResult {
	/** Process exit code; null when signal-killed, timed out, or never launched. */
	exitCode: number | null;
	stdout: string;
	stderr: string;
	/** True iff the command was killed for exceeding its budget. */
	timedOut: boolean;
	/** Wall-clock duration of the spawn, ms. */
	durationMs: number;
	/** Human-readable reason when the command could not run (ENOENT, empty argv). */
	error?: string;
}

/**
 * Resolve a bare bin (e.g. `vitest`) to the overlay's local `node_modules/.bin`
 * — it is not on PATH, and the overlay symlinks node_modules so it resolves
 * there. Bins that are absolute, slash-bearing, or absent from `.bin` (e.g.
 * `node`, `pytest`, `cargo`) pass through to PATH unchanged.
 */
export function resolveOverlayBin(overlayRoot: string, rawBin: string): string {
	if (rawBin.includes("/")) return rawBin;
	const local = `${overlayRoot}/node_modules/.bin/${rawBin}`;
	return existsSync(local) ? local : rawBin;
}

/** The child leads its own process group on POSIX (kill-proof review round 4, M6), so a timeout can stop every
 *  descendant: vitest's forks worker outlived `child.kill()` on the wrapper and kept running test code — writing
 *  into os.tmpdir() and the shared node_modules — after the proof had returned. Windows has no process groups. */
const OWN_PROCESS_GROUP = process.platform !== "win32";

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms).unref());

/** Signal the whole group (`-pid`), falling back to the direct child when the group is gone or unsupported. */
function signalGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	try {
		if (OWN_PROCESS_GROUP && child.pid !== undefined) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			/* already reaped */
		}
	}
}

/** True while any member of the group exists (EPERM: exists, not inspectable). */
function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** SIGTERM the group, SIGKILL whatever survives the grace, and return only once no member is left. */
async function terminateGroup(child: ReturnType<typeof spawn>): Promise<void> {
	signalGroup(child, "SIGTERM");
	const pid = child.pid;
	if (!OWN_PROCESS_GROUP || pid === undefined) {
		await sleep(KILL_GRACE_MS);
		signalGroup(child, "SIGKILL");
		return;
	}
	const grace = Date.now() + KILL_GRACE_MS;
	while (groupAlive(pid) && Date.now() < grace) await sleep(GROUP_REAP_POLL_MS);
	while (groupAlive(pid)) {
		signalGroup(child, "SIGKILL");
		await sleep(GROUP_REAP_POLL_MS);
	}
}

/**
 * While a detached child runs, this process ending must not leave the group behind: `exit` (process.exit, a
 * finished event loop) and the terminating signals SIGKILL the group first. A forwarded signal is re-raised when
 * no other listener owns it, so the default termination still happens. Returns the teardown.
 */
function guardParentExit(child: ReturnType<typeof spawn>): () => void {
	const onExit = (): void => signalGroup(child, "SIGKILL");
	const onSignal = (signal: NodeJS.Signals): void => {
		signalGroup(child, "SIGKILL");
		process.removeListener(signal, onSignal);
		if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
	};
	process.once("exit", onExit);
	for (const signal of FORWARDED_SIGNALS) process.on(signal, onSignal);
	return () => {
		process.removeListener("exit", onExit);
		for (const signal of FORWARDED_SIGNALS) process.removeListener(signal, onSignal);
	};
}

const defaultSpawn: OverlaySpawnFn = (command, args, options) =>
	new Promise((resolveOutcome) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				cwd: options.cwd,
				detached: OWN_PROCESS_GROUP,
				...(options.env ? { env: { ...process.env, ...options.env } } : {}),
			});
		} catch (err) {
			resolveOutcome({
				stdout: "",
				stderr: "",
				status: null,
				error: err instanceof Error ? err : new Error(String(err)),
			});
			return;
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let groupGone: Promise<void> = Promise.resolve();
		const unguard = guardParentExit(child);
		child.stdout?.setEncoding("utf-8");
		child.stderr?.setEncoding("utf-8");
		child.stdout?.on("data", (c: string) => {
			stdout += c;
		});
		child.stderr?.on("data", (c: string) => {
			stderr += c;
		});
		const killTimer = setTimeout(() => {
			timedOut = true;
			groupGone = terminateGroup(child);
		}, options.timeout);
		killTimer.unref();
		const settle = (o: OverlaySpawnOutcome): void => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			unguard();
			resolveOutcome(o);
		};
		child.on("error", (err) => settle({ stdout, stderr, status: null, error: err }));
		child.on("close", (code) => {
			if (!timedOut) {
				settle({ stdout, stderr, status: code });
				return;
			}
			// Wait for the whole group: a worker that outlives the wrapper must be gone before the caller continues.
			void groupGone.then(() =>
				settle({
					stdout,
					stderr,
					status: null,
					error: Object.assign(new Error(`timed out after ${options.timeout} ms`), { code: "ETIMEDOUT" }),
				}),
			);
		});
	});


/**
 * Run `argv` against an ALREADY-BUILT overlay root, bounded at `budgetMs`.
 * Never throws — a launch failure or timeout resolves with `exitCode: null`
 * and a populated `error`/`timedOut`. The caller owns the overlay lifetime
 * (build once, run N jobs, clean up once).
 */
export async function runArgvInOverlay(
	argv: string[],
	overlayRoot: string,
	budgetMs: number,
	spawnFn: OverlaySpawnFn = defaultSpawn,
	env?: Record<string, string>,
): Promise<OverlayCommandRunResult> {
	const [rawBin, ...args] = argv;
	if (!rawBin) {
		return { exitCode: null, stdout: "", stderr: "", timedOut: false, durationMs: 0, error: "empty argv" };
	}
	const bin = resolveOverlayBin(overlayRoot, rawBin);
	const start = Date.now();
	const outcome = await spawnFn(bin, args, {
		cwd: overlayRoot,
		timeout: budgetMs,
		...(env ? { env } : {}),
	});
	const durationMs = Date.now() - start;
	if (outcome.error) {
		const timedOut = hasErrorCode(outcome.error, "ETIMEDOUT");
		const reason = timedOut ? outcome.error.message : `'${bin}' failed to launch: ${outcome.error.message}`;
		return { exitCode: null, stdout: outcome.stdout, stderr: outcome.stderr, timedOut, durationMs, error: reason };
	}
	return {
		exitCode: outcome.status,
		stdout: outcome.stdout,
		stderr: outcome.stderr,
		timedOut: false,
		durationMs,
	};
}
