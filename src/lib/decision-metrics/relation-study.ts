import { hash } from "../../harness/semantic-graph/relation-core.js";
import { makeRelationPacket, unitLogicalKey } from "../../harness/semantic-graph/relation-packet.js";
import { lexicalCandidates, prepareRelations, sealPlan } from "../../harness/semantic-graph/relation-plan.js";
import type { EngineSpec, InvariantDefinition, PolicyReference, RelationPacket, RelationPlan, RelationSnapshot } from "../../harness/semantic-graph/relation-types.js";
import type { Unit } from "../../harness/semantic-graph/types.js";

/** Fixed exploratory cohort. Selection reads no predictions or reference labels. */
export function naturalRelationStudies(snapshot: RelationSnapshot, policy: PolicyReference, engines: EngineSpec[], count = 200): { A: RelationPlan; B: RelationPlan; selection: unknown } {
    const eligible = snapshot.units.filter(u => u.kind === "function" && u.text.length >= 120 && u.text.length <= 2000 && !/\.(test|spec)\.|__tests__/.test(u.file));
    if (eligible.length < count) throw new Error(`natural cohort requires ${count} eligible functions; found ${eligible.length}`);
    const coverage = [3, 6, 10, 12].flatMap(k => (["shared_rules", "lexical"] as const).flatMap(method => prepareRelations(snapshot, policy, engines.slice(0, 1), { mode: "retrieved", method, k, kinds: [], maxPackets: 1 }).coverage));
    const { A, B } = sampleNaturalRelationPackets(eligible, count, policy, snapshot);
    const base = prepareRelations(snapshot, policy, engines, { mode: "curated", method: "shared_rules", k: 10, kinds: [], maxPackets: 1 });
    const { id: _id, ...body } = base;
    const make = (packets: RelationPacket[]) => {
        if (new Set(packets.map(p => p.id)).size !== count) throw new Error("duplicate study packet; revise deterministic sampling before inference");
        return sealPlan({ ...body, coverage, jobs: engines.map(engine => ({ id: hash({ engine, packets: packets.map(p => p.id), snapshot: snapshot.digest }), side: "single", snapshot, packets, engine })) });
    };
    return { A: make(A), B: make(B), selection: { eligibleFunctions: eligible.length, sourceRevision: snapshot.revision, history: snapshot.history.boundary, countPerConstruct: count, seed: "sha256(unit.id); version 1", controls: "every fifth case sampled by hash; others lexical", A: A.map(p => ({ id: p.id, kind: p.kind, participants: p.participants })), B: B.map(p => ({ id: p.id, participants: p.participants })), candidateReference: "authored registry candidates only; study cases are not candidate-recall gold", scope: "single-repository development diagnostic; no deployment precision or scale claim" } };
}
function invariantStudyPacket(index: number, invariant: InvariantDefinition, source: Unit, other: Unit, third: Unit, snapshot: RelationSnapshot) {
    if (index < 80) return makeRelationPacket("invariant_membership", invariant, [source], snapshot, null, null);
    if (index < 140) {
        const roles = ["enforces", "assumes", "propagates", "reports", "tests"] as const;
        return makeRelationPacket("invariant_role", invariant, [source], snapshot, null, roles[index % roles.length]!);
    }
    if (index < 185) return makeRelationPacket("invariant_compatibility", invariant, [source, other], snapshot, null, null);
    return makeRelationPacket("invariant_group", invariant, [source, other, third], snapshot, null, null);
}

function sampleNaturalRelationPackets(eligible: Unit[], count: number, policy: PolicyReference, snapshot: RelationSnapshot) {
    const ordered = eligible.map(unit => ({ unit, key: hash(unit.id) })).sort((a, b) => a.key.localeCompare(b.key));
    const rankings = new Map<string, Unit[]>();
    const A: RelationPacket[] = [], B: RelationPacket[] = [];
    for (let i = 0; i < count; i++) {
        const invariant = policy.policy.invariants[i % policy.policy.invariants.length]!;
        const ranked = rankings.get(invariant.statement) ?? lexicalCandidates(invariant.statement, eligible, eligible.length);
        rankings.set(invariant.statement, ranked);
        // Every fifth case is a hash-selected control; the rest follow lexical rank.
        const source = i % 5 === 0 ? ordered[i]!.unit : ranked[i]!;
        const other = ranked[(i + 37) % ranked.length]!;
        const third = ranked[(i + 79) % ranked.length]!;
        A.push(invariantStudyPacket(i, invariant, source, other, third, snapshot));
        const scenario = policy.policy.scenarios.find(s => s.invariantId === invariant.id)!;
        B.push(makeRelationPacket("semantic_coupling", invariant, i % 2 ? [source, other] : [other, source], snapshot, scenario, null));
    }
    return { A, B };
}

export function compactBlindReview(plan: RelationPlan): unknown {
    const job = plan.jobs[0]!;
    const ids = new Set(job.packets.flatMap(p => p.participants));
    const units = job.snapshot.units.filter(unit => ids.has(unit.id));
    const keys = new Map(units.map(unit => [unit.id, unitLogicalKey(unit)]));
    const { policy } = plan.policy;
    const context = policy.invariants.flatMap(invariant => invariant.contextFiles)
        .filter(file => job.snapshot.files[file])
        .map(file => [file, job.snapshot.files[file]!.text]);
    const participantKey = (id: string) => {
        const key = keys.get(id);
        if (key === undefined) throw new Error("review participant missing from snapshot");
        return key;
    };
    return {
        planId: plan.id,
        instructions: "Read all supplied implementations and policy. Independently label every case without accessing model predictions. Output RelationLabels schema; source astra_model_review, reviewer GPT-6 Astra, split development, blinded true. Use insufficient_evidence where external dependencies prevent a justified judgment; a missing supplied dependency is not proof of a bug. Include a short rationale and exact source quotes. Record caseId from this packet so repeated participants cannot inflate sample counts.",
        policy, context: Object.fromEntries(context),
        units: units.map(u => ({ id: u.id, file: u.file, line: u.line, text: u.text })),
        cases: job.packets.map(p => ({
            packetId: p.id, caseId: p.invariantId + ":" + p.participants.map(participantKey).sort().join("|"),
            kind: p.kind, invariantId: p.invariantId, scenarioId: p.scenarioId, role: p.queriedRole,
            participants: p.participants, complete: p.complete, missing: p.missing,
        })),
    };
}
