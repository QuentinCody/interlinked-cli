#!/usr/bin/env node
// ===========================================
// Interlinked Harness Server
// ===========================================
// Local Unix socket server for agent guard evaluation, lifecycle management,
// and auto file reservation. Runs as a background process per developer.
//
// Usage:
//   node cli/dist/harness/server.js [--socket <path>] [--idle-timeout <ms>]
//
// Idle timeout disabled by default (event-driven, no CPU cost when idle). Configurable via --idle-timeout.
//
// The event-processing pipeline (lifecycle / PreToolUse / PostToolUse) lives
// in `server/`; this file owns CLI parsing, daemon-scoped state, the socket
// servers, and process lifecycle. `processEvent` builds a `ServerRuntime`
// context once and delegates each event branch to the extracted pipelines.

import { registerAllBuiltinVerifyPasses } from "./check-pipeline/builtin-verify-passes.js";
import { astComplexityAvailable } from "./checks/cyclomatic-ast.js";
import { recordDaemonEvent, recordDaemonExit } from "./daemon-ledger.js";
import { type FilePriority } from "./file-priority.js";
import { FileContentCache } from "./grep-accelerator.js";
import { ProjectGraph } from "./project-graph.js";
import { loadRules } from "./rules-loader.js";
import {
	writeActivityRecord,
	writeGuardDecisionRecord,
	writeLifecycleActivityRecord,
} from "./server/activity-writer.js";
import { writeCollectionRecord as appendCollectionRecord } from "./server/collection-writer.js";
import {
	getGraphForFile as resolveGraphForFile,
	type ServerRuntime,
} from "./server/runtime-context.js";
import { installEarlyShutdown, readServerCliConfig } from "./server/server-cli-bootstrap.js";
import { createDaemonState } from "./server/server-daemon-state.js";
import { activateDaemon } from "./server/server-daemon-activation.js";
import { createEventLoop } from "./server-event-loop.js";
import { createSocketLifecycle } from "./server-socket-lifecycle.js";
import { createStartupGuard } from "./server/startup-guard.js";
import { guardTallySnapshot } from "./guard-tally.js";
import { writeStatuslineArtifacts } from "./statusline-snapshot.js";
import { TrigramIndex } from "./trigram-index.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "./types.js";

// ===========================================
// CLI Arguments
// ===========================================

const cliConfig = readServerCliConfig();
const {
	cwd: CWD,
	interlinkedDir: INTERLINKED_DIR,
	socketPath: SOCKET_PATH,
	pidPath: PID_PATH,
	runRawSocket: RUN_RAW_SOCKET,
	runFramedSocket: RUN_FRAMED_SOCKET,
	idleTimeoutMs: IDLE_TIMEOUT_MS,
	verbose: VERBOSE,
} = cliConfig;

// Register the bundled verify-pass filters (Mythos Phase 3). Module-load
// side effect: every PostToolUse detector now runs through the second-
// pass FP filter chain. Adding new built-ins is a one-line append in
// `check-pipeline/builtin-verify-passes.ts`; nothing else needs to change.
registerAllBuiltinVerifyPasses();

// Recency-weighted check-depth state (Mythos Phase 4). Populated lazily
// on first SessionStart (or first PostToolUse use, whichever fires) so
// the cold-start cost is paid once per daemon. Per-file priorities map
// is consulted by `shouldRunAdvisoryChecks(filePath, filePriorityMap)`
// before each advisory inline detector pass; cold files (>180 days
// unchanged) skip the heavier checks entirely.
let filePriorityMap = new Map<string, FilePriority>();
const earlyShutdown = installEarlyShutdown(PID_PATH);
// Arms the process-level survival handlers (crash-loop fix) with a STARTUP
// exception: an uncaught error before every socket is bound is fatal, not
// survivable — surviving it is how a deaf daemon is born (F1, 2026-08-14).
const startupGuard = createStartupGuard({ cwd: CWD, runRaw: RUN_RAW_SOCKET, runFramed: RUN_FRAMED_SOCKET, logAlways });
// Always-on by default. Per-session Maps (classifierSessions, autoCoordStates,
// preEditBaselines) drop on SessionEnd, so resident memory stabilizes around
// ~30 MB per daemon — it doesn't grow with uptime. The original orphan-
// accumulation concern (many daemons × many CWDs) is handled by the explicit
// `interlinked harness clean` command, not by an idle timer.
// Set `--idle-timeout <ms>` to opt back into auto-shutdown if you want it.
/** Milliseconds in one minute — for converting IDLE_TIMEOUT_MS into a human-readable log line. */
const MS_PER_MINUTE = 60_000;

// ===========================================
// State
// ===========================================

let rules: GuardRulesConfig = loadRules(CWD);
const daemonState = createDaemonState({ cli: cliConfig, rules, log, logAlways });
const {
	cohort,
	sessions,
	writeClassifierStatus,
	writeReviewPendingMarker,
	asyncFindings,
	learnedRules,
	asyncAnalysis,
	classifierSessions,
	contentScanner,
	compiledAllowlist: initialCompiledAllowlist,
	autoCoordStates,
	indexWarningSent,
	autoCoordConfig,
	preEditBaselines,
	routeMap,
	errorHistory,
	projectWideSweepState,
	serverBridge,
	reservations,
	protocolStatusPath: PROTOCOL_STATUS_PATH,
	protocolStatus,
} = daemonState;
let compiledAllowlist = initialCompiledAllowlist;

// --- Multi-project graph cache ---
// Lazily creates a ProjectGraph per project root so structural checks work
// for files in any repo, not just the harness's CWD.
const _graphCache = new Map<string, ProjectGraph>();

/** Resolve (and lazily build + cache) the project graph for a file. Thin
 *  wrapper over `server/runtime-context.getGraphForFile` so the local
 *  call sites (background init, framed-daemon context) stay terse. */
function getGraphForFile(filePath: string): ProjectGraph {
	return resolveGraphForFile(serverRuntime, filePath);
}

// Defer CWD graph initialization — socket starts accepting connections immediately.
// First request that needs the graph triggers lazy init via getGraphForFile().
setTimeout(() => {
	try {
		const g = getGraphForFile(CWD);
		routeMap.initialize(g.allFiles());
		log("Route map initialized");
	} catch (err) {
		log(`Background init failed (non-fatal): ${err}`);
	}
	log(`Error history loaded: ${errorHistory.size} records`);
}, 0);

// --- Trigram search index (grep acceleration) ---
// Load existing index if available; build is done via CLI command.
// Content cache avoids redundant disk reads for files the agent just edited.
const fileContentCache = new FileContentCache();
let trigramIndex: TrigramIndex | null = null;
setTimeout(() => {
	try {
		trigramIndex = TrigramIndex.load(CWD);
		if (trigramIndex) {
			serverRuntime.trigramIndex = trigramIndex;
			log(
				`Trigram index loaded: ${trigramIndex.files.length} files, base ${trigramIndex.baseCommit.slice(0, 8)}`,
			);
			// Incremental update from git changes since index was built
			const updated = trigramIndex.incrementalUpdate();
			if (updated > 0) {
				log(`Trigram index updated: ${updated} files changed since base commit`);
			}
		} else {
			log("No trigram index found (run `interlinked index build` to create one)");
		}
	} catch (err) {
		log(`Trigram index load failed (non-fatal): ${err}`);
	}
	refreshStatuslineSnapshot();
}, 0);

// --- Strict cyclomatic gate capability ---
// The PreToolUse cyclomatic block + CRAP scoring need the AST pass (the optional
// `typescript` dep, now in optionalDependencies so a normal install has it).
// `--omit=optional` or a stripped install drops it, degrading the gate to the
// less-accurate regex walker. The fail-open in complexity-write-guard would hide
// that, so surface it loudly here (stderr, not verbose-gated) — never silent.
if (astComplexityAvailable()) {
	log("Cyclomatic gate: AST-accurate (typescript resolved)");
} else {
	console.error(
		"[interlinked] WARNING: `typescript` is not resolvable — the strict cyclomatic " +
			"PreToolUse gate and CRAP scoring fell back to the less-accurate regex walker. " +
			"Reinstall without `--omit=optional` to restore AST-accurate enforcement.",
	);
}

// --- Structure graph cache (persists across PostToolUse calls) ---
// Avoids rebuilding the full artifact graph on every file edit.
let structureGraph: import("./structure/artifact-graph.js").ArtifactGraph | null = null;
let structureConfigCache: import("./structure/types.js").StructureConfig | null = null;

let idleTimer: ReturnType<typeof setTimeout> | undefined;

// ===========================================
// Logging
// ===========================================

function log(msg: string): void {
	if (VERBOSE) {
		console.error(`[harness ${new Date().toISOString().slice(11, 19)}] ${msg}`);
	}
}

function logAlways(msg: string): void {
	console.error(`[interlinked-harness] ${msg}`);
}

// Statusline status-file writers (writeClassifierStatus / writeScannerStatus /
// writeReviewPendingMarker) are constructed in the State section above via
// `createStatusWriters(INTERLINKED_DIR)` — see `server/status-writers.ts`.

/**
 * Refresh `.interlinked/statusline.snapshot` and `.interlinked/loaded-rules.md`.
 * Called from the rules hot-reload callback, the trigram-index load timer,
 * and a low-frequency tick that keeps reservation/index counters fresh.
 * Cheap (a few in-memory reads + ~500-byte file write) — safe to call often.
 */
function refreshStatuslineSnapshot(): void {
	const indexStatus = trigramIndex ? "ready" : "missing";
	const indexFiles = trigramIndex?.files.length ?? 0;
	writeStatuslineArtifacts({
		cwd: CWD,
		interlinkedDir: INTERLINKED_DIR,
		rules,
		reservationsCount: reservations.getAll().length,
		indexStatus,
		indexFiles,
		serverBridgeConnected: serverBridge !== null,
		daemonPid: process.pid,
		guardTally: guardTallySnapshot(),
	});
}

// ===========================================
// Idle Timer
// ===========================================

function resetIdleTimer(): void {
	if (!IDLE_TIMEOUT_MS) return; // 0 = disabled
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		logAlways(`Shutting down after ${IDLE_TIMEOUT_MS / MS_PER_MINUTE}min idle`);
		shutdownWith("idle-timeout");
	}, IDLE_TIMEOUT_MS);
}

// Sponsor-runtime activity signal: stamped on every event-loop dispatch (the
// event loop already calls the idle-timer reset per event), so sponsor
// rotation-impressions only count windows with real hook traffic.
let lastHookEventAtMs = 0;
function noteActivityAndResetIdleTimer(): void {
	lastHookEventAtMs = Date.now();
	resetIdleTimer();
}

// ===========================================
// Runtime context
// ===========================================
// One mutable object bundling all daemon-scoped state, passed to each
// extracted pipeline. The reassign-on-reload fields (`rules`,
// `trigramIndex`, `compiledAllowlist`, `structure*`, `filePriorityMap`) are
// kept in sync with the module-level `let`s by `syncRuntime()` — called
// before every pipeline dispatch and after every state-mutating handler.

const serverRuntime: ServerRuntime = {
	cwd: CWD,
	interlinkedDir: INTERLINKED_DIR,
	rules,
	cohort,
	sessions,
	reservations,
	errorHistory,
	routeMap,
	serverBridge,
	asyncFindings,
	learnedRules,
	asyncAnalysis,
	projectWideSweepState,
	contentScanner,
	compiledAllowlist,
	classifierSessions,
	autoCoordStates,
	autoCoordConfig,
	indexWarningSent,
	preEditBaselines,
	trigramIndex,
	fileContentCache,
	structureGraph,
	structureConfigCache,
	filePriorityMap,
	graphCache: _graphCache,
	log,
	logAlways,
	writeClassifierStatus,
	writeReviewPendingMarker,
};

/** Push module-level `let`s that pipelines may reassign into the runtime
 *  context before dispatch, and pull pipeline-mutated fields back out
 *  afterward. Keeps the two views from drifting without a Proxy. */
function syncRuntimeIn(): void {
	serverRuntime.rules = rules;
	serverRuntime.compiledAllowlist = compiledAllowlist;
	serverRuntime.trigramIndex = trigramIndex;
	serverRuntime.structureGraph = structureGraph;
	serverRuntime.structureConfigCache = structureConfigCache;
	serverRuntime.filePriorityMap = filePriorityMap;
}
function syncRuntimeOut(): void {
	trigramIndex = serverRuntime.trigramIndex;
	structureGraph = serverRuntime.structureGraph;
	structureConfigCache = serverRuntime.structureConfigCache;
	filePriorityMap = serverRuntime.filePriorityMap;
}

// ===========================================
// Collection v1 record writer
// ===========================================

/** Record a tool event to both local streams, binding the daemon CWD as the
 *  fallback: the canonical collection.v1 record (server/collection-writer.ts)
 *  and the legacy v5 activity.jsonl mirror (server/activity-writer.ts) that the
 *  CLI reader commands still consume. Both are best-effort and never throw. */
function writeCollectionRecord(event: HarnessEvent, decision?: HarnessDecision): void {
	appendCollectionRecord(event, CWD);
	writeActivityRecord(event, CWD);
	// Persist the guard decision (PreToolUse block/ask, or any warnings) to
	// activity.jsonl. collection.jsonl drops guard_* by design, so this is the
	// only local sink — restores the 2026-06-01 guard-writer regression.
	if (decision) writeGuardDecisionRecord(event, decision, CWD);
}

/** Persist non-tool lifecycle events to the full-fidelity activity stream only.
 *  The collection schema is tool-only, so lifecycle events must not enter the
 *  collection dual-write above. */
function writeLifecycleRecord(event: HarnessEvent, decision?: HarnessDecision): void {
	writeLifecycleActivityRecord(event, CWD, decision);
}

// ===========================================
// Event Processing
// ===========================================
// The per-event pipeline (parse → hydrate/record session → lifecycle/Pre/Post
// dispatch → snapshot + latency log) lives in `server-event-loop.ts`. It
// closes over the `serverRuntime` context plus the module-scoped callbacks
// below (idle-timer reset, runtime in/out sync, collection-record writer) and
// the protocol-status object + path. `writeProtocolStatus` is returned so the
// startup statements at the bottom of this file can serialize the status file.

/** Deadline (in ms) to drain pending async analysis work before shutdown. */
const ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS = 5_000;

const { evaluateEventLine, evaluateUnifiedViaRuntime, writeProtocolStatus } = createEventLoop({
	ctx: serverRuntime,
	protocolStatus,
	protocolStatusPath: PROTOCOL_STATUS_PATH,
	resetIdleTimer: noteActivityAndResetIdleTimer,
	syncRuntimeIn,
	syncRuntimeOut,
	writeCollectionRecord,
	writeLifecycleActivityRecord: writeLifecycleRecord,
});

// ===========================================
// Server Setup
// ===========================================
// The socket binding, legacy pid file, raw-socket connection server, and the
// graceful/forced shutdown path live in `server-socket-lifecycle.ts`. That
// cluster closes over the live socket server, the framed-daemon handle, the
// open-client set, the shutting-down flag, and the connection counter, so it
// is built behind one factory here. The framed-daemon handle and the
// rules/settings watcher disposers are bound after they are created, via
// `setFramedDaemon` / `setUnwatchers`.

// Lifecycle ledger: one row per start and per exit WITH ITS REASON, so the
// next "daemon unreachable" block can explain itself instead of reading as a
// crash. Wrapper (not a param on the lifecycle module) so its contract stays
// untouched and every caller states its reason at the call site.
const DAEMON_STARTED_MS = Date.now();
recordDaemonEvent(CWD, { at: DAEMON_STARTED_MS, pid: process.pid, event: "start" });
const socketLifecycle = createSocketLifecycle({
		socketPath: SOCKET_PATH,
		pidPath: PID_PATH,
		runRawSocket: RUN_RAW_SOCKET,
		asyncAnalysisDrainTimeoutMs: ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS,
		serverBridge,
		reservations,
		contentScanner,
		asyncAnalysis,
		evaluateEventLine,
		log,
		logAlways,
	});
const shutdownWith = (reason: string): void => {
	recordDaemonExit(CWD, reason, DAEMON_STARTED_MS);
	socketLifecycle.shutdown();
};

// ===========================================
// Start Server
// ===========================================

await activateDaemon({
	cli: cliConfig,
	state: daemonState,
	runtime: serverRuntime,
	socketLifecycle,
	startupGuard,
	earlyShutdown,
	moduleUrl: import.meta.url,
	getRules: () => rules,
	setRules: (nextRules) => {
		rules = nextRules;
	},
	setCompiledAllowlist: (nextAllowlist) => {
		compiledAllowlist = nextAllowlist;
	},
	getLastHookEventAtMs: () => lastHookEventAtMs,
	getTrigramIndex: () => trigramIndex,
	getGraphForFile,
	resetIdleTimer,
	refreshStatuslineSnapshot,
	shutdownWith,
	evaluateEventLine,
	evaluateUnifiedViaRuntime,
	writeProtocolStatus,
	log,
	logAlways,
});

// server.ts is a process entry point (shebang above) — it has no public
// API. Every consumer either spawns `dist/harness/server.js` as a daemon
// or imports the extracted pipeline modules from `server/` directly.
