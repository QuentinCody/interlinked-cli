import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceDigest } from "../finding-outcomes.js";
import { isJsonObject } from "../../lib/json-types.js";
import { evidenceRuntimeIdentity } from "../evidence-runtime-identity.js";
import type { CorpusFailure } from "./corpus-snapshot.js";
import { captureDetectorSources, type DetectorIdentitySource } from "./detector-closure.js";

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
function runtimeDetectorIdentity(): DetectorIdentitySource {
    const { root, code } = corpusRuntimeRoot(fileURLToPath(import.meta.url));
    if (code === "src") return captureDetectorSources(root);
    // A bundle is immutable chunks: its build fingerprint is the whole identity.
    const build = evidenceRuntimeIdentity();
    return () => ({ loaded: build, current: evidenceRuntimeIdentity() });
}
// Capture once when the source runner imports this module, so an edit after
// load cannot relabel already-loaded detector code. Each detector's identity is
// its own static import closure (detector-closure.ts): an edit to an unrelated
// file no longer voids its evidence.
export const corpusDetectorIdentity: DetectorIdentitySource = runtimeDetectorIdentity();

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
