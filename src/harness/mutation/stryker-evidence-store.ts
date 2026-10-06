import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { withFileMutationLock } from "../../lib/file-mutation-lock.js";
import { preserveStrykerEvidence } from "./stryker-evidence.js";
import { appendMutationRun, MUTATION_RETENTION, pruneMutationReports, type MutationRetention } from "./stryker-evidence-retention.js";

const MAX_RAW_REPORT_BYTES = 16 * 1024 * 1024;
export interface RetainedMutationReport { retained: boolean; path?: string; sha256?: string; reason?: string; pruned?: number }
/** Bounded local sidecar. No signed-v3 schema or mutation score semantics change. */
export function retainMutationReport(args: { cwd: string; report: unknown; run: string; source: string }, limits: MutationRetention = MUTATION_RETENTION): RetainedMutationReport {
    if (!isJsonObject(args.report)) return { retained: false, reason: "report is not an object" };
    try {
        const evidence = preserveStrykerEvidence(args.report);
        const bytes = JSON.stringify(evidence);
        if (Buffer.byteLength(bytes) > MAX_RAW_REPORT_BYTES) return { retained: false, reason: "raw report exceeds 16 MiB retention budget" };
        if (Buffer.byteLength(bytes) > limits.bytes) return { retained: false, reason: "report exceeds total retention budget" };
        const directory = join(args.cwd, ".interlinked", "mutation-evidence");
        mkdirSync(directory, { recursive: true });
        const path = join(directory, evidence.report_sha256 + ".json");
        const log = join(directory, "runs.jsonl");
        return withFileMutationLock(log, () => {
        try { writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); }
        catch (error) {
            if (!isJsonObject(error) || error.code !== "EEXIST") throw error;
            if (statSync(path).size > MAX_RAW_REPORT_BYTES) throw new Error("existing mutation evidence exceeds read budget");
            if (readFileSync(path, "utf8") !== bytes) throw new Error("existing mutation evidence does not match its content identity");
        }
        const pruned = pruneMutationReports(directory, path, limits, Date.now());
        appendMutationRun(log, JSON.stringify({
            schema: "mutation-evidence-run.v1", run: args.run, source: args.source,
            report_sha256: evidence.report_sha256, observed_at: new Date().toISOString(),
            freshness: "unknown", classification: "raw evidence; killedBy is not causal attribution", pruned_reports: pruned,
        }) + "\n", limits.logBytes);
        return { retained: true, path, sha256: evidence.report_sha256, pruned };
        }, { waitMs: 1000 });
    } catch (error) { return { retained: false, reason: String(error) }; }
}
