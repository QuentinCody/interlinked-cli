import { hash } from "./relation-core.js";
import { parseRelationRun } from "./relation-codec.js";
import { sealPlan } from "./relation-plan.js";
import type { RelationJob, RelationMeasurement, RelationPlan, RelationRun } from "./relation-types.js";

export function pairedRelationPlan(beforeInput: RelationRun, afterInput: RelationRun): RelationPlan {
    const before = parseRelationRun(beforeInput), after = parseRelationRun(afterInput);
    if (before.plan.kind !== "single_snapshot" || after.plan.kind !== "single_snapshot") throw new Error("pair two single-snapshot runs");
    if (before.plan.policy.digest !== after.plan.policy.digest) throw new Error("invariant/scenario policy changed; cannot create matched remeasurement");
    const jobs: RelationJob[] = [], unmatched = [...before.plan.unmatched, ...after.plan.unmatched];
    pairRelationJobs(before, after, unmatched, jobs);
    for (const right of after.plan.jobs) if (!before.plan.jobs.some(j => j.engine.id === right.engine.id)) unmatched.push(`new_arm:${right.engine.id}`);
    const { id: _id, ...base } = before.plan;
    return sealPlan({ ...base, kind: "paired_snapshots", jobs, createdAt: new Date().toISOString(), sourcePlans: [before.plan.id, after.plan.id], coverage: [...before.plan.coverage, ...after.plan.coverage], unmatched: [...new Set(unmatched)] });
}
export interface RelationComparisonRow { armId: string; logicalKey: string; before: string | null; after: string | null; evidenceChanged: boolean; outcome: "same_assessment" | "changed_assessment" | "non_comparable"; reason: string; }
function pairRelationJobs(before: RelationRun, after: RelationRun, unmatched: string[], jobs: RelationJob[]) {
    for (const left of before.plan.jobs) {
        const right = after.plan.jobs.find(j => j.engine.id === left.engine.id);
        if (!right || left.snapshot.repository !== right.snapshot.repository) { unmatched.push(`missing_arm_or_repository:${left.engine.id}`); continue; }
        if (hash(left.snapshot.history.boundary) !== hash(right.snapshot.history.boundary) || left.snapshot.history.digest !== right.snapshot.history.digest) throw new Error("paired history must use the same pre-change tip and window");
        const leftKeys = new Set(left.packets.map(p => p.logicalKey)), rightKeys = new Set(right.packets.map(p => p.logicalKey));
        for (const key of new Set([...leftKeys, ...rightKeys])) if (!leftKeys.has(key) || !rightKeys.has(key)) unmatched.push(`${left.engine.id}:${key}`);
        for (const [side, job] of [["before", left], ["after", right]] as const) {
            const result = { ...job, engine: left.engine, side };
            jobs.push({ ...result, id: hash({ side, source: job.id, engine: left.engine }) });
        }
    }
}

function compareRows(a: RelationMeasurement | undefined, b: RelationMeasurement | undefined, beforeSnapshot: string | undefined, afterSnapshot: string | undefined): Omit<RelationComparisonRow, "armId" | "logicalKey"> {
    const common = { before: a?.choice ?? null, after: b?.choice ?? null, evidenceChanged: a?.evidenceHash !== b?.evidenceHash };
    if (!a || !b) return { ...common, outcome: "non_comparable", reason: "participant/claim missing on one side" };
    if (a.engineIdentity !== b.engineIdentity || a.contractHash !== b.contractHash || a.servedModel !== b.servedModel) return { ...common, outcome: "non_comparable", reason: "measurement configuration changed" };
    if (a.status !== "answered" || b.status !== "answered") return { ...common, outcome: "non_comparable", reason: "one or both sides unresolved" };
    if (beforeSnapshot !== afterSnapshot && a.evidenceHash === b.evidenceHash) return { ...common, outcome: "non_comparable", reason: "source snapshot changed outside visible packet; dependency context requires review" };
    return { ...common, outcome: a.choice === b.choice ? "same_assessment" : "changed_assessment", reason: a.choice === b.choice ? "same categorical observation; not proof of preservation" : "categorical observations differ; not a drift/repair verdict" };
}
export function comparePairedRun(input: RelationRun): { schema: string; runId: string; rows: RelationComparisonRow[]; unmatched: string[]; complete: boolean } {
    const run = parseRelationRun(input);
    if (run.plan.kind !== "paired_snapshots") throw new Error("comparison needs a paired assessment run");
    const before = new Map<string, RelationMeasurement>(), after = new Map<string, RelationMeasurement>();
    for (const measurement of run.measurements) {
        const job = run.plan.jobs.find(j => j.id === measurement.jobId)!;
        const target = job.side === "before" ? before : after;
        const key = `${measurement.armId}:${measurement.logicalKey}`;
        if (target.has(key)) throw new Error("ambiguous relation correspondence");
        target.set(key, measurement);
    }
    const rows = [...new Set([...before.keys(), ...after.keys()])].map(key => {
        const a = before.get(key), b = after.get(key), example = a ?? b!;
        return { armId: example.armId, logicalKey: example.logicalKey, ...compareRows(a, b, run.plan.jobs.find(j => j.id === a?.jobId)?.snapshot.digest, run.plan.jobs.find(j => j.id === b?.jobId)?.snapshot.digest) };
    });
    return { schema: "interlinked.relation-comparison/1", runId: run.id, rows, unmatched: run.plan.unmatched, complete: run.complete && !run.plan.unmatched.length && rows.every(r => r.outcome !== "non_comparable") };
}
