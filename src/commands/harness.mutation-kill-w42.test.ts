// ===========================================
// interlinked harness — wave pass1_w42 survivor kills
// ===========================================
// Targets 33 listed survivors in src/commands/harness.ts. Every dependency
// of harness.ts is mocked so each handler runs deterministically with no
// real process/socket I/O. `../lib/output.js` is mocked with a capturing
// replica of the real `output()` dispatcher so the raw `data` argument
// (which several call sites never route into a renderer) is inspectable
// directly — several survivors live entirely inside that dead parameter.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	distStaleness: vi.fn(),
	stalenessWarning: vi.fn(),
	readRecentDaemonEvents: vi.fn(),
	recordDaemonEvent: vi.fn(),
	detectEnforcementGaps: vi.fn(),
	formatEnforcementGapWarning: vi.fn(),
	acquireStartupLock: vi.fn(),
	waitForDaemonSocket: vi.fn(),
	startupInFlight: vi.fn(),
	touchStartupLock: vi.fn(),
	probeHarnessLive: vi.fn(),
	probeHarnessSocket: vi.fn(),
	livenessStatusValue: vi.fn(),
	zombieWarningLine: vi.fn(),
	reapOrphanHarnessesVerified: vi.fn(),
	stopAllDaemons: vi.fn(),
	reportRestartDecision: vi.fn(),
	resolveRestartAction: vi.fn(),
	buildHarnessSpawnArgs: vi.fn(),
	cleanStaleRestartFiles: vi.fn(),
	reportPendingStart: vi.fn(),
	daemonizeHarness: vi.fn(),
	framedSocketLines: vi.fn(),
	lockedJsonRestartStart: vi.fn(),
	protocolStatusLines: vi.fn(),
	startHarnessForeground: vi.fn(),
	stopRunningHarnessForRestart: vi.fn(),
	ensureDistFresh: vi.fn(),
	getFramedSocketPath: vi.fn(),
	getHarnessServerPath: vi.fn(),
	getSocketPath: vi.fn(),
	isHarnessRunning: vi.fn(),
	collectAncestorPids: vi.fn(),
	readActiveHarnessPid: vi.fn(),
	reapOrphanHarnesses: vi.fn(),
	parseHarnessProtocol: vi.fn(),
	queryHarness: vi.fn(),
	readActiveMode: vi.fn(),
	readFramedSocketStatuses: vi.fn(),
	readLastLatencyTimestamp: vi.fn(),
	readProtocolStatus: vi.fn(),
	readRssMb: vi.fn(),
	buildHarnessTestEvent: vi.fn(),
	resolveHarnessTestInput: vi.fn(),
	harnessHealthCommand: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
}));

vi.mock("../harness/build-staleness.js", () => ({
	distStaleness: mocks.distStaleness,
	stalenessWarning: mocks.stalenessWarning,
}));

vi.mock("../harness/daemon-ledger.js", () => ({
	readRecentDaemonEvents: mocks.readRecentDaemonEvents,
	recordDaemonEvent: mocks.recordDaemonEvent,
}));

vi.mock("../harness/enforcement-gap.js", () => ({
	detectEnforcementGaps: mocks.detectEnforcementGaps,
	formatEnforcementGapWarning: mocks.formatEnforcementGapWarning,
}));

vi.mock("../harness/startup-lock.js", () => ({
	acquireStartupLock: mocks.acquireStartupLock,
	waitForDaemonSocket: mocks.waitForDaemonSocket,
	startupInFlight: mocks.startupInFlight,
	touchStartupLock: mocks.touchStartupLock,
}));

vi.mock("../lib/formatter.js", () => ({
	c: {
		bold: (s: string) => s,
		dim: (s: string) => s,
		red: (s: string) => s,
		green: (s: string) => s,
		yellow: (s: string) => s,
		cyan: (s: string) => s,
		blue: (s: string) => s,
	},
	header: (title: string) => `## ${title}`,
	kvLine: (key: string, value: string) => `${key}: ${value}`,
}));

// Capturing replica of ../lib/output.js. `capturedData` records the raw
// `data` argument passed to every `output()` call so a mutation that lives
// entirely inside a call site's `data` literal (never routed into a
// renderer) is still observable.
const capturedData: unknown[] = [];
vi.mock("../lib/output.js", () => ({
	getOutputMode: (options: { json?: boolean; short?: boolean; full?: boolean }) => {
		if (options.json) return "json";
		if (options.short) return "short";
		if (options.full) return "full";
		return "normal";
	},
	output: (
		mode: string,
		data: unknown,
		renderers: {
			json?: () => unknown;
			short?: () => string;
			normal: () => string;
			full?: () => string;
		},
	) => {
		capturedData.push(data);
		switch (mode) {
			case "json":
				console.log(JSON.stringify(renderers.json ? renderers.json() : data, null, 2));
				break;
			case "short":
				console.log(renderers.short ? renderers.short() : renderers.normal());
				break;
			case "full":
				console.log(renderers.full ? renderers.full() : renderers.normal());
				break;
			default:
				console.log(renderers.normal());
		}
	},
	outputError: (mode: string, message: string) => {
		if (mode === "json") {
			console.error(JSON.stringify({ error: message }, null, 2));
		} else {
			console.error(message);
		}
		process.exitCode = 1;
	},
}));

vi.mock("./harness-liveness.js", () => ({
	classifyHarnessLiveness: (input: { processRunning: boolean; socketAnswered: boolean }) => {
		if (input.socketAnswered) return "listening";
		return input.processRunning ? "zombie" : "stopped";
	},
	livenessStatusValue: mocks.livenessStatusValue,
	probeHarnessLive: mocks.probeHarnessLive,
	probeHarnessSocket: mocks.probeHarnessSocket,
	zombieWarningLine: mocks.zombieWarningLine,
}));

vi.mock("./harness-daemon-control.js", () => ({
	reapOrphanHarnessesVerified: mocks.reapOrphanHarnessesVerified,
	stopAllDaemons: mocks.stopAllDaemons,
	collectServingDaemonPids: vi.fn(),
}));

vi.mock("./harness-restart-guard.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./harness-restart-guard.js")>();
	return {
		reportRestartDecision: mocks.reportRestartDecision,
		resolveRestartAction: mocks.resolveRestartAction,
		// REAL attempt helpers, with only the ledger sink and env injected —
		// the "records the explicit-restart ledger entry" pin below keeps
		// asserting the genuine row shape (now written by beginRestartAttempt).
		beginRestartAttempt: (cwd: string) =>
			actual.beginRestartAttempt(cwd, {
				recordEvent: (evt) => mocks.recordDaemonEvent(cwd, evt),
				env: {},
			}),
		failRestartAttempt: (cwd: string, attemptId: string, detail: string) =>
			actual.failRestartAttempt(cwd, attemptId, detail, {
				recordEvent: (evt) => mocks.recordDaemonEvent(cwd, evt),
			}),
	};
});

vi.mock("./harness-lifecycle-helpers.js", () => ({
	buildHarnessSpawnArgs: mocks.buildHarnessSpawnArgs,
	cleanStaleRestartFiles: mocks.cleanStaleRestartFiles,
	reportPendingStart: mocks.reportPendingStart,
	daemonizeHarness: mocks.daemonizeHarness,
	framedSocketLines: mocks.framedSocketLines,
	lockedJsonRestartStart: mocks.lockedJsonRestartStart,
	protocolStatusLines: mocks.protocolStatusLines,
	startHarnessForeground: mocks.startHarnessForeground,
	stopRunningHarnessForRestart: mocks.stopRunningHarnessForRestart,
}));

vi.mock("./harness-process.js", () => ({
	ensureDistFresh: mocks.ensureDistFresh,
	getFramedSocketPath: mocks.getFramedSocketPath,
	getHarnessServerPath: mocks.getHarnessServerPath,
	getSocketPath: mocks.getSocketPath,
	isHarnessRunning: mocks.isHarnessRunning,
	collectAncestorPids: mocks.collectAncestorPids,
	readActiveHarnessPid: mocks.readActiveHarnessPid,
	reapOrphanHarnesses: mocks.reapOrphanHarnesses,
}));

vi.mock("./harness-status-helpers.js", () => ({
	parseHarnessProtocol: mocks.parseHarnessProtocol,
	queryHarness: mocks.queryHarness,
	readActiveMode: mocks.readActiveMode,
	readFramedSocketStatuses: mocks.readFramedSocketStatuses,
	readLastLatencyTimestamp: mocks.readLastLatencyTimestamp,
	readProtocolStatus: mocks.readProtocolStatus,
	readRssMb: mocks.readRssMb,
}));

vi.mock("./harness-test-event.js", () => ({
	buildHarnessTestEvent: mocks.buildHarnessTestEvent,
	resolveHarnessTestInput: mocks.resolveHarnessTestInput,
}));

vi.mock("./harness-health.js", () => ({
	harnessHealthCommand: mocks.harnessHealthCommand,
}));

import {
	harnessRestartCommand,
	harnessStartCommand,
	harnessStatusCommand,
	harnessStopCommand,
	harnessTestCommand,
} from "./harness.js";

let logs: string[];
let errs: string[];

function logText(): string {
	return logs.join("\n");
}

const SOCK = "/repo/.interlinked/harness.sock";

beforeEach(() => {
	for (const m of Object.values(mocks)) m.mockReset();
	capturedData.length = 0;
	logs = [];
	errs = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		errs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
	});
	vi.spyOn(process, "cwd").mockReturnValue("/repo");
	process.exitCode = 0;

	mocks.existsSync.mockReturnValue(false);
	mocks.distStaleness.mockReturnValue(null);
	mocks.stalenessWarning.mockReturnValue(null);
	mocks.readRecentDaemonEvents.mockReturnValue([]);
	mocks.detectEnforcementGaps.mockReturnValue([]);
	mocks.formatEnforcementGapWarning.mockReturnValue(null);
	mocks.acquireStartupLock.mockReturnValue({
		acquired: true,
		path: "/repo/.interlinked/.harness-start.lock",
		release: vi.fn(),
	});
	mocks.waitForDaemonSocket.mockResolvedValue(false);
	mocks.startupInFlight.mockReturnValue(false);
	mocks.probeHarnessLive.mockResolvedValue(false);
	mocks.probeHarnessSocket.mockResolvedValue(false);
	mocks.livenessStatusValue.mockImplementation(
		(state: string, pid: number | undefined) => `status:${state}:${pid ?? "?"}`,
	);
	mocks.zombieWarningLine.mockReturnValue("zombie-warning");
	mocks.reapOrphanHarnessesVerified.mockResolvedValue({ candidates: [], killed: [], dryRun: false });
	mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [] });
	mocks.resolveRestartAction.mockResolvedValue({ action: "proceed" });
	mocks.cleanStaleRestartFiles.mockResolvedValue(undefined);
	mocks.stopRunningHarnessForRestart.mockResolvedValue({ oldPid: undefined, survived: false });
	mocks.lockedJsonRestartStart.mockResolvedValue(undefined);
	mocks.reportPendingStart.mockResolvedValue(undefined);
	mocks.framedSocketLines.mockReturnValue([]);
	mocks.protocolStatusLines.mockReturnValue([]);
	mocks.ensureDistFresh.mockReturnValue(undefined);
	mocks.getFramedSocketPath.mockReturnValue("/repo/.interlinked/harness-default.sock");
	mocks.getHarnessServerPath.mockReturnValue("/repo/dist/harness/server.js");
	mocks.getSocketPath.mockReturnValue(SOCK);
	mocks.isHarnessRunning.mockReturnValue({ running: false });
	mocks.parseHarnessProtocol.mockImplementation((raw: string | undefined) =>
		raw === "raw" || raw === "framed" || raw === "dual" ? raw : "dual",
	);
	mocks.queryHarness.mockResolvedValue(null);
	mocks.readActiveMode.mockReturnValue(null);
	mocks.readFramedSocketStatuses.mockResolvedValue([]);
	mocks.readLastLatencyTimestamp.mockReturnValue(null);
	mocks.readProtocolStatus.mockReturnValue(null);
	mocks.readRssMb.mockReturnValue(null);
	mocks.buildHarnessTestEvent.mockReturnValue({
		toolName: "Bash",
		displayLabel: "echo hi",
		event: {},
	});
	mocks.resolveHarnessTestInput.mockResolvedValue({ kind: "bash", command: "echo hi" });
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

// ===========================================================================
// harnessStartCommand — already-running branch
// ===========================================================================

describe("harnessStartCommand — socket-authoritative already-running data + text", () => {
	it("reports an answering daemon without running the orphan reaper", async () => {
		mocks.probeHarnessSocket.mockResolvedValue(true);
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 999 });
		mocks.reapOrphanHarnessesVerified.mockResolvedValue({
			candidates: [],
			killed: ["1111", "2222"],
			dryRun: false,
		});
		await harnessStartCommand({});
		expect(capturedData).toContainEqual({
			already_running: true,
			pid: 999,
			reaped: [],
		});
		expect(logText()).toBe("Harness already running (PID 999)");
		expect(mocks.reapOrphanHarnessesVerified).not.toHaveBeenCalled();
	});

	it("prints the plain already-running line for a pid-backed answering socket", async () => {
		mocks.probeHarnessSocket.mockResolvedValue(true);
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 42 });
		await harnessStartCommand({});
		expect(logText()).toBe("Harness already running (PID 42)");
		expect(logText()).not.toContain("reaped");
		expect(mocks.reapOrphanHarnessesVerified).not.toHaveBeenCalled();
	});

	it("does not throw when the lock loser's holder is undefined (optional chaining)", async () => {
		mocks.acquireStartupLock.mockReturnValue({ acquired: false, path: "x" });
		await expect(harnessStartCommand({ json: true })).resolves.toBeUndefined();
		expect(mocks.reportPendingStart).toHaveBeenCalledWith("/repo", null, { json: true });
	});

	it("passes the holder pid through when a holder is present", async () => {
		mocks.acquireStartupLock.mockReturnValue({
			acquired: false,
			path: "x",
			holder: { pid: 4242, at: 1 },
		});
		await harnessStartCommand({});
		expect(mocks.reportPendingStart).toHaveBeenCalledWith("/repo", 4242, {});
	});
});

// ===========================================================================
// harnessStopCommand
// ===========================================================================

describe("harnessStopCommand — data objects + join separators (mutantIds 5c8bdc77f7748cc3, d5f35a190f6057b7, ed4997c1aad78611, 26e4ee00fe99c005, 6ef57c91ce2d8296, 5798615d6c66154a, 004470786f9025e6, b2fad1f93315618d)", () => {
	it("captures { stopped: false } exactly when nothing was found to stop", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [] });
		await harnessStopCommand({});
		expect(capturedData).toContainEqual({ stopped: false });
	});

	it("captures stopped:true with the full pids/survived shape when everything died", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [1, 2], survived: [] });
		await harnessStopCommand({});
		expect(capturedData).toContainEqual({ stopped: true, pids: [1, 2], survived: [] });
	});

	it("captures stopped:false when a daemon survived", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [1], survived: [3] });
		await harnessStopCommand({});
		expect(capturedData).toContainEqual({ stopped: false, pids: [1], survived: [3] });
	});

	it("joins multiple survivors with comma-space and the kill hint with a single space", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [3, 4] });
		await harnessStopCommand({});
		expect(logText()).toContain("PID(s) 3, 4 survived SIGKILL");
		expect(logText()).toContain("Investigate process permissions or kernel state manually");
	});

	it("joins multiple stopped pids with comma-space in the success line", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [5, 6], survived: [] });
		await harnessStopCommand({});
		expect(logText()).toBe("Harness stopped (2 daemon(s): 5, 6)");
	});
});

// ===========================================================================
// harnessRestartCommand
// ===========================================================================

describe("harnessRestartCommand — ledger event + default sessionId + survived guard (mutantIds 3f6999fb94a5b822, 7dcdee3d6a2d81ca, d873c144eef000be, 665a73646e0f8ce2, 0844ca1194a91224)", () => {
	it("records the full handover/explicit-restart ledger entry before stopping", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.stopRunningHarnessForRestart.mockResolvedValue({ oldPid: undefined, survived: false });
		await harnessRestartCommand({ json: true });
		expect(mocks.recordDaemonEvent).toHaveBeenCalledWith(
			"/repo",
			expect.objectContaining({
				pid: process.pid,
				event: "handover",
				reason: "explicit-restart",
			}),
		);
		const call = mocks.recordDaemonEvent.mock.calls[0]?.[1] as { at: number };
		expect(typeof call.at).toBe("number");
	});

	it("passes the default session id through to the JSON restart-start path", async () => {
		mocks.stopRunningHarnessForRestart.mockResolvedValue({ oldPid: undefined, survived: false });
		await harnessRestartCommand({ json: true });
		expect(mocks.lockedJsonRestartStart).toHaveBeenCalledWith(
			"/repo",
			expect.anything(),
			"dual",
			"default",
			undefined,
			"json",
		);
	});

	it("passes an explicit session id through unchanged", async () => {
		mocks.stopRunningHarnessForRestart.mockResolvedValue({ oldPid: undefined, survived: false });
		await harnessRestartCommand({ json: true, sessionId: "alpha" });
		expect(mocks.lockedJsonRestartStart).toHaveBeenCalledWith(
			"/repo",
			expect.anything(),
			"dual",
			"alpha",
			undefined,
			"json",
		);
	});

	it("aborts before start when the daemon survives SIGKILL — cleanup and restart-start never run", async () => {
		mocks.stopRunningHarnessForRestart.mockResolvedValue({ oldPid: 300, survived: true });
		await harnessRestartCommand({ json: true });
		expect(mocks.cleanStaleRestartFiles).not.toHaveBeenCalled();
		expect(mocks.lockedJsonRestartStart).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// harnessStatusCommand
// ===========================================================================

describe("harnessStatusCommand — orphan dryRun + ?? null fields (mutantIds b6195fe3e7b7c816, a0f88f4d003df4d2, b066947290b66be4, 8ce83d9c763a71f0, 710b34fadd283894)", () => {
	it("calls the orphan probe with { dryRun: true } exactly", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		await harnessStatusCommand({});
		expect(mocks.reapOrphanHarnessesVerified).toHaveBeenCalledWith("/repo", { dryRun: true });
	});

	it("carries truthy last_framed_event_at / framed_timeout_count straight through into the JSON report", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 4242 });
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue({ ok: true });
		mocks.readProtocolStatus.mockReturnValue({
			protocol_version: "9",
			last_raw_event_at: null,
			last_framed_event_at: "2026-08-01T00:00:00Z",
			framed_error_count: 0,
			framed_timeout_count: 5,
		});
		await harnessStatusCommand({ json: true });
		const parsed = JSON.parse(logText()) as {
			last_framed_event_at: string | null;
			framed_timeout_count: number | null;
		};
		expect(parsed.last_framed_event_at).toBe("2026-08-01T00:00:00Z");
		expect(parsed.framed_timeout_count).toBe(5);
	});

	it("a framed socket with health:null does not count as an answering listener", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 7 });
		mocks.existsSync.mockReturnValue(false);
		mocks.probeHarnessLive.mockResolvedValue(false);
		mocks.readFramedSocketStatuses.mockResolvedValue([
			{
				session_id: "default",
				pid: 7,
				alive: true,
				socket_path: "/repo/.interlinked/harness-default.sock",
				health: null,
				health_error: "timeout",
			},
		]);
		await harnessStatusCommand({ json: true });
		const parsed = JSON.parse(logText()) as { socket_answered: boolean; liveness: string };
		expect(parsed.socket_answered).toBe(false);
		expect(parsed.liveness).toBe("zombie");
	});
});

describe("harnessStatusCommand — normal-mode optional lines (mutantIds c71d31997493156f, c9721a2e8b80eef5, 239c98a43fc54cbc, 6f753f9e57657506, c9e955b29b9887aa, 04cdca65cb630dbb, 9df073e3e6011480, 03123be2fdb34469, cf65ad9633966b37, 03bd6c9637704514)", () => {
	it("omits RSS/Build/Mode/Last-event lines and prints Orphans: 0 when nothing is set", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.existsSync.mockReturnValue(false);
		mocks.readRssMb.mockReturnValue(null);
		mocks.stalenessWarning.mockReturnValue(null);
		mocks.readActiveMode.mockReturnValue(null);
		mocks.readLastLatencyTimestamp.mockReturnValue(null);
		mocks.reapOrphanHarnessesVerified.mockResolvedValue({ candidates: [], killed: [], dryRun: true });
		await harnessStatusCommand({});
		const out = logText();
		expect(out).not.toContain("RSS:");
		expect(out).not.toContain("Build:");
		expect(out).not.toContain("Mode:");
		expect(out).not.toContain("Last event:");
		expect(out).toContain("Orphans: 0");
		expect(out).not.toContain("run 'interlinked harness reap'");
		// The lines array must start life empty — no injected literal survives.
		expect(out).not.toContain("Stryker was here");
		// join("\n") must actually separate lines, not glue them.
		expect(out).toContain("## Harness Status\nStatus:");
	});

	it("prints Orphans with the reap hint when candidates exist", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.existsSync.mockReturnValue(false);
		mocks.reapOrphanHarnessesVerified.mockResolvedValue({
			candidates: [{ pid: 1, ppid: 2, command: "node server" }],
			killed: [],
			dryRun: true,
		});
		await harnessStatusCommand({});
		expect(logText()).toContain("Orphans: 1 (run 'interlinked harness reap' to inspect)");
		expect(logText()).not.toContain("Orphans: 0");
	});

	it("prints every optional line when every optional value is set", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 4242 });
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue({ ok: true });
		mocks.readRssMb.mockReturnValue(321);
		mocks.stalenessWarning.mockReturnValue("dist is stale");
		mocks.readActiveMode.mockReturnValue("quality");
		mocks.readLastLatencyTimestamp.mockReturnValue("2026-06-01T00:00:00Z");
		await harnessStatusCommand({});
		const out = logText();
		expect(out).toContain("RSS: 321 MB");
		expect(out).toContain("Build: dist is stale");
		expect(out).toContain("Mode: quality");
		expect(out).toContain("Last event: 2026-06-01T00:00:00Z");
	});

	it("does not append a gap-warning block when there is no gap", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.existsSync.mockReturnValue(false);
		mocks.formatEnforcementGapWarning.mockReturnValue(null);
		await harnessStatusCommand({});
		const out = logText();
		expect(out).not.toContain("null");
		expect(out).not.toContain("Stryker was here");
	});

	it("appends the gap-warning block exactly once when a gap is reported", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.existsSync.mockReturnValue(false);
		mocks.formatEnforcementGapWarning.mockReturnValue("Guard was OFF for 9h07m.");
		await harnessStatusCommand({});
		expect(logText()).toContain("Guard was OFF for 9h07m.");
	});
});

// ===========================================================================
// harnessTestCommand
// ===========================================================================

describe("harnessTestCommand — harness-not-running data object (mutantIds 81a4388a5918596b, 43a9492cc61d64b3)", () => {
	it("captures { error: 'harness_not_running' } exactly and prints the fixed message", async () => {
		mocks.existsSync.mockReturnValue(false);
		await harnessTestCommand("echo hi", {});
		expect(capturedData).toContainEqual({ error: "harness_not_running" });
		expect(logText()).toContain("Harness not running. Start with: interlinked harness start");
	});

	it("captures the same shape under --json mode", async () => {
		mocks.existsSync.mockReturnValue(false);
		await harnessTestCommand("echo hi", { json: true });
		expect(capturedData).toContainEqual({ error: "harness_not_running" });
		const parsed = JSON.parse(logText()) as { error: string };
		expect(parsed.error).toBe("Harness not running");
	});
});
