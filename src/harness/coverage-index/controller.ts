import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { captureVitestShards } from "../coverage-shards/vitest.js";
import type { CoverageRunResult } from "../coverage-runner.js";
import { aggregateFiles, replaceShards } from "./aggregate.js";
import { readStrictCapture } from "./captured-elements.js";
import type { CoverageIndexContext } from "./context.js";
import { manifestValidity } from "./invalidation.js";
import { readAcceptedManifest } from "./store.js";
import { indexStore, promoteMatchingProposal, readContributions, stageCoverageIndex } from "./staged-state.js";
import { coverageSignature, denominatorContribution, elementsToCoverage, strictElements } from "./strict-elements.js";
import type { CoverageIndexManifest, ShardCoverageContribution } from "./types.js";
import { containedFile, hashBytes } from "../../lib/metrics/inventory.js";
import { checkIndexStability, indexQuarantined } from "./stability.js";
import { readEvidenceArtifact } from "../../lib/metrics/evidence-store.js";
import { defaultJsTestCommand } from "../coverage-runner-commands.js";

export interface IndexedCoverageOptions { context: CoverageIndexContext; workspace: string; timeoutMs: number; full?: boolean; }
export interface IndexedCoverageResult { result: CoverageRunResult; selectedTests: string[] | undefined; indexed: boolean; reason: string | null; artifact?: { content: string; root: string; argv: string[] }; }
interface Selection { previous: CoverageIndexManifest | null; selected: string[] | undefined; contributions: Map<string, ShardCoverageContribution>; full: boolean; }
function changedShard(context: CoverageIndexContext, hashes: Record<string, string>): boolean {
    const current = new Map(context.inventory.files.map(file => [file.path, file.sha256]));
    return Object.entries(hashes).some(([path, hash]) => current.get(path) !== hash);
}
function selectShards(context: CoverageIndexContext, full: boolean): Selection {
    if (!full && indexQuarantined(context.inventory.root, context.fingerprint)) throw new Error("Coverage index quarantined; run metrics coverage warm to establish stability");
    promoteMatchingProposal(context);
    const previous = readAcceptedManifest(indexStore(context.inventory.root));
    if (full || !previous || !manifestValidity(previous, context.validity).valid) return { previous, selected: undefined, contributions: new Map(), full: true };
    const contributions = readContributions(context.inventory.root, previous), selected: string[] = [];
    for (const entry of Object.values(previous.shards)) {
        if (entry.shardId === "@denominators") continue;
        if (entry.passed !== true || entry.instability.quarantined) throw new Error("Unstable or incomplete shard requires a full warm run");
        if (changedShard(context, entry.dependencyHashes)) selected.push(...entry.testPaths);
    }
    if (!selected.length && previous.sourceRevision !== context.fingerprint) return { previous, selected: undefined, contributions: new Map(), full: true };
    return { previous, selected: [...new Set(selected)].sort(), contributions, full: false };
}
function assertCaptureScope(context: CoverageIndexContext, selected: string[] | undefined, actual: string[]): void {
    const expected = selected ?? context.inventory.files.filter(file => file.role === "test").map(file => file.path);
    if (JSON.stringify([...expected].sort()) !== JSON.stringify([...actual].sort())) throw new Error("Captured test universe differs from discovered/selected tests");
}
function materialize(options: IndexedCoverageOptions, selection: Selection, directory: string): Map<string, ShardCoverageContribution> {
    const root = realpathSync(options.workspace), shards = readStrictCapture(directory, root);
    for (const file of options.context.inventory.files) {
        if (hashBytes(readFileSync(containedFile(root, file.path))) !== file.sha256) throw new Error(`Runner changed measured input: ${file.path}`);
    }
    assertCaptureScope(options.context, selection.selected, shards.flatMap(shard => shard.tests));
    const full = strictElements(JSON.parse(readEvidenceArtifact(join(directory, "coverage", "coverage-final.json"))), root);
    const denominator = denominatorContribution(full);
    const replacements = [...shards.map(shard => shard.contribution), denominator];
    const contributions = replaceShards(selection.contributions, replacements, []).next;
    if (selection.full && coverageSignature(aggregateFiles(contributions.values())) !== coverageSignature(full)) throw new Error("Per-shard aggregate differs from the full coverage report");
    validateStability(options.context, selection, contributions);
    stageCoverageIndex(options.context, [...shards, { contribution: denominator, tests: [], durationMs: 0 }], selection.previous, selection.full);
    return contributions;
}
function validateStability(context: CoverageIndexContext, selection: Selection, contributions: Map<string, ShardCoverageContribution>): void {
    if (!selection.full) return;
    const previous = selection.previous;
    const prior = previous?.sourceRevision === context.fingerprint && manifestValidity(previous, context.validity).valid
        ? coverageSignature(aggregateFiles(readContributions(context.inventory.root, previous).values())) : null;
    checkIndexStability(context.inventory.root, { fingerprint: context.fingerprint, signature: coverageSignature(aggregateFiles(contributions.values())), priorSignature: prior });
}
async function captureSelected(options: IndexedCoverageOptions, selection: Selection, directory: string): Promise<IndexedCoverageResult> {
    const captured = await captureVitestShards({ projectRoot: options.workspace, captureDir: directory, timeoutMs: options.timeoutMs,
        ...(selection.selected ? { selectedTests: selection.selected } : {}) });
    if (!captured.runResult.ok || captured.runResult.testsPassed !== true || captured.degraded) return { result: captured.runResult, selectedTests: selection.selected, indexed: false, reason: captured.degraded ?? captured.runResult.error ?? "Tests did not pass" };
    try {
        const contributions = materialize(options, selection, directory);
        return { result: { ...captured.runResult, perFile: elementsToCoverage(aggregateFiles(contributions.values())) }, indexed: true, selectedTests: selection.selected, reason: null,
            ...(options.full ? { artifact: { content: readEvidenceArtifact(join(directory, "coverage", "coverage-final.json")), root: realpathSync(options.workspace),
                argv: [...defaultJsTestCommand(join(directory, "coverage")), "--coverage.provider=custom", `--coverage.customProviderModule=${join(directory, "capture-provider.mjs")}`] } } : {}) };
    } catch (error) { return { result: captured.runResult, indexed: false, selectedTests: selection.selected, reason: error instanceof Error ? error.message : "Index validation failed" }; }
}
export async function runIndexedCoverage(options: IndexedCoverageOptions): Promise<IndexedCoverageResult> {
    const selection = selectShards(options.context, options.full === true);
    if (selection.selected?.length === 0) return { result: { ok: true, testsPassed: true, suiteMs: 0, perFile: elementsToCoverage(aggregateFiles(selection.contributions.values())) }, indexed: true, selectedTests: [], reason: null };
    const directory = mkdtempSync(join(options.workspace, ".interlinked-coverage-capture-"));
    try { return await captureSelected(options, selection, directory); }
    finally { rmSync(directory, { recursive: true, force: true }); }
}

export function coverageIndexStatus(context: CoverageIndexContext): { present: boolean; generation: number | null; valid: boolean; reasons: string[]; shards: number; changedShards: number } {
    promoteMatchingProposal(context);
    const manifest = readAcceptedManifest(indexStore(context.inventory.root));
    if (!manifest) return { present: false, generation: null, valid: false, reasons: ["No accepted index"], shards: 0, changedShards: 0 };
    const validity = manifestValidity(manifest, context.validity), entries = Object.values(manifest.shards).filter(entry => entry.shardId !== "@denominators");
    readContributions(context.inventory.root, manifest);
    const changed = entries.filter(entry => changedShard(context, entry.dependencyHashes)).length;
    const quarantined = indexQuarantined(context.inventory.root, context.fingerprint);
    return { present: true, generation: manifest.generation, valid: validity.valid && changed === 0 && !quarantined, reasons: [...validity.reasons, ...(changed ? [`${changed} stale test shards`] : []), ...(quarantined ? ["Index quarantined for unstable coverage"] : [])], shards: entries.length, changedShards: changed };
}
