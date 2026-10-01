import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { captureVitestShards } from "../coverage-shards/vitest.js";
import type { CoverageRunResult } from "../coverage-runner.js";
import { elementSetMetrics, foldContribution } from "./aggregate.js";
import { failedCaptureShards, iterateStrictCapture } from "./captured-elements.js";
import { inventoryDigest, WHOLE_INVENTORY_KEY, type CoverageIndexContext } from "./context.js";
import { manifestValidity } from "./invalidation.js";
import { readAcceptedManifest } from "./store.js";
import { beginStaging, indexStore, iterateContributions, promoteMatchingProposal } from "./staged-state.js";
import { coverageSignature, denominatorContribution, elementsToCoverage, strictElements } from "./strict-elements.js";
import type { CanonicalCoverageElementSet, CoverageIndexManifest, FileCoverageMetrics } from "./types.js";

/** The synthetic shard carrying every measured file with zero hits (the denominator); it is never a test shard. */
const DENOMINATORS_SHARD = "@denominators";
import { containedFile, hashBytes } from "../../lib/metrics/inventory.js";
import { checkIndexStability, indexQuarantined } from "./stability.js";
import { readEvidenceArtifact } from "../../lib/metrics/evidence-store.js";
import { verifyIndexRuntime } from "./runtime-context.js";
import { remainingCoverageTime } from "./runtime-inputs.js";
import type { ResourceBudget } from "../resource-budget.js";

/**
 * `maxWorkers`: the host governor's worker cap for the instrumented capture; omitted ⇒ the runner's default.
 * `resourceBudget`: the memory budget the caller was ADMITTED under (project lease + host capacity held); the capture's
 * child tree is supervised against it, the way the scheduler supervises its runner (review 2026-09-30).
 */
export interface IndexedCoverageOptions { context: CoverageIndexContext; workspace: string; timeoutMs: number; full?: boolean; maxWorkers?: number; resourceBudget: ResourceBudget; }
/** `metrics`: per-file counts over the FULL universe (reused shards + the re-run ones + the zeroed denominators), the ratchet's input; present only when `indexed`. */
export interface IndexedCoverageResult { result: CoverageRunResult; selectedTests: string[] | undefined; indexed: boolean; reason: string | null; metrics?: Map<string, FileCoverageMetrics>; artifact?: { content: string; root: string; argv: string[] }; }
/** The aggregate's two views: the gate's line/function sets and the ratchet's per-dimension counts. */
type Aggregate = Map<string, CanonicalCoverageElementSet>;
function measured(aggregate: Aggregate): { perFile: CoverageRunResult["perFile"]; metrics: Map<string, FileCoverageMetrics> } {
    // Path order, whatever order the shards were folded in: a fold is not a sort.
    const ordered: Aggregate = new Map([...aggregate].sort(([left], [right]) => left.localeCompare(right)));
    return { perFile: elementsToCoverage(ordered), metrics: new Map([...ordered].map(([path, set]) => [path, elementSetMetrics(set)])) };
}
/** `retained`: the accepted shards an incremental run keeps (read one blob at a time, never all at once). */
interface Selection { previous: CoverageIndexManifest | null; selected: string[] | undefined; retained: string[]; full: boolean; }
/** The current inventory as a shard's recorded dependencies see it: per-file hashes plus the whole-inventory digest an opaque shard binds. */
function currentDependencies(context: CoverageIndexContext): Map<string, string> {
    const current = new Map(context.inventory.files.map(file => [file.path, file.sha256]));
    current.set(WHOLE_INVENTORY_KEY, inventoryDigest(context.inventory));
    return current;
}
function changedShard(current: ReadonlyMap<string, string>, hashes: Record<string, string>): boolean {
    return Object.entries(hashes).some(([path, hash]) => current.get(path) !== hash);
}
async function selectShards(context: CoverageIndexContext, full: boolean): Promise<Selection> {
    if (!full && indexQuarantined(context.storeRoot, context.fingerprint)) throw new Error("Coverage index quarantined; run metrics coverage warm to establish stability");
    await promoteMatchingProposal(context);
    const previous = readAcceptedManifest(indexStore(context.storeRoot));
    if (full || !previous || !manifestValidity(previous, context.validity).valid) return { previous, selected: undefined, retained: [], full: true };
    const selected: string[] = [], retained: string[] = [], current = currentDependencies(context);
    for (const entry of Object.values(previous.shards)) {
        if (entry.shardId === DENOMINATORS_SHARD) continue;
        if (entry.passed !== true || entry.instability.quarantined) throw new Error("Unstable or incomplete shard requires a full warm run");
        if (changedShard(current, entry.dependencyHashes)) selected.push(...entry.testPaths);
        else retained.push(entry.shardId);
    }
    if (!selected.length && previous.sourceRevision !== context.fingerprint) return { previous, selected: undefined, retained: [], full: true };
    return { previous, selected: [...new Set(selected)].sort(), retained, full: false };
}
function assertCaptureScope(context: CoverageIndexContext, selected: string[] | undefined, actual: string[]): void {
    const expected = selected ?? context.testFiles;
    if (JSON.stringify([...expected].sort()) !== JSON.stringify([...actual].sort())) throw new Error("Captured test universe differs from discovered/selected tests");
}
/**
 * STREAMING materialization: every captured shard is persisted (blob + manifest entry) and folded into the running
 * aggregate as it is read, then discarded; the retained shards of an incremental run are folded from their blobs
 * one at a time the same way. Memory is bounded by the aggregate plus one shard — holding all 2501 of this
 * repository's contributions at once exhausted the default heap (2026-09-29). Blobs are content-addressed, so
 * one written before a later validation failure is an unreferenced file, never accepted state; the pending
 * manifest is written only after every check passed.
 */
function materialize(options: IndexedCoverageOptions, selection: Selection, directory: string): Aggregate {
    const root = realpathSync(options.workspace), context = options.context;
    for (const file of context.inventory.files) {
        if (hashBytes(readFileSync(containedFile(root, file.path))) !== file.sha256) throw new Error(`Runner changed measured input: ${file.path}`);
    }
    const aggregate: Aggregate = new Map(), tests: string[] = [], staging = beginStaging(context, selection.previous, selection.full);
    for (const shard of iterateStrictCapture(directory, root)) {
        staging.add(shard);
        foldContribution(aggregate, shard.contribution);
        tests.push(...shard.tests);
    }
    assertCaptureScope(context, selection.selected, tests);
    const full = strictElements(JSON.parse(readEvidenceArtifact(join(directory, "coverage", "coverage-final.json"))), root);
    const denominator = denominatorContribution(full);
    staging.add({ contribution: denominator, tests: [], durationMs: 0 });
    foldContribution(aggregate, denominator);
    if (selection.previous) for (const kept of iterateContributions(context.storeRoot, selection.previous, selection.retained)) foldContribution(aggregate, kept);
    if (selection.full && coverageSignature(aggregate) !== coverageSignature(full)) throw new Error("Per-shard aggregate differs from the full coverage report");
    validateStability(context, selection, aggregate);
    remainingCoverageTime(context.runtime.deadline);
    staging.finish();
    return aggregate;
}
/** The prior accepted aggregate's signature, folded one blob at a time; null when no comparable prior exists. */
function priorSignature(context: CoverageIndexContext, previous: CoverageIndexManifest | null): string | null {
    if (!previous || previous.sourceRevision !== context.fingerprint || !manifestValidity(previous, context.validity).valid) return null;
    const aggregate: Aggregate = new Map();
    for (const contribution of iterateContributions(context.storeRoot, previous)) foldContribution(aggregate, contribution);
    return coverageSignature(aggregate);
}
function validateStability(context: CoverageIndexContext, selection: Selection, aggregate: Aggregate): void {
    if (!selection.full) return;
    checkIndexStability(context.storeRoot, { fingerprint: context.fingerprint, signature: coverageSignature(aggregate), priorSignature: priorSignature(context, selection.previous) });
}
async function captureSelected(options: IndexedCoverageOptions, selection: Selection, directory: string): Promise<IndexedCoverageResult> {
    const captured = await captureVitestShards({ projectRoot: options.workspace, captureDir: directory, timeoutMs: remainingCoverageTime(options.context.runtime.deadline), environment: options.context.runtime.environment, resourceBudget: options.resourceBudget,
        ...(selection.selected ? { selectedTests: selection.selected } : {}), ...(options.maxWorkers !== undefined ? { maxWorkers: options.maxWorkers } : {}) });
    if (!captured.runResult.ok || captured.runResult.testsPassed !== true || captured.degraded) {
        // Name the shards that failed: a bare "Tests did not pass" sends the operator back to an eight-minute rerun.
        const failed = failedCaptureShards(directory, realpathSync(options.workspace));
        const reason = captured.degraded ?? captured.runResult.error ?? (failed.length ? `Tests did not pass: ${failed.join(", ")}` : "Tests did not pass");
        return { result: captured.runResult, selectedTests: selection.selected, indexed: false, reason };
    }
    try {
        await verifyIndexRuntime(options.context.inventory.root, options.context.runtime, options.workspace, [directory]);
        const { perFile, metrics } = measured(materialize(options, selection, directory));
        return { result: { ...captured.runResult, perFile }, metrics, indexed: true, selectedTests: selection.selected, reason: null,
            ...(options.full && captured.argv ? { artifact: { content: readEvidenceArtifact(join(directory, "coverage", "coverage-final.json")), root: realpathSync(options.workspace), argv: captured.argv } } : {}) };
    } catch (error) { return { result: captured.runResult, indexed: false, selectedTests: selection.selected, reason: error instanceof Error ? error.message : "Index validation failed" }; }
}
export async function runIndexedCoverage(input: IndexedCoverageOptions): Promise<IndexedCoverageResult> {
    const options = { ...input, context: { ...input.context, runtime: { ...input.context.runtime,
        deadline: Math.min(input.context.runtime.deadline, Date.now() + input.timeoutMs) } } };
    await verifyIndexRuntime(options.context.inventory.root, options.context.runtime, options.workspace);
    const selection = await selectShards(options.context, options.full === true);
    if (selection.selected?.length === 0) {
        await verifyIndexRuntime(options.context.inventory.root, options.context.runtime, options.workspace);
        // Nothing re-runs: the accepted aggregate is the retained shards plus the accepted denominator, folded blob by blob.
        const aggregate: Aggregate = new Map();
        if (selection.previous) for (const kept of iterateContributions(options.context.storeRoot, selection.previous, [...selection.retained, DENOMINATORS_SHARD])) foldContribution(aggregate, kept);
        const { perFile, metrics } = measured(aggregate);
        return { result: { ok: true, testsPassed: true, suiteMs: 0, perFile }, metrics, indexed: true, selectedTests: [], reason: null };
    }
    const directory = mkdtempSync(join(options.workspace, ".interlinked-coverage-capture-"));
    try { return await captureSelected(options, selection, directory); }
    finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function coverageIndexStatus(context: CoverageIndexContext): Promise<{ present: boolean; generation: number | null; valid: boolean; reasons: string[]; shards: number; changedShards: number }> {
    await verifyIndexRuntime(context.inventory.root, context.runtime);
    await promoteMatchingProposal(context);
    const manifest = readAcceptedManifest(indexStore(context.storeRoot));
    if (!manifest) return { present: false, generation: null, valid: false, reasons: ["No accepted index"], shards: 0, changedShards: 0 };
    const validity = manifestValidity(manifest, context.validity), entries = Object.values(manifest.shards).filter(entry => entry.shardId !== DENOMINATORS_SHARD);
    // Every blob must be readable; each is dropped as soon as it is checked.
    for (const _contribution of iterateContributions(context.storeRoot, manifest)) { /* readability is the check */ }
    const current = currentDependencies(context);
    const changed = entries.filter(entry => changedShard(current, entry.dependencyHashes)).length;
    const quarantined = indexQuarantined(context.storeRoot, context.fingerprint);
    return { present: true, generation: manifest.generation, valid: validity.valid && changed === 0 && !quarantined, reasons: [...validity.reasons, ...(changed ? [`${changed} stale test shards`] : []), ...(quarantined ? ["Index quarantined for unstable coverage"] : [])], shards: entries.length, changedShards: changed };
}
