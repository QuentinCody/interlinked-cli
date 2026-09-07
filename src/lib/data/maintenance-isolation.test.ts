import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { maintainData, dataMaintenanceJobs } from "./maintenance.js";
import { updateDataConfig } from "./config.js";
import { dataIndexPath } from "./index-schema.js";
import { discoverDataFiles } from "./discovery.js";

describe("independent evidence maintenance controls", () => {
    it("rotates losslessly with no SQLite creation when only rotation is enabled", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "interlinked-rotation-only-"));
        const data = join(cwd, ".interlinked");
        mkdirSync(data);
        const original = `${JSON.stringify({ message: "x".repeat(1024) })}\n`.repeat(2200);
        writeFileSync(join(data, "timeline.jsonl"), original);
        updateDataConfig(cwd, { auto_compact: true, auto_index: false, keep_live_mb: 1, compact_at_mb: 2 });
        expect(dataMaintenanceJobs(cwd)).toHaveLength(1);
        const result = await maintainData(cwd, { execute: true });
        expect(result).toMatchObject({ executed: true, indexing: null, rotations: [expect.objectContaining({ compacted: true })] });
        expect(existsSync(dataIndexPath(cwd))).toBe(false);
        const archives = discoverDataFiles(cwd).files.filter((file) => file.archived && file.source.name === "timeline");
        expect(archives).toHaveLength(1);
        const archive = archives[0];
        if (!archive) throw new Error("archive missing");
        expect(gunzipSync(readFileSync(archive.path)).toString() + readFileSync(join(data, "timeline.jsonl"), "utf8")).toBe(original);
    });
    it("leaves automatic work disabled by default and supports explicit indexing", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "interlinked-explicit-index-"));
        expect(dataMaintenanceJobs(cwd)).toEqual([]);
        await maintainData(cwd, { execute: true });
        expect(existsSync(dataIndexPath(cwd))).toBe(false);
        await maintainData(cwd, { execute: true, index: true });
        expect(existsSync(dataIndexPath(cwd))).toBe(true);
        const originalIndex = readFileSync(dataIndexPath(cwd));
        await maintainData(cwd, { execute: true, index: false });
        expect(readFileSync(dataIndexPath(cwd))).toEqual(originalIndex);
    });
});
