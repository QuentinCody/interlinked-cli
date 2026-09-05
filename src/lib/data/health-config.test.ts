import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCapturedData, recordCaptureReceipt } from "./capture.js";
import { parseDataConfig, readDataConfig, updateDataConfig } from "./config.js";
import { dataHealth } from "./health.js";
import { indexData } from "./indexer.js";
import { investigateData } from "./investigate.js";
import { dataOpenObligations } from "./obligation-view.js";
import { isJsonObject } from "../json-types.js";
import { maintainData } from "./maintenance.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "data-health-")); mkdirSync(join(cwd, ".interlinked")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe("data health and operator contracts", () => {
    it("records failed maintenance operations in producer health", async () => {
        writeFileSync(join(cwd, ".interlinked", "data.config.json"), "invalid");
        await expect(maintainData(cwd, { execute: true })).rejects.toThrow();
        const sources = dataHealth(cwd).sources;
        expect(Array.isArray(sources) && sources.filter(isJsonObject).find((source) => source.name === "data-maintenance")).toMatchObject({ state: "failed" });
    });
    it("separates unsupported providers from written evidence and exposes failed producers", () => {
        appendCapturedData({ cwd, producer: "native", provider: "codex" }, "costs", [{ input_tokens: 3 }]);
        recordCaptureReceipt({ cwd, producer: "native", provider: "pi" }, { source: "costs", status: "unsupported" });
        const sources = dataHealth(cwd).sources;
        expect(Array.isArray(sources) && sources.filter(isJsonObject).find((source) => source.name === "costs")).toMatchObject({ state: "observed", receipts: expect.any(Array) });
        recordCaptureReceipt({ cwd, producer: "native", provider: "codex" }, { source: "costs", status: "failed" });
        const failed = dataHealth(cwd).sources;
        expect(Array.isArray(failed) && failed.filter(isJsonObject).find((source) => source.name === "costs")).toMatchObject({ state: "failed" });
    });
    it("rejects real project capture from tests and keeps temporary roots usable", () => {
        expect(() => appendCapturedData({ cwd: process.cwd(), producer: "fixture" }, "tests", [{}])).toThrow("real project data directory");
        expect(appendCapturedData({ cwd, producer: "fixture" }, "tests", [{}])).toBe(true);
    });
    it("round trips bounded automation configuration and rejects invalid policy", () => {
        expect(readDataConfig(cwd).auto_index).toBe(false);
        updateDataConfig(cwd, { auto_index: true, index_max_mb: 32 });
        expect(readDataConfig(cwd)).toMatchObject({ auto_index: true, index_max_mb: 32 });
        expect(() => parseDataConfig({ keep_live_mb: 300, compact_at_mb: 200 })).toThrow();
        expect(() => parseDataConfig({ constructor: "invalid" })).toThrow();
    });
    it("correlates phases while preserving missing evidence and capture-envelope session identity", async () => {
        const context = { cwd, producer: "fixture", session: "s", provider: "codex" };
        appendCapturedData(context, "collection", [{ phase: "pre", tool_use_id: "call" }, { phase: "post", tool_use_id: "call" }]);
        await indexData(cwd);
        const result = await investigateData(cwd, { session: "s", call: "call" });
        expect(result.calls).toEqual([expect.objectContaining({ session: "s", call_id: "call", stages_observed: expect.arrayContaining(["tool-attempt", "tool-completion"]), not_observed_in_result: expect.arrayContaining(["guard-verdict"]) })]);
    });
    it("folds obligation transactions and never treats malformed evidence as no debt", async () => {
        const path = join(cwd, ".interlinked", "obligations.jsonl");
        writeFileSync(path, JSON.stringify({ op: "open", kind: "coverage", file: "a.ts", contentHash: "hash", sessionId: "s", atMs: 1 }) + "\n");
        expect(await dataOpenObligations(cwd, "a.ts")).toMatchObject({ state: "available", obligations: [expect.objectContaining({ file: "a.ts" })] });
        appendFileSync(path, JSON.stringify({ op: "discharge", id: "coverage:a.ts", source: "observed", atMs: 2 }) + "\n");
        expect(await dataOpenObligations(cwd, "a.ts")).toMatchObject({ state: "available", obligations: [] });
        appendFileSync(path, "broken\n");
        expect(await dataOpenObligations(cwd, "a.ts")).toMatchObject({ state: "unavailable", obligations: null });
    });
});
