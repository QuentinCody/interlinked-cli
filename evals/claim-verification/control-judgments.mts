import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { JevClient } from "../../src/harness/jev/client.js";
import { evaluateCase, type GroundingCase } from "./grounding.mjs";
import { rescueQuestion, rescueDecision, shouldRescue } from "./grounding-rescue.mjs";
import { createLoggedClient } from "./eval-client.mjs";
import { eligibleEvidence, type Control } from "./controls.mjs";
import { redactE20 } from "../../src/harness/jev/decision-shadow-redact.js";
import { deterministicOutcome, type TypedControl } from "./typed-controls.mjs";

export async function routeControl(c: TypedControl, client: JevClient) {
    const deterministic = deterministicOutcome(c);
    if (deterministic) return { route: "deterministic", status: deterministic.status, supported: deterministic.status === "supported" };
    const judged = await runControl(c, client, true);
    return { route: judged.row.route, status: judged.row.rescue === null ? "not_measured" : judged.row.rescue ? "supported" : "not_supported", supported: judged.row.rescue };
}

export async function runControl(c: Control, client: JevClient, filtered: boolean) {
    const selected = filtered ? eligibleEvidence(c.evidence) : c.evidence;
    const item: GroundingCase = { id: c.id, claim: c.claim, origin: c.origin, expectedSupport: c.expectedSupport!, evidence: selected };
    if (redactE20(JSON.stringify(item)) !== JSON.stringify(item)) throw new Error("Redaction required before remote evaluation");
    const identity = { id: c.id, expectedSupport: c.expectedSupport, variant: c.variant };
    if (filtered && !selected.length) return { row: { ...identity, route: "no_eligible_evidence",
        baseline: false, choice: false, citations: false, rescue: false } };
    const choice = await evaluateCase(item, client, false);
    const citations = await evaluateCase(item, client, true);
    const eligible = shouldRescue(choice.summary.baselineSupported, citations.summary.groundedSupported);
    const rescue = eligible ? await client.askDetailed({}, { rescue: rescueQuestion(item) }) : null;
    return { row: { ...identity, route: "model", baseline: choice.summary.baselineSupported, choice: choice.summary.groundedSupported,
        citations: citations.summary.groundedSupported,
        rescue: eligible ? rescue?.ok ? rescueDecision(rescue.response.answers.rescue) : null : citations.summary.groundedSupported },
        choiceRun: choice, citationRun: citations, rescueRun: rescue };
}

function recordHoldoutStart(input: string, output: string): void {
    const holdoutIndex = process.argv.indexOf("--holdout");
    if (holdoutIndex >= 0) {
        const manifest = JSON.parse(readFileSync(process.argv[holdoutIndex + 1]!, "utf8"));
        const sha256 = createHash("sha256").update(readFileSync(input)).digest("hex");
        if (manifest.sha256 !== sha256 || !Number.isFinite(Date.parse(manifest.createdAt)) || Date.parse(manifest.createdAt) > Date.now()) throw new Error("Invalid holdout chronology or hash");
        writeFileSync(input + ".scored-once", JSON.stringify({ startedAt: new Date().toISOString(), sha256, output }) + "\n", { flag: "wx", mode: 0o600 });
    }
}

async function main(): Promise<void> {
    const [input, output] = process.argv.slice(2);
    if (!input || !output || !process.env.TYPESAFE_API_KEY) throw new Error("Usage: control-judgments.mts CONTROLS NEW_OUTPUT; TYPESAFE_API_KEY required");
    const controls: Control[] = JSON.parse(readFileSync(input, "utf8"));
    recordHoldoutStart(input, output);
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const client = createLoggedClient({ apiKey: process.env.TYPESAFE_API_KEY, save, maxSpendUsd: 1 });
    const filtered = process.argv.includes("--provenance");
    const cases = controls.filter(c => c.certified && c.expectedSupport !== null);
    save("manifest.json", { createdAt: new Date().toISOString(), model: "jev-1.13.0", input, filtered,
        cases: cases.length, implementation: readFileSync("evals/claim-verification/control-judgments.mts", "utf8") });
    const results: unknown[] = []; let cursor = 0;
    async function worker() {
        while (cursor < cases.length) {
            const c = cases[cursor++]!;
            const result = await runControl(c, client, filtered);
            save(`${c.id}.json`, result); results.push(result.row);
            if (client.spend().failures >= 3 || client.spend().usd >= 1) throw new Error("Run budget/failure stop");
            if (results.length % 50 === 0) console.log(JSON.stringify({ completed: results.length, total: cases.length, spend: client.spend() }));
        }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    save("summary.json", { createdAt: new Date().toISOString(), model: "jev-1.13.0", filtered, cases: results, spend: client.spend() });
    console.log(JSON.stringify({ completed: results.length, spend: client.spend() }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
