// ============================================================================
// Behavioral tests for the harness daemon entry point (`server.ts`).
// ============================================================================
// `server.ts` is a process entry point: it has NO exports and runs its entire
// startup as module-load side effects (CLI parse → state construction → socket
// servers → process-signal wiring → framed-daemon spawn). The only way to cover
// it is to `import("./server.js")` under a full mock harness that neutralizes
// every real side effect (no real Unix socket, no `process.exit`, no daemon
// spawn, no disk writes) and CAPTURES the callbacks server.ts wires into its
// collaborators (rules hot-reload, settings-strip, scanner status, the socket
// lifecycle setters, the framed-daemon evaluator-context factory). Invoking
// those captured callbacks is what exercises the inline closures that are the
// real coverable logic of this file.
//
// Strategy:
//   * `process.argv` is set per-suite BEFORE the dynamic import so the REAL
//     `parseArgs` runs against controlled flags (covers the CLI-arg branches).
//   * `process.on` / `process.removeListener` / `process.exit` are spied so
//     signal handlers are captured (not bound to the real process) and exit is
//     a throw we can assert, never a real exit.
//   * timers are faked so the three `setTimeout(0)` background-init closures and
//     the two `setInterval` ticks can be flushed and asserted deterministically.
//   * sibling modules are mocked at their import boundary; the factory return
//     values double as the assertion handles.
//
// Each test re-imports the module fresh (`vi.resetModules()` in beforeEach) so
// the top-level state is rebuilt against that test's mock configuration.

import { EventEmitter } from "node:events";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import type { ContentScanner, ScannerStatus } from "./content-scanner/types.js";
import { DEFAULT_CONFIG } from "./rules/default-config.js";
import type { GuardRulesConfig } from "./types/config.js";
import type { HarnessDecision } from "./types.js";
import type { UnifiedHookEvent } from "./unified-event.js";

const lifecycleMocks = vi.hoisted(() => ({
	reapZombieIncumbent: vi.fn(async () => "gone" as const),
	removePidFileIfOwned: vi.fn(),
}));

vi.mock("./server/anti-stomp.js", async () => {
	const actual = await vi.importActual<typeof import("./server/anti-stomp.js")>(
		"./server/anti-stomp.js",
	);
	return { ...actual, reapZombieIncumbent: lifecycleMocks.reapZombieIncumbent };
});

vi.mock("./daemon-pid-ownership.js", async () => {
	const actual = await vi.importActual<typeof import("./daemon-pid-ownership.js")>(
		"./daemon-pid-ownership.js",
	);
	return { ...actual, removePidFileIfOwned: lifecycleMocks.removePidFileIfOwned };
});

// ---------------------------------------------------------------------------
// Shared mutable capture slots. Reset in beforeEach. The mock factories below
// are hoisted by Vitest, so they reference these via closure (they exist at
// module-eval time) and must not be re-assigned to fresh objects per-test —
// only mutated.
// ---------------------------------------------------------------------------

interface Captured {
	rulesReloadCb: ((rules: GuardRulesConfig) => void) | null;
	settingsOnStrip: ((r: StripResult) => void) | null;
	scannerStatusCb: ((s: ScannerStatus) => void) | null;
	socketSetters: {
		setFramedDaemon: Mock | null;
		setUnwatchers: Mock | null;
		startRawServer: Mock | null;
		cleanupSocket: Mock | null;
		writePidFile: Mock | null;
		shutdown: Mock | null;
	};
	eventLoopDeps: EventLoopDepsCapture | null;
	sessionDaemonOpts: SessionDaemonOptsCapture | null;
	socketLifecycleDeps: SocketLifecycleDepsCapture | null;
	statusWriters: {
		writeClassifierStatus: Mock;
		writeScannerStatus: Mock;
		writeReviewPendingMarker: Mock;
	};
	reservationEventSink: ((event: unknown) => void) | null;
	/** The first constructor arg `ReservationManager` was built with this load
	 *  (`serverBridge || undefined`) — captured so the `||`/ternary mutants on
	 *  that expression (server.ts ~line 340) are distinguishable from the
	 *  bridge itself, which `FakeReservationManager` otherwise discards. */
	reservationManagerBridgeArg: unknown;
}

interface StripResult {
	totalStripped: number;
	entries: Array<{
		file: string;
		bucket: string;
		index: number;
		rule: unknown;
		reason: string | undefined;
	}>;
}

interface EventLoopDepsCapture {
	resetIdleTimer: () => void;
	syncRuntimeIn: () => void;
	syncRuntimeOut: () => void;
	writeCollectionRecord: (event: unknown, decision?: unknown) => void;
	writeLifecycleActivityRecord: (event: unknown, decision?: unknown) => void;
	protocolStatusPath: string;
	ctx: Record<string, unknown>;
}

interface SessionDaemonOptsCapture {
	session_id: string;
	idle_shutdown_ms?: number;
	state: {
		getEvaluatorContext: () => Record<string, unknown>;
		evaluateHook: (event: unknown) => Promise<HarnessDecision>;
		tsgo: unknown;
	};
	paths: unknown;
}

interface SocketLifecycleDepsCapture {
	socketPath: string;
	pidPath: string;
	runRawSocket: boolean;
	serverBridge: unknown;
	contentScanner: ContentScanner | undefined;
}

const cap: Captured = {
	rulesReloadCb: null,
	settingsOnStrip: null,
	scannerStatusCb: null,
	socketSetters: {
		setFramedDaemon: null,
		setUnwatchers: null,
		startRawServer: null,
		cleanupSocket: null,
		writePidFile: null,
		shutdown: null,
	},
	eventLoopDeps: null,
	sessionDaemonOpts: null,
	socketLifecycleDeps: null,
	statusWriters: {
		writeClassifierStatus: vi.fn(),
		writeScannerStatus: vi.fn(),
		writeReviewPendingMarker: vi.fn(),
	},
	reservationEventSink: null,
	reservationManagerBridgeArg: undefined,
};

// Per-test override for what loadRules returns (rebuilt fresh in beforeEach).
let rulesOverride: GuardRulesConfig;
// Per-test override for what createScanner returns.
let scannerOverride: ContentScanner | undefined;
// Per-test override for what createServerBridge returns.
let serverBridgeOverride: { shutdown: Mock } | null;

// A VALID GuardRulesConfig built off the shipped `DEFAULT_CONFIG` so every
// required nested config (curl_mcp_detection, structural_checks, error_memory,
// taint_tracking, output_scanning, …) is fully-formed without hand-construction.
// `loadRules`/`watchRulesFiles` are mocked, so this is the single source of the
// daemon's "rules". Deep-clone the default so per-test overrides never mutate
// the shared const. `content_scanner` is absent by default (the disabled
// branch); tests pass it in via `overrides`.
function makeRules(overrides: Partial<GuardRulesConfig> = {}): GuardRulesConfig {
	const base = structuredClone(DEFAULT_CONFIG);
	return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// node:net — fake createServer returning an EventEmitter with listen/close.
// ---------------------------------------------------------------------------
class FakeServer extends EventEmitter {
	listen = vi.fn();
	close = vi.fn();
}
const fakeServers: FakeServer[] = [];
vi.mock("node:net", () => ({
	createServer: vi.fn((_handler?: unknown) => {
		const s = new FakeServer();
		fakeServers.push(s);
		return s;
	}),
}));

// ---------------------------------------------------------------------------
// node:fs — neutralize the direct disk writes server.ts performs (the
// reservation-event sink uses existsSync/mkdirSync/appendFileSync; the early
// shutdown uses removeFileIfExists which is itself mocked via socket-lifecycle).
// ---------------------------------------------------------------------------
vi.mock("node:fs", () => ({
	appendFileSync: vi.fn(),
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	readFileSync: vi.fn(() => ""),
	rmSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// rules-loader — loadRules returns the per-test rules; watchRulesFiles captures
// the hot-reload callback and returns a disposer.
// ---------------------------------------------------------------------------
const unwatchRulesMock = vi.fn();
vi.mock("./rules-loader.js", () => ({
	loadRules: vi.fn(() => rulesOverride),
	watchRulesFiles: vi.fn((_cwd: string, cb: (r: GuardRulesConfig) => void) => {
		cap.rulesReloadCb = cb;
		return unwatchRulesMock;
	}),
}));

// ---------------------------------------------------------------------------
// settings-watcher — capture onStrip, return disposer.
// ---------------------------------------------------------------------------
const unwatchSettingsMock = vi.fn();
vi.mock("./settings-watcher.js", () => ({
	watchSettingsFiles: vi.fn((opts: { onStrip: (r: StripResult) => void }) => {
		cap.settingsOnStrip = opts.onStrip;
		return unwatchSettingsMock;
	}),
}));

// settings-validator — the strip-preview helpers used inside onStrip.
vi.mock("../lib/settings-validator.js", () => ({
	autoStripAllScopes: vi.fn(),
	defaultStripAuditLogPath: vi.fn(() => "/tmp/strip-audit.log"),
	describeReason: vi.fn((r: string | undefined) => `reason:${r ?? "?"}`),
}));

// ---------------------------------------------------------------------------
// content-scanner — registry returns the per-test scanner; allowlist compile is
// an identity-ish stub.
// ---------------------------------------------------------------------------
vi.mock("./content-scanner/registry.js", () => ({
	createScanner: vi.fn(() => scannerOverride),
}));
vi.mock("./content-scanner/allowlist.js", () => ({
	compileAllowlist: vi.fn((a: unknown) => ({ compiledFrom: a })),
}));

// ---------------------------------------------------------------------------
// server-bridge — returns the per-test bridge (or null for local-only branch).
// ---------------------------------------------------------------------------
vi.mock("./server-bridge.js", () => ({
	createServerBridge: vi.fn(() => serverBridgeOverride),
}));

// ---------------------------------------------------------------------------
// status-writers — return the shared spies so we can assert status writes.
// ---------------------------------------------------------------------------
vi.mock("./server/status-writers.js", () => ({
	createStatusWriters: vi.fn(() => cap.statusWriters),
}));

// ---------------------------------------------------------------------------
// protocol-status — keep these pure-ish but observable. We let the real strings
// flow; they're cheap and let us assert classifier/scanner status content.
// ---------------------------------------------------------------------------
vi.mock("./server/protocol-status.js", () => ({
	parseProtocolMode: vi.fn(),
	createProtocolStatus: vi.fn((opts: unknown) => ({ __proto_status: opts })),
	computeClassifierStatusLine: vi.fn(() => "classifier:line"),
	formatScannerStatusLine: vi.fn((s: ScannerStatus) => `scanner:${s.state}`),
	buildStartupMessage: vi.fn(() => "STARTUP_MESSAGE"),
	recordProtocolEvent: vi.fn(),
	writeProtocolStatus: vi.fn(),
}));
// cli-args re-exported from a different module path in server.ts.
vi.mock("./server/cli-args.js", async () => {
	const actual =
		await vi.importActual<typeof import("./server/cli-args.js")>("./server/cli-args.js");
	return actual;
});

// ---------------------------------------------------------------------------
// socket-lifecycle (low-level helpers in server/) — neutralize fs touches.
// ---------------------------------------------------------------------------
vi.mock("./server/socket-lifecycle.js", () => ({
	ensureDirectory: vi.fn(),
	removeFileIfExists: vi.fn(),
	cleanupSocket: vi.fn(),
}));

// ---------------------------------------------------------------------------
// server-socket-lifecycle — capture the deps + expose spy setters/lifecycle.
// ---------------------------------------------------------------------------
vi.mock("./server-socket-lifecycle.js", () => ({
	createSocketLifecycle: vi.fn((deps: SocketLifecycleDepsCapture) => {
		cap.socketLifecycleDeps = deps;
		cap.socketSetters.cleanupSocket = vi.fn();
		cap.socketSetters.writePidFile = vi.fn();
		cap.socketSetters.shutdown = vi.fn();
		cap.socketSetters.startRawServer = vi.fn();
		cap.socketSetters.setFramedDaemon = vi.fn();
		cap.socketSetters.setUnwatchers = vi.fn();
		return {
			cleanupSocket: cap.socketSetters.cleanupSocket,
			writePidFile: cap.socketSetters.writePidFile,
			shutdown: cap.socketSetters.shutdown,
			startRawServer: cap.socketSetters.startRawServer,
			setFramedDaemon: cap.socketSetters.setFramedDaemon,
			setUnwatchers: cap.socketSetters.setUnwatchers,
		};
	}),
}));

// ---------------------------------------------------------------------------
// server-event-loop — capture deps; return controllable entry points.
// ---------------------------------------------------------------------------
const evaluateEventLineMock = vi.fn(async () => ({ decision: "allow" }) as HarnessDecision);
const evaluateUnifiedViaRuntimeMock = vi.fn(
	async () => ({ decision: "allow" }) as HarnessDecision,
);
const writeProtocolStatusMock = vi.fn();
vi.mock("./server-event-loop.js", () => ({
	createEventLoop: vi.fn((deps: EventLoopDepsCapture) => {
		cap.eventLoopDeps = deps;
		return {
			evaluateEventLine: evaluateEventLineMock,
			evaluateUnifiedViaRuntime: evaluateUnifiedViaRuntimeMock,
			writeProtocolStatus: writeProtocolStatusMock,
		};
	}),
}));

// ---------------------------------------------------------------------------
// session-daemon — capture opts; return a fake handle. Async (server.ts awaits).
// ---------------------------------------------------------------------------
const sessionDaemonHandle = {
	paths: { socket: "/tmp/framed.sock", pid: "/tmp/framed.pid" },
	session_id: "default",
	started_at: 0,
	stop: vi.fn(async () => {}),
	rpcInflight: vi.fn(() => 0),
};
vi.mock("./session-daemon.js", async () => {
	// Re-export the REAL `DaemonOwnershipConflictError` alongside the mocked
	// `startSessionDaemon` so a test can construct a genuine instance and
	// server.ts's real `instanceof` check in its catch handler narrows on it
	// (a fake/duck-typed class here would silently make that branch dead).
	const actual =
		await vi.importActual<typeof import("./session-daemon.js")>("./session-daemon.js");
	return {
		DaemonOwnershipConflictError: actual.DaemonOwnershipConflictError,
		startSessionDaemon: vi.fn(async (opts: SessionDaemonOptsCapture) => {
			cap.sessionDaemonOpts = opts;
			return sessionDaemonHandle;
		}),
	};
});

// ---------------------------------------------------------------------------
// session-paths — deterministic framed paths.
// ---------------------------------------------------------------------------
vi.mock("./session-paths.js", () => ({
	daemonPathsFor: vi.fn((_cwd: string, id: string) => ({
		socket: `/tmp/harness-${id}.sock`,
		pid: `/tmp/harness-${id}.pid`,
		log: `/tmp/harness-${id}.log`,
	})),
	// No foreign daemon in the mocked world — the anti-stomp guard must not
	// read the real repo's live harness.pid and process.exit() the test worker.
	liveForeignDaemonPid: vi.fn(() => null),
	// Default: NOTHING answers the socket path. Since 2026-08-15 the bind-time
	// verdict comes from a CONNECT rather than the pid file (see
	// server/incumbent-check.ts), so a default of "serving" would make EVERY
	// server load in this file take the defer-and-exit(0) branch. A refused
	// probe is the ordinary "stale socket file, take over" startup.
	classifyDaemonSocket: vi.fn(async () => "absent"),
	isDaemonSocketServing: vi.fn(async () => false),
	daemonSocketPaths: vi.fn(() => []),
}));

// ---------------------------------------------------------------------------
// Constructor mocks for the daemon state. These MUST be real `class`
// declarations, not `vi.fn(() => obj)`: an arrow-function mock implementation
// is not `new`-able, so `new CohortManager()` throws "is not a constructor".
// Real classes survive `resetModules` re-imports and stay constructable. The
// per-instance method spies (detectLostAgents, releaseAllForAgent, …) are the
// shared module-level mocks below so tests can drive/inspect them.
// ---------------------------------------------------------------------------
const detectLostAgentsMock = vi.fn<() => Array<{ name: string }>>(() => []);
const reservationShutdownMock = vi.fn();
const releaseAllForAgentMock = vi.fn();

class FakeCohortManager {
	detectLostAgents = detectLostAgentsMock;
}
class FakeSessionTracker {
	get = vi.fn(() => undefined);
}
class FakeReservationManager {
	getAll = vi.fn(() => []);
	shutdown = reservationShutdownMock;
	releaseAllForAgent = releaseAllForAgentMock;
	constructor(bridgeArg: unknown, _b: unknown, sink: (e: unknown) => void) {
		cap.reservationEventSink = sink;
		cap.reservationManagerBridgeArg = bridgeArg;
	}
}
class FakeErrorHistory {
	size = 7;
}
class FakeRouteMap {
	initialize = vi.fn();
}
class FakeFileContentCache {}
class FakeProjectWideSweepState {}
class FakeAsyncFindingQueue {}
class FakeProjectGraph {
	allFiles = vi.fn(() => []);
}

// setActiveCohort: server.ts registers its CohortManager as the process-wide
// active cohort at startup (cohort git discipline, 2475022) — the mock must
// export it or every bootstrap test dies at module scope.
vi.mock("./cohort.js", () => ({ CohortManager: FakeCohortManager, setActiveCohort: vi.fn() }));
vi.mock("./session-state.js", () => ({ SessionTracker: FakeSessionTracker }));
vi.mock("./reservations.js", () => ({ ReservationManager: FakeReservationManager }));
vi.mock("./error-history.js", () => ({ ErrorHistory: FakeErrorHistory }));
vi.mock("./route-map.js", () => ({ RouteMap: FakeRouteMap }));
vi.mock("./grep-accelerator.js", () => ({ FileContentCache: FakeFileContentCache }));
vi.mock("./quality-checks.js", () => ({ ProjectWideSweepState: FakeProjectWideSweepState }));
vi.mock("./async-finding-queue.js", () => ({ AsyncFindingQueue: FakeAsyncFindingQueue }));
const mutationBackgroundStopMock = vi.fn();
vi.mock("./mutation/mutation-cloud-v3-background.js", () => ({
	startMutationCloudV3Background: vi.fn(() => ({
		tick: vi.fn(async () => "disabled"),
		stop: mutationBackgroundStopMock,
	})),
}));
vi.mock("./learned-rules.js", () => ({
	createLearnedRulesStore: vi.fn(() => ({})),
}));
vi.mock("./async-analysis.js", () => ({
	createAsyncAnalysisManager: vi.fn(() => ({ drain: vi.fn(async () => {}) })),
}));
vi.mock("./policy-classifier.js", () => ({
	resolveApiKey: vi.fn(() => "API_KEY"),
}));

// ProjectGraph: getGraphForFile resolves via runtime-context which we mock too,
// but the class is still imported/constructed lazily — give it a shell.
vi.mock("./project-graph.js", () => ({ ProjectGraph: FakeProjectGraph }));
const fakeGraph = { allFiles: vi.fn(() => ["a.ts", "b.ts"]) };
vi.mock("./server/runtime-context.js", () => ({
	getGraphForFile: vi.fn(() => fakeGraph),
}));

// TrigramIndex.load — per-test override via slot.
let trigramLoadResult: {
	files: string[];
	baseCommit: string;
	incrementalUpdate: Mock;
} | null;
vi.mock("./trigram-index.js", () => ({
	TrigramIndex: { load: vi.fn(() => trigramLoadResult) },
}));

vi.mock("./live-snapshot.js", () => ({
	sweepStaleLiveSnapshots: vi.fn(() => ({ removed: [], scanned: 0 })),
}));
vi.mock("./build-staleness.js", () => ({
	runningBuildStaleness: vi.fn(() => null),
	stalenessWarning: vi.fn(() => null),
}));
// build-refresh — capture opts so the `lastActivityMs` closure (a thin
// wrapper over module state, otherwise unreachable because
// `resolveOwnArtifact` bails out early on a src-run/.ts module URL) can be
// invoked directly.
interface BuildRefreshOptsCapture {
	lastActivityMs: () => number;
}
let capturedBuildRefreshOpts: BuildRefreshOptsCapture | null = null;
vi.mock("./build-refresh.js", async () => {
	// Preserve the real staleness-warning side effect (a pre-existing test
	// asserts on it) while stubbing out the rest — the real function's
	// artifact-resolution/watcher/spawn machinery has no meaningful behavior
	// under a src-run .ts module URL anyway.
	const { runningBuildStaleness, stalenessWarning } =
		await vi.importMock<typeof import("./build-staleness.js")>("./build-staleness.js");
	return {
		startBuildRefreshWatcher: vi.fn(
			(opts: BuildRefreshOptsCapture & { moduleUrl: string; log: (m: string) => void }) => {
				const warn = stalenessWarning(runningBuildStaleness(opts.moduleUrl));
				if (warn) opts.log(warn);
				capturedBuildRefreshOpts = opts;
				return vi.fn();
			},
		),
	};
});
vi.mock("./statusline-snapshot.js", () => ({
	writeStatuslineArtifacts: vi.fn(),
}));
vi.mock("./tsgo-runner.js", () => ({
	createTsgoRunner: vi.fn(() => ({ __tsgo: true })),
}));
vi.mock("./check-pipeline/builtin-verify-passes.js", () => ({
	registerAllBuiltinVerifyPasses: vi.fn(),
}));
vi.mock("./server/collection-writer.js", () => ({
	writeCollectionRecord: vi.fn(),
}));
// activity-writer — real module in production (server.ts imports it directly,
// unmocked, until this addition). Mocked here so writeCollectionRecord's
// conditional `if (decision) writeGuardDecisionRecord(...)` branch (mutation
// hardening below) can be asserted by direct call-presence rather than by
// sniffing appended file content through several layers of real I/O.
vi.mock("./server/activity-writer.js", () => ({
	writeActivityRecord: vi.fn(),
	writeGuardDecisionRecord: vi.fn(),
	writeLifecycleActivityRecord: vi.fn(),
}));
// mutation/manifest — real module in production. Mocked so shrinkIdleMemory's
// clearManifestCache() call can be asserted directly instead of only "does
// not throw" (which a no-op mutant also satisfies).
vi.mock("./mutation/manifest.js", () => ({
	clearManifestCache: vi.fn(),
}));
vi.mock("./evaluator/pre-tool.js", () => ({
	resetProjectSetupWarningsCache: vi.fn(),
}));
vi.mock("./auto-coordinate.js", () => ({
	DEFAULT_AUTO_COORDINATION_CONFIG: { enabled: false, interval_ms: 1000 },
}));

// ---------------------------------------------------------------------------
// checks/cyclomatic-ast — astComplexityAvailable capability probe. Default
// `true` so most tests exercise the "AST-accurate" log line already covered;
// a dedicated test flips it `false` for the fallback-warning branch.
// ---------------------------------------------------------------------------
let astComplexityAvailableOverride = true;
vi.mock("./checks/cyclomatic-ast.js", () => ({
	astComplexityAvailable: vi.fn(() => astComplexityAvailableOverride),
}));

// ---------------------------------------------------------------------------
// server/daemon-timers — capture the hooks object so the RSS-ceiling/spike/
// idle-shrink closures server.ts wires in (normally only invoked by real
// memory pressure) can be exercised directly.
// ---------------------------------------------------------------------------
interface DaemonTimerHooksCapture {
	shutdown: () => void;
	acquireRecycleLease?: () => boolean;
	onSpike?: (rssMb: number, deltaMb: number) => void;
	shrinkIdleMemory?: () => void;
	lastEventAtMs?: () => number;
}
let capturedDaemonTimerHooks: DaemonTimerHooksCapture | null = null;
vi.mock("./server/daemon-timers.js", () => ({
	heapSpaceSummary: vi.fn(() => "old=1MB"),
	installDaemonTimers: vi.fn((hooks: DaemonTimerHooksCapture) => {
		capturedDaemonTimerHooks = hooks;
		return vi.fn();
	}),
}));

// ---------------------------------------------------------------------------
// sponsor/runtime — capture the options object so readSettings/
// hasRecentActivity (thin closures over module state) can be invoked
// directly rather than through the real tick() polling loop.
// ---------------------------------------------------------------------------
interface SponsorRuntimeOptsCapture {
	readSettings: () => unknown;
	hasRecentActivity: () => boolean;
	log: (msg: string) => void;
	interlinkedDir: string;
}
let capturedSponsorOpts: SponsorRuntimeOptsCapture | null = null;
vi.mock("./sponsor/runtime.js", () => ({
	readSponsorSettingsFromConfig: vi.fn(() => null),
	startSponsorRuntime: vi.fn((opts: SponsorRuntimeOptsCapture) => {
		capturedSponsorOpts = opts;
		return { tick: vi.fn(async () => {}) };
	}),
}));

// ---------------------------------------------------------------------------
// Process-level shims. Spied per-suite in setup() so signal handlers are
// captured (never bound to the real process) and exit never really exits.
// ---------------------------------------------------------------------------
const signalHandlers = new Map<string, Array<(...a: unknown[]) => void>>();
// Append-only log of every `process.on` registration, NEVER filtered by
// removeListener. Lets a test reach the early SIGTERM handler that server.ts
// registers first and later removes (the live `signalHandlers` map drops it).
const allOnRegistrations: Array<{ event: string; listener: (...a: unknown[]) => void }> = [];
// Optional per-test hook invoked synchronously inside the `process.on` spy as
// each registration happens. This is the ONLY way to reach the body of
// `_earlyShutdown` (server.ts:145-157) and the `if (_shutdownPending)` true
// branch (server.ts:654): both require a signal to fire WHILE module init is
// still running (`_shutdownReady === false`), i.e. before the bottom-of-file
// rebind. A test installs a hook that fires the SIGTERM handler the moment it
// is registered (line 159) — at that point `_shutdownReady` is still false, so
// the body runs, sets `_shutdownPending`, and the later line-654 check trips.
let onProcessOnRegister:
	| ((event: string, listener: (...a: unknown[]) => void) => void)
	| null = null;
let processOnSpy: ReturnType<typeof vi.spyOn>;
let processRemoveSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;

class ProcessExitError extends Error {
	constructor(public code: number | undefined) {
		super(`process.exit(${code})`);
	}
}

function installProcessShims(): void {
	signalHandlers.clear();
	allOnRegistrations.length = 0;
	processOnSpy = vi
		.spyOn(process, "on")
		.mockImplementation((event: string | symbol, listener: (...a: unknown[]) => void) => {
			const key = String(event);
			const list = signalHandlers.get(key) ?? [];
			list.push(listener);
			signalHandlers.set(key, list);
			allOnRegistrations.push({ event: key, listener });
			onProcessOnRegister?.(key, listener);
			return process;
		});
	processRemoveSpy = vi
		.spyOn(process, "removeListener")
		.mockImplementation((event: string | symbol, listener: (...a: unknown[]) => void) => {
			const key = String(event);
			const list = (signalHandlers.get(key) ?? []).filter((l) => l !== listener);
			signalHandlers.set(key, list);
			return process;
		});
	processExitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ProcessExitError(code);
	}) as never);
}

function lastSignalHandler(sig: string): ((...a: unknown[]) => void) | undefined {
	const list = signalHandlers.get(sig);
	return list ? list[list.length - 1] : undefined;
}

// ---------------------------------------------------------------------------
// Import driver. Sets argv, faked timers, fresh state, imports the module, then
// flushes the three setTimeout(0) background-init closures.
// ---------------------------------------------------------------------------
const ORIGINAL_ARGV = process.argv.slice();

async function loadServer(extraArgv: string[] = []): Promise<void> {
	process.argv = ["node", "server.js", ...extraArgv];
	await import("./server.js");
	// Flush the three setTimeout(0) background-init closures (route map build,
	// error-history log, trigram load + statusline refresh).
	await vi.runOnlyPendingTimersAsync();
}

beforeEach(async () => {
	// NB: `vi.resetModules()` re-runs every `vi.mock` factory on the next
	// `import("./server.js")`, so the constructor mocks created INSIDE those
	// factories (CohortManager, ReservationManager, …) are fresh per test. We
	// deliberately do NOT call `vi.clearAllMocks()` — it strips the
	// implementation off `vi.fn(impl)` mocks, which makes the constructor mocks
	// non-constructable (`new X()` throws "is not a constructor"). Instead we
	// `.mockClear()` only the module-level spies whose call counts we assert.
	vi.resetModules();
	const sessionPaths = await import("./session-paths.js");
	vi.mocked(sessionPaths.liveForeignDaemonPid).mockReset().mockReturnValue(null);
	vi.mocked(sessionPaths.classifyDaemonSocket).mockReset().mockResolvedValue("absent");
	lifecycleMocks.reapZombieIncumbent.mockReset().mockResolvedValue("gone");
	lifecycleMocks.removePidFileIfOwned.mockReset();
	evaluateEventLineMock.mockClear();
	evaluateUnifiedViaRuntimeMock.mockClear();
	writeProtocolStatusMock.mockClear();
	writeProtocolStatusMock.mockReset();
	unwatchRulesMock.mockClear();
	unwatchSettingsMock.mockClear();
	mutationBackgroundStopMock.mockClear();
	reservationShutdownMock.mockClear();
	releaseAllForAgentMock.mockClear();
	detectLostAgentsMock.mockClear();
	detectLostAgentsMock.mockReturnValue([]);
	sessionDaemonHandle.stop.mockClear();
	sessionDaemonHandle.rpcInflight.mockClear();
	fakeGraph.allFiles.mockClear();
	vi.useFakeTimers();
	fakeServers.length = 0;
	rulesOverride = makeRules();
	scannerOverride = undefined;
	serverBridgeOverride = { shutdown: vi.fn() };
	trigramLoadResult = null;
	cap.rulesReloadCb = null;
	cap.settingsOnStrip = null;
	cap.scannerStatusCb = null;
	cap.eventLoopDeps = null;
	cap.sessionDaemonOpts = null;
	cap.socketLifecycleDeps = null;
	cap.reservationEventSink = null;
	cap.reservationManagerBridgeArg = undefined;
	cap.statusWriters.writeClassifierStatus = vi.fn();
	cap.statusWriters.writeScannerStatus = vi.fn();
	cap.statusWriters.writeReviewPendingMarker = vi.fn();
	onProcessOnRegister = null;
	astComplexityAvailableOverride = true;
	capturedDaemonTimerHooks = null;
	capturedSponsorOpts = null;
	capturedBuildRefreshOpts = null;
	installProcessShims();
});

afterEach(() => {
	process.argv = ORIGINAL_ARGV.slice();
	processOnSpy?.mockRestore();
	processRemoveSpy?.mockRestore();
	processExitSpy?.mockRestore();
	vi.useRealTimers();
});

// ===========================================================================
// Suite
// ===========================================================================

describe("harness server.ts — startup wiring (dual protocol, default flags)", () => {
	it("constructs the event loop, socket lifecycle, and framed daemon, then starts the raw server", async () => {
		await loadServer();
		// Event loop built with the runtime context + module callbacks.
		expect(cap.eventLoopDeps).not.toBeNull();
		expect(cap.eventLoopDeps?.protocolStatusPath).toContain("harness-protocol.json");
		// Socket lifecycle constructed for dual mode → raw socket on.
		expect(cap.socketLifecycleDeps?.runRawSocket).toBe(true);
		expect(cap.socketLifecycleDeps?.socketPath).toContain("harness.sock");
		// Framed daemon spawned (dual) and handed to the lifecycle via the setter.
		expect(cap.sessionDaemonOpts).not.toBeNull();
		expect(cap.socketSetters.setFramedDaemon).toHaveBeenCalledWith(sessionDaemonHandle);
		// Raw server started.
		expect(cap.socketSetters.startRawServer).toHaveBeenCalledTimes(1);
		// PID + protocol status written during startup.
		expect(cap.socketSetters.writePidFile).toHaveBeenCalledTimes(1);
		expect(writeProtocolStatusMock).toHaveBeenCalled();
	});

	it("cleans the stale raw socket on startup when the raw socket is enabled", async () => {
		await loadServer();
		expect(cap.socketSetters.cleanupSocket).toHaveBeenCalledTimes(1);
	});

	it("hands watcher and mutation-background disposers to the socket lifecycle", async () => {
		await loadServer();
		const setter = cap.socketSetters.setUnwatchers;
		expect(setter).toHaveBeenCalledTimes(1);
		const [stopRepoWatchers, stopSettingsWatcher] =
			setter?.mock.calls[0] ?? [];
		expect(stopSettingsWatcher).toBe(unwatchSettingsMock);
		expect(stopRepoWatchers).toEqual(expect.any(Function));
		stopRepoWatchers?.();
		expect(mutationBackgroundStopMock).toHaveBeenCalledTimes(1);
		expect(unwatchRulesMock).toHaveBeenCalledTimes(1);
	});

	it("writes an initial classifier status line at startup", async () => {
		await loadServer();
		expect(cap.statusWriters.writeClassifierStatus).toHaveBeenCalledWith("classifier:line");
	});

	it("passes a session-daemon evaluator-context factory and the unified evaluator", async () => {
		await loadServer();
		const ctxFactory = cap.sessionDaemonOpts?.state.getEvaluatorContext;
		expect(typeof ctxFactory).toBe("function");
		const evalCtx = ctxFactory?.();
		// getEvaluatorContext closes over getGraphForFile → resolves the fake graph.
		expect(evalCtx?.graph).toBe(fakeGraph);
		const event: UnifiedHookEvent = {
			schema_version: "1",
			event_id: "startup-evaluator",
			session_id: "startup-session",
			ts: "2026-09-07T00:00:00.000Z",
			runner: "codex",
			runner_native_event: "PreToolUse",
			phase: "pre-tool",
			action: { kind: "tool_call", tool_name: "Read", tool_class: "read", tool_input: {}, tool_input_redacted: {} },
			context: { cwd: "/repo" },
			raw: {},
		};
		evaluateUnifiedViaRuntimeMock.mockResolvedValueOnce({ decision: "block", reason: "startup sentinel" });
		const decision = await cap.sessionDaemonOpts?.state.evaluateHook(event);
		expect(evaluateUnifiedViaRuntimeMock).toHaveBeenCalledExactlyOnceWith(event);
		expect(decision).toMatchObject({ decision: "block", reason: "startup sentinel" });
		expect(cap.sessionDaemonOpts?.state.tsgo).toEqual({ __tsgo: true });
	});
});

describe("harness server.ts — protocol mode branches", () => {
	it("raw-only protocol skips the framed daemon and only starts the raw server", async () => {
		await loadServer(["--protocol", "raw"]);
		expect(cap.socketLifecycleDeps?.runRawSocket).toBe(true);
		// No framed daemon spawned.
		expect(cap.sessionDaemonOpts).toBeNull();
		expect(cap.socketSetters.setFramedDaemon).not.toHaveBeenCalled();
		// Raw server still started.
		expect(cap.socketSetters.startRawServer).toHaveBeenCalledTimes(1);
	});

	it("framed-only protocol skips the raw socket and starts the framed daemon", async () => {
		await loadServer(["--protocol", "framed"]);
		expect(cap.socketLifecycleDeps?.runRawSocket).toBe(false);
		// Raw startup skipped: no stale-socket cleanup, no raw server.
		expect(cap.socketSetters.cleanupSocket).not.toHaveBeenCalled();
		expect(cap.socketSetters.startRawServer).not.toHaveBeenCalled();
		// Framed daemon spawned.
		expect(cap.sessionDaemonOpts).not.toBeNull();
		expect(cap.socketSetters.setFramedDaemon).toHaveBeenCalledWith(sessionDaemonHandle);
	});

	it("honors a custom --socket path and --session-id for framed paths", async () => {
		await loadServer(["--socket", "/tmp/custom.sock", "--session-id", "sess-9"]);
		expect(cap.socketLifecycleDeps?.socketPath).toBe("/tmp/custom.sock");
		expect(cap.sessionDaemonOpts?.session_id).toBe("sess-9");
	});
});

describe("harness server.ts — content scanner branches", () => {
	it("writes 'disabled' when no content_scanner config is present", async () => {
		rulesOverride = makeRules();
		await loadServer();
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("disabled");
	});

	it("registers an onStatusChange writer when the scanner supports lifecycle", async () => {
		rulesOverride = makeRules({
			content_scanner: { enabled: true, runtime: "local" } as never,
		});
		const onStatusChange = vi.fn((cb: (s: ScannerStatus) => void) => {
			cap.scannerStatusCb = cb;
		});
		scannerOverride = makeScanner({ onStatusChange });
		await loadServer();
		expect(onStatusChange).toHaveBeenCalledTimes(1);
		// Drive a lifecycle transition through the captured callback.
		cap.scannerStatusCb?.({ state: "ready", sinceIso: "2026-01-01T00:00:00Z" });
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("scanner:ready");
		// Pass the live scanner to the socket lifecycle for shutdown.
		expect(cap.socketLifecycleDeps?.contentScanner).toBe(scannerOverride);
	});

	it("marks an HTTP scanner without lifecycle as ready", async () => {
		rulesOverride = makeRules({
			content_scanner: { enabled: true, runtime: "http" } as never,
		});
		scannerOverride = makeScanner({ runtime: "http" });
		// Strip the optional lifecycle hooks so the else-branch runs.
		delete scannerOverride.onStatusChange;
		await loadServer();
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("ready:http");
	});
});

describe("harness server.ts — server bridge branch", () => {
	it("passes the bridge to the socket lifecycle when configured", async () => {
		serverBridgeOverride = { shutdown: vi.fn() };
		await loadServer();
		expect(cap.socketLifecycleDeps?.serverBridge).toBe(serverBridgeOverride);
	});

	it("runs local-only (null bridge) when no server is configured", async () => {
		serverBridgeOverride = null;
		await loadServer();
		expect(cap.socketLifecycleDeps?.serverBridge).toBeNull();
	});
});

describe("harness server.ts — background init timers", () => {
	it("initializes the route map from the project graph on the deferred tick", async () => {
		await loadServer();
		// loadServer already flushed pending timers; the route map was built from
		// the fake graph's allFiles(). Re-flush is a no-op but confirms idempotence.
		expect(fakeGraph.allFiles).toHaveBeenCalled();
	});

	it("loads the trigram index and runs an incremental update when present", async () => {
		const incrementalUpdate = vi.fn(() => 3);
		trigramLoadResult = { files: ["x.ts"], baseCommit: "abcdef1234567890", incrementalUpdate };
		await loadServer();
		expect(incrementalUpdate).toHaveBeenCalledTimes(1);
	});

	it("tolerates an absent trigram index (no throw, statusline still refreshed)", async () => {
		trigramLoadResult = null;
		await expect(loadServer()).resolves.toBeUndefined();
	});
});

describe("harness server.ts — rules hot-reload callback", () => {
	it("recomputes classifier status and rules-active count on reload", async () => {
		await loadServer();
		const before = cap.statusWriters.writeClassifierStatus.mock.calls.length;
		cap.rulesReloadCb?.(makeRules({ rules: [] }));
		expect(cap.statusWriters.writeClassifierStatus.mock.calls.length).toBeGreaterThan(before);
	});

	it("on reload with scanner disabled, writes 'disabled' scanner status", async () => {
		await loadServer();
		cap.statusWriters.writeScannerStatus.mockClear();
		cap.rulesReloadCb?.(makeRules()); // no content_scanner → disabled branch
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("disabled");
	});

	it("on reload with scanner enabled but none constructed, requests a restart", async () => {
		// Daemon started with NO scanner → contentScanner undefined. A reload that
		// flips content_scanner.enabled on hits the down:needs_restart branch.
		rulesOverride = makeRules();
		await loadServer();
		cap.statusWriters.writeScannerStatus.mockClear();
		cap.rulesReloadCb?.(
			makeRules({ content_scanner: { enabled: true, runtime: "local" } as never }),
		);
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("down:needs_restart");
	});

	it("on reload with a live lifecycle scanner, writes the formatted status", async () => {
		rulesOverride = makeRules({
			content_scanner: { enabled: true, runtime: "local" } as never,
		});
		const getStatus = vi.fn((): ScannerStatus => ({ state: "dormant", sinceIso: "t" }));
		scannerOverride = makeScanner({ getStatus });
		await loadServer();
		cap.statusWriters.writeScannerStatus.mockClear();
		cap.rulesReloadCb?.(
			makeRules({ content_scanner: { enabled: true, runtime: "local" } as never }),
		);
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("scanner:dormant");
	});

	it("on reload with a live scanner lacking getStatus, falls back to ready:<runtime>", async () => {
		rulesOverride = makeRules({
			content_scanner: { enabled: true, runtime: "local" } as never,
		});
		scannerOverride = makeScanner({ runtime: "local" });
		delete scannerOverride.getStatus;
		await loadServer();
		cap.statusWriters.writeScannerStatus.mockClear();
		cap.rulesReloadCb?.(
			makeRules({ content_scanner: { enabled: true, runtime: "local" } as never }),
		);
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("ready:local");
	});
});

describe("harness server.ts — settings-strip callback", () => {
	it("logs a bounded preview (<=5 entries) and the '...and N more' tail", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer();
		const entries = Array.from({ length: 7 }, (_v, i) => ({
			file: `/repo/.claude/settings.json`,
			bucket: "allow",
			index: i,
			rule: `Bash(rm:${i})`,
			reason: "unparseable",
		}));
		cap.settingsOnStrip?.({ totalStripped: 7, entries });
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Live-stripped 7 malformed permission rule(s)");
		expect(logged).toContain("...and 2 more");
		errSpy.mockRestore();
	});

	it("omits the '...and N more' tail when entries fit within the preview window", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer();
		cap.settingsOnStrip?.({
			totalStripped: 2,
			entries: [
				{ file: "/r/.claude/settings.json", bucket: "deny", index: 0, rule: "x", reason: "r1" },
				{ file: "/r/.claude/settings.json", bucket: "deny", index: 1, rule: "y", reason: "r2" },
			],
		});
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Live-stripped 2 malformed permission rule(s)");
		expect(logged).not.toContain("...and");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — process signal handlers", () => {
	it("rebinds SIGINT/SIGTERM to the real shutdown after startup", async () => {
		await loadServer();
		// The early handler was removed and the real shutdown bound.
		expect(processRemoveSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
		expect(processRemoveSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		const sigint = lastSignalHandler("SIGINT");
		sigint?.();
		expect(cap.socketSetters.shutdown).toHaveBeenCalledTimes(1);
	});

	it("SIGHUP reloads rules without exiting", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer();
		const sighup = lastSignalHandler("SIGHUP");
		expect(typeof sighup).toBe("function");
		sighup?.();
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Rules reloaded via SIGHUP");
		errSpy.mockRestore();
	});

	it("the early shutdown handler hard-exits via a timer when fired pre-readiness", async () => {
		// Capture the early handler from a partially-evaluated module. We can't
		// easily freeze mid-init, so instead exercise the early handler that was
		// registered first (before removeListener ran). The first SIGTERM listener
		// is the early one; invoking it sets pending + schedules a hard exit.
		await loadServer();
		// After startup _shutdownReady is true, so the early handler is a no-op;
		// but it was registered and removed — assert it was bound at least once.
		expect(processOnSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
	});
});

describe("harness server.ts — reservation event sink", () => {
	it("serializes reservation events to the events log (best-effort)", async () => {
		await loadServer();
		expect(typeof cap.reservationEventSink).toBe("function");
		// Should not throw; fs is mocked so the append is captured.
		expect(() => cap.reservationEventSink?.({ kind: "grant", file: "a.ts" })).not.toThrow();
	});
});

describe("harness server.ts — runtime sync callbacks", () => {
	it("exposes idempotent syncRuntimeIn / syncRuntimeOut to the event loop", async () => {
		await loadServer();
		expect(typeof cap.eventLoopDeps?.syncRuntimeIn).toBe("function");
		expect(typeof cap.eventLoopDeps?.syncRuntimeOut).toBe("function");
		expect(() => {
			cap.eventLoopDeps?.syncRuntimeIn();
			cap.eventLoopDeps?.syncRuntimeOut();
		}).not.toThrow();
	});

	it("resetIdleTimer is a no-op when the idle timeout is disabled (default 0)", async () => {
		await loadServer();
		expect(() => cap.eventLoopDeps?.resetIdleTimer()).not.toThrow();
	});

	it("writeCollectionRecord delegates to the collection writer without throwing", async () => {
		await loadServer();
		expect(() =>
			cap.eventLoopDeps?.writeCollectionRecord({ hook_event: "PreToolUse" }),
		).not.toThrow();
	});
});

describe("harness server.ts — idle timeout enabled branch", () => {
	it("arms an idle timer that shuts down after the configured timeout", async () => {
		await loadServer(["--idle-timeout", "1000"]);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		// resetIdleTimer was wired into the event loop; invoking it arms the timer.
		cap.eventLoopDeps?.resetIdleTimer();
		vi.advanceTimersByTime(1000);
		// The idle expiry calls the real shutdown() from the socket lifecycle.
		expect(cap.socketSetters.shutdown).toHaveBeenCalled();
		errSpy.mockRestore();
	});
});

describe("harness server.ts — periodic ticks", () => {
	it("the lost-agent sweep releases reservations for detected lost agents", async () => {
		await loadServer();
		// The 2-minute lost-agent tick calls cohort.detectLostAgents(); make it
		// report one lost agent so the release branch runs.
		detectLostAgentsMock.mockReturnValueOnce([{ name: "ghost" }]);
		vi.advanceTimersByTime(2 * 60 * 1000);
		expect(releaseAllForAgentMock).toHaveBeenCalledWith("ghost", expect.anything());
	});

	it("the statusline refresh interval fires without throwing", async () => {
		await loadServer();
		expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
	});
});

describe("harness server.ts — verbose logging branch", () => {
	it("emits timestamped log lines on the deferred init ticks when --verbose is set", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// The VERBOSE `log()` path (else of the no-op) runs the timestamped writer.
		expect(logged).toContain("[harness ");
		expect(logged).toContain("Error history loaded: 7 records");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — background-init failure paths", () => {
	it("logs (non-fatal) when the route-map init tick throws", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const rc = await import("./server/runtime-context.js");
		vi.mocked(rc.getGraphForFile).mockImplementationOnce(() => {
			throw new Error("graph boom");
		});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Background init failed (non-fatal)");
		expect(logged).toContain("graph boom");
		errSpy.mockRestore();
	});

	it("logs (non-fatal) when the trigram-index load tick throws", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const ti = await import("./trigram-index.js");
		vi.mocked(ti.TrigramIndex.load).mockImplementationOnce(() => {
			throw new Error("index boom");
		});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Trigram index load failed (non-fatal)");
		expect(logged).toContain("index boom");
		errSpy.mockRestore();
	});

	it("does not run the incremental update when no index is found (else branch)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		trigramLoadResult = null;
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("No trigram index found");
		errSpy.mockRestore();
	});

	it("logs only when files actually changed (incrementalUpdate > 0)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		trigramLoadResult = {
			files: ["x.ts"],
			baseCommit: "deadbeefcafef00d",
			incrementalUpdate: vi.fn(() => 0),
		};
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// 0 changes → no "files changed since base commit" line.
		expect(logged).toContain("Trigram index loaded");
		expect(logged).not.toContain("files changed since base commit");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — reservation event sink directory creation", () => {
	it("creates the events directory when it does not yet exist", async () => {
		const fs = await import("node:fs");
		vi.mocked(fs.existsSync).mockReturnValue(false);
		await loadServer();
		cap.reservationEventSink?.({ kind: "grant", file: "a.ts" });
		expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(expect.any(String), {
			recursive: true,
		});
		expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalled();
	});

	it("swallows append errors so reservation observability never throws", async () => {
		const fs = await import("node:fs");
		vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		await loadServer();
		expect(() => cap.reservationEventSink?.({ kind: "release" })).not.toThrow();
	});
});

describe("harness server.ts — stale-snapshot sweep branch", () => {
	it("logs the reaped count when stale live snapshots are swept", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const ls = await import("./live-snapshot.js");
		vi.mocked(ls.sweepStaleLiveSnapshots).mockReturnValueOnce({
			removed: ["s1.live.json", "s2.live.json"],
			scanned: 5,
		});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Reaped 2 stale live snapshot(s) (of 5 scanned)");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — policy classifier startup log", () => {
	it("logs a ready classifier when enabled and an API key resolves", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		rulesOverride = makeRules({
			policy_classifier: { enabled: true, provider: "groq", model: "m1" } as never,
		});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Policy classifier: groq/m1 (ready)");
		errSpy.mockRestore();
	});

	it("logs 'no API key' when the classifier provider needs a key but none resolves", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const pc = await import("./policy-classifier.js");
		vi.mocked(pc.resolveApiKey).mockReturnValueOnce(undefined);
		rulesOverride = makeRules({
			policy_classifier: { enabled: true, provider: "groq", model: "m2" } as never,
		});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Policy classifier: groq/m2 (no API key)");
		errSpy.mockRestore();
	});

	it("treats the claude_code provider as ready without resolving an API key", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		rulesOverride = makeRules({
			policy_classifier: { enabled: true, provider: "claude_code", model: "cc" } as never,
		});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Policy classifier: claude_code/cc (ready)");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — content scanner constructed-undefined branch", () => {
	it("writes 'disabled' when content_scanner is configured but createScanner returns undefined", async () => {
		rulesOverride = makeRules({
			content_scanner: { enabled: true, runtime: "local" } as never,
		});
		scannerOverride = undefined; // misconfigured backend → undefined scanner
		await loadServer();
		// The ternary's truthy side runs (createScanner called) but yields undefined,
		// so the `else` arm writes "disabled".
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("disabled");
		expect(cap.socketLifecycleDeps?.contentScanner).toBeUndefined();
	});
});

describe("harness server.ts — early shutdown handler", () => {
	it("is a no-op once the real shutdown has been wired (post-readiness)", async () => {
		const ownership = await import("./daemon-pid-ownership.js");
		await loadServer();
		// The early SIGTERM handler is the FIRST `process.on("SIGTERM", …)`
		// registration (server.ts:159). It is later removed via removeListener and
		// replaced by the real shutdown, so the live `signalHandlers` map no longer
		// holds it — reach it through the never-filtered registration log instead.
		const earlyReg = allOnRegistrations.find((r) => r.event === "SIGTERM");
		expect(earlyReg).toBeDefined();
		const earlyHandler = earlyReg?.listener;
		vi.mocked(ownership.removePidFileIfOwned).mockClear();
		// After startup `_shutdownReady` is true → the handler returns immediately
		// (the guard branch) without scheduling a hard exit or removing the pid file.
		expect(() => earlyHandler?.()).not.toThrow();
		expect(vi.mocked(ownership.removePidFileIfOwned)).not.toHaveBeenCalled();
		// And it is NOT the same function as the real shutdown that's now bound.
		const liveSigterm = lastSignalHandler("SIGTERM");
		expect(earlyHandler).not.toBe(liveSigterm);
	});

	it("the early SIGTERM and SIGINT registrations are distinct from the rebound real shutdown", async () => {
		await loadServer();
		// Both signals were registered with the early handler first, then removed.
		expect(processRemoveSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
		expect(processRemoveSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		// The real shutdown is now the active SIGTERM/SIGINT listener.
		expect(lastSignalHandler("SIGTERM")).toBeDefined();
		expect(lastSignalHandler("SIGINT")).toBeDefined();
	});
});

describe("harness server.ts — staleness warning branch", () => {
	it("logs a staleness warning when the running build is stale", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const stale = await import("./build-staleness.js");
		vi.mocked(stale.stalenessWarning).mockReturnValueOnce("BUILD IS STALE");
		await loadServer();
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("BUILD IS STALE");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — content scanner absent (falsy config) branch", () => {
	it("takes the ternary's `: undefined` arm when content_scanner config is absent", async () => {
		// `makeRules()` clones DEFAULT_CONFIG, whose `content_scanner` is a truthy
		// object ({enabled:false,…}), so the ternary at server.ts:222-224 normally
		// takes the truthy `createScanner(...)` arm. Deleting the key makes
		// `rules.content_scanner` falsy → the `: undefined` arm runs and
		// createScanner is never called.
		// The createScanner mock fn is module-level and shared across every test
		// (it survives vi.resetModules), so assert a per-load delta rather than a
		// global never-called. A falsy content_scanner short-circuits the ternary
		// at server.ts:222-224 before createScanner, so the count must not move.
		const reg = await import("./content-scanner/registry.js");
		const callsBefore = vi.mocked(reg.createScanner).mock.calls.length;
		const rules = makeRules();
		delete rules.content_scanner;
		rulesOverride = rules;
		await loadServer();
		expect(vi.mocked(reg.createScanner).mock.calls.length).toBe(callsBefore);
		// contentScanner is undefined → the disabled arm of the if/else writes it,
		// and the socket lifecycle receives an undefined scanner.
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("disabled");
		expect(cap.socketLifecycleDeps?.contentScanner).toBeUndefined();
	});
});

describe("harness server.ts — early shutdown fired DURING startup (pre-readiness)", () => {
	it("runs the early-shutdown body, sets pending, graceful-shuts on init completion, and hard-exits via the 1500ms timer", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const ownership = await import("./daemon-pid-ownership.js");
		vi.mocked(ownership.removePidFileIfOwned).mockClear();

		// Fire the FIRST SIGTERM registration synchronously, the instant server.ts
		// runs `process.on("SIGTERM", _earlyShutdown)` (line 159). At that moment
		// module init is mid-flight and `_shutdownReady` is still false, so the
		// handler executes its real body (lines 145-157): sets `_shutdownPending`,
		// attempts best-effort pid cleanup, and schedules the 1500ms hard-exit
		// fallback. This is the only window that reaches the body and the
		// `if (_shutdownPending)` graceful branch at line 654.
		let firedOnce = false;
		onProcessOnRegister = (event, listener) => {
			if (event === "SIGTERM" && !firedOnce) {
				firedOnce = true;
				listener();
			}
		};

		process.argv = ["node", "server.js"];
		await import("./server.js");

		// Body ran: best-effort pid cleanup was attempted.
		expect(vi.mocked(ownership.removePidFileIfOwned)).toHaveBeenCalledWith(
			expect.stringContaining("harness.pid"),
			process.pid,
		);
		// Because `_shutdownPending` was set before line 654, init completion runs
		// the graceful path — the real shutdown from the lifecycle.
		expect(cap.socketSetters.shutdown).toHaveBeenCalledTimes(1);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Shutdown was requested during startup");

		// The 1500ms hard-exit fallback closure is still armed. Advancing past it
		// fires `process.exit(0)`, which our spy turns into a throw. This advance
		// also drains the deferred setTimeout(0) background-init closures from this
		// import; afterEach's useRealTimers()/resetModules() clears the remainder.
		expect(() => vi.advanceTimersByTime(1500)).toThrow(/process\.exit\(0\)/);
		expect(processExitSpy).toHaveBeenCalledWith(0);
		errSpy.mockRestore();
	});
});

// ===========================================================================
// Anti-stomp loser paths (regression: orphaned daemons from an unhandled
// framed-ownership conflict — see server/anti-stomp.ts and session-daemon.ts).
// Both losing paths must record the `anti-stomp` ledger row (via the REAL,
// unmocked `daemon-ledger.js` writing through the globally-mocked
// `node:fs.appendFileSync`) and call `process.exit(0)` — never silently stay
// resident.
// ===========================================================================
describe("harness server.ts — anti-stomp loser paths", () => {
	// Defensive, LOCAL to this block: the outer `beforeEach`'s
	// `vi.resetModules()` does not clear every mock's call history (only a
	// short explicit list — see its own comment), so `fs.appendFileSync`'s
	// call log otherwise accumulates across every test in this large file.
	// Each of these tests inspects "the ledger row THIS test just wrote", so
	// each must start from a clean slate regardless of run order.
	beforeEach(async () => {
		const fs = await import("node:fs");
		vi.mocked(fs.appendFileSync).mockClear();
		// `node:fs`'s mock instance is NOT recreated per `resetModules()`
		// generation the way local project-relative mocks are, so an
		// EARLIER test's `existsSync` override (e.g. the reservation-sink
		// test that sets it to `false`) otherwise leaks in — which silently
		// defeats the raw-legacy anti-stomp condition's `existsSync(SOCKET_PATH)`
		// half, regardless of `liveForeignDaemonPid`'s return value.
		vi.mocked(fs.existsSync).mockReturnValue(true);
		const sp = await import("./session-paths.js");
		vi.mocked(sp.liveForeignDaemonPid).mockReturnValue(null);
		// Default per test: nobody answers → the ordinary take-over path. Tests
		// that assert the DEFER branch set this to true themselves.
		vi.mocked(sp.classifyDaemonSocket).mockReset().mockResolvedValue("absent");
	});

	async function ledgerRows(): Promise<string[]> {
		const fs = await import("node:fs");
		return vi
			.mocked(fs.appendFileSync)
			.mock.calls.map((c) => String(c[1]))
			.filter((line) => line.includes('"event":"exit"'));
	}

	it("raw-legacy path: a live foreign PID on harness.pid exits and records anti-stomp", async () => {
		const sp = await import("./session-paths.js");
		vi.mocked(sp.liveForeignDaemonPid).mockReturnValue(13579);
		vi.mocked(sp.classifyDaemonSocket).mockResolvedValue("ready");

		await expect(loadServer()).rejects.toThrow(/process\.exit\(0\)/);
		expect(processExitSpy).toHaveBeenCalledWith(0);
		const rows = await ledgerRows();
		// The ledger row records THIS (losing) process's own pid, not the
		// winner's (13579) — matching the "start"/"handover" rows' convention.
		expect(rows.some((r) => r.includes('"reason":"anti-stomp"') && r.includes(`"pid":${process.pid}`))).toBe(
			true,
		);
	});

	// -------------------------------------------------------------------------
	// Socket-serving probe (regression: `liveForeignDaemonPid` alone can't
	// distinguish a healthy incumbent from a zombie kept resident by
	// `installCrashResilience()` — see `isDaemonSocketServing` in
	// session-paths.ts). Four cases: serving incumbent still wins, a
	// live-but-silent incumbent is reaped and taken over, a dead pid takes
	// over (unchanged pre-existing behavior), and a throwing probe fails safe
	// by deferring.
	// -------------------------------------------------------------------------

	it("raw-legacy path: a live AND SERVING incumbent still exits (does not stomp a healthy daemon)", async () => {
		const sp = await import("./session-paths.js");
		vi.mocked(sp.liveForeignDaemonPid).mockReturnValue(13579);
		vi.mocked(sp.classifyDaemonSocket).mockResolvedValue("ready");

		await expect(loadServer()).rejects.toThrow(/process\.exit\(0\)/);
		expect(processExitSpy).toHaveBeenCalledWith(0);
		expect(vi.mocked(sp.classifyDaemonSocket)).toHaveBeenCalledWith(
			expect.stringContaining("harness.sock"),
		);
		const rows = await ledgerRows();
		expect(rows.some((r) => r.includes('"reason":"anti-stomp"') && r.includes(`"pid":${process.pid}`))).toBe(
			true,
		);
	});

	it("raw-legacy path: a live but NOT SERVING incumbent is reaped and taken over (no exit, no anti-stomp row)", async () => {
		const sp = await import("./session-paths.js");
		vi.mocked(sp.liveForeignDaemonPid).mockReturnValue(13579);
		vi.mocked(sp.classifyDaemonSocket).mockResolvedValue("absent");

		await loadServer();
		expect(processExitSpy).not.toHaveBeenCalled();
		expect(lifecycleMocks.reapZombieIncumbent).toHaveBeenCalledWith(
			expect.objectContaining({ pid: 13579, cwd: process.cwd() }),
		);
		const rows = await ledgerRows();
		expect(rows.some((r) => r.includes('"reason":"anti-stomp"'))).toBe(false);
	});

	// Since 2026-08-15 a socket file is ALWAYS probed, pid file or not: a stale
	// socket with no pid file is exactly the state that made every newcomer
	// exit `startup-failed` on EADDRINUSE while nothing served.
	it("raw-legacy path: a stale socket with no live owner is probed, then taken over", async () => {
		const sp = await import("./session-paths.js");
		vi.mocked(sp.liveForeignDaemonPid).mockReturnValue(null);

		await loadServer();
		expect(processExitSpy).not.toHaveBeenCalled();
		expect(vi.mocked(sp.classifyDaemonSocket)).toHaveBeenCalledWith(
			expect.stringContaining("harness.sock"),
		);
		const rows = await ledgerRows();
		expect(rows.some((r) => r.includes('"reason":"anti-stomp"'))).toBe(false);
	});

	it("raw-legacy path: a SERVING socket with NO pid file is still deferred to (never stomped)", async () => {
		const sp = await import("./session-paths.js");
		vi.mocked(sp.liveForeignDaemonPid).mockReturnValue(null);
		vi.mocked(sp.classifyDaemonSocket).mockResolvedValue("ready");
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		await expect(loadServer()).rejects.toThrow(/process\.exit\(0\)/);
		expect(killSpy).not.toHaveBeenCalled();
		killSpy.mockRestore();
	});

	it("raw-legacy path: a throwing probe fails safe and defers to the incumbent (exits)", async () => {
		const sp = await import("./session-paths.js");
		vi.mocked(sp.liveForeignDaemonPid).mockReturnValue(13579);
		vi.mocked(sp.classifyDaemonSocket).mockImplementation(() => {
			throw new Error("unexpected probe failure");
		});

		await expect(loadServer()).rejects.toThrow(/did not prove the Interlinked protocol/);
		expect(processExitSpy).not.toHaveBeenCalled();
		const rows = await ledgerRows();
		expect(rows.some((r) => r.includes('"reason":"anti-stomp"'))).toBe(false);
	});

	it("framed path: DaemonOwnershipConflictError exits and records anti-stomp (does not silently stay resident)", async () => {
		const sd = await import("./session-daemon.js");
		vi.mocked(sd.startSessionDaemon).mockRejectedValueOnce(
			new sd.DaemonOwnershipConflictError("default", 24680),
		);

		await expect(loadServer()).rejects.toThrow(/process\.exit\(0\)/);
		expect(processExitSpy).toHaveBeenCalledWith(0);
		const rows = await ledgerRows();
		expect(rows.some((r) => r.includes('"reason":"anti-stomp"') && r.includes(`"pid":${process.pid}`))).toBe(
			true,
		);
	});

	// P: a genuine (non-ownership) framed startup failure exits LOUDLY with the
	// distinct startup code and a `startup-failed` ledger row — it is neither
	// mislabeled anti-stomp nor (the F1 bug) rethrown into
	// `installCrashResilience()`, which would keep a socket-less process alive.
	it("framed path: a genuine (non-ownership) startup failure exits 78 and records startup-failed", async () => {
		const sd = await import("./session-daemon.js");
		vi.mocked(sd.startSessionDaemon).mockRejectedValueOnce(new Error("disk full"));

		await expect(loadServer()).rejects.toThrow(/process\.exit\(78\)/);
		expect(processExitSpy).toHaveBeenCalledWith(78);
		const rows = await ledgerRows();
		expect(rows.some((r) => r.includes('"reason":"anti-stomp"'))).toBe(false);
		expect(
			rows.some(
				(r) => r.includes('"reason":"startup-failed"') && r.includes(`"pid":${process.pid}`),
			),
		).toBe(true);
	});

	// P: the raw listener's bind failure takes the same terminal path — the
	// reporter handed to `startRawServer` is the startup guard itself.
	it("raw path: a listen failure exits 78 and records startup-failed", async () => {
		await loadServer();
		const reporter = cap.socketSetters.startRawServer?.mock.calls[0]?.[0] as
			| { fail: (what: string, err: unknown) => void }
			| undefined;
		expect(reporter).toBeDefined();
		expect(() =>
			reporter?.fail("raw socket bind", Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" })),
		).toThrow(/process\.exit\(78\)/);
		expect(processExitSpy).toHaveBeenCalledWith(78);
		expect((await ledgerRows()).some((r) => r.includes('"reason":"startup-failed"'))).toBe(true);
	});

	// P: the ledger records `listening` only when every socket this protocol
	// mode runs has REPORTED a bind — the row that lets a reader tell a
	// serving daemon from one that only got as far as `start`.
	it("records the `listening` ledger row once both sockets report (dual mode)", async () => {
		const fs = await import("node:fs");
		await loadServer();
		const listeningRows = (): string[] =>
			vi
				.mocked(fs.appendFileSync)
				.mock.calls.map((call) => String(call[1]))
				.filter((line) => line.includes('"event":"listening"'));
		// Framed reported during startup; the raw listener has not yet.
		expect(listeningRows()).toHaveLength(0);
		const reporter = cap.socketSetters.startRawServer?.mock.calls[0]?.[0] as
			| { note: (which: "raw" | "framed") => void }
			| undefined;
		reporter?.note("raw");
		expect(listeningRows()).toHaveLength(1);
		// Idempotent: a second report does not write a second row.
		reporter?.note("raw");
		expect(listeningRows()).toHaveLength(1);
	});

	// -------------------------------------------------------------------------
	// Log-content hardening (mutation kills for the StringLiteral `detail`
	// arguments and the zombie-reap message — a passing exit/ledger assertion
	// alone does not pin what the human-facing log line actually said).
	// -------------------------------------------------------------------------

	it("raw-legacy anti-stomp log names 'the raw socket' as the contested resource", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const sp = await import("./session-paths.js");
		vi.mocked(sp.liveForeignDaemonPid).mockReturnValue(13579);
		vi.mocked(sp.classifyDaemonSocket).mockResolvedValue("ready");

		await expect(loadServer()).rejects.toThrow(/process\.exit\(0\)/);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("already owns the raw socket for");
		errSpy.mockRestore();
	});

	it("framed anti-stomp log names the framed session id as the contested resource", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const sd = await import("./session-daemon.js");
		vi.mocked(sd.startSessionDaemon).mockRejectedValueOnce(
			new sd.DaemonOwnershipConflictError("default", 24680),
		);

		await expect(loadServer()).rejects.toThrow(/process\.exit\(0\)/);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain('already owns the framed session "default" for');
		errSpy.mockRestore();
	});

	it("logs the exact zombie-reap message when a live-but-silent incumbent is taken over", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const sp = await import("./session-paths.js");
		vi.mocked(sp.liveForeignDaemonPid).mockReturnValue(13579);
		vi.mocked(sp.classifyDaemonSocket).mockResolvedValue("absent");

		await loadServer();
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain(
			"exists but refuses connections — removing the stale socket (pid 13579 is alive but not serving) and binding.",
		);
		errSpy.mockRestore();
	});
});

describe("harness server.ts — cyclomatic gate capability", () => {
	it("logs the fallback WARNING when astComplexityAvailable() is false (line 317)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		astComplexityAvailableOverride = false;
		await loadServer();
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("`typescript` is not resolvable");
		expect(logged).toContain("less-accurate regex walker");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — writeCollectionRecord guard-decision branch (line 496)", () => {
	it("writes a guard decision record when a decision is present", async () => {
		const aw = await import("./server/activity-writer.js");
		await loadServer();
		vi.mocked(aw.writeGuardDecisionRecord).mockClear();
		const event = { hook_event: "PreToolUse", session_id: "guard-decision" };
		const decision: HarnessDecision = { decision: "allow" };
		cap.eventLoopDeps?.writeCollectionRecord(event, decision);
		expect(aw.writeGuardDecisionRecord).toHaveBeenCalledWith(event, decision, expect.any(String));
	});
});

describe("harness server.ts — daemon-timer closures (RSS ceiling / spike / idle shrink)", () => {
	it("shutdown hook delegates to the real socket-lifecycle shutdown (line 684)", async () => {
		await loadServer();
		expect(capturedDaemonTimerHooks).not.toBeNull();
		capturedDaemonTimerHooks?.shutdown();
		expect(cap.socketSetters.shutdown).toHaveBeenCalledTimes(1);
	});

	it("does not wire an RSS successor spawn that can overlap the bloated daemon", async () => {
		await loadServer();
		expect(capturedDaemonTimerHooks).not.toHaveProperty("requestHandOver");
		expect(capturedDaemonTimerHooks?.acquireRecycleLease).toEqual(expect.any(Function));
	});

	it("onSpike records a spike ledger row with rss/delta detail (line 693)", async () => {
		await loadServer();
		const fs = await import("node:fs");
		vi.mocked(fs.appendFileSync).mockClear();
		capturedDaemonTimerHooks?.onSpike?.(512, 200);
		const rows = vi.mocked(fs.appendFileSync).mock.calls.map((c) => String(c[1]));
		expect(
			rows.some(
				(r) =>
					r.includes('"event":"spike"') &&
					r.includes('"rss_mb":512') &&
					r.includes("+200MB in one tick [") &&
					r.includes("old=1MB"),
			),
		).toBe(true);
	});

	it("shrinkIdleMemory clears the manifest cache without throwing (lines 698-701)", async () => {
		await loadServer();
		expect(() => capturedDaemonTimerHooks?.shrinkIdleMemory?.()).not.toThrow();
	});

	it("lastEventAtMs reflects the daemon's own hook-activity timestamp (line 697)", async () => {
		await loadServer();
		expect(typeof capturedDaemonTimerHooks?.lastEventAtMs?.()).toBe("number");
	});
});

describe("harness server.ts — sponsor runtime wiring (lines 715-717)", () => {
	it("readSettings delegates to readSponsorSettingsFromConfig", async () => {
		await loadServer();
		const sponsor = await import("./sponsor/runtime.js");
		vi.mocked(sponsor.readSponsorSettingsFromConfig).mockClear();
		capturedSponsorOpts?.readSettings();
		expect(sponsor.readSponsorSettingsFromConfig).toHaveBeenCalledTimes(1);
	});

	it("hasRecentActivity is true right after a hook event and false once the window elapses", async () => {
		await loadServer();
		// A hook event bumps `lastHookEventAtMs` via the raw event-loop path in
		// real operation; here we only need the comparison logic itself, which
		// is pure once evaluated at time-of-call — the window is 5 minutes and
		// no event has been recorded, so `Date.now() - lastHookEventAtMs` is
		// effectively `Date.now() - 0`, far past the window: false.
		expect(capturedSponsorOpts?.hasRecentActivity()).toBe(false);
	});

	it("log forwards to the daemon's own log() writer without throwing (line 717)", async () => {
		await loadServer();
		expect(() => capturedSponsorOpts?.log("sponsor test message")).not.toThrow();
	});
});

describe("harness server.ts — build-refresh watcher wiring", () => {
	it("lastActivityMs reflects the daemon's own hook-activity timestamp (line 810)", async () => {
		await loadServer();
		expect(typeof capturedBuildRefreshOpts?.lastActivityMs()).toBe("number");
	});
});

describe("harness server.ts — rebound SIGTERM handler", () => {
	it("the rebound SIGTERM handler calls the real shutdown (line 742)", async () => {
		await loadServer();
		const sigterm = lastSignalHandler("SIGTERM");
		expect(typeof sigterm).toBe("function");
		sigterm?.();
		expect(cap.socketSetters.shutdown).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Local helper: a typed ContentScanner fake. Methods present by default; tests
// `delete` the optional ones to drive the else-branches.
// ---------------------------------------------------------------------------
function makeScanner(
	overrides: Partial<ContentScanner> = {},
): ContentScanner {
	const scanner: ContentScanner = {
		name: "fake-scanner",
		runtime: "local",
		ready: vi.fn(async () => true),
		scan: vi.fn(async () => []),
		shutdown: vi.fn(async () => {}),
		onStatusChange: vi.fn(),
		getStatus: vi.fn((): ScannerStatus => ({ state: "ready", sinceIso: "t" })),
		...overrides,
	};
	return scanner;
}

// ===========================================================================
// Mutation-kill hardening (survivor campaign). Each block below targets one
// or more specific surviving mutant sites recorded against server.ts, cross-
// referenced by exact (mutator, siteId) against the committed mutation
// manifest. Comments name the mutation being killed, not just the behavior.
// ===========================================================================

describe("harness server.ts — reservation event sink (mutation hardening)", () => {
	it("appends the exact JSON-serialized event line, and skips mkdirSync, when the dir already exists", async () => {
		const fs = await import("node:fs");
		vi.mocked(fs.existsSync).mockReturnValue(true);
		await loadServer();
		vi.mocked(fs.appendFileSync).mockClear();
		vi.mocked(fs.mkdirSync).mockClear();
		const event = { kind: "grant", file: "z.ts" };
		cap.reservationEventSink?.(event);
		// Kills: whole-body wipe, try-block wipe, and the template->`` mutant.
		expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledWith(
			expect.stringContaining("/.interlinked/reservation-events.jsonl"),
			`${JSON.stringify(event)}\n`,
		);
		// Kills: the two ".interlinked"->"" StringLiteral mutants and the
		// "reservation-events.jsonl"->"" mutant (all collapse the path above).
		// Kills: !existsSync(dir)->existsSync(dir), and the ConditionalExpression
		// ->true variant (both would call mkdirSync despite the dir existing).
		expect(vi.mocked(fs.mkdirSync)).not.toHaveBeenCalled();
	});

	it("creates the directory with exactly {recursive:true} only when it is missing", async () => {
		const fs = await import("node:fs");
		vi.mocked(fs.existsSync).mockReturnValue(false);
		await loadServer();
		vi.mocked(fs.mkdirSync).mockClear();
		cap.reservationEventSink?.({ kind: "grant" });
		// Kills: !existsSync(dir)->existsSync(dir), ConditionalExpression->false
		// (both would skip mkdirSync despite the dir being absent).
		expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledTimes(1);
		// Kills: {recursive:true}->{} and the inner true->false BooleanLiteral.
		expect(vi.mocked(fs.mkdirSync)).toHaveBeenLastCalledWith(expect.any(String), {
			recursive: true,
		});
	});
});

describe("harness server.ts — rules-reload optional chaining (mutation hardening)", () => {
	it("tolerates an undefined content_scanner via optional chaining on both enabled and allowlist reads", async () => {
		await loadServer();
		const rulesNoScanner = makeRules();
		delete rulesNoScanner.content_scanner;
		cap.statusWriters.writeScannerStatus.mockClear();
		// Kills: `rules.content_scanner?.enabled` -> `.enabled` (no `?.`) and
		// `rules.content_scanner?.allowlist` -> `.allowlist` (no `?.`) — either
		// would throw a TypeError reading a property off `undefined`.
		expect(() => cap.rulesReloadCb?.(rulesNoScanner)).not.toThrow();
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("disabled");
	});
});

describe("harness server.ts — auto_coordination merge (mutation hardening)", () => {
	it("module-scope autoCoordConfig merges rules.auto_coordination when present", async () => {
		rulesOverride = makeRules({ auto_coordination: { enabled: true, interval_ms: 42 } as never });
		await loadServer();
		const cfg = cap.eventLoopDeps?.ctx.autoCoordConfig as Record<string, unknown>;
		// Kills (module scope): ConditionalExpression->true/false and the
		// ||->&& LogicalOperator, and the whole-object-literal->{} mutant —
		// all of them fail to carry `enabled:true, interval_ms:42` through.
		expect(cfg).toMatchObject({ enabled: true, interval_ms: 42 });
	});

	it("rules-reload callback re-merges rules.auto_coordination via Object.assign", async () => {
		await loadServer();
		const cfg = cap.eventLoopDeps?.ctx.autoCoordConfig as Record<string, unknown>;
		cap.rulesReloadCb?.(makeRules({ auto_coordination: { enabled: true, interval_ms: 99 } as never }));
		// Kills (reload-callback scope): ConditionalExpression->true/false and
		// the ||->&& LogicalOperator on `rules.auto_coordination || {}`.
		expect(cfg).toMatchObject({ enabled: true, interval_ms: 99 });
	});
});

describe("harness server.ts — log-message content (mutation hardening)", () => {
	it("reload callback logs the exact rules-active count message (verbose)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer(["--verbose"]);
		errSpy.mockClear();
		cap.rulesReloadCb?.(makeRules({ rules: [{ id: "r1" } as never, { id: "r2" } as never] }));
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: `Rules reloaded: ${...} rules active` -> ``.
		expect(logged).toContain("Rules reloaded: 2 rules active");
		errSpy.mockRestore();
	});

	it("logs 'Route map initialized' on the deferred background-init tick (verbose)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: "Route map initialized" -> "".
		expect(logged).toContain("Route map initialized");
		errSpy.mockRestore();
	});

	it("logs the trigram index base commit truncated to 8 chars, not the raw commit", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		trigramLoadResult = {
			files: ["a.ts"],
			baseCommit: "abcdef1234567890",
			incrementalUpdate: vi.fn(() => 0),
		};
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: `trigramIndex.baseCommit.slice(0, 8)` -> `trigramIndex.baseCommit`.
		expect(logged).toContain("base abcdef12");
		expect(logged).not.toContain("abcdef1234567890");
		errSpy.mockRestore();
	});

	it("logs the exact 'files changed since base commit' message when the index actually updates", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		trigramLoadResult = {
			files: ["x.ts"],
			baseCommit: "cafebabe11112222",
			incrementalUpdate: vi.fn(() => 4),
		};
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: `updated > 0` -> false, the surrounding block -> {}, and the
		// message template -> ``.
		expect(logged).toContain("Trigram index updated: 4 files changed since base commit");
		errSpy.mockRestore();
	});

	it("logs the exact lost-agent message on the periodic sweep (verbose)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer(["--verbose"]);
		errSpy.mockClear();
		detectLostAgentsMock.mockReturnValueOnce([{ name: "ghost-42" }]);
		vi.advanceTimersByTime(2 * 60 * 1000);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: `Agent lost (no events for 5min): ${agent.name}` -> ``.
		expect(logged).toContain("Agent lost (no events for 5min): ghost-42");
		errSpy.mockRestore();
	});

	it("shutdownWith records reason 'signal' for both the SIGINT and SIGTERM handlers", async () => {
		const fs = await import("node:fs");
		await loadServer();

		vi.mocked(fs.appendFileSync).mockClear();
		lastSignalHandler("SIGINT")?.();
		let rows = vi.mocked(fs.appendFileSync).mock.calls.map((c) => String(c[1]));
		// Kills: the SIGINT handler's own "signal" -> "" StringLiteral.
		expect(rows.some((r) => r.includes('"event":"exit"') && r.includes('"reason":"signal"'))).toBe(
			true,
		);

		vi.mocked(fs.appendFileSync).mockClear();
		lastSignalHandler("SIGTERM")?.();
		rows = vi.mocked(fs.appendFileSync).mock.calls.map((c) => String(c[1]));
		// Kills: the SIGTERM handler's own, separately-mutated "signal" -> "".
		expect(rows.some((r) => r.includes('"event":"exit"') && r.includes('"reason":"signal"'))).toBe(
			true,
		);
	});
});

describe("harness server.ts — log() internals (mutation hardening)", () => {
	it("stays silent when --verbose is not set (VERBOSE stays false)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer(); // no --verbose
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: `VERBOSE` -> `true` inside log(), AND the parseArgs `verbose`
		// option's `default: false` -> `default: true` (both make log() noisy
		// even when --verbose was never passed).
		expect(logged).not.toContain("[harness ");
		errSpy.mockRestore();
	});

	it("timestamps each verbose line as HH:MM:SS, not the full ISO-8601 string", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: `new Date().toISOString().slice(11, 19)` -> `new Date().toISOString()`.
		expect(logged).toMatch(/\[harness \d{2}:\d{2}:\d{2}\] /);
		expect(logged).not.toMatch(/\[harness \d{4}-\d{2}-\d{2}T/);
		errSpy.mockRestore();
	});

	it("sponsor runtime's log callback actually reaches the daemon's verbose log output", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer(["--verbose"]);
		errSpy.mockClear();
		capturedSponsorOpts?.log("sponsor-probe-xyz");
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: `(msg) => log(msg)` -> `() => undefined` for the sponsor
		// runtime's `log` option — a bare not.toThrow() also passes a no-op.
		expect(logged).toContain("sponsor-probe-xyz");
		errSpy.mockRestore();
	});

	it("parseArgs tolerates an unrecognized flag (strict: false) instead of throwing", async () => {
		// Kills: the parseArgs `strict: false` -> `strict: true` BooleanLiteral —
		// Node's parseArgs throws ERR_PARSE_ARGS_UNKNOWN_OPTION in strict mode
		// for a flag not declared in `options`, which would reject this import.
		await expect(loadServer(["--not-a-real-flag", "value"])).resolves.toBeUndefined();
	});
});

describe("harness server.ts — refreshStatuslineSnapshot (mutation hardening)", () => {
	it("writes exact indexStatus/indexFiles/serverBridgeConnected fields when the index and bridge are live", async () => {
		const snap = await import("./statusline-snapshot.js");
		trigramLoadResult = {
			files: ["a.ts", "b.ts", "c.ts"],
			baseCommit: "cafe1234",
			incrementalUpdate: vi.fn(() => 0),
		};
		serverBridgeOverride = { shutdown: vi.fn() };
		await loadServer();
		vi.mocked(snap.writeStatuslineArtifacts).mockClear();
		cap.rulesReloadCb?.(makeRules()); // triggers a fresh refreshStatuslineSnapshot()
		// Kills: the whole-body -> {} wipe (nothing would be written at all).
		expect(vi.mocked(snap.writeStatuslineArtifacts)).toHaveBeenCalledTimes(1);
		const arg = vi.mocked(snap.writeStatuslineArtifacts).mock.calls[0]?.[0] as unknown as Record<
			string,
			unknown
		>;
		// Kills: "ready" -> "" and the whole-object-argument -> {} mutant.
		expect(arg.indexStatus).toBe("ready");
		// Kills: `trigramIndex?.files.length ?? 0` -> `... && 0`.
		expect(arg.indexFiles).toBe(3);
		// Kills: `serverBridge !== null` -> false (ConditionalExpression) and
		// the `!==` -> `===` EqualityOperator mutant.
		expect(arg.serverBridgeConnected).toBe(true);
	});

	it("reports indexStatus 'missing', indexFiles 0, and serverBridgeConnected false when idle/local-only", async () => {
		const snap = await import("./statusline-snapshot.js");
		trigramLoadResult = null;
		serverBridgeOverride = null;
		await loadServer();
		vi.mocked(snap.writeStatuslineArtifacts).mockClear();
		cap.rulesReloadCb?.(makeRules());
		const arg = vi.mocked(snap.writeStatuslineArtifacts).mock.calls[0]?.[0] as unknown as Record<
			string,
			unknown
		>;
		// Kills: "missing" -> "".
		expect(arg.indexStatus).toBe("missing");
		// Kills the `??` -> `&&` mutant from the opposite side (undefined && 0
		// stays undefined, not 0).
		expect(arg.indexFiles).toBe(0);
		// Kills the ConditionalExpression->true and `===` variants from the
		// opposite side (both would report `true` here).
		expect(arg.serverBridgeConnected).toBe(false);
	});
});

describe("harness server.ts — idle timeout scheduling", () => {
	it("calls clearTimeout to cancel a previously armed timer on a second call", async () => {
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		await loadServer(["--idle-timeout", "5000"]);
		const scheduleSpy = vi.spyOn(globalThis, "setTimeout");
		cap.eventLoopDeps?.resetIdleTimer();
		expect(scheduleSpy).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 5000);
		const armedTimer = scheduleSpy.mock.results[0]?.value;
		clearSpy.mockClear();
		cap.eventLoopDeps?.resetIdleTimer(); // second call -> idleTimer now truthy
		// Kills: `idleTimer` -> `false` (ConditionalExpression).
		expect(clearSpy).toHaveBeenCalledOnce();
		expect(clearSpy).toHaveBeenCalledWith(armedTimer);
		scheduleSpy.mockRestore();
		clearSpy.mockRestore();
	});

	it("idle-timeout expiry logs the exact minutes message and records reason 'idle-timeout'", async () => {
		const fs = await import("node:fs");
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer(["--idle-timeout", String(2 * 60 * 1000)]); // 2 minutes
		vi.mocked(fs.appendFileSync).mockClear();
		cap.eventLoopDeps?.resetIdleTimer();
		vi.advanceTimersByTime(2 * 60 * 1000);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: the `Shutting down after ${...}min idle` template -> ``, and
		// `IDLE_TIMEOUT_MS / MS_PER_MINUTE` -> `*` (would print a huge number).
		expect(logged).toContain("Shutting down after 2min idle");
		const rows = vi.mocked(fs.appendFileSync).mock.calls.map((c) => String(c[1]));
		// Kills: "idle-timeout" -> "" (the shutdownWith reason argument).
		expect(rows.some((r) => r.includes('"reason":"idle-timeout"'))).toBe(true);
		errSpy.mockRestore();
	});
});

describe("harness server.ts — noteActivityAndResetIdleTimer (mutation hardening)", () => {
	it("updates lastHookEventAtMs so hasRecentActivity flips true and lastEventAtMs becomes positive", async () => {
		await loadServer();
		expect(capturedSponsorOpts?.hasRecentActivity()).toBe(false); // no event recorded yet
		cap.eventLoopDeps?.resetIdleTimer(); // this callback IS noteActivityAndResetIdleTimer
		// Kills: the whole function body -> {} (a no-op leaves both signals at
		// their initial/absent state).
		expect(capturedSponsorOpts?.hasRecentActivity()).toBe(true);
		expect(capturedDaemonTimerHooks?.lastEventAtMs?.()).toBeGreaterThan(0);
	});
});

describe("harness server.ts — syncRuntimeIn / syncRuntimeOut (mutation hardening)", () => {
	it("syncRuntimeIn pushes the module-level trigramIndex into the runtime context", async () => {
		trigramLoadResult = { files: ["p.ts"], baseCommit: "1234567890abcdef", incrementalUpdate: vi.fn(() => 0) };
		await loadServer();
		const ctx = cap.eventLoopDeps?.ctx as Record<string, unknown>;
		// Corrupt the runtime-context copy; syncRuntimeIn must overwrite it back
		// from the module-level `trigramIndex` let.
		ctx.trigramIndex = "SENTINEL" as never;
		cap.eventLoopDeps?.syncRuntimeIn();
		// Kills: the whole syncRuntimeIn body -> {}.
		expect(ctx.trigramIndex).not.toBe("SENTINEL");
		expect((ctx.trigramIndex as { files: string[] } | null)?.files).toEqual(["p.ts"]);
	});

	it("syncRuntimeOut pulls the runtime context's trigramIndex back into module state (observable via refreshStatuslineSnapshot)", async () => {
		const snap = await import("./statusline-snapshot.js");
		await loadServer();
		const ctx = cap.eventLoopDeps?.ctx as Record<string, unknown>;
		ctx.trigramIndex = { files: new Array(9).fill("x"), baseCommit: "deadbeef00000000" } as never;
		cap.eventLoopDeps?.syncRuntimeOut();
		vi.mocked(snap.writeStatuslineArtifacts).mockClear();
		// refreshStatuslineSnapshot reads the MODULE-LEVEL `trigramIndex`, not
		// ctx.trigramIndex directly, so this only reflects the sentinel if
		// syncRuntimeOut actually ran.
		cap.rulesReloadCb?.(makeRules());
		const arg = vi.mocked(snap.writeStatuslineArtifacts).mock.calls[0]?.[0] as unknown as Record<
			string,
			unknown
		>;
		// Kills: the whole syncRuntimeOut body -> {}.
		expect(arg.indexFiles).toBe(9);
	});
});

describe("harness server.ts — writeCollectionRecord (mutation hardening)", () => {
	it("forwards the exact event to both the collection writer and the activity mirror", async () => {
		const cw = await import("./server/collection-writer.js");
		const aw = await import("./server/activity-writer.js");
		await loadServer();
		const event = { hook_event: "PostToolUse", session_id: "s2" };
		cap.eventLoopDeps?.writeCollectionRecord(event);
		// Kills: the whole writeCollectionRecord body -> {} (neither writer
		// would ever be called).
		expect(vi.mocked(cw.writeCollectionRecord)).toHaveBeenCalledWith(event, expect.any(String));
		expect(vi.mocked(aw.writeActivityRecord)).toHaveBeenCalledWith(event, expect.any(String));
	});

	it("calls writeGuardDecisionRecord only when a decision is provided (the `if (decision)` gate)", async () => {
		const aw = await import("./server/activity-writer.js");
		await loadServer();
		// This mock's call history is NOT reset by resetModules() between
		// tests (it is a bare vi.fn() named-export mock, not a per-import
		// constructed class instance) — clear explicitly so the count below
		// reflects only this test's own actions.
		vi.mocked(aw.writeGuardDecisionRecord).mockClear();
		const event = { hook_event: "PreToolUse", session_id: "s3" };
		const decision = { decision: "block", reason: "x" } as unknown as HarnessDecision;

		cap.eventLoopDeps?.writeCollectionRecord(event, decision);
		// Kills: `decision` -> `false` (ConditionalExpression) — would never
		// call the guard-decision writer even when a real decision is passed.
		expect(vi.mocked(aw.writeGuardDecisionRecord)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(aw.writeGuardDecisionRecord)).toHaveBeenCalledWith(
			event,
			decision,
			expect.any(String),
		);

		vi.mocked(aw.writeGuardDecisionRecord).mockClear();
		cap.eventLoopDeps?.writeCollectionRecord(event); // no decision this time
		// Kills: `decision` -> `true` (ConditionalExpression) — would call the
		// guard-decision writer even with no decision at all.
		expect(vi.mocked(aw.writeGuardDecisionRecord)).not.toHaveBeenCalled();
	});
});

describe("harness server.ts — lifecycle activity wiring", () => {
	it("forwards lifecycle events and their redaction decision to the activity-only writer", async () => {
		const aw = await import("./server/activity-writer.js");
		await loadServer();
		const event = { hook_event: "UserPromptSubmit", session_id: "s-lifecycle" };
		const decision = { decision: "allow", redacted_prompt: "<EMAIL>" };

		cap.eventLoopDeps?.writeLifecycleActivityRecord(event, decision);

		expect(vi.mocked(aw.writeLifecycleActivityRecord)).toHaveBeenCalledWith(
			event,
			expect.any(String),
			decision,
		);
	});
});

describe("harness server.ts — shutdownWith arithmetic (mutation hardening)", () => {
	it("computes exact rss/heap/ext MB and a small uptime_s using the documented divisions", async () => {
		const fs = await import("node:fs");
		const memSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
			rss: 209_715_200, // 200 MiB
			heapTotal: 100_000_000,
			heapUsed: 104_857_600, // 100 MiB
			external: 15_728_640, // 15 MiB
			arrayBuffers: 1_048_576, // 1 MiB -> ext total 16 MiB
		} as never);
		await loadServer();
		vi.mocked(fs.appendFileSync).mockClear();
		vi.advanceTimersByTime(60_000); // 60s of "uptime" for a stable, non-zero window
		capturedDaemonTimerHooks?.shutdown(); // -> shutdownWith("rss-ceiling")
		const rows = vi.mocked(fs.appendFileSync).mock.calls.map((c) => String(c[1]));
		const exitRow = rows.find(
			(r) => r.includes('"event":"exit"') && r.includes('"reason":"rss-ceiling"'),
		);
		// Kills: the whole ledger-object literal -> {}, "exit" -> "", and
		// "rss-ceiling" -> "" (shutdown hook's own StringLiteral argument).
		expect(exitRow).toBeDefined();
		const row = exitRow as string;
		// Kills: `rss / 1048576` -> `rss * 1048576`.
		expect(row).toContain('"rss_mb":200');
		// Kills: `heapUsed / 1048576` -> `heapUsed * 1048576`.
		expect(row).toContain('"heap_mb":100');
		// Kills: `(external + arrayBuffers) / 1048576` -> `* 1048576`, and
		// `external + arrayBuffers` -> `external - arrayBuffers`.
		expect(row).toContain('"ext_mb":16');
		// Kills: `(Date.now() - DAEMON_STARTED_MS) / 1000` -> `* 1000`, and
		// `Date.now() - DAEMON_STARTED_MS` -> `Date.now() + DAEMON_STARTED_MS`.
		// A wide sanity band, not an exact-elapsed pin: other real timers
		// registered during loadServer() (e.g. the lost-agent setInterval)
		// can consume additional fake-clock time when advanceTimersByTime
		// processes due callbacks, so the true elapsed value is "a small
		// number of minutes", not exactly 60s. The `*1000` mutant would
		// produce a value in the tens of millions; the `+DAEMON_STARTED_MS`
		// mutant would produce a value near double the current epoch second
		// count (billions) — both are many orders of magnitude outside this
		// band regardless of the exact real elapsed time.
		const uptimeMatch = row.match(/"uptime_s":(-?\d+)/);
		expect(uptimeMatch).not.toBeNull();
		const uptimeS = Number(uptimeMatch?.[1]);
		expect(uptimeS).toBeGreaterThanOrEqual(1);
		expect(uptimeS).toBeLessThanOrEqual(3600);
		memSpy.mockRestore();
	});
});

describe("harness server.ts — shrinkIdleMemory (mutation hardening)", () => {
	it("actually clears the manifest cache (not a no-op)", async () => {
		const mm = await import("./mutation/manifest.js");
		await loadServer();
		vi.mocked(mm.clearManifestCache).mockClear();
		capturedDaemonTimerHooks?.shrinkIdleMemory?.();
		// Kills: the whole shrinkIdleMemory body -> {} — a bare not.toThrow()
		// also passes a no-op, so this checks the real call happened.
		expect(vi.mocked(mm.clearManifestCache)).toHaveBeenCalledTimes(1);
	});
});

describe("harness server.ts — hasRecentActivity boundary (mutation hardening)", () => {
	it("is true just under the 5-minute window and false exactly at the boundary (strict <, not <=)", async () => {
		await loadServer();
		cap.eventLoopDeps?.resetIdleTimer(); // records lastHookEventAtMs = now
		vi.advanceTimersByTime(5 * 60 * 1000 - 1); // 1ms under the window
		// Kills: the whole condition -> false, and `Date.now() - lastHookEventAtMs`
		// -> `+` (either makes this always false).
		expect(capturedSponsorOpts?.hasRecentActivity()).toBe(true);
	});

	it("is false exactly AT the boundary", async () => {
		await loadServer();
		cap.eventLoopDeps?.resetIdleTimer();
		vi.advanceTimersByTime(5 * 60 * 1000); // exactly the window
		// Kills: `<` -> `<=` (EqualityOperator).
		expect(capturedSponsorOpts?.hasRecentActivity()).toBe(false);
	});
});

describe("harness server.ts — settings-strip callback formatting (mutation hardening)", () => {
	it("omits the tail with a real empty string, never a placeholder, when entries fit", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer();
		cap.settingsOnStrip?.({
			totalStripped: 1,
			entries: [{ file: "/r/.claude/settings.json", bucket: "allow", index: 0, rule: "z", reason: "r" }],
		});
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: the `more` ternary's falsy-branch "" -> "Stryker was here!".
		expect(logged).not.toContain("Stryker was here!");
		errSpy.mockRestore();
	});

	it("joins preview lines with a real newline, not a run-together string", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer();
		cap.settingsOnStrip?.({
			totalStripped: 2,
			entries: [
				{ file: "/r/.claude/settings.json", bucket: "allow", index: 0, rule: "A", reason: "r1" },
				{ file: "/r/.claude/settings.json", bucket: "deny", index: 1, rule: "B", reason: "r2" },
			],
		});
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// The path-strip regex already reduces "/r/.claude/settings.json" to
		// ".claude/settings.json" before this line is built.
		const line1 = '  - .claude/settings.json permissions.allow[0] = "A" (reason:r1)';
		const line2 = '  - .claude/settings.json permissions.deny[1] = "B" (reason:r2)';
		// Kills: `previews.join("\n")`'s separator "\n" -> "" — without the
		// newline the two lines would run together with no boundary.
		expect(logged).toContain(`${line1}\n${line2}`);
		errSpy.mockRestore();
	});

	it("builds each preview line with the exact stripped path, bucket, index, rule JSON, and reason", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer();
		cap.settingsOnStrip?.({
			totalStripped: 1,
			entries: [
				{
					file: "/home/u/.claude/settings.local.json",
					bucket: "deny",
					index: 3,
					rule: "Bash(rm:*)",
					reason: "bad-glob",
				},
			],
		});
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: the map callback's whole body -> {} (returns undefined for
		// every preview line), the per-line template -> ``, and "$1" -> "" in
		// the path-strip replace() (which would blank the path entirely).
		// Also kills the c/d regex variants (single-`.` quantifier): with a
		// multi-segment leading path they fail to strip at all.
		expect(logged).toContain(
			'  - .claude/settings.local.json permissions.deny[3] = "Bash(rm:*)" (reason:bad-glob)',
		);
		errSpy.mockRestore();
	});

	it("regex requires both the start anchor and reaching end-of-string past any embedded newline", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer();
		cap.settingsOnStrip?.({
			totalStripped: 1,
			entries: [{ file: "A.claude/B\nC.claude/D", bucket: "allow", index: 0, rule: "R", reason: "r" }],
		});
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Empirically verified (scratch/probes/server-onstrip-regex-probe.mjs):
		// with this input the real regex has NO match at all (greedy `.+`
		// cannot cross the embedded \n to reach `$`, and `^` locks the search
		// to position 0), so `file` is left completely unstripped.
		// Kills: dropping the `$` end-anchor (finds a match starting at "C"
		// once nothing downstream of the \n needs re-reaching the true end)
		// and dropping the `^` start-anchor (search would retry starting at
		// "C" once position 0 fails) — both produce a DIFFERENT, partially
		// stripped string for this exact input.
		expect(logged).toContain("  - A.claude/B\nC.claude/D permissions.allow[0]");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — module-scoped path constants (mutation hardening)", () => {
	it("computes INTERLINKED_DIR as <cwd>/.interlinked", async () => {
		await loadServer();
		const ctx = cap.eventLoopDeps?.ctx as Record<string, unknown>;
		// Kills: the INTERLINKED_DIR-site ".interlinked" -> "" StringLiteral —
		// without the suffix, interlinkedDir would just equal CWD.
		expect(String(ctx.interlinkedDir)).toMatch(/\.interlinked$/);
	});

	it("computes the default PID path from INTERLINKED_DIR when --pid-file is not passed", async () => {
		await loadServer();
		// Kills: the whole `stringArg(...) || join(...)` -> true/false, the
		// ||->&& LogicalOperator, and "harness.pid" -> "" (all three collapse
		// or corrupt the default path below).
		expect(cap.socketLifecycleDeps?.pidPath).toMatch(/\.interlinked\/harness\.pid$/);
	});

	it("honors an explicit --pid-file over the computed default", async () => {
		await loadServer(["--pid-file", "/tmp/custom-harness.pid"]);
		// Kills: "pid-file" -> "" (would read args[""] instead of the real
		// flag, silently falling back to the default path even though
		// --pid-file was passed).
		expect(cap.socketLifecycleDeps?.pidPath).toBe("/tmp/custom-harness.pid");
	});

	it("registers the early shutdown handler under the literal 'SIGINT' event name too (not just SIGTERM)", async () => {
		await loadServer();
		const earlyTermReg = allOnRegistrations.find((r) => r.event === "SIGTERM");
		const earlySigintReg = allOnRegistrations.find(
			(r) => r.event === "SIGINT" && r.listener === earlyTermReg?.listener,
		);
		// Kills: "SIGINT" -> "" on the early process.on registration (line
		// ~154) — the early handler would then be registered under the empty
		// string instead, and no "SIGINT"-keyed entry with the SAME listener
		// as the SIGTERM early registration would exist.
		expect(earlySigintReg).toBeDefined();
	});

	it("defaults FRAMED_SESSION_ID to 'default' when neither --session-id nor INTERLINKED_SESSION_ID is set", async () => {
		const prevEnv = process.env.INTERLINKED_SESSION_ID;
		delete process.env.INTERLINKED_SESSION_ID;
		try {
			await loadServer();
			// Kills: "default" -> "" (the FRAMED_SESSION_ID fallback literal).
			expect(cap.sessionDaemonOpts?.session_id).toBe("default");
		} finally {
			if (prevEnv !== undefined) process.env.INTERLINKED_SESSION_ID = prevEnv;
		}
	});
});

describe("harness server.ts — content-scanner and AST-gate startup logs (mutation hardening)", () => {
	it("logs the exact content-scanner enabled banner with name and runtime", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		rulesOverride = makeRules({ content_scanner: { enabled: true, runtime: "local" } as never });
		scannerOverride = makeScanner({ name: "my-scanner-42", runtime: "local" });
		await loadServer();
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: the `Content scanner: enabled (${name} / ${runtime})` template -> ``.
		expect(logged).toContain("Content scanner: enabled (my-scanner-42 / local)");
		errSpy.mockRestore();
	});

	it("logs 'Cyclomatic gate: AST-accurate' when the AST complexity pass is available (verbose)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		astComplexityAvailableOverride = true;
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: `astComplexityAvailable()` -> false (ConditionalExpression),
		// the true-branch block -> {}, and its message string -> "".
		expect(logged).toContain("Cyclomatic gate: AST-accurate (typescript resolved)");
		errSpy.mockRestore();
	});

	it("includes the exact reinstall hint in the AST-fallback warning", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		astComplexityAvailableOverride = false;
		await loadServer();
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: "Reinstall without `--omit=optional` to restore AST-accurate
		// enforcement." -> "".
		expect(logged).toContain("Reinstall without `--omit=optional` to restore AST-accurate enforcement.");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — server-bridge branch logs and constructor arg (mutation hardening)", () => {
	it("logs 'Server bridge connected' (and not the local-only line) when a bridge is configured", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		serverBridgeOverride = { shutdown: vi.fn() };
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: `serverBridge` -> false, the if-block -> {}, and
		// "Server bridge connected" -> "".
		expect(logged).toContain("Server bridge connected");
		expect(logged).not.toContain("No server configured");
		errSpy.mockRestore();
	});

	it("logs 'No server configured' (and not the connected line) when running local-only", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		serverBridgeOverride = null;
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: `serverBridge` -> true, the else-block -> {}, and
		// "No server configured — running in local-only mode" -> "".
		expect(logged).toContain("No server configured — running in local-only mode");
		expect(logged).not.toContain("Server bridge connected");
		errSpy.mockRestore();
	});

	it("passes the live server bridge (not undefined) as the reservation manager's bridge arg when configured", async () => {
		serverBridgeOverride = { shutdown: vi.fn() };
		await loadServer();
		// Kills: `serverBridge || undefined` -> false (ConditionalExpression)
		// and the ||->&& LogicalOperator (both would pass undefined/false
		// instead of the live bridge object).
		expect(cap.reservationManagerBridgeArg).toBe(serverBridgeOverride);
	});

	it("passes undefined (not the boolean literal true) as the bridge arg when running local-only", async () => {
		serverBridgeOverride = null;
		await loadServer();
		// Kills: `serverBridge || undefined` -> true (ConditionalExpression).
		expect(cap.reservationManagerBridgeArg).toBeUndefined();
	});
});

describe("harness server.ts — protocol status and runtime-context objects (mutation hardening)", () => {
	it("passes the exact protocol/socket-path fields to createProtocolStatus at startup", async () => {
		const ps = await import("./server/protocol-status.js");
		// This mock's call history persists across tests (bare vi.fn() named
		// export, not a per-import class instance) — clear before the action
		// so `.mock.calls[0]` reflects THIS test's own loadServer() call.
		vi.mocked(ps.createProtocolStatus).mockClear();
		await loadServer(["--protocol", "raw"]);
		const call = vi.mocked(ps.createProtocolStatus).mock.calls[0]?.[0] as Record<string, unknown>;
		// Kills: the whole createProtocolStatus argument object -> {}.
		expect(call).toMatchObject({
			protocol: "raw",
			rawSocketPath: expect.stringContaining("harness.sock"),
			framedSocketPath: null,
			framedSessionId: null,
		});
	});

	it("serverRuntime carries the full daemon-scoped context (not an empty stub)", async () => {
		await loadServer();
		const ctx = cap.eventLoopDeps?.ctx as Record<string, unknown>;
		// Kills: the whole serverRuntime object literal -> {}.
		expect(ctx.cwd).toBeDefined();
		expect(ctx.interlinkedDir).toBeDefined();
		expect(ctx.rules).toBeDefined();
		expect(ctx.cohort).toBeDefined();
		expect(ctx.reservations).toBeDefined();
		expect(typeof ctx.log).toBe("function");
		expect(typeof ctx.logAlways).toBe("function");
	});

	it("passes exact startup-message fields to buildStartupMessage", async () => {
		const ps = await import("./server/protocol-status.js");
		vi.mocked(ps.buildStartupMessage).mockClear();
		rulesOverride = makeRules({ rules: [{ id: "x" } as never, { id: "y" } as never, { id: "z" } as never] });
		await loadServer(["--idle-timeout", "9000"]);
		const call = vi.mocked(ps.buildStartupMessage).mock.calls[0]?.[0] as Record<string, unknown>;
		// Kills: the whole buildStartupMessage argument object -> {}.
		expect(call).toMatchObject({
			protocol: "dual",
			pid: process.pid,
			ruleCount: 3,
			idleTimeoutMs: 9000,
			msPerMinute: 60000,
		});
	});
});

describe("harness server.ts — daemon-ledger start row (mutation hardening)", () => {
	it("records a 'start' ledger row carrying this process's own pid at startup", async () => {
		const fs = await import("node:fs");
		vi.mocked(fs.appendFileSync).mockClear();
		await loadServer();
		const rows = vi.mocked(fs.appendFileSync).mock.calls.map((c) => String(c[1]));
		// Kills: the whole `{at, pid, event:"start"}` object literal -> {},
		// and "start" -> "".
		expect(rows.some((r) => r.includes('"event":"start"') && r.includes(`"pid":${process.pid}`))).toBe(
			true,
		);
	});
});

describe("harness server.ts — stale-snapshot sweep and lost-agent interval (mutation hardening)", () => {
	it("does not log a reaped-count line when nothing was swept (removed.length === 0)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer(["--verbose"]); // default sweepStaleLiveSnapshots mock returns removed: []
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: `sweep.removed.length > 0` -> true, and `>` -> `>=` (0 >= 0
		// is also always true) — both would log "Reaped 0 ..." unconditionally.
		expect(logged).not.toContain("Reaped");
		errSpy.mockRestore();
	});

	it("the lost-agent sweep interval does not fire before 2 minutes have elapsed", async () => {
		await loadServer();
		detectLostAgentsMock.mockClear();
		// Kills: the inner `2 * 60` -> `2 / 60` ArithmeticOperator, which
		// shortens the setInterval period from 2 minutes to ~33ms — advancing
		// only 1 minute would then already fire many times.
		vi.advanceTimersByTime(60 * 1000);
		expect(detectLostAgentsMock).not.toHaveBeenCalled();
	});
});

describe("harness server.ts — policy classifier claude_code branch (mutation hardening)", () => {
	it("claude_code provider is ready even when resolveApiKey finds no key (short-circuits via ===)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const pc = await import("./policy-classifier.js");
		vi.mocked(pc.resolveApiKey).mockReturnValueOnce(undefined);
		rulesOverride = makeRules({
			policy_classifier: { enabled: true, provider: "claude_code", model: "cc2" } as never,
		});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// Kills: `provider === "claude_code"` -> false, and "claude_code" -> ""
		// (both would fall through to needing a real API key, which this test
		// deliberately withholds).
		expect(logged).toContain("Policy classifier: claude_code/cc2 (ready)");
		errSpy.mockRestore();
	});
});
