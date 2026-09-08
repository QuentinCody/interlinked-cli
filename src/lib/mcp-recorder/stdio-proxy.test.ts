// Tests for the stdio MCP proxy (`runMcpStdioProxy`): spawns a child MCP
// server, forwards stdin/stdout/stderr, and records JSON-RPC traffic. No
// injectable spawn seam exists, so we mock node:child_process's `spawn` to
// return a fake EventEmitter-based child process and drive the module's real
// event wiring end to end — including the real McpProtocolRecorder, which
// writes real JSONL into a tmp cwd we assert against afterwards.

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
    spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { runMcpStdioProxy } from "./stdio-proxy.js";
import { getMcpEventsPath } from "./writer.js";

interface FakeChild extends EventEmitter {
    stdin: EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
    const child: FakeChild = Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), { writable: true, write: vi.fn(), end: vi.fn() }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn((_signal?: string) => {
            child.killed = true;
            return true;
        }),
    });
    return child;
}

let tmp: string;
let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "interlinked-stdio-proxy-"));
    spawnMock.mockReset();
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
});

describe("runMcpStdioProxy — happy path", () => {
    it("forwards stdin/stdout/stderr, records JSON-RPC traffic, forwards SIGINT, and resolves the exit code", async () => {
        const child = makeFakeChild();
        spawnMock.mockReturnValue(child);

        const proxyPromise = runMcpStdioProxy({
            serverName: "fixture-server",
            command: "node",
            args: ["server.js"],
            cwd: tmp,
            sessionId: "sess-1",
        });

        expect(spawnMock).toHaveBeenCalledWith(
            "node",
            ["server.js"],
            expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
        );

        // Complete line on stdin: buffer empties, so the later stdin 'end'
        // flush hits the "buffer already empty" early-return branch.
        process.stdin.emit(
            "data",
            Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`),
        );
        expect(child.stdin.write).toHaveBeenCalledTimes(1);

        // Partial line on stdout (no trailing newline): leftover buffer gets
        // flushed later when the child closes.
        child.stdout.emit(
            "data",
            Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
        );
        expect(stdoutWriteSpy).toHaveBeenCalled();

        // Partial line on stderr.
        child.stderr.emit("data", Buffer.from("server warming up"));
        expect(stderrWriteSpy).toHaveBeenCalled();

        // Server-side stdin transport error is recorded, not thrown.
        child.stdin.emit("error", new Error("EPIPE"));

        // stdin end: flushes clientLines (empty buffer -> early return) and
        // ends the child's stdin.
        process.stdin.emit("end");
        expect(child.stdin.end).toHaveBeenCalledTimes(1);

        // Forwarded SIGINT: the module's process.once("SIGINT", ...) handler
        // should kill the still-alive child.
        process.emit("SIGINT");
        expect(child.kill).toHaveBeenCalledWith("SIGINT");
        expect(child.killed).toBe(true);

        // Close with a real numeric exit code -> resolveExitCode's
        // `code !== null` branch. Also flushes the leftover stdout/stderr
        // buffers (non-empty -> the flush-and-emit branch).
        child.emit("close", 0, null);

        const exitCode = await proxyPromise;
        expect(exitCode).toBe(0);

        // Real assertions against what the recorder actually wrote.
        const eventsPath = getMcpEventsPath(tmp);
        const lines = readFileSync(eventsPath, "utf-8").trim().split("\n");
        const records = lines.map((l) => JSON.parse(l));

        const requestRecord = records.find((r) => r.method === "tools/list");
        expect(requestRecord).toBeDefined();
        expect(requestRecord.direction).toBe("client_to_server");

        const responseRecord = records.find(
            (r) => r.kind === "mcp_message" && r.direction === "server_to_client",
        );
        expect(responseRecord).toBeDefined();

        const stderrRecord = records.find((r) => r.message_type === "transport_stderr");
        expect(stderrRecord).toBeDefined();
        expect(stderrRecord.payload).toBe("server warming up");

        const transportErrorRecord = records.find((r) => r.message_type === "transport_error");
        expect(transportErrorRecord).toBeDefined();
        expect(transportErrorRecord.payload.message).toContain("EPIPE");

        const closeRecord = records.find((r) => r.message_type === "transport_close");
        expect(closeRecord).toBeDefined();
        expect(closeRecord.payload.exit_code).toBe(0);
        expect(closeRecord.payload.signal).toBeNull();
    });
});

describe("runMcpStdioProxy — spawn failure", () => {
    it("records a transport error and resolves exit code 1 when the child fails to start", async () => {
        const child = makeFakeChild();
        spawnMock.mockReturnValue(child);

        const proxyPromise = runMcpStdioProxy({
            serverName: "broken-server",
            command: "does-not-exist",
            cwd: tmp,
        });

        child.emit("error", new Error("ENOENT: command not found"));
        // A subsequent close event still records the close (recording happens
        // before the settle() guard), but the settle() guard means the
        // promise resolves to the 'error' path's exit code (1), not the
        // close event's code (7).
        child.emit("close", 7, null);

        const exitCode = await proxyPromise;
        expect(exitCode).toBe(1);

        const eventsPath = getMcpEventsPath(tmp);
        const lines = readFileSync(eventsPath, "utf-8").trim().split("\n");
        const records = lines.map((l) => JSON.parse(l));
        const errorRecord = records.find((r) => r.message_type === "transport_error");
        expect(errorRecord).toBeDefined();
        expect(errorRecord.payload.message).toContain("failed to start MCP server");
        expect(errorRecord.payload.message).toContain("ENOENT");

        const closeRecord = records.find((r) => r.message_type === "transport_close");
        expect(closeRecord).toBeDefined();
        expect(closeRecord.payload.exit_code).toBe(7);
    });
});

describe("runMcpStdioProxy — resolveExitCode branches", () => {
    it("returns 1 when the process is killed by a signal (code null, signal set)", async () => {
        const child = makeFakeChild();
        spawnMock.mockReturnValue(child);

        const proxyPromise = runMcpStdioProxy({
            serverName: "signal-server",
            command: "node",
            cwd: tmp,
        });

        child.emit("close", null, "SIGTERM");
        expect(await proxyPromise).toBe(1);
    });

    it("returns 0 when both code and signal are null", async () => {
        const child = makeFakeChild();
        spawnMock.mockReturnValue(child);

        const proxyPromise = runMcpStdioProxy({
            serverName: "no-signal-server",
            command: "node",
            cwd: tmp,
        });

        child.emit("close", null, null);
        expect(await proxyPromise).toBe(0);
    });
});

describe("runMcpStdioProxy — stdin write guard", () => {
    it("does not write to a non-writable child stdin, but still records the client line", async () => {
        const child = makeFakeChild();
        child.stdin.writable = false;
        spawnMock.mockReturnValue(child);

        const proxyPromise = runMcpStdioProxy({
            serverName: "unwritable-stdin-server",
            command: "node",
            cwd: tmp,
        });

        process.stdin.emit(
            "data",
            Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "notify/ping" })}\n`),
        );
        expect(child.stdin.write).not.toHaveBeenCalled();

        child.emit("close", 0, null);
        await proxyPromise;

        const eventsPath = getMcpEventsPath(tmp);
        const lines = readFileSync(eventsPath, "utf-8").trim().split("\n");
        const records = lines.map((l) => JSON.parse(l));
        const notifyRecord = records.find((r) => r.method === "notify/ping");
        expect(notifyRecord).toBeDefined();
    });
});
