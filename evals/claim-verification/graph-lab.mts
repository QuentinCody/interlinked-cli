import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDecisionClient, type DecisionClient } from "./decision-eval-client.mjs";
import { provenanceCases, extractionCases, instructionCases, documentationCases } from "./graph-lab-fixtures.mjs";
import { evaluateProvenance, evaluateExtraction, evaluateInstructions, evaluateDocumentation, supportMetrics } from "./graph-lab-evaluate.mjs";
import { summarizeMatching } from "./claim-matching.mjs";

type ProvenanceResult = Awaited<ReturnType<typeof evaluateProvenance>>[number];
export function summarizeCore(_domain: "provenance", rows: Array<Pick<ProvenanceResult, "split" | "expected" | "graphLexical" | "graphOracle" | "rawP" | "graphP" | "graphThenLinkedVerifier">>) {
    return Object.fromEntries(["development", "holdout"].map(split => {
        const selected = rows.filter(r => r.split === split);
        return [split, Object.fromEntries(["raw", "graph", "lexicalGraph", "oracleGraph", "modelLinkVerifier"].map(arm => [arm,
            supportMetrics(selected.map(r => ({ expected: r.expected, predicted: arm === "raw" ? r.rawP >= 0.9 : arm === "graph" ? r.graphP >= 0.9
                : arm === "lexicalGraph" ? r.graphLexical : arm === "oracleGraph" ? r.graphOracle : r.graphThenLinkedVerifier })))]))];
    })) as Record<"development" | "holdout", Record<string, ReturnType<typeof supportMetrics>>>;
}
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
function accuracy(rows: Array<Record<string, unknown>>, fields: string[]) {
    return Object.fromEntries(["development", "holdout"].map(split => {
        const selected = rows.filter(r => r.split === split);
        return [split, Object.fromEntries(fields.map(arm => [arm, { correct: selected.filter(r => r[arm] === r.expected).length, count: selected.length }]))];
    }));
}
export function modelToken(model: "jev-1.13.0" | "clef-flash"): string {
    if (model === "jev-1.13.0") return process.env.TYPESAFE_API_KEY ?? "";
    return process.env.CLOUDFLARE_API_TOKEN ?? execFileSync("python3", ["-c",
        "import pathlib,tomllib;print(tomllib.loads((pathlib.Path.home()/'.cf/config.toml').read_text())['access_token'])"], { encoding: "utf8" }).trim();
}
/** The caller chooses the destination account; a source checkout never supplies its author's account. */
export function modelAccount(model: "jev-1.13.0" | "clef-flash", env: NodeJS.ProcessEnv = process.env): string {
    if (model === "jev-1.13.0") return "";
    const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error("CLOUDFLARE_ACCOUNT_ID must name the target Cloudflare account");
    return account;
}
export function outputWriter(output: string) {
    mkdirSync(output, { recursive: true, mode: 0o700 });
    return (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

interface CoreCases {
    provenance: ReturnType<typeof provenanceCases>; extraction: ReturnType<typeof extractionCases>;
    instructions: ReturnType<typeof instructionCases>; documentation: ReturnType<typeof documentationCases>;
}
type Model = "jev-1.13.0" | "clef-flash";

function preregisterCore(save: ReturnType<typeof outputWriter>, models: Model[], cases: CoreCases): void {
    const sources = ["graph-lab", "graph-lab-core", "graph-lab-fixtures", "graph-lab-evaluate", "decision-eval-client", "provenance-graph", "claim-matching"];
    save("preregister.json", { createdAt: new Date().toISOString(), casesSha256: hash(JSON.stringify(cases)), counts: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, v.length])),
        thresholds: { support: 0.9, claimFilter: 0.8, qualifierLink: 0.8, instructionEdge: 0.8, matchingIoU: 0.5 },
        models, clefRevision: "Hosted selector; immutable backend revision not exposed.",
        labels: "Construction controls, not model adjudication; fixtures and wording frozen before requests; held-out rows not used for tuning.",
        limitations: "Small related template families. No population accuracy claim; oracle target graph is a privileged-input ceiling.",
        inputHashes: Object.fromEntries(sources.map(s => [s, hash(readFileSync(`evals/claim-verification/${s}.mts`))])),
        priorKnownSpendUsd: 2.076606022, maximumNewUsdAcrossTheseClients: 1, production: "Evaluation only" });
    save("cases.json", cases);
}

async function evaluateCoreDomain(client: DecisionClient, domain: keyof CoreCases, cases: CoreCases) {
    if (domain === "provenance") {
        const rows = await evaluateProvenance(client, cases.provenance);
        return { rows, summary: summarizeCore(domain, rows) };
    }
    if (domain === "extraction") {
        const rows = await evaluateExtraction(client, cases.extraction);
        const arms = Object.keys(rows[0]!.metrics);
        const summary = Object.fromEntries(["development", "holdout"].map(split => [split, Object.fromEntries(arms.map(arm =>
            [arm, summarizeMatching(rows.filter(r => r.split === split).map(r => r.metrics[arm]!))]))]));
        return { rows, summary };
    }
    if (domain === "instructions") {
        const rows = await evaluateInstructions(client, cases.instructions);
        return { rows, summary: accuracy(rows, ["latestMessage", "scopedRegex", "raw", "authorityFiltered", "graphResolved"]) };
    }
    const rows = await evaluateDocumentation(client, cases.documentation);
    return { rows, summary: accuracy(rows, ["raw", "importerCount", "graphOracle", "lexicalGraph", "modelGraph"]) };
}

async function main() {
    const [output, stage = "core", onlyModel] = process.argv.slice(2);
    if (!output || stage !== "core" || (onlyModel && !["jev-1.13.0", "clef-flash"].includes(onlyModel))) throw Error("Usage: graph-lab.mts NEW_OUTPUT core [jev-1.13.0|clef-flash]");
    const models = (["jev-1.13.0", "clef-flash"] as const).filter(model => !onlyModel || model === onlyModel);
    const save = outputWriter(output);
    const cases = { provenance: provenanceCases(), extraction: extractionCases(), instructions: instructionCases(), documentation: documentationCases() };
    preregisterCore(save, models, cases);
    const summaries = [];
    for (const model of models) {
        const modelSave = outputWriter(resolve(output, model));
        const account = modelAccount(model);
        const client = createDecisionClient({ model, token: modelToken(model), account, remainingUsd: 0.5, save: modelSave });
        for (const domain of ["provenance", "extraction", "instructions", "documentation"] as const) {
            const started = performance.now();
            try {
                const result = await evaluateCoreDomain(client, domain, cases);
                modelSave(`${domain}.json`, result); summaries.push({ model, domain, summary: result.summary });
                console.log(JSON.stringify({ model, domain, completed: true, elapsedMs: performance.now() - started, usage: { ...client.usage(), latenciesMs: undefined } }));
            } catch (error) {
                modelSave(`${domain}-failure.json`, { error: error instanceof Error ? error.message : String(error), usage: client.usage() });
                throw error;
            }
        }
        modelSave("usage.json", client.usage());
    }
    save("summary.json", { createdAt: new Date().toISOString(), summaries });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
