import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceDigest } from "../finding-outcomes.js";
import { isJsonObject } from "../../lib/json-types.js";
import { evidenceRuntimeIdentity } from "../evidence-runtime-identity.js";
import { captureCorpusInputs, type CorpusFailure } from "./corpus-snapshot.js";

export interface CorpusProvenance {
    schema: "corpus-scan.v2";
    detector: string;
    configuration: string;
    input: string;
    scope: string;
    search_root: string;
    run: string;
    timestamp: string;
    discovered: number;
    eligible: number;
    read: number;
    executed: number;
    complete: boolean;
    exclusions: string[];
    failures: CorpusFailure[];
}
export type CorpusBinding = Pick<CorpusProvenance, "detector" | "configuration" | "input" | "scope" | "search_root">;

/** The scanner executes raw functions, without policy suppression or diff filtering. */
export const CORPUS_CONFIGURATION = evidenceDigest("raw-registry-functions:v2;fixtures-excluded;2MB-input-budget");

export function corpusRuntimeRoot(moduleFile: string): { root: string; code: string } {
    const marker = sep + "dist" + sep;
    const at = moduleFile.lastIndexOf(marker);
    if (at >= 0) return { root: moduleFile.slice(0, at), code: "dist" };
    return { root: resolve(dirname(moduleFile), "../../.."), code: "src" };
}
function sourceIdentity(): string {
    const { root, code } = corpusRuntimeRoot(fileURLToPath(import.meta.url));
    if (code === "dist") return evidenceRuntimeIdentity();
    try {
        const snapshot = captureCorpusInputs(join(root, code), root, "source");
        if (snapshot.failures.length || snapshot.inputs.length === 0) return "unavailable";
        const dependency = existsSync(join(root, "package-lock.json")) ? "package-lock.json" : "package.json";
        return evidenceDigest(snapshot.digest + readFileSync(join(root, dependency), "utf8") + process.version);
    } catch { return "unavailable"; }
}
// Capture once when the source runner imports this module. A disk edit mid-run
// is detected separately; it cannot relabel already-loaded detector code.
export const CORPUS_DETECTOR_IDENTITY = sourceIdentity();
export function currentCorpusDetectorIdentity(): string { return sourceIdentity(); }

export function corpusProvenanceMatches(record: CorpusProvenance | undefined, current: CorpusBinding | undefined): boolean {
    if (!record || !current || record.schema !== "corpus-scan.v2") return false;
    if (!record.complete || record.failures.length > 0 || record.eligible <= 0) return false;
    if (record.discovered < record.eligible || record.read !== record.eligible || record.executed !== record.eligible) return false;
    return (["detector", "configuration", "input", "scope", "search_root"] as const).every((field) => {
        return record[field] !== "" && record[field] !== "unavailable" && record[field] === current[field];
    });
}

export function parseCorpusProvenance(raw: unknown): CorpusProvenance | undefined {
    if (!isJsonObject(raw) || raw.schema !== "corpus-scan.v2" || typeof raw.complete !== "boolean") return undefined;
    const strings = ["detector", "configuration", "input", "scope", "search_root", "run", "timestamp"];
    if (!strings.every(key => typeof raw[key] === "string")) return undefined;
    if (!["discovered", "eligible", "read", "executed"].every(key => Number.isSafeInteger(raw[key]) && Number(raw[key]) >= 0)) return undefined;
    if (!Array.isArray(raw.exclusions) || !raw.exclusions.every(x => typeof x === "string")) return undefined;
    if (!Array.isArray(raw.failures) || !raw.failures.every(x => isJsonObject(x) && typeof x.file === "string" && typeof x.message === "string")) return undefined;
    // SAFETY: all required discriminants, bindings, counters and array elements were validated above.
    return raw as unknown as CorpusProvenance;
}
