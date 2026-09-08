import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexData } from "./indexer.js";
import { searchData } from "./search.js";
import { dataView } from "./views.js";

let cwd: string;
let dir: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "data-usage-retention-")); dir = join(cwd, ".interlinked"); mkdirSync(dir); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

function usage(id: string, input: number, variant: string): string {
    return `${JSON.stringify({ schema: "usage-delta.v1", ts: "2026-09-08T12:00:00Z", tool_use_id: id, provider: "claude", session_id: "session", input_tokens: input, capture: { event_id: variant } })}\n`;
}

describe("usage deduplication within retained query scope", () => {
    it("retains an archived usage message when its newer duplicate generation is superseded", async () => {
        const path = join(dir, "costs.jsonl");
        const original = usage("message-a", 10, "older");
        writeFileSync(path, original);
        await indexData(cwd);
        appendFileSync(path, usage("message-a", 10, "newer"));
        await indexData(cwd);
        expect(dataView(cwd, "usage")).toMatchObject({ rows: [{ records: 1, input_tokens: 10 }] });
        mkdirSync(join(dir, "archive"));
        writeFileSync(join(dir, "archive", "costs-0001.jsonl.gz"), gzipSync(original));
        writeFileSync(path, usage("message-b", 20, "live"));
        await indexData(cwd);
        expect(searchData(cwd).rows).toHaveLength(2);
        expect(dataView(cwd, "usage")).toMatchObject({ rows: [{ records: 2, input_tokens: 30 }] });
        expect(dataView(cwd, "usage", { archives: false })).toMatchObject({ rows: [{ records: 1, input_tokens: 20 }] });
    });
    it("chooses a live copy when the latest indexed duplicate exists only in an archive", async () => {
        writeFileSync(join(dir, "costs.jsonl"), usage("message-a", 10, "live"));
        await indexData(cwd);
        mkdirSync(join(dir, "archive"));
        writeFileSync(join(dir, "archive", "costs-0001.jsonl.gz"), gzipSync(usage("message-a", 10, "archive")));
        await indexData(cwd);
        expect(dataView(cwd, "usage", { archives: false, session: "session" })).toMatchObject({ rows: [{ records: 1, input_tokens: 10 }] });
        expect(dataView(cwd, "usage")).toMatchObject({ rows: [{ records: 1, input_tokens: 10 }] });
    });
});
