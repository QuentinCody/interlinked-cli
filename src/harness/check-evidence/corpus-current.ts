import { join } from "node:path";
import type { CheckRegistration } from "../check-registry/types.js";
import type { CorpusRecord } from "./corpus.js";
import type { CorpusBinding } from "./corpus-provenance.js";
import { loadCorpusStore, recordCorpusScan } from "./corpus-scan.js";
import type { DetectorIdentitySource } from "./detector-closure.js";

/**
 * Local tests, pre-push and CI all execute this read-only qualification path.
 *
 * Each check is scanned over ONE capture of `<root>/src`, and its binding comes
 * from that same capture (plus the detector's import closure read after the
 * scan). The tree is not read a second time, so a concurrent edit to a file
 * the detector does not import cannot void the evidence.
 */
export function qualifyCurrentCorpus(root: string, ids: readonly string[], registry: readonly CheckRegistration[],
    identity?: DetectorIdentitySource): {
    records: Record<string, CorpusRecord>; bindings: Record<string, CorpusBinding>;
} {
    const stored = loadCorpusStore(root);
    const records: Record<string, CorpusRecord> = {};
    const bindings: Record<string, CorpusBinding> = {};
    for (const id of ids) {
        const check = registry.find(row => row.id === id);
        if (!check) throw new Error("Unknown corpus cohort check: " + id);
        const scan = recordCorpusScan(stored, check, join(root, "src"), root, identity);
        records[id] = scan.record;
        bindings[id] = scan.binding;
    }
    return { records, bindings };
}
