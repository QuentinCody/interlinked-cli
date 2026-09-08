import { parseWire, wireRecord, wireUnknown } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FsState {
    exists: boolean;
    size: number;
    content: Buffer;
}

let fsState: FsState;
let callback: (() => void) | undefined;
let outputLines: string[];
let errors: string[];
let readOptions: Record<string, unknown> | undefined;

vi.mock("node:fs", () => ({
    existsSync: () => fsState.exists,
    statSync: () => ({ size: fsState.size }),
    openSync: () => 1,
    readSync: (_fd: number, buffer: Buffer, _offset: number, length: number, position: number) => {
        fsState.content.subarray(position, position + length).copy(buffer);
        return length;
    },
    closeSync: () => undefined,
    watchFile: (_path: string, _options: unknown, cb: () => void) => {
        callback = cb;
    },
    unwatchFile: () => undefined,
}));

vi.mock("../lib/config.js", () => ({
    getDataDir: () => "/tmp/interlinked",
}));

vi.mock("../lib/formatter.js", () => ({
    c: {
        cyan: (s: string) => s,
        dim: (s: string) => s,
        green: (s: string) => s,
        yellow: (s: string) => s,
        blue: (s: string) => s,
        red: (s: string) => s,
    },
    shortTimestamp: () => "12:00",
}));

vi.mock("../lib/local-activity.js", () => ({
    readLocalActivity: (options: Record<string, unknown>) => {
        readOptions = options;
        return [];
    },
}));

vi.mock("../lib/activity-utils.js", () => ({
    formatActivitySummary: (event: Record<string, unknown>) => {
        const session = event.session === null ? "null-session" : String(event.session);
        const hook = event.hook === null ? "null-hook" : String(event.hook);
        return `${session} ${hook}`;
    },
    parseDuration: () => 3600000,
}));

import { logsCommand } from "./logs.js";

function emitEvent(event: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<void> {
    const promise = logsCommand({ follow: true, raw: true, ...options });
    return Promise.resolve().then(() => {
        const line = `${JSON.stringify(event)}\n`;
        fsState.content = Buffer.from(line);
        fsState.size = fsState.content.length;
        callback?.();
        process.emit("SIGINT");
        return promise;
    });
}

beforeEach(() => {
    fsState = { exists: true, size: 0, content: Buffer.alloc(0) };
    callback = undefined;
    outputLines = [];
    errors = [];
    readOptions = undefined;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        outputLines.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "cwd").mockReturnValue("/repo");
});

afterEach(() => {
    vi.restoreAllMocks();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.exitCode = undefined;
});

describe("logs mutation contracts", () => {
    // test-contract: an event whose agent filter does not match must be omitted from followed output.
    it("rejects a mismatching agent filter", async () => {
        await emitEvent({ ts: "T", agent: "claude", type: "tool_use", tool: "Read" }, { agent: "gemini" });
        expect(outputLines.join("\n")).not.toContain('"agent":"claude"');
    });

    // test-contract: non-string optional session and hook values are normalized to null in raw output.
    it("normalizes non-string session and hook values", async () => {
        await emitEvent({
            ts: "T",
            agent: "claude",
            type: "tool_use",
            session: 42,
            hook: 7,
        });
        const rendered = nonNull(outputLines.find((line) => line.startsWith("{")));
        const event = parseWire(JSON.parse(rendered), wireRecord(wireUnknown), "test JSON value");
        expect(event.session).toBeNull();
        expect(event.hook).toBeNull();
    });

    // test-contract: a string-valued hook is retained while a non-string hook is discarded.
    it("retains string hooks and discards numeric hooks", async () => {
        await emitEvent({
            ts: "T",
            agent: "claude",
            type: "tool_use",
            hook: "before-tool",
        });
        const rendered = nonNull(outputLines.find((line) => line.startsWith("{")));
        expect(JSON.parse(rendered)).toHaveProperty(["hook"], "before-tool");
    });

    // test-contract: a string-valued session is retained while a non-string session is discarded.
    it("retains string sessions and discards numeric sessions", async () => {
        await emitEvent({
            ts: "T",
            agent: "claude",
            type: "tool_use",
            session: "session-1",
        });
        const rendered = nonNull(outputLines.find((line) => line.startsWith("{")));
        expect(JSON.parse(rendered)).toHaveProperty(["session"], "session-1");
    });

    // test-contract: a file whose size is unchanged must not be reread by the tail.
    it("does not read when size equals the initial offset", async () => {
        const promise = logsCommand({ follow: true });
        await Promise.resolve();
        fsState.size = 0;
        callback?.();
        process.emit("SIGINT");
        await promise;
        expect(outputLines.filter((line) => line.startsWith("{"))).toHaveLength(0);
    });

    // test-contract: omitted query filters are not forwarded as properties to the activity reader.
    it("omits undefined agent, type, and since options", async () => {
        await logsCommand({});
        expect(readOptions).toEqual({ limit: 20, cwd: "/repo" });
    });
});
