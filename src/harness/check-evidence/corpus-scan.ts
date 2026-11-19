// Corpus scans execute raw detector functions and retain complete input evidence.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { CheckRegistration } from "../check-registry/types.js";
import { CHECK_CORPUS_PATH, type CorpusHit, type CorpusRecord, type CorpusStore, EMPTY_CORPUS, parseCorpusStore } from "./corpus.js";
import { CORPUS_CONFIGURATION, corpusDetectorIdentity, type CorpusBinding, type CorpusProvenance } from "./corpus-provenance.js";
import { captureCorpusInputs, corpusScope, type CorpusFailure, type CorpusSnapshot } from "./corpus-snapshot.js";
import { buildBoundCorpusRecord } from "./corpus-v2.js";
import type { DetectorIdentitySource } from "./detector-closure.js";

interface CorpusScanResult {
    hits: CorpusHit[];
    files_scanned: number;
    failures: CorpusFailure[];
    provenance: CorpusProvenance;
    /** The current binding, from the SAME capture the detector read and the closure read after the scan. */
    binding: CorpusBinding;
}

/** Run the detector over every captured input; errors are recorded, never dropped. */
function executeDetector(check: CheckRegistration, snapshot: CorpusSnapshot): { hits: CorpusHit[]; failures: CorpusFailure[]; executed: number } {
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
    return { hits, failures, executed };
}

/**
 * Bind eligibility and errors to the same exact bytes the detector read. The
 * inputs are captured ONCE: the detector reads that capture, and the input
 * digest and the returned binding describe it, so a later disk edit cannot
 * void (or relabel) what was scanned. The detector identity is its own import
 * closure (`detector-closure.ts`), read again after the scan.
 */
export function scanCorpus(check: CheckRegistration, searchRoot: string, repoRoot: string,
    identity: DetectorIdentitySource = corpusDetectorIdentity): CorpusScanResult {
    const scope = corpusScope(check.id);
    const snapshot = captureCorpusInputs(searchRoot, repoRoot, scope);
    const { hits, failures, executed } = executeDetector(check, snapshot);
    const detector = identity(check.fn.name);
    if (detector.current !== detector.loaded) {
        failures.push({ file: "detector", message: "detector changed after runtime import" });
    }
    const search_root = relative(repoRoot, searchRoot);
    const provenance: CorpusProvenance = { schema: "corpus-scan.v2",
        detector: detector.loaded, configuration: CORPUS_CONFIGURATION, input: snapshot.digest,
        scope, search_root, run: randomUUID(), timestamp: new Date().toISOString(),
        discovered: snapshot.discovered, eligible: snapshot.eligible, read: snapshot.inputs.length,
        executed, complete: failures.length === 0, failures, exclusions: snapshot.exclusions };
    const binding: CorpusBinding = { detector: detector.current, configuration: CORPUS_CONFIGURATION,
        input: snapshot.digest, scope, search_root };
    return { hits, files_scanned: snapshot.inputs.length, failures, provenance, binding };
}

/** Recompute a STORED record's binding against the tree now; never trust a persisted 'fresh' flag. */
export function currentCorpusBinding(record: CorpusRecord, repoRoot: string, check: Pick<CheckRegistration, "id" | "fn">,
    identity: DetectorIdentitySource = corpusDetectorIdentity): CorpusBinding | undefined {
    const provenance = record.provenance;
    const scope = corpusScope(check.id);
    if (!provenance || provenance.scope !== scope || provenance.search_root !== "src") return undefined;
    const snapshot = captureCorpusInputs(join(repoRoot, "src"), repoRoot, scope);
    if (snapshot.failures.length > 0) return undefined;
    return { detector: identity(check.fn.name).current, configuration: CORPUS_CONFIGURATION,
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

export function recordCorpusScan(store: CorpusStore, check: CheckRegistration, searchRoot: string, repoRoot: string,
    identity: DetectorIdentitySource = corpusDetectorIdentity): {
    store: CorpusStore; record: CorpusRecord; failures: CorpusFailure[]; binding: CorpusBinding;
} {
    const scan = scanCorpus(check, searchRoot, repoRoot, identity);
    const record = buildBoundCorpusRecord(scan.hits, scan.provenance, store.checks[check.id]);
    return { store: { version: 2, checks: { ...store.checks, [check.id]: record } }, record, failures: scan.failures,
        binding: scan.binding };
}
