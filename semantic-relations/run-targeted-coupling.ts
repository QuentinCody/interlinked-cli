import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hash } from "../src/harness/semantic-graph/relation-core.js";
import { makeRelationPacket } from "../src/harness/semantic-graph/relation-packet.js";
import { sealPlan } from "../src/harness/semantic-graph/relation-plan.js";
import { freezeRelations } from "../src/harness/semantic-graph/relation-freeze.js";
import { exportBundle, writeArtifactFile } from "../src/harness/semantic-graph/relation-store.js";
import { assessRelations } from "../src/lib/decision-metrics/relation-assess.js";
import { auditRelations } from "../src/lib/decision-metrics/relation-audit.js";
import { RELATION_CONTRACTS } from "../src/lib/decision-metrics/relation-contracts.js";
import type { RelationPlan, InvariantDefinition, ScenarioDefinition } from "../src/harness/semantic-graph/relation-types.js";

const root = process.cwd(), study = resolve(process.argv[2] ?? "semantic-relations/studies/2026-10-27-exploratory");
const original = JSON.parse(readFileSync(join(study, "A-plan.json"), "utf8")) as RelationPlan;
const cases = JSON.parse(readFileSync(join(study, "B-targeted-cases.json"), "utf8")) as Array<{ id: string; sourceId: string; targetId: string; invariantId: string; scenario: { statement: string; applicability: string }; choice: string; rationale: string; evidence: string[]; contextFiles: string[] }>;
const snapshot = original.jobs[0]!.snapshot;
const invariants: InvariantDefinition[] = [], scenarios: ScenarioDefinition[] = [];
const packets = cases.map((c, i) => {
    const source = snapshot.units.find(u => u.id === c.sourceId), target = snapshot.units.find(u => u.id === c.targetId);
    if (!source || !target) throw new Error(`missing targeted participant ${i}`);
    const seed = original.policy.policy.invariants.find(inv => inv.id === c.invariantId);
    if (!seed) throw new Error(`unknown invariant ${c.invariantId}`);
    // Opaque model-visible IDs avoid leaking reference words such as update/control.
    const invariant = { ...seed, id: `targeted-invariant-${i + 1}`, participants: [source.id, target.id], groups: [], contextFiles: c.contextFiles };
    const scenario = { ...c.scenario, id: `targeted-scenario-${i + 1}`, version: "1", invariantId: invariant.id };
    invariants.push(invariant); scenarios.push(scenario);
    return makeRelationPacket("semantic_coupling", invariant, [source, target], snapshot, scenario, null);
});
if (packets.some(p => !p.complete)) throw new Error(`targeted packet incomplete: ${packets.filter(p => !p.complete).map(p => p.missing)}`);
const policy = { version: 1 as const, invariants, scenarios };
const plan = sealPlan({ schema: "interlinked.relation-plan/1", kind: "single_snapshot", createdAt: new Date().toISOString(), policy: { revision: null, blobs: {}, digest: hash(policy), exploratory: true, policy }, jobs: original.jobs.map(job => ({ ...job, id: hash({ engine: job.engine, packets: packets.map(p => p.id) }), packets })), coverage: [], sourcePlans: [original.id], experimental: true, unmatched: [], contractDigest: hash(RELATION_CONTRACTS) });
const labels = { schema: "interlinked.relation-labels/1", planId: plan.id, blinded: true, labels: packets.map((p, i) => ({ packetId: p.id, caseId: cases[i]!.id, split: "development", source: "astra_model_review", reviewer: "GPT-6 Astra / prospective scenario author; not independent ground truth", choice: cases[i]!.choice, rationale: cases[i]!.rationale, evidence: cases[i]!.evidence })) };
writeArtifactFile(join(study, "B-targeted-labels.json"), labels);
freezeRelations(root, plan, join(study, "B-targeted-input"));
writeArtifactFile(join(study, "B-targeted-protocol.json"), { scenarioCount: cases.length, directPairs: cases.length / 2, referenceSource: "Astra-authored prospective API changes over pinned code", expectedLabelsFrozenBeforeInference: true, threshold: .8, rationale: "The broad lexical cohort contained no update positives; this separate supplemental diagnostic tests explicit supplied call boundaries. Do not pool its precision with the broad cohort.", executedReproductions: false });
const run = await assessRelations(root, plan, { fresh: true });
exportBundle(join(study, "B-targeted-result"), run, "result");
writeArtifactFile(join(study, "B-targeted-audit.json"), auditRelations(run, labels));
console.log(JSON.stringify({ cases: packets.length, J: run.measurements.filter(m => m.armId === "J").map(m => ({ packet: m.packetId, status: m.status, choice: m.choice })) }));
