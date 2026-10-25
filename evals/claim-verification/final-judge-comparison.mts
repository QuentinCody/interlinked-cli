import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JevQuestion } from "../../src/harness/jev/types.js";
import { createDecisionClient, type DecisionClient } from "./decision-eval-client.mjs";
import { outputWriter, modelAccount, modelToken } from "./graph-lab.mjs";
import { probability, supportMetrics } from "./graph-lab-evaluate.mjs";
import { deterministicOutcome, type TypedControl } from "./typed-controls.mjs";

export const baselineDecision = (checkable: number, evidenced: number) => checkable >= 0.5 && evidenced >= 0.3;
interface CachedCase { id: string; route: string; baseline: boolean; expectedSupport: boolean }
function loadRequests(directory: string, cases: CachedCase[]) {
    return cases.map(c => {
        if (c.route === "no_eligible_evidence") return { ...c, request: null };
        const recorded = JSON.parse(readFileSync(`${directory}/${c.id}.json`, "utf8")).choiceRun.record;
        return { ...c, request: { state: recorded.baselineState as unknown, questions: recorded.baselineQuestions as Record<string, JevQuestion> } };
    });
}

async function judgeRequests(client: DecisionClient, requests: ReturnType<typeof loadRequests>, controls: TypedControl[]) {
    const rows: Array<{ id: string; expected: boolean; jevCached: boolean; clef: boolean; deterministicFirst: boolean; route: string }> = [];
    for (const c of requests) {
        let supported = false;
        if (c.request) {
            const result = await client.ask(`final-judge-${c.id}`, c.request.state, c.request.questions);
            supported = baselineDecision(probability(result, "k0"), probability(result, "e0"));
        }
        const control = controls.find(x => x.id === c.id)!;
        const deterministic = deterministicOutcome(control);
        rows.push({ id: c.id, expected: c.expectedSupport, jevCached: c.baseline, clef: supported,
            deterministicFirst: deterministic ? deterministic.status === "supported" : supported, route: deterministic ? "deterministic" : c.route });
    }
    return rows;
}

async function main() {
    const output = process.argv[2]; if (!output) throw Error("Usage: final-judge-comparison.mts NEW_OUTPUT");
    const base = "scratch/2026-10-19-claim-verification/trust-run-01", old = `${base}/holdout-jev`;
    const controlsText = readFileSync(`${base}/mixed-holdout/cases.json`, "utf8"), controls: TypedControl[] = JSON.parse(controlsText);
    const cached: { cases: CachedCase[] } = JSON.parse(readFileSync(`${old}/summary.json`, "utf8"));
    const save = outputWriter(output);
    const requests = loadRequests(old, cached.cases);
    save("preregister.json", { createdAt: new Date().toISOString(), controlSha256: createHash("sha256").update(controlsText).digest("hex"),
        requestsSha256: createHash("sha256").update(JSON.stringify(requests)).digest("hex"), model: "clef-flash",
        comparator: "Cached original Jev baseline; identical frozen states/questions; no Jev rerun; no new holdout claim",
        thresholds: { checkable: 0.5, evidenced: 0.3 }, deterministicFirst: "Original typed verifier; only unhandled families use the direct model baseline." });
    const account = modelAccount("clef-flash");
    const client = createDecisionClient({ model: "clef-flash", token: modelToken("clef-flash"), account, remainingUsd: 0.2, save });
    const rows = await judgeRequests(client, requests, controls);
    const summary = Object.fromEntries(["jevCached", "clef", "deterministicFirst"].map(arm => [arm, supportMetrics(rows.map(r => ({ expected: r.expected, predicted: r[arm as "clef" | "jevCached" | "deterministicFirst"] })))]));
    save("summary.json", { rows, summary, usage: client.usage() }); console.log(JSON.stringify(summary));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
