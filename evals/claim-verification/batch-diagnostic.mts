import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimQuestions } from "../../src/harness/jev/claim-evidence.js";
import { redactE20 } from "../../src/harness/jev/decision-shadow-redact.js";
import { makeCells, summarizeCell, type DiagnosticCase } from "./diagnostic.mjs";
import { validateAnnotation, type Annotation, type Span } from "./annotation-metrics.mjs";
import { createLoggedClient } from "./eval-client.mjs";

interface Receipt { id: string; tool: string; input: string; result_tail: string; error: boolean; structuredResult?: unknown }
export interface FrozenEvidence {
    id: string; receipts: Receipt[];
    operationalEvidence: Array<{ name: string; input: string; result: string; is_error: boolean }>;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function mergedSpans(spans: Span[]): Span[] {
    const result: Span[] = [];
    for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
        const last = result.at(-1);
        if (last && s <= last[1]) last[1] = Math.max(last[1], e);
        else result.push([s, e]);
    }
    return result;
}

export function buildDiagnosticCase(source: string, annotation: Annotation, evidence: FrozenEvidence): DiagnosticCase {
    const selected = new Set(annotation.claims.flatMap(c => c.evidenceIds.curated));
    return { id: annotation.id, source, sourceIdentity: annotation.sourceSha256, annotation: `model-adjudicated:${annotation.annotator}`,
        targets: annotation.claims.map(c => ({ id: c.id, spans: mergedSpans([...c.spans, ...c.qualifiers.flatMap(q => q.spans)]),
            expectedSupport: c.labels.curated === "supported", expectedByEvidence: {
                operational: c.labels.operational === "supported", curated: c.labels.curated === "supported" },
            rationale: c.rationale.curated, evidenceIds: c.evidenceIds.curated })),
        operationalEvidence: evidence.operationalEvidence.map(r => ({ tool: r.name, input: r.input, result_tail: r.result, error: r.is_error })),
        curatedEvidence: evidence.receipts.filter(r => selected.has(r.id)).map(r => ({ tool: r.tool, input: r.input, error: r.error,
            result_tail: r.result_tail + (r.structuredResult === undefined ? "" : `\nSTRUCTURED_RETURNED_RESULT:\n${JSON.stringify(r.structuredResult)}`) })),
    };
}

interface Outcome { target: string; status: string; supported?: boolean }
export function summarizeReference(annotation: Annotation, snapshot: "operational" | "curated", outcomes: Outcome[]) {
    const counts = { claims: annotation.claims.length, referenceSupported: 0, referenceContradictions: 0,
        referenceUnsupported: 0, notAssessable: 0, extractionFailure: 0, notMeasured: 0, checkabilityFiltered: 0,
        trueEndorsements: 0, falseEndorsements: 0, correctNonEndorsements: 0, missedSupport: 0, endorsementsWithoutAssessableReference: 0 };
    for (const claim of annotation.claims) {
        const label = claim.labels[snapshot]; const outcome = outcomes.find(r => r.target === claim.id);
        if (label === "supported") counts.referenceSupported++;
        if (label === "contradicted") counts.referenceContradictions++;
        if (label === "unsupported") counts.referenceUnsupported++;
        if (label === "not_assessable") counts.notAssessable++;
        if (outcome?.status === "extraction_failure") { counts.extractionFailure++; continue; }
        if (!outcome || outcome.status === "not_measured") { counts.notMeasured++; continue; }
        if (outcome.status === "checkability_filtered") { counts.checkabilityFiltered++; continue; }
        if (label === "not_assessable") {
            if (outcome.supported === true) counts.endorsementsWithoutAssessableReference++;
        } else if (outcome.supported === true) {
            if (label === "supported") counts.trueEndorsements++; else counts.falseEndorsements++;
        } else if (outcome.supported === false) {
            if (label === "supported") counts.missedSupport++; else counts.correctNonEndorsements++;
        }
    }
    return counts;
}

type SaveOutput = (name: string, data: unknown) => void;

function loadDiagnosticSource(file: string, annotationDir: string, sourceDir: string) {
    const source = JSON.parse(readFileSync(resolve(sourceDir, file), "utf8"));
    const annotation: Annotation = JSON.parse(readFileSync(resolve(annotationDir, file), "utf8"));
    const evidenceFile = file === "c28e9a81-158.json" ? file.replace(".json", "-evidence-v2.json") : file.replace(".json", "-evidence.json");
    const evidence: FrozenEvidence = JSON.parse(readFileSync(resolve(sourceDir, evidenceFile), "utf8"));
    if (source.id !== annotation.id || evidence.id !== annotation.id) throw new Error("Turn identity mismatch");
    validateAnnotation(annotation, source.source, new Set(evidence.receipts.map(r => r.id)), evidence.operationalEvidence.length,
        new Set(evidence.receipts.slice(-evidence.operationalEvidence.length).map(r => r.id)));
    return { source, annotation, evidenceFile, evidence };
}

async function runDiagnosticCell(item: DiagnosticCase, annotation: Annotation, cell: ReturnType<typeof makeCells>[number], client: ReturnType<typeof createLoggedClient> | null, save: SaveOutput) {
    const original = JSON.stringify(cell.state); const submitted = redactE20(original);
    const safeCell = { ...cell, state: JSON.parse(submitted) as typeof cell.state };
    const result = client && safeCell.state.claims.length ? await client.askDetailed(safeCell.state, claimQuestions(safeCell.state.claims.length)) : null;
    const outcomes = summarizeCell(item, cell, result?.ok ? result.response : null);
    const redactedClaims = cell.state.claims.flatMap((c, i) => c !== safeCell.state.claims[i] ? [i] : []);
    for (const outcome of outcomes) if (outcome.candidateIndexes.some(i => redactedClaims.includes(i))) outcome.status = "not_measured";
    const summary = { id: item.id, extractor: cell.extractor, evidence: cell.evidence,
        status: result?.ok ? "completed" : result?.error ?? "not_run", redacted: original !== submitted,
        counts: summarizeReference(annotation, cell.evidence, outcomes) };
    save(`${item.id}-${cell.extractor}-${cell.evidence}.json`, { ...summary, state: safeCell.state, result, outcomes });
    return summary;
}

function diagnosticManifest(sourceDir: string, files: string[]) {
    return { createdAt: new Date().toISOString(), model: "jev-1.13.0", authority: "model-adjudicated reference labels",
        longContext: true, sources: files.map(name => ({ name, sha256: hash(readFileSync(resolve(sourceDir, name), "utf8")) })),
        implementation: ["batch-diagnostic.mts", "diagnostic.mts", "annotation-metrics.mts"].map(name => ({ name,
            source: readFileSync(resolve("evals/claim-verification", name), "utf8") })),
        note: "Curated snapshot is the union of reference-cited whole receipts, including structured results. Same snapshot in both extraction cells. Binary non-endorsement is not confirmed contradiction." };
}

async function main(): Promise<void> {
    const [annotationDir, sourceDir, output] = process.argv.slice(2);
    if (!annotationDir || !sourceDir || !output) throw new Error("Usage: batch-diagnostic.mts ANNOTATIONS SOURCES NEW_OUTPUT [--jev]");
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const save = (name: string, data: unknown) => writeFileSync(resolve(output, name), JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const files = readdirSync(sourceDir).filter(n => n.endsWith(".json") && !n.includes("-evidence"));
    const live = process.argv.includes("--jev");
    if (live && !process.env.TYPESAFE_API_KEY) throw new Error("Missing TYPESAFE_API_KEY");
    const client = live ? createLoggedClient({ apiKey: process.env.TYPESAFE_API_KEY!, save }) : null;
    const summaries: unknown[] = []; const exclusions: unknown[] = [];
    save("manifest.json", diagnosticManifest(sourceDir, files));
    for (const file of files.sort()) {
        const { source, annotation, evidenceFile, evidence } = loadDiagnosticSource(file, annotationDir, sourceDir);
        if (!evidence.receipts.length) { exclusions.push({ id: source.id, reason: "curated_receipts_not_recovered" }); continue; }
        const item = buildDiagnosticCase(source.source, annotation, evidence);
        save(`${source.id}-snapshot.json`, { annotation, item, evidenceSourceSha256: hash(readFileSync(resolve(sourceDir, evidenceFile), "utf8")) });
        for (const cell of makeCells(item)) {
            const summary = await runDiagnosticCell(item, annotation, cell, client, save);
            summaries.push(summary); console.log(JSON.stringify({ id: source.id, extractor: cell.extractor, evidence: cell.evidence, status: summary.status }));
        }
        if (client && client.spend().failures >= 3) break;
    }
    save("summary.json", { createdAt: new Date().toISOString(), requestedTurns: files.length, exclusions, cells: summaries,
        spend: client?.spend() ?? null, agentSessionCost: "not exposed", model: "jev-1.13.0" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
