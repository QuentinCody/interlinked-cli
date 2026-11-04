import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hash } from "../src/harness/semantic-graph/relation-core.js";
import { makeRelationPacket } from "../src/harness/semantic-graph/relation-packet.js";
import { sealPlan } from "../src/harness/semantic-graph/relation-plan.js";
import { freezeRelations, loadRelationArtifact } from "../src/harness/semantic-graph/relation-freeze.js";
import { pairedRelationPlan, comparePairedRun } from "../src/harness/semantic-graph/relation-compare.js";
import { exportBundle, writeArtifactFile } from "../src/harness/semantic-graph/relation-store.js";
import { assessRelations } from "../src/lib/decision-metrics/relation-assess.js";
import { auditRelations, type RelationLabels } from "../src/lib/decision-metrics/relation-audit.js";
import { fixtureEvidenceId } from "../src/lib/decision-metrics/relation-fixtures.js";
import type { RelationJob, RelationPlan, RelationPolicy } from "../src/harness/semantic-graph/relation-types.js";

const root = process.cwd(), study = resolve(process.argv[2] ?? "semantic-relations/studies/2026-10-27-exploratory");
const mode = process.argv[3] ?? "fixtures";
function neutralize(original: RelationPlan): RelationPlan {
    const mapping = new Map(original.policy.policy.invariants.map(i => [i.id, fixtureEvidenceId(i.id)]));
    const rename = (value: string) => [...mapping].reduce((s, [from, to]) => s.replaceAll(from, to), value);
    const policy = structuredClone(original.policy.policy);
    for (const i of policy.invariants) { i.id = rename(i.id); i.participants = i.participants.map(rename); i.groups = i.groups.map(g => g.map(rename)); i.contextFiles = i.contextFiles.map(rename); }
    for (const s of policy.scenarios) { s.id = rename(s.id); s.invariantId = rename(s.invariantId); }
    const jobs = original.jobs.filter(j => ["J", "H"].includes(j.engine.id)).map(job => {
        return neutralizeRelationJob(job, rename, policy);
    });
    const { id, ...body } = original;
    return sealPlan({ ...body, createdAt: new Date().toISOString(), policy: { ...original.policy, policy, digest: hash(policy) }, jobs, sourcePlans: [id] });
}
const input = (name: string) => (loadRelationArtifact(join(study, `${name}-input`)) as { plan: RelationPlan }).plan;
function neutralizeRelationJob(job: RelationJob, rename: (value: string) => string, policy: RelationPolicy) {
    const snapshot = structuredClone(job.snapshot);
    snapshot.files = Object.fromEntries(Object.entries(snapshot.files).map(([file, body]) => [rename(file), body]));
    for (const unit of snapshot.units) { unit.id = rename(unit.id); unit.file = rename(unit.file); }
    snapshot.revision = hash(snapshot.files); snapshot.tree = hash(snapshot.files);
    const { digest: _digest, ...snapshotBody } = snapshot; snapshot.digest = hash(snapshotBody);
    const packets = job.packets.map(p => makeRelationPacket(p.kind, policy.invariants.find(i => i.id === rename(p.invariantId))!, p.participants.map(id => snapshot.units.find(u => u.id === rename(id))!), snapshot, policy.scenarios.find(s => s.id === rename(p.scenarioId ?? "")) ?? null, p.queriedRole));
    return { ...job, id: hash({ oldJob: job.id, neutral: true }), snapshot, packets };
}

async function assess(name: string, plan: RelationPlan) {
    freezeRelations(root, plan, join(study, `${name}-input`));
    const run = await assessRelations(root, plan, { fresh: true });
    exportBundle(join(study, `${name}-result`), run, "result");
    console.log(JSON.stringify({ completed: name, statuses: run.measurements.reduce<Record<string, number>>((a, m) => (a[`${m.armId}:${m.status}`] = (a[`${m.armId}:${m.status}`] ?? 0) + 1, a), {}) }));
    return run;
}
writeArtifactFile(join(study, `${mode}-neutral-protocol.json`), { intervention: "Only replace descriptive fixture IDs and file paths with opaque hashes; source bytes, statements, scenarios, options and threshold unchanged.", originalResultsPreserved: true, postResultControl: true, threshold: .8, repetitions: mode === "C" ? 5 : 1 });
if (mode === "fixtures") {
    const original = input("fixtures"), plan = neutralize(original);
    const references = JSON.parse(readFileSync(join(study, "fixtures-labels.json"), "utf8")) as RelationLabels;
    const packetMap = new Map(original.jobs[0]!.packets.map((p, i) => [p.id, plan.jobs[0]!.packets[i]!.id]));
    const labels = { ...references, planId: plan.id, labels: references.labels.map(l => ({ ...l, packetId: packetMap.get(l.packetId)! })) };
    writeArtifactFile(join(study, "fixtures-neutral-labels.json"), labels);
    const run = await assess("fixtures-neutral", plan);
    writeArtifactFile(join(study, "fixtures-neutral-audit.json"), auditRelations(run, labels));
} else if (mode === "C") {
    for (const name of ["A", "B"]) loadRelationArtifact(join(study, `${name}-H-result`));
    const before = neutralize(input("C-before")), after = neutralize(input("C-after"));
    const left = await assess("C-neutral-before", before), right = await assess("C-neutral-after", after);
    const paired = pairedRelationPlan(left, right);
    freezeRelations(root, paired, join(study, "C-neutral-paired-input"));
    const run = await assessRelations(root, paired);
    exportBundle(join(study, "C-neutral-paired-result"), run, "result");
    writeArtifactFile(join(study, "C-neutral-comparison.json"), comparePairedRun(run));
    for (const arm of ["J", "H"]) {
        const { id, ...body } = before;
        const repeatPlan = sealPlan({ ...body, jobs: before.jobs.filter(j => j.engine.id === arm), sourcePlans: [id] });
        const repeats = [];
        for (let i = 1; i <= 5; i++) {
            const repeated = await assess(`C-neutral-${arm}-repeat-${i}`, repeatPlan);
            repeats.push({ runId: repeated.id, observations: repeated.measurements.map(m => ({ logicalKey: m.logicalKey, choice: m.choice, status: m.status, raw: m.raw })) });
        }
        writeArtifactFile(join(study, `C-neutral-${arm}-repeats.json`), repeats);
    }
} else throw new Error("Expected fixtures or C");
