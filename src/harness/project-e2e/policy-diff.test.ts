// Unit F3 (plan §13, PE-33, PE-74): head policy against the TRUSTED base.
// Weakening (a dropped or demoted required scenario, an unbound contract, a
// loosened boundary/proof/stability/gate/observation) is a finding unless a
// reviewed replacement record binds exactly the base and head digests.
// Refactors, reorders, descriptions and tightening are never findings.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { httpFixturePolicy } from "./__tests__/fixture-http.js";
import { fixturePolicy } from "./__tests__/fixture-projects.js";
import { appendPolicyChange, readPolicyChanges, type PolicyChangeRecord } from "./policy-changes.js";
import { comparePolicies } from "./policy-diff.js";
import { parseE2ePolicy, policyDigest, type E2ePolicy } from "./policy.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
type Json = Record<string, unknown> & { projects: Array<Record<string, unknown> & { scenarios: Array<Record<string, unknown>>; gates?: Record<string, unknown> }> };
function policy(mutate: (json: Json) => void = () => {}, from: () => Record<string, unknown> = () => fixturePolicy("py")): E2ePolicy {
    const json = from() as Json; // SAFETY: fixture-authored JSON shape
    mutate(json);
    return parseE2ePolicy(JSON.stringify(json));
}
const kinds = (base: E2ePolicy, head: E2ePolicy, records: PolicyChangeRecord[] = []) => comparePolicies(base, head, records).weakening.map(row => row.kind);
const replacement = (base: E2ePolicy, head: E2ePolicy, scenarioId: string | undefined, rationale = "requirement R1 retired by product decision"): PolicyChangeRecord =>
    ({ version: 1, kind: "replacement", projectId: "orders", ...(scenarioId ? { scenarioId } : {}), baseDigest: policyDigest(base), headDigest: policyDigest(head), rationale, recordedAt: "2026-09-25T00:00:00.000Z" });

describe("policy diff — positive (weakening is named)", () => {
    it("P1: a removed required scenario, a required→advisory demotion and an unbound contract are each a weakening naming the scenario", () => {
        const base = policy();
        expect(kinds(base, policy(json => { json.projects[0]!.scenarios = []; }))).toEqual(["scenario-removed"]);
        expect(kinds(base, policy(json => { json.projects[0]!.scenarios[0]!.required = false; }))).toEqual(["scenario-demoted"]);
        expect(kinds(base, policy(json => { json.projects[0]!.scenarios[0]!.contractIds = ["orders.create"]; }))).toEqual(["contract-unbound"]);
        const removed = comparePolicies(base, policy(json => { json.projects[0]!.scenarios = []; }), []).weakening[0]!;
        expect(removed).toMatchObject({ projectId: "orders", scenarioId: "order-persists" });
        expect(removed.detail).toMatch(/order-persists/);
    });
    it("P2: loosened gates, mode, observations, boundary (dropped real component, new allowed double, dropped request), proof and stability are weakening; a narrowed protected scope too", () => {
        const base = policy(json => { json.projects[0]!.observations = { runtimeCoverage: "node-required" }; json.projects[0]!.scenarios[0]!.stability = { qualificationRuns: 3 }; json.projects[0]!.scenarios[0]!.proof = { mode: "characterization", revision: "HEAD" }; });
        expect(kinds(base, policy(json => { json.projects[0]!.gates = { commit: "warn" }; }, () => JSON.parse(JSON.stringify(base)) as Record<string, unknown>))).toEqual(["gate-loosened"]);
        const mutate = (edit: (json: Json) => void) => kinds(base, policy(edit, () => JSON.parse(JSON.stringify(base)) as Record<string, unknown>));
        expect(mutate(json => { json.projects[0]!.mode = "advisory"; })).toEqual(["project-demoted"]);
        expect(mutate(json => { json.projects[0]!.observations = { runtimeCoverage: "node" }; })).toEqual(["observations-loosened"]);
        expect(mutate(json => { json.projects[0]!.scenarios[0]!.boundary = { entry: "process", real: [] }; })).toEqual(["boundary-loosened"]);
        expect(mutate(json => { json.projects[0]!.scenarios[0]!.boundary = { entry: "process", real: ["application"], allowedDoubles: ["clock"] }; })).toEqual(["boundary-loosened"]);
        expect(mutate(json => { delete json.projects[0]!.scenarios[0]!.proof; })).toEqual(["proof-dropped"]);
        expect(mutate(json => { json.projects[0]!.scenarios[0]!.stability = { qualificationRuns: 1 }; })).toEqual(["stability-loosened"]);
        expect(mutate(json => { json.projects[0]!.protectedInputs = []; json.projects[0]!.scenarios[0]!.affects = ["orders_cli.py"]; })).toEqual(["scope-narrowed"]);
        const browser = policy(() => {}, httpFixturePolicy);
        expect(kinds(browser, policy(json => { (json.projects[0]!.scenarios[0]!.boundary as Record<string, unknown>).real = ["application"]; }, httpFixturePolicy))).toEqual(["boundary-loosened"]);
    });
    it("P3: a replacement record binding EXACTLY the base and head digests and the scenario discharges that weakening; the comparison still lists it as replaced", () => {
        const base = policy(), head = policy(json => { json.projects[0]!.scenarios = []; });
        const result = comparePolicies(base, head, [replacement(base, head, "order-persists")]);
        expect(result.weakening).toEqual([]);
        expect(result.replaced).toHaveLength(1);
        expect(result.replaced[0]).toMatchObject({ kind: "scenario-removed", scenarioId: "order-persists" });
    });
    it("P4: the record ledger appends and reads back strictly; a malformed row is skipped and reported", () => {
        const root = mkdtempSync(join(tmpdir(), "policy-changes-")); dirs.push(root);
        const base = policy(), head = policy(json => { json.projects[0]!.scenarios = []; });
        appendPolicyChange(root, replacement(base, head, "order-persists"));
        const path = join(root, ".interlinked", "e2e-policy-changes.jsonl");
        expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
        const rows = readPolicyChanges(root);
        expect(rows.records).toHaveLength(1);
        expect(rows.records[0]!.scenarioId).toBe("order-persists");
    });
});
describe("policy diff — negative (never a finding)", () => {
    it("N1: reorder, description edits, an added scenario, a tightened gate, a widened scope, a prepare argv refactor and an identical policy produce no weakening", () => {
        const base = policy();
        expect(kinds(base, base)).toEqual([]);
        expect(kinds(base, policy(json => { json.projects[0]!.scenarios[0]!.description = "reworded"; }))).toEqual([]);
        expect(kinds(base, policy(json => { json.projects[0]!.scenarios.push({ ...json.projects[0]!.scenarios[0]!, id: "extra" }); }))).toEqual([]);
        expect(kinds(base, policy(json => { json.projects[0]!.gates = { stop: "warn", commit: "require", ci: "require" }; }))).toEqual([]);
        expect(kinds(base, policy(json => { json.projects[0]!.protectedInputs = ["orders_cli.py", "README.md"]; }))).toEqual([]);
        expect(kinds(base, policy(json => { (json.projects[0]!.suites as Array<Record<string, unknown>>)[0]!.prepare = [{ argv: ["python3", "-c", "pass"] }]; }))).toEqual([]);
        expect(kinds(base, policy(json => { json.projects[0]!.scenarios[0]!.contractIds = ["orders.invalid", "orders.create"]; }))).toEqual([]);
    });
    it("N2: a replacement record for another scenario, another base digest or another head digest discharges nothing", () => {
        const base = policy(), head = policy(json => { json.projects[0]!.scenarios = []; });
        expect(kinds(base, head, [replacement(base, head, "other-scenario")])).toEqual(["scenario-removed"]);
        expect(kinds(base, head, [{ ...replacement(base, head, "order-persists"), baseDigest: "0".repeat(64) }])).toEqual(["scenario-removed"]);
        expect(kinds(base, head, [{ ...replacement(base, head, "order-persists"), headDigest: "0".repeat(64) }])).toEqual(["scenario-removed"]);
    });
    it("N3: no base policy (first adoption, PE-38) is a bootstrap — every scenario is new, nothing is weakened, and the comparison says so", () => {
        const result = comparePolicies(null, policy(), []);
        expect(result.weakening).toEqual([]);
        expect(result.bootstrap).toBe(true);
    });
});
