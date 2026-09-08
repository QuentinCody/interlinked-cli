import { readdirSync } from "node:fs";
import { join } from "node:path";
import { artifactSourcePath } from "../../lib/metrics/evidence-json.js";
import { parseShardRecord } from "../coverage-shards/vitest.js";
import { strictElements } from "./strict-elements.js";
import type { ShardCoverageContribution } from "./types.js";
import { readEvidenceArtifact } from "../../lib/metrics/evidence-store.js";

export interface StrictCapturedShard { contribution: ShardCoverageContribution; tests: string[]; durationMs: number; }
export function readStrictCapture(directory: string, root: string): StrictCapturedShard[] {
    const result: StrictCapturedShard[] = [], ids = new Set<string>();
    for (const path of readdirSync(join(directory, "shards")).filter(path => path.endsWith(".json"))) {
        const row = parseShardRecord(JSON.parse(readEvidenceArtifact(join(directory, "shards", path))));
        if (!row || row.passed !== true || row.project || row.testFiles.length !== 1) throw new Error("Incomplete, failed or unsupported multi-project shard");
        const tests = row.testFiles.map(file => artifactSourcePath(root, file)), shardId = tests.join("+");
        if (ids.has(shardId)) throw new Error("Repeated shard boundary; index cannot establish isolation");
        ids.add(shardId);
        result.push({ contribution: { shardId, files: strictElements(row.istanbul, root) }, tests, durationMs: row.durationMs ?? 0 });
    }
    if (!result.length) throw new Error("No test shards captured");
    return result;
}
