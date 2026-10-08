import * as fs from "node:fs";
import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "./types.js";
import {
    enrichCodexSubagentAttribution,
    parseCodexAttributionRollout,
    resolveCodexSubagentAttribution,
} from "./codex-subagent-attribution.js";
import { eventAttributionFields } from "./event-attribution-fields.js";

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return { ...actual, readFileSync: vi.fn(actual.readFileSync), readSync: vi.fn(actual.readSync) };
});
beforeEach(() => { vi.clearAllMocks(); });

const TS = "2026-08-20T15:48:53.313Z";

function event(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
    return {
        hook_event: "PreToolUse",
        session_id: "parent-thread",
        agent_source: "codex",
        timestamp: TS,
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "sed -n '1,40p' src/a.ts" },
        tool_use_id: "exec-123",
        ...overrides,
    };
}

function rollout(
    options: { completed?: boolean; subagent?: boolean; duplicateRootMeta?: boolean } = {},
): string {
    const source = options.subagent === false
        ? { cli: true }
        : {
                subagent: {
                    thread_spawn: {
                        parent_thread_id: "parent-thread",
                        agent_path: "/root/kill_a_survivors",
                        agent_nickname: "Curie",
                    },
                },
            };
    const rows: unknown[] = [
        {
            timestamp: "2026-08-20T15:48:40.000Z",
            type: "session_meta",
            payload: {
                id: "sub-thread",
                ...(options.duplicateRootMeta ? { session_id: "parent-thread" } : {}),
                source,
                cwd: "/repo",
            },
        },
        {
            timestamp: "2026-08-20T15:48:41.000Z",
            type: "turn_context",
            payload: { model: "vendor-model-luna", effort: "medium" },
        },
        {
            timestamp: "2026-08-20T15:48:53.263Z",
            type: "response_item",
            payload: {
                type: "custom_tool_call",
                name: "exec",
                call_id: "call-1",
                input: "const r = await tools.exec_command({cmd:\"sed -n '1,40p' src/a.ts\"});",
            },
        },
    ];
    if (options.duplicateRootMeta) {
        rows.splice(1, 0, {
            timestamp: "2026-08-20T15:48:40.500Z",
            type: "session_meta",
            payload: {
                id: "parent-thread",
                session_id: "parent-thread",
                source: { cli: true },
                cwd: "/repo",
            },
        });
    }
    if (options.completed) {
        rows.push({
            timestamp: "2026-08-20T15:48:54.742Z",
            type: "event_msg",
            payload: { type: "item_completed", item: { type: "CommandExecution", id: "exec-123" } },
        });
    }
    return rows.map((row) => JSON.stringify(row)).join("\n");
}

function tempRollout(text: string): string {
    const dir = mkdtempSync(join(tmpdir(), "codex-attribution-"));
    const path = join(dir, "rollout-test.jsonl");
    writeFileSync(path, text);
    return path;
}

describe("parseCodexAttributionRollout", () => {
    it("reads current Codex thread_spawn identity, model, cwd, and execution ids", () => {
        const parsed = parseCodexAttributionRollout(rollout({ completed: true }));
        expect(parsed.attribution).toEqual({
            subagent_id: "sub-thread",
            agent_name: "/root/kill_a_survivors",
            parent_agent: "parent-thread",
            model: "vendor-model-luna",
        });
        expect(parsed.cwd).toBe("/repo");
        expect(parsed.executionIds.has("exec-123")).toBe(true);
    });

    it("does not invent attribution for a root Codex rollout", () => {
        expect(parseCodexAttributionRollout(rollout({ subagent: false })).attribution).toBeNull();
    });

    it("keeps the first child owner when a later root session_meta is duplicated", () => {
        const parsed = parseCodexAttributionRollout(rollout({ duplicateRootMeta: true }));
        expect(parsed.attribution).toMatchObject({
            subagent_id: "sub-thread",
            agent_name: "/root/kill_a_survivors",
            parent_agent: "parent-thread",
        });
        expect(parsed.cwd).toBe("/repo");
    });

    it("drops a pending call once its tool-output response item arrives", () => {
        const rows = [
            {
                timestamp: "2026-08-20T15:48:50.000Z",
                type: "response_item",
                payload: { type: "custom_tool_call", name: "exec", call_id: "call-1", input: "cmd-1" },
            },
            {
                timestamp: "2026-08-20T15:48:51.000Z",
                type: "response_item",
                payload: { type: "custom_tool_call", name: "exec", call_id: "call-2", input: "cmd-2" },
            },
            {
                timestamp: "2026-08-20T15:48:52.000Z",
                type: "response_item",
                payload: { type: "custom_tool_call_output", call_id: "call-1" },
            },
        ];
        const text = rows.map((row) => JSON.stringify(row)).join("\n");
        const parsed = parseCodexAttributionRollout(text);
        expect(parsed.pendingCalls).toHaveLength(1);
        expect(parsed.pendingCalls[0]?.input).toBe("cmd-2");
    });

    it("skips a malformed rollout line and still resolves the valid attribution around it", () => {
        const lines = rollout({ completed: true }).split("\n");
        lines.splice(1, 0, "{not valid json");
        const parsed = parseCodexAttributionRollout(lines.join("\n"));
        expect(parsed.attribution).toEqual({
            subagent_id: "sub-thread",
            agent_name: "/root/kill_a_survivors",
            parent_agent: "parent-thread",
            model: "vendor-model-luna",
        });
    });
});

describe("resolveCodexSubagentAttribution", () => {
    it("reads a bounded header and tail of a large active rollout, including its latest execution", () => {
        const path = tempRollout(rollout() + "\n" + "{\"ignored\":true}\n".repeat(400_000));
        appendFileSync(path, JSON.stringify({ type: "event_msg", payload: { item: { id: "exec-123" } } }) + "\n");
        const wholeRead = vi.spyOn(fs, "readFileSync");
        const rangeRead = vi.spyOn(fs, "readSync");
        try {
            expect(resolveCodexSubagentAttribution(event(), { rolloutPaths: [path] })).toMatchObject({ subagent_id: "sub-thread", model: null });
            expect(wholeRead.mock.calls.filter(([file]) => file === path)).toHaveLength(0);
            const bytes = rangeRead.mock.results.reduce((sum, result) => sum + (result.type === "return" ? Number(result.value) : 0), 0);
            expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
        } finally { wholeRead.mockRestore(); rangeRead.mockRestore(); }
    });

    it("does not resurrect a pending call whose completion is outside the retained tail", () => {
        const output = JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-1" } });
        const path = tempRollout(rollout() + "\n" + output + "\n" + "{\"ignored\":true}\n".repeat(100_000));
        expect(resolveCodexSubagentAttribution(event(), { rolloutPaths: [path] })).toBeNull();
    });

    it("stops reading a large root rollout as soon as its native owner is known", () => {
        const path = tempRollout(rollout({ subagent: false }) + "\n" + "{\"ignored\":true}\n".repeat(100_000));
        const wholeRead = vi.spyOn(fs, "readFileSync");
        const rangeRead = vi.spyOn(fs, "readSync");
        try {
            expect(resolveCodexSubagentAttribution(event(), { rolloutPaths: [path] })).toBeNull();
            expect(wholeRead.mock.calls.filter(([file]) => file === path)).toHaveLength(0);
            const bytes = rangeRead.mock.results.reduce((sum, result) => sum + (result.type === "return" ? Number(result.value) : 0), 0);
            expect(bytes).toBeLessThanOrEqual(64 * 1024);
        } finally { wholeRead.mockRestore(); rangeRead.mockRestore(); }
    });

    it("refreshes attribution after append and replacement instead of reusing stale execution ids", () => {
        const path = tempRollout(rollout());
        expect(resolveCodexSubagentAttribution(event({ tool_use_id: "new-id", tool_input: { command: "other command" } }), { rolloutPaths: [path] })).toBeNull();
        appendFileSync(path, "\n" + JSON.stringify({ type: "event_msg", payload: { item: { id: "new-id" } } }));
        expect(resolveCodexSubagentAttribution(event({ tool_use_id: "new-id" }), { rolloutPaths: [path] })?.subagent_id).toBe("sub-thread");
        writeFileSync(path, rollout({ subagent: false }));
        expect(resolveCodexSubagentAttribution(event({ tool_use_id: "new-id" }), { rolloutPaths: [path] })).toBeNull();
    });

    it("uses the exact completed execution id for PostToolUse", () => {
        const path = tempRollout(rollout({ completed: true }));
        const resolved = resolveCodexSubagentAttribution(
            event({ hook_event: "PostToolUse" }),
            { rolloutPaths: [path], nowMs: Date.parse(TS) },
        );
        expect(resolved?.subagent_id).toBe("sub-thread");
        expect(resolved?.model).toBe("vendor-model-luna");
    });

    it("matches the pending rollout call for PreToolUse before completion", () => {
        const path = tempRollout(rollout());
        expect(
            resolveCodexSubagentAttribution(event(), {
                rolloutPaths: [path],
                nowMs: Date.parse(TS),
            })?.agent_name,
        ).toBe("/root/kill_a_survivors");
    });

    it("rejects a pending call from another cwd or with another command", () => {
        const path = tempRollout(rollout());
        expect(resolveCodexSubagentAttribution(event({ cwd: "/other" }), { rolloutPaths: [path] })).toBeNull();
        expect(
            resolveCodexSubagentAttribution(
                event({ tool_input: { command: "npm test" } }),
                { rolloutPaths: [path] },
            ),
        ).toBeNull();
    });

    it("preserves native fields and fills only missing identity", () => {
        const path = tempRollout(rollout({ completed: true }));
        const target = event({ agent_name: "native-name" });
        enrichCodexSubagentAttribution(target, { rolloutPaths: [path] });
        expect(target.agent_name).toBe("native-name");
        expect(eventAttributionFields(target)).toEqual({
            subagent_id: "sub-thread",
            model: "vendor-model-luna",
            parent_agent: "parent-thread",
        });
    });

    it("returns null instead of throwing when a rollout path cannot be read", () => {
        const dirPath = mkdtempSync(join(tmpdir(), "codex-attribution-dir-"));
        expect(
            resolveCodexSubagentAttribution(event(), { rolloutPaths: [dirPath], nowMs: Date.parse(TS) }),
        ).toBeNull();
    });

    it("discovers today's rollout files under sessionsDir and skips one it cannot stat", () => {
        // Fixed clock (not Date.now()) so directory placement and the
        // mtime-freshness check are deterministic regardless of wall time.
        const nowMs = Date.parse(TS);
        const now = new Date(nowMs);
        const year = String(now.getFullYear());
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const day = String(now.getDate()).padStart(2, "0");
        const sessionsDir = mkdtempSync(join(tmpdir(), "codex-sessions-"));
        const dateDir = join(sessionsDir, year, month, day);
        mkdirSync(dateDir, { recursive: true });
        const livePath = join(dateDir, "rollout-live.jsonl");
        writeFileSync(livePath, rollout({ completed: true }));
        utimesSync(livePath, now, now);
        symlinkSync(join(dateDir, "does-not-exist.jsonl"), join(dateDir, "rollout-broken.jsonl"));

        const resolved = resolveCodexSubagentAttribution(
            event({ hook_event: "PostToolUse" }),
            { sessionsDir, nowMs },
        );
        expect(resolved).toEqual({
            subagent_id: "sub-thread",
            agent_name: "/root/kill_a_survivors",
            parent_agent: "parent-thread",
            model: "vendor-model-luna",
        });
    });

    it("picks a matching pending call when the rollout has multiple queued candidates", () => {
        const rows = [
            {
                timestamp: "2026-08-20T15:48:40.000Z",
                type: "session_meta",
                payload: {
                    id: "sub-thread",
                    source: {
                        subagent: {
                            thread_spawn: {
                                parent_thread_id: "parent-thread",
                                agent_path: "/root/kill_a_survivors",
                            },
                        },
                    },
                    cwd: "/repo",
                },
            },
            {
                timestamp: "2026-08-20T15:48:41.000Z",
                type: "turn_context",
                payload: { model: "vendor-model-luna" },
            },
            {
                timestamp: "2026-08-20T15:48:50.000Z",
                type: "response_item",
                payload: {
                    type: "custom_tool_call",
                    name: "exec",
                    call_id: "call-early",
                    input: "sed -n '1,40p' src/a.ts (queued earlier)",
                },
            },
            {
                timestamp: "2026-08-20T15:48:53.000Z",
                type: "response_item",
                payload: {
                    type: "custom_tool_call",
                    name: "exec",
                    call_id: "call-late",
                    input: "sed -n '1,40p' src/a.ts (queued later)",
                },
            },
        ];
        const path = tempRollout(rows.map((row) => JSON.stringify(row)).join("\n"));
        const resolved = resolveCodexSubagentAttribution(event(), {
            rolloutPaths: [path],
            nowMs: Date.parse(TS),
        });
        expect(resolved).toEqual({
            subagent_id: "sub-thread",
            agent_name: "/root/kill_a_survivors",
            parent_agent: "parent-thread",
            model: "vendor-model-luna",
        });
    });
});
