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

import { execSync, spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type { JsonObject } from "../lib/json-types.js";
import {
	checkAssertionDensity,
	checkProdDeltaWithoutTestDelta,
	checkProdTestLocRatio,
	checkTddCommitGate,
	checkTppLeapfrog,
	runBehavioralChecks,
} from "./behavioral-checks.js";
import {
	checkAssertionStrengthWeakening,
	checkClockMockAdded,
	checkConventionalCommitCoherence,
	checkDisabledTestDelta,
	checkDoneWithoutVerify,
	checkReintroducesRemovedCode,
	checkTestBlockCountRegression,
	parseCommitMessageFromBash,
} from "./behavioral-diff-checks.js";
import { getOrCreateEngine } from "./check-engine/index.js";
import { GENERIC_CHECK_META, QUALITY_CHECK_META, STRUCTURAL_CHECK_META } from "./check-metadata.js";
import { CohortManager } from "./cohort.js";
import { applyAllowlist, compileAllowlist } from "./content-scanner/allowlist.js";
import { decideFromFindings } from "./content-scanner/policy.js";
import { runPostToolScan } from "./content-scanner/post-scan.js";
import { scanUserPrompt } from "./content-scanner/prompt-scan.js";
import { buildAskReason, writePendingPrompt } from "./content-scanner/redact-preview.js";
import { createScanner } from "./content-scanner/registry.js";
import { countPendingReviews } from "./content-scanner/review-files.js";
import type { ContentScanner, ScanFinding } from "./content-scanner/types.js";
import { fetchAndScan } from "./content-scanner/web-fetch-proxy.js";
import { snapshotCrap } from "./checks/crap-baseline.js";
import { coverageForFile, loadCoverageFinal } from "./coverage-final-reader.js";
import { checkOrphanedTests } from "./deletion-hygiene.js";
import { ErrorHistory } from "./error-history.js";
import { readSharedConfig } from "../lib/config.js";
import { evaluatePostToolUse, evaluatePreToolUse, extractPermissionPattern } from "./evaluator.js";
import { appendLatencyLog } from "./latency-log.js";
import { PROTOCOL_VERSION } from "./daemon-protocol.js";
import { checkProjectTestsClean, checkProjectTypecheckClean } from "./project-typecheck-gate.js";
import { capturePrimitiveViolations as captureDiscoveredPrimitiveViolations } from "./discovered-primitives.js";
import { registerAllBuiltinVerifyPasses } from "./check-pipeline/builtin-verify-passes.js";
import {
	type FilePriority,
	refreshPriorityIfStale as refreshFilePriorityIfStale,
	shouldRunAdvisoryChecks,
} from "./file-priority.js";
import { shouldSkipPath } from "./skip-paths.js";
import {
	computeEffectivenessSummary,
	recordWarningResolutions,
	recordWarningsIssued,
} from "./feedback-effectiveness.js";
import { checkFunctionComplexity, checkMissingReturnTypes } from "./generic-checks.js";
import { checkGrepAcceleration, FileContentCache, findRipgrep } from "./grep-accelerator.js";
import {
	formatImpactWarning,
	recordImpactFollowUps,
	runImpactAnalysis,
} from "./impact-analysis.js";
import {
	appendShadowLog,
	buildEvidenceEnvelope,
	type ClassifierSessionState,
	callClassifier,
	createClassifierSessionState,
	hashEvidence,
	resolveApiKey,
} from "./policy-classifier.js";
import { runMetacoderForPrompt } from "./metacoder/index.js";
import { evictOverlayForSession } from "./metacoder/metacoder-writer.js";
import { DEFAULT_METACODER_CONFIG } from "./metacoder/types.js";
import { ProjectGraph } from "./project-graph.js";
import {
	countAsAnyCasts,
	countConsoleStatements,
	countNonNullAssertions,
	countPublicApiSurface,
	countSuppressionDirectives,
	countTodoMarkers,
	countTypeDensity,
	collectSoftwareVersionReferences,
	findProjectRoot,
	formatQualityWarnings,
	ProjectWideSweepState,
	type QualityCheckOptions,
	runProjectWideChecksAsync,
	runQualityChecks,
} from "./quality-checks.js";
import {
	autoStripAllScopes,
	defaultStripAuditLogPath,
	describeReason as describeMalformedReason,
} from "../lib/settings-validator.js";
import { watchSettingsFiles } from "./settings-watcher.js";
import { resetProjectSetupWarningsCache } from "./evaluator/pre-tool.js";
import { formatStopNudge, readSessionTokens } from "./commit-cadence.js";
import {
	countCodeFilesEdited,
	countUiFilesEdited,
	formatStubsIntroducedWarning,
	formatUiNotInteractedWarning,
	formatUnverifiedCodeWarning,
	formatVerifyNotRunWarning,
} from "./verification-stop-checks.js";
import { recordHarnessCaught } from "./recurrence.js";
import { runFailureChannels } from "./failure-channels.js";
import { ReservationManager } from "./reservations.js";
import { isErr, tryFn } from "./result.js";
import { DEFAULT_TRIGGERS, expandSiblings } from "./sibling-expansion.js";
import { RouteMap } from "./route-map.js";
import { loadRules, watchRulesFiles } from "./rules-loader.js";
import { writeStatuslineArtifacts } from "./statusline-snapshot.js";
import { sanitizeSessionId } from "./session-paths.js";
import { daemonPathsFor } from "./session-paths.js";
import { collectDeletionHygieneDiffFindings } from "./server/deletion-hygiene-diff.js";
import { collectSuggestionFindings } from "./server/suggestion-checks.js";
import { createServerBridge, type ServerBridge } from "./server-bridge.js";
import { startSessionDaemon, type SessionDaemonHandle } from "./session-daemon.js";
import {
	extractAllEditedFilePaths,
	extractEditedFilePath,
} from "./server-tool-helpers.js";
import {
	acknowledgeChecks,
	getActiveSkills,
	isAcknowledged,
	recordSkillEnter,
	recordSkillLeave,
	SessionTracker,
} from "./session-state.js";
import {
	deleteLiveSnapshot,
	readLiveSnapshot,
	sweepStaleLiveSnapshots,
	writeLiveSnapshot,
} from "./live-snapshot.js";
import {
	formatStructuralWarnings,
	runStructuralChecks,
	shouldSkipTsc,
} from "./structural-checks.js";
import { runStructureChecks } from "./structure/structure-checks.js";
import { formatStructureWarnings } from "./structure/structure-formatter.js";
import { loadStructureConfig } from "./structure/structure-loader.js";
import {
	type Finding,
	formatScoredFindings,
	scoreFindings,
	writeTelemetry,
} from "./suggestion-scorer.js";
import { loadFileSuppressions, scanInlineSuppressions } from "./suppressions.js";
import {
	checkContextBloat,
	checkSilentFailure,
	consecutiveFailureWarning,
	formatBloatWarning,
	formatSilentFailureWarning,
} from "./tool-result-checks.js";
import { TrigramIndex } from "./trigram-index.js";
import { createTsgoRunner } from "./tsgo-runner.js";
import type {
	ExportedSymbol,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	PreEditBaseline,
} from "./types.js";
import { toLegacyHarnessEvent } from "./legacy-client.js";
import type { UnifiedHookEvent } from "./unified-event.js";

// ===========================================
// CLI Arguments
// ===========================================

const { values: args } = parseArgs({
	options: {
		socket: { type: "string", short: "s" },
		"pid-file": { type: "string" },
		"idle-timeout": { type: "string" },
		cwd: { type: "string" },
		protocol: { type: "string" },
		"session-id": { type: "string" },
		verbose: { type: "boolean", short: "v", default: false },
	},
	strict: false,
});

// Narrow parseArgs values — they return `string | true | undefined` for string options.
// `true` occurs when flag is passed without a value (e.g., --socket without =path).
function stringArg(val: string | boolean | undefined): string | undefined {
	return typeof val === "string" ? val : undefined;
}

const CWD = stringArg(args.cwd) || process.cwd();
const INTERLINKED_DIR = join(CWD, ".interlinked");

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
const SOCKET_PATH = stringArg(args.socket) || join(INTERLINKED_DIR, "harness.sock");
const PID_PATH = stringArg(args["pid-file"]) || join(INTERLINKED_DIR, "harness.pid");

// ============================================================================
// Early SIGTERM/SIGINT handler — installed BEFORE heavy startup work.
// ============================================================================
// Why: Node delivers signals on JS turn boundaries. The full graceful
// `shutdown()` registered at the bottom of this file can't fire until module
// initialization finishes — and trigram-index load, project-graph build,
// rule compilation, etc. are mostly synchronous, so a SIGTERM during
// startup gets queued for *seconds*. The user-visible symptom is
// `harness restart` hitting its grace window every time and falling back to
// SIGKILL.
//
// The fix: register a minimal handler immediately. If a signal arrives
// before the full shutdown machinery is wired, set a "pending" flag and
// schedule a hard exit. Once startup completes, the bottom-of-file code
// upgrades the handler to the real `shutdown()`. If the pending flag is
// set, it triggers shutdown right away.
let _shutdownReady = false;
let _shutdownPending = false;
function _earlyShutdown(): void {
	if (_shutdownReady) {
		// Real handler is in place; this branch is unreachable in practice
		// (process.on rebinds), but defensive against double-binding.
		return;
	}
	_shutdownPending = true;
	// Best-effort artifact cleanup so the next startup doesn't see a stale
	// pid file from a daemon that was killed mid-init.
	try {
		if (existsSync(PID_PATH)) rmSync(PID_PATH);
	} catch (cleanupErr) {
		void cleanupErr; /* intentional: pid file may not have been written yet */
	}
	// Hard exit after a short window if the real shutdown never wires up.
	// 1500 ms covers cold-cache module init (~1s on this repo) but stays
	// tight enough that the user perceives the shutdown as snappy. Forced
	// exit isn't graceful, but the daemon hasn't accepted external
	// connections yet — there's nothing to drain.
	const t = setTimeout(() => {
		process.exit(0);
	}, 1500);
	t.unref();
}
process.on("SIGTERM", _earlyShutdown);
process.on("SIGINT", _earlyShutdown);

type HarnessProtocolMode = "raw" | "framed" | "dual";
function parseProtocolMode(raw: string | undefined): HarnessProtocolMode {
	if (raw === "raw" || raw === "framed" || raw === "dual") return raw;
	return "dual";
}
const PROTOCOL_MODE = parseProtocolMode(stringArg(args.protocol));
const RUN_RAW_SOCKET = PROTOCOL_MODE !== "framed";
const RUN_FRAMED_SOCKET = PROTOCOL_MODE !== "raw";
const FRAMED_SESSION_ID = stringArg(args["session-id"]) || process.env.INTERLINKED_SESSION_ID || "default";
const FRAMED_PATHS = daemonPathsFor(CWD, FRAMED_SESSION_ID);
// Always-on by default. Per-session Maps (classifierSessions, autoCoordStates,
// preEditBaselines) drop on SessionEnd, so resident memory stabilizes around
// ~30 MB per daemon — it doesn't grow with uptime. The original orphan-
// accumulation concern (many daemons × many CWDs) is handled by the explicit
// `interlinked harness clean` command, not by an idle timer.
// Set `--idle-timeout <ms>` to opt back into auto-shutdown if you want it.
const IDLE_TIMEOUT_DEFAULT_MS = 0;
const _rawIdleArg = stringArg(args["idle-timeout"]);
const IDLE_TIMEOUT_MS =
	_rawIdleArg !== undefined ? Number(_rawIdleArg) : IDLE_TIMEOUT_DEFAULT_MS;
const VERBOSE = args.verbose;

/** Milliseconds in one minute — for converting IDLE_TIMEOUT_MS into a human-readable log line. */
const MS_PER_MINUTE = 60_000;
/** Deadline (in ms) to drain pending async analysis work before shutdown. */
const ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS = 5_000;

// ===========================================
// State
// ===========================================

let rules: GuardRulesConfig = loadRules(CWD);
const cohort = new CohortManager();
const sessions = new SessionTracker();

// --- Learned rules (cross-session permission learning) ---
import { createLearnedRulesStore } from "./learned-rules.js";

const learnedRules = createLearnedRulesStore(INTERLINKED_DIR);

// --- Async analysis (background check coalescing) ---
import { createAsyncAnalysisManager } from "./async-analysis.js";

const asyncAnalysis = createAsyncAnalysisManager(INTERLINKED_DIR);

// --- Turn-end handler ---
import { buildTurnEndSummary, formatTurnEndWarnings } from "./turn-end.js";

// --- LLM policy classifier session state ---
// Per-session classifier state (call count, consecutive failures).
const classifierSessions = new Map<string, ClassifierSessionState>();

// --- Metacoder per-session rule cache ---
// Populated on UserPromptSubmit after the metacoder writes the overlay;
// consulted on PreToolUse via `rulesForSession()`. Cache entry replaces
// on each new prompt for the same session_id (plan §1.1, replace
// semantics). Cleared in the SessionEnd / Stop handler.
const sessionRules = new Map<string, GuardRulesConfig>();

/** PreToolUse evaluator entry point — returns the per-session merged
 *  ruleset (floor + overlay) for the given session, or the global floor
 *  when no overlay has been written yet. Mirrors the existing `rules`
 *  fallback so legacy callers behave unchanged when no metacoder has fired.
 *
 *  Plan §reviewer-P3 (round 5): on cache miss, hydrate from the on-disk
 *  overlay file. Without this, a daemon restart between UserPromptSubmit
 *  and the first PreToolUse leaves the in-memory map empty, so the agent
 *  silently runs against floor-only even though `overlay-rules.json`
 *  exists on disk. The hydrated value is cached so subsequent calls in
 *  the same process stay O(1). */
function rulesForSession(sessionId: string | undefined): GuardRulesConfig {
	if (!sessionId) return rules;
	const cached = sessionRules.get(sessionId);
	if (cached) return cached;
	// Cache miss — try loading from disk. `loadRules(cwd, sessionId)`
	// returns floor + overlay when an overlay file exists, or floor-only
	// otherwise. Either way we cache the snapshot; a later
	// UserPromptSubmit replaces it via `sessionRules.set(...)`, and a
	// floor reload clears the map via `sessionRules.clear()`.
	const hydrated = loadRules(CWD, sessionId);
	sessionRules.set(sessionId, hydrated);
	return hydrated;
}

// ML content scanner (OpenAI privacy-filter / gpt-oss-safeguard). Off by default;
// opt in via `.interlinked/guard-rules.local.json` → `"content_scanner": {"enabled": true}`.
// Undefined when disabled or misconfigured — both read paths below null-check.
const contentScanner: ContentScanner | undefined = rules.content_scanner
	? createScanner(rules.content_scanner)
	: undefined;
// Compile the allowlist once at startup so we don't pay regex/string-building
// cost on every scan. Recompiled on hot-reload (see watchRulesFiles below).
let compiledAllowlist = compileAllowlist(rules.content_scanner?.allowlist);
if (contentScanner) {
	// Visible at startup so agents know the scanner is in-line.
	logAlways(`Content scanner: enabled (${contentScanner.name} / ${contentScanner.runtime})`);
	if (contentScanner.onStatusChange) {
		// Statusline writer — every lifecycle transition (spawn, ready, dormant,
		// disabled) lands a single-line marker at .interlinked/content-scanner.status.
		contentScanner.onStatusChange((s) => {
			writeScannerStatus(formatScannerStatusLine(s));
		});
	} else {
		// HTTP backends don't currently surface state — treat them as running.
		writeScannerStatus(`ready:${contentScanner.runtime}`);
	}
} else {
	writeScannerStatus("disabled");
}

// --- Auto-coordination state ---
import {
	type AutoCoordinationState,
	createAutoCoordinationState,
	DEFAULT_AUTO_COORDINATION_CONFIG,
	injectCoordinationWarnings,
	shouldCoordinate,
} from "./auto-coordinate.js";

const autoCoordStates = new Map<string, AutoCoordinationState>();
const indexWarningSent = new Set<string>();
const autoCoordConfig = {
	...DEFAULT_AUTO_COORDINATION_CONFIG,
	...(rules.auto_coordination || {}),
};

function getAutoCoordState(sessionId: string): AutoCoordinationState {
	let state = autoCoordStates.get(sessionId);
	if (!state) {
		state = createAutoCoordinationState();
		autoCoordStates.set(sessionId, state);
	}
	return state;
}

// --- Pre-edit baseline cache (diff-aware quality checks) ---
// Captured on PreToolUse for Edit/Write tools, consumed on PostToolUse.
const preEditBaselines = new Map<string, PreEditBaseline>();
const routeMap = new RouteMap(CWD);
const errorHistory = new ErrorHistory(INTERLINKED_DIR, rules.error_memory);

// --- Project-wide check sweep state ---
// Tracks edit count and reported findings for debounced cross-file sweeps.
const projectWideSweepState = new ProjectWideSweepState();

// --- Multi-project graph cache ---
// Lazily creates a ProjectGraph per project root so structural checks work
// for files in any repo, not just the harness's CWD.
const _graphCache = new Map<string, ProjectGraph>();

function getGraphForFile(filePath: string): ProjectGraph {
	const projectRoot = findProjectRoot(filePath, CWD) || CWD;
	let g = _graphCache.get(projectRoot);
	if (!g) {
		g = new ProjectGraph(projectRoot);
		try {
			g.initialize();
			log(`Project graph initialized for ${projectRoot}: ${g.fileCount} files`);
		} catch (err) {
			log(`Project graph init failed for ${projectRoot} (non-fatal): ${err}`);
		}
		_graphCache.set(projectRoot, g);
	}
	return g;
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

// --- Structure graph cache (persists across PostToolUse calls) ---
// Avoids rebuilding the full artifact graph on every file edit.
let structureGraph: import("./structure/artifact-graph.js").ArtifactGraph | null = null;
let structureConfigCache: import("./structure/types.js").StructureConfig | null = null;

// Create server bridge for reservation sync and guard event reporting
const serverBridge: ServerBridge | null = createServerBridge(CWD);
if (serverBridge) {
	log("Server bridge connected");
} else {
	log("No server configured — running in local-only mode");
}

const reservationEventsPath = join(CWD, ".interlinked", "reservation-events.jsonl");
const reservations = new ReservationManager(
	serverBridge || undefined,
	undefined,
	(event) => {
		try {
			const dir = dirname(reservationEventsPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			appendFileSync(reservationEventsPath, `${JSON.stringify(event)}\n`);
		} catch (_err) {
			/* intentional: reservation-events is best-effort observability */
		}
	},
);
let idleTimer: ReturnType<typeof setTimeout>;
let connectionCount = 0;
let _totalEventsProcessed = 0;

interface ProtocolStatusFile {
	protocol: HarnessProtocolMode;
	protocol_version: typeof PROTOCOL_VERSION;
	started_at: string;
	raw_socket_path: string | null;
	framed_socket_path: string | null;
	framed_session_id: string | null;
	last_raw_event_at: string | null;
	last_framed_event_at: string | null;
	raw_event_count: number;
	framed_event_count: number;
	framed_error_count: number;
	framed_timeout_count: number;
}

const PROTOCOL_STATUS_PATH = join(INTERLINKED_DIR, "harness-protocol.json");
const protocolStatus: ProtocolStatusFile = {
	protocol: PROTOCOL_MODE,
	protocol_version: PROTOCOL_VERSION,
	started_at: new Date().toISOString(),
	raw_socket_path: RUN_RAW_SOCKET ? SOCKET_PATH : null,
	framed_socket_path: RUN_FRAMED_SOCKET ? FRAMED_PATHS.socket : null,
	framed_session_id: RUN_FRAMED_SOCKET ? FRAMED_SESSION_ID : null,
	last_raw_event_at: null,
	last_framed_event_at: null,
	raw_event_count: 0,
	framed_event_count: 0,
	framed_error_count: 0,
	framed_timeout_count: 0,
};

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

// ===========================================
// Classifier Status (read by statusline script)
// ===========================================

const CLASSIFIER_STATUS_PATH = join(INTERLINKED_DIR, "classifier.status");

function writeClassifierStatus(status: string): void {
	try {
		writeFileSync(CLASSIFIER_STATUS_PATH, status);
	} catch (e) {
		void e;
	}
}

// ===========================================
// Content Scanner Status (read by statusline script)
// ===========================================
// Parallels CLASSIFIER_STATUS_PATH. One-line states consumed by the bash
// statusline: disabled / starting / ready:<pid> / dormant / down:<reason>.

const SCANNER_STATUS_PATH = join(INTERLINKED_DIR, "content-scanner.status");
/** Mirror file written next to the status. Holds the count of unresolved
 *  review files so the bash statusline can render `🔒 review:N` without
 *  scanning the pending dir on every render. Empty/absent means zero. */
const SCANNER_REVIEW_PENDING_PATH = join(INTERLINKED_DIR, "scanner", "review-pending");

function writeScannerStatus(status: string): void {
	try {
		writeFileSync(SCANNER_STATUS_PATH, status);
	} catch (e) {
		void e;
	}
}

/** Persist the count of pending reviews as a single line for the
 *  statusline. Best-effort: failure to write only loses the indicator,
 *  which is recoverable on the next call. */
function writeReviewPendingMarker(count: number): void {
	try {
		writeFileSync(SCANNER_REVIEW_PENDING_PATH, `${count}\n`);
	} catch (e) {
		void e;
	}
}

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
	});
}

/** Collapse a `ScannerStatus` into the one-line shell-grepable format. */
function formatScannerStatusLine(s: {
	state: string;
	pid?: number;
	detail?: string;
}): string {
	switch (s.state) {
		case "ready":
			return `ready:${s.pid ?? "?"}`;
		case "dormant":
			return "dormant";
		case "starting":
		case "idle":
			return "starting";
		case "disabled":
			return `down:${s.detail ?? "unknown"}`;
		default:
			return s.state;
	}
}

// ===========================================
// Idle Timer
// ===========================================

function resetIdleTimer(): void {
	if (!IDLE_TIMEOUT_MS) return; // 0 = disabled
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		logAlways(`Shutting down after ${IDLE_TIMEOUT_MS / MS_PER_MINUTE}min idle`);
		shutdown();
	}, IDLE_TIMEOUT_MS);
}

// ===========================================
// Event Processing
// ===========================================

async function processEvent(rawData: string): Promise<HarnessDecision> {
	let event: HarnessEvent;
	try {
		event = JSON.parse(rawData.trim());
	} catch (cause) {
		// SECURITY: Malformed events must NOT be allowed through.
		// A broken payload could be a parser-differential attack or a
		// corrupted hook script — either way, we cannot evaluate safety.
		log(`Event parse failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		return { decision: "block", reason: "Malformed event — cannot evaluate safety." };
	}

	_totalEventsProcessed++;
	resetIdleTimer();

	// Lazy hydrate: if the in-memory tracker has no entry for this session
	// but disk has a `<id>.live.json` from a previous incarnation of this
	// daemon, restore it before recordEvent so the upcoming event lands on
	// continuous trajectory state (acknowledged checks, edit counts, fired
	// reminders, TDD cycles, ...) instead of resetting to a fresh session.
	if (event.session_id && !sessions.get(event.session_id)) {
		const snap = readLiveSnapshot(CWD, event.session_id);
		if (snap) {
			const restored = sessions.hydrate(snap);
			if (restored) {
				log(
					`Hydrated session ${event.session_id} from live snapshot ` +
						`(${restored.tool_call_count} tool calls, ${restored.files_written.size} files written)`,
				);
			}
		}
	}

	// Update session trajectory.
	// Per-event durability: the snapshot write moved out of this function and
	// runs from `evaluateEventLine` AFTER `processEvent` returns, so the
	// snapshot reflects post-event mutations too — PostToolUse handlers
	// updating `tdd_cycles`, `assertion_counts`, or `active_skills` would
	// otherwise be lost on a daemon restart even though `recordEvent` mutated
	// state that *was* captured. See `evaluateEventLine`'s try/finally.
	const session = sessions.recordEvent(event);

	// Update cohort based on lifecycle events
	switch (event.hook_event) {
		case "SessionStart": {
			cohort.agentJoined(event);
			log(`Agent joined: ${event.agent_name || event.session_id} (${event.agent_source})`);
			// Recency-weighted check depth (Mythos Phase 4): refresh the
			// per-file priority map from git log if the cache is stale.
			// Cold files (>180 days unchanged) skip advisory checks at
			// PostToolUse via `shouldRunAdvisoryChecks`.
			try {
				const refreshed = refreshFilePriorityIfStale(CWD);
				if (refreshed.size > 0) {
					filePriorityMap = refreshed;
					log(`File-priority map refreshed: ${refreshed.size} entries`);
				}
			} catch (err) {
				log(`File-priority refresh failed (non-fatal): ${err}`);
			}
			// Incremental index update on session start (catches git changes between sessions)
			if (trigramIndex) {
				try {
					const updated = trigramIndex.incrementalUpdate();
					if (updated > 0) {
						log(`Trigram index refreshed: ${updated} files updated`);
					}
				} catch (err) {
					log(`Trigram index refresh failed (non-fatal): ${err}`);
				}
				// One-time warning if index exists but ripgrep is missing
				if (!findRipgrep()) {
					logAlways(
						"[interlinked] Trigram index loaded but ripgrep (rg) not found — grep acceleration disabled. Install: brew install ripgrep (macOS), apt install ripgrep (Linux), or cargo install ripgrep",
					);
				}
			}
			// Auto-strip malformed permission rules from .claude/settings*.json
			// (project + user scope), with an audit log so every removed entry
			// is visible. The agent-write path is already blocked at PreToolUse
			// (write-content-guards.ts), but Claude Code's "Always allow" UI
			// writes settings.json internally without firing a tool hook — that
			// path is invisible to PreToolUse, so SessionStart is the only
			// surface where we can clean it. JSONL audit at
			// .interlinked/permission-rule-strips.jsonl.
			try {
				const auditPath = defaultStripAuditLogPath(CWD);
				const stripResult = autoStripAllScopes(CWD, auditPath);
				if (stripResult.totalStripped > 0) {
					// Invalidate the project-setup-warning cache so the next
					// PreToolUse re-reads settings.json and stops emitting
					// `[interlinked:setup]` for the entries just stripped.
					// Without this, the daemon serves stale warning text for
					// the rest of its process lifetime even though the file
					// is now clean.
					resetProjectSetupWarningsCache();
					const previews = stripResult.entries.slice(0, 5).map((e) => {
						const file = e.file.replace(/^.+?(\.claude\/.+)$/, "$1");
						return `  - ${file} permissions.${e.bucket}[${e.index}] = ${JSON.stringify(e.rule)} (${describeMalformedReason(e.reason)})`;
					});
					const more =
						stripResult.entries.length > previews.length
							? `\n  ...and ${stripResult.entries.length - previews.length} more`
							: "";
					const relAudit = auditPath.startsWith(`${CWD}/`)
						? auditPath.slice(CWD.length + 1)
						: auditPath;
					const warning =
						`[interlinked:permission-strip] Auto-stripped ${stripResult.totalStripped} malformed permission rule(s) from Claude Code settings file(s) (full audit at ${relAudit}):\n${previews.join("\n")}${more}\n` +
						"These rules came from Claude Code's permission UI; the upstream extractor occasionally emits bad parens / empty / missing-Tool() entries. The agent-write path is already blocked at PreToolUse — this strip handles the UI-write path that is invisible to hooks.";
					log(
						`Auto-stripped ${stripResult.totalStripped} malformed permission rule(s); audit at ${auditPath}`,
					);
					return { decision: "allow", warnings: [warning] };
				}
			} catch (err) {
				log(`Permission-rule auto-strip failed (non-fatal): ${err}`);
			}
			break;
		}
		case "SessionEnd":
		case "Stop": {
			// Build turn-end summary before cleanup (trajectory-level analysis)
			const turnSummary = buildTurnEndSummary(session, 0, 0);
			const turnWarnings = formatTurnEndWarnings(turnSummary);
			if (turnWarnings.length > 0) {
				log(`Turn-end patterns: ${turnSummary.turn_patterns.join(", ")}`);
			}

			// Commit-cadence Stop nudge — encourage bundling uncommitted code-file
			// edits into commits before ending. Doc/plan files are excluded.
			// Wording escalates by cumulative session token count, read once
			// from the transcript path the hook script forwarded.
			const cadenceCfg = rules.commit_cadence;
			if (cadenceCfg?.enabled && session && !session.stop_nudge_emitted) {
				const nonDocCount = session.non_doc_files_edited_since_commit?.size ?? 0;
				const docCount = session.doc_files_edited_since_commit ?? 0;
				const tokens = readSessionTokens(event.transcript_path);
				const nudge = formatStopNudge({
					uncommittedNonDocCount: nonDocCount,
					docFilesExcluded: docCount,
					threshold: cadenceCfg.stop_threshold,
					cumulativeTokens: tokens?.total,
					tokenBandLow: cadenceCfg.token_band_low,
					tokenBandHigh: cadenceCfg.token_band_high,
				});
				if (nudge !== null) {
					turnWarnings.push(nudge);
					session.stop_nudge_emitted = true;
					log(
						`Commit-cadence Stop nudge: ${nonDocCount} uncommitted code files, ${docCount} doc files excluded, tokens=${tokens?.total ?? "n/a"}`,
					);
				}
			}

			// Verification-before-stop nudges — three independent reflection
			// warnings keyed off the verification_observed / stubs_introduced
			// session fields populated by session-state.ts (signals) and the
			// post-tool evaluator (stubs). All stderr-only; none block. See
			// docs/external-pulse/failproofai.md §"smarter Stop hooks" for the
			// design rationale and docs/design/stop-event-checks.md for the
			// tier-2/3 backlog.
			const vsc = rules.verification_stop_checks;
			if (vsc?.enabled && session) {
				const verificationObserved = session.verification_observed ?? new Set<string>();
				if (vsc.warn_unverified_code) {
					const codeFilesEdited = countCodeFilesEdited(session.files_written);
					const warning = formatUnverifiedCodeWarning({ codeFilesEdited, verificationObserved });
					if (warning !== null) {
						turnWarnings.push(warning);
						log(
							`Verify-before-stop: unverified-code (${codeFilesEdited} files, signals=${[...verificationObserved].join(",") || "none"})`,
						);
					}
				}
				if (vsc.warn_verify_not_run) {
					const codeFilesEdited = countCodeFilesEdited(session.files_written);
					const warning = formatVerifyNotRunWarning({ codeFilesEdited, verificationObserved });
					if (warning !== null) {
						turnWarnings.push(warning);
						log(
							`Verify-before-stop: verify-suite-not-run (${codeFilesEdited} files, signals=${[...verificationObserved].join(",") || "none"})`,
						);
					}
				}
				if (vsc.warn_ui_not_interacted) {
					const uiFilesEdited = countUiFilesEdited(session.files_written);
					const warning = formatUiNotInteractedWarning({ uiFilesEdited, verificationObserved });
					if (warning !== null) {
						turnWarnings.push(warning);
						log(`Verify-before-stop: ui-not-interacted (${uiFilesEdited} files)`);
					}
				}
				if (vsc.warn_stubs_introduced) {
					const stubs = session.stubs_introduced ?? [];
					const warning = formatStubsIntroducedWarning({ stubs });
					if (warning !== null) {
						turnWarnings.push(warning);
						log(`Verify-before-stop: stubs-introduced (${stubs.length})`);
					}
				}
			}

			// Persist session trajectory + turn summary before cleanup
			const trajectory = sessions.serialize(event.session_id);
			if (trajectory) {
				const saveResult = tryFn(() => {
					const sessDir = join(CWD, ".interlinked", "sessions");
					if (!existsSync(sessDir)) mkdirSync(sessDir, { recursive: true });
					// SECURITY: event.session_id arrives over the Unix socket as
					// arbitrary JSON-parsed data. Without sanitization, a payload
					// like "../../../.config/target" would escape sessDir via
					// path.join (which does not contain traversal). We both
					// sanitize (whitelist charset + length cap) and containment-
					// check the resolved path before writing.
					const safeId = sanitizeSessionId(event.session_id);
					if (!safeId) {
						throw new Error("invalid session_id: no safe characters");
					}
					const targetPath = join(sessDir, `${safeId}.trajectory.json`);
					const resolvedDir = resolve(sessDir);
					const resolvedTarget = resolve(targetPath);
					if (
						resolvedTarget !== resolvedDir &&
						!resolvedTarget.startsWith(resolvedDir + sep)
					) {
						throw new Error(
							`refusing to write trajectory outside sessions dir: ${resolvedTarget}`,
						);
					}
					writeFileSync(
						targetPath,
						JSON.stringify(
							{
								...trajectory,
								turn_summary: turnSummary,
								feedback_effectiveness: computeEffectivenessSummary(session),
							},
							null,
							2,
						),
					);
				});
				if (isErr(saveResult)) {
					log(`Failed to save trajectory (non-fatal): ${saveResult.error.message}`);
				} else {
					log(`Session trajectory saved: ${event.session_id}`);
				}
			}

			// Drain any in-flight async analysis before cleanup
			await asyncAnalysis.drain(ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS);

			cohort.agentLeft(event);
			reservations.releaseAllForAgent(event.agent_name || session.agent_name, cohort);
			sessions.remove(event.session_id);
			// Pair the trajectory.json archive with live-snapshot deletion —
			// once the session is permanently archived, the live snapshot is
			// noise that would otherwise be picked up by the startup sweep.
			deleteLiveSnapshot(CWD, event.session_id);
			classifierSessions.delete(event.session_id);
			autoCoordStates.delete(event.session_id);
			// Metacoder cleanup — evict the overlay artifacts on disk AND the
			// per-session rule cache. Codex emits `Stop` only; Claude emits
			// both `SessionEnd` and `Stop`. The joint switch case above
			// catches all three. Plan §1, §2.5.
			evictOverlayForSession({ cwd: CWD, sessionId: event.session_id });
			sessionRules.delete(event.session_id);
			log(`Agent left: ${event.agent_name || event.session_id}`);
			return {
				decision: "allow",
				warnings: turnWarnings.length > 0 ? turnWarnings : undefined,
			};
		}
		case "UserPromptSubmit": {
			cohort.recordActivity(event);

			// Recursion guard — when the metacoder spawns `claude -p` to invoke
			// Opus 4.7, the spawned subprocess inherits the user's hooks and
			// fires its own UserPromptSubmit back here. Without this short-
			// circuit we recurse and never return. Plan §2.5.
			if (event.metacoder_subprocess === true) {
				return { decision: "allow" };
			}

			// Scan the prompt for PII. On findings, return a redacted copy so the
			// hook stores the masked version in activity.jsonl instead of the raw.
			// Never blocks — users are always allowed to submit their own prompts;
			// this is storage hygiene, not a policy gate.
			let redactedPrompt: string | undefined;
			if (rules.content_scanner?.enabled && contentScanner) {
				const promptText = event.prompt ?? "";
				const scanResult = await scanUserPrompt(promptText, rules, contentScanner);
				if (scanResult) {
					log(
						`Content scanner: UserPromptSubmit — ${scanResult.findings.length} finding(s), redacted for local log`,
					);
					redactedPrompt = scanResult.redacted;
				}
			}

			// Metacoder — synchronous per-prompt overlay generation. Plan §1, §6.
			// Pass the redacted prompt when the scanner fired, the raw prompt
			// otherwise. Fail-open on every error: the prompt always reaches the
			// agent, just without overlay constraints.
			const metacoderConfig = rules.metacoder ?? DEFAULT_METACODER_CONFIG;
			let metacoderAdditionalContext: string | undefined;
			if (!metacoderConfig.enabled) {
				// Plan §reviewer-P1 (round 6): metacoder explicitly off. Evict
				// any stale overlay-rules.json from a prior prompt before it
				// can be merged on the next PreToolUse. Without this, a user
				// who toggles enabled→false keeps being blocked by the last
				// overlay until SessionEnd.
				sessionRules.delete(event.session_id);
				evictOverlayForSession({ cwd: CWD, sessionId: event.session_id });
			} else if (event.prompt && event.prompt.length > 0) {
				const promptForMeta = redactedPrompt ?? event.prompt;
				const outcome = await runMetacoderForPrompt({
					cwd: CWD,
					sessionId: event.session_id,
					client: event.agent_source,
					prompt: promptForMeta,
					floorRuleIds: rules.rules.map((r) => r.id),
					config: metacoderConfig,
				});
				if (outcome.kind === "ok") {
					sessionRules.set(event.session_id, loadRules(CWD, event.session_id));
					metacoderAdditionalContext = outcome.overlay.system_prompt_addendum;
					log(
						`Metacoder: ${outcome.overlay.rules.length} overlay rule(s) for ${event.session_id}`,
					);
				} else {
					// Replace semantics (plan §1.1): a non-ok outcome on prompt B
					// must clear prompt A's overlay, otherwise prompt A's rules
					// keep blocking prompt B's tool calls until SessionEnd.
					// Covers skipped (empty_overlay / no_api_key / disabled) and
					// failed (timeout / malformed JSON / etc.) uniformly.
					sessionRules.delete(event.session_id);
					evictOverlayForSession({ cwd: CWD, sessionId: event.session_id });
					if (outcome.kind === "failed") {
						log(`Metacoder failed (non-fatal): ${outcome.reason}`);
					}
				}
			}

			return {
				decision: "allow",
				redacted_prompt: redactedPrompt,
				additional_context: metacoderAdditionalContext,
			};
		}
		case "SubagentStart":
			cohort.subagentJoined(event);
			log(`Subagent joined: ${event.agent_name || "unnamed"}`);
			break;
		case "SubagentStop":
			cohort.subagentLeft(event);
			log(`Subagent left: ${event.agent_name || "unnamed"}`);
			break;
		case "SkillEnter": {
			const name = (event.tool_input?.name as string | undefined)?.trim();
			if (!name) {
				return { decision: "allow", warnings: ["SkillEnter: missing tool_input.name"] };
			}
			const ttl = event.tool_input?.ttl_seconds as number | undefined;
			const sourceRaw = event.tool_input?.source as string | undefined;
			const source: "cli" | "hook" | "manual" =
				sourceRaw === "hook" || sourceRaw === "manual" ? sourceRaw : "cli";
			const targetSessions = event.session_id
				? [session]
				: sessions.getAll();
			let count = 0;
			for (const target of targetSessions) {
				recordSkillEnter(target, { name, ttl_seconds: ttl, source });
				count++;
			}
			log(`SkillEnter: ${name} (${source}, ${count} session${count === 1 ? "" : "s"})`);
			return { decision: "allow" };
		}
		case "SkillLeave": {
			const name = (event.tool_input?.name as string | undefined)?.trim();
			if (!name) {
				return { decision: "allow", warnings: ["SkillLeave: missing tool_input.name"] };
			}
			const targetSessions = event.session_id
				? [session]
				: sessions.getAll();
			let removed = 0;
			for (const target of targetSessions) {
				if (recordSkillLeave(target, name)) removed++;
			}
			log(`SkillLeave: ${name} (removed from ${removed} session${removed === 1 ? "" : "s"})`);
			return { decision: "allow" };
		}
		case "SkillList": {
			// `additional_context` is the only string-typed escape hatch on
			// HarnessDecision; the CLI parses it as JSON. Acceptable because
			// the caller is `interlinked skill list`, not an agent hook.
			const targetSessions = event.session_id ? [session] : sessions.getAll();
			const collected = targetSessions.map((target) => ({
				session_id: target.session_id,
				agent_name: target.agent_name,
				skills: getActiveSkills(target),
			}));
			return {
				decision: "allow",
				additional_context: JSON.stringify(collected),
			};
		}
		default:
			cohort.recordActivity(event);
			break;
	}

	// Evaluate based on hook type
	if (isPreToolUse(event)) {
		// Resolve graph for the file being edited (supports cross-repo edits)
		const filePath =
			(event.tool_input?.file_path as string) || (event.tool_input?.path as string) || "";
		const activeGraph = getGraphForFile(filePath || CWD);

		// `sharedConfig` carries Phase D.2 trajectory feature flags
		// (`harness.trajectory.tool_loop`, etc.). Without passing it through,
		// `isFeatureEnabled` falls back to the defaults map (every flag false)
		// and the trajectory detector silently no-ops even after the user
		// explicitly enables it in `.interlinked/config.json`. Reading per
		// event is cheap (small JSON, fs cache) and matches what the hook
		// script does for mode resolution.
		const preDecision = evaluatePreToolUse(
			event,
			rulesForSession(event.session_id),
			session,
			reservations,
			cohort,
			activeGraph,
			sessions,
			routeMap,
			errorHistory,
			readSharedConfig(CWD),
		);

		// --- LLM Policy Classifier: escalation check (shadow mode) ---
		// Only runs when: decision is "allow", escalation criteria matched, classifier enabled.
		const classifierConfig = rules.policy_classifier;
		if (
			preDecision.decision === "allow" &&
			preDecision._escalation &&
			classifierConfig?.enabled
		) {
			const classifierStart = Date.now();
			try {
				// Get or create per-session classifier state
				let classifierState = classifierSessions.get(event.session_id);
				if (!classifierState) {
					classifierState = createClassifierSessionState();
					classifierSessions.set(event.session_id, classifierState);
				}

				const evidence = buildEvidenceEnvelope(event, session, preDecision._escalation);
				const classification = await callClassifier(
					evidence,
					classifierConfig,
					classifierState,
				);

				const latencyMs = Date.now() - classifierStart;
				const wouldHaveChanged =
					classification.label === "deny" &&
					classification.confidence >= (classifierConfig.confidence_threshold || 0.8);

				// Shadow log
				appendShadowLog(
					{
						ts: new Date().toISOString(),
						session_id: event.session_id,
						agent_name: event.agent_name || session.agent_name,
						trigger: preDecision._escalation.trigger,
						tool_name: event.tool_name || "",
						action_class: evidence.action_class,
						local_decision: "allow",
						classification,
						would_have_changed: wouldHaveChanged,
						latency_ms: latencyMs,
						evidence_hash: hashEvidence(evidence),
					},
					CWD,
				);

				// Shadow mode: inject warning but never change decision
				if (classifierConfig.mode === "shadow") {
					const warnings = preDecision.warnings || [];
					warnings.push(
						`[interlinked:policy] Shadow: ${classification.label} (${classification.confidence.toFixed(2)}) — ${classification.reasoning}`,
					);
					preDecision.warnings = warnings;
				}
				// Enforce mode will promote the shadow-only classifier result into
				// a blocking decision once that path is wired up.

				writeClassifierStatus(
					`${classifierConfig.provider}:${classifierConfig.model}:ok:${latencyMs}ms`,
				);
				log(
					`Policy classifier: ${classification.label} (${classification.confidence.toFixed(2)}) for ${preDecision._escalation.trigger} — ${latencyMs}ms`,
				);
			} catch (classifierErr) {
				// Fail-open: classifier errors never block the tool call
				writeClassifierStatus(
					`${classifierConfig.provider}:${classifierConfig.model}:error`,
				);
				log(
					`Policy classifier error (fail-open): ${classifierErr instanceof Error ? classifierErr.message : String(classifierErr)}`,
				);
			}
		}

		// --- Content Scanner: WebFetch proxy (3-way human review) ---
		// PostToolUse `block` cannot substitute the agent's view of `tool_response`,
		// so for WebFetch we intercept at PreToolUse: harness performs the fetch
		// itself, scans the body, and either passes it through (no findings),
		// stashes a review file (findings present), or honours a prior user
		// decision (allow / redact / block) via block-and-answer. See
		// `web-fetch-proxy.ts` for the flow.
		const isWebFetchTool =
			event.tool_name === "WebFetch" || event.tool_name === "web_fetch";
		if (
			preDecision.decision === "allow" &&
			isWebFetchTool &&
			contentScanner &&
			rules.content_scanner?.enabled &&
			rules.content_scanner.scan_points.external_egress
		) {
			const url = (event.tool_input?.url as string) || "";
			const promptField = (event.tool_input?.prompt as string) || "";
			if (url) {
				const proxyResult = await fetchAndScan({
					cwd: CWD,
					url,
					prompt: promptField,
					scanner: contentScanner,
					compiledAllowlist,
					config: rules.content_scanner,
					toolName: event.tool_name ?? "WebFetch",
				});
				log(
					`Content scanner: WebFetch proxy → ${proxyResult.kind}` +
						(proxyResult.kind === "review_pending"
							? ` (${proxyResult.findingCount} finding(s))`
							: ""),
				);
				if (proxyResult.kind === "passthrough") {
					return {
						decision: "block",
						reason: proxyResult.body,
						warnings: preDecision.warnings,
					};
				}
				if (proxyResult.kind === "review_pending") {
					writeReviewPendingMarker(countPendingReviews(CWD));
					return {
						decision: "block",
						reason:
							"Privacy filter flagged this WebFetch response. The body is " +
							`stashed locally for review (${proxyResult.findingCount} finding(s)).\n` +
							"Run `interlinked scanner review` in another terminal to choose " +
							"Allow / Redact / Block, then re-invoke the same WebFetch.",
						warnings: preDecision.warnings,
					};
				}
				if (proxyResult.kind === "decision_resolved") {
					writeReviewPendingMarker(countPendingReviews(CWD));
					return {
						decision: "block",
						reason: proxyResult.body,
						warnings: preDecision.warnings,
					};
				}
				// proxyResult.kind === "fail_open" — fall through to the regular
				// flow so existing rules still apply. The agent's WebFetch will
				// run normally; PII in the response is then handled by the
				// post-scan path's taint ratchet.
				log(`Content scanner: WebFetch proxy fail_open — ${proxyResult.detail}`);
			}
		}

		// --- Content Scanner: run ML PII detection on the scan request (if present) ---
		// Runs when the evaluator attached a _contentScan bundle AND the scanner is
		// enabled. Iterates per-part (Write.content, Bash.command, etc.), aggregates
		// findings, and blocks the tool call if any survive the min_score floor.
		// Fail-open on any error (network, spawn, timeout).
		if (
			preDecision.decision === "allow" &&
			preDecision._contentScan &&
			contentScanner &&
			rules.content_scanner?.enabled
		) {
			const scanReq = preDecision._contentScan;
			const maxBytes = rules.content_scanner.max_scan_bytes || 100_000;
			const timeoutMs = rules.content_scanner.local?.scan_timeout_ms || 1500;
			const findings: ScanFinding[] = [];
			for (const part of scanReq.parts) {
				try {
					const partFindings = await contentScanner.scan({
						text: part.text.slice(0, maxBytes),
						source: part.source,
						signal: AbortSignal.timeout(timeoutMs),
					});
					findings.push(...partFindings);
				} catch (scanErr) {
					log(
						`Content scanner scan failed (fail-open): ${scanErr instanceof Error ? scanErr.message : String(scanErr)}`,
					);
				}
			}
			// Allowlist pass — drop known false positives (noreply@*, snake_case
			// identifiers misread as private_person, RFC test domains, etc.)
			// before the policy decides. Suppressed entries don't reach the
			// permission UI, the systemMessage, or the pending-prompt file.
			const allowlistResult = applyAllowlist(findings, compiledAllowlist);
			const keptFindings = allowlistResult.kept;
			if (allowlistResult.suppressed.length > 0) {
				log(
					`Content scanner: allowlist suppressed ${allowlistResult.suppressed.length} finding(s)`,
				);
			}
			const verdict = decideFromFindings(keptFindings, rules.content_scanner);
			log(
				`Content scanner: ${event.tool_name} (${scanReq.hook}) — ${scanReq.parts.length} part(s), ${findings.length} finding(s) (${keptFindings.length} after allowlist), decision=${verdict.decision}`,
			);
			if (verdict.decision === "ask") {
				// Hand off to Claude Code's built-in confirmation UI via the "ask"
				// decision. Reason has three parts:
				//   (1) category summary from decideFromFindings  — agent-safe
				//   (2) per-source preview with PII → <CATEGORY>   — agent-safe
				//   (3) pointer to a LOCAL-ONLY file with the full unmasked content
				//       — user opens from another terminal; never sent to Anthropic.
				// Group only the SURVIVORS for the pending-prompt + ask-reason —
				// allowlist-suppressed findings are FPs the operator already
				// declared safe, so we mustn't echo them back through the UI.
				const findingsBySource = new Map<string, ScanFinding[]>();
				for (const f of keptFindings) {
					const bucket = findingsBySource.get(f.source) ?? [];
					bucket.push(f);
					findingsBySource.set(f.source, bucket);
				}
				const pendingPromptPath = writePendingPrompt({
					cwd: CWD,
					request: scanReq,
					findingsBySource,
					toolName: event.tool_name ?? "unknown",
				});
				preDecision.decision = "ask";
				const askOutputs = buildAskReason({
					policySummary: verdict.reason ?? "privacy-filter detected sensitive content.",
					request: scanReq,
					findingsBySource,
					pendingPromptPath,
				});
				preDecision.reason = askOutputs.reason;
				// Raw flagged values are surfaced here only — Claude Code's
				// `systemMessage` is shown to the user but NOT included in the
				// model's context window (hooks reference). This is the sole
				// agent-safe channel for raw PII.
				if (askOutputs.systemMessage) preDecision.system_message = askOutputs.systemMessage;
			}
		}

		// Clean up _escalation and _contentScan from the decision before returning to hook script
		// (internal fields, not part of the hook protocol)
		delete preDecision._escalation;
		delete preDecision._contentScan;

		// --- Auto-coordination: periodic read-only check-in with MCP server ---
		const eventToolName = event.tool_name || "";
		if (
			preDecision.decision === "allow" &&
			session &&
			serverBridge &&
			shouldCoordinate(
				session,
				getAutoCoordState(event.session_id),
				autoCoordConfig,
				eventToolName,
			)
		) {
			const coordState = getAutoCoordState(event.session_id);
			try {
				const coordResponse = await serverBridge.fetchCoordinationState(
					event.agent_name || session.agent_name,
					session,
					autoCoordConfig.timeout_ms,
				);
				if (coordResponse) {
					injectCoordinationWarnings(preDecision, coordResponse);
					session.last_coordination_at = session.tool_call_count;
					session.last_coordination_ts = Date.now();
					coordState.consecutiveMisses = 0;
					coordState.totalCheckins++;
					log(
						`Auto-coordination: ${coordResponse.unread.total} unread, ${coordResponse.task_changes.length} task changes`,
					);
				} else {
					coordState.consecutiveMisses++;
					if (coordState.consecutiveMisses >= autoCoordConfig.max_misses_before_disable) {
						coordState.disabled = true;
						log("Auto-coordination: disabled after consecutive misses");
					}
				}
			} catch {
				coordState.consecutiveMisses++;
			}
		}

		// Inject any pending findings from background async analysis
		if (filePath) {
			const asyncFindings = asyncAnalysis.consume(filePath);
			if (asyncFindings.length > 0) {
				const warnings = preDecision.warnings || [];
				for (const f of asyncFindings) {
					warnings.push(`[interlinked:async] ${f.name}: ${f.message}`);
				}
				preDecision.warnings = warnings;
				log(`Injected ${asyncFindings.length} async finding(s) for ${filePath}`);
			}
		}

		// Cross-session learned rules: observe allowed patterns
		if (preDecision.decision === "allow" && event.tool_name) {
			const pat = extractPermissionPattern(event.tool_name, event.tool_input || {});
			if (pat && !learnedRules.has(pat)) {
				const learned = learnedRules.observe(pat, event.session_id);
				if (learned) {
					const warnings = preDecision.warnings || [];
					warnings.push(
						`[interlinked:learned] Pattern "${pat}" observed ${learned.observation_count} times across sessions — saved as learned rule.`,
					);
					preDecision.warnings = warnings;
					log(`Learned rule: ${pat}`);
				}
			}
		}

		// Report blocks/warns to server for team visibility
		if (serverBridge && preDecision.decision === "block") {
			serverBridge.reportGuardEvent({
				agent_name: event.agent_name || session.agent_name,
				event_type: "guard_block",
				tool_name: event.tool_name,
				tool_input_summary: summarizeToolInput(event),
				decision: "block",
				reason: preDecision.reason || "Blocked by guard rule",
				occurred_at: event.timestamp,
			});
		}

		// --- TDD commit gate: check for unresolved test failures before git commit ---
		if (
			preDecision.decision === "allow" &&
			session &&
			event.tool_name === "Bash" &&
			/\bgit\s+commit\b/.test((event.tool_input?.command as string) || "")
		) {
			const testFirstMode = rules.structural_checks?.test_first_mode || "warn";
			const commitMessage = parseCommitMessageFromBash(
				(event.tool_input?.command as string) || "",
			);
			const gateResults = [
				...(session.tdd_cycles.size > 0 ? checkTddCommitGate(session, testFirstMode) : []),
				...checkProdDeltaWithoutTestDelta(session),
				...checkProdTestLocRatio(session),
				...checkTppLeapfrog(session),
				// Batch 3: diff-aware commit gates.
				...checkDisabledTestDelta(session),
				...checkTestBlockCountRegression(session),
				...checkAssertionStrengthWeakening(session),
				...checkClockMockAdded(session),
				...checkConventionalCommitCoherence(session, commitMessage),
				// Batch 4: trajectory commit gates.
				...checkReintroducesRemovedCode(session),
				...checkDoneWithoutVerify(session),
			];
			if (gateResults.length > 0) {
				const warnings = preDecision.warnings || [];
				for (const r of gateResults) {
					warnings.push(`[interlinked:${r.name}] ${r.message}`);
				}
				preDecision.warnings = warnings;

				if (
					testFirstMode === "enforce" &&
					gateResults.some((r) => r.severity === "error")
				) {
					preDecision.decision = "block";
					preDecision.reason =
						"BLOCKED: Tests must pass before committing. " +
						gateResults
							.filter((r) => r.severity === "error")
							.map((r) => r.message)
							.join(" ");
				}
			}
		}

		// --- Project-wide typecheck gate (commit + push) ---
		// Diff-UNaware. Asserts the WHOLE project typechecks before
		// allowing `git commit` or `git push`. Catches the failure
		// mode where an agent edits file A, doesn't touch file B, and
		// CI fails because B was already broken. Per-edit checks are
		// diff-aware and won't surface that. This gate must.
		// Bypass via INTERLINKED_SKIP_PROJECT_TYPECHECK=1 (audited).
		if (preDecision.decision === "allow" && event.tool_name === "Bash") {
			const cmdStr = (event.tool_input?.command as string) || "";
			const isCommit = /\bgit\s+commit\b/.test(cmdStr);
			const isPush = /\bgit\s+push\b/.test(cmdStr);
			if (isCommit || isPush) {
				const tcResults = checkProjectTypecheckClean(CWD);
				const tcWarnings = tcResults.filter((r) => r.severity === "warning");
				const tcErrors = tcResults.filter((r) => r.severity === "error");
				if (tcWarnings.length > 0) {
					const warnings = preDecision.warnings || [];
					for (const w of tcWarnings) {
						warnings.push(`[interlinked:${w.name}] ${w.message}`);
					}
					preDecision.warnings = warnings;
				}
				if (tcErrors.length > 0) {
					preDecision.decision = "block";
					const action = isCommit ? "commit" : "push";
					const errLines = tcErrors
						.slice(0, 10)
						.map((e) => `  - ${e.message}`)
						.join("\n");
					const tail =
						tcErrors.length > 10 ? `\n  ... and ${tcErrors.length - 10} more` : "";
					preDecision.reason =
						`BLOCKED: Project typecheck failed (${tcErrors.length} error${tcErrors.length === 1 ? "" : "s"}) — CI will fail on this ${action}. ` +
						"Pre-existing errors in untouched files DO count: every commit must build clean. Fix these first:\n" +
						errLines +
						tail +
						"\n\nTo bypass (NOT RECOMMENDED — CI will still fail on the PR): " +
						"INTERLINKED_SKIP_PROJECT_TYPECHECK=1 git ...";
					if (serverBridge) {
						serverBridge.reportGuardEvent({
							agent_name: event.agent_name || session?.agent_name || "",
							event_type: "guard_block",
							tool_name: event.tool_name,
							tool_input_summary: summarizeToolInput(event),
							decision: "block",
							reason: `project_typecheck_clean: ${tcErrors.length} error${tcErrors.length === 1 ? "" : "s"}`,
							occurred_at: event.timestamp,
						});
					}
				}

				// Push-only second tier: full test suite. Typecheck-clean
				// is necessary but not sufficient — the codex-flag commit
				// + 139-repo audit wave were both tsc-clean but had stale
				// test assertions that turned CI red. Tests are slow
				// (~40s on this repo), so we only run them on PUSH, not
				// on every commit. Bypass: INTERLINKED_SKIP_PROJECT_TESTS=1.
				if (preDecision.decision === "allow" && isPush) {
					const testResults = checkProjectTestsClean(CWD);
					const testWarnings = testResults.filter((r) => r.severity === "warning");
					const testErrors = testResults.filter((r) => r.severity === "error");
					if (testWarnings.length > 0) {
						const warnings = preDecision.warnings || [];
						for (const w of testWarnings) {
							warnings.push(`[interlinked:${w.name}] ${w.message}`);
						}
						preDecision.warnings = warnings;
					}
					if (testErrors.length > 0) {
						preDecision.decision = "block";
						const failLines = testErrors
							.slice(0, 10)
							.map((e) => `  - ${e.message}`)
							.join("\n");
						const tail =
							testErrors.length > 10
								? `\n  ... and ${testErrors.length - 10} more`
								: "";
						preDecision.reason =
							`BLOCKED: Project tests failed (${testErrors.length} failure${testErrors.length === 1 ? "" : "s"}) — CI will fail on this push. ` +
							"Pre-existing test failures DO count: every push must build clean. Failing tests:\n" +
							failLines +
							tail +
							"\n\nTo bypass (NOT RECOMMENDED — CI will still fail on the PR): " +
							"INTERLINKED_SKIP_PROJECT_TESTS=1 git push ...";
						if (serverBridge) {
							serverBridge.reportGuardEvent({
								agent_name: event.agent_name || session?.agent_name || "",
								event_type: "guard_block",
								tool_name: event.tool_name,
								tool_input_summary: summarizeToolInput(event),
								decision: "block",
								reason: `project_tests_clean: ${testErrors.length} failure${testErrors.length === 1 ? "" : "s"}`,
								occurred_at: event.timestamp,
							});
						}
					}
				}
			}
		}

		// --- Grep acceleration: intercept search tools via trigram index ---
		// Substitution path (block-and-answer) is DISABLED by default. Reason:
		//   - Bypasses the content scanner — substituted output reaches the
		//     model via permissionDecisionReason, an envelope the OPF scanner
		//     and checks/pii.ts weren't designed to inspect.
		//   - Index can be stale: incrementalUpdate uses `git diff baseCommit
		//     ..HEAD`, refresh fires on SessionStart only, external file edits
		//     are invisible until next session.
		//   - Partially-formed hookSpecificOutput envelopes have hit Claude
		//     Code's "(root): Invalid input" validator failure (fail-closed
		//     on a safety boundary, contradicts feedback_safety_continuity).
		// The trigram index itself stays loaded and is still consumed by
		// impact analysis, project graph, and structural checks.
		// Re-enable: set INTERLINKED_GREP_ACCELERATOR=1 OR set
		// guard-rules.json `grep_acceleration.substitution_enabled: true`.
		const isSearchTool =
			event.tool_name === "Grep" ||
			(event.tool_name === "Bash" &&
				/\b(rg|ripgrep|grep|egrep)\s/.test((event.tool_input?.command as string) || ""));

		const grepSubstitutionEnabled =
			process.env.INTERLINKED_GREP_ACCELERATOR === "1" ||
			(process.env.INTERLINKED_GREP_ACCELERATOR !== "0" &&
				rules.grep_acceleration?.substitution_enabled === true);

		if (
			preDecision.decision === "allow" &&
			trigramIndex &&
			isSearchTool &&
			grepSubstitutionEnabled
		) {
			const grepDecision = checkGrepAcceleration(event, trigramIndex, {}, fileContentCache);
			if (grepDecision) {
				log(`Grep accelerated: ${event.tool_name} → ${grepDecision.decision}`);
				// Merge any warnings from the guard evaluation
				if (preDecision.warnings?.length) {
					grepDecision.warnings = [
						...(preDecision.warnings || []),
						...(grepDecision.warnings || []),
					];
				}
				return grepDecision;
			}
		}

		// For search tools that weren't accelerated, add index status as a warning.
		// Once-per-session dedup: this fired on every search call before, training
		// agents to ignore it. The status doesn't change mid-session (trigramIndex
		// is loaded once at startup), so re-emitting buys nothing.
		const indexWarnKey = event.session_id || "anonymous";
		if (
			isSearchTool &&
			preDecision.decision === "allow" &&
			!indexWarningSent.has(indexWarnKey)
		) {
			const warnings = preDecision.warnings || [];
			let emitted = false;
			if (!trigramIndex) {
				warnings.push(
					"[interlinked:index] No search index. Run `interlinked index build` to enable grep acceleration.",
				);
				emitted = true;
			} else if (!findRipgrep()) {
				warnings.push(
					"[interlinked:index] Index loaded but ripgrep not installed — grep acceleration disabled. Install: brew install ripgrep",
				);
				emitted = true;
			} else {
				// Index + rg both available. Check freshness by comparing base commit to HEAD.
				try {
					const head = execSync("git rev-parse HEAD", {
						cwd: CWD,
						encoding: "utf-8",
						timeout: 2000,
					}).trim();
					if (head && trigramIndex.baseCommit && head !== trigramIndex.baseCommit) {
						const behindCount = execSync(
							`git rev-list --count ${trigramIndex.baseCommit.slice(0, 8)}..HEAD`,
							{ cwd: CWD, encoding: "utf-8", timeout: 2000 },
						).trim();
						warnings.push(
							`[interlinked:index] Search index is ${behindCount} commit(s) behind HEAD. Run \`interlinked index build\` to refresh.`,
						);
						emitted = true;
					}
				} catch (e) {
					void e;
				}
			}
			// Mark sent regardless of whether we emitted — clean state need not re-check.
			indexWarningSent.add(indexWarnKey);
			if (emitted) {
				preDecision.warnings = warnings;
			}
		}

		// --- tsgo acceleration: rewrite tsc → tsgo when available ---
		if (preDecision.decision === "allow" && isBashTsc(event)) {
			const tsgoResult = tryTsgoRewrite(event, CWD, log);
			if (tsgoResult) return tsgoResult;
			// tsgo not available — let tsc through but note it in warnings
			const warnings = preDecision.warnings || [];
			warnings.push(
				"[interlinked:tsc] Using tsc (tsgo not available — install @typescript/native-preview for ~10x faster type checking)",
			);
			preDecision.warnings = warnings;
		}

		// --- Diff-aware: capture pre-edit baseline for file write tools ---
		if (rules.diff_aware?.enabled !== false && filePath) {
			const toolName = event.tool_name || "";
			const isFileWrite = [
				"Write",
				"Edit",
				"Update",
				"WriteFile",
				"EditFile",
				"write_file",
				"edit_file",
			].includes(toolName);

			if (isFileWrite && existsSync(filePath)) {
				try {
					const preContent = readFileSync(filePath, "utf-8");
					const missingRT = checkMissingReturnTypes(preContent, filePath);
					const complexFns = checkFunctionComplexity(preContent, filePath);
					// CRAP baseline — fail-open when coverage data is absent.
					let crapScores: Map<string, Map<string, number>> | undefined;
					try {
						const coveragePath = resolve(CWD, "coverage", "coverage-final.json");
						const covCache = loadCoverageFinal(coveragePath, CWD);
						if (covCache) {
							const relPath = relative(CWD, filePath).replace(/\\/g, "/");
							const perFile = coverageForFile(covCache, relPath);
							const mtimeMs = statSync(filePath).mtimeMs;
							crapScores = snapshotCrap({
								preContent,
								filePath: relPath,
								coverage: perFile,
								fileMtime: mtimeMs,
								threshold: 30,
							});
						}
					} catch (crapErr) {
						void crapErr; /* CRAP snapshot must never break the baseline capture */
					}
					preEditBaselines.set(filePath, {
						missingReturnTypes: new Set(missingRT.map((m) => m.text)),
						complexFunctions: new Set(complexFns.map((m) => m.text)),
						crapScores,
						capturedAt: Date.now(),
						suppressionCount: countSuppressionDirectives(preContent),
						asAnyCastCount: countAsAnyCasts(preContent),
						nonNullAssertionCount: countNonNullAssertions(preContent),
						todoMarkerCount: countTodoMarkers(preContent),
						consoleStatementCount: countConsoleStatements(preContent),
						publicApiSurfaceCount: countPublicApiSurface(preContent),
						typeDensity: countTypeDensity(preContent),
						softwareVersions: collectSoftwareVersionReferences(preContent, filePath),
						discoveredPrimitiveViolations: captureDiscoveredPrimitiveViolations(
							CWD,
							preContent,
						),
					});
				} catch (e) {
					void e;
				}
			}
		}

		// --- Structure context injection (non-blocking) ---
		if (
			filePath &&
			[
				"Write",
				"Edit",
				"Update",
				"WriteFile",
				"EditFile",
				"write_file",
				"edit_file",
			].includes(event.tool_name || "")
		) {
			try {
				const structRepoRoot = findProjectRoot(filePath, CWD) || CWD;
				const { config } = loadStructureConfig(structRepoRoot);
				if (config && session) {
					// Check for unresolved structure follow-ups in session
					const unresolvedStructure: string[] = [];
					for (const [key, completion] of session.pending_completions) {
						if (!key.startsWith("struct:")) continue;
						const remaining = completion.affected_files.filter(
							(f) => !completion.resolved_files.has(f),
						);
						if (remaining.length > 0) {
							unresolvedStructure.push(
								`${completion.description}: ${remaining.join(", ")}`,
							);
						}
					}
					if (unresolvedStructure.length > 0) {
						const warnings = preDecision.warnings || [];
						warnings.push(
							`[interlinked:structure] Unresolved companion follow-ups from previous edits:\n${unresolvedStructure.map((u) => `  - ${u}`).join("\n")}`,
						);
						preDecision.warnings = warnings;
					}
				}
			} catch (e) {
				void e;
			}
		}

		return preDecision;
	}

	if (isPostToolUse(event)) {
		// --- Phase B.2: skip_paths short-circuit ---
		// Daemon-side mirror of the hook-side `skip-paths` chunk. The hook
		// reads `.interlinked/config.json#skip_paths` and exits early on
		// excluded paths, but on installs that rely on DEFAULT_CONFIG (no
		// shared file written) the hook's list is empty and the event still
		// reaches the daemon. Without this check the daemon then runs the
		// full structural / quality pipeline on `dist/**`, `node_modules/**`,
		// generated files, etc. Consult the merged `rules.skip_paths` here so
		// the configured globs short-circuit regardless of install path.
		const editedFilePathRaw =
			(event.tool_input?.file_path as string) ||
			(event.tool_input?.path as string) ||
			"";
		if (editedFilePathRaw && shouldSkipPath(editedFilePathRaw, rules)) {
			return {
				decision: "allow",
				summary: `skip_paths matched (${editedFilePathRaw}) — post-event pipeline skipped`,
			};
		}

		// --- Dirty layer: track file edits for trigram index freshness ---
		if (trigramIndex) {
			const editedPath = (event.tool_input?.file_path as string) || "";
			const toolName = event.tool_name || "";
			const isFileWrite = [
				"Write",
				"Edit",
				"Update",
				"WriteFile",
				"EditFile",
				"write_file",
				"edit_file",
				"NotebookEdit",
			].includes(toolName);

			if (isFileWrite && editedPath) {
				try {
					const absPath = editedPath.startsWith("/") ? editedPath : join(CWD, editedPath);
					const relPath = relative(CWD, absPath);
					if (existsSync(absPath) && !relPath.startsWith("..")) {
						const content = readFileSync(absPath, "utf-8");
						trigramIndex.updateFile(relPath, content);
						fileContentCache.set(relPath, content);
						log(`Trigram index dirty update: ${relPath}`);
					}
				} catch (e) {
					void e;
				}
			}
		}

		// --- Test run tracking: detect test runner commands and record pass/fail ---
		if (session) {
			const cmd = (event.tool_input?.command as string) || "";
			const testRunFile = detectTestRunFile(cmd, CWD);
			if (testRunFile) {
				const passed = event.hook_event !== "PostToolUseFailure";
				session.test_runs.set(testRunFile, {
					status: passed ? "pass" : "fail",
					at_step: session.tool_call_count,
				});
				// Update TDD cycle state from test result
				recordTestRunCycle(session, testRunFile, passed);
			}
		}

		const postDecision = evaluatePostToolUse(event, rules, session, reservations, cohort);

		// --- Phase 1 Failure-Recovery Channels (Channels 1, 2, 3, 5, 6) ---
		// Gated on the canonical `tool_outcome === "error"` from the wire-format
		// extension. Both delivery shapes converge here — folded failures
		// (Claude/Codex/Gemini/Copilot deliver tool failures on the regular
		// PostToolUse / AfterTool / postToolUse) and the dedicated
		// PostToolUseFailure (Cursor's postToolUseFailure event) — because
		// the per-provider normalizers in event-normalizers.ts populate
		// tool_outcome consistently. Output flows into postDecision.warnings,
		// which the .mjs surfaces via formatProviderResponse's reason/summary
		// channels per existing wiring.
		if (event.tool_outcome === "error") {
			try {
				const channelsOutput = runFailureChannels({ event, session, cwd: CWD });
				if (channelsOutput && channelsOutput.warnings.length > 0) {
					if (!postDecision.warnings) postDecision.warnings = [];
					postDecision.warnings.push(...channelsOutput.warnings);
				}
			} catch (e) {
				// Fail-open: a channel-orchestrator crash must not abort the
				// PostToolUse hook response. The local quality pipeline above
				// stays authoritative; the recovery channel just becomes
				// silent for this event.
				log(`Failure-recovery channels error: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		// --- Content Scanner: scan Read/Grep results, ratchet session sensitivity on PII ---
		// Never blocks (we're already past the read), but raises `session.sensitivity_level`
		// so downstream PreToolUse taint rules (no network after taint, etc.) fire.
		if (contentScanner && rules.content_scanner?.enabled) {
			const postScanResult = await runPostToolScan({
				event,
				session,
				rules,
				scanner: contentScanner,
				compiledAllowlist,
			});
			if (postScanResult.warnings.length > 0) {
				if (!postDecision.warnings) postDecision.warnings = [];
				postDecision.warnings.push(...postScanResult.warnings);
			}
		}

		const postStartMs = Date.now();
		const checksRan: string[] = [];
		const allCheckResults: import("./types.js").CheckResultEntry[] = [];
		// Phase A.7: per-subprocess-tool breakdown — quality-checks pushes one
		// entry per `engine.runChecksAsync` invocation (one per tool). The
		// daemon forwards this into latency.jsonl so the latency CLI can show
		// per-tool p50/p99.
		const postToolMetrics: import("./quality-checks.js").ToolBreakdownEntry[] = [];

		// Per-phase wall-clock breakdown. Lets us see which phase of the
		// PostToolUse handler is responsible for the residual ms not
		// attributed to a subprocess tool. `markPhase(name)` records the
		// delta from the previous mark; the closing `closePhase()` captures
		// anything between the last mark and end-of-handler.
		const phaseBreakdown: Record<string, number> = {};
		let phaseCursor = postStartMs;
		const markPhase = (name: string): void => {
			const now = Date.now();
			phaseBreakdown[name] = (phaseBreakdown[name] ?? 0) + (now - phaseCursor);
			phaseCursor = now;
		};

		// --- Tool-response checks (run for ALL PostToolUse events, not just file edits) ---
		// These inspect tool_response payloads, so they apply equally to MCP tools,
		// Bash JSON output, and any other tool that returns structured data.
		// (Phase mark for diagnostic instrumentation — captures time spent in
		// the bookkeeping between handler entry and tool-response checks.)
		markPhase("pre_tool_response");
		if (session && event.tool_name) {
			const toolName = event.tool_name;

			// Silent-failure lint: tool returned 200/success but body signals error.
			if (!session.silent_failure_warned.has(toolName)) {
				const silentHit = checkSilentFailure(event.tool_response);
				if (silentHit) {
					if (!postDecision.warnings) postDecision.warnings = [];
					postDecision.warnings.push(formatSilentFailureWarning(toolName, silentHit));
					session.silent_failure_warned.add(toolName);
					checksRan.push("silent-failure");
				}
			}

			// Context-bloat warning: tool_response exceeds ~8K-token budget.
			if (!session.bloat_warned.has(toolName)) {
				const bloatHit = checkContextBloat(event.tool_response);
				if (bloatHit) {
					if (!postDecision.warnings) postDecision.warnings = [];
					postDecision.warnings.push(formatBloatWarning(toolName, bloatHit));
					session.bloat_warned.add(toolName);
					checksRan.push("context-bloat");
				}
			}

			// Consecutive-error feedback: 3+ same-tool failures in a row.
			// Counter is maintained in session-state.ts (increment on failure, reset on success).
			const failureCount = session.consecutive_tool_failures.get(toolName) || 0;
			const consecutiveMsg = consecutiveFailureWarning(failureCount, toolName);
			if (consecutiveMsg) {
				if (!postDecision.warnings) postDecision.warnings = [];
				postDecision.warnings.push(consecutiveMsg);
				checksRan.push("consecutive-errors");
			}
		}

		// Run quality checks (synchronous, with timeouts per check)
		const isDirectFileEdit =
			event.tool_name &&
			[
				"Write",
				"Edit",
				"Update",
				"WriteFile",
				"EditFile",
				"write_file",
				"edit_file",
				"NotebookEdit",
				// Copilot CLI
				"apply_patch",
				"str_replace",
				"create",
			].includes(event.tool_name);

		// Also detect Bash commands that edit files (sed, awk, tee, etc.)
		// For these, try to extract the target file path from the command.
		let editedFilePath = "";
		// `editedFilePaths` is the full set of files this PostToolUse should
		// fan out across. Codex `apply_patch` payloads can carry multiple
		// `*** Update File:` / `Add File:` / `Delete File:` sections in one
		// call; without iterating, only the first file gets TDD/quality/
		// structural checks and the rest of the patch silently bypasses them.
		let editedFilePaths: string[] = [];
		if (
			!isDirectFileEdit &&
			event.tool_name &&
			["Bash", "Shell", "shell", "run_command"].includes(event.tool_name)
		) {
			const cmd = (event.tool_input?.command as string) || "";
			// Match edited file paths in Bash commands (sed -i, awk >, tee, cat >, etc.)
			// Supports: .ts, .tsx, .js, .jsx, .mjs, .cjs, .py, .pyi, .rs, .go, .java,
			//           .c, .cpp, .cc, .cxx, .h, .hpp, .hxx
			const editedFileMatch = cmd.match(
				/\b([\w./-]+\.(?:tsx?|jsx?|mjs|cjs|py|pyi|rs|go|java|c|cpp|cc|cxx|h|hpp|hxx|rb|php|swift|kt|kts|scala|lua|zig|nim|ex|exs|clj|cljs|ml|mli|hs|lhs|erl|hrl|dart|r|R|jl|v|sv|vhd|vhdl|pro|pl|pm|sh|bash|zsh|fish))\b/,
			);
			if (editedFileMatch) {
				editedFilePath = editedFileMatch[1];
				editedFilePaths = [editedFilePath];
			}
		} else if (isDirectFileEdit) {
			editedFilePaths = extractAllEditedFilePaths(event);
			editedFilePath = editedFilePaths[0] || "";
		}

		const shouldRunChecks =
			isDirectFileEdit || editedFilePath.length > 0 || editedFilePaths.length > 0;
		if (shouldRunChecks) {
			const dataDir = join(CWD, ".interlinked");
			const markerPath = join(dataDir, "quality-check-in-progress");
			const pendingPath = join(dataDir, "pending-quality-warnings.json");

			// Write marker BEFORE running checks so PreToolUse knows to wait.
			const markerResult = tryFn(() => {
				if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
				writeFileSync(markerPath, new Date().toISOString());
			});
			if (isErr(markerResult)) {
				log(
					`Failed to write quality-check marker (non-fatal): ${markerResult.error.message}`,
				);
			}

			// Per-file fan-out: Codex `apply_patch` payloads can carry multiple
			// `*** Update File:` / `Add File:` / `Delete File:` sections in one call.
			// Iterate so quality / structural / TDD / suggestion checks run for every
			// file in the patch, not just the first one. For non-multi events,
			// `editedFilePaths` collapses to a single-element list.
			const pathsToCheck =
				editedFilePaths.length > 0
					? editedFilePaths
					: editedFilePath.length > 0
						? [editedFilePath]
						: [""];
			// Phase mark — everything before this point was tool-response checks
			// (silent-failure, context-bloat) plus paths-to-check setup.
			markPhase("tool_response_checks");
			// Project-wide sweep is once-per-evaluation: a multi-file patch is one
			// edit event semantically, and `runProjectWideChecks` spawns subprocesses
			// we don't want to multiply by file count.
			let projectWideSweepFiredThisEvent = false;
			// Marks the suffix of `allCheckResults` not yet mirrored into the
			// recurrence log. The fan-out body keeps appending across files, so
			// without a cursor each iteration would re-record prior files'
			// findings, inflating recurrence counts and tripping ratchets.
			let recurrenceCursor = 0;
			for (const currentEditedPath of pathsToCheck) {
				editedFilePath = currentEditedPath;
				// For Bash edits, inject the detected file path into a synthetic event
				const checkEvent = editedFilePath
					? { ...event, tool_input: { ...event.tool_input, file_path: editedFilePath } }
					: event;

				// --- Structural checks (fast, sub-100ms, dependency-aware) ---
				let oldExports: ExportedSymbol[] = [];
				let oldInterfaceBodies = new Map<string, string>();
				let exportSurfaceChanged = false;
				const structuralConfig = rules.structural_checks;
				editedFilePath = (checkEvent.tool_input?.file_path as string) || "";

				// --- TDD cycle tracking: record impl edits and test writes ---
				if (session && editedFilePath) {
					if (TEST_FILE_RE.test(editedFilePath)) {
						recordTestWrite(session, editedFilePath);
					} else {
						recordImplEdit(session, editedFilePath);
					}
				}

				// Resolve graph for the edited file's project (supports cross-repo edits)
				const fileGraph = getGraphForFile(editedFilePath || CWD);

				if (structuralConfig?.enabled && fileGraph.isInitialized && editedFilePath) {
					// Capture old state, then update graph with new file content
					oldExports = fileGraph.getExports(editedFilePath);
					oldInterfaceBodies = fileGraph.getInterfaceBodies(editedFilePath);
					fileGraph.updateFile(editedFilePath);

					const rawStructuralResults = runStructuralChecks(
						checkEvent,
						structuralConfig,
						fileGraph,
						sessions,
						oldExports,
						oldInterfaceBodies,
					);
					checksRan.push("structural");

					// --- File-level suppression for structural checks ---
					// Only JSON suppressions apply (inline comments don't make sense
					// for cross-file structural checks).
					const structRelPath = relative(CWD, editedFilePath);
					const structFileSup = loadFileSuppressions(
						join(CWD, ".interlinked"),
						structRelPath,
					);
					const afterSuppression = rawStructuralResults.filter(
						(r) => !structFileSup.has(r.check),
					);

					// --- Session-ack suppression for structural checks ---
					// If the user already saw a warning for this file+check and let
					// the agent continue, skip re-firing warnings (errors always re-fire).
					const structuralResults = afterSuppression.filter(
						(r) =>
							r.severity === "error" || !isAcknowledged(session, editedFilePath, r.check),
					);

					// Collect structured results for local persistence
					for (const r of structuralResults) {
						allCheckResults.push({
							source: "structural",
							name: r.check,
							severity: r.severity,
							message: r.message,
							file: r.file,
							detail: r.detail,
							affected_files: r.affectedFiles,
							determinism: STRUCTURAL_CHECK_META[r.check]?.determinism ?? "heuristic",
						});
					}

					if (structuralResults.length > 0) {
						const structWarnings = formatStructuralWarnings(structuralResults);
						postDecision.warnings = [...(postDecision.warnings || []), ...structWarnings];

						// Block only on fully_deterministic findings with error/warning severity.
						// Heuristic/partial findings (blast_radius, test_proximity, etc.) are advisory only.
						const hasDeterministicActionable = structuralResults.some(
							(r) =>
								(r.severity === "error" || r.severity === "warning") &&
								STRUCTURAL_CHECK_META[r.check]?.determinism === "fully_deterministic",
						);
						if (hasDeterministicActionable) {
							postDecision.decision = "block";
						}

						log(`Structural issues: ${structuralResults.map((r) => r.check).join(", ")}`);

						// Record failed files for recently-failed-here tracking
						const failedChecks = structuralResults
							.filter((r) => r.severity === "error" || r.severity === "warning")
							.map((r) => r.check);
						if (failedChecks.length > 0) {
							session.failed_files.set(editedFilePath, {
								failure_count: failedChecks.length,
								checks: [...new Set(failedChecks)],
								recorded_at: event.timestamp,
								tool_call_count: session.tool_call_count,
							});
						}

						// --- Impact analysis (fast, graph-only, no subprocesses) ---
						if (structuralConfig?.impact_analysis && editedFilePath) {
							const newExportsForImpact = fileGraph.getExports(editedFilePath);
							const impactResult = runImpactAnalysis(
								editedFilePath,
								fileGraph,
								oldExports,
								newExportsForImpact,
								structuralResults,
								{ highThreshold: structuralConfig.impact_high_threshold ?? 4 },
							);

							// Record follow-ups in session state (replaces inline pending_completions)
							recordImpactFollowUps(impactResult, session);

							// Format warnings
							const impactWarnings = formatImpactWarning(impactResult, fileGraph);
							if (impactWarnings.length > 0) {
								postDecision.warnings = [
									...(postDecision.warnings || []),
									...impactWarnings,
								];
							}

							// Critical impact blocks so the agent reads the warning
							if (impactResult.severity === "critical") {
								postDecision.decision = "block";
							}

							log(
								`Impact analysis: ${impactResult.severity} (${impactResult.dependentCount} dependents, ${impactResult.breakingFiles.length} breaking)`,
							);
						} else {
							// Fallback: record pending completions without full impact analysis
							const exportResults = structuralResults.filter(
								(r) =>
									r.check === "export_surface" &&
									r.affectedFiles &&
									r.affectedFiles.length > 0,
							);
							for (const result of exportResults) {
								session.pending_completions.set(editedFilePath, {
									source_file: editedFilePath,
									affected_files: result.affectedFiles!,
									resolved_files: new Set(),
									recorded_at_tool_call: session.tool_call_count,
									description: result.message,
								});
							}
						}
						// Record errors in cross-session error history
						if (rules.error_memory?.enabled) {
							const relPath = fileGraph.toRelative(editedFilePath);
							const fileRole = fileGraph.classifyModule(editedFilePath);
							const currentExports = fileGraph
								.getExports(editedFilePath)
								.map((e) => e.name);
							const dependentCount = fileGraph.getDependents(editedFilePath).length;
							const dependencyCount = fileGraph.getDependencies(editedFilePath).length;

							for (const result of structuralResults) {
								if (result.severity === "error" || result.severity === "warning") {
									const diffContext = ErrorHistory.buildErrorContext({
										file: relPath,
										fileRole,
										dependentCount,
										dependencyCount,
										exports: currentExports,
										result,
										oldString: checkEvent.tool_input?.old_string as
											| string
											| undefined,
										newString: checkEvent.tool_input?.new_string as
											| string
											| undefined,
										content: checkEvent.tool_input?.content as string | undefined,
									});
									// Estimate line number from old_string position
									let lineStart: number | undefined;
									const oldStr = checkEvent.tool_input?.old_string as
										| string
										| undefined;
									if (oldStr) {
										try {
											const content = readFileSync(editedFilePath, "utf-8");
											const idx = content.indexOf(oldStr);
											if (idx >= 0)
												lineStart = content.slice(0, idx).split("\n").length;
										} catch (e) {
											void e;
										}
									}

									await errorHistory.recordError(
										event.session_id,
										session.agent_name,
										relPath,
										fileRole,
										result,
										diffContext,
										{
											line_start: lineStart,
											co_edited_files: [...session.files_written]
												.map((f) => fileGraph.toRelative(f))
												.filter((f) => f !== relPath),
											pre_error_sequence: [...session.tool_sequence],
										},
									);
								}
							}
						}
					} else {
						// No failures — clear any previous failed_files entry for this file
						session.failed_files.delete(editedFilePath);

						// Record fix in error history
						if (rules.error_memory?.enabled) {
							const relPath = fileGraph.toRelative(editedFilePath);
							const fixContext = ErrorHistory.buildQueryContext({
								file: relPath,
								fileRole: fileGraph.classifyModule(editedFilePath),
								dependentCount: fileGraph.getDependents(editedFilePath).length,
								dependencyCount: fileGraph.getDependencies(editedFilePath).length,
								exports: fileGraph.getExports(editedFilePath).map((e) => e.name),
								oldString: checkEvent.tool_input?.old_string as string | undefined,
								newString: checkEvent.tool_input?.new_string as string | undefined,
								content: checkEvent.tool_input?.content as string | undefined,
							});
							errorHistory.recordFix(relPath, fixContext);
						}
					}

					// Check if export surface changed (for smart tsc)
					const newExports = fileGraph.getExports(editedFilePath);
					exportSurfaceChanged = !shouldSkipTsc(structuralConfig, oldExports, newExports);

					// --- Deletion hygiene (Layer 3): orphaned test references ---
					// When exports are removed, check if co-located test files still reference them
					if (session && oldExports.length > 0) {
						const newExportNames = new Set(newExports.map((e) => e.name));
						const removedSymbols = oldExports
							.filter((e) => !newExportNames.has(e.name))
							.map((e) => e.name);

						if (removedSymbols.length > 0) {
							// Resolve co-located test files (same pattern as checkTestFileExists)
							const extMatch = editedFilePath.match(/\.(ts|tsx|js|jsx|mjs|cjs)$/);
							if (extMatch) {
								const base = editedFilePath.slice(0, -extMatch[0].length);
								const testCandidates = [
									`${base}.test${extMatch[0]}`,
									`${base}.spec${extMatch[0]}`,
									join(
										dirname(editedFilePath),
										"__tests__",
										`${basename(base)}.test${extMatch[0]}`,
									),
									join(
										dirname(editedFilePath),
										"__tests__",
										`${basename(base)}.spec${extMatch[0]}`,
									),
								];
								for (const testFile of testCandidates) {
									if (!existsSync(testFile)) continue;
									try {
										const testContent = readFileSync(testFile, "utf-8");
										const wasEdited = session.files_written.has(testFile);
										const orphanFindings = checkOrphanedTests(
											removedSymbols,
											relative(CWD, testFile),
											testContent,
											wasEdited,
										);
										for (const f of orphanFindings) {
											allCheckResults.push({
												source: "suggestion",
												name: f.check,
												severity: "warning",
												message: f.message,
												file: testFile,
												determinism: "heuristic",
											});
										}
										if (orphanFindings.length > 0) {
											postDecision.warnings = [
												...(postDecision.warnings || []),
												...orphanFindings.map(
													(f) => `[deletion-hygiene:${f.check}] ${f.message}`,
												),
											];
										}
									} catch (e) {
										void e;
									}
								}
							}
						}
					}
				} else if (fileGraph.isInitialized && editedFilePath) {
					// Even if structural checks are disabled, keep graph up to date
					fileGraph.updateFile(editedFilePath);
				}

				// Update route map when a file is edited
				if (editedFilePath) {
					routeMap.updateFile(editedFilePath);
				}

				// --- Quality checks (tsc, lint, secrets — slower, subprocess-based) ---
				// Capture baseline suppression count before quality checks consume it
				let previousSuppressionCount = 0;
				if (rules.quality_checks) {
					// Smart tsc: when only internal logic changed (no export surface change),
					// still run tsc but filter output to only the edited file. This catches
					// internal type errors (e.g. TS18046 'unknown' access) without reporting
					// unrelated project-wide errors.
					let qualityOpts: QualityCheckOptions | undefined;
					if (
						structuralConfig?.smart_tsc &&
						!exportSurfaceChanged &&
						editedFilePath &&
						rules.quality_checks.typescript?.enabled
					) {
						const filterFile = relative(
							findProjectRoot(editedFilePath, CWD) || CWD,
							editedFilePath,
						);
						qualityOpts = { tscFilterFile: filterFile };
						log(`Smart tsc: filtering to ${filterFile} (internal-only edit)`);
					}

					const currentBaseline = preEditBaselines.get(editedFilePath);
					previousSuppressionCount = currentBaseline?.suppressionCount ?? 0;
					// Phase mark — everything from the last mark up to here was
					// the structural-checks block (export-surface diff, project
					// graph update, impact analysis, deletion-hygiene).
					markPhase("structural_checks");
					const rawQualityResults = await runQualityChecks(
						checkEvent,
						rules.quality_checks,
						CWD,
						{
							...qualityOpts,
							baseline: currentBaseline,
							diffAware: rules.diff_aware,
							outToolMetrics: postToolMetrics,
							// Mythos Phase 4: recency-weighted check depth.
							// Cold files skip heuristic detectors at PostToolUse.
							filePriority: filePriorityMap,
							// Diagnostic: per-check phase boundary. Each iteration
							// of the inline-check loop fires this with its name,
							// so phase_breakdown carries one entry per check
							// (inline_software_version_regression, inline_strong_typing,
							// …). Lets us pin a residual spike to a single check.
							onCheckBoundary: markPhase,
						},
					);
					// Phase mark — runQualityChecks ran tsc/biome/inline checks.
					// The subprocess time is captured in tool_breakdown; this
					// phase covers their wall time + the inline-check residual.
					markPhase("quality_checks");
					// Clear consumed baseline
					preEditBaselines.delete(editedFilePath);
					// Track which quality checks actually applied to this file type
					for (const [name, check] of Object.entries(rules.quality_checks)) {
						if (
							check.enabled &&
							check.file_types.some((t: string) => editedFilePath.endsWith(t))
						) {
							checksRan.push(name);
						}
					}

					// --- Session-ack suppression for quality checks ---
					// Skip re-firing warnings the user already acknowledged for this file+check.
					// Errors always re-fire regardless of acknowledgment.
					const qualityResults = rawQualityResults.filter(
						(r) =>
							r.severity === "error" || !isAcknowledged(session, editedFilePath, r.name),
					);

					// --- Sibling expansion (PostToolUse fan-out) ---
					// When a finding hits a known type-erasure / boundary pattern, query
					// the trigram index for every other instance and emit one row per
					// sibling. Codex finding-discovery convention "do not collapse
					// separate instances under one candidate" — turns a single edit's
					// `as_any_ratchet` into a worklist covering the whole module.
					const triggerNames = new Set(DEFAULT_TRIGGERS.map((t) => t.triggerName));
					const triggers = qualityResults
						.filter((r) => triggerNames.has(r.name))
						.map((r) => ({ name: r.name, file: r.file ?? editedFilePath }));
					if (trigramIndex && triggers.length > 0) {
						try {
							const siblings = expandSiblings({
								triggers,
								index: trigramIndex,
								reader: {
									read: (relPath: string): string | undefined => {
										try {
											return readFileSync(`${CWD}/${relPath}`, "utf-8");
										} catch (e) {
											void e;
											return undefined;
										}
									},
								},
								cwd: CWD,
							});
							for (const s of siblings) {
								qualityResults.push({
									name: s.siblingRuleId,
									severity: "warning",
									message: s.message,
									file: s.file,
								});
							}
							if (siblings.length > 0) {
								log(
									`Sibling expansion: ${siblings.length} row(s) across ${triggers.length} trigger(s)`,
								);
							}
						} catch (e) {
							// Sibling fan-out is advisory — never fail the post-edit pipeline on it.
							log(`Sibling expansion failed: ${e instanceof Error ? e.message : String(e)}`);
						}
					}

					// Collect quality check results for local persistence
					for (const r of qualityResults) {
						allCheckResults.push({
							source: "quality",
							name: r.name,
							severity: r.severity,
							message: r.message,
							file: r.file,
							detail: r.detail,
							determinism:
								QUALITY_CHECK_META[r.name]?.determinism ??
								GENERIC_CHECK_META[r.name]?.determinism ??
								"fully_deterministic",
						});
					}

					if (qualityResults.length > 0) {
						const warnings = formatQualityWarnings(qualityResults);
						postDecision.warnings = [...(postDecision.warnings || []), ...warnings];

						// Block only on fully_deterministic quality checks with error severity.
						// Heuristic checks (strong_typing, prompt_injection, freshness-sensitive
						// references) are advisory only, except software_version_regression:
						// PostToolUse returns `decision: "block"` for compatibility even though
						// the mutation already landed. Treat it as an attention-required channel.
						const hasDeterministicErrors = qualityResults.some(
							(r) =>
								r.severity === "error" &&
								QUALITY_CHECK_META[r.name]?.determinism === "fully_deterministic",
						);
						const hasPostToolAttention = qualityResults.some(
							(r) => r.name === "software_version_regression",
						);
						if (hasDeterministicErrors || hasPostToolAttention) {
							postDecision.decision = "block";
						}

						const outcome = hasDeterministicErrors
							? "blocking"
							: hasPostToolAttention
								? "post-tool attention required"
								: "advisory";
						log(
							`Quality issues found: ${qualityResults.map((r) => r.name).join(", ")} (${outcome})`,
						);
					}
				}

				// ── Project-wide sweep (cross-file tsc/biome) ──
				// Catches cross-file type errors and lint issues that per-file checks miss.
				// Triggers: every N edits or immediately when export surface changed.
				const pwConfig = rules.project_wide_checks;
				if (pwConfig?.enabled && editedFilePath) {
					projectWideSweepState.recordFileChecked(editedFilePath);
					if (!projectWideSweepFiredThisEvent) {
						const intervalReached = projectWideSweepState.recordEdit(pwConfig);
						const shouldSweep =
							intervalReached || (pwConfig.on_export_change && exportSurfaceChanged);
	
						if (shouldSweep) {
							projectWideSweepFiredThisEvent = true;
							// Async sweep yields the event loop while tsc/biome subprocesses
							// run, so other PostToolUse connections can be serviced during
							// the up-to-30s sweep window instead of queueing behind it.
							const sweepResult = await runProjectWideChecksAsync(
								pwConfig,
								projectWideSweepState,
								CWD,
							);
		
							if (sweepResult.findings.length > 0) {
								const sweepWarnings = formatQualityWarnings(sweepResult.findings);
								postDecision.warnings = [
									...(postDecision.warnings || []),
									...sweepWarnings,
								];
								log(
									`Project-wide sweep: ${sweepResult.findings.length} cross-file issue(s) from ${sweepResult.toolsRun.join(", ")} (${sweepResult.elapsedMs}ms)`,
								);
							} else {
								log(
									`Project-wide sweep: clean (${sweepResult.toolsRun.join(", ")}, ${sweepResult.elapsedMs}ms)`,
								);
							}
						}
					}
				}
				// Phase mark — project-wide sweep is debounced (every 5 edits), so
				// for most events this will be ~0ms; only firings show real cost.
				markPhase("project_wide_sweep");

				// ── Scored suggestions (non-deterministic heuristics, top 1-3) ──
				if (editedFilePath && existsSync(editedFilePath)) {
					try {
						const suggContent = readFileSync(editedFilePath, "utf-8");
						const inlineSup = scanInlineSuppressions(suggContent);
						const relPath = relative(CWD, editedFilePath);
						const fileSup = loadFileSuppressions(join(CWD, ".interlinked"), relPath);

						// Collect findings from regex heuristics (30+ checks).
						// Registry lives in ./server/suggestion-checks.ts for auditing.
						const allFindings: Finding[] = collectSuggestionFindings(
							suggContent,
							editedFilePath!,
						);

						// --- Deletion hygiene (Layer 2): diff-aware zombie detectors ---
						// These compare old_string vs new_string to catch the agent hedging.
						allFindings.push(
							...collectDeletionHygieneDiffFindings({
								oldString: checkEvent.tool_input?.old_string as string | undefined,
								newString: checkEvent.tool_input?.new_string as string | undefined,
								filePath: editedFilePath!,
							}),
						);

						if (allFindings.length > 0) {
							// Compute edit region for proximity scoring
							let editStartLine: number | undefined;
							let editEndLine: number | undefined;
							const oldStr = checkEvent.tool_input?.old_string as string | undefined;
							if (oldStr && suggContent) {
								const idx = suggContent.indexOf(oldStr);
								if (idx >= 0) {
									editStartLine = suggContent.slice(0, idx).split("\n").length;
									editEndLine = editStartLine + oldStr.split("\n").length;
								}
							}

							const rawScored = scoreFindings(allFindings, {
								filePath: editedFilePath!,
								session,
								editStartLine,
								editEndLine,
								inlineSuppressions: inlineSup,
								fileSuppressions: fileSup,
								limit: rules.suggestion_limit ?? 3,
								threshold: rules.suggestion_threshold ?? 0.5,
							});

							// Session-ack suppression for suggestions (always warning severity)
							const scored = rawScored.filter(
								(s) => !isAcknowledged(session, editedFilePath!, s.check),
							);

							if (scored.length > 0) {
								for (const s of scored) {
									allCheckResults.push({
										source: "suggestion",
										name: s.check,
										severity: "warning",
										message: s.message,
										file: editedFilePath || undefined,
										score: s.score,
										line: s.line,
										determinism: "heuristic",
									});
								}
								const suggWarnings = formatScoredFindings(scored);
								postDecision.warnings = [
									...(postDecision.warnings || []),
									...suggWarnings,
								];
								log(
									`Suggestions: ${scored.map((s) => `${s.check}(${s.score.toFixed(2)})`).join(", ")}`,
								);
							}

							// Telemetry (non-blocking)
							writeTelemetry(allFindings, scored, {
								interlinkedDir: join(CWD, ".interlinked"),
								sessionId: checkEvent.session_id,
								agentName: session?.agent_name || "unknown",
								filePath: relPath,
								threshold: rules.suggestion_threshold ?? 0.5,
							});
						}
					} catch (e) {
						void e;
					}
				}

				// --- Session-level taste check: shotgun surgery ---
				// Threshold starts at 40 (not 25): adding a field to a shared interface
				// naturally touches types + implementation + every test mock, easily 10-15 files.
				if (session && session.files_written.size >= 40) {
					const shotgunKey = `shotgun-surgery-${session.files_written.size >= 60 ? "60" : "40"}`;
					if (!isAcknowledged(session, "__session__", shotgunKey)) {
						allCheckResults.push({
							source: "suggestion",
							name: "shotgun-surgery",
							severity: "warning",
							message: `This session has edited ${session.files_written.size} files. Consider whether abstraction boundaries could reduce the blast radius, or if this change should be broken into smaller steps.`,
							determinism: "heuristic",
						});
						if (!postDecision.warnings) postDecision.warnings = [];
						postDecision.warnings.push(
							`[taste:shotgun-surgery] ${session.files_written.size} files edited in this session — consider if the change scope is too broad`,
						);
						checksRan.push("shotgun-surgery");
						// Mark as acknowledged so we don't re-fire on every subsequent edit
						// at the same threshold. The 60-file threshold uses a different key,
						// so it will still fire once when crossed.
						acknowledgeChecks(session, "__session__", [shotgunKey]);
					}
				}

				// --- Structure checks phase (non-blocking guidance) ---
				// Skip cold graph build if existing checks already consumed most of the time budget.
				// The 15s PostToolUse timeout is shared with tsc/biome/etc. On large repos, a cold
				// graph build (~5-10s for 20K+ nodes) can push past the limit. The cached graph
				// (from a previous call) makes subsequent edits fast (<100ms).
				const structTimeBudgetMs = 12000;
				const structElapsed = Date.now() - postStartMs;
				const hasCachedGraph = structureGraph !== null;
				if (editedFilePath && (hasCachedGraph || structElapsed < structTimeBudgetMs)) {
					try {
						const structRepoRoot = findProjectRoot(editedFilePath, CWD) || CWD;
						const structResult = runStructureChecks(
							editedFilePath,
							structRepoRoot,
							structureGraph,
							structureConfigCache,
							session?.files_written,
						);
						structureGraph = structResult.graph;
						if (!structureConfigCache) {
							structureConfigCache = loadStructureConfig(structRepoRoot).config;
						}
						for (const r of structResult.results) {
							allCheckResults.push(r);
						}
						if (structResult.findings.length > 0) {
							checksRan.push("structure");
							if (!postDecision.warnings) postDecision.warnings = [];
							postDecision.warnings.push(
								...formatStructureWarnings(structResult.findings),
							);
						}
						// Record structure pending completions into session state
						if (session) {
							for (const pc of structResult.pendingCompletions) {
								session.pending_completions.set(`struct:${pc.source_artifact_ref}`, {
									source_file: pc.source_file,
									affected_files: pc.required_companion_files,
									resolved_files: new Set(pc.resolved_companion_files),
									recorded_at_tool_call: session.tool_call_count,
									description: `[structure] ${pc.finding_class}: ${pc.source_artifact_ref}`,
								});
							}
						}
					} catch (structErr) {
						log(
							`Structure check error: ${structErr instanceof Error ? structErr.message : String(structErr)}`,
						);
					}
				}
				// Phase mark — everything between project_wide_sweep and here was
				// the scored-suggestions pipeline (scanInlineSuppressions,
				// loadFileSuppressions, runStructureChecks). One of these is
				// re-loading state per event and is the load-bearing tax.
				markPhase("scored_suggestions");


				// --- Session-level behavioral checks ---
				if (session && editedFilePath) {
					// Capture fileContent once — both `countSuppressionDirectives`
					// and `checkAssertionDensity` need it. Reading twice would
					// double the I/O on every PostToolUse Edit.
					let fileContent: string | undefined;
					let currentSuppressionCount = 0;
					try {
						if (existsSync(editedFilePath)) {
							fileContent = readFileSync(editedFilePath, "utf-8");
							currentSuppressionCount = countSuppressionDirectives(fileContent);
						}
					} catch (e) {
						void e;
					}
					const behavioralResults = runBehavioralChecks(
						session,
						editedFilePath,
						allCheckResults,
						previousSuppressionCount,
						currentSuppressionCount,
					);

					// Plan 09 Phase 1: assertion-density runs outside
					// `runBehavioralChecks` because it's session-delta-based and
					// needs the post-edit content (which the orchestrator's
					// signature doesn't carry). The internal `TEST_FILE_RE` short-
					// circuit handles the test-file gate.
					if (fileContent !== undefined) {
						const r = checkAssertionDensity(session, editedFilePath, fileContent);
						if (r) behavioralResults.push(r);
					}

					// Filter-first: only push *shown* results into
					// `allCheckResults` so the recurrence and effectiveness loops
					// downstream don't see acknowledged-skipped findings.
					// Errors bypass the ack check by design — match the
					// suggestion-check pattern at server.ts:1970 and the quality-
					// check pattern at :1661 (`r.severity === "error" ||
					// !isAcknowledged(...)`). Acknowledging an error means "I saw
					// it"; it should still surface until actually fixed.
					if (behavioralResults.length > 0) {
						if (!postDecision.warnings) postDecision.warnings = [];
						for (const r of behavioralResults) {
							if (r.severity !== "warning" && r.severity !== "error") {
								// Info-level — record but don't surface, matching
								// the pre-existing `checkTddGreenConfirmation`
								// behavior.
								allCheckResults.push(r);
								continue;
							}
							const shouldShow =
								r.severity === "error" ||
								!isAcknowledged(session, editedFilePath, r.name);
							if (!shouldShow) continue;

							allCheckResults.push(r);
							const tag =
								r.determinism === "fully_deterministic" ? "[proven]" : "[heuristic]";
							postDecision.warnings.push(`${tag} ${r.name}: ${r.message}`);
						}
					}
				}

				// --- Feedback effectiveness tracking ---
				if (session && editedFilePath && allCheckResults.length > 0) {
					const warningNames = allCheckResults
						.filter((r) => r.severity === "warning" || r.severity === "error")
						.map((r) => r.name);
					if (warningNames.length > 0) {
						recordWarningsIssued(session, editedFilePath, warningNames);
					}
					recordWarningResolutions(
						session,
						editedFilePath,
						new Set(allCheckResults.map((r) => r.name)),
					);
				}

				// --- Session-ack: record shown warnings so they don't re-fire ---
				// Only acknowledge warning-level findings (errors must always re-fire).
				if (editedFilePath && allCheckResults.length > 0) {
					const warningCheckNames = allCheckResults
						.filter((r) => r.severity === "warning")
						.map((r) => r.name);
					if (warningCheckNames.length > 0) {
						acknowledgeChecks(session, editedFilePath, warningCheckNames);
					}
				}

				// Mirror EVERY actionable check failure (quality / structural /
				// suggestion / impact / structure / behavioral) into the
				// recurrence log so `interlinked recurrence` can aggregate
				// repeated harness_caught hits across sessions and propose
				// ratchets. Independent of error_memory.enabled — that gate
				// is for embedding-augmented error history; recurrence is its
				// own JSONL. Fire-and-forget; recordHarnessCaught swallows
				// storage failures so live PostToolUse never trips.
				if (editedFilePath && allCheckResults.length > recurrenceCursor) {
					const recurrenceRelPath = relative(CWD, editedFilePath);
					for (let i = recurrenceCursor; i < allCheckResults.length; i++) {
						const r = allCheckResults[i];
						if (r.severity !== "error" && r.severity !== "warning") continue;
						recordHarnessCaught({
							check_id: r.name,
							agent_source: event.agent_source,
							session_id: event.session_id,
							file: r.file ? relative(CWD, r.file) : recurrenceRelPath,
							message: r.message,
							cwd: CWD,
							phase: r.phase,
							severity: r.severity,
						});
					}
					recurrenceCursor = allCheckResults.length;
				}
			}
			// Phase mark — covers behavioral-checks + the recurrence log
			// appender. If `recordHarnessCaught` is doing a full re-scan of
			// the recurrences.jsonl file each call, this is where it lands.
			markPhase("recurrence_aggregate");

			// Write all accumulated warnings and remove marker.
			try {
				const allWarnings = postDecision.warnings || [];
				if (allWarnings.length > 0) {
					writeFileSync(pendingPath, JSON.stringify(allWarnings));
				}
				// Remove marker — signals PreToolUse that checks are done.
				unlinkSync(markerPath);
			} catch (err) {
				try {
					unlinkSync(markerPath);
				} catch (e) {
					void e;
				}
				log(`Quality check file error: ${err}`);
			}
		}

		// Phase mark — covers the final warnings-marker write +
		// any tail bookkeeping outside the inner block.
		markPhase("session_persist");

		// Attach structured check results and timing to the decision
		const elapsedMs = Date.now() - postStartMs;
		if (allCheckResults.length > 0) {
			postDecision.check_results = allCheckResults;
		}
		if (checksRan.length > 0) {
			postDecision.checks_ran = [...new Set(checksRan)];
			postDecision.checks_timing_ms = elapsedMs;
		}
		if (postToolMetrics.length > 0) {
			postDecision.tool_breakdown = postToolMetrics;
		}
		postDecision.phase_breakdown = phaseBreakdown;

		// Required-tool coverage: warn once per session if required tools are missing
		if (rules.required_tools?.length && session) {
			const engine = getOrCreateEngine(CWD);
			for (const reqId of rules.required_tools) {
				const skipKey = `required-tool-missing::${reqId}`;
				if (session.acknowledged_checks.has(skipKey)) continue;
				if (!engine.isToolAvailable(reqId)) {
					if (!postDecision.warnings) postDecision.warnings = [];
					postDecision.warnings.push(
						`[interlinked:required-tool] Required tool "${reqId}" is not available. Install it or remove from required_tools in guard-rules.json.`,
					);
					session.acknowledged_checks.add(skipKey);
				}
			}
		}

		// Emit a summary line when all checks pass (positive feedback).
		// When there ARE issues, the detailed warnings provide the signal.
		// Uses a separate `summary` field so the hook script can surface it
		// as non-blocking output (stderr/pending) rather than a fake "block".
		const allWarnings = postDecision.warnings || [];
		if (allWarnings.length === 0 && checksRan.length > 0) {
			const ruleCount = rules.rules.length;
			// Deduplicate and abbreviate check names for a compact summary
			const unique = [...new Set(checksRan)];
			const checkSummary = unique
				.map((c) => {
					if (c === "structural") return "structural";
					if (c === "typescript") return "tsc";
					if (c === "biome_lint") return "biome";
					if (c === "secrets_in_source") return "secrets";
					if (c === "affected_tests") return "tests";
					return c.replace(/_/g, "-");
				})
				.join(", ");
			postDecision.summary = `[interlinked] ✓ ${ruleCount} guard rules, ${checkSummary} — all clean (${elapsedMs}ms)`;
		}

		return postDecision;
	}

	// Non-tool events (lifecycle, notifications, etc.) — always allow
	return { decision: "allow" };
}

async function evaluateEventLine(
	line: string,
	protocol: "raw" | "framed",
): Promise<HarnessDecision> {
	// Parse session_id once up-front so the durability finally block can run
	// even when `processEvent` throws — the session was already created (or
	// hydrated) by the time recordEvent ran, so a snapshot is safe to write.
	let sessionIdForSnap: string | null = null;
	try {
		const parsed: JsonObject = JSON.parse(line);
		if (typeof parsed.session_id === "string") sessionIdForSnap = parsed.session_id;
	} catch (e) {
		void e;
	}

	try {
		const decision = await processEvent(line);
		recordProtocolEvent(protocol);
		try {
			const evt: JsonObject = JSON.parse(line);
			appendLatencyLog(INTERLINKED_DIR, {
				hook_event: typeof evt.hook_event === "string" ? evt.hook_event : null,
				tool_name: typeof evt.tool_name === "string" ? evt.tool_name : null,
				session_id: typeof evt.session_id === "string" ? evt.session_id : null,
				agent_source: typeof evt.agent_source === "string" ? evt.agent_source : null,
				decision: decision.decision,
				checks_ran: decision.checks_ran ?? null,
				checks_timing_ms: decision.checks_timing_ms ?? null,
				tool_breakdown: decision.tool_breakdown ?? null,
				phase_breakdown: decision.phase_breakdown ?? null,
			});
		} catch (e) {
			void e;
		}
		return decision;
	} finally {
		// Per-event durability: write the live snapshot AFTER processEvent so
		// the snapshot reflects every post-event state mutation — PostToolUse
		// handlers updating `tdd_cycles`, `assertion_counts`, `active_skills`,
		// etc. The earlier "snapshot right after recordEvent" placement lost
		// those mutations on a daemon restart between events. Best-effort:
		// write failures are logged but never block the decision return.
		if (sessionIdForSnap) {
			try {
				const snap = sessions.serialize(sessionIdForSnap);
				if (snap) {
					const writeResult = writeLiveSnapshot(CWD, sessionIdForSnap, snap);
					if (!writeResult.ok) {
						log(`Live snapshot write failed (non-fatal): ${writeResult.error.message}`);
					}
				}
			} catch (e) {
				log(`Live snapshot write threw: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}
}

async function evaluateUnifiedViaRuntime(event: UnifiedHookEvent): Promise<HarnessDecision> {
	try {
		const legacyEvent = toLegacyHarnessEvent(event);
		return await evaluateEventLine(JSON.stringify(legacyEvent), "framed");
	} catch (err) {
		protocolStatus.framed_error_count++;
		writeProtocolStatus();
		throw err;
	}
}

function recordProtocolEvent(protocol: "raw" | "framed"): void {
	const now = new Date().toISOString();
	if (protocol === "raw") {
		protocolStatus.raw_event_count++;
		protocolStatus.last_raw_event_at = now;
	} else {
		protocolStatus.framed_event_count++;
		protocolStatus.last_framed_event_at = now;
	}
	writeProtocolStatus();
}

function writeProtocolStatus(): void {
	try {
		ensureDirectory(PROTOCOL_STATUS_PATH);
		writeFileSync(PROTOCOL_STATUS_PATH, `${JSON.stringify(protocolStatus, null, 2)}\n`);
	} catch (e) {
		void e;
	}
}

function summarizeToolInput(event: HarnessEvent): string {
	if (!event.tool_input) return event.tool_name || "";
	const input = event.tool_input;
	if (input.command) return String(input.command).slice(0, 200);
	if (input.file_path) return String(input.file_path);
	if (input.url) return String(input.url).slice(0, 200);
	return event.tool_name || "";
}

function isPreToolUse(event: HarnessEvent): boolean {
	return event.hook_event === "PreToolUse" || event.hook_event === "BeforeTool";
}

function isPostToolUse(event: HarnessEvent): boolean {
	return (
		event.hook_event === "PostToolUse" ||
		event.hook_event === "AfterTool" ||
		event.hook_event === "PostToolUseFailure"
	);
}

// ===========================================
// Test Runner Detection
// ===========================================

const TEST_RUNNER_PATTERNS = [
	/\b(?:npx\s+)?vitest\s+run\s+(\S+)/,
	/\b(?:npx\s+)?jest\s+(\S+)/,
	/\bpytest\s+(\S+)/,
	/\bcargo\s+test/,
	/\bgo\s+test\s+(\S+)/,
	/\bnpm\s+(?:run\s+)?test/,
	/\b(?:npx\s+)?vitest(?:\s|$)/,
	/\b(?:npx\s+)?jest(?:\s|$)/,
];

/**
 * Detect if a bash command runs a test runner. If a specific test file is targeted,
 * return its absolute path. Otherwise return a sentinel indicating "ran all tests".
 */
function detectTestRunFile(command: string, cwd: string): string | null {
	for (const pattern of TEST_RUNNER_PATTERNS) {
		const match = command.match(pattern);
		if (match) {
			const targetFile = match[1];
			if (targetFile && /\.(test|spec|_test)\b/.test(targetFile)) {
				return targetFile.startsWith("/") ? targetFile : join(cwd, targetFile);
			}
			// Generic test run (no specific file) — record as sentinel
			return "__all_tests__";
		}
	}
	return null;
}

// ===========================================
// TDD Cycle Tracking
// ===========================================

const TEST_FILE_RE = /\.(test|spec)\.[^.]+$|__tests__\//;

/** Given a test file path, derive the source file it tests. */
function sourceFileForTest(testFile: string): string | null {
	// __tests__/foo.test.ts → ../foo.ts
	if (testFile.includes("__tests__/")) {
		const dir = dirname(dirname(testFile));
		const base = basename(testFile).replace(/\.(test|spec)\./, ".");
		return join(dir, base);
	}
	// foo.test.ts → foo.ts
	return testFile.replace(/\.(test|spec)\./, ".");
}

/** Given a source file path, find the test file (if it exists on disk). */
function findTestForSource(filePath: string): string | null {
	const ext = filePath.slice(filePath.lastIndexOf("."));
	const base = filePath.slice(0, -ext.length);
	const dir = dirname(filePath);
	const name = basename(filePath, ext);

	if (name.endsWith(".test") || name.endsWith(".spec")) return null;

	const candidates = [
		`${base}.test${ext}`,
		`${base}.spec${ext}`,
		join(dir, "__tests__", `${name}.test${ext}`),
		join(dir, "__tests__", `${name}.spec${ext}`),
	];
	return candidates.find((t) => existsSync(t)) || null;
}

/** Get or create the TDD cycle entry for a source file. */
function getOrCreateCycle(
	session: import("./types.js").SessionTrajectory,
	sourceFile: string,
): import("./types.js").TddCycle {
	let cycle = session.tdd_cycles.get(sourceFile);
	if (!cycle) {
		cycle = {
			source_file: sourceFile,
			test_file: findTestForSource(sourceFile),
			state: "no_test",
			impl_edits_before_test: 0,
		};
		session.tdd_cycles.set(sourceFile, cycle);
	}
	return cycle;
}

/** Record that a source file was edited (implementation work). */
function recordImplEdit(session: import("./types.js").SessionTrajectory, sourceFile: string): void {
	if (TEST_FILE_RE.test(sourceFile)) return;
	const cycle = getOrCreateCycle(session, sourceFile);
	cycle.impl_edits_before_test++;
}

/** Record that a test file was written/edited. */
function recordTestWrite(session: import("./types.js").SessionTrajectory, testFile: string): void {
	const sourceFile = sourceFileForTest(testFile);
	if (!sourceFile || !existsSync(sourceFile)) return;

	const cycle = getOrCreateCycle(session, sourceFile);
	cycle.test_file = testFile;
	cycle.test_written_at = session.tool_call_count;
}

/** Record a test run result and update the corresponding cycle state. */
function recordTestRunCycle(
	session: import("./types.js").SessionTrajectory,
	testRunFile: string,
	passed: boolean,
): void {
	// For sentinel "__all_tests__", update all tracked cycles
	if (testRunFile === "__all_tests__") {
		for (const [, cycle] of session.tdd_cycles) {
			updateCycleFromTestRun(cycle, passed, session.tool_call_count);
		}
		return;
	}

	// For a specific test file, find the source file it tests
	const sourceFile = sourceFileForTest(testRunFile);
	if (!sourceFile) return;

	const cycle = getOrCreateCycle(session, sourceFile);
	cycle.test_file = testRunFile;
	updateCycleFromTestRun(cycle, passed, session.tool_call_count);
}

function updateCycleFromTestRun(
	cycle: import("./types.js").TddCycle,
	passed: boolean,
	step: number,
): void {
	cycle.previous_state = cycle.state;

	if (passed) {
		cycle.green_at = step;
		cycle.state = "green";
		// Reset impl edit counter — tests verified the work
		cycle.impl_edits_before_test = 0;
	} else {
		cycle.red_at = step;
		if (cycle.previous_state === "green") {
			cycle.state = "regression";
		} else {
			cycle.state = "red";
		}
	}
}

// ===========================================
// Server Setup
// ===========================================

function ensureDirectory(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function cleanupSocket(path: string = SOCKET_PATH): void {
	try {
		if (existsSync(path)) {
			unlinkSync(path);
		}
	} catch (e) {
		void e;
	}
}

function writePidFile(): void {
	// Owns ONLY the legacy `harness.pid`. The framed `harness-<session>.pid`
	// is written exclusively by `startSessionDaemon()` (session-daemon.ts:136)
	// AFTER its ownership check — writing it here too clobbers a sibling
	// daemon's PID file before the session-daemon code can detect the
	// existing owner, causing it to remove the live socket and rebind.
	ensureDirectory(PID_PATH);
	writeFileSync(PID_PATH, String(process.pid));
}

function removePidFile(): void {
	// Owns ONLY the legacy `harness.pid`. The framed `harness-<session>.pid`
	// is removed by `session-daemon.handle.stop()` (session-daemon.ts:167-169)
	// — the side that wrote it owns the lifecycle, so we don't touch it here.
	try {
		if (existsSync(PID_PATH)) {
			rmSync(PID_PATH);
		}
	} catch (e) {
		void e;
	}
}

let socketServer: ReturnType<typeof createServer> | null = null;
let framedDaemon: SessionDaemonHandle | null = null;
let shuttingDown = false;

/** Tracks every open raw-socket client so shutdown can destroy them. Without
 *  this, `socketServer.close(callback)` waits for clients to disconnect on
 *  their own — which never happens for a hung .mjs hook — and SIGTERM appears
 *  to be ignored. The set is mutated by createRawSocketServer's connect/close
 *  handlers and emptied during shutdownAsync. */
const openRawClients: Set<Socket> = new Set();

/** Hard ceiling on graceful shutdown. If `shutdownAsync` doesn't reach
 *  `process.exit(0)` within this window, force-exit so a stuck connection or
 *  drain promise can't hold the daemon hostage and block restarts. */
const SHUTDOWN_GRACE_MS = 3000;
/** Per-step timeout for individual shutdown phases (framedDaemon.stop, etc.).
 *  Each phase races against this window; the SHUTDOWN_GRACE_MS umbrella
 *  catches anything that escapes both. */
const SHUTDOWN_STEP_TIMEOUT_MS = 500;

function shutdown(): void {
	if (shuttingDown) return;
	shuttingDown = true;
	// Always-armed force-exit. Any path that hangs for more than 3 s — a
	// pinned client connection, an async drain that never resolves, a third-
	// party shutdown handler that throws — will fall through to this rather
	// than leaving the daemon SIGTERM-deaf and forcing the user to SIGKILL.
	const forceExit = setTimeout(() => {
		try {
			logAlways(`Graceful shutdown stalled after ${SHUTDOWN_GRACE_MS}ms — forcing exit`);
		} catch (logErr) {
			void logErr; /* intentional: logger may already be torn down */
		}
		try {
			removePidFile();
		} catch (rmErr) {
			void rmErr; /* intentional: best-effort cleanup during forced exit */
		}
		try {
			if (RUN_RAW_SOCKET) cleanupSocket();
		} catch (sockErr) {
			void sockErr; /* intentional: best-effort cleanup during forced exit */
		}
		process.exit(1);
	}, SHUTDOWN_GRACE_MS);
	forceExit.unref();
	shutdownAsync().finally(() => clearTimeout(forceExit));
}

async function shutdownAsync(): Promise<void> {
	logAlways("Shutting down...");
	serverBridge?.shutdown();
	reservations.shutdown();
	// Fire-and-forget: the Python sidecar will be SIGKILLed by the SidecarManager
	// after its own 1 s grace window; we don't block the exit on it here.
	contentScanner?.shutdown().catch(() => {
		// best-effort
	});
	// Destroy open raw-socket clients BEFORE server.close(). Node's
	// `server.close()` only stops accepting new connections; it waits forever
	// for active ones to drain on their own. A hung .mjs hook (mid-RPC, parent
	// exited) will pin the close indefinitely without this loop.
	for (const sock of openRawClients) {
		try {
			sock.destroy();
		} catch (destroyErr) {
			void destroyErr; /* intentional: socket already torn down */
		}
	}
	openRawClients.clear();
	// Stop the framed daemon, but bound it: an in-flight RPC on a stuck
	// client would otherwise hang stop() forever. 500 ms is generous —
	// stop() destroys its own clients first, so close() should resolve
	// in microseconds. The race + timeout is insurance, not the path.
	if (framedDaemon) {
		await Promise.race([
			framedDaemon.stop("server_shutdown"),
			new Promise<void>((resolve) => {
				const t = setTimeout(resolve, SHUTDOWN_STEP_TIMEOUT_MS);
				t.unref();
			}),
		]);
	}
	// Tell the raw server to stop accepting new connections, but DO NOT
	// await server.close(callback). The callback only fires after every
	// active connection drains on its own — and a malformed client (rare
	// but real, observed in the wild) can keep that pending forever. We
	// already destroyed openRawClients above; the OS will reclaim the
	// listening socket on process exit regardless.
	try {
		socketServer?.close();
	} catch (closeErr) {
		void closeErr; /* intentional: close() can throw if the server is already closed */
	}
	if (RUN_RAW_SOCKET) cleanupSocket();
	removePidFile();
	unwatchRules();
	unwatchSettings();
	process.exit(0);
}

function createRawSocketServer(): ReturnType<typeof createServer> {
	return createServer((sock: Socket) => {
		connectionCount++;
		openRawClients.add(sock);
		log(`Connection opened (total: ${connectionCount})`);

		let buffer = "";

		sock.on("data", async (data: Buffer) => {
			buffer += data.toString("utf-8");
			// Handle newline-delimited JSON (may receive multiple events in one chunk)
			let newlineIdx = buffer.indexOf("\n");
			while (newlineIdx !== -1) {
				const line = buffer.slice(0, newlineIdx);
				buffer = buffer.slice(newlineIdx + 1);
				if (!line.trim()) continue;
				const decision = await evaluateEventLine(line, "raw");
				try {
					sock.write(`${JSON.stringify(decision)}\n`);
				} catch (e) {
					void e;
				}
				newlineIdx = buffer.indexOf("\n");
			}
		});

		sock.on("close", () => {
			connectionCount--;
			openRawClients.delete(sock);
			log(`Connection closed (remaining: ${connectionCount})`);
		});

		sock.on("error", (err: Error) => {
			log(`Socket error: ${err.message}`);
		});
	});
}

function buildStartupMessage(): string {
	const sockets: string[] = [];
	if (RUN_RAW_SOCKET) sockets.push(`raw ${SOCKET_PATH}`);
	if (RUN_FRAMED_SOCKET) sockets.push(`framed ${FRAMED_PATHS.socket}`);
	return (
		`Harness started (${PROTOCOL_MODE}) on ${sockets.join(", ")} ` +
		`(PID ${process.pid}, ${rules.rules.length} rules` +
		`${IDLE_TIMEOUT_MS ? `, idle timeout ${IDLE_TIMEOUT_MS / MS_PER_MINUTE}min` : ""})`
	);
}

// ===========================================
// Start Server
// ===========================================

// Clean up stale raw socket from previous run. Framed startup performs its own
// PID-aware stale-artifact check before removing `harness-*.sock`.
if (RUN_RAW_SOCKET) {
	cleanupSocket();
	ensureDirectory(SOCKET_PATH);
}
writePidFile();
writeProtocolStatus();

// Sweep orphaned `<id>.live.json` snapshots older than 48h. A session that
// hasn't sent an event in two days is stale enough that its snapshot is no
// longer load-bearing — keeping it around just delays GC and clutters
// `interlinked status`. Live snapshots from sessions still active in the
// last 48h survive and will hydrate on their next event.
{
	const sweep = sweepStaleLiveSnapshots(CWD);
	if (sweep.removed.length > 0) {
		log(
			`Reaped ${sweep.removed.length} stale live snapshot(s) (of ${sweep.scanned} scanned)`,
		);
	}
}

// Watch rules files for hot-reload
const unwatchRules = watchRulesFiles(CWD, (newRules) => {
	rules = newRules;
	// Plan §reviewer-P5 (round 4): clear cached per-session rules so
	// active sessions pick up the new floor (and any new metacoder
	// config) on the very next PreToolUse. Without this, sessions that
	// already have a written overlay keep the snapshot of `rules` they
	// were merged against until SessionEnd / Stop, so a user disabling a
	// floor rule via `guard-rules.local.json` mid-session never takes
	// effect for live sessions. Subsequent UserPromptSubmit calls will
	// rebuild the cache with fresh floor + overlay.
	sessionRules.clear();
	// Update classifier status on config reload
	if (rules.policy_classifier?.enabled) {
		const p = rules.policy_classifier;
		const hasKey = p.provider === "claude_code" || !!resolveApiKey(p.api_key_env);
		writeClassifierStatus(
			hasKey ? `${p.provider}:${p.model}:ready` : `${p.provider}:${p.model}:no_key`,
		);
	} else {
		writeClassifierStatus("disabled");
	}
	// Update scanner status on config reload. If the user toggled off via
	// `interlinked scanner off`, the flag flips here; scan paths already
	// short-circuit on rules.content_scanner?.enabled so no further scans run.
	// The existing sidecar stays alive until its idle timer fires, which is
	// fine — it just sits dormant. On toggle-back-on we reuse the live scanner.
	if (!rules.content_scanner?.enabled) {
		writeScannerStatus("disabled");
	} else if (contentScanner?.getStatus) {
		writeScannerStatus(formatScannerStatusLine(contentScanner.getStatus()));
	} else if (contentScanner) {
		writeScannerStatus(`ready:${contentScanner.runtime}`);
	} else {
		// Config flipped from disabled→enabled at runtime, but the scanner
		// was not constructed at startup. Requires a harness restart to pick up.
		writeScannerStatus("down:needs_restart");
	}
	// Recompile the allowlist whenever rules reload — users adding entries
	// to .interlinked/guard-rules.local.json shouldn't have to restart the
	// harness for them to take effect on the next scan.
	compiledAllowlist = compileAllowlist(rules.content_scanner?.allowlist);
	// Update auto-coordination config
	Object.assign(autoCoordConfig, DEFAULT_AUTO_COORDINATION_CONFIG, rules.auto_coordination || {});
	log(`Rules reloaded: ${rules.rules.length} rules active`);
	refreshStatuslineSnapshot();
});

// Live filesystem watcher on .claude/settings*.json (project + user
// scope). Claude Code's "Always allow" UI writes those files directly
// without firing a tool hook, so PreToolUse content guards in
// `evaluator/write-content-guards.ts` can't intercept it. The
// SessionStart strip above only runs after Claude Code has already
// printed its "Invalid permission rule" warning to the terminal —
// closing that gap is what this watcher is for. On change, the
// debounced strip runs `autoStripAllScopes` so a malformed rule lives
// on disk for at most ~poll + debounce before being removed.
const unwatchSettings = watchSettingsFiles({
	cwd: CWD,
	onStrip: (stripResult) => {
		resetProjectSetupWarningsCache();
		const previews = stripResult.entries.slice(0, 5).map((e) => {
			const file = e.file.replace(/^.+?(\.claude\/.+)$/, "$1");
			return `  - ${file} permissions.${e.bucket}[${e.index}] = ${JSON.stringify(e.rule)} (${describeMalformedReason(e.reason)})`;
		});
		const more =
			stripResult.entries.length > previews.length
				? `\n  ...and ${stripResult.entries.length - previews.length} more`
				: "";
		logAlways(
			`[interlinked] Live-stripped ${stripResult.totalStripped} malformed permission rule(s) from .claude/settings*.json:\n${previews.join("\n")}${more}`,
		);
	},
});

// Periodically refresh the statusline snapshot so live counters
// (reservations, index status, server-bridge connectivity) reflect
// current state without depending on a triggering event.
const STATUSLINE_REFRESH_INTERVAL_MS = 10_000;
setInterval(() => {
	refreshStatuslineSnapshot();
}, STATUSLINE_REFRESH_INTERVAL_MS);

// Start idle timer
resetIdleTimer();

// Periodically check for lost agents (every 2 minutes)
setInterval(
	() => {
		const lost = cohort.detectLostAgents();
		for (const agent of lost) {
			log(`Agent lost (no events for 5min): ${agent.name}`);
			reservations.releaseAllForAgent(agent.name, cohort);
		}
	},
	2 * 60 * 1000,
);

// Handle process signals
// Upgrade the early SIGTERM/SIGINT handlers (installed at the top of this
// file before heavy startup work) to the full graceful `shutdown()`. The
// early handler covers signals that arrive while module init was still
// blocking the event loop — without it, restarts during the first ~3s of
// daemon life always fall through to SIGKILL. Order matters: re-bind first
// so any signal arriving DURING this turn lands on the real handler, then
// honor a flag set by the early handler if a signal was already received.
process.removeListener("SIGTERM", _earlyShutdown);
process.removeListener("SIGINT", _earlyShutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
_shutdownReady = true;
if (_shutdownPending) {
	logAlways("Shutdown was requested during startup — running graceful path now");
	shutdown();
}
process.on("SIGHUP", () => {
	// Reload rules on SIGHUP.
	// Plan §reviewer-P2 (round 6): also invalidate the per-session rule
	// cache so the new ruleset takes effect on active sessions' next
	// PreToolUse. Without this clear, sessions that have a hydrated
	// snapshot keep using stale rules until SessionEnd / Stop and
	// operator SIGHUP-driven reloads silently no-op for live sessions.
	// Mirrors the watchRulesFiles callback above — keep both in sync.
	rules = loadRules(CWD);
	sessionRules.clear();
	logAlways(`Rules reloaded via SIGHUP: ${rules.rules.length} rules active`);
});

const tsgoRunner = createTsgoRunner();

if (RUN_FRAMED_SOCKET) {
	framedDaemon = await startSessionDaemon({
		paths: FRAMED_PATHS,
		session_id: FRAMED_SESSION_ID,
		idle_shutdown_ms: IDLE_TIMEOUT_MS,
		state: {
			tsgo: tsgoRunner,
			getEvaluatorContext: () => ({
				rules,
				session: sessions.get(FRAMED_SESSION_ID),
				reservations,
				cohort,
				graph: getGraphForFile(CWD),
				sessions,
				routeMap,
				errorHistory,
			}),
			evaluateHook: evaluateUnifiedViaRuntime,
		},
	});
}

if (RUN_RAW_SOCKET) {
	const rawServer = createRawSocketServer();
	socketServer = rawServer;
	rawServer.listen(SOCKET_PATH);
}

writeProtocolStatus();

logAlways(buildStartupMessage());

// Write initial classifier status for statusline
if (rules.policy_classifier?.enabled) {
	const provider = rules.policy_classifier.provider;
	const model = rules.policy_classifier.model;
	const hasKey =
		provider === "claude_code" || !!resolveApiKey(rules.policy_classifier.api_key_env);
	writeClassifierStatus(hasKey ? `${provider}:${model}:ready` : `${provider}:${model}:no_key`);
	log(`Policy classifier: ${provider}/${model} (${hasKey ? "ready" : "no API key"})`);
} else {
	writeClassifierStatus("disabled");
}

// ===========================================
// tsgo acceleration — rewrite agent tsc calls to use tsgo
// ===========================================

let _tsgoAvailable: boolean | null = null;

function isTsgoAvailable(): boolean {
	if (_tsgoAvailable !== null) return _tsgoAvailable;
	try {
		const result = spawnSync("npx", ["tsgo", "--version"], {
			timeout: 5_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		_tsgoAvailable = result.status === 0 && !result.error;
	} catch {
		_tsgoAvailable = false;
	}
	return _tsgoAvailable;
}

/** Check if this is a Bash tool call that runs tsc for type-checking (safe for tsgo). */
function isBashTsc(event: { tool_name?: string; tool_input?: JsonObject }): boolean {
	if (event.tool_name !== "Bash") return false;
	const cmd = ((event.tool_input?.command as string) || "").trim();
	if (/\btsgo\b/.test(cmd)) return false; // already using tsgo
	// Only match tsc as the primary command (not inside strings/echo)
	const isTscCommand = /^(npx\s+)?tsc\b/.test(cmd) || /[;&|]\s*(npx\s+)?tsc\b/.test(cmd);
	if (!isTscCommand) return false;
	// tsgo doesn't support all tsc flags — only rewrite for type-checking.
	// Skip: --build/-b, --watch/-w, --declaration/-d, --emitDeclarationOnly,
	// --incremental, --composite, --init, --generateTrace
	if (
		/\s(-[bwd]|--build|--watch|--declaration|--emitDeclarationOnly|--incremental|--composite|--init|--generateTrace)\b/.test(
			cmd,
		)
	)
		return false;
	return true;
}

/** Rewrite a tsc command to tsgo and run it via block-and-answer. */
function tryTsgoRewrite(
	event: { tool_input?: JsonObject },
	cwd: string,
	log: (msg: string) => void,
): { decision: "block"; reason: string } | null {
	if (!isTsgoAvailable()) return null;

	const cmd = (event.tool_input?.command as string) || "";
	// Replace tsc with tsgo in the command
	const rewritten = cmd.replace(/\b(npx\s+)?tsc\b/, "npx tsgo");
	log(`tsgo acceleration: ${cmd.trim().slice(0, 60)} → ${rewritten.trim().slice(0, 60)}`);

	try {
		const result = spawnSync("sh", ["-c", rewritten], {
			cwd,
			timeout: 120_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		const output = ((result.stdout || "") + (result.stderr || "")).trim();
		const exitCode = result.status ?? 1;

		// Only use tsgo results when it exits clean (no errors).
		// When tsgo finds errors, fall back to tsc — tsgo may produce
		// false positives due to different type resolution behavior.
		if (exitCode !== 0) {
			log(`tsgo exited ${exitCode}, falling back to tsc`);
			return null;
		}

		return {
			decision: "block",
			reason: [
				"[interlinked:tsgo] Accelerated with tsgo (native TypeScript compiler)",
				`$ ${rewritten}`,
				...(output ? [output] : ["(no output)"]),
			].join("\n"),
		};
	} catch (err) {
		log(`tsgo acceleration failed: ${err instanceof Error ? err.message : String(err)}`);
		return null; // fall through to normal tsc
	}
}
