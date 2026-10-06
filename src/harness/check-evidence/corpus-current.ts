import { join } from "node:path";
import type { CheckRegistration } from "../check-registry/types.js";
import type { CorpusRecord } from "./corpus.js";
import type { CorpusBinding } from "./corpus-provenance.js";
import { currentCorpusBinding, loadCorpusStore, recordCorpusScan } from "./corpus-scan.js";

/** Local tests, pre-push and CI all execute this read-only qualification path. */
export function qualifyCurrentCorpus(root: string, ids: readonly string[], registry: readonly CheckRegistration[]): {
    records: Record<string, CorpusRecord>; bindings: Record<string, CorpusBinding>;
} {
    const stored = loadCorpusStore(root);
    const records: Record<string, CorpusRecord> = {};
    const bindings: Record<string, CorpusBinding> = {};
    for (const id of ids) {
        const check = registry.find(row => row.id === id);
        if (!check) throw new Error("Unknown corpus cohort check: " + id);
        records[id] = recordCorpusScan(stored, check, join(root, "src"), root).record;
    }
    for (const [id, record] of Object.entries(records)) {
        const current = currentCorpusBinding(record, root, id);
        if (current) bindings[id] = current;
    }
    return { records, bindings };
}
