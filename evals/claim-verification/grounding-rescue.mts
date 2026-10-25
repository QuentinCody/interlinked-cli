import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JevAnswer, JevNoulQuestion } from "../../src/harness/jev/types.js";
import { redactE20 } from "../../src/harness/jev/decision-shadow-redact.js";
import { evaluateCase, parseCases, type GroundingCase } from "./grounding.mjs";
import { createLoggedClient } from "./eval-client.mjs";

export const shouldRescue = (baseline: boolean | null, grounded: boolean | null) => baseline === true && grounded === false;
export function rescueDecision(answer: JevAnswer | undefined, threshold = 0.9): boolean | null {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("Invalid rescue threshold");
    return answer?.type === "noul" && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1 ? answer.noul >= threshold : null;
}
export function rescueQuestion(item: GroundingCase): JevNoulQuestion {
    return { type: "noul", instructions: { question: "Does the captured execution evidence establish this complete claim?",
        claim: item.claim, receipts: item.evidence.map(r => ({ tool: r.tool, attempted_input: r.input, returned_result: r.result_tail, reported_error: r.error })) },
        criteria: { true: "Returned results jointly establish every factual component and its scope. Inputs identify the operation and target; returned output must confirm its result. A file listing after a write can confirm the file was produced. A document excerpt supports a claim about what that document states.",
            false: "A required fact, completion, scope or exception is missing or contradicted. An attempted command with no completion evidence is insufficient. An agent's own written text does not independently prove the factual claims inside it. Reading a file that says tests passed is not a test-run result. Do not use remembered facts, stated plans or successful unrelated operations as evidence." } };
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Save = (name: string, value: unknown) => void;
type RescueClient = ReturnType<typeof createLoggedClient> | null;
type BaseSummary = Pick<Awaited<ReturnType<typeof evaluateCase>>["summary"], "id" | "baselineSupported" | "groundedSupported">;
interface CachedBaseline { modelRequested: string; cases: BaseSummary[] }

function prepareCases(input: string, output: string) {
    const casesText = readFileSync(input, "utf8"); const cases = parseCases(casesText);
    const thresholdIndex = process.argv.indexOf("--threshold");
    const threshold = thresholdIndex < 0 ? 0.9 : Number(process.argv[thresholdIndex + 1]);
    rescueDecision(undefined, threshold);
    if (redactE20(casesText) !== casesText) throw new Error("Prepare redacted cases before remote evaluation");
    const holdoutIndex = process.argv.indexOf("--holdout");
    const holdout = holdoutIndex < 0 ? null : JSON.parse(readFileSync(process.argv[holdoutIndex + 1]!, "utf8"));
    if (holdout && (holdout.sha256 !== hash(casesText) || !holdout.createdAt || !Number.isFinite(Date.parse(holdout.createdAt))
        || Date.parse(holdout.createdAt) > Date.now())) throw new Error("Holdout manifest does not predate scoring or match cases");
    if (holdout) writeFileSync(`${input}.scored-once`, JSON.stringify({ startedAt: new Date().toISOString(), output, sha256: hash(casesText) }) + "\n", { flag: "wx", mode: 0o600 });
    return { casesText, cases, threshold, holdout };
}

function cachedBaseline(cases: GroundingCase[]) {
    const reuseIndex = process.argv.indexOf("--reuse"); const reuse = reuseIndex < 0 ? null : process.argv[reuseIndex + 1]!;
    if (reuse && hash(JSON.stringify(parseCases(readFileSync(resolve(reuse, "cases.json"), "utf8")))) !== hash(JSON.stringify(cases))) throw new Error("Cached cases differ");
    const cached: CachedBaseline | null = reuse ? JSON.parse(readFileSync(resolve(reuse, "summary.json"), "utf8")) : null;
    if (cached && cached.modelRequested !== "jev-1.13.0") throw new Error("Cached model differs");
    return { reuse, cached };
}

async function scoreRescueCases(cases: GroundingCase[], client: RescueClient, cached: CachedBaseline | null,
    reuse: string | null, threshold: number, save: Save) {
    const summaries = [];
    for (const [index, item] of cases.entries()) {
        const fresh = cached ? null : await evaluateCase(item, client, true);
        const base = cached ? cached.cases.find(r => r.id === item.id) : fresh!.summary;
        if (!base) throw new Error("Cached case missing");
        const eligible = shouldRescue(base.baselineSupported, base.groundedSupported);
        const question = eligible ? rescueQuestion(item) : null;
        const result = client && question ? await client.askDetailed({}, { rescue: question }) : null;
        const rescued = result?.ok ? rescueDecision(result.response.answers.rescue, threshold) : null;
        const supported = eligible ? rescued : base.groundedSupported;
        const summary = { id: item.id, expectedSupport: item.expectedSupport, baselineSupported: base.baselineSupported,
            groundedSupported: base.groundedSupported, rescueEligible: eligible, rescueSupported: rescued, finalSupported: supported };
        save(`case-${index}.json`, { summary, fresh, question, result, cachedFrom: reuse }); summaries.push(summary);
        console.log(JSON.stringify(summary));
        if (client && client.spend().failures >= 3) break;
    }
    return summaries;
}

async function main(): Promise<void> {
    const [input, output] = process.argv.slice(2);
    if (!input || !output) throw new Error("Usage: grounding-rescue.mts CASES NEW_OUTPUT [--reuse BASELINE_DIR] [--jev] [--holdout MANIFEST]");
    const { casesText, cases, threshold, holdout } = prepareCases(input, output);
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const save: Save = (name, value) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const { reuse, cached } = cachedBaseline(cases);
    const live = process.argv.includes("--jev");
    if (live && !process.env.TYPESAFE_API_KEY) throw new Error("Missing TYPESAFE_API_KEY");
    const client = live ? createLoggedClient({ apiKey: process.env.TYPESAFE_API_KEY!, save }) : null;
    save("manifest.json", { createdAt: new Date().toISOString(), casesSha256: hash(casesText), holdout, reuse, model: "jev-1.13.0",
        rescueThreshold: threshold, implementation: readFileSync("evals/claim-verification/grounding-rescue.mts", "utf8"),
        note: "Authored fixtures are development/stress data, never population accuracy estimates. Rescue changes the pipeline, not model semantics." });
    save("cases.json", cases);
    const summaries = await scoreRescueCases(cases, client, cached, reuse, threshold, save);
    save("summary.json", { createdAt: new Date().toISOString(), model: "jev-1.13.0", cases: summaries, spend: client?.spend() ?? null,
        requestedCases: cases.length, unprocessedCaseIds: cases.slice(summaries.length).map(c => c.id), agentSessionCost: "not exposed" });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
