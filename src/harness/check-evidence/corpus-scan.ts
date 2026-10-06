// Corpus scans execute raw detector functions and retain complete input evidence.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { CheckRegistration } from "../check-registry/types.js";
import { CHECK_CORPUS_PATH, type CorpusHit, type CorpusRecord, type CorpusStore, EMPTY_CORPUS, parseCorpusStore } from "./corpus.js";
import { CORPUS_CONFIGURATION, CORPUS_DETECTOR_IDENTITY, currentCorpusDetectorIdentity, type CorpusBinding, type CorpusProvenance } from "./corpus-provenance.js";
import { captureCorpusInputs, corpusScope, type CorpusFailure } from "./corpus-snapshot.js";
import { buildBoundCorpusRecord } from "./corpus-v2.js";

interface CorpusScanResult {
    hits: CorpusHit[];
    files_scanned: number;
    failures: CorpusFailure[];
    provenance: CorpusProvenance;
}

/** Bind eligibility and errors to the same exact bytes the detector read. */
export function scanCorpus(check: CheckRegistration, searchRoot: string, repoRoot: string): CorpusScanResult {
    const scope = corpusScope(check.id);
    const snapshot = captureCorpusInputs(searchRoot, repoRoot, scope);
    const failures = [...snapshot.failures];
    const hits: CorpusHit[] = [];
    let executed = 0;
    for (const input of snapshot.inputs) {
        try {
            const matches = check.fn(input.content, input.file);
            hits.push(...matches.map(match => ({ file: input.file, line: match.line, text: match.text })));
            executed++;
        } catch (error) { failures.push({ file: input.file, message: String(error) }); }
    }
    const after = captureCorpusInputs(searchRoot, repoRoot, scope);
    if (after.digest !== snapshot.digest) failures.push({ file: searchRoot, message: "input changed during scan" });
    if (currentCorpusDetectorIdentity() !== CORPUS_DETECTOR_IDENTITY) {
        failures.push({ file: "detector", message: "detector changed after runtime import" });
    }
    const provenance: CorpusProvenance = { schema: "corpus-scan.v2",
        detector: CORPUS_DETECTOR_IDENTITY, configuration: CORPUS_CONFIGURATION, input: snapshot.digest,
        scope, search_root: relative(repoRoot, searchRoot), run: randomUUID(), timestamp: new Date().toISOString(),
        discovered: snapshot.discovered, eligible: snapshot.eligible, read: snapshot.inputs.length,
        executed, complete: failures.length === 0, failures, exclusions: snapshot.exclusions };
    return { hits, files_scanned: snapshot.inputs.length, failures, provenance };
}

/** Recompute, never trust a persisted 'fresh' flag. */
export function currentCorpusBinding(record: CorpusRecord, repoRoot: string, checkId: string): CorpusBinding | undefined {
    const provenance = record.provenance;
    const scope = corpusScope(checkId);
    if (!provenance || provenance.scope !== scope || provenance.search_root !== "src") return undefined;
    const snapshot = captureCorpusInputs(join(repoRoot, "src"), repoRoot, scope);
    if (snapshot.failures.length > 0) return undefined;
    return { detector: currentCorpusDetectorIdentity(), configuration: CORPUS_CONFIGURATION,
        input: snapshot.digest, scope, search_root: provenance.search_root };
}

export function loadCorpusStore(repoRoot: string): CorpusStore {
    const path = join(repoRoot, CHECK_CORPUS_PATH);
    if (!existsSync(path)) return EMPTY_CORPUS;
    try { return parseCorpusStore(JSON.parse(readFileSync(path, "utf8"))); }
    catch { return EMPTY_CORPUS; }
}

export function saveCorpusStore(repoRoot: string, store: CorpusStore): void {
    const target = join(repoRoot, CHECK_CORPUS_PATH);
    mkdirSync(dirname(target), { recursive: true });
    const temporary = target + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(store, null, "\t") + "\n", { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
}

export function recordCorpusScan(store: CorpusStore, check: CheckRegistration, searchRoot: string, repoRoot: string): {
    store: CorpusStore; record: CorpusRecord; failures: CorpusFailure[];
} {
    const scan = scanCorpus(check, searchRoot, repoRoot);
    const record = buildBoundCorpusRecord(scan.hits, scan.provenance, store.checks[check.id]);
    return { store: { version: 2, checks: { ...store.checks, [check.id]: record } }, record, failures: scan.failures };
}
