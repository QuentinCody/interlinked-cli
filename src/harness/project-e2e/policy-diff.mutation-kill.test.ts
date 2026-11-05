import { describe, expect, it } from "vitest";
import { fixturePolicy } from "./__tests__/fixture-projects.js";
import { comparePolicies } from "./policy-diff.js";
import { parseE2ePolicy, type E2ePolicy } from "./policy.js";

type Json = Record<string, unknown> & { projects: Array<Record<string, unknown>> };
function policy(mutate: (json: Json) => void): E2ePolicy {
    const json = fixturePolicy("py") as Json; // SAFETY: fixture-authored JSON shape
    mutate(json);
    return parseE2ePolicy(JSON.stringify(json));
}
const kinds = (base: E2ePolicy, head: E2ePolicy) => comparePolicies(base, head, []).weakening.map(row => row.kind);

// Census fault: `GATE_RANK.off` 0 → 1 survived the companion test — only a
// require → warn transition was pinned (docs/reviews/kill-proof-census-e2e-structure.md).
describe("comparePolicies — turning a gate OFF is a weakening from every lower level too", () => {
    // test-contract: invariant — `off` ranks strictly below `warn`; a commit gate that stops warning is a loosened gate, not a refactor
    it("reports gate-loosened when a warn commit gate becomes off", () => {
        const base = policy(json => { json.projects[0]!.gates = { commit: "warn" }; });
        const head = policy(json => { json.projects[0]!.gates = { commit: "off" }; });
        const comparison = comparePolicies(base, head, []);
        expect(comparison.weakening.map(row => row.kind)).toEqual(["gate-loosened"]);
        expect(comparison.weakening[0]!.detail).toMatch(/gates\.commit warn → off/);
    });
    // test-contract: invariant — the Stop reminder defaults to warn, so silencing it (stop: off) is a weakening even when the base wrote nothing
    it("reports gate-loosened when the default warn stop gate is turned off", () => {
        const base = policy(json => { json.projects[0]!.gates = { commit: "require" }; });
        const head = policy(json => { json.projects[0]!.gates = { commit: "require", stop: "off" }; });
        expect(kinds(base, head)).toEqual(["gate-loosened"]);
    });
});
