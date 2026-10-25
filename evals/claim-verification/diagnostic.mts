import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAIM_CHECKABLE_MIN, CLAIM_EVIDENCED_MIN, claimQuestions } from "../../src/harness/jev/claim-evidence.js";
import { JevClient, type JevAskResult } from "../../src/harness/jev/client.js";
import { redactE20 } from "../../src/harness/jev/decision-shadow-redact.js";
import type { JevResponse } from "../../src/harness/jev/types.js";
import { legacyCandidates, normalize } from "./extractors.mjs";

type Span = [number, number];
type Receipt = { tool: string; input: string; result_tail: string; error: boolean };
export interface DiagnosticCase {
    id: string;
    source: string;
    sourceIdentity: string;
    annotation: string;
    targets: Array<{ id: string; spans: Span[]; expectedSupport: boolean; rationale: string; evidenceIds: string[];
        expectedByEvidence?: { operational: boolean; curated: boolean } }>;
    operationalEvidence: Receipt[];
    curatedEvidence: Receipt[];
}
interface Cell {
    extractor: "legacy" | "manual";
    evidence: "operational" | "curated";
    state: { claims: string[]; evidence: Receipt[] };
}

export function sourcePassage(source: string, spans: Span[]): string {
    if (!spans.length) throw new Error("A target requires at least one source span");
    return spans.map(([start, end]) => {
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length) throw new Error("Invalid source span");
        return source.slice(start, end);
    }).join("\n");
}

/** The submitted state contains no annotations, expected answers or target-to-evidence links. */
export function makeCells(item: DiagnosticCase): Cell[] {
    const candidates = { legacy: legacyCandidates(item.source).map(candidate => candidate.text),
        manual: item.targets.map(target => sourcePassage(item.source, target.spans)) };
    const cells: Cell[] = [];
    for (const extractor of ["legacy", "manual"] as const) {
        for (const evidence of ["operational", "curated"] as const) cells.push({ extractor, evidence,
            state: { claims: candidates[extractor], evidence: evidence === "operational" ? item.operationalEvidence : item.curatedEvidence } });
    }
    return cells;
}

function probability(response: JevResponse, id: string): number | null {
    const value = response.answers[id];
    return value?.type === "noul" && Number.isFinite(value.noul) && value.noul >= 0 && value.noul <= 1 ? value.noul : null;
}

interface TargetResult {
    target: string; expectedSupport: boolean; candidateIndexes: number[];
    status: "extraction_failure" | "not_measured" | "judged" | "checkability_filtered";
    scores?: Array<{ checkable: number | null; evidenced: number | null }>;
    correctSupport?: boolean; supported?: boolean;
}
export function summarizeCell(item: DiagnosticCase, cell: Cell, response: JevResponse | null): TargetResult[] {
    return item.targets.map((target, targetIndex) => {
        const indexes = cell.extractor === "manual" ? [targetIndex] : target.spans.map(span => {
            const text = normalize(sourcePassage(item.source, [span]));
            return cell.state.claims.findIndex(claim => normalize(claim).includes(text));
        });
        const expectedSupport = target.expectedByEvidence?.[cell.evidence] ?? target.expectedSupport;
        const base = { target: target.id, expectedSupport, candidateIndexes: [...new Set(indexes)] };
        if (indexes.some(index => index < 0)) return { ...base, status: "extraction_failure" };
        if (!response) return { ...base, status: "not_measured" };
        const scores = [...new Set(indexes)].map(index => ({ checkable: probability(response, `k${index}`), evidenced: probability(response, `e${index}`) }));
        if (scores.some(score => score.checkable === null || score.evidenced === null)) return { ...base, status: "not_measured", scores };
        const checkable = scores.every(score => score.checkable! >= CLAIM_CHECKABLE_MIN);
        const supported = scores.every(score => score.evidenced! >= CLAIM_EVIDENCED_MIN);
        return { ...base, status: checkable ? "judged" : "checkability_filtered", scores,
            correctSupport: checkable && supported === expectedSupport, supported };
    });
}

function blocksAt(source: string[], line: number): Array<Record<string, unknown>> {
    const text = source[line - 1];
    if (!text) throw new Error("Evidence source line missing");
    const row = JSON.parse(text);
    if (!Array.isArray(row?.message?.content)) throw new Error("Evidence source blocks missing");
    return row.message.content.filter((block: unknown) => typeof block === "object" && block !== null && !Array.isArray(block));
}

/** Resolve previously audited native source references, checking both sides of the join. */
export function receiptAt(source: string, reference: { id: string; line: number; resultLine: number }): Receipt {
    const lines = source.split("\n");
    const call = blocksAt(lines, reference.line).find(block => block.type === "tool_use" && block.id === reference.id);
    const result = blocksAt(lines, reference.resultLine).find(block => block.type === "tool_result" && block.tool_use_id === reference.id);
    if (!call || !result || typeof call.name !== "string") throw new Error("Receipt identity mismatch");
    const input = call.input;
    const key = call.name === "Bash" ? "command" : "file_path";
    const direct: unknown = typeof input === "object" && input !== null ? Reflect.get(input, key) : null;
    const output = typeof result.content === "string" ? result.content : Array.isArray(result.content)
        ? result.content.map(block => typeof block?.text === "string" ? block.text : "").join("\n") : null;
    if (output === null) throw new Error("Receipt output unsupported");
    return { tool: call.name, input: typeof direct === "string" ? direct : JSON.stringify(input ?? {}), result_tail: output, error: result.is_error === true };
}

interface CellResult {
    extractor: Cell["extractor"]; evidence: Cell["evidence"]; status: string;
    state: Cell["state"]; result?: JevAskResult; latencyMs?: number;
    targets: ReturnType<typeof summarizeCell>;
}
export async function runCells(item: DiagnosticCase, client: JevClient | null): Promise<CellResult[]> {
    const results: CellResult[] = [];
    for (const cell of makeCells(item)) {
        if (!cell.state.claims.length || !client) {
            results.push({ ...cell, status: cell.state.claims.length ? "not_run" : "no_candidates", targets: summarizeCell(item, cell, null) });
            continue;
        }
        const started = performance.now();
        const result = await client.askDetailed(cell.state, claimQuestions(cell.state.claims.length));
        results.push({ ...cell, status: result.ok ? "completed" : result.error, result, latencyMs: performance.now() - started,
            targets: summarizeCell(item, cell, result.ok ? result.response : null) });
    }
    return results;
}

function parseCase(text: string): DiagnosticCase {
    const value = JSON.parse(text);
    if (!value || typeof value.id !== "string" || typeof value.source !== "string" || typeof value.sourceIdentity !== "string"
        || typeof value.annotation !== "string" || !Array.isArray(value.targets) || !value.targets.length) throw new Error("Invalid diagnostic case");
    for (const target of value.targets) {
        if (!target || typeof target.id !== "string" || typeof target.expectedSupport !== "boolean" || typeof target.rationale !== "string"
            || !Array.isArray(target.evidenceIds) || target.evidenceIds.some((id: unknown) => typeof id !== "string")
            || !Array.isArray(target.spans) || target.spans.some((span: unknown) => !Array.isArray(span) || span.length !== 2)) throw new Error("Invalid target");
        sourcePassage(value.source, target.spans);
        if (target.expectedByEvidence !== undefined && (typeof target.expectedByEvidence?.operational !== "boolean"
            || typeof target.expectedByEvidence?.curated !== "boolean")) throw new Error("Invalid evidence-specific labels");
    }
    for (const receipts of [value.operationalEvidence, value.curatedEvidence]) {
        if (!Array.isArray(receipts) || receipts.some(row => !row || typeof row.tool !== "string" || typeof row.input !== "string"
            || typeof row.result_tail !== "string" || typeof row.error !== "boolean")) throw new Error("Invalid receipt");
    }
    if (new Set(value.targets.map((target: { id: string }) => target.id)).size !== value.targets.length) throw new Error("Duplicate target ID");
    return value;
}

function summarizeRunCell(row: Awaited<ReturnType<typeof runCells>>[number]) {
    return { extractor: row.extractor, evidence: row.evidence,
        status: row.status, targets: row.targets.length, correctSupport: row.targets.filter(target => target.correctSupport).length,
        confirmedSupported: row.targets.filter(target => target.correctSupport && target.supported).length,
        falseSupported: row.targets.filter(target => target.status === "judged" && target.supported && !target.expectedSupport).length,
        extractionFailures: row.targets.filter(target => target.status === "extraction_failure").length,
        checkabilityFiltered: row.targets.filter(target => target.status === "checkability_filtered").length,
        notMeasured: row.targets.filter(target => target.status === "not_measured").length };
}

async function main(): Promise<void> {
    const input = process.argv[2];
    const output = process.argv[3];
    if (!input || !output) throw new Error("Usage: diagnostic.mts CASE.json NEW_OUTPUT_DIR [--jev]");
    const source = readFileSync(input, "utf8");
    const item = parseCase(source);
    for (const cell of makeCells(item)) {
        const submitted = JSON.stringify(cell.state);
        if (redactE20(submitted) !== submitted) throw new Error("Credential-shaped content found; prepare a redacted case before remote evaluation");
    }
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const live = process.argv.includes("--jev");
    if (live && !process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY missing");
    const client = live ? new JevClient({ apiKey: process.env.TYPESAFE_API_KEY!, config: { model: "jev-1.13.0", timeout_ms: 20_000, max_spend_usd: 0.10 } }) : null;
    save("case.json", item);
    save("manifest.json", { createdAt: new Date().toISOString(), sourceSha256: createHash("sha256").update(source).digest("hex"),
        model: "jev-1.13.0", checkableThreshold: CLAIM_CHECKABLE_MIN, evidencedThreshold: CLAIM_EVIDENCED_MIN,
        questions: makeCells(item).map(cell => ({ extractor: cell.extractor, evidence: cell.evidence, questions: claimQuestions(cell.state.claims.length) })),
        implementations: ["evals/claim-verification/diagnostic.mts", "evals/claim-verification/extractors.mts", "src/harness/jev/claim-evidence.ts"].map(path => ({ path, source: readFileSync(path, "utf8") })),
        limitation: "Agent-authored development targets; neither complete message annotation nor independent ground truth. Low support is not a contradiction verdict." });
    const results = await runCells(item, client);
    save("results.json", results);
    const summary = { id: item.id, spend: client?.spend() ?? null, cells: results.map(summarizeRunCell) };
    save("summary.json", summary);
    console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
