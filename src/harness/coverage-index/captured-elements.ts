import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { artifactSourcePath } from "../../lib/metrics/evidence-json.js";
import { parseShardRecord } from "../coverage-shards/vitest.js";
import { strictElements } from "./strict-elements.js";
import type { ShardCoverageContribution } from "./types.js";
import { readEvidenceArtifact } from "../../lib/metrics/evidence-store.js";

export interface StrictCapturedShard { contribution: ShardCoverageContribution; tests: string[]; durationMs: number; }

/** One capture record's failing test files: none when it passed, its files when it did not, the record's name when it cannot be read. */
function failedShardFiles(directory: string, path: string, root: string): string[] {
    let row: ReturnType<typeof parseShardRecord>;
    try {
        row = parseShardRecord(JSON.parse(readEvidenceArtifact(join(directory, "shards", path))));
    } catch (error) {
        return [`${path} (unreadable: ${error instanceof Error ? error.message : String(error)})`];
    }
    if (!row) return [`${path} (unrecognized shard record)`];
    return row.passed === true ? [] : row.testFiles.map(file => artifactSourcePath(root, file));
}

/** The test files of every captured shard that did not pass — the names behind a "Tests did not pass" verdict (sorted, bounded). */
export function failedCaptureShards(directory: string, root: string, limit = 10): string[] {
    const shards = existsSync(join(directory, "shards")) ? readdirSync(join(directory, "shards")).filter(path => path.endsWith(".json")) : [];
    return shards.flatMap(path => failedShardFiles(directory, path, root)).sort().slice(0, limit);
}
/**
 * Yields the captured shards ONE AT A TIME so the caller can persist and fold each before the next is parsed:
 * a 2501-shard capture (≈2.5 GB of records) does not fit in one process at the default heap (2026-09-29).
 * Record validity (passed, single-file, unique boundary) is enforced as each record is read; an empty capture
 * is reported when the iteration ends.
 */
export function* iterateStrictCapture(directory: string, root: string): Generator<StrictCapturedShard, void, undefined> {
    const ids = new Set<string>();
    for (const path of readdirSync(join(directory, "shards")).filter(path => path.endsWith(".json")).sort()) {
        const row = parseShardRecord(JSON.parse(readEvidenceArtifact(join(directory, "shards", path))));
        if (!row || row.passed !== true || row.project || row.testFiles.length !== 1) throw new Error("Incomplete, failed or unsupported multi-project shard");
        const tests = row.testFiles.map(file => artifactSourcePath(root, file)), shardId = tests.join("+");
        if (ids.has(shardId)) throw new Error("Repeated shard boundary; index cannot establish isolation");
        ids.add(shardId);
        yield { contribution: { shardId, files: strictElements(row.istanbul, root) }, tests, durationMs: row.durationMs ?? 0 };
    }
    if (!ids.size) throw new Error("No test shards captured");
}

export function readStrictCapture(directory: string, root: string): StrictCapturedShard[] {
    return [...iterateStrictCapture(directory, root)];
}
