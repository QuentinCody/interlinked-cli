import { expect, test } from "vitest";
import { executeRelationFixtures, fixtureRelationPlan, RELATION_FIXTURES } from "./relation-fixtures.js";
import { relationRequest } from "./relation-engines.js";

test("all eight invariant and eight directed coupling mechanisms execute their counterexample/control", () => {
    const results = executeRelationFixtures();
    expect(results).toHaveLength(16);
    expect(results.filter(r => !r.passed)).toEqual([]);
});

test("fixture requests conceal descriptive reference IDs in paths and policy metadata", () => {
    const engine = { id: "J", backend: "typesafe" as const, model: "jev-test", identity: "jev-test", command: null, endpoint: null, effort: null, maxCalls: 20, maxUsd: 1, timeoutMs: 1000, band: [.2, .8] as const };
    const { plan, labels } = fixtureRelationPlan([engine]);
    const requests = JSON.stringify(plan.jobs[0]!.packets.map(relationRequest));
    for (const fixture of RELATION_FIXTURES) expect(requests).not.toContain(fixture.id);
    expect(labels.labels.map(l => l.caseId)).toEqual(RELATION_FIXTURES.map(f => f.id));
});
