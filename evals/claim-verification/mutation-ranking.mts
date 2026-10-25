import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JevQuestion } from "../../src/harness/jev/types.js";
import { createLoggedClient } from "./eval-client.mjs";
import { copyClosure, executePoolTest, type PoolMutant } from "./mutation-pool.mjs";

interface Scores { violates: number; realistic: number; checked: number; equivalent: number }
interface FrozenPool { source: string; tests: string; sourcePath: string; testPath: string; sourceSha256: string; testSha256: string; pool: PoolMutant[] }
type RankedScore = { id: string; priority: number } & Scores;
type Save = (name: string, value: unknown) => void;
export const priority = (p: Scores): number => 0.5 * p.violates + 0.3 * p.realistic + 0.2 * (1 - p.checked);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function withExploration(ranked: string[], random: string[]): string[] {
    const result: string[] = [], used = new Set<string>();
    while (result.length < ranked.length) {
        const source = (result.length + 1) % 10 === 0 ? random : ranked;
        const next = source.find(id => !used.has(id));
        if (next === undefined) throw new Error("Ranking pool mismatch");
        result.push(next); used.add(next);
    }
    return result;
}

function questions(mutants: PoolMutant[], source: string): Record<string, JevQuestion> {
    const result: Record<string, JevQuestion> = {};
    for (const [i, m] of mutants.entries()) {
        const change = `line ${source.slice(0, m.start).split("\n").length}: ${m.before} → ${m.after}`;
        const prompts = {
            violates: `Does this concrete change violate behavior described by the supplied source comments or test titles? ${change}`,
            realistic: `Is this concrete change a plausible developer mistake in the supplied code? ${change}`,
            checked: `Does an assertion in the supplied tests directly distinguish the behavior affected by this change? ${change}`,
            equivalent: `Does this concrete change preserve all observable behavior of the supplied module? ${change}`,
        };
        for (const [kind, question] of Object.entries(prompts)) result[`${kind}_${i}`] = { type: "noul", instructions: { question },
            criteria: { true: { what: "Yes" }, false: { what: "No" } } };
    }
    return result;
}

async function scoreMutants(client: ReturnType<typeof createLoggedClient>, frozen: FrozenPool): Promise<RankedScore[]> {
    const scores: RankedScore[] = [];
    for (let start = 0; start < frozen.pool.length; start += 20) {
        const batch = frozen.pool.slice(start, start + 20);
        const result = await client.askDetailed({ source: frozen.source, tests: frozen.tests }, questions(batch, frozen.source));
        if (!result.ok) throw new Error(`Mutation scoring failed: ${result.error}`);
        for (const [i, m] of batch.entries()) {
            const p: Scores = { violates: 0, realistic: 0, checked: 0, equivalent: 0 };
            for (const key of Object.keys(p) as Array<keyof Scores>) {
                const answer = result.response.answers[`${key}_${i}`];
                if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error("Missing mutation score");
                p[key] = answer.noul;
            }
            scores.push({ id: m.id, ...p, priority: priority(p) });
        }
    }
    return scores;
}

function rankingOrders(frozen: FrozenPool, scores: RankedScore[]) {
    const random = frozen.pool.map(m => m.id).sort((a, b) => hash(`20261019:${a}`).localeCompare(hash(`20261019:${b}`)));
    const rank: Record<string, number> = { binary_operator: 0, numeric_plus_one: 1, numeric_minus_one: 1, boolean_flip: 2, zero_literal: 3, return_undefined: 4, empty_string: 5 };
    const heuristic = [...frozen.pool].sort((a, b) => (rank[a.operator] ?? 9) - (rank[b.operator] ?? 9) || a.id.localeCompare(b.id)).map(m => m.id);
    const jev = [...scores].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).map(m => m.id);
    return { random, heuristic: withExploration(heuristic, random), jev: withExploration(jev, random) };
}

async function executeRankingArm(output: string, arm: "heuristic" | "random" | "jev", order: string[],
    frozen: FrozenPool, budgetMs: number, save: Save) {
        const root = resolve(output, arm); copyClosure(frozen.sourcePath, root); copyClosure(frozen.testPath, root);
        writeFileSync(resolve(root, "vitest.config.mts"), 'export default {test:{environment:"node",maxWorkers:1}};\n');
        const baseline = await executePoolTest(root, frozen.sourcePath, frozen.testPath, frozen.source, "baseline", 60_000);
        if (!baseline.report?.success) throw new Error("Arm baseline failed");
        const rows = []; let usedMs = 0;
        for (const id of order) {
            const remaining = budgetMs - usedMs; if (remaining <= 0) break;
            const mutant = frozen.pool.find(m => m.id === id)!;
            const run = await executePoolTest(root, frozen.sourcePath, frozen.testPath, mutant.source, id, Math.min(5_000, remaining));
            usedMs += run.elapsedMs;
            const status = run.timedOut ? remaining < 5_000 ? "budget_exhausted" : "timeout" : run.error || run.signal ? "runner_failure"
                : run.report?.numFailedTests ? "killed" : run.report?.success && run.report.numTotalTests === baseline.report.numTotalTests ? "survived" : "invalid_or_runner_failure";
            save(`${arm}-${id}.json`, { id, status, ...run }); rows.push({ id, status, elapsedMs: run.elapsedMs, cumulativeMs: usedMs });
        }
        const summary = { arm, budgetMs, usedMs, rows }; save(`${arm}-summary.json`, summary);
        return summary;
}

function preregisterRanking(poolText: string, frozen: FrozenPool, budgetMs: number, save: Save): void {
    save("preregister.json", { createdAt: new Date().toISOString(), poolSha256: hash(poolText), ids: frozen.pool.map(m => m.id), budgetMs,
        score: "0.5 violates + 0.3 realistic + 0.2 (1-checked); equivalence excluded", exploration: "every tenth ranked slot", seed: 20261019,
        heuristic: "fixed binary, numeric, boolean, return, string operator priority; no learned history", armExecutionOrder: ["heuristic", "random", "jev"],
        limitation: "Single module pilot. Test-runner wall time includes startup. Final in-flight mutant is killed at remaining budget, not counted as survivor. Screen outcomes withheld from Jev.",
        implementationSha256: hash(readFileSync("evals/claim-verification/mutation-ranking.mts", "utf8")) });
}

async function main(): Promise<void> {
    const [screen, output] = process.argv.slice(2);
    if (!screen || !output || !process.env.TYPESAFE_API_KEY) throw new Error("Usage: mutation-ranking.mts SCREEN_MODULE NEW_OUTPUT; TYPESAFE_API_KEY required");
    const poolText = readFileSync(resolve(screen, "pool.json"), "utf8");
    const frozen: FrozenPool = JSON.parse(poolText);
    if (hash(readFileSync(frozen.sourcePath, "utf8")) !== frozen.sourceSha256 || hash(readFileSync(frozen.testPath, "utf8")) !== frozen.testSha256) throw new Error("Screened source changed");
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const save: Save = (name, value) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const budgetMs = 10_000;
    preregisterRanking(poolText, frozen, budgetMs, save);
    const client = createLoggedClient({ apiKey: process.env.TYPESAFE_API_KEY, save, maxSpendUsd: 0.3 });
    const scores = await scoreMutants(client, frozen);
    save("scores.json", { scores, spend: client.spend() });
    const orders = rankingOrders(frozen, scores);
    save("orders.json", orders);
    const summaries = [];
    for (const arm of ["heuristic", "random", "jev"] as const) {
        summaries.push(await executeRankingArm(output, arm, orders[arm], frozen, budgetMs, save));
    }
    save("summary.json", { createdAt: new Date().toISOString(), pool: frozen.pool.length, summaries, spend: client.spend(),
        sourceUnchanged: hash(readFileSync(frozen.sourcePath, "utf8")) === frozen.sourceSha256, testsUnchanged: hash(readFileSync(frozen.testPath, "utf8")) === frozen.testSha256 });
    console.log(JSON.stringify(summaries.map(s => ({ arm: s.arm, executed: s.rows.length, survived: s.rows.filter(r => r.status === "survived").length, usedMs: s.usedMs }))));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
