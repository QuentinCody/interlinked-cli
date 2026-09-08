import { makeServerRuntime } from "./__tests__/fixtures.js";
import { makeGuardRules } from "../evaluator/__tests__/fixtures.js";
import { daemonPathsFor } from "../session-paths.js";
import { ProjectGraph } from "../project-graph.js";
// ===========================================
// activateDaemon — startup wiring seams
// ===========================================
// `activateDaemon` is almost entirely wiring: it hands callbacks to the timer
// installer, the rules/settings watchers, and the startup self-check. The
// end-to-end startup order is pinned by `src/harness/server.test.ts`; this file
// covers the callbacks that file constructs but never invokes, by capturing
// them off the mocked collaborator and calling them directly.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonLedgerEvent } from "../daemon-ledger.js";
import { recordDaemonEvent } from "../daemon-ledger.js";
import { acquireStartupLock } from "../startup-lock.js";
import { installDaemonTimers } from "./daemon-timers.js";
import { activateHookCoverage } from "./hook-coverage.js";
import { activateDaemon } from "./server-daemon-activation.js";
import { runStartupSelfCheck } from "./startup-guard.js";

vi.mock("../build-refresh.js", () => ({ startBuildRefreshWatcher: vi.fn(() => () => {}) }));
vi.mock("../daemon-ledger.js", () => ({
	recordDaemonEvent: vi.fn(),
	makeHeapPressureLedger: vi.fn(() => () => {}),
}));
vi.mock("../evaluator/pre-tool.js", () => ({ resetProjectSetupWarningsCache: vi.fn() }));
vi.mock("../live-snapshot.js", () => ({
	sweepStaleLiveSnapshots: vi.fn(() => ({ removed: [], scanned: 0 })),
}));
vi.mock("../mutation/mutation-cloud-v3-background.js", () => ({
	startMutationCloudV3Background: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock("../policy-classifier.js", () => ({ resolveApiKey: vi.fn(() => undefined) }));
vi.mock("../rules-loader.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../rules-loader.js")>(),
	loadRules: vi.fn(() => ({ rules: [] })),
	watchRulesFiles: vi.fn(() => () => {}),
}));
vi.mock("../settings-watcher.js", () => ({ watchSettingsFiles: vi.fn(() => () => {}) }));
vi.mock("../sponsor/runtime.js", () => ({
	readSponsorSettingsFromConfig: vi.fn(() => ({})),
	startSponsorRuntime: vi.fn(() => ({ tick: vi.fn(async () => {}) })),
}));
vi.mock("../startup-lock.js", () => ({
	acquireStartupLock: vi.fn(() => ({ acquired: true, path: "/lock", release: vi.fn() })),
}));
vi.mock("../tsgo-runner.js", () => ({ createTsgoRunner: vi.fn(() => ({})) }));
vi.mock("./daemon-timers.js", () => ({
	installDaemonTimers: vi.fn(() => () => {}),
	heapSpaceSummary: vi.fn(() => "old=1MB"),
}));
vi.mock("./idle-shrink.js", () => ({ makeShrinkIdleMemory: vi.fn(() => () => {}) }));
// This suite tests startup wiring; filesystem observation has its own real-FS tests.
vi.mock("./hook-coverage.js", () => ({ activateHookCoverage: vi.fn(() => () => {}) }));
vi.mock("./incumbent-check.js", () => ({
	antiStompDepsFor: vi.fn(() => ({})),
	settleIncumbentAtBind: vi.fn(async () => ({ verdict: "free" })),
}));
vi.mock("./protocol-status.js", () => ({
	buildStartupMessage: vi.fn(() => "listening"),
	computeClassifierStatusLine: vi.fn(() => "classifier:off"),
	formatScannerStatusLine: vi.fn(() => "scanner:ready"),
}));
vi.mock("./startup-guard.js", () => ({
	runStartupSelfCheck: vi.fn(async () => true),
	startFramedDaemonOrExit: vi.fn(async () => ({})),
}));

const CWD = "/tmp/daemon-activation-cwd";
const RULES = makeGuardRules();
const { createProtocolStatus } = await vi.importActual<typeof import("./protocol-status.js")>("./protocol-status.js");
vi.mock("./hook-coverage.js", () => ({ activateHookCoverage: vi.fn(() => () => {}) }));

type ActivateOptions = Parameters<typeof activateDaemon>[0];

/** The daemon collaborators `activateDaemon` reads, reduced to the members it
 *  actually touches — every heavyweight one is mocked at module scope above. */
function makeOptions(): ActivateOptions {
	const runtime = makeServerRuntime({ cwd: CWD, rules: RULES });
	return {
		cli: {
			cwd: CWD,
			interlinkedDir: `${CWD}/.interlinked`,
			socketPath: `${CWD}/.interlinked/harness.sock`,
			pidPath: `${CWD}/.interlinked/harness.pid`,
			framedPaths: daemonPathsFor(CWD, "sess-activation"),
			verbose: false,
			framedSessionId: "sess-activation",
			protocolMode: "raw",
			runRawSocket: false,
			runFramedSocket: false,
			idleTimeoutMs: 600_000,
		},
		state: {
			...runtime, writeScannerStatus: vi.fn(), deliverMutationFindingToSessions: vi.fn(() => 0),
			serverBridge: null,
			protocolStatusPath: `${CWD}/.interlinked/harness-protocol.json`,
			protocolStatus: createProtocolStatus({ protocol: "raw", rawSocketPath: null, framedSocketPath: null, framedSessionId: null }),
		},
		runtime,
		socketLifecycle: {
			setUnwatchers: vi.fn(),
			setFramedDaemon: vi.fn(),
			writePidFile: vi.fn(),
			cleanupSocket: vi.fn(),
			startRawServer: vi.fn(),
			shutdown: vi.fn(),
		},
		startupGuard: { note: vi.fn(), fail: vi.fn(), isStartupComplete: () => true, onStartupFailure: vi.fn() },
		earlyShutdown: { upgrade: vi.fn() },
		moduleUrl: "file:///dist/harness/server.js",
		getRules: () => RULES,
		setRules: vi.fn(),
		setCompiledAllowlist: vi.fn(),
		getLastHookEventAtMs: () => 0,
		getTrigramIndex: () => null,
		getGraphForFile: () => new ProjectGraph(CWD),
		resetIdleTimer: vi.fn(),
		refreshStatuslineSnapshot: vi.fn(),
		shutdownWith: vi.fn(),
		evaluateEventLine: vi.fn<ActivateOptions["evaluateEventLine"]>(async () => ({ decision: "allow" })),
		evaluateUnifiedViaRuntime: vi.fn<NonNullable<ActivateOptions["evaluateUnifiedViaRuntime"]>>(async () => ({ decision: "allow" })),
		writeProtocolStatus: vi.fn(),
		log: vi.fn(),
		logAlways: vi.fn(),
	};
}

describe("activateDaemon — callbacks handed to collaborators", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		process.removeAllListeners("SIGHUP");
	});

	it("gives the daemon timers a recycle lease that reports the startup lock outcome", async () => {
		const options = makeOptions();
		await activateDaemon(options);
		expect(activateHookCoverage).toHaveBeenCalledWith(options.runtime);
		const timerHooks = vi.mocked(installDaemonTimers).mock.calls[0]?.[0];

		vi.mocked(acquireStartupLock).mockReturnValueOnce({
			acquired: true,
			path: "/lock",
			release: () => {},
		});
		expect(timerHooks?.acquireRecycleLease?.()).toBe(true);

		vi.mocked(acquireStartupLock).mockReturnValueOnce({ acquired: false, holder: null });
		expect(timerHooks?.acquireRecycleLease?.()).toBe(false);

		expect(vi.mocked(acquireStartupLock)).toHaveBeenCalledWith(CWD);
	});

	it("routes startup self-check events to the daemon ledger under the daemon cwd", async () => {
		const recorded: Array<{ root: string; event: DaemonLedgerEvent }> = [];
		vi.mocked(recordDaemonEvent).mockImplementation((root, event) => {
			recorded.push({ root, event });
		});

		await activateDaemon(makeOptions());
		const selfCheckDeps = vi.mocked(runStartupSelfCheck).mock.calls[0]?.[0];
		recorded.length = 0;

		selfCheckDeps?.recordEvent?.({
			at: 1_730_000_000_000,
			pid: 4242,
			event: "exit",
			reason: "self-check-failed",
		});

		expect(recorded).toEqual([
			{
				root: CWD,
				event: { at: 1_730_000_000_000, pid: 4242, event: "exit", reason: "self-check-failed" },
			},
		]);
	});
});
