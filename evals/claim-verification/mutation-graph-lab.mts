import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { copyClosure, executePoolTest, type PoolMutant } from "./mutation-pool.mjs";
import { withExploration, priority } from "./mutation-ranking.mjs";
import { createDecisionClient } from "./decision-eval-client.mjs";
import { modelAccount, modelToken, outputWriter } from "./graph-lab.mjs";
import { noul, probability } from "./graph-lab-evaluate.mjs";
import type { JevQuestion } from "../../src/harness/jev/types.js";

const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export function meanRank(a: string[], b: string[]): string[] {
    if (a.length !== b.length || a.some(id => !b.includes(id))) throw Error("Different ranking pools");
    return [...a].sort((x, y) => a.indexOf(x) + b.indexOf(x) - a.indexOf(y) - b.indexOf(y) || x.localeCompare(y));
}
export function diversify(order: string[], neighborhood: Record<string, string>): string[] {
    const selected: string[] = [], counts = new Map<string, number>();
    const remaining = new Set(order);
    while (remaining.size) {
        const ranked = [...remaining].sort((a, b) => {
            const score = (id: string) => (order.length - order.indexOf(id)) / (1 + (counts.get(neighborhood[id]!) ?? 0));
            return score(b) - score(a) || (counts.get(neighborhood[a]!) ?? 0) - (counts.get(neighborhood[b]!) ?? 0) || a.localeCompare(b);
        });
        const id = ranked[0]!, group = neighborhood[id]!;
        selected.push(id); remaining.delete(id); counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    return selected;
}
export function observedSubsumption(killSets: Record<string, string[]>) {
    const bySet = new Map<string, { mutants: string[]; killers: string[] }>(), unresolvedSurvivors: string[] = [];
    for (const [id, tests] of Object.entries(killSets)) {
        const killers = [...new Set(tests)].sort();
        if (!killers.length) { unresolvedSurvivors.push(id); continue; }
        const key = JSON.stringify(killers), group = bySet.get(key) ?? { mutants: [], killers };
        group.mutants.push(id); bySet.set(key, group);
    }
    const groups = [...bySet.values()], edges: Array<[number, number]> = [];
    for (let i = 0; i < groups.length; i++) for (let j = 0; j < groups.length; j++)
        if (i !== j && groups[i]!.killers.every(t => groups[j]!.killers.includes(t))) edges.push([i, j]);
    return { groups, edges, unresolvedSurvivors };
}
function neighborhoods(source: string, pool: PoolMutant[]) {
    const file = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true), result: Record<string, string> = {};
    for (const mutant of pool) {
        let best: ts.Node = file;
        const walk = (node: ts.Node) => {
            if (node.getStart(file) <= mutant.start && node.end >= mutant.end) {
                if (ts.isStatement(node)) best = node; ts.forEachChild(node, walk);
            }
        };
        walk(file); result[mutant.id] = `${best.kind}:${best.getStart(file)}`;
    }
    return result;
}
interface FrozenPool { source: string; tests: string; sourcePath: string; testPath: string; sourceSha256: string; testSha256: string; pool: PoolMutant[] }
interface Label { id: string; label: string; canonicalBehavioralGroup: string }
interface Outcome { id: string; status: string; elapsedMs: number }
interface ScoredMutant { id: string; violates: number; realistic: number; checked: number; equivalent: number; priority: number }
type Save = (name: string, value: unknown) => void;
function resultCounts(rows: Outcome[], labels: Map<string, Label>) {
    const meaningful = rows.filter(r => r.status === "survived" && labels.get(r.id)?.label === "meaningful_gap");
    return { executed: rows.length, survived: rows.filter(r => r.status === "survived").length, meaningful: meaningful.length,
        groups: new Set(meaningful.map(r => labels.get(r.id)!.canonicalBehavioralGroup)).size, elapsedMs: rows.reduce((n, r) => n + r.elapsedMs, 0) };
}
function preregisterGraph(poolText: string, savedScoresText: string, frozen: FrozenPool, save: Save): void {
    save("preregister.json", { createdAt: new Date().toISOString(), poolSha256: hash(poolText), jevScoresSha256: hash(savedScoresText),
        ids: frozen.pool.map(m => m.id), budgetMs: 10_000, seed: 20261020, hybrid: "Equal mean ordinal rank; no fitted weights",
        graph: "Greedy score = original rank percentile / (1 + previously selected mutants in the same smallest enclosing AST statement); ties favor less visited neighborhoods",
        exploration: "Every tenth slot from the same seeded random order", equivalence: "Logged for Clef, excluded from ranks",
        scope: "Retrospective single-module follow-up; prior outcomes known to investigators, not supplied to model. Existing model labels reused.",
        implementationSha256: hash(readFileSync("evals/claim-verification/mutation-graph-lab.mts")) });
}

async function scoreGraphPool(client: ReturnType<typeof createDecisionClient>, frozen: FrozenPool): Promise<ScoredMutant[]> {
    const scores: ScoredMutant[] = [];
    for (let start = 0; start < frozen.pool.length; start += 15) {
        const batch = frozen.pool.slice(start, start + 15), questions: Record<string, JevQuestion> = {};
        for (const [i, m] of batch.entries()) {
            const change = `line ${frozen.source.slice(0, m.start).split("\n").length}: ${m.before} → ${m.after}`;
            for (const [key, question] of Object.entries({
                violates: "Does this change violate behavior described by the source comments or test titles?",
                realistic: "Is this concrete change a plausible developer mistake?",
                checked: "Does an assertion in the tests directly distinguish the behavior affected by this change?",
                equivalent: "Does this change preserve all observable behavior of the module?",
            })) questions[`${key}_${i}`] = noul(`${question} Change: ${change}`);
        }
        const response = await client.ask(`mutation-${start}`, { source: frozen.source, tests: frozen.tests }, questions);
        batch.forEach((m, i) => {
            const p = { violates: probability(response, `violates_${i}`), realistic: probability(response, `realistic_${i}`),
                checked: probability(response, `checked_${i}`), equivalent: probability(response, `equivalent_${i}`) };
            scores.push({ id: m.id, ...p, priority: priority(p) });
        });
    }
    return scores;
}

function graphOrders(frozen: FrozenPool, cachedScores: Array<{ id: string; priority: number }>, scores: ScoredMutant[]) {
    const random = frozen.pool.map(m => m.id).sort((a, b) => hash(`20261020:${a}`).localeCompare(hash(`20261020:${b}`)));
    const ranks: Record<string, number> = { binary_operator: 0, numeric_plus_one: 1, numeric_minus_one: 1, boolean_flip: 2, zero_literal: 3, return_undefined: 4, empty_string: 5 };
    const heuristic = [...frozen.pool].sort((a, b) => (ranks[a.operator] ?? 9) - (ranks[b.operator] ?? 9) || a.id.localeCompare(b.id)).map(m => m.id);
    const jev = [...cachedScores].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).map(r => r.id);
    const clef = [...scores].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).map(r => r.id);
    const neighbor = neighborhoods(frozen.source, frozen.pool), hybrid = meanRank(heuristic, jev);
    const orders = Object.fromEntries(Object.entries({ random, heuristic, jev, clef, heuristicJev: hybrid, heuristicClef: meanRank(heuristic, clef),
        heuristicGraph: diversify(heuristic, neighbor), heuristicJevGraph: diversify(hybrid, neighbor) })
        .map(([arm, order]) => [arm, arm === "random" ? order : withExploration(order, random)]));
    return { orders, neighborhoods: neighbor };
}

function replayOutcomes(orders: Record<string, string[]>, results: Outcome[], labels: Map<string, Label>) {
    const outcome = new Map(results.map(r => [r.id, r]));
    return Object.fromEntries(Object.entries(orders).map(([arm, order]) => {
        const rows: Outcome[] = []; let elapsed = 0;
        for (const id of order) { const row = outcome.get(id)!; if (elapsed + row.elapsedMs > 10_000) break; rows.push(row); elapsed += row.elapsedMs; }
        return [arm, resultCounts(rows, labels)];
    }));
}

function saveSubsumption(base: string, results: Outcome[], save: Save): void {
    const killSets: Record<string, string[]> = {};
    for (const row of results.filter(r => ["killed", "survived"].includes(r.status))) {
        const raw = JSON.parse(readFileSync(`${base}/mutation-screen-v4/bounded-file-io/${row.id}.json`, "utf8"));
        killSets[row.id] = (raw.report?.testResults ?? []).flatMap((suite: { name: string; assertionResults: Array<{ status: string; fullName: string }> }) =>
            suite.assertionResults.filter(t => t.status === "failed").map(t => `${suite.name.split("/src/").at(-1)}:${t.fullName}`));
    }
    save("subsumption.json", { ...observedSubsumption(killSets), granularity: "Vitest test cases, not individual assertion calls", excludedTimeouts: 3 });
}

async function executeGraphArm(output: string, arm: string, order: string[], frozen: FrozenPool, labels: Map<string, Label>, save: Save) {
        const root = resolve(output, arm); copyClosure(frozen.sourcePath, root); copyClosure(frozen.testPath, root);
        writeFileSync(resolve(root, "vitest.config.mts"), 'export default {test:{environment:"node",maxWorkers:1}};\n');
        const baseline = await executePoolTest(root, frozen.sourcePath, frozen.testPath, frozen.source, "baseline", 60_000);
        if (!baseline.report?.success) throw Error("Arm baseline failed");
        const rows: Outcome[] = []; let used = 0;
        for (const id of order) {
            const remaining = 10_000 - used; if (remaining <= 0) break;
            const m = frozen.pool.find(x => x.id === id)!;
            const run = await executePoolTest(root, frozen.sourcePath, frozen.testPath, m.source, id, Math.min(5_000, remaining));
            used += run.elapsedMs;
            const status = run.timedOut ? remaining < 5_000 ? "budget_exhausted" : "timeout" : run.error || run.signal ? "runner_failure"
                : run.report?.numFailedTests ? "killed" : run.report?.success && run.report.numTotalTests === baseline.report.numTotalTests ? "survived" : "invalid_or_runner_failure";
            save(`${arm}-${id}.json`, { id, status, ...run }); rows.push({ id, status, elapsedMs: run.elapsedMs });
        }
        const summary = { arm, rows, ...resultCounts(rows, labels) }; save(`${arm}-summary.json`, summary);
        console.log(JSON.stringify({ ...summary, rows: undefined }));
        return summary;
}

async function main() {
    const output = process.argv[2]; if (!output) throw Error("Usage: mutation-graph-lab.mts NEW_OUTPUT");
    const base = "scratch/2026-10-19-claim-verification/trust-run-01", save = outputWriter(output);
    const poolText = readFileSync(`${base}/mutation-pool-valid/pool.json`, "utf8"), frozen: FrozenPool = JSON.parse(poolText);
    if (hash(readFileSync(frozen.sourcePath)) !== frozen.sourceSha256 || hash(readFileSync(frozen.testPath)) !== frozen.testSha256) throw Error("Frozen mutation source changed");
    const savedScoresText = readFileSync(`${base}/mutation-ranking-valid/scores.json`, "utf8");
    const cached: { scores: Array<{ id: string; priority: number }> } = JSON.parse(savedScoresText);
    preregisterGraph(poolText, savedScoresText, frozen, save);
    const account = modelAccount("clef-flash");
    const client = createDecisionClient({ model: "clef-flash", token: modelToken("clef-flash"), account, remainingUsd: 0.2, save: outputWriter(resolve(output, "clef-flash")) });
    const scores = await scoreGraphPool(client, frozen);
    save("clef-scores.json", { scores, usage: client.usage() });
    const ranked = graphOrders(frozen, cached.scores, scores);
    save("orders.json", ranked);
    const labels = new Map<string, Label>((JSON.parse(readFileSync(`${base}/io-mutant-adjudication-reconciled.json`, "utf8")).cases as Label[]).map(l => [l.id, l]));
    const screen: { results: Outcome[] } = JSON.parse(readFileSync(`${base}/mutation-pool-valid/summary.json`, "utf8"));
    const replay = replayOutcomes(ranked.orders, screen.results, labels);
    save("replay.json", replay);
    saveSubsumption(base, screen.results, save);
    const summaries = [];
    for (const arm of Object.keys(ranked.orders).sort((a, b) => hash(a).localeCompare(hash(b)))) {
        summaries.push(await executeGraphArm(output, arm, ranked.orders[arm]!, frozen, labels, save));
    }
    save("summary.json", { summaries, replay, usage: client.usage(), sourceUnchanged: hash(readFileSync(frozen.sourcePath)) === frozen.sourceSha256,
        testsUnchanged: hash(readFileSync(frozen.testPath)) === frozen.testSha256 });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
