import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { withFileMutationLock } from "../lib/file-mutation-lock.js";
import { isJsonObject } from "../lib/json-types.js";
import type { OptionValues } from "commander";
import { CHECK_REGISTRY } from "../harness/check-registry/index.js";
import { loadCheckEvidenceBaseline } from "../harness/check-evidence/baseline.js";
import { CHECK_CORPUS_PATH, corpusSatisfied, unadjudicatedHits } from "../harness/check-evidence/corpus.js";
import { currentCorpusBinding, loadCorpusStore, recordCorpusScan, saveCorpusStore } from "../harness/check-evidence/corpus-scan.js";
import { CORPUS_CONTROLS, qualifyCorpusControls } from "../harness/check-evidence/corpus-controls.js";
import { output, getOutputMode } from "../lib/output.js";

export function corpusStatus(cwd: string, ids?: readonly string[]) {
    const store = loadCorpusStore(cwd);
    const enforced = new Set(loadCheckEvidenceBaseline(cwd).corpus_cohort ?? []);
    return Object.entries(store.checks).filter(([id]) => !ids || ids.includes(id)).map(([id, record]) => {
        const current = record.provenance ? currentCorpusBinding(record, cwd, id) : undefined;
        const check = CHECK_REGISTRY.find(check => check.id === id);
        const controls = check ? qualifyCorpusControls(check) : null;
        return { id, enforced: enforced.has(id), historical: !record.provenance,
            qualified: corpusSatisfied(record, current) && controls?.qualified === true,
            current_complete: corpusSatisfied(record, current), files: record.files_scanned,
            hits: record.hits.length, unadjudicated: unadjudicatedHits(record).length,
            provenance: record.provenance ?? null, controls };
    });
}
export function scanCheckCorpus(cwd: string, ids: readonly string[]): ReturnType<typeof corpusStatus> {
    if (ids.length === 0 || ids.length > 20) throw new Error("Select between 1 and 20 check ids per scan");
    const checks = ids.map(id => {
        const check = CHECK_REGISTRY.find(check => check.id === id);
        if (!check) throw new Error("Unknown check " + id);
        return check;
    });
    mkdirSync(join(cwd, ".interlinked"), { recursive: true });
    for (const check of checks) {
        withFileMutationLock(join(cwd, CHECK_CORPUS_PATH), () => {
            const store = corpusForUpdate(cwd);
            saveCorpusStore(cwd, recordCorpusScan(store, check, join(cwd, "src"), cwd).store);
        }, { waitMs: 1000 });
    }
    return corpusStatus(cwd, ids);
}
function corpusForUpdate(cwd: string): ReturnType<typeof loadCorpusStore> {
    const path = join(cwd, CHECK_CORPUS_PATH);
    if (!existsSync(path)) return loadCorpusStore(cwd);
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(raw) || (raw.version !== 1 && raw.version !== 2) || !isJsonObject(raw.checks)) throw new Error("Invalid corpus store; original bytes retained");
    const parsed = loadCorpusStore(cwd);
    if (Object.keys(parsed.checks).length !== Object.keys(raw.checks).length) throw new Error("Malformed corpus record; original bytes retained");
    return parsed;
}
export function harnessCorpusCommand(action: "status" | "scan", ids: string[], opts: OptionValues): void {
    const selected = ids.length ? ids : Object.keys(CORPUS_CONTROLS);
    const result = action === "scan" ? scanCheckCorpus(process.cwd(), selected) : corpusStatus(process.cwd(), ids.length ? ids : undefined);
    output(getOutputMode(opts), result, { json: () => result, normal: () => result.map(row =>
        row.id + ": " + (row.qualified ? "qualified" : row.historical ? "historical/unqualified" : "unqualified") +
        "; " + row.files + " files; " + row.hits + " hits; " + row.unadjudicated + " unadjudicated").join("\n") });
    if (action === "scan" && result.some(row => row.provenance?.complete !== true)) process.exitCode = 2;
}
