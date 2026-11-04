import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseRelationRun } from "../src/harness/semantic-graph/relation-codec.js";
import type { RelationPlan } from "../src/harness/semantic-graph/relation-types.js";

const study = resolve(process.argv[2] ?? "semantic-relations/studies/2026-10-27-runtime");
const read = (name: string): unknown => JSON.parse(readFileSync(join(study, name), "utf8"));
function counts(values: string[]): Record<string, number> {
    return values.reduce<Record<string, number>>((out, value) => { out[value] = (out[value] ?? 0) + 1; return out; }, {});
}
const runs = ["assess", "cache", "repair", "paired", "control-comment-only", "control-no-comment"].map(name => {
    const run = parseRelationRun(read(`${name}-run.json`));
    return {
        name, id: run.id, arms: [...new Set(run.measurements.map(m => m.armId))].map(arm => {
            const rows = run.measurements.filter(m => m.armId === arm);
            return { arm, observations: rows.length, statuses: counts(rows.map(m => m.status)), cached: rows.filter(m => m.cached).length,
                calls: rows.reduce((sum, m) => sum + m.calls, 0), recordedCostUsd: rows.reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
                unknownSpendCalls: rows.filter(m => m.calls > 0 && m.costUsd === null).reduce((sum, m) => sum + m.calls, 0),
                costBasis: arm === "J" ? "adapter estimate, not invoice" : "CLI list-equivalent usage under subscription, not incremental charge" };
        }),
        observations: run.measurements.map(m => {
            const job = run.plan.jobs.find(j => j.id === m.jobId)!;
            const packet = job.packets.find(p => p.id === m.packetId)!;
            return { arm: m.armId, side: job.side, invariant: packet.invariantId, kind: m.recordKind, participants: packet.participants,
                complete: packet.complete, missing: packet.missing, status: m.status, choice: m.choice, raw: m.raw, reason: m.reason,
                evidenceHash: m.evidenceHash, snapshotDigest: m.snapshotDigest, cached: m.cached };
        }),
    };
});
const retrieval = ["shared_rules", "lexical"].map(method => {
    const plan = read(`${method}-plan.json`) as RelationPlan;
    return { method, units: plan.jobs[0]!.snapshot.units.length, historyCommits: plan.jobs[0]!.snapshot.history.commits.length,
        coChangeFiles: Object.keys(plan.jobs[0]!.snapshot.history.map).length,
        recovered: plan.coverage.reduce((sum, c) => sum + c.recovered.length, 0), reference: plan.coverage.reduce((sum, c) => sum + c.reference.length, 0),
        perInvariant: plan.coverage.map(c => ({ invariant: c.invariantId, recovered: c.recovered.length, reference: c.reference.length })) };
});
const commands = readdirSync(study).filter(f => /-command(?:-\d+)?\.json$/.test(f)).sort().map(file => {
    const row = read(file) as { name: string; exitCode: number; durationMs: number };
    return { file, name: row.name, exitCode: row.exitCode, durationMs: row.durationMs };
});
writeFileSync(join(study, "summary.json"), JSON.stringify({ exploratory: true, retrieval, runs, commands, comparison: read("comparison.json"),
    limits: ["Sequential dogfood with authored invariants and selected participants, not randomized incremental utility.",
        "Source capture has no usable co-change edges; retrieval is registry-relative on 533 units.",
        "Controls retain twelve over-budget observations as unassessed per run; only six judgments are requested.",
        "Cached observations retain historical responses, zero new calls and null per-observation cost; zero new inference is not a new invoice estimate.",
        "No independent ground truth, deployment qualification or automatic semantic gate."] }, null, 2) + "\n");
console.log(join(study, "summary.json"));
