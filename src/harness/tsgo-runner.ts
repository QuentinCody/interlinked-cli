// ===========================================
// tsgo runner — warm `tsgo --watch` daemon + cold one-shot fallback
// ===========================================
// Target architecture: docs/design/free-cli-architecture.md §5 and
// docs/design/three-product-architecture.md — a persistent `tsgo --watch`
// child holds the project's type graph in memory so single-file checks drop
// toward ~5–50ms warm instead of ~200–800ms cold.
//
// ---------------------------------------------------------------------------
// STEP 1 findings — empirically observed `tsgo --watch` behavior
// (tsgo == @typescript/native-preview 7.0.0-dev; verified May 2026):
//
//  * `tsgo --watch --noEmit --pretty false` writes BOTH the first compile and
//    every subsequent recompile to STDOUT (stderr stays empty), plain text,
//    no ANSI. tsgo has NO LSP / server mode — `--watch` is the only warm path.
//  * Each compilation pass is bracketed by two marker lines:
//        build starting at <H:MM:SS AM/PM>
//        <zero or more diagnostic lines>
//        build finished in <N>s
//  * Diagnostic lines use Form 1: `file(line,col): error TSxxxx: message` —
//    exactly what `parseTsgoOutput` already parses. A clean pass is a
//    `build starting` line immediately followed by `build finished`.
//  * tsgo watches the filesystem itself: when a watched file's mtime changes,
//    it auto-starts a new full pass. The harness Edit/Write tool writes the
//    file to disk BEFORE checkFile() is ever called, so a recompile fires on
//    its own — the runner does not have to drive it.
//  * The compile itself is sub-millisecond once warm (`build finished in
//    0.000s`), BUT tsgo's change-detection has a fixed ~1s debounce before it
//    begins a pass. `--watchFile usefsevents` and `--watchInterval` do NOT
//    shrink that ~1s floor.
//
// Consequence for the drive model: "edit file then wait for tsgo to notice"
// would be ~1s — slower than the cold path. So checkFile() instead reads the
// LATEST COMPLETED PASS buffer the watch child already holds. By the time a
// checkFile() RPC arrives (the agent has done other work since the Edit), the
// ~1s-debounced recompile has normally already finished, so the read is
// ~1–5ms. The only slow case is racing tsgo's watcher immediately after an
// edit; that is covered by a bounded wait for the next `build finished` and,
// failing that, a cold one-shot fallback.
//
// Current consumption: `tsgo-runner.ts` is consumed ONLY by
// `daemon-dispatcher.ts` via the `tsgo.check_file` / `tsgo.simulate_edit`
// RPCs. The PostToolUse `typescript` quality check does NOT route through
// this module — it flows through `quality-checks.ts` →
// `check-engine/tool-runners/tsc.ts` (a separate `spawnSync` path). Routing
// the PostToolUse check through the warm runner would require editing
// `quality-checks.ts` / `check-engine/`, so it is left as a follow-up.
// ---------------------------------------------------------------------------
//
// The runner never throws and never hangs: every failure path (tsgo missing,
// child crash, spawn error, parse failure, warm-wait timeout) degrades to the
// cold one-shot or to an empty diagnostics list. The daemon must never crash
// because of tsgo.

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TsgoDiagnostic } from "./daemon-protocol.js";
import { applyLiteralReplacement } from "./overlay-content.js";
import {
	computeCacheKey,
	findTsconfigDir,
	isTsFile,
	locateTsgo,
	nowMs,
	readFileSyncSafe,
	runTsgoOneShot,
} from "./tsgo-diagnostics.js";

// Public re-export: `parseTsgoOutput` (and the helper cluster it lives among)
// moved to `tsgo-diagnostics.ts` in a behavior-preserving split. Consumers that
// import `parseTsgoOutput` from `tsgo-runner.js` keep working unchanged.
export { parseTsgoOutput } from "./tsgo-diagnostics.js";

// WatchProcess + its lifecycle state/constants moved to `tsgo-runner-watch.ts`
// in a behavior-preserving split (keeps this factory under the line cap). The
// sibling depends only on `tsgo-diagnostics.js`, so there is no import cycle.
import {
	DEFAULT_WATCH_IDLE_MS,
	WATCH_CRASHED,
	WATCH_IDLE_EVICTED,
	WATCH_RUNNING,
	WatchProcess,
	type WatchProcessState,
} from "./tsgo-runner-watch.js";

// Back-compat: `WatchProcessState` was exported from this module; keep that
// surface stable by re-exporting it from its new home.
export type { WatchProcessState };

/** Default per-call timeout for the cold one-shot `tsgo` invocation (ms). */
const DEFAULT_COLD_TIMEOUT_MS = 5000;
/** Default cap on (path, mtime, size)-keyed result-cache entries. */
const DEFAULT_MAX_CACHE_ENTRIES = 512;

interface TsgoRunnerOptions {
	/** Override the executable lookup. Defaults to the first tsgo binary on $PATH. */
	executable?: string;
	/** Extra args passed to every invocation. */
	extraArgs?: readonly string[];
	/** Per-call timeout. Defaults to DEFAULT_COLD_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Cap cache entries. Defaults to DEFAULT_MAX_CACHE_ENTRIES. */
	maxCacheEntries?: number;
	/**
	 * Idle window after which the warm `tsgo --watch` child is killed. The next
	 * TS check lazily respawns it. Default: 10 minutes (the daemon's own
	 * idle_shutdown_ms is 15 minutes — the watch child evicts sooner so a long
	 * non-TS stretch inside a live session reclaims the process).
	 */
	watchIdleMs?: number;
	/**
	 * Disable the warm `tsgo --watch` child entirely; every check uses the cold
	 * one-shot path. Used by tests that want to exercise the fallback.
	 */
	disableWatch?: boolean;
}

export interface TsgoRunner {
	available(): boolean;
	checkFile(
		path: string,
	): Promise<{ diagnostics: TsgoDiagnostic[]; cached: boolean; elapsed_ms: number }>;
	simulateEdit(
		path: string,
		oldString: string,
		newString: string,
	): Promise<{ new_diagnostics: TsgoDiagnostic[]; elapsed_ms: number }>;
	invalidate(path: string): void;
	/**
	 * `cache_size` / `available` are unchanged for back-compat. `watch_process`
	 * is an additive optional field reporting the warm child's lifecycle state.
	 */
	stats(): { cache_size: number; available: boolean; watch_process?: WatchProcessState };
	/**
	 * Release the warm `tsgo --watch` child (test/shutdown hook). Idempotent.
	 * The daemon never has to call this — the runner registers process-exit
	 * handlers that kill the child — but tests use it for determinism.
	 *
	 * Optional so existing `TsgoRunner` stubs (daemon-dispatcher / session-
	 * daemon / hook-entry tests) stay assignable without change — the real
	 * `createTsgoRunner()` always provides it.
	 */
	dispose?(): void;
}

interface CacheEntry {
	key: string;
	diagnostics: TsgoDiagnostic[];
}

interface WarmWatcherContext {
	watchEnabled: boolean;
	isAvailable: boolean;
	isDisposed(): boolean;
	executable: string | null;
	watchIdleMs: number;
	watchers: Map<string, WatchProcess>;
}

/** Obtain a usable watcher, awaiting complete teardown before a replacement. */
async function acquireWarmWatcher(
	path: string,
	ctx: WarmWatcherContext,
): Promise<WatchProcess | null> {
	if (!ctx.watchEnabled || !ctx.isAvailable || ctx.isDisposed() || ctx.executable === null) {
		return null;
	}
	const root = findTsconfigDir(path);
	if (root === null) return null;
	let watcher = ctx.watchers.get(root);
	if (watcher?.isUsable()) {
		watcher.touchIdle();
		return watcher;
	}
	// Idle eviction publishes its state immediately but deliberately retains
	// the per-project compiler lease until the old OS process group is fully
	// reaped. Await that acknowledgement before registering the replacement.
	if (watcher) await watcher.kill();
	watcher = new WatchProcess(ctx.executable, root, ctx.watchIdleMs);
	ctx.watchers.set(root, watcher);
	watcher.start();
	return watcher;
}

function summarizeWatchers(
	isAvailable: boolean,
	watchEnabled: boolean,
	watchers: ReadonlyMap<string, WatchProcess>,
): WatchProcessState {
	if (!isAvailable) return "unavailable";
	if (!watchEnabled) return "disabled";
	if (watchers.size === 0) return "not-started";
	let sawCrashed = false;
	let sawEvicted = false;
	for (const watcher of watchers.values()) {
		const state = watcher.state();
		if (state === WATCH_RUNNING) return WATCH_RUNNING;
		if (state === WATCH_CRASHED) sawCrashed = true;
		if (state === WATCH_IDLE_EVICTED) sawEvicted = true;
	}
	if (sawCrashed) return WATCH_CRASHED;
	if (sawEvicted) return WATCH_IDLE_EVICTED;
	return "not-started";
}

export function createTsgoRunner(opts: TsgoRunnerOptions = {}): TsgoRunner {
	const executable = opts.executable ?? locateTsgo();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_COLD_TIMEOUT_MS;
	const maxEntries = opts.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
	const extraArgs: readonly string[] = opts.extraArgs ?? ["--noEmit"];
	const watchIdleMs = opts.watchIdleMs ?? DEFAULT_WATCH_IDLE_MS;
	const watchEnabled = !opts.disableWatch;
	const cache = new Map<string, CacheEntry>();
	const isAvailable = executable !== null;

	// One warm `tsgo --watch` child per discovered project root. Lazy: nothing
	// is spawned at createTsgoRunner() time — a codebase with no TypeScript
	// never triggers a TS check, so it never pays any tsgo cost.
	const watchers = new Map<string, WatchProcess>();
	const lifecycle = { disposed: false };
	const watcherContext: WarmWatcherContext = {
		watchEnabled,
		isAvailable,
		isDisposed: () => lifecycle.disposed,
		executable,
		watchIdleMs,
		watchers,
	};

	function cachePut(path: string, entry: CacheEntry): void {
		if (cache.size >= maxEntries) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		// In-memory result cache; bounded by maxEntries with FIFO eviction
		// above, so no unbounded growth (this is not a Redis key).
		cache.set(path, entry);
	}

	async function check(path: string): Promise<{
		diagnostics: TsgoDiagnostic[];
		cached: boolean;
		elapsed_ms: number;
	}> {
		if (!isAvailable) return { diagnostics: [], cached: false, elapsed_ms: 0 };
		if (!existsSync(path)) return { diagnostics: [], cached: false, elapsed_ms: 0 };

		const key = computeCacheKey(path);
		const cached = cache.get(path) ?? null;
		if (cached && cached.key === key) {
			return { diagnostics: cached.diagnostics, cached: true, elapsed_ms: 0 };
		}

		const started = nowMs();
		// Warm path: read the watch child's latest completed pass. Falls back
		// to the cold one-shot when the warm child is unavailable / raced.
		const diagnostics = await checkViaWarmOrCold(path);
		const elapsed_ms = nowMs() - started;
		cachePut(path, { key, diagnostics });
		return { diagnostics, cached: false, elapsed_ms };
	}

	/** Warm-then-cold dispatch for a single file's diagnostics. */
	async function checkViaWarmOrCold(path: string): Promise<TsgoDiagnostic[]> {
		if (isTsFile(path)) {
			const watcher = await acquireWarmWatcher(path, watcherContext);
			if (watcher) {
				const warm = await watcher.diagnosticsForFile(path);
				if (warm !== null) return warm;
			}
		}
		// Cold fallback: warm child unavailable / not yet spawned / timed out.
		return runTsgoOneShot(executable as string, path, extraArgs, timeoutMs);
	}

	async function simulate(
		path: string,
		oldString: string,
		newString: string,
	): Promise<{ new_diagnostics: TsgoDiagnostic[]; elapsed_ms: number }> {
		if (!isAvailable || !existsSync(path)) return { new_diagnostics: [], elapsed_ms: 0 };

		const started = nowMs();
		const original = readFileSyncSafe(path);
		if (original === null) return { new_diagnostics: [], elapsed_ms: 0 };
		if (oldString && !original.includes(oldString)) {
			// Patch would fail anyway; no simulated diagnostics.
			return { new_diagnostics: [], elapsed_ms: nowMs() - started };
		}
		const patched = oldString
			? applyLiteralReplacement(original, oldString, newString, false)
			: original + newString;

		// simulate_edit type-checks a transient copy of the patched file. We do
		// NOT route this through the warm `tsgo --watch` child: the watch graph
		// only sees files on disk, and writing the patch into the live tree
		// would corrupt the agent's working copy. A one-shot on the temp file
		// is correct here. Pass the live project's root as the admission key so
		// runTsgoOneShot evicts its warm watcher before the temp-file child starts.

		const dir = mkdtempSync(join(tmpdir(), "interlinked-simedit-"));
		const suffix = path.match(/\.[A-Za-z0-9]+$/)?.[0] ?? ".ts";
		const tmpFile = join(dir, `sim${suffix}`);
		writeFileSync(tmpFile, patched);
		const diagnostics = await runTsgoOneShot(
			executable as string,
			tmpFile,
			extraArgs,
			timeoutMs,
			findTsconfigDir(path) ?? join(path, ".."),
		);
		const elapsed_ms = nowMs() - started;
		// We do not diff against baseline here because the baseline check is a
		// separate `tsgo.check_file` call; the callers in the daemon do the
		// diff to surface only the *new* diagnostics. This keeps the runner
		// responsibilities narrow.
		return { new_diagnostics: diagnostics, elapsed_ms };
	}

	function invalidate(path: string): void {
		cache.delete(path);
	}

	function stats(): {
		cache_size: number;
		available: boolean;
		watch_process?: WatchProcessState;
	} {
		return {
			cache_size: cache.size,
			available: isAvailable,
			watch_process: summarizeWatchers(isAvailable, watchEnabled, watchers),
		};
	}

	function dispose(): void {
		lifecycle.disposed = true;
		for (const w of watchers.values()) w.kill();
		watchers.clear();
		process.removeListener("exit", onExit);
		process.removeListener("SIGTERM", onExit);
		process.removeListener("SIGINT", onExit);
	}

	// Kill the warm child(ren) when the daemon process exits. This keeps the
	// runner self-managing — server.ts needs no shutdown wiring. `exit` covers
	// the graceful daemon shutdown path; the signal handlers cover SIGTERM /
	// SIGINT. Handlers are best-effort and never throw.
	const onExit = (): void => {
		try {
			for (const w of watchers.values()) w.kill();
		} catch (_err) {
			void 0; // intentional: best-effort cleanup must never throw at exit
		}
	};
	process.once("exit", onExit);
	process.once("SIGTERM", onExit);
	process.once("SIGINT", onExit);

	return {
		available: () => isAvailable,
		checkFile: check,
		simulateEdit: simulate,
		invalidate,
		stats,
		dispose,
	};
}
