// Harness liveness — the ROUND-TRIP verdict both diagnostics now depend on.
//
// The bug this module exists to close (audit F1, 2026-08-14): `harness status`
// and `doctor` judged the daemon by pid-liveness alone, so a process kept
// resident by crash-resilience with no listening socket was reported as
// healthy by both — while every tool call was failing closed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	queryHarnessSocket: vi.fn(),
	framedHealth: vi.fn(),
	daemonSocketPaths: vi.fn(),
}));

vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("./harness-process.js", () => ({
	getSocketPath: (cwd: string) => `${cwd}/.interlinked/harness.sock`,
	getFramedSocketPath: (cwd: string) => `${cwd}/.interlinked/harness-default.sock`,
}));
vi.mock("./harness-status-helpers.js", () => ({
	queryHarnessSocket: mocks.queryHarnessSocket,
}));
// Framed probing goes through the REAL RPC client + daemon discovery (review
// 2026-08-26): mock both so the unit tests control framed health directly.
vi.mock("../harness/daemon-client.js", () => ({
	createDaemonClient: (path: string) => ({
		call: (method: string) => mocks.framedHealth(path, method),
	}),
}));
vi.mock("../harness/session-paths.js", () => ({
	daemonSocketPaths: mocks.daemonSocketPaths,
	discoverDaemons: () => [],
}));

const RAW = "/repo/.interlinked/harness.sock";
const FRAMED = "/repo/.interlinked/harness-default.sock";
const VALID_HEALTH = {
	status: "ready",
	uptime_ms: 1,
	warm_caches: [],
	tsgo_status: "ready",
	rpc_inflight: 0,
	protocol_version: "1",
};
// Identity colors so assertions compare words, not ANSI.
vi.mock("../lib/formatter.js", () => ({
	c: {
		green: (s: string) => s,
		red: (s: string) => s,
		yellow: (s: string) => s,
		dim: (s: string) => s,
		bold: (s: string) => s,
	},
}));

import {
	classifyHarnessLiveness,
	harnessServerRow,
	LIVENESS_PROBE_TIMEOUT_MS,
	parseDaemonHealth,
	livenessStatusValue,
	probeHarnessLive,
	probeHarnessSocket,
	zombieWarningLine,
} from "./harness-liveness.js";

beforeEach(() => {
	mocks.existsSync.mockReset();
	mocks.queryHarnessSocket.mockReset();
	mocks.framedHealth.mockReset();
	mocks.daemonSocketPaths.mockReset().mockReturnValue([RAW, FRAMED]);
	// Default: framed probes fail cleanly unless a test arms them.
	mocks.framedHealth.mockRejectedValue(new Error("no framed daemon"));
});

describe("classifyHarnessLiveness", () => {
	// P1: the state the whole fix exists for.
	it("calls a live pid with no answer a zombie", () => {
		expect(classifyHarnessLiveness({ processRunning: true, socketAnswered: false })).toBe(
			"zombie",
		);
	});

	// P2: an answer is proof, whatever the pid file says.
	it("calls an answering socket listening even when the pid file is stale", () => {
		expect(classifyHarnessLiveness({ processRunning: true, socketAnswered: true })).toBe(
			"listening",
		);
		expect(classifyHarnessLiveness({ processRunning: false, socketAnswered: true })).toBe(
			"listening",
		);
	});

	// N1: nothing running, nothing answering — the honest empty state.
	it("calls no pid and no answer stopped", () => {
		expect(classifyHarnessLiveness({ processRunning: false, socketAnswered: false })).toBe(
			"stopped",
		);
	});
});

describe("probeHarnessSocket", () => {
	// P1: a decision line back means the daemon is serving.
	it("returns true when the daemon answers", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarnessSocket.mockResolvedValue({ decision: "allow" });
		await expect(probeHarnessSocket("/repo")).resolves.toBe(true);
		expect(mocks.queryHarnessSocket).toHaveBeenCalledWith(
			RAW,
			expect.objectContaining({ hook_event: "StatusQuery" }),
			LIVENESS_PROBE_TIMEOUT_MS,
			expect.anything(), // the cancellation signal (review pass 15)
		);
	});

	// P4 (review 2026-08-26): a FRAMED-ONLY daemon is the normal modern case —
	// the raw-only probe called it dead, and the unref'd confirm timer then let
	// the whole status command exit code 13 before framed health was checked.
	// Framed health is a REAL `daemon.health` RPC, never a raw StatusQuery.
	it("returns true when only the FRAMED socket exists and its daemon.health answers", async () => {
		mocks.existsSync.mockImplementation((p: string) => p === FRAMED);
		mocks.framedHealth.mockResolvedValue(VALID_HEALTH);
		await expect(probeHarnessSocket("/repo")).resolves.toBe(true);
		expect(mocks.queryHarnessSocket).not.toHaveBeenCalled();
		expect(mocks.framedHealth).toHaveBeenCalledWith(FRAMED, "daemon.health");
	});

	it("discovers a named framed socket even when its pid file is missing", async () => {
		const named = "/repo/.interlinked/harness-agent-42.sock";
		mocks.daemonSocketPaths.mockReturnValue([named]);
		mocks.existsSync.mockImplementation((p: string) => p === named);
		mocks.framedHealth.mockResolvedValue(VALID_HEALTH);
		await expect(probeHarnessSocket("/repo")).resolves.toBe(true);
		expect(mocks.framedHealth).toHaveBeenCalledWith(named, "daemon.health");
	});

	// N-health (review pass 15): a correct envelope with an INVALID health body
	// must not count — "any object" was the old, too-permissive rule.
	it("returns false when the framed daemon answers with an invalid health body", async () => {
		mocks.existsSync.mockImplementation((p: string) => p === FRAMED);
		mocks.framedHealth.mockResolvedValue({ status: "ok" });
		await expect(probeHarnessSocket("/repo")).resolves.toBe(false);
	});

	it("accepts a DEGRADED daemon as alive — it is serving, its report says how well", async () => {
		mocks.existsSync.mockImplementation((p: string) => p === FRAMED);
		mocks.framedHealth.mockResolvedValue({ ...VALID_HEALTH, status: "degraded" });
		await expect(probeHarnessSocket("/repo")).resolves.toBe(true);
	});

	// P5: one silent socket must not veto the other's answer — and the answer
	// arrives without waiting for the silent sibling's timeout (first success
	// wins; the raw probe here NEVER settles).
	it("returns true when the raw socket never answers but the framed one does", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarnessSocket.mockImplementation(() => new Promise(() => {}));
		mocks.framedHealth.mockResolvedValue(VALID_HEALTH);
		await expect(probeHarnessSocket("/repo")).resolves.toBe(true);
	});

	// N-framed: a framed socket whose health call REJECTS is not healthy.
	it("returns false when the only framed socket rejects the health call", async () => {
		mocks.existsSync.mockImplementation((p: string) => p === FRAMED);
		mocks.framedHealth.mockRejectedValue(new Error("bad_request"));
		await expect(probeHarnessSocket("/repo")).resolves.toBe(false);
	});

	// P2: connected (or timed out) with no answer is NOT serving.
	it("returns false when the query yields nothing", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarnessSocket.mockResolvedValue(null);
		await expect(probeHarnessSocket("/repo")).resolves.toBe(false);
	});

	// N1: no socket file → no dial at all.
	it("short-circuits without querying when neither socket file is present", async () => {
		mocks.existsSync.mockReturnValue(false);
		await expect(probeHarnessSocket("/repo")).resolves.toBe(false);
		expect(mocks.queryHarnessSocket).not.toHaveBeenCalled();
	});

	// P3: the caller's timeout is honored (a diagnostic must not hang).
	it("passes an explicit timeout through", async () => {
		mocks.existsSync.mockImplementation((p: string) => p === RAW);
		mocks.queryHarnessSocket.mockResolvedValue(null);
		await expect(probeHarnessSocket("/repo", 25)).resolves.toBe(false);
		expect(mocks.queryHarnessSocket).toHaveBeenCalledWith(
			RAW,
			expect.anything(),
			25,
			expect.anything(),
		);
	});
});

describe("parseDaemonHealth — full-contract validation (review pass 16)", () => {
	it("P: accepts a complete valid health object (typed result returned)", () => {
		expect(parseDaemonHealth(VALID_HEALTH)).toEqual(VALID_HEALTH);
	});

	it("N: rejects the two-field object the old check accepted", () => {
		expect(parseDaemonHealth({ status: "ready", protocol_version: "1" })).toBeNull();
	});

	it("N: rejects an unsupported protocol version — incompatible is not listening", () => {
		expect(parseDaemonHealth({ ...VALID_HEALTH, protocol_version: "garbage" })).toBeNull();
	});

	it("N: rejects wrong field types (uptime as string, warm_caches with non-strings)", () => {
		expect(parseDaemonHealth({ ...VALID_HEALTH, uptime_ms: "1" })).toBeNull();
		expect(parseDaemonHealth({ ...VALID_HEALTH, warm_caches: [1] })).toBeNull();
	});

	it("N: rejects negative or fractional counters (review pass 17)", () => {
		expect(parseDaemonHealth({ ...VALID_HEALTH, uptime_ms: -1 })).toBeNull();
		expect(parseDaemonHealth({ ...VALID_HEALTH, uptime_ms: 1.5 })).toBeNull();
		expect(parseDaemonHealth({ ...VALID_HEALTH, rpc_inflight: -2 })).toBeNull();
	});

	it("N: rejects a missing tsgo_status and non-object values", () => {
		const { tsgo_status: _dropped, ...withoutTsgo } = VALID_HEALTH;
		expect(parseDaemonHealth(withoutTsgo)).toBeNull();
		expect(parseDaemonHealth(null)).toBeNull();
		expect(parseDaemonHealth("ready")).toBeNull();
	});
});

describe("probeHarnessLive", () => {
	// P1: an immediate answer costs exactly one round-trip.
	it("returns true on the first answer without re-probing", async () => {
		mocks.existsSync.mockImplementation((p: string) => p === RAW);
		mocks.queryHarnessSocket.mockResolvedValue({ decision: "allow" });
		await expect(probeHarnessLive("/repo", true, 0)).resolves.toBe(true);
		expect(mocks.queryHarnessSocket).toHaveBeenCalledTimes(1);
	});

	// P2: a daemon still binding (the `restart && status` window) answers on
	// the confirming probe — it must NOT be reported as a zombie.
	it("re-probes once when a live pid answered nothing, and accepts a late answer", async () => {
		mocks.existsSync.mockImplementation((p: string) => p === RAW);
		mocks.queryHarnessSocket
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ decision: "allow" });
		await expect(probeHarnessLive("/repo", true, 0)).resolves.toBe(true);
		expect(mocks.queryHarnessSocket).toHaveBeenCalledTimes(2);
	});

	// P3: silent twice with a live pid is a real zombie.
	it("returns false when both probes are silent", async () => {
		mocks.existsSync.mockImplementation((p: string) => p === RAW);
		mocks.queryHarnessSocket.mockResolvedValue(null);
		await expect(probeHarnessLive("/repo", true, 0)).resolves.toBe(false);
		expect(mocks.queryHarnessSocket).toHaveBeenCalledTimes(2);
		expect(mocks.queryHarnessSocket.mock.calls[0]?.[0]).toBe(RAW);
		expect(mocks.queryHarnessSocket.mock.calls[1]?.[0]).toBe(RAW);
		expect(mocks.queryHarnessSocket.mock.calls[0]?.[2]).toBe(LIVENESS_PROBE_TIMEOUT_MS);
	});

	// N1: with no live pid there is nothing to wait for — "not running" stays
	// instant, so the common case pays nothing for the zombie check.
	it("does not re-probe when no process is running", async () => {
		mocks.existsSync.mockImplementation((p: string) => p === RAW);
		mocks.queryHarnessSocket.mockResolvedValue(null);
		await expect(probeHarnessLive("/repo", false, 0)).resolves.toBe(false);
		expect(mocks.queryHarnessSocket).toHaveBeenCalledTimes(1);
		expect(mocks.queryHarnessSocket.mock.calls[0]?.[0]).toBe(RAW);
		expect(mocks.queryHarnessSocket.mock.calls[0]?.[2]).toBe(LIVENESS_PROBE_TIMEOUT_MS);
	});
});

describe("harnessServerRow", () => {
	// P1: pid + answer = pass, and the row says WHY it passed.
	it("passes when the socket answered", () => {
		expect(
			harnessServerRow({
				processRunning: true,
				pid: 42,
				socketExists: true,
				socketAnswered: true,
			}),
		).toEqual({ status: "pass", message: "Running (PID 42) -- socket answering" });
	});

	// P2: pid + silence = FAIL with the shared zombie wording.
	it("FAILS with the zombie message when a live pid answers nothing", () => {
		const row = harnessServerRow({
			processRunning: true,
			pid: 42,
			socketExists: true,
			socketAnswered: false,
		});
		expect(row.status).toBe("fail");
		expect(row.message).toBe(zombieWarningLine(42));
	});

	// N1: an un-probed caller keeps the pre-probe wording rather than being
	// handed a verdict nobody measured.
	it("keeps the plain running message when the caller did not probe", () => {
		expect(
			harnessServerRow({
				processRunning: true,
				pid: 42,
				socketExists: true,
				socketAnswered: undefined,
			}),
		).toEqual({ status: "pass", message: "Running (PID 42)" });
	});

	// N2/N3: the two not-running messages are unchanged.
	it("warns about a stale socket, then about the inline fallback", () => {
		expect(
			harnessServerRow({
				processRunning: false,
				pid: undefined,
				socketExists: true,
				socketAnswered: false,
			}),
		).toEqual({
			status: "warn",
			message: "Stale socket found but process not running -- run 'interlinked harness start'",
		});
		expect(
			harnessServerRow({
				processRunning: false,
				pid: undefined,
				socketExists: false,
				socketAnswered: false,
			}),
		).toEqual({
			status: "warn",
			message:
				"Not running -- guard evaluation uses inline fallback (5 checks vs 20+). Start: 'interlinked harness start'",
		});
	});

	// P3: an answering daemon with no pid file (framed-only) still passes.
	it("passes without a pid when something answered", () => {
		expect(
			harnessServerRow({
				processRunning: false,
				pid: undefined,
				socketExists: false,
				socketAnswered: true,
			}),
		).toEqual({ status: "pass", message: "Running -- socket answering" });
	});
});

describe("livenessStatusValue / zombieWarningLine", () => {
	// P1: each state gets distinct words; "running (PID …)" is reserved for a
	// verified listener.
	it("renders one distinct value per state", () => {
		expect(livenessStatusValue("listening", 9)).toBe("running (PID 9) — socket answering");
		expect(livenessStatusValue("zombie", 9)).toBe(
			"ZOMBIE — process alive (PID 9), no socket answering",
		);
		expect(livenessStatusValue("stopped", undefined)).toBe("not running");
	});

	// N1: an unknown pid degrades gracefully instead of printing "undefined".
	it("does not print a literal undefined pid", () => {
		expect(livenessStatusValue("zombie", undefined)).not.toContain("undefined");
		expect(zombieWarningLine(undefined)).not.toContain("undefined");
	});

	// P2: the warning states the consequence and the fix, in that order.
	it("names the consequence and the fix command", () => {
		const line = zombieWarningLine(31337);
		expect(line).toContain("Harness PID 31337");
		expect(line).toContain("guarding nothing");
		expect(line).toContain("interlinked harness restart");
	});
});
