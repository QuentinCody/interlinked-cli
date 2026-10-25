import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractionMetrics, locatedLegacy, type Annotation, type LocatedCandidate } from "./annotation-metrics.mjs";
import { matchedExtractionMetrics, summarizeMatching } from "./claim-matching.mjs";
import { spanCandidates } from "./extractors.mjs";
import { summarizeExtraction } from "./extraction-comparison.mjs";
import { assessTestProvenance, type ProvenanceGraph } from "./provenance-graph.mjs";
import type { TestReceipt } from "./receipt-facts.mjs";

const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const base = "scratch/2026-10-19-claim-verification";
const references = `${base}/reference-snapshot-01`;
const sources = `${base}/goal-run-01/labeling-sources`;
const clairicPath = `${base}/trust-run-01/clairic-extraction/summary.json`;
const receiptPath = `${base}/typed-receipt-01/verification.json`;
const implementationFiles = ["graph-replay.mts", "claim-matching.mts", "annotation-metrics.mts", "extractors.mts",
    "extraction-comparison.mts", "provenance-graph.mts", "receipt-facts.mts"].map(p => `evals/claim-verification/${p}`);
interface SavedReceipt { receipt: TestReceipt; before: Record<string, string>; after: Record<string, string>; sourceStable: boolean }
interface ExtractionRow {
    id: string; session: string; arm: string; containment: Omit<ReturnType<typeof extractionMetrics>, "details">;
    matching: Array<{ threshold: number; metrics: ReturnType<typeof matchedExtractionMetrics> }>;
}
interface ReferenceFile { file: string; sha256: string; sourceSha256: string }

export function replayReceipt(saved: SavedReceipt, current: Record<string, string>) {
    const receipt = saved.receipt;
    const graph: ProvenanceGraph = { nodes: [
        { id: "claim", kind: "claim", text: `All ${receipt.runner!.numTotalTests} executed tests passed.`, interpretation: "explicit",
            scope: { receiptId: receipt.id, sourceIdentity: receipt.sourceIdentity!, selection: receipt.selection! } },
        { id: receipt.id, kind: "receipt", origin: "tool_result", result: receipt },
        { id: "run", kind: "run", completed: true, captureComplete: false, stableDuringRun: null,
            nondeterministic: false, environment: null, selectionIdentity: null },
    ], edges: [
        { id: "citation", from: "claim", to: receipt.id, kind: "cites", basis: "observed" },
        { id: "producer", from: receipt.id, to: "run", kind: "generated_by", basis: "observed" },
    ] };
    for (const [path, sha256] of Object.entries(saved.before)) {
        graph.nodes.push({ id: path, kind: "input", path, sha256, dependenciesComplete: false });
        // Before/after snapshots do not observe which inputs the process actually read.
        graph.edges.push({ id: `possible-use:${path}`, from: "run", to: path, kind: "used", basis: "inferred" });
        if (receipt.selection?.includes(path)) graph.edges.push({ id: `executed:${path}`, from: "run", to: path, kind: "executed", basis: "observed" });
    }
    return { graph, current, assessment: assessTestProvenance(graph, "claim", { files: current, environment: null, selectionIdentity: null }),
        knownChangedInputs: Object.keys(saved.before).filter(path => current[path] !== saved.before[path]),
        captureGaps: ["No complete observed input closure", "No environment or test-discovery identity",
            "Before/after equality does not establish input stability throughout execution"],
        limitations: ["One historical receipt, not live-session coverage or an accuracy estimate.",
            "The claim is constructed from the receipt, with explicit scope; natural-language linkage is not tested."] };
}

function loadFrozenMessages(files: ReferenceFile[], hosted: Map<string, LocatedCandidate[]>) {
    return files.map(file => {
        const annotationPath = `${references}/${file.file}`, sourcePath = `${sources}/${file.file}`;
        const annotation: Annotation = read(annotationPath), source: { id: string; source: string; session: string } = read(sourcePath);
        if (digest(readFileSync(annotationPath)) !== file.sha256 || digest(source.source) !== file.sourceSha256
            || annotation.sourceSha256 !== file.sourceSha256 || source.id !== annotation.id || !hosted.has(source.id)) throw new Error("Frozen corpus identity mismatch");
        return { file, annotation, source, sourceFileSha256: digest(readFileSync(sourcePath)) };
    });
}

function scoreReplayExtraction(messages: ReturnType<typeof loadFrozenMessages>, hosted: Map<string, LocatedCandidate[]>, thresholds: number[]) {
    const rows: ExtractionRow[] = [];
    for (const { annotation, source } of messages) {
        const arms: Record<string, LocatedCandidate[]> = {
            legacy: locatedLegacy(source.source),
            spans: spanCandidates(source.source).map(c => ({ text: c.text, spans: [c.span!] })),
            clairic: hosted.get(source.id)!,
            wholeMessageControl: [{ text: source.source, spans: [[0, source.source.length]] }],
        };
        for (const [arm, candidates] of Object.entries(arms)) {
            const { details: _details, ...containment } = extractionMetrics(source.source, annotation, candidates);
            rows.push({ id: source.id, session: source.session, arm, containment,
                matching: thresholds.map(threshold => ({ threshold, metrics: matchedExtractionMetrics(source.source, annotation, candidates, threshold) })) });
        }
    }
    return rows;
}

function summarizeReplayExtraction(rows: ExtractionRow[], thresholds: number[]) {
    return Object.fromEntries(["legacy", "spans", "clairic", "wholeMessageControl"].map(arm => {
        const selected = rows.filter(r => r.arm === arm);
        return [arm, { containment: summarizeExtraction(selected.map(r => r.containment)),
            matching: Object.fromEntries(thresholds.map(t => [t, summarizeMatching(selected.map(r => r.matching.find(m => m.threshold === t)!.metrics))])) }];
    }));
}

function saveReplayManifest(save: (name: string, value: unknown) => void, messages: ReturnType<typeof loadFrozenMessages>, thresholds: number[]): void {
    const inputPaths = [`${references}/manifest.json`, clairicPath, receiptPath, ...implementationFiles,
        "src/harness/jev/receipt-verifiers.ts", "src/harness/jev/claim-review.ts"];
    // Written before scoring. This is a disclosed retrospective rescore, not a new holdout.
    save("manifest.json", { createdAt: new Date().toISOString(), primaryThreshold: 0.5, sensitivityThresholds: thresholds,
        matching: "Maximum total source-character IoU; one-to-one; core plus qualifiers; UTF-16; whitespace/Markdown ignored.",
        sourceFiles: messages.map(m => ({ sourceFileSha256: m.sourceFileSha256, ...m.file })),
        inputHashes: Object.fromEntries(inputPaths.map(p => [p, digest(readFileSync(p))])),
        apiCalls: 0, apiSpendUsd: 0, node: process.version, icu: process.versions.icu });
}

function main(): void {
    const output = process.argv[2];
    if (!output) throw new Error("Usage: graph-replay.mts NEW_OUTPUT (repository root; saved October 19 artifacts required)");
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const manifest: { files: ReferenceFile[] } = read(`${references}/manifest.json`);
    const prior: { rows: Array<{ id: string; candidates: LocatedCandidate[] }> } = read(clairicPath);
    const hosted = new Map(prior.rows.map(r => [r.id, r.candidates]));
    if (hosted.size !== prior.rows.length) throw new Error("Duplicate saved extraction identity");
    const messages = loadFrozenMessages(manifest.files, hosted);
    const thresholds = [0.25, 0.5, 0.75];
    saveReplayManifest(save, messages, thresholds);
    const rows = scoreReplayExtraction(messages, hosted, thresholds);
    const summaries = summarizeReplayExtraction(rows, thresholds);
    save("extraction.json", { createdAt: new Date().toISOString(), primaryThreshold: 0.5, turns: messages.length, summaries, rows,
        limitations: ["Reused model references, not human ground truth.", "Matching scores depend on claim granularity.",
            "No new model calls, judgments, or frozen-holdout scoring.", "Sensitivity is descriptive; no best threshold is selected."] });
    const saved: SavedReceipt = read(receiptPath);
    const current = Object.fromEntries(Object.keys(saved.before).filter(existsSync).map(p => [p, digest(readFileSync(p))]));
    const replay = replayReceipt(saved, current); save("provenance.json", replay);
    console.log(JSON.stringify({ extraction: Object.fromEntries(Object.entries(summaries).map(([arm, s]) => [arm, {
        old: s.containment.counts.completeRetained, matched: s.matching["0.5"]!.counts,
        rates: s.matching["0.5"]!.rates }])), provenance: replay.assessment, knownChangedInputs: replay.knownChangedInputs }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
