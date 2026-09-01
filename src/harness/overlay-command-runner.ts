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

const defaultSpawn: OverlaySpawnFn = (command, args, options) =>
	new Promise((resolveOutcome) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				cwd: options.cwd,
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
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
		}, options.timeout);
		killTimer.unref();
		const settle = (o: OverlaySpawnOutcome): void => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			resolveOutcome(o);
		};
		child.on("error", (err) => settle({ stdout, stderr, status: null, error: err }));
		child.on("close", (code) =>
			settle(
				timedOut
					? {
							stdout,
							stderr,
							status: null,
							error: Object.assign(new Error(`timed out after ${options.timeout} ms`), {
								code: "ETIMEDOUT",
							}),
						}
					: { stdout, stderr, status: code },
			),
		);
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
		const code = (outcome.error as NodeJS.ErrnoException).code;
		const timedOut = code === "ETIMEDOUT";
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
