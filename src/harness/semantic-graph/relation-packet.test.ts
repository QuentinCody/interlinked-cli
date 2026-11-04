import { expect, it } from "vitest";
import { makeRelationPacket } from "./relation-packet.js";
import { validatePacketPopulation } from "../../lib/decision-metrics/relation-contracts.js";
const invariant = { id: "I", version: "1", statement: "Missing evidence is unavailable", applicability: "verification", clauses: ["Missing evidence is not passing"], exceptions: [], participants: [], groups: [], contextFiles: [] };
const a = { id: "a", kind: "function" as const, file: "a.ts", name: "a", line: 1, endLine: 1, text: "function a() {}", hash: "a" };
it("keeps direction, role, group and incomplete evidence distinct", () => {
    const b = { ...a, id: "b", name: "b", file: "b.ts" };
    const make = (participants: typeof a[]) => makeRelationPacket("invariant_compatibility", invariant, participants, { files: {}, omitted: [] }, null, null);
    expect(make([a, b]).logicalKey).not.toBe(make([b, a]).logicalKey);
    const group = makeRelationPacket("invariant_group", invariant, [a, b], { files: {}, omitted: [] }, null, null);
    expect(group.unit).toBe("group"); expect(validatePacketPopulation(group).id).toBe("invariant_group");
    expect(() => validatePacketPopulation({ ...group, unit: "pair" })).toThrow();
    const incomplete = makeRelationPacket("invariant_group", invariant, [a, b], { files: {}, omitted: [] }, null, null, 2);
    expect(incomplete.complete).toBe(false); expect(incomplete.evidence.participants).toEqual([a, b]);
});
