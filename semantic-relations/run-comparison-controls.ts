import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { hash, textHash } from "../src/harness/semantic-graph/relation-core.js";
import { makeRelationPacket } from "../src/harness/semantic-graph/relation-packet.js";
import { sealPlan } from "../src/harness/semantic-graph/relation-plan.js";
import { pairedRelationPlan, comparePairedRun } from "../src/harness/semantic-graph/relation-compare.js";
import { freezeRelations } from "../src/harness/semantic-graph/relation-freeze.js";
import { writeArtifactFile } from "../src/harness/semantic-graph/relation-store.js";
import { assessRelations } from "../src/lib/decision-metrics/relation-assess.js";
import { fixtureEvidenceId } from "../src/lib/decision-metrics/relation-fixtures.js";
import type { RelationPlan } from "../src/harness/semantic-graph/relation-types.js";

const root = resolve(process.cwd()), study = resolve(process.argv[2] ?? "semantic-relations/studies/2026-10-27-exploratory");
// C is deliberately sequenced after completed A/B, and does not infer ordered drift.
for (const arm of ["A", "B"]) JSON.parse(readFileSync(join(study, `${arm}-run.json`), "utf8"));
const original = JSON.parse(readFileSync(join(study, "fixtures-plan.json"), "utf8")) as RelationPlan;
const { id: _id, ...body } = original;
const evidenceId = (id: string) => original.policy.policy.invariants.some(i => i.id === id) ? id : fixtureEvidenceId(id);
const fixtureFile = (id: string) => `fixtures/${evidenceId(id)}.js`;
const before = sealPlan({ ...body, createdAt: new Date().toISOString(), jobs: original.jobs.map(job => ({ ...job, id: hash({ job: job.id, C: "before" }), packets: job.packets.filter(p => p.kind !== "semantic_coupling") })) });
const afterSnapshot = structuredClone(original.jobs[0]!.snapshot);
const edits: Record<string, { ordinal: number; replacement: string; expected: string }> = {
    "A-equivalent-control-flow": { ordinal: 1, replacement: 'function right(s) { return "passed" === s; }', expected: "behavior-preserving" },
    "A-inverted-default": { ordinal: 1, replacement: 'function right(s) { return s === "passed"; }', expected: "false-pass counterexample removed" },
    "A-vocabulary-distractor": { ordinal: 0, replacement: 'function statusLabel(status) { return "color-" + status; } // Fixed: this now verifies successful completion.', expected: "unsupported fixed comment only" },
    "A-explicit-exception": { ordinal: 1, replacement: 'function diagnosticOnly(s) { return s === "failed" ? ["failure"] : []; } // This code is definitely broken.', expected: "unsupported broken comment only" },
    "A-composition-loses-status": { ordinal: 2, replacement: 'function attest(rows) { return false; }', expected: "false-pass counterexample removed; false negatives allowed by this invariant" },
    "A-boundary-assumptions": { ordinal: 2, replacement: 'function attest(result) { return result.status !== "failed"; }', expected: "false-pass introduced" },
    "A-enforcement-role": { ordinal: 0, replacement: 'function permitVerification(result) { return result.status === "passed"; }', expected: "behavior-preserving" },
};
for (const [id, edit] of Object.entries(edits)) {
    const path = fixtureFile(id), lines = afterSnapshot.files[path]!.text.split("\n");
    lines[edit.ordinal] = edit.replacement;
    const text = lines.join("\n"); afterSnapshot.files[path] = { text, hash: textHash(text) };
    for (const unit of afterSnapshot.units.filter(u => u.file === path)) { unit.text = lines.slice(unit.line - 1, unit.endLine).join("\n"); unit.hash = textHash(unit.text); }
}
afterSnapshot.units = afterSnapshot.units.filter(u => u.file !== fixtureFile("A-missing-policy-context"));
delete afterSnapshot.files[fixtureFile("A-missing-policy-context")];
afterSnapshot.revision = hash(afterSnapshot.files); afterSnapshot.tree = hash(afterSnapshot.files);
const { digest: _digest, ...snapshotBody } = afterSnapshot; afterSnapshot.digest = hash(snapshotBody);
const afterPackets = before.jobs[0]!.packets.filter(p => p.invariantId !== evidenceId("A-missing-policy-context")).map(p => makeRelationPacket(p.kind, original.policy.policy.invariants.find(i => i.id === p.invariantId)!, p.participants.map(id => afterSnapshot.units.find(u => u.id === id)!), afterSnapshot, null, p.queriedRole));
const after = sealPlan({ ...body, createdAt: new Date().toISOString(), jobs: original.jobs.map(job => ({ ...job, id: hash({ job: job.id, C: "after" }), snapshot: afterSnapshot, packets: afterPackets })) });
const execute = (id: string, expression: string) => runInNewContext(`${afterSnapshot.files[fixtureFile(id)]!.text}\n(${expression})`, {}, { timeout: 100 }) === true;
const behavioralChecks = [
    { id: "preserved-control", passed: execute("A-equivalent-control-flow", '["passed","failed","unavailable"].every(s => left(s) === right(s))') },
    { id: "removed-default-counterexample", passed: execute("A-inverted-default", '!right("unavailable")') },
    { id: "removed-composition-counterexample", passed: execute("A-composition-loses-status", '!attest(flatten(producer()))') },
    { id: "introduced-counterexample", passed: execute("A-boundary-assumptions", 'attest(forward(producer()))') },
];
if (behavioralChecks.some(c => !c.passed)) throw new Error("C mechanism check failed");
writeArtifactFile(join(study, "C-protocol.json"), { orderedTransitionInference: false, variants: edits, deletion: "A-missing-policy-context", behavioralChecks, freshRepeats: 5, interpretation: "changed categorical assessment is not a drift verdict; compare evidence and executed controls" });
freezeRelations(root, before, join(study, "C-before-input")); freezeRelations(root, after, join(study, "C-after-input"));
const left = await assessRelations(root, before, { fresh: true });
const right = await assessRelations(root, after, { fresh: true });
writeArtifactFile(join(study, "C-before-run.json"), left); writeArtifactFile(join(study, "C-after-run.json"), right);
const paired = pairedRelationPlan(left, right); freezeRelations(root, paired, join(study, "C-paired-input"));
const run = await assessRelations(root, paired);
writeArtifactFile(join(study, "C-paired-run.json"), run); writeArtifactFile(join(study, "C-comparison.json"), comparePairedRun(run));
const { id: _beforeId, ...beforeBody } = before;
const repeatPlan = sealPlan({ ...beforeBody, jobs: before.jobs.filter(j => j.engine.id === "J") });
const repeats = [];
for (let i = 0; i < 5; i++) { const repeat = await assessRelations(root, repeatPlan, { fresh: true }); writeArtifactFile(join(study, `C-repeat-${i + 1}.json`), repeat); repeats.push({ runId: repeat.id, observations: repeat.measurements.map(m => ({ logicalKey: m.logicalKey, choice: m.choice, status: m.status, raw: m.raw })) }); }
writeArtifactFile(join(study, "C-repeats.json"), repeats);
console.log(JSON.stringify({ comparisonRows: comparePairedRun(run).rows.length, unmatched: paired.unmatched.length, repetitions: repeats.length, behavioralChecks }));
