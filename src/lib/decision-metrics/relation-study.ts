import { hash } from "../../harness/semantic-graph/relation-core.js";
import { makeRelationPacket, unitLogicalKey } from "../../harness/semantic-graph/relation-packet.js";
import { lexicalCandidates, prepareRelations, sealPlan } from "../../harness/semantic-graph/relation-plan.js";
import type { EngineSpec, PolicyReference, RelationKind, RelationPacket, RelationPlan, RelationSnapshot } from "../../harness/semantic-graph/relation-types.js";
import { Unit } from "../../harness/semantic-graph/types.js";

/** Fixed exploratory cohort. Selection reads no predictions or reference labels. */
export function naturalRelationStudies(snapshot: RelationSnapshot, policy: PolicyReference, engines: EngineSpec[], count = 200): { A: RelationPlan; B: RelationPlan; selection: unknown } {
    const eligible = snapshot.units.filter(u => u.kind === "function" && u.text.length >= 120 && u.text.length <= 2000 && !/\.(test|spec)\.|__tests__/.test(u.file));
    if (eligible.length < count) throw new Error(`natural cohort requires ${count} eligible functions; found ${eligible.length}`);
    const coverage = [3, 6, 10, 12].flatMap(k => (["shared_rules", "lexical"] as const).flatMap(method => prepareRelations(snapshot, policy, engines.slice(0, 1), { mode: "retrieved", method, k, kinds: [], maxPackets: 1 }).coverage));
    const A: RelationPacket[] = [], B: RelationPacket[] = [];
    sampleNaturalRelationPackets(eligible, count, policy, A, snapshot, B);
    const base = prepareRelations(snapshot, policy, engines, { mode: "curated", method: "shared_rules", k: 10, kinds: [], maxPackets: 1 });
    const { id: _id, ...body } = base;
    const make = (packets: RelationPacket[]) => {
        if (new Set(packets.map(p => p.id)).size !== count) throw new Error("duplicate study packet; revise deterministic sampling before inference");
        return sealPlan({ ...body, coverage, jobs: engines.map(engine => ({ id: hash({ engine, packets: packets.map(p => p.id), snapshot: snapshot.digest }), side: "single", snapshot, packets, engine })) });
    };
    return { A: make(A), B: make(B), selection: { eligibleFunctions: eligible.length, sourceRevision: snapshot.revision, history: snapshot.history.boundary, countPerConstruct: count, seed: "sha256(unit.id); version 1", controls: "every fifth case sampled by hash; others lexical", A: A.map(p => ({ id: p.id, kind: p.kind, participants: p.participants })), B: B.map(p => ({ id: p.id, participants: p.participants })), candidateReference: "authored registry candidates only; study cases are not candidate-recall gold", scope: "single-repository development diagnostic; no deployment precision or scale claim" } };
}
function sampleNaturalRelationPackets(eligible: Unit[], count: number, policy: PolicyReference, A: RelationPacket[], snapshot: RelationSnapshot, B: RelationPacket[]) {
    const ordered = [...eligible].sort((a, b) => hash(a.id).localeCompare(hash(b.id)));
    for (let i = 0; i < count; i++) {
        const invariant = policy.policy.invariants[i % policy.policy.invariants.length]!;
        const ranked = lexicalCandidates(invariant.statement, eligible, eligible.length);
        // 20% uniformly selected hard/unrelated controls; 80% lexical candidates.
        const source = i % 5 === 0 ? ordered[i]! : ranked[i]!;
        const other = ranked[(i + 37) % ranked.length]!;
        const third = ranked[(i + 79) % ranked.length]!;
        const kind: RelationKind = i < 80 ? "invariant_membership" : i < 140 ? "invariant_role" : i < 185 ? "invariant_compatibility" : "invariant_group";
        const participants = kind === "invariant_group" ? [source, other, third] : kind === "invariant_compatibility" ? [source, other] : [source];
        const role = kind === "invariant_role" ? (["enforces", "assumes", "propagates", "reports", "tests"] as const)[i % 5]! : null;
        A.push(makeRelationPacket(kind, invariant, participants, snapshot, null, role));
        const scenario = policy.policy.scenarios.find(s => s.invariantId === invariant.id)!;
        B.push(makeRelationPacket("semantic_coupling", invariant, i % 2 ? [source, other] : [other, source], snapshot, scenario, null));
    }
}

export function compactBlindReview(plan: RelationPlan): unknown {
    const job = plan.jobs[0]!;
    const ids = new Set(job.packets.flatMap(p => p.participants));
    return { planId: plan.id, instructions: "Read all supplied implementations and policy. Independently label every case without accessing model predictions. Output RelationLabels schema; source astra_model_review, reviewer GPT-6 Astra, split development, blinded true. Use insufficient_evidence where external dependencies prevent a justified judgment; a missing supplied dependency is not proof of a bug. Include a short rationale and exact source quotes. Record caseId from this packet so repeated participants cannot inflate sample counts.", policy: plan.policy.policy, context: Object.fromEntries(plan.policy.policy.invariants.flatMap(i => i.contextFiles).filter(f => job.snapshot.files[f]).map(f => [f, job.snapshot.files[f]!.text])), units: job.snapshot.units.filter(u => ids.has(u.id)).map(u => ({ id: u.id, file: u.file, line: u.line, text: u.text })), cases: job.packets.map(p => ({ packetId: p.id, caseId: `${p.invariantId}:${p.participants.map(id => unitLogicalKey(job.snapshot.units.find(u => u.id === id)!)).sort().join("|")}`, kind: p.kind, invariantId: p.invariantId, scenarioId: p.scenarioId, role: p.queriedRole, participants: p.participants, complete: p.complete, missing: p.missing })) };
}
