import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { hash } from "../../harness/semantic-graph/relation-core.js";
import { parseRelationPlan, parseRelationRun } from "../../harness/semantic-graph/relation-codec.js";
import { prepareRelations, sealPlan } from "../../harness/semantic-graph/relation-plan.js";
import { comparePairedRun, pairedRelationPlan } from "../../harness/semantic-graph/relation-compare.js";
import { freezeRelations, implementationSources, loadRelationArtifact, planFromArtifact } from "../../harness/semantic-graph/relation-freeze.js";
import type { EngineSpec } from "../../harness/semantic-graph/relation-types.js";
import { assessRelations } from "./relation-assess.js";
import { clopperPearsonOneSided, auditRelations } from "./relation-audit.js";
import { fixtureRelationPlan } from "./relation-fixtures.js";
import { RELATION_CONTRACTS } from "./relation-contracts.js";
import type { RelationBackend } from "./relation-engines.js";
import { haikuArgs, haikuEnvironment, validateHaikuIsolation } from "./relation-haiku.js";

const engine: EngineSpec = { id: "J", backend: "typesafe", model: "fixture-model", identity: "fixture-model", command: null, endpoint: null, effort: null, maxCalls: 100, maxUsd: 1, timeoutMs: 1000, band: [.2,.8] };
const dirs: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "relation-workflow-")); dirs.push(root); return root; };
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
const backend: RelationBackend = async (engine, packet) => {
    const choice = Object.keys(RELATION_CONTRACTS[packet.kind].options!)[0]!;
    return { raw: { kind: "choice", probabilities: Object.fromEntries(Object.keys(RELATION_CONTRACTS[packet.kind].options!).map(k => [k, Number(k === choice)])) }, servedModel: engine.model, response: { fixture: true }, calls: 1, costUsd: .001, inputTokens: 50, failure: null, probabilitySource: "backend_distribution" };
};

test("freeze closes over source and rejects resealed packet source substitution", () => {
    expect(implementationSources()["src/harness/jev/client.ts"]).toContain("class JevClient");
    const { plan } = fixtureRelationPlan([engine]);
    const root = temp(); freezeRelations(root, plan, join(root, "input"));
    expect(planFromArtifact(loadRelationArtifact(join(root, "input")), true).id).toBe(plan.id);
    const packet = plan.jobs[0]!.packets[2]!;
    packet.evidence.participant = { text: "fabricated passing result" };
    packet.evidenceHash = hash({ evidence: packet.evidence, dependencies: packet.dependencies, missing: packet.missing });
    packet.id = hash({ logicalKey: packet.logicalKey, evidenceHash: packet.evidenceHash });
    const { id: _id, ...body } = plan;
    expect(() => parseRelationPlan(sealPlan(body))).toThrow("pinned source");
});

test("paired plan is consumable; cache reuse preserves costs and unresolved side cannot look repaired", async () => {
    const root = temp(), { plan, labels } = fixtureRelationPlan([{ ...engine, maxCalls: 16 }]);
    const first = await assessRelations(root, plan, { backend });
    expect(parseRelationRun(first).measurements).toHaveLength(16);
    const paired = pairedRelationPlan(first, first);
    const rerun = await assessRelations(temp(), paired, { backend });
    expect(rerun.measurements).toHaveLength(32);
    expect(rerun.measurements.slice(16).every(m => m.cached && m.calls === 0)).toBe(true);
    expect(comparePairedRun(rerun).rows.every(r => r.outcome === "same_assessment")).toBe(true);
    const failed = structuredClone(rerun); failed.measurements[16]!.status = "failed"; failed.measurements[16]!.choice = null;
    const { id: _id, ...body } = failed; failed.id = hash(body);
    expect(comparePairedRun(failed).rows[0]!.outcome).toBe("non_comparable");
    expect((auditRelations(first, labels) as { incomplete: boolean }).incomplete).toBe(false);
});

test("missing reference opportunities and distinct incomplete groups survive candidate preparation", () => {
    const { plan } = fixtureRelationPlan([engine]), snapshot = plan.jobs[0]!.snapshot;
    const policy = structuredClone(plan.policy), invariant = policy.policy.invariants[0]!;
    policy.policy.invariants = [invariant]; policy.policy.scenarios = [];
    invariant.participants.push("missing");
    invariant.groups = [[...invariant.participants.slice(0, 2), "missing-x"], [...invariant.participants.slice(0, 2), "missing-y"]];
    policy.digest = hash(policy.policy);
    const prepared = prepareRelations(snapshot, policy, [engine], { mode: "curated", method: "shared_rules", k: 3, kinds: ["invariant_group"], maxPackets: 100 });
    expect(prepared.coverage[0]!.reference).toHaveLength(2);
    expect(prepared.coverage[0]!.reference).toContain("unresolved:missing");
    expect(prepared.jobs[0]!.packets).toHaveLength(2);
    expect(prepared.jobs[0]!.packets.every(p => !p.complete)).toBe(true);
    expect(parseRelationPlan(prepared)).toEqual(prepared);
});

test("one-sided exact binomial convention reproduces the preregistered boundary", () => {
    expect(clopperPearsonOneSided(75, 83)!.lower).toBeCloseTo(.832805, 5);
    expect(clopperPearsonOneSided(8, 300)!.upper).toBeCloseTo(.047600, 5);
    expect(clopperPearsonOneSided(9, 300)!.upper).toBeGreaterThan(.05);
    expect(clopperPearsonOneSided(0, 0)).toBeNull();
    expect(clopperPearsonOneSided(0, 100)!.lower).toBe(0);
    expect(clopperPearsonOneSided(100, 100)!.upper).toBe(1);
});

test("H rejects available tools and attempted calls even when the response looks valid", () => {
    expect(haikuEnvironment().USER).toBe(process.env.USER);
    expect(haikuEnvironment().HOME).toBe(process.env.HOME);
    const args = haikuArgs({ ...engine, backend: "haiku" });
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--safe-mode"); expect(args).toContain("--strict-mcp-config");
    const envelope = { argv: args, cliIdentity: "fixture", events: [{ type: "system", subtype: "init", tools: [], mcp_servers: [], model: "fixture" }, { type: "result", result: "{}", is_error: false, total_cost_usd: .01 }], exitCode: 0, timedOut: false, truncated: false };
    expect(validateHaikuIsolation(envelope).model).toBe("fixture");
    expect(() => validateHaikuIsolation({ ...envelope, events: [{ ...envelope.events[0], tools: ["Read"] }, envelope.events[1]!] })).toThrow("tool inventory");
    expect(() => validateHaikuIsolation({ ...envelope, events: [...envelope.events, { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }] })).toThrow("attempted tool");
});

test("failed calls and budget exclusions retain full cohort membership", async () => {
    const root = temp(), { plan } = fixtureRelationPlan([{ ...engine, maxCalls: 2 }]);
    const run = await assessRelations(root, plan, { backend: async () => { throw new Error("unavailable"); } });
    expect(run.measurements).toHaveLength(16);
    expect(run.measurements.filter(m => m.status === "failed")).toHaveLength(1);
    expect(run.measurements.filter(m => m.status === "unassessed")).toHaveLength(15);
});

test("run parser rejects mismatched interpretations and fabricated accounting", async () => {
    const { plan } = fixtureRelationPlan([engine]);
    const run = await assessRelations(temp(), plan, { backend });
    for (const changes of [{ choice: "contradictory" }, { calls: -1 }, { costUsd: -100 }, { engineIdentity: "different" }]) {
        const changed = structuredClone(run); Object.assign(changed.measurements[0]!, changes);
        const { id: _id, ...body } = changed; changed.id = hash(body);
        expect(() => parseRelationRun(changed)).toThrow();
    }
});

test("an unchanged participant is remeasured when another snapshot dependency changes", async () => {
    const root = temp(), { plan } = fixtureRelationPlan([engine]);
    await assessRelations(root, plan, { backend });
    const changed = structuredClone(plan), snapshot = changed.jobs[0]!.snapshot;
    snapshot.tree = hash("shared declaration changed");
    const { digest: _digest, ...snapshotBody } = snapshot; snapshot.digest = hash(snapshotBody);
    const { id: _id, ...body } = changed;
    const run = await assessRelations(root, sealPlan(body), { backend });
    expect(run.measurements.every(m => !m.cached && m.calls === 1)).toBe(true);
    expect(parseRelationRun(run).complete).toBe(true);
});
