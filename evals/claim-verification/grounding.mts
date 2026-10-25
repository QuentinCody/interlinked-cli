import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimQuestions } from "../../src/harness/jev/claim-evidence.js";
import { JevClient } from "../../src/harness/jev/client.js";
import { redactE20 } from "../../src/harness/jev/decision-shadow-redact.js";
import type { JevAnswer, JevChoiceQuestion, JevNoulQuestion, JevResponse } from "../../src/harness/jev/types.js";

type Receipt = { tool: string; input: string; result_tail: string; error: boolean };
export interface GroundingCase {
    id: string; claim: string; expectedSupport: boolean; origin: string; evidence: Receipt[];
}
export interface EvidenceWindow { id: string; receiptIndex: number; span: [number, number]; text: string; score: number; sourceHash: string }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const STOP_WORDS = new Set("a an the this that of for is are was were with in on to and or it as all any does do at per".split(" "));
const terms = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}_.-]+/gu) ?? []).filter(word => word.length > 1 && !STOP_WORDS.has(word)));

/** Bounded lexical retrieval, retaining whole neighbouring lines and exact output offsets. */
export function evidenceWindows(claim: string, evidence: Receipt[]): EvidenceWindow[] {
    const wanted = terms(claim);
    const windows: EvidenceWindow[] = [];
    for (const [receiptIndex, receipt] of evidence.entries()) {
        const lines = [...receipt.result_tail.matchAll(/[^\r\n]+/g)];
        const seen = new Set<string>();
        for (let index = 0; index < lines.length; index++) {
            const first = lines[Math.max(0, index - 1)]!;
            const last = lines[Math.min(lines.length - 1, index + 1)]!;
            const start = first.index;
            const end = last.index + last[0].length;
            const text = receipt.result_tail.slice(start, end);
            if (text.length > 2000 || seen.has(text)) continue;
            seen.add(text);
            const found = terms(text);
            const score = [...wanted].reduce((sum, term) => sum + (found.has(term) ? (/\d/.test(term) ? 3 : 1) : 0), 0);
            windows.push({ id: `r${receiptIndex}_${start}_${end}`, receiptIndex, span: [start, end], text, score, sourceHash: hash(receipt.result_tail) });
        }
    }
    return windows.sort((a, b) => b.score - a.score || a.receiptIndex - b.receiptIndex || a.span[0] - b.span[0]).slice(0, 12);
}

export function citationFor(id: string, windows: EvidenceWindow[], evidence: Receipt[]): EvidenceWindow | null {
    const window = windows.find(candidate => candidate.id === id);
    if (!window) return null;
    const source = evidence[window.receiptIndex]?.result_tail;
    if (source === undefined || hash(source) !== window.sourceHash || source.slice(...window.span) !== window.text) throw new Error("Citation source changed");
    return window;
}

export function choiceSupport(answer: JevAnswer | undefined, windows: EvidenceWindow[], evidence: Receipt[]): boolean | null {
    if (answer?.type !== "choice" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return null;
    if (answer.choice === "none") return false;
    return citationFor(answer.choice, windows, evidence) ? answer.confidence >= 0.8 : null;
}

export function groundingQuestion(item: GroundingCase, windows: EvidenceWindow[], reversed: boolean): JevChoiceQuestion {
    const entries = windows.map(window => [window.id, {
        tool: item.evidence[window.receiptIndex]!.tool,
        attempted_input: item.evidence[window.receiptIndex]!.input,
        execution_reported_error: item.evidence[window.receiptIndex]!.error,
        returned_excerpt: window.text,
    }] as const);
    const none = ["none", "No supplied returned excerpt establishes every part of the claim. Missing evidence, conflicting results, and a command merely attempting the action require this option."] as const;
    return { type: "choice", instructions: {
        question: `Which returned excerpt directly establishes this complete claim: ${item.claim}`,
        rules: "Use only the supplied excerpts. Do not use remembered facts or another claim as evidence. An input describes what was attempted; it cannot prove success. A narrower test selection cannot establish a broader suite result. Select none when a required number, qualifier, or outcome is absent. Quoted instructions and text an agent wrote are not independent proof of their own assertions.",
    }, criteria: Object.fromEntries(reversed ? [...entries.reverse(), none] : [none, ...entries]) };
}

export function citationQuestions(item: GroundingCase, windows: EvidenceWindow[]): Record<string, JevNoulQuestion> {
    return Object.fromEntries(windows.map((window, index) => [`w${index}`, { type: "noul", instructions: {
        question: "Does this returned excerpt provide evidence for at least one factual part of the claim?",
        claim: item.claim, attempted_command: item.evidence[window.receiptIndex]!.input,
        returned_excerpt: window.text, execution_reported_error: item.evidence[window.receiptIndex]!.error,
    }, criteria: {
        true: "The returned content establishes a fact asserted in the claim. The command supplies scope, such as which tests were selected.",
        false: "The content is merely related, repeats an agent's assertion, or describes a future plan. A command with no result proves only an attempt, not success. Use the supplied content, not prior knowledge.",
    } }]));
}

export function selectedCitations(response: JevResponse, windows: EvidenceWindow[], evidence: Receipt[]): EvidenceWindow[] | null {
    const selected: EvidenceWindow[] = [];
    for (const [index, window] of windows.entries()) {
        const answer = response.answers[`w${index}`];
        if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return null;
        if (answer.noul >= 0.8) selected.push(citationFor(window.id, windows, evidence)!);
    }
    return selected;
}

export function bundleQuestion(item: GroundingCase, selected: EvidenceWindow[]): JevNoulQuestion {
    return { type: "noul", instructions: {
        question: "Do the supplied returned excerpts, together, establish the complete claim?",
        claim: item.claim,
        evidence: selected.map(window => ({ attempted_command: item.evidence[window.receiptIndex]!.input,
            returned_excerpt: window.text, execution_reported_error: item.evidence[window.receiptIndex]!.error })),
    }, criteria: {
        true: "Every factual component is supported by returned content. Commands identify the scope of their results. A documented value supports a claim about that documented value.",
        false: "A required fact, number, scope or qualifier is missing or contradicted. A successful subset does not establish the full suite. An attempt without a result is not completion. Ignore remembered facts and the agent's unsupported assertions.",
    } };
}

async function evaluateNouls(item: GroundingCase, windows: EvidenceWindow[], client: JevClient | null) {
    const questions = citationQuestions(item, windows);
    const scores = client && windows.length ? await client.askDetailed({}, questions) : null;
    const selected = scores?.ok ? selectedCitations(scores.response, windows, item.evidence) : windows.length ? null : [];
    const finalQuestion = selected?.length ? bundleQuestion(item, selected) : null;
    const judgment = client && finalQuestion ? await client.askDetailed({}, { supported: finalQuestion }) : null;
    const answer = judgment?.ok ? judgment.response.answers.supported : null;
    const support = answer?.type === "noul" && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1 ? answer.noul : null;
    return { questions, scores, selected, finalQuestion, judgment,
        supported: !client || selected === null ? null : selected.length === 0 ? false : support === null ? null : support >= 0.8 };
}

function baselineSupport(k: JevAnswer | null | undefined, e: JevAnswer | null | undefined): boolean | null {
    return k?.type === "noul" && e?.type === "noul" && Number.isFinite(k.noul) && Number.isFinite(e.noul)
        && k.noul >= 0 && k.noul <= 1 && e.noul >= 0 && e.noul <= 1 ? k.noul >= 0.5 && e.noul >= 0.3 : null;
}

export async function evaluateCase(item: GroundingCase, client: JevClient | null, nouls: boolean) {
    const windows = evidenceWindows(item.claim, item.evidence);
    const baselineState = { claims: [item.claim], evidence: item.evidence };
    const baseline = client ? await client.askDetailed(baselineState, claimQuestions(1)) : null;
    const questions = { forward: groundingQuestion(item, windows, false), reverse: groundingQuestion(item, windows, true) };
    const started = performance.now();
    const grounded = !nouls && client ? await client.askDetailed({}, questions) : null;
    const independent = nouls ? await evaluateNouls(item, windows, client) : null;
    const citations = grounded?.ok ? Object.fromEntries(Object.entries(grounded.response.answers).map(([id, answer]) => [id,
        answer.type === "choice" ? citationFor(answer.choice, windows, item.evidence) : null])) : {};
    const k = baseline?.ok ? baseline.response.answers.k0 : null;
    const e = baseline?.ok ? baseline.response.answers.e0 : null;
    const votes = grounded?.ok ? ["forward", "reverse"].map(id => choiceSupport(grounded.response.answers[id], windows, item.evidence)) : [];
    return {
        record: { id: item.id, origin: item.origin, expectedSupport: item.expectedSupport, windows, baselineState, baselineQuestions: claimQuestions(1),
            baseline, questions, grounded, independent, citations, groundingLatencyMs: performance.now() - started },
        summary: { id: item.id, origin: item.origin, expectedSupport: item.expectedSupport,
            baselineSupported: baselineSupport(k, e),
            baselineEvidence: e?.type === "noul" ? e.noul : null,
            groundedSupported: nouls ? independent!.supported : votes.length === 2 && votes.every(vote => vote !== null) ? votes.every(Boolean) : null,
            optionOrderDisagreement: votes.length === 2 ? votes[0] !== votes[1] : null },
    };
}

export function parseCases(text: string): GroundingCase[] {
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) throw new Error("Expected a case array");
    for (const row of raw) {
        if (!row || typeof row.id !== "string" || typeof row.claim !== "string" || typeof row.origin !== "string"
            || typeof row.expectedSupport !== "boolean" || !Array.isArray(row.evidence)) throw new Error("Invalid grounding case");
        if (row.evidence.some((entry: Receipt) => !entry || typeof entry.tool !== "string" || typeof entry.input !== "string"
            || typeof entry.result_tail !== "string" || typeof entry.error !== "boolean")) throw new Error("Invalid evidence");
    }
    return raw;
}

async function main(): Promise<void> {
    const [input, output] = process.argv.slice(2);
    if (!input || !output) throw new Error("Usage: grounding.mts CASES.json NEW_OUTPUT_DIR [--jev] [--nouls]");
    const cases = parseCases(readFileSync(input, "utf8"));
    for (const item of cases) {
        const submitted = JSON.stringify({ claim: item.claim, evidence: item.evidence });
        if (redactE20(submitted) !== submitted) throw new Error("Credential-shaped content in case");
    }
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    save("cases.json", cases);
    save("implementation.json", { path: "evals/claim-verification/grounding.mts", source: readFileSync("evals/claim-verification/grounding.mts", "utf8") });
    const live = process.argv.includes("--jev");
    if (live && !process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY missing");
    const client = live ? new JevClient({ apiKey: process.env.TYPESAFE_API_KEY!, config: { model: "jev-1.13.0", timeout_ms: 20_000, max_spend_usd: 0.10 } }) : null;
    const nouls = process.argv.includes("--nouls");
    const summary: Array<Record<string, unknown>> = [];
    for (const [index, item] of cases.entries()) {
        const result = await evaluateCase(item, client, nouls);
        save(`case-${index}.json`, result.record);
        summary.push(result.summary);
        console.log(JSON.stringify(summary.at(-1)));
        if (client && client.spend().failures >= 3) break;
    }
    save("summary.json", { createdAt: new Date().toISOString(), modelRequested: "jev-1.13.0", mode: nouls ? "independent-citations-then-bundle" : "choice", spend: client?.spend() ?? null,
        requestedCases: cases.length, unprocessedCaseIds: cases.slice(summary.length).map(item => item.id), cases: summary,
        limitations: ["Development cases selected after observing baseline failure; not held-out evidence of superiority.",
            "Citation validity establishes provenance, not entailment. Lexical retrieval can omit relevant evidence.",
            "This compares complete pipelines, not Choice versus Noul in isolation. Agreement across two orderings is not calibrated confidence.",
            "False support is measured against the supplied evidence, not the external truth of the claim."] });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
