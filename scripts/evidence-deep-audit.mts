import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcessAsync } from "../src/harness/check-engine/spawn-async.js";
import { isJsonObject } from "../src/lib/json-types.js";

/** Stable section/detail keys are deduplication hints, not semantic finding identity. */
export function auditKeys(report: unknown): string[] {
    if (!isJsonObject(report) || report.schema_version !== "interlinked.verify/1") throw new Error("unsupported verify report");
    const keys: string[] = [];
    for (const [section, value] of Object.entries(report)) {
        if (!isJsonObject(value) || !Array.isArray(value.details)) continue;
        for (const detail of value.details) {
            if (!isJsonObject(detail)) continue;
            const ordered = Object.entries(detail).filter(([key]) => !["timestamp", "duration_ms"].includes(key)).sort(([a], [b]) => a.localeCompare(b));
            keys.push(createHash("sha256").update(JSON.stringify([section, ordered])).digest("hex"));
        }
    }
    return [...new Set(keys)].sort();
}
export async function deepAudit(root: string, out: string): Promise<unknown> {
    mkdirSync(out, { recursive: true });
    const started = Date.now();
    // verify owns resource admission. Wrapping it in another heavy lease can deny its own children capacity.
    const result = await runProcessAsync(process.execPath,
        ["--max-old-space-size=4096", join(root, "dist/index.js"), "verify", "--all-checks", "--json"],
        { cwd: root, timeout: 15 * 60 * 1000 });
    writeFileSync(join(out, "verify.stdout.json"), result.stdout);
    writeFileSync(join(out, "verify.stderr.txt"), result.stderr);
    let keys: string[] = [], parsed = false, reason: string | null = null;
    try { keys = auditKeys(JSON.parse(result.stdout)); parsed = true; } catch (error) { reason = String(error); }
    const oldPath = join(out, "previous-keys.json");
    let previous: unknown = null;
    if (existsSync(oldPath)) { try { previous = JSON.parse(readFileSync(oldPath, "utf8")); } catch { previous = null; } }
    const known = new Set(Array.isArray(previous) ? previous.filter((key): key is string => typeof key === "string") : []);
    const report = { schema: "deep-audit.v1", owner: "QuentinCody", advisory: true, started_at: new Date(started).toISOString(),
        elapsed_ms: Date.now() - started, exit_code: result.code, timed_out: result.timedOut, killed: result.killed,
        capture_complete: parsed && !result.stdoutTruncated && !result.stderrTruncated && !result.killed,
        parse_issue: reason, keys, new_keys: keys.filter(key => !known.has(key)), previous_comparison_available: Array.isArray(previous),
        deduplication: "exact section/detail identity; summary-only sections remain in raw report",
        triage: "Review new keys and raw unavailable checks; record verdict and retained regression case. No automatic suppression or issue creation.",
        caps: { wall_minutes: 15, stdout_bytes: 10485760, stderr_bytes: 10485760, artifact_retention_days: 14 } };
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    if (report.capture_complete) writeFileSync(join(out, "keys.json"), JSON.stringify(keys));
    else if (Array.isArray(previous)) writeFileSync(join(out, "keys.json"), JSON.stringify([...known]));
    return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = await deepAudit(process.cwd(), resolve(process.argv[2] ?? ".interlinked/agent-output/deep-audit"));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
