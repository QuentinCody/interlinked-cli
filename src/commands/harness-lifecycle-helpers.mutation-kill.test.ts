import { wireAbsentOptional, parseWire, wireObject, wireOptional, wireString } from "../lib/value-validation.js";
// Mutation-kill wave targeting 47 survived mutants in harness-lifecycle-helpers.ts
// (manifest .interlinked/mutation-manifest.json, generation 2026-08-17). Each test
// carries a `// test-contract:` line naming the mutant class it targets.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	unlinkSync: vi.fn(),
	getOutputMode: vi.fn(),
	output: vi.fn(),
	outputError: vi.fn(),
	waitForDaemonSocket: vi.fn(),
	acquireStartupLock: vi.fn(),
	touchStartupLockHolder: vi.fn(),
	transferStartupLock: vi.fn(),
	reapOrphanHarnessesVerified: vi.fn(),
	stopAllDaemons: vi.fn(),
	getHarnessServerPath: vi.fn(),
	getPidPath: vi.fn(),
	getSocketPath: vi.fn(),
	isHarnessRunning: vi.fn(),
	openDaemonStderrLog: vi.fn(),
	closeDaemonStderrLog: vi.fn(),
	readDaemonStderrLog: vi.fn(),
	expectedSocketPaths: vi.fn(),
	classifyDaemonSocket: vi.fn(),
	isDaemonSocketReady: vi.fn(),
	readHarnessProcessIdentity: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
	readFileSync: mocks.readFileSync,
	unlinkSync: mocks.unlinkSync,
}));
vi.mock("../harness/daemon-process-identity.js", () => ({
	readHarnessProcessIdentity: mocks.readHarnessProcessIdentity,
}));
vi.mock("../harness/startup-lock.js", () => ({
	acquireStartupLock: mocks.acquireStartupLock,
	waitForDaemonSocket: mocks.waitForDaemonSocket,
	// Heartbeat while waiting for readiness (startup-lock work, 2026-08) —
	// a no-op here; these contracts cover readiness detection, not the lock.
	touchStartupLockHolder: mocks.touchStartupLockHolder,
	transferStartupLock: mocks.transferStartupLock,
}));
vi.mock("../lib/output.js", () => ({
	getOutputMode: mocks.getOutputMode,
	output: mocks.output,
	outputError: mocks.outputError,
}));
vi.mock("../lib/formatter.js", () => ({
	c: {
		green: (value: string) => value,
		yellow: (value: string) => value,
		red: (value: string) => value,
		dim: (value: string) => value,
	},
	kvLine: (key: string, value: unknown) => `${key}: ${value}`,
}));
vi.mock("./harness-daemon-control.js", () => ({
	reapOrphanHarnessesVerified: mocks.reapOrphanHarnessesVerified,
	stopAllDaemons: mocks.stopAllDaemons,
}));
vi.mock("./harness-process.js", () => ({
	closeDaemonStderrLog: mocks.closeDaemonStderrLog,
	getHarnessServerPath: mocks.getHarnessServerPath,
	getPidPath: mocks.getPidPath,
	getSocketPath: mocks.getSocketPath,
	isHarnessRunning: mocks.isHarnessRunning,
	openDaemonStderrLog: mocks.openDaemonStderrLog,
	readDaemonStderrLog: mocks.readDaemonStderrLog,
}));
vi.mock("./harness-status-helpers.js", () => ({ expectedSocketPaths: mocks.expectedSocketPaths }));
vi.mock("../harness/session-paths.js", () => ({
	classifyDaemonSocket: mocks.classifyDaemonSocket,
	isDaemonSocketReady: mocks.isDaemonSocketReady,
}));

import {
	buildHarnessSpawnArgs,
	cleanStaleRestartFiles,
	daemonizeHarness,
	inlineJsonRestartStart,
	protocolStatusLines,
	reportPendingStart,
	stopRunningHarnessForRestart,
} from "./harness-lifecycle-helpers.js";

function child(pid = 4321): EventEmitter & {
	pid: number;
	kill: ReturnType<typeof vi.fn>;
	unref: ReturnType<typeof vi.fn>;
} {
	return Object.assign(new EventEmitter(), { pid, kill: vi.fn(), unref: vi.fn() });
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getOutputMode.mockImplementation((opts: { json?: boolean }) => (opts.json ? "json" : "normal"));
	mocks.getSocketPath.mockReturnValue("/tmp/harness.sock");
	mocks.getPidPath.mockReturnValue("/tmp/harness.pid");
	mocks.expectedSocketPaths.mockReturnValue(["/tmp/harness.sock"]);
	mocks.classifyDaemonSocket.mockResolvedValue("absent");
	mocks.isDaemonSocketReady.mockResolvedValue(true);
	mocks.readFileSync.mockReturnValue("777");
	mocks.readHarnessProcessIdentity.mockReturnValue({
		bootId: "boot",
		startId: "start",
	});
	mocks.transferStartupLock.mockReturnValue(true);
	mocks.openDaemonStderrLog.mockReturnValue(undefined);
	mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 777 });
	mocks.reapOrphanHarnessesVerified.mockResolvedValue(undefined);
	mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [] });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("reportPendingStart — holder identity and payload shape", () => {
	// test-contract: invariant — holderPid===null must read "another process", not "PID null".
	it("names an unknown holder as 'another process' in human output", async () => {
		mocks.waitForDaemonSocket.mockResolvedValue(false);
		let normalText = "";
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			normalText = renderers.normal?.() ?? "";
		});
		await reportPendingStart("/repo", null, {});
		expect(normalText).toBe(
			"A harness start is already in flight (another process); it has not answered yet. Retry in a few seconds — do not start another one.",
		);
	});

	// test-contract: public-api — a known holder pid must render exactly "PID <n>".
	it("names a known holder by its exact pid in human output", async () => {
		mocks.waitForDaemonSocket.mockResolvedValue(true);
		let normalText = "";
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			normalText = renderers.normal?.() ?? "";
		});
		await reportPendingStart("/repo", 88, {});
		expect(normalText).toBe("Harness already running (started by PID 88)");
	});

	// test-contract: invariant — start_pending must be the negation of live, and the data object is exact.
	it("emits start_pending as the exact negation of liveness", async () => {
		mocks.waitForDaemonSocket.mockResolvedValueOnce(true);
		let data: unknown;
		mocks.output.mockImplementation((_mode, passedData) => {
			data = passedData;
		});
		await reportPendingStart("/repo", 5, { json: true });
		expect(data).toEqual({ already_running: true, start_pending: false, starter_pid: 5 });
	});
});

describe("buildHarnessSpawnArgs — exact argv construction", () => {
	// test-contract: public-api — "--expose-gc" and "--cwd" tokens must be present verbatim.
	it("builds the exact verbose framed argv", () => {
		expect(buildHarnessSpawnArgs("server.mjs", "/repo", "framed", "session-1", { verbose: true })).toEqual([
			"--max-old-space-size=1536",
			"--expose-gc",
			"server.mjs",
			"--cwd",
			"/repo",
			"--protocol",
			"framed",
			"--session-id",
			"session-1",
			"--verbose",
		]);
	});

	// test-contract: boundary — opts.verbose must gate the "--verbose" token, not always push it.
	it("omits --verbose when opts.verbose is false", () => {
		expect(buildHarnessSpawnArgs("server.mjs", "/repo", "raw", "ignored", { verbose: false })).toEqual([
			"--max-old-space-size=1536",
			"--expose-gc",
			"server.mjs",
			"--cwd",
			"/repo",
			"--protocol",
			"raw",
		]);
	});
});

describe("daemonizeHarness — readiness detection and failure reporting", () => {
	// test-contract: concurrency — a detached child without the owner-checked
	// startup lease is terminated before any later start can overlap it.
	it("terminates a detached child when the startup lease cannot transfer", async () => {
		const spawned = child(101);
		mocks.spawn.mockReturnValue(spawned);
		mocks.transferStartupLock.mockReturnValue(false);
		await expect(
			daemonizeHarness({
				mode: "normal",
				cwd: "/repo",
				nodePath: "/node",
				spawnArgs: ["server"],
				protocol: "raw",
				sessionId: "s",
				serverPath: "server",
			}),
		).rejects.toThrow("without a transferable startup lease");
		expect(mocks.transferStartupLock).toHaveBeenCalledWith("/repo", { childPid: 101 });
		expect(spawned.kill).toHaveBeenCalledWith("SIGTERM");
		expect(spawned.unref).not.toHaveBeenCalled();
	});

	// test-contract: invariant — stderr log must only be read when NOT ready.
	it("does not read the stderr log once the daemon becomes ready on the first check", async () => {
		mocks.spawn.mockReturnValue(child(101));
		mocks.existsSync.mockReturnValue(true);
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 101 });
		await daemonizeHarness({
			mode: "normal",
			cwd: "/repo",
			nodePath: "/node",
			spawnArgs: ["server"],
			protocol: "raw",
			sessionId: "s",
			serverPath: "server",
		});
		expect(mocks.readDaemonStderrLog).not.toHaveBeenCalled();
	});

	// test-contract: bug — child-exit must break the poll loop and report elapsed SECONDS, not ms:
	// a process exit must break the poll loop promptly and report elapsed SECONDS, not milliseconds.
	it("reports elapsed seconds (not ms) when the child exits before answering", async () => {
		vi.useFakeTimers();
		const spawned = child(80);
		mocks.spawn.mockReturnValue(spawned);
		// A stale inode exists, but no listener accepts a connection.
		mocks.existsSync.mockReturnValue(true);
		mocks.isDaemonSocketReady.mockResolvedValue(false);
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.readDaemonStderrLog.mockReturnValue("");
		let normalText = "";
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			normalText = renderers.normal?.() ?? "";
		});
		const promise = daemonizeHarness({
			mode: "normal",
			cwd: "/repo",
			nodePath: "/node",
			spawnArgs: [],
			protocol: "raw",
			sessionId: "s",
			serverPath: "server",
		});
		spawned.emit("exit");
		await vi.advanceTimersByTimeAsync(500);
		await promise;
		expect(normalText).toContain("Failed to start harness after 1s.");
		expect(mocks.isDaemonSocketReady).toHaveBeenCalledWith("/tmp/harness.sock");
	});

	// test-contract: invariant — readiness requires ALL sockets, not just one.
	it("does not declare ready until every expected socket exists", async () => {
		vi.useFakeTimers();
		const spawned = child(55);
		mocks.spawn.mockReturnValue(spawned);
		mocks.expectedSocketPaths.mockReturnValue(["/a.sock", "/b.sock"]);
		mocks.isDaemonSocketReady.mockImplementation(async (p: string) => p === "/a.sock");
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		let jsonData: unknown;
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			jsonData = renderers.json();
		});
		const promise = daemonizeHarness({
			mode: "normal",
			cwd: "/repo",
			nodePath: "/node",
			spawnArgs: [],
			protocol: "raw",
			sessionId: "s",
			serverPath: "server",
		});
		await Promise.resolve();
		expect(jsonData).toBeUndefined();
		spawned.emit("exit");
		await vi.advanceTimersByTimeAsync(500);
		await promise;
		expect(jsonData).toMatchObject({ status: "failed" });
	});

	// test-contract: boundary — timeout at exactly the 60s budget must stop and report 60s:
	// timeout at exactly the 60s budget must stop, report 60s, and join hint lines with a real newline.
	it("stops at the exact 60s budget and shows the foreground fallback hint", async () => {
		vi.useFakeTimers();
		const spawned = child(95);
		mocks.spawn.mockReturnValue(spawned);
		mocks.existsSync.mockReturnValue(false);
		mocks.isDaemonSocketReady.mockResolvedValue(false);
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.readDaemonStderrLog.mockReturnValue("");
		let normalText = "";
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			normalText = renderers.normal?.() ?? "";
		});
		const promise = daemonizeHarness({
			mode: "normal",
			cwd: "/my/repo",
			nodePath: "/node",
			spawnArgs: [],
			protocol: "raw",
			sessionId: "s",
			serverPath: "/opt/server.mjs",
		});
		await vi.advanceTimersByTimeAsync(60_000);
		await promise;
		expect(normalText).toContain("Failed to start harness after 60s.");
		expect(normalText).toContain("node /opt/server.mjs --cwd /my/repo --verbose");
		expect(normalText).toContain("\n");
	});

	// test-contract: public-api — stderr must be trimmed THEN capped to 500 chars:
	// stderr must be trimmed THEN capped to 500 chars; a leading-space, over-long payload proves both.
	it("trims then truncates stderr output to exactly 500 characters", async () => {
		vi.useFakeTimers();
		const spawned = child(90);
		mocks.spawn.mockReturnValue(spawned);
		mocks.existsSync.mockReturnValue(false);
		mocks.isDaemonSocketReady.mockResolvedValue(false);
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		const longOutput = `  ${"x".repeat(600)}  \n`;
		mocks.readDaemonStderrLog.mockReturnValue(longOutput);
		let normalText = "";
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			normalText = renderers.normal?.() ?? "";
		});
		const promise = daemonizeHarness({
			mode: "normal",
			cwd: "/repo",
			nodePath: "/node",
			spawnArgs: [],
			protocol: "raw",
			sessionId: "s",
			serverPath: "server",
		});
		spawned.emit("exit");
		await vi.advanceTimersByTimeAsync(500);
		await promise;
		expect(normalText).toContain("x".repeat(500));
		expect(normalText).not.toContain("x".repeat(501));
	});
});

describe("stopRunningHarnessForRestart — pid fallback and survivor reporting", () => {
	// test-contract: public-api — nothing stopped and nothing survived must return the exact empty-result shape.
	it("returns the exact empty-result object when no daemon was stopped", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [] });
		expect(await stopRunningHarnessForRestart("/repo", "json")).toEqual({ oldPid: undefined, survived: false });
	});

	// test-contract: bug — must fall back to the stopped list when no prior pid was observed.
	it("falls back to the stopped pid when isHarnessRunning reported none", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [999], survived: [] });
		expect(await stopRunningHarnessForRestart("/repo", "json")).toEqual({ oldPid: 999, survived: false });
	});

	// test-contract: public-api — SIGKILL survivors
	// are reported with the exact object shape and a comma-separated pid list.
	it("reports SIGKILL survivors with an exact object and comma-joined pid list", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 321 });
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [321], survived: [321, 322] });
		const result = await stopRunningHarnessForRestart("/repo", "json");
		expect(result).toEqual({ oldPid: 321, survived: true });
		expect(mocks.outputError).toHaveBeenCalledWith(
			"json",
			"PID(s) 321, 322 survived SIGKILL — possibly kernel-protected. Investigate manually.",
		);
	});
});

describe("cleanStaleRestartFiles — delete-when-stale conditions", () => {
	// test-contract: invariant — stale socket/pid cleanup:
	// a stale (existing, not-running) socket AND pid file must both be unlinked.
	it("deletes both stale artifacts when they exist and nothing is running", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		await cleanStaleRestartFiles("/repo", { discover: () => [] });
		expect(mocks.unlinkSync.mock.calls.sort()).toEqual([["/tmp/harness.pid"], ["/tmp/harness.sock"]]);
	});

	// test-contract: invariant — a protocol-ready live harness must protect both
	// files from deletion; PID liveness alone is not socket readiness.
	it("deletes nothing while a protocol-ready harness is running", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.classifyDaemonSocket.mockResolvedValue("ready");
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 55 });
		await cleanStaleRestartFiles("/repo", { discover: () => [] });
		expect(mocks.unlinkSync).not.toHaveBeenCalled();
	});

	// test-contract: boundary — a non-existent file must never be unlinked, even if not running.
	it("deletes nothing when the files do not exist, even though nothing is running", async () => {
		mocks.existsSync.mockReturnValue(false);
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		await cleanStaleRestartFiles("/repo", { discover: () => [] });
		expect(mocks.unlinkSync).not.toHaveBeenCalled();
	});
});

describe("inlineJsonRestartStart — server resolution, argv, and poll convergence", () => {
	// test-contract: bug — a resolvable but missing-on-disk server path must
	// still error AND exit nonzero (review 2026-08-30: output() only prints,
	// so automation received exit 0 for a failed restart).
	it("treats a resolved server path that does not exist on disk as missing", async () => {
		mocks.getHarnessServerPath.mockReturnValue("/opt/server.mjs");
		mocks.existsSync.mockReturnValue(false);
		let jsonData: unknown;
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			jsonData = renderers.json();
		});
		process.exitCode = 0;
		await inlineJsonRestartStart("/repo", {}, "raw", "s", 1, "json");
		expect(jsonData).toEqual({ status: "error", message: "Harness server not found" });
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});

	// test-contract: bug — review 2026-08-30: a live pid with no sockets was
	// reported "restarted" with exit 0. It must report failed_not_listening
	// and exit nonzero; a dead daemon reports failed, also nonzero.
	it("reports failed_not_listening (exit 1) for a live pid with no sockets", async () => {
		vi.useFakeTimers();
		mocks.getHarnessServerPath.mockReturnValue("server.mjs");
		// Server artifact exists; the SOCKET never does.
		mocks.existsSync.mockImplementation((p: string) => !String(p).includes(".sock"));
		mocks.isDaemonSocketReady.mockResolvedValue(false);
		mocks.spawn.mockReturnValue(child(303));
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 303 });
		let jsonData: { status?: string | undefined } = {};
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			jsonData = parseWire(renderers.json(), wireObject({ "status": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value");
		});
		process.exitCode = 0;
		const run = inlineJsonRestartStart("/repo", {}, "raw", "s", 1, "json");
		await vi.advanceTimersByTimeAsync(31_000);
		await run;
		expect(jsonData.status).toBe("failed_not_listening");
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
		vi.useRealTimers();
	});

	// test-contract: public-api — exact spawn argv/options:
	// boolean(detached true->false) + conditional(opts.verbose->true) — exact spawn argv/options with verbose ON.
	it("spawns inline restart with exact verbose argv and stdio options", async () => {
		mocks.getHarnessServerPath.mockReturnValue("server.mjs");
		mocks.existsSync.mockReturnValue(true);
		mocks.spawn.mockReturnValue(child(202));
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 202 });
		let jsonData: unknown;
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			jsonData = renderers.json();
		});
		await inlineJsonRestartStart("/repo", { verbose: true }, "framed", "session-2", 17, "json");
		expect(mocks.spawn).toHaveBeenCalledWith(
			process.execPath,
			[
				"--max-old-space-size=1536",
				"--expose-gc",
				"server.mjs",
				"--cwd",
				"/repo",
				"--protocol",
				"framed",
				"--session-id",
				"session-2",
				"--verbose",
			],
			{ stdio: "ignore", detached: true, cwd: "/repo" },
		);
		expect(jsonData).toEqual({
			status: "restarted",
			old_pid: 17,
			new_pid: 202,
			protocol: "framed",
			sockets: ["/tmp/harness.sock"],
		});
	});

	// test-contract: boundary — verbose:false must omit the --verbose token.
	it("omits --verbose from inline restart argv when opts.verbose is false", async () => {
		mocks.getHarnessServerPath.mockReturnValue("server.mjs");
		mocks.existsSync.mockReturnValue(true);
		mocks.spawn.mockReturnValue(child(203));
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 203 });
		let jsonData: unknown;
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			jsonData = renderers.json();
		});
		await inlineJsonRestartStart("/repo", { verbose: false }, "raw", "s", 1, "json");
		expect(mocks.spawn).toHaveBeenCalledWith(
			process.execPath,
			["--max-old-space-size=1536", "--expose-gc", "server.mjs", "--cwd", "/repo", "--protocol", "raw"],
			{
				stdio: "ignore",
				detached: true,
				cwd: "/repo",
			},
		);
		expect(jsonData).toMatchObject({ status: "restarted", new_pid: 203 });
	});

	// test-contract: invariant — already-ready state must skip polling entirely (exactly one status read).
	it("skips polling entirely when already ready on the first check", async () => {
		mocks.getHarnessServerPath.mockReturnValue("server.mjs");
		mocks.existsSync.mockReturnValue(true);
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 55 });
		mocks.spawn.mockReturnValue(child(55));
		let jsonData: unknown;
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			jsonData = renderers.json();
		});
		await inlineJsonRestartStart("/repo", {}, "raw", "s", 1, "json");
		expect(jsonData).toEqual({
			status: "restarted",
			old_pid: 1,
			new_pid: 55,
			protocol: "raw",
			sockets: ["/tmp/harness.sock"],
		});
		expect(mocks.isHarnessRunning.mock.calls).toEqual([["/repo"]]);
	});

	// test-contract: invariant — partial socket presence must keep the reported status "failed" (still polling)
	// until every expected socket exists; a premature "restarted" verdict is the observable defect.
	it("keeps polling until every expected socket exists, not just one", async () => {
		vi.useFakeTimers();
		mocks.getHarnessServerPath.mockReturnValue("server.mjs");
		mocks.expectedSocketPaths.mockReturnValue(["/a.sock", "/b.sock"]);
		mocks.existsSync.mockImplementation((p: string) => p === "server.mjs" || p === "/a.sock");
		mocks.isDaemonSocketReady.mockImplementation(async (p: string) => p === "/a.sock");
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 9 });
		mocks.spawn.mockReturnValue(child(9));
		let jsonData: unknown;
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			jsonData = renderers.json();
		});
		const promise = inlineJsonRestartStart("/repo", {}, "raw", "s", 1, "json");
		await Promise.resolve();
		expect(jsonData).toBeUndefined();
		await vi.advanceTimersByTimeAsync(500);
		expect(jsonData).toBeUndefined();
		mocks.isDaemonSocketReady.mockResolvedValue(true);
		await vi.advanceTimersByTimeAsync(500);
		await promise;
		expect(jsonData).toMatchObject({ status: "restarted" });
	});

	// test-contract: public-api — error path normal renderer must be the empty string.
	it("emits an empty normal-mode string on the error path", async () => {
		mocks.getHarnessServerPath.mockReturnValue(undefined);
		let normalResult: string | undefined = "unset";
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			normalResult = renderers.normal();
		});
		await inlineJsonRestartStart("/repo", {}, "raw", "s", 1, "json");
		expect(normalResult).toBe("");
	});

	// test-contract: public-api — restart-result path normal renderer must be the empty string.
	it("emits an empty normal-mode string on the restart-result path", async () => {
		mocks.getHarnessServerPath.mockReturnValue("server.mjs");
		mocks.existsSync.mockReturnValue(true);
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 3 });
		mocks.spawn.mockReturnValue(child(3));
		let normalResult: string | undefined = "unset";
		mocks.output.mockImplementation((_mode, _data, renderers) => {
			normalResult = renderers.normal();
		});
		await inlineJsonRestartStart("/repo", {}, "raw", "s", 1, "json");
		expect(normalResult).toBe("");
	});
});

describe("protocolStatusLines — optional field gating", () => {
	// test-contract: invariant — a falsy field must be omitted, not always shown.
	it("omits the framed-event line when last_framed_event_at is falsy", () => {
		expect(
			protocolStatusLines({
				protocol: "raw",
				protocol_version: "1",
				started_at: "start",
				framed_session_id: null,
				raw_event_count: 1,
				framed_event_count: 0,
				raw_socket_path: null,
				framed_socket_path: null,
				last_raw_event_at: null,
				last_framed_event_at: null,
				framed_error_count: 0,
				framed_timeout_count: 0,
			}),
		).toEqual(["Protocol: raw", "Framed errors: 0 errors, 0 timeouts"]);
	});
});
