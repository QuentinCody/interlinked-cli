import { createHash } from "node:crypto";
import { isJsonObject } from "../../lib/json-types.js";

export interface StrykerMutantEvidence {
    id?: unknown; statusReason?: unknown; killedBy?: unknown; testsCompleted?: unknown;
}
export interface StrykerReportEvidence {
    schema: "stryker-raw-evidence.v1";
    report_sha256: string;
    /** JSON-value serialization at the adapter boundary, including unknown fields; not original HTTP bytes. */
    report_json: string;
    unresolved_test_ids: string[];
    applicability: "unknown";
}
export interface KillInputBinding {
    closure: "complete" | "unknown";
    hashes: Record<string, string>;
    runtime: string;
    environment: Record<string, string | null>;
}
export function mutantRawEvidence(raw: Record<string, unknown>): StrykerMutantEvidence {
    return Object.fromEntries((["id", "statusReason", "killedBy", "testsCompleted"] as const)
        .filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]));
}
function knownTestIds(report: Record<string, unknown>): Set<string> {
    const counts = new Map<string, number>();
    if (!isJsonObject(report.testFiles)) return new Set();
    for (const file of Object.values(report.testFiles)) {
        if (!isJsonObject(file) || !Array.isArray(file.tests)) continue;
        for (const test of file.tests) {
            if (isJsonObject(test) && typeof test.id === "string") counts.set(test.id, (counts.get(test.id) ?? 0) + 1);
        }
    }
    // Ambiguous test IDs remain unresolved.
    return new Set([...counts].filter(([, count]) => count === 1).map(([id]) => id));
}
function referencedTests(file: unknown): string[] {
    if (!isJsonObject(file) || !Array.isArray(file.mutants)) return [];
    return file.mutants.flatMap(mutant => {
        if (!isJsonObject(mutant) || !Array.isArray(mutant.killedBy)) return [];
        return mutant.killedBy.filter((id): id is string => typeof id === "string");
    });
}
function unresolvedTests(report: Record<string, unknown>): string[] {
    const known = knownTestIds(report);
    if (!isJsonObject(report.files)) return [];
    return [...new Set(Object.values(report.files).flatMap(referencedTests).filter(id => !known.has(id)))].sort();
}
/** Sidecar evidence, never silently appended to a signed protocol-v3 payload. */
export function preserveStrykerEvidence(report: Record<string, unknown>): StrykerReportEvidence {
    const json = JSON.stringify(report);
    return { schema: "stryker-raw-evidence.v1", report_sha256: createHash("sha256").update(json).digest("hex"),
        report_json: json, unresolved_test_ids: unresolvedTests(report), applicability: "unknown" };
}
function bindingDigest(binding: KillInputBinding): string {
    return JSON.stringify([binding.runtime, Object.entries(binding.hashes).sort(), Object.entries(binding.environment).sort()]);
}
/** killedBy is not an input closure. Callers must supply a declared complete binding. */
export function killApplicability(recorded: KillInputBinding | undefined, current: KillInputBinding | undefined): "current" | "stale" | "unknown" {
    if (!recorded || !current || recorded.closure !== "complete" || current.closure !== "complete") return "unknown";
    return bindingDigest(recorded) === bindingDigest(current) ? "current" : "stale";
}
