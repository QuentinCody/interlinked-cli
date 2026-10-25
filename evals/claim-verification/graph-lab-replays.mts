import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Annotation } from "./annotation-metrics.mjs";
import { spanCandidates } from "./extractors.mjs";
import { matchedExtractionMetrics, summarizeMatching } from "./claim-matching.mjs";
import { collectLocalizationCases, evaluateLocalization } from "./localization-lab.mjs";
import { modelAccount, modelToken, outputWriter } from "./graph-lab.mjs";
import { createDecisionClient, type DecisionClient } from "./decision-eval-client.mjs";
import { noul, probability } from "./graph-lab-evaluate.mjs";

const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export function summarizeLocalization(rows: Awaited<ReturnType<typeof evaluateLocalization>>) {
    return Object.fromEntries(Object.keys(rows[0]?.metrics ?? {}).map(arm => {
        const fields = ["top1", "reciprocalRank", "changedMass", "uniformMass", "liftOverUniform"] as const;
        return [arm, Object.fromEntries(fields.map(key => [key, rows.reduce((n, r) => n + Number(r.metrics[arm]![key]), 0) / rows.length])) as Record<typeof fields[number], number>];
    }));
}
function historicalCases() {
    const base = "scratch/2026-10-19-claim-verification", refs = `${base}/reference-snapshot-01`;
    const manifest = JSON.parse(readFileSync(`${refs}/manifest.json`, "utf8"));
    return (manifest.files as Array<{ file: string; sha256: string }>).map(f => {
        const raw = readFileSync(`${refs}/${f.file}`, "utf8"), annotation: Annotation = JSON.parse(raw);
        const source = JSON.parse(readFileSync(`${base}/goal-run-01/labeling-sources/${f.file}`, "utf8"));
        if (hash(raw) !== f.sha256 || hash(source.source) !== annotation.sourceSha256) throw Error("Historical reference changed");
        return { id: source.id as string, source: source.source as string, annotation };
    });
}
async function evaluateHistorical(client: DecisionClient, cases: ReturnType<typeof historicalCases>) {
    const rows = [];
    for (const c of cases) {
        const candidates = spanCandidates(c.source).map(r => ({ text: r.text, spans: [r.span!] })), scores: number[] = [];
        for (let start = 0; start < candidates.length; start += 30) {
            const batch = candidates.slice(start, start + 30);
            const response = await client.ask(`historical-${c.id}-${start}`, { source: c.source }, Object.fromEntries(batch.map((candidate, i) =>
                [`c${i}`, noul(`Does this passage assert a checkable factual result or existing behavior, rather than only a plan, offer, heading or question? Preserve negative assertions as claims. Passage: ${candidate.text}`)])));
            batch.forEach((_, i) => scores.push(probability(response, `c${i}`)));
        }
        rows.push({ id: c.id, scores, metrics: {
            splitter: matchedExtractionMetrics(c.source, c.annotation, candidates),
            modelFilter: matchedExtractionMetrics(c.source, c.annotation, candidates.filter((_, i) => scores[i]! >= 0.8)),
        } });
    }
    return rows;
}
async function main() {
    const [output, stage] = process.argv.slice(2);
    if (!output || !["localization", "historical-extraction"].includes(stage ?? "")) throw Error("Usage: graph-lab-replays.mts NEW_OUTPUT localization|historical-extraction");
    const save = outputWriter(output);
    const collected = stage === "localization" ? collectLocalizationCases() : null;
    const historical = stage === "historical-extraction" ? historicalCases() : null;
    const cases = collected?.cases ?? historical!;
    save("preregister.json", { createdAt: new Date().toISOString(), stage, casesSha256: hash(JSON.stringify(cases)), count: cases.length,
        hypothesis: stage === "localization" ? "Model-token, line and statement locations and token diffusion beat identifier overlap on recorded edits."
            : "A fixed 0.8 model claim filter improves one-to-one precision without an unacceptable recall loss; report both, no post-hoc threshold selection.",
        orderReplicas: 2, diffusionDamping: 0.7, diffusionRounds: 30, models: ["jev-1.13.0", "clef-flash"], perClientSpendLimit: 0.3,
        limitations: collected?.limitation ?? "Reused historical model annotations; reference agreement, not held-out semantic accuracy.",
        inputHashes: Object.fromEntries(["graph-lab-replays", "localization-lab", "decision-eval-client", "graph-lab-core", "claim-matching"].map(s =>
            [s, hash(readFileSync(`evals/claim-verification/${s}.mts`))])) });
    save("cases.json", { cases, exclusions: collected?.excluded });
    const summaries = [];
    for (const model of ["jev-1.13.0", "clef-flash"] as const) {
        const modelSave = outputWriter(resolve(output, model));
        const account = modelAccount(model);
        const client = createDecisionClient({ model, token: modelToken(model), account, remainingUsd: 0.3, save: modelSave });
        if (collected) {
            const rows = await evaluateLocalization(client, collected.cases), summary = summarizeLocalization(rows);
            modelSave("results.json", { rows, summary }); summaries.push({ model, summary });
        } else {
            const rows = await evaluateHistorical(client, historical!);
            const summary = Object.fromEntries(["splitter", "modelFilter"].map(arm => [arm, summarizeMatching(rows.map(r => r.metrics[arm as "splitter" | "modelFilter"]))]));
            modelSave("results.json", { rows, summary }); summaries.push({ model, summary });
        }
        modelSave("usage.json", client.usage()); console.log(JSON.stringify({ model, stage, calls: client.usage().calls, estimatedUsd: client.usage().estimatedUsd }));
    }
    save("summary.json", summaries);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
