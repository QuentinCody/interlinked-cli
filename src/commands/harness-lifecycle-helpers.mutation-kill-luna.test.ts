import { EventEmitter } from "node:events";
import { describe, expect, it, beforeEach, vi } from "vitest";

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
    kvLine: (key: string, value: string) => `${key}: ${value}`,
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
    lockedJsonRestartStart,
    protocolStatusLines,
    reportPendingStart,
    stopRunningHarnessForRestart,
} from "./harness-lifecycle-helpers.js";

function child(pid = 4321): EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> } {
    const value = Object.assign(new EventEmitter(), { pid, unref: vi.fn() });
    return value;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOutputMode.mockImplementation((opts: { json?: boolean }) => opts.json ? "json" : "normal");
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

describe("harness lifecycle public contracts", () => {
    // test-contract: public-api — spawn arguments preserve the heap cap, GC switch, cwd, protocol, session, and verbose flag.
    it("builds the exact framed verbose argv", () => {
        expect(buildHarnessSpawnArgs("server.mjs", "/repo", "framed", "session-1", { verbose: true })).toEqual([
            "--max-old-space-size=1536", "--expose-gc", "server.mjs", "--cwd", "/repo",
            "--protocol", "framed", "--session-id", "session-1", "--verbose",
        ]);
    });

    // test-contract: boundary — raw protocol intentionally omits a session selector while retaining the protocol selector.
    it("omits session-id for raw protocol", () => {
        expect(buildHarnessSpawnArgs("server.mjs", "/repo", "raw", "ignored", {})).toEqual([
            "--max-old-space-size=1536", "--expose-gc", "server.mjs", "--cwd", "/repo", "--protocol", "raw",
        ]);
    });

	// test-contract: invariant — only stale socket and pid artifacts are removed;
	// a protocol-ready live harness protects both files.
    it("cleans stale artifacts only when no harness is running", async () => {
        mocks.existsSync.mockReturnValue(true);
        mocks.isHarnessRunning.mockReturnValue({ running: false });
        await cleanStaleRestartFiles("/repo", { discover: () => [], reap: () => ({ candidates: [], killed: [], dryRun: false }) });
        expect(mocks.unlinkSync).toHaveBeenCalledWith("/tmp/harness.sock");
        expect(mocks.unlinkSync).toHaveBeenCalledWith("/tmp/harness.pid");

        mocks.unlinkSync.mockClear();
		mocks.classifyDaemonSocket.mockResolvedValue("ready");
        mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 55 });
        await cleanStaleRestartFiles("/repo", { discover: () => [], reap: () => ({ candidates: [], killed: [], dryRun: false }) });
        expect(mocks.unlinkSync).not.toHaveBeenCalled();
    });

    // test-contract: failure — artifact unlink failures are best-effort and must not reject restart pre-flight.
    it("ignores stale artifact unlink errors", async () => {
        mocks.existsSync.mockReturnValue(true);
        mocks.isHarnessRunning.mockReturnValue({ running: false });
        mocks.unlinkSync.mockImplementation(() => { throw new Error("read-only"); });
        await expect(cleanStaleRestartFiles("/repo", { discover: () => [] })).resolves.toBeUndefined();
    });

    // test-contract: public-api — daemonization passes detached cwd and stderr stdio, closes the log, and unrefs the child.
    it("spawns a detached daemon with exact options and reports started human output", async () => {
        const spawned = child(101);
        mocks.spawn.mockReturnValue(spawned);
        mocks.existsSync.mockReturnValue(true);
        mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 101 });
        mocks.output.mockImplementationOnce((_mode, _data, renderers) => expect(renderers.normal?.()).toBe("Harness started (PID 101)"));
        await daemonizeHarness({ mode: "normal", cwd: "/repo", nodePath: "/node", spawnArgs: ["server"], protocol: "raw", sessionId: "s", serverPath: "server" });
        expect(mocks.spawn).toHaveBeenCalledWith("/node", ["server"], { stdio: ["ignore", "ignore", "ignore"], detached: true, cwd: "/repo", env: expect.any(Object) });
        expect(spawned.unref).toHaveBeenCalledOnce();
        expect(mocks.closeDaemonStderrLog).toHaveBeenCalledWith(undefined);
        expect(mocks.output).toHaveBeenCalledOnce();
    });

    // test-contract: boundary — parent daemonization never unlinks a socket; child-side anti-stomp owns stale cleanup for every protocol.
    it("does not unlink a socket before framed child startup", async () => {
        const spawned = child();
        mocks.spawn.mockReturnValue(spawned);
        mocks.existsSync.mockReturnValue(true);
        await daemonizeHarness({ mode: "normal", cwd: "/repo", nodePath: "/node", spawnArgs: [], protocol: "framed", sessionId: "s", serverPath: "server" });
        expect(mocks.unlinkSync).not.toHaveBeenCalled();
    });

    // test-contract: failure — an unavailable server emits one structured error and never attempts a process spawn.
    it("reports missing server in inline JSON restart", async () => {
        mocks.getHarnessServerPath.mockReturnValue(undefined);
        mocks.output.mockImplementation((_mode, _data, renderers) => renderers.json());
        await inlineJsonRestartStart("/repo", {}, "raw", "s", 9, "json");
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.output.mock.calls.at(-1)?.[1]).toEqual({});
    });

    // test-contract: public-api — inline restart supplies protocol/session/verbose argv and detached stdio, then emits the new pid.
    it("spawns inline restart with exact argv and JSON payload", async () => {
        mocks.getHarnessServerPath.mockReturnValue("server.mjs");
        mocks.existsSync.mockReturnValue(true);
        mocks.spawn.mockReturnValue(child(202));
        mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 202 });
        mocks.output.mockImplementation((_mode, _data, renderers) => renderers.json());
        await inlineJsonRestartStart("/repo", { verbose: true }, "framed", "session-2", 17, "json");
        expect(mocks.spawn).toHaveBeenCalledWith(process.execPath, ["--max-old-space-size=1536", "--expose-gc", "server.mjs", "--cwd", "/repo", "--protocol", "framed", "--session-id", "session-2", "--verbose"], { stdio: "ignore", detached: true, cwd: "/repo", env: expect.any(Object) });
        expect(mocks.spawn.mock.results[0]?.value.unref).toHaveBeenCalledOnce();
        expect(mocks.output.mock.calls.at(-1)?.[1]).toEqual({});
    });

    // test-contract: invariant — a pending start distinguishes a live socket from an unanswered holder in both JSON status fields and human wording.
    it("reports already-running and start-pending outcomes", async () => {
        mocks.waitForDaemonSocket.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        mocks.output.mockImplementation((_mode, _data, renderers) => renderers.json());
        await reportPendingStart("/repo", 88, { json: true });
        expect(mocks.output.mock.calls.at(-1)?.[1]).toEqual({ already_running: true, start_pending: false, starter_pid: 88 });
        await reportPendingStart("/repo", null, { json: true });
        expect(mocks.output.mock.calls.at(-1)?.[1]).toEqual({ already_running: false, start_pending: true, starter_pid: null });
    });

    // test-contract: public-api — human pending-start output names a known starter and gives a distinct retry instruction.
    it("renders human pending-start guidance", async () => {
        mocks.waitForDaemonSocket.mockResolvedValue(false);
        mocks.output.mockImplementation((_mode, _data, renderers) => expect(renderers.normal?.()).toContain("PID 88"));
        await reportPendingStart("/repo", 88, {});
        expect(mocks.output).toHaveBeenCalledOnce();
    });

    // test-contract: public-api — stop returns no prior pid for an empty stop result and preserves the non-survived outcome.
    it("returns an empty stop result when no daemon was stopped", async () => {
        mocks.isHarnessRunning.mockReturnValue({ running: false });
        expect(await stopRunningHarnessForRestart("/repo", "json")).toEqual({ oldPid: undefined, survived: false });
    });

    // test-contract: boundary — a stopped daemon uses the observed running pid, while multiple stopped pids are rendered comma-separated on stderr.
    it("returns the prior pid and reports a clean stop", async () => {
        mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 321 });
        mocks.stopAllDaemons.mockResolvedValue({ stopped: [321, 322], survived: [] });
        expect(await stopRunningHarnessForRestart("/repo", "normal")).toEqual({ oldPid: 321, survived: false });
        expect(mocks.outputError).not.toHaveBeenCalled();
    });

    // test-contract: failure — SIGKILL survivors are surfaced as fatal output and force the caller to abort restart.
    it("returns survived true and reports SIGKILL survivors", async () => {
        mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 321 });
        mocks.stopAllDaemons.mockResolvedValue({ stopped: [321], survived: [321, 322] });
        expect(await stopRunningHarnessForRestart("/repo", "json")).toEqual({ oldPid: 321, survived: true });
        expect(mocks.outputError).toHaveBeenCalledWith("json", "PID(s) 321, 322 survived SIGKILL — possibly kernel-protected. Investigate manually.");
    });

    // test-contract: public-api — protocol status lines include required protocol/error counts and only present optional timestamps/paths.
    it("renders protocol status lines with optional fields", () => {
        expect(protocolStatusLines({ protocol: "framed", protocol_version: "1", started_at: "start", framed_session_id: null, raw_event_count: 1, framed_event_count: 0, raw_socket_path: "/raw", framed_socket_path: null, last_raw_event_at: "now", last_framed_event_at: null, framed_error_count: 2, framed_timeout_count: 3 })).toEqual([
            "Protocol: framed", "Raw socket: /raw", "Last raw event: now", "Framed errors: 2 errors, 3 timeouts",
        ]);
    });

    // test-contract: public-api — the startup lock winner starts and always releases, while a loser reports pending without spawning.
    it("honors locked restart winner and loser branches", async () => {
        const release = vi.fn();
        mocks.acquireStartupLock.mockReturnValue({ acquired: true, path: "/lock", release });
        const start = vi.fn().mockResolvedValue(undefined);
        await lockedJsonRestartStart("/repo", {}, "raw", "s", 1, "json", { start });
        expect(start).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();

        mocks.acquireStartupLock.mockReturnValue({ acquired: false, holder: { pid: 7, at: 0 } });
        const pending = vi.fn().mockResolvedValue(undefined);
        await lockedJsonRestartStart("/repo", {}, "raw", "s", 1, "json", { start, reportPending: pending });
        expect(pending).toHaveBeenCalledWith("/repo", 7, {});
        expect(start).toHaveBeenCalledOnce();
    });
});
