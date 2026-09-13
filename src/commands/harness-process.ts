import { nonNull } from "../lib/non-null.js";
// ===========================================
// interlinked harness — process / orphan-daemon utilities
// ===========================================
// Pure process-management helpers split out of `harness.ts`: PID/socket path
// resolution, orphan-daemon reaping, ancestor-chain protection, daemon server
// path resolution, stale-dist rebuild, and liveness probing. The lifecycle
// command handlers (`harnessStartCommand` et al.) import from here; `harness.ts`
// re-exports the public surface so importers stay byte-for-byte identical.

import { execSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { distStaleness, type DistStaleness } from "../harness/build-staleness.js";
import { daemonPathsFor } from "../harness/session-paths.js";
import { getConfigDir } from "../lib/config.js";
import { c } from "../lib/formatter.js";
import {
	clearOrphanedPidFiles,
	collectReapCandidates,
	type OrphanCandidate,
	terminateCandidates,
} from "./harness-process-reap.js";

interface HarnessStatus {
	running: boolean;
	pid?: number;
}

export function getSocketPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), "harness.sock");
}

export function getFramedSocketPath(cwd: string, sessionId: string | undefined): string {
	return daemonPathsFor(cwd, sessionId || "default").socket;
}

export function getPidPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), "harness.pid");
}


/** Result returned by `reapOrphanHarnesses`. `candidates` is the full set the
 * sweep considered. `killed` is the subset whose authenticated process
 * identity was confirmed gone (including ESRCH/PID replacement); empty when
 * `dryRun: true`. */
export interface ReapResult {
	candidates: OrphanCandidate[];
	killed: number[];
	dryRun: boolean;
}

export interface ReapOptions {
	/** When true, do NOT issue `process.kill`; just return candidates. Default
	 *  for the `reap` CLI surface so users see the impact before opting in. */
	dryRun?: boolean;
	/** When true, also consider the active pid-file daemon. The invoking
	 * process and its ancestor chain remain protected; explicit restart uses
	 * `stopAllDaemons` when it intentionally needs to replace an ancestor. */
	killAll?: boolean;
	/** PIDs this sweep must never signal, whatever `ps` says — in practice the
	 *  daemons that ANSWERED a socket probe (see
	 *  `harness-daemon-control.ts::collectServingDaemonPids`). A reaper that
	 *  kills a working daemon opens the guard gap that makes the next caller
	 *  start another one; that loop is the 2026-08-15 restart storm. Honored
	 *  even under `killAll`, which is a "clean up the mess" verb, not a stop
	 *  verb — `stopAllDaemons` is the way to stop a live daemon. */
	protectPids?: Set<number>;
}

/**
 * SIGTERM any orphan interlinked harness daemons before we start a fresh one.
 *
 * Orphans accumulate when a previous session ended without a clean shutdown
 * (Ctrl-C on the parent shell, OS reboot, daemon crash leaving the pid file
 * stale). On one developer machine we observed 28 daemons accumulated across
 * 4 days of sessions, ~1.8 GB stale RSS. Without this sweep, every
 * `interlinked harness start` adds another long-lived process to the pile.
 *
 * Selection criteria: the process command line must structurally name a
 * supported Node/Bun Interlinked daemon entry and this exact cwd. We then
 * authenticate runtime, argv and process start identity again immediately
 * before each signal. We exclude:
 *   1. The CLI process running this code (`process.pid`).
 *   2. The current shell / Claude Code ancestor chain (would terminate the
 *      session that just typed `interlinked harness start`).
 *   3. Any PID matching the active `.interlinked/harness.pid` for THIS cwd
 *      (already shutdown by `isHarnessRunning` above, but defensive).
 *
 * `opts.dryRun` returns the candidate list without signalling. `opts.killAll`
 * disables only the active-pid protection; it never makes the reaper a broad
 * `pkill`, and socket-verified serving daemons remain protected.
 *
 * Best-effort: if `ps` fails, return an empty result — callers fall through.
 */
export function reapOrphanHarnesses(cwd: string, opts: ReapOptions = {}): ReapResult {
	const dryRun = opts.dryRun === true;
	const killAll = opts.killAll === true;
	const empty: ReapResult = { candidates: [], killed: [], dryRun };
	let ps: string;
	try {
		const raw = execSync("ps -ax -o pid=,ppid=,command= 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
		});
		if (typeof raw !== "string") return empty;
		ps = raw;
	} catch (e) {
		void e;
		return empty;
	}
	const ancestorPids = collectAncestorPids();
	const activePid = readActiveHarnessPid(cwd);
	const protect = opts.protectPids ?? new Set<number>();
	const candidates = collectReapCandidates(ps, cwd, ancestorPids, activePid, killAll).filter(
		(c) => !protect.has(c.pid),
	);
	if (dryRun) {
		return { candidates, killed: [], dryRun: true };
	}
	const killed = terminateCandidates(candidates, cwd);
	// After everything dies, sweep the stale pid/sock files so the next
	// `startSessionDaemon` doesn't see an "existing PID" left behind by a
	// daemon that crashed without reaching its own removePidFile() call.
	if (killed.length > 0) {
		clearOrphanedPidFiles(cwd, killed);
		process.stderr.write(
			`[interlinked] Reaped ${killed.length} orphan harness daemon${killed.length === 1 ? "" : "s"}: ${killed.join(", ")}\n`,
		);
	}
	return { candidates, killed, dryRun: false };
}


/**
 * Walk up the parent chain so we never SIGTERM a daemon that's actually our
 * own ancestor (the shell or Claude Code that invoked this CLI). Mirrors the
 * `getProtectedPids` logic in `harness/pre-checks.ts`.
 *
 * Public API: exported so the new operational commands (`harness reap`,
 * `harness clean`, future `doctor` enhancements) and downstream tests can
 * reproduce the same ancestor-protection set without duplicating the walk.
 */
export function collectAncestorPids(): Set<number> {
	const pids = new Set<number>([process.pid]);
	if (process.ppid) pids.add(process.ppid);
	try {
		const psOut = execSync("ps -o pid=,ppid= -ax 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
		});
		const childToParent = new Map<number, number>();
		for (const line of psOut.split("\n")) {
			const m = line.trim().match(/^(\d+)\s+(\d+)$/);
			if (m) childToParent.set(Number.parseInt(nonNull(m[1]), 10), Number.parseInt(nonNull(m[2]), 10));
		}
		let current = process.ppid;
		for (let i = 0; i < 10 && current > 1; i++) {
			pids.add(current);
			const parent = childToParent.get(current);
			if (!parent || parent <= 1) break;
			current = parent;
		}
	} catch (e) {
		void e;
	}
	return pids;
}

/**
 * Read the active daemon PID from `.interlinked/harness.pid`. Returns null
 * when the file is missing or contains a non-numeric value.
 *
 * Public API: exported so operational commands (`harness reap`, `harness
 * clean`) can identify the active daemon without coupling to `isHarnessRunning`,
 * which has additional liveness side effects (it auto-cleans stale pid files).
 */
export function readActiveHarnessPid(cwd: string): number | null {
	try {
		const pidPath = getPidPath(cwd);
		if (!existsSync(pidPath)) return null;
		const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
		return Number.isNaN(pid) ? null : pid;
	} catch (e) {
		void e;
		return null;
	}
}

function getDaemonLogPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), "logs", "daemon.log");
}

export interface DaemonStderrLog {
	fd: number;
	path: string;
	startOffset: number;
}

export function openDaemonStderrLog(cwd: string): DaemonStderrLog | null {
	const path = getDaemonLogPath(cwd);
	try {
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const startOffset = existsSync(path) ? statSync(path).size : 0;
		const fd = openSync(path, "a");
		return { fd, path, startOffset };
	} catch (_) {
		return null;
	}
}

export function closeDaemonStderrLog(log: DaemonStderrLog | null): void {
	if (!log) return;
	try {
		closeSync(log.fd);
	} catch (_) {
		/* intentional: child inherited its own stderr fd; parent close is best-effort */
	}
}

export function readDaemonStderrLog(log: DaemonStderrLog | null): string {
	if (!log) return "";
	try {
		return readFileSync(log.path).subarray(log.startOffset).toString("utf-8");
	} catch (_) {
		return "";
	}
}

interface DistFreshnessOptions {
	/** Suppress progress output when the caller owes stdout a single JSON value. */
	quiet?: boolean;
	/** Test seams for the filesystem/build boundaries; production uses the real implementations. */
	resolveServerPath?: () => string;
	readStaleness?: (repoRoot: string) => DistStaleness | null;
	runBuild?: (repoRoot: string) => void;
}

function runRepositoryBuild(repoRoot: string): void {
	execSync("npm run build", {
		cwd: repoRoot,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 120_000,
	});
}

function sourceCheckoutRootForServerPath(serverPath: string): string | null {
	const harnessDir = dirname(serverPath);
	const buildOrSourceDir = dirname(harnessDir);
	const artifact = basename(serverPath);
	const container = basename(harnessDir);
	const generation = basename(buildOrSourceDir);
	const recognizedRuntime = artifact === "server.js" && container === "harness" && generation === "dist";
	const recognizedSource = artifact === "server.ts" && container === "harness" && generation === "src";
	return recognizedRuntime || recognizedSource ? dirname(buildOrSourceDir) : null;
}

/**
 * Rebuild a source checkout when ANY product source is newer than dist.
 *
 * The shared recursive staleness detector deliberately ignores tests and
 * generated/vendor trees, but sees edits to existing nested files whose
 * parent-directory mtime does not change. Installed packages normally have no
 * src/ tree, so their staleness result is null and this remains a no-op.
 * A detected stale build is different: rebuild failure (or a build that leaves
 * dist stale) throws so callers never launch known-old enforcement code.
 */
export function ensureDistFresh(options: DistFreshnessOptions = {}): void {
	const resolveServerPath = options.resolveServerPath ?? getHarnessServerPath;
	const readStaleness = options.readStaleness ?? distStaleness;
	const runBuild = options.runBuild ?? runRepositoryBuild;
	const distServer = resolveServerPath();
	if (!distServer || !existsSync(distServer)) return;

	// Only infer a checkout from the two source/runtime layouts we own. A
	// managed `.interlinked/harness-server` is a standalone artifact; walking
	// three parents from it could accidentally inspect and build an unrelated
	// ancestor checkout.
	const repoRoot = sourceCheckoutRootForServerPath(distServer);
	if (repoRoot === null) return;
	const before = readStaleness(repoRoot);
	if (!before?.stale) return;

	if (!options.quiet) console.log(c.yellow("Source newer than dist — rebuilding..."));
	try {
		runBuild(repoRoot);
	} catch (err) {
		const detail = err instanceof Error && err.message ? `: ${err.message}` : "";
		throw new Error(`Build failed; refusing to start the harness with stale code${detail}`);
	}

	const after = readStaleness(repoRoot);
	if (after === null) {
		throw new Error("Build completed but dist freshness could not be verified; refusing to start the harness");
	}
	if (after.stale) {
		throw new Error("Build completed but dist is still stale; refusing to start the harness");
	}
	if (!options.quiet) console.log(c.green("Rebuilt dist/"));
}

export function getHarnessServerPath(): string {
	// Resolve harness server path — prefer pre-compiled JS for fast startup.
	// Supported Node >=22 file modules expose dirname in both source and ESM builds.
	const dir = import.meta.dirname;
	const candidates = [
		// 1. Pre-compiled JS — same dist/ directory as this file (tsup co-entry)
		join(dir, "harness", "server.js"),
		// 2. Pre-compiled JS — one level up (when this file is in dist/commands/)
		join(dir, "..", "harness", "server.js"),
		// 3. tsx-from-src: src/commands/harness.ts running under tsx —
		//    walk to project root and down into dist/.
		join(dir, "..", "..", "dist", "harness", "server.js"),
		// 4. Flat-layout source checkout (no `cli/` prefix).
		join(process.cwd(), "dist", "harness", "server.js"),
		// 5. Pre-compiled JS in node_modules
		join(process.cwd(), "node_modules", "interlinked-cli", "dist", "harness", "server.js"),
		// 6. Monorepo source checkout with `cli/` prefix.
		join(process.cwd(), "cli", "dist", "harness", "server.js"),
		// 7. Pre-compiled binary
		join(process.cwd(), ".interlinked", "harness-server"),
		// 8. Source TypeScript fallbacks (slower — Node can't run .ts directly)
		join(dir, "..", "harness", "server.ts"),
		join(dir, "..", "src", "harness", "server.ts"),
		join(process.cwd(), "cli", "src", "harness", "server.ts"),
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return ""; // Empty string — caller checks and shows error
}

export function isHarnessRunning(cwd?: string): HarnessStatus {
	const pidPath = getPidPath(cwd);
	if (!existsSync(pidPath)) return { running: false };

	try {
		const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
		if (Number.isNaN(pid)) return { running: false };

		// Check if process is alive
		process.kill(pid, 0); // Signal 0 = just check existence
		return { running: true, pid };
	} catch (_) {
		// Process not running — clean up stale PID file
		try {
			unlinkSync(pidPath);
		} catch (_unlinkErr) {
			/* intentional: best-effort PID file cleanup, ignore unlink errors */
		}
		return { running: false };
	}
}

export type { OrphanCandidate } from "./harness-process-reap.js";
export type { HarnessStatus };
