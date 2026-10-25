import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callCoverage } from "./call-coverage.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Row shapes follow `.interlinked/timeline.jsonl` (timeline.v1) and `.interlinked/collection.jsonl` (collection.v1).
function use(root: string, ts: string, session: string, id: string, tool: string, cwd = root): string {
    return JSON.stringify({ schema: "timeline.v1", ts, session, provider: "claude-code", cwd, category: "tool_use", tool_name: tool, tool_use_id: id });
}
function seen(ts: string, session: string, id: string, phase: "pre" | "post"): string {
    return JSON.stringify({ schema: "collection.v1", kind: "tool_event", ts, session_id: session, phase, provider_tool: "x", tool_use_id: id });
}
function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "call-coverage-"))); roots.push(root);
    mkdirSync(join(root, ".interlinked"));
    writeFileSync(join(root, ".interlinked", "config.json"), "{}");
    const stray = join(root, "scratch", "probe");
    writeFileSync(join(root, ".interlinked", "timeline.jsonl"), [
        use(root, "2026-10-22T01:00:00.000Z", "A", "t1", "Bash"),
        use(root, "2026-10-22T01:00:01.000Z", "A", "t2", "Edit"),
        use(root, "2026-10-22T01:00:02.000Z", "A", "t3", "Write", stray),
        use(root, "2026-10-22T01:00:03.000Z", "A", "t4", "Write", stray),
        use(root, "2026-10-22T01:00:04.000Z", "A", "t5", "Read"),
        use(root, "2026-10-22T01:00:05.000Z", "B", "t6", "Bash"),
        use(root, "2026-10-21T01:00:00.000Z", "A", "t0", "Bash"),
        JSON.stringify({ schema: "timeline.v1", ts: "2026-10-22T01:00:06.000Z", session: "A", category: "tool_result", tool_use_id: "t5", is_error: false }),
        "{ torn line",
    ].join("\n") + "\n");
    writeFileSync(join(root, ".interlinked", "collection.jsonl"), [
        seen("2026-10-22T01:00:00.100Z", "A", "t1", "pre"), seen("2026-10-22T01:00:00.900Z", "A", "t1", "post"),
        seen("2026-10-22T01:00:01.100Z", "A", "t2", "pre"),
        seen("2026-10-22T01:00:05.100Z", "B", "t6", "post"),
    ].join("\n") + "\n");
    return root;
}

describe("callCoverage — positive", () => {
    it("P1: per session, a call is judged when the collection log holds any row with its tool_use_id; the rest are counted by tool and working folder", async () => {
        const rows = await callCoverage({ root: project(), since: "2026-10-22T00:00:00.000Z" });
        expect(rows).toEqual([
            { session: "A", provider: "claude-code", calls: 5, judged: 2, byTool: { Write: 2, Read: 1 }, byFolder: { "scratch/probe": 2, ".": 1 },
                firstUnjudged: "2026-10-22T01:00:02.000Z", lastUnjudged: "2026-10-22T01:00:04.000Z" },
            { session: "B", provider: "claude-code", calls: 1, judged: 1, byTool: {}, byFolder: {}, firstUnjudged: null, lastUnjudged: null },
        ]);
    });
});

describe("callCoverage — negative", () => {
    it("keeps reused tool ids in different sessions separate", async () => {
        const root = project();
        writeFileSync(join(root, ".interlinked", "timeline.jsonl"), [
            use(root, "2026-10-22T01:00:00.000Z", "A", "shared", "Bash"),
            use(root, "2026-10-22T01:00:01.000Z", "B", "shared", "Bash"),
        ].join("\n"));
        writeFileSync(join(root, ".interlinked", "collection.jsonl"), seen("2026-10-22T01:00:00.100Z", "A", "shared", "pre"));
        const rows = await callCoverage({ root, since: "2026-10-22T00:00:00.000Z" });
        expect(rows.map(row => [row.session, row.calls, row.judged])).toEqual([["A", 1, 1], ["B", 1, 0]]);
        expect((await callCoverage({ root, session: "B", since: "2026-10-22T00:00:00.000Z" }))[0]?.judged).toBe(0);
    });
    it("N1: calls before the window, other sessions, results and torn lines are not calls; no timeline is no evidence", async () => {
        const root = project();
        expect((await callCoverage({ root, session: "A", since: "2026-10-22T00:00:00.000Z" })).map(row => [row.session, row.calls])).toEqual([["A", 5]]);
        expect((await callCoverage({ root, session: "A", since: "2026-10-20T00:00:00.000Z" }))[0]?.calls).toBe(6);
        const empty = realpathSync(mkdtempSync(join(tmpdir(), "call-coverage-"))); roots.push(empty);
        expect(await callCoverage({ root: empty, since: "2026-10-22T00:00:00.000Z" })).toEqual([]);
    });
});
