import { isJsonObject } from "../json-types.js";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- mocks -----------------------------------------------------------

class FakeStdin extends EventEmitter {
    writable = true;
    write = vi.fn();
    end = vi.fn();
}

class FakeChild extends EventEmitter {
    stdin = new FakeStdin();
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill = vi.fn();
    killed = false;
}

let currentChild: FakeChild;

const hoisted = vi.hoisted(() => ({
    spawnMock: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("node:child_process", () => ({
    spawn: (...args: unknown[]) => hoisted.spawnMock(...args),
}));

interface RecorderInstance {
    opts: unknown;
    recordJsonLine: ReturnType<typeof vi.fn>;
    recordStderrLine: ReturnType<typeof vi.fn>;
    recordTransportError: ReturnType<typeof vi.fn>;
    recordTransportClose: ReturnType<typeof vi.fn>;
}

let recorderInstance: RecorderInstance;

vi.mock("./recorder.js", () => ({
    McpProtocolRecorder: vi.fn().mockImplementation(function (opts: unknown) {
        recorderInstance = {
            opts,
            recordJsonLine: vi.fn(),
            recordStderrLine: vi.fn(),
            recordTransportError: vi.fn(),
            recordTransportClose: vi.fn(),
        };
        return recorderInstance;
    }),
}));

// import after mocks are declared
import { runMcpStdioProxy, type McpStdioProxyOptions } from "./stdio-proxy.js";

const spawnMock = hoisted.spawnMock;

const baseOpts: McpStdioProxyOptions = {
    serverName: "test-server",
    command: "node",
};

beforeEach(() => {
    currentChild = new FakeChild();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => currentChild);
});

afterEach(() => {
    vi.restoreAllMocks();
    // remove any leftover listeners this run may have added onto the real
    // process/stdin objects if a test forgot to settle the child.
    process.stdin.removeAllListeners("data");
    process.stdin.removeAllListeners("end");
    process.stdin.removeAllListeners("error");
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
});

function closeChild(code: number | null, signal: NodeJS.Signals | null = null): void {
    currentChild.emit("close", code, signal);
}

describe("runMcpStdioProxy spawn options — positive (must fire)", () => {
    it("uses serverCwd when provided, and falls back to cwd (?? not &&) when serverCwd is absent", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts, cwd: "/base/cwd" });
        const spawnOpts = spawnMock.mock.calls[0]?.[2];
        expect(spawnOpts).toHaveProperty("cwd", "/base/cwd");
        closeChild(0);
        await promise;
    });

    it("passes process.env by reference when opts.env is absent (?? not &&)", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        const spawnOpts = spawnMock.mock.calls[0]?.[2];
        if (!isJsonObject(spawnOpts)) throw new Error("Expected spawn options");
        expect(spawnOpts.env).toBe(process.env);
        closeChild(0);
        await promise;
    });

    it("passes an empty args array to spawn when opts.args is absent", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        const spawnArgs = spawnMock.mock.calls[0]?.[1];
        expect(spawnArgs).toEqual([]);
        closeChild(0);
        await promise;
    });

    it("constructs the recorder with transport 'stdio'", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        expect(recorderInstance.opts).toMatchObject({ transport: "stdio" });
        closeChild(0);
        await promise;
    });
});

describe("runMcpStdioProxy error listener wiring — positive (must fire)", () => {
    it("records a transport error when process.stdin emits an error", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        process.stdin.emit("error", new Error("boom-client"));
        expect(recorderInstance.recordTransportError).toHaveBeenCalledWith(
            expect.stringContaining("boom-client"),
        );
        closeChild(0);
        await promise;
    });

    it("records a transport error when child.stdin emits an error", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        currentChild.stdin.emit("error", new Error("boom-server"));
        expect(recorderInstance.recordTransportError).toHaveBeenCalledWith(
            expect.stringContaining("boom-server"),
        );
        closeChild(0);
        await promise;
    });
});

describe("signal forwarding — positive (must fire)", () => {
    it("kills the child with SIGINT when the process receives SIGINT", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        process.emit("SIGINT");
        expect(currentChild.kill).toHaveBeenCalledWith("SIGINT");
        closeChild(0);
        await promise;
    });

    it("kills the child with SIGTERM when the process receives SIGTERM", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        process.emit("SIGTERM");
        expect(currentChild.kill).toHaveBeenCalledWith("SIGTERM");
        closeChild(0);
        await promise;
    });

    it("does not forward the signal when the child is already killed", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        currentChild.killed = true;
        process.emit("SIGINT");
        expect(currentChild.kill).not.toHaveBeenCalled();
        closeChild(0);
        await promise;
    });

    it("stops forwarding signals after the child has closed (cleanup ran)", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        closeChild(0);
        await promise;
        process.emit("SIGINT");
        expect(currentChild.kill).not.toHaveBeenCalled();
    });
});

describe("settle / cleanup idempotency — positive (must fire)", () => {
    it("only tears down stdin listeners once even if close+error both fire", async () => {
        const onSpy = vi.spyOn(process.stdin, "on");
        const offSpy = vi.spyOn(process.stdin, "off");
        const promise = runMcpStdioProxy({ ...baseOpts });
        const registeredListeners = onSpy.mock.calls.slice(-3);
        expect(registeredListeners.map(([event]) => event)).toEqual(["data", "end", "error"]);
        closeChild(0);
        currentChild.emit("error", new Error("late-error"));
        await promise;
        // exactly one teardown pass: data, end, error => 3 off calls
        expect(offSpy).toHaveBeenCalledTimes(3);
        expect(offSpy.mock.calls).toEqual(registeredListeners);
    });
});

describe("cleanupStdinListeners — positive (must fire)", () => {
    it("removes the data/end/error stdin listeners and pauses stdin on settle", async () => {
        const offSpy = vi.spyOn(process.stdin, "off");
        const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
        const promise = runMcpStdioProxy({ ...baseOpts });
        closeChild(0);
        await promise;
        expect(offSpy).toHaveBeenCalledWith("data", expect.any(Function));
        expect(offSpy).toHaveBeenCalledWith("end", expect.any(Function));
        expect(offSpy).toHaveBeenCalledWith("error", expect.any(Function));
        expect(pauseSpy).toHaveBeenCalled();
    });
});

describe("JsonLineBuffer via stdin forwarding — positive (must fire)", () => {
    it("parses a complete newline-terminated line out of the buffer", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        process.stdin.emit("data", Buffer.from("hello-line\n"));
        expect(recorderInstance.recordJsonLine).toHaveBeenCalledWith("client_to_server", "hello-line");
        closeChild(0);
        await promise;
    });

    it("slices only up to the newline, not the whole remaining buffer", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        process.stdin.emit("data", Buffer.from("first\nsecond"));
        expect(recorderInstance.recordJsonLine).toHaveBeenCalledWith("client_to_server", "first");
        expect(recorderInstance.recordJsonLine).not.toHaveBeenCalledWith(
            "client_to_server",
            "first\nsecond",
        );
        closeChild(0);
        await promise;
    });

    it("does not flush anything when the buffer is empty at stdin end", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        process.stdin.emit("end");
        expect(recorderInstance.recordJsonLine).not.toHaveBeenCalled();
        closeChild(0);
        await promise;
    });

    it("flushes a trailing partial line without a newline on stdin end", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        process.stdin.emit("data", Buffer.from("partial-no-newline"));
        process.stdin.emit("end");
        expect(recorderInstance.recordJsonLine).toHaveBeenCalledWith(
            "client_to_server",
            "partial-no-newline",
        );
        closeChild(0);
        await promise;
    });
});

describe("resolveExitCode — positive (must fire)", () => {
    it("resolves with the numeric exit code when the child closes with a code", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        closeChild(5, null);
        await expect(promise).resolves.toBe(5);
    });

    it("resolves with 0 when the child closes with no code and no signal", async () => {
        const promise = runMcpStdioProxy({ ...baseOpts });
        closeChild(null, null);
        await expect(promise).resolves.toBe(0);
    });
});
