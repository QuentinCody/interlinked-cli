import { hash } from "./relation-core.js";
import { RELATION_CONTRACTS } from "../../lib/decision-metrics/relation-contracts.js";
import type { Json } from "../../lib/decision-metrics/types.js";
import type { InvariantDefinition, InvariantRole, RelationKind, RelationPacket, RelationSnapshot, ScenarioDefinition } from "./relation-types.js";
import type { Unit } from "./types.js";

export function unitLogicalKey(unit: Unit): string { return `${unit.file}#${unit.kind}:${unit.name}`; }
export function selectUnits(units: Unit[], selector: string): Unit[] {
    return units.filter(unit => unit.id === selector || unitLogicalKey(unit) === selector || `${unit.file}#${unit.name}` === selector || unit.file === selector);
}
export function makeRelationPacket(kind: RelationKind, invariant: InvariantDefinition, participants: Unit[], snapshot: Pick<RelationSnapshot, "files" | "omitted">, scenario: ScenarioDefinition | null, role: InvariantRole | null, maxBytes = 24000, expectedParticipants = participants.map(unitLogicalKey)): RelationPacket {
    const contract = RELATION_CONTRACTS[kind];
    const missing = invariant.contextFiles.filter(file => !snapshot.files[file]).map(file => `missing_context:${file}`);
    const { evidence, context } = relationPacketEvidence(invariant, snapshot, missing, kind, participants, role, scenario);
    if (!participants.length || (kind === "semantic_coupling" && (!scenario || participants.length !== 2))) missing.push("missing_participant_or_scenario");
    if (Buffer.byteLength(JSON.stringify(evidence)) > maxBytes) missing.push("evidence_budget_exceeded");
    const dependencies = Object.fromEntries([...participants.map(p => [`unit:${p.id}`, p.hash]), ...context.filter(c => c.hash).map(c => [`file:${c.file}`, c.hash!])]);
    const logicalKey = hash({ kind, invariant: [invariant.id, invariant.version], scenario: scenario ? [scenario.id, scenario.version] : null, role, participants: expectedParticipants });
    const evidenceHash = hash({ evidence, dependencies, missing });
    return { schema: "interlinked.relation-packet/1", id: hash({ logicalKey, evidenceHash }), logicalKey, kind, populationId: contract.populationId, unit: contract.unit, participants: participants.map(p => p.id), expectedParticipants, invariantId: invariant.id, scenarioId: scenario?.id ?? null, queriedRole: role, evidence, dependencies, complete: missing.length === 0, missing, evidenceHash };
}

function relationPacketEvidence(invariant: InvariantDefinition, snapshot: Pick<RelationSnapshot, "files" | "omitted">, missing: string[], kind: string, participants: Unit[], role: string | null, scenario: ScenarioDefinition | null) {
    const context = invariant.contextFiles.map(file => ({ file, text: snapshot.files[file]?.text ?? null, hash: snapshot.files[file]?.hash ?? null }));
    const invariantEvidence = { id: invariant.id, version: invariant.version, statement: invariant.statement, applicability: invariant.applicability, clauses: invariant.clauses, exceptions: invariant.exceptions };
    const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
    const evidence: Record<string, Json> = { invariant: asJson(invariantEvidence), context: asJson({ supplied: context, missing }) };
    if (kind === "invariant_group") evidence.participants = asJson(participants);
    else if (kind === "invariant_membership" || kind === "invariant_role") { evidence.participant = asJson(participants[0] ?? null); if (role) evidence.role = role; }
    else {
        evidence.left = asJson({ implementation: participants[0] ?? null, context });
        evidence.right = asJson({ implementation: participants[1] ?? null, context });
        if (kind === "semantic_coupling") evidence.scenario = asJson({ ...scenario, invariant: invariantEvidence });
    }
    return { evidence, context };
}
