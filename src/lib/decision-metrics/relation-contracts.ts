import { CATALOG, selectEvidence } from "./contracts.js";
import type { DecisionQuestion } from "./types.js";
import type { RelationKind, RelationPacket } from "../../harness/semantic-graph/relation-types.js";

export interface RelationContract extends DecisionQuestion {
    id: RelationKind; version: "1"; unit: "pair" | "group"; populationId: string; phase: "research";
}
const uncertain = { insufficient_evidence: "The supplied evidence does not establish an answer" };
function contract(id: RelationKind, unit: "pair" | "group", question: string, on: string[], options: Record<string, string>): RelationContract {
    return { id, version: "1", unit, populationId: `${id.replaceAll("_", "-")}/v1`, phase: "research", kind: "choose", question, on, options: { ...options, ...uncertain } };
}
export const RELATION_CONTRACTS: Record<RelationKind, RelationContract> = {
    invariant_membership: contract("invariant_membership", "pair", "Does this implementation participate in this explicit invariant within its declared scope? Judge supplied evidence, not shared vocabulary alone.", ["/invariant", "/participant", "/context"], { related: "Participates in the invariant", unrelated: "Does not participate" }),
    invariant_role: contract("invariant_role", "pair", "Does the supplied implementation perform the specified role for this invariant? Other roles may also apply; assess only the requested role.", ["/invariant", "/participant", "/role", "/context"], { present: "Performs the requested role", absent: "Does not perform the requested role" }),
    invariant_compatibility: contract("invariant_compatibility", "pair", "Are these implementations compatible with the explicit invariant, scope, and listed exceptions? A shared name or shape is not compatibility evidence.", ["/invariant", "/left", "/right", "/context"], { compatible: "Compatible with the invariant", contradictory: "Their behavior or assumptions contradict the invariant" }),
    invariant_group: contract("invariant_group", "group", "Do these participants jointly preserve the stated invariant? Inspect their composition; pairwise compatibility alone does not establish this. Only explicit exceptions apply.", ["/invariant", "/participants", "/context"], { compatible: "Jointly compatible", contradictory: "The composition contradicts the invariant" }),
    semantic_coupling: { ...CATALOG.semantic_coupling!, id: "semantic_coupling", version: "1", unit: "pair", phase: "research", populationId: "semantic-coupling/v1" },
};
export function validatePacketPopulation(packet: RelationPacket): RelationContract {
    const expected = RELATION_CONTRACTS[packet.kind];
    if (!expected || packet.populationId !== expected.populationId || packet.unit !== expected.unit) throw new Error("relation population/contract mismatch");
    if (packet.unit === "group" && (packet.participants.length > 6 || (packet.complete && packet.participants.length < 2))) throw new Error("group requires 2..6 explicit participants");
    if (packet.complete && packet.kind !== "invariant_group" && packet.participants.length !== (["invariant_membership", "invariant_role"].includes(packet.kind) ? 1 : 2)) throw new Error("relation participant count mismatch");
    selectEvidence(packet.evidence, expected.on);
    return expected;
}
