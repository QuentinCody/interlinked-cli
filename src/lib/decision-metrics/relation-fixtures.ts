import { runInNewContext } from "node:vm";
import { hash, textHash } from "../../harness/semantic-graph/relation-core.js";
import { makeRelationPacket } from "../../harness/semantic-graph/relation-packet.js";
import { sealPlan } from "../../harness/semantic-graph/relation-plan.js";
import type { EngineSpec, InvariantDefinition, RelationKind, RelationPlan, RelationSnapshot, ScenarioDefinition } from "../../harness/semantic-graph/relation-types.js";
import type { Unit } from "../../harness/semantic-graph/types.js";
import { RELATION_CONTRACTS } from "./relation-contracts.js";
import type { RelationLabels } from "./relation-audit.js";

interface Fixture { id: string; kind: RelationKind; code: string[]; choice: string; check: string; scenario?: string; role?: "enforces"; exception?: string; }
export function fixtureEvidenceId(id: string): string { return `case-${hash(id).slice(0, 16)}`; }
export const RELATION_FIXTURES: Fixture[] = [
    { id: "A-equivalent-control-flow", kind: "invariant_compatibility", code: ['function left(s) { return s === "passed"; }', 'function right(s) { switch(s) { case "passed": return true; default: return false; } }'], choice: "compatible", check: '["failed","unavailable","deferred","passed"].every(s => left(s) === right(s))' },
    { id: "A-inverted-default", kind: "invariant_compatibility", code: ['function left(s) { return s === "passed"; }', 'function right(s) { return s !== "failed"; }'], choice: "contradictory", check: 'left("unavailable") === false && right("unavailable") === true' },
    { id: "A-vocabulary-distractor", kind: "invariant_membership", code: ['function statusLabel(status) { return "color-" + status; }'], choice: "unrelated", check: 'statusLabel("passed") === "color-passed" && typeof statusLabel("unavailable") === "string"' },
    { id: "A-explicit-exception", kind: "invariant_compatibility", code: ['function left(s) { return s === "passed"; }', 'function diagnosticOnly(s) { return s === "failed" ? ["failure"] : []; }'], choice: "compatible", exception: "diagnosticOnly returns findings only, does not attest pass, and has no verification consumer. Empty findings is permitted for unavailable tools.", check: 'left("unavailable") === false && diagnosticOnly("unavailable").length === 0' },
    { id: "A-composition-loses-status", kind: "invariant_group", code: ['function producer() { return {status:"unavailable", findings:[]}; }', 'function flatten(result) { return result.findings; }', 'function attest(rows) { return rows.length === 0; }'], choice: "contradictory", check: 'producer().status === "unavailable" && attest(flatten(producer())) === true' },
    { id: "A-boundary-assumptions", kind: "invariant_group", code: ['function producer() { return {status:"unavailable", findings:[]}; }', 'function forward(result) { return result; }', 'function attest(result) { return result.status === "passed"; }'], choice: "compatible", check: 'attest(forward(producer())) === false' },
    { id: "A-enforcement-role", kind: "invariant_role", role: "enforces", code: ['function permitVerification(result) { if (result.status !== "passed") return false; return true; }'], choice: "present", check: '["failed","deferred","unavailable"].every(status => !permitVerification({status})) && permitVerification({status:"passed"})' },
    { id: "A-missing-policy-context", kind: "invariant_membership", code: ['function adapter(result) { return externalPolicy(result); }'], choice: "insufficient_evidence", check: 'typeof externalPolicy === "undefined"' },
    { id: "B-required-update", kind: "semantic_coupling", code: ['function left() { return false; }', 'function right() { return Boolean(left()); }'], scenario: 'left will return {status:"passed"|"unavailable"} instead of boolean. right must continue returning true only for passed checks. Must right change?', choice: "update", check: 'right() === false && Boolean({status:"unavailable"}) === true' },
    { id: "B-verification-only", kind: "semantic_coupling", code: ['function left() { return {status:"failed"}; }', 'function right() { return left().status === "passed"; }'], scenario: 'left adds {status:"unavailable"} alongside passed and failed results. Preserve right behavior: true only for passed. Assess counterpart work.', choice: "verify_only", check: 'right() === false && ({status:"unavailable"}).status !== "passed"' },
    { id: "B-unaffected-consumer", kind: "semantic_coupling", code: ['function left() { return {status:"failed", id:"check-1"}; }', 'function right() { return left().id; }'], scenario: 'left adds unavailable to status; id remains exactly unchanged. right only formats the id and makes no verification claim. Assess counterpart work.', choice: "independent", check: 'right() === "check-1"' },
    { id: "B-no-import-policy-twin", kind: "semantic_coupling", code: ['function left(s) { return s !== "failed"; }', 'function right(s) { return s !== "failed"; }'], scenario: 'The shared verification policy now includes unavailable as a non-pass. left is changed to return s === "passed". right independently enforces the same policy in another adapter. Assess counterpart work in right.', choice: "update", check: 'right("unavailable") === true && ("unavailable" === "passed") === false' },
    { id: "B-direction-reversal", kind: "semantic_coupling", code: ['function left() { return producer().id.toUpperCase(); }', 'function producer() { return {status:"failed",id:"check-1"}; }'], scenario: 'left changes its presentation to lowercase the id. producer supplies the same id and status as before and never consumes left. Assess counterpart work in producer.', choice: "independent", check: 'left() === "CHECK-1" && producer().id === "check-1"' },
    { id: "B-context-unavailable", kind: "semantic_coupling", code: ['function left(s) { return policyTransform(s); }', 'function right(s) { return projectAdapter(s); }'], scenario: 'left changes its result encoding. Neither policyTransform nor projectAdapter nor their integration is supplied. Determine whether right must be updated.', choice: "insufficient_evidence", check: 'typeof policyTransform === "undefined" && typeof projectAdapter === "undefined"' },
    { id: "B-target-schema-update", kind: "semantic_coupling", code: ['function left() { return {target:"a",passed:true}; }', 'function right() { return left().target === "a"; }'], scenario: 'left renames target to targetDigest and removes target. right must continue validating the requested target. Assess counterpart work.', choice: "update", check: 'right() === true && ({targetDigest:"a",passed:true}).target !== "a"' },
    { id: "B-deferred-control", kind: "semantic_coupling", code: ['function left() { return {status:"failed"}; }', 'function right() { const s=left().status; return s === "passed"; }'], scenario: 'left introduces a deferred state. right remains true only for passed. Assess whether an edit is required or verification suffices.', choice: "verify_only", check: 'right() === false && ({status:"deferred"}).status !== "passed"' },
];
export function executeRelationFixtures(): Array<{ id: string; passed: boolean; check: string }> {
    return RELATION_FIXTURES.map(f => ({ id: f.id, passed: runInNewContext(`${f.code.join("\n")}\n(${f.check})`, {}, { timeout: 100 }) === true, check: f.check }));
}
export function fixtureRelationPlan(engines: EngineSpec[]): { plan: RelationPlan; labels: RelationLabels; checks: ReturnType<typeof executeRelationFixtures> } {
    const checks = executeRelationFixtures();
    if (checks.some(c => !c.passed)) throw new Error("executable relation fixture failed");
    const files: RelationSnapshot["files"] = {}, units: Unit[] = [];
    const invariants: InvariantDefinition[] = [], scenarios: ScenarioDefinition[] = [];
    buildRelationFixtureSources(files, units, invariants, scenarios);
    const snapshot = relationFixtureSnapshot(files, units);
    const packets = RELATION_FIXTURES.map(f => makeRelationPacket(f.kind, invariants.find(i => i.id === fixtureEvidenceId(f.id))!, units.filter(u => u.file === `fixtures/${fixtureEvidenceId(f.id)}.js`), snapshot, scenarios.find(s => s.id === fixtureEvidenceId(f.id)) ?? null, f.role ?? null));
    const policy = { version: 1 as const, invariants, scenarios };
    const plan = sealPlan({ schema: "interlinked.relation-plan/1", kind: "single_snapshot", createdAt: new Date().toISOString(), policy: { revision: null, blobs: {}, digest: hash(policy), exploratory: true, policy }, jobs: engines.map(engine => ({ id: hash({ engine, snapshot: snapshot.digest }), side: "single", snapshot, packets, engine })), coverage: [], sourcePlans: [], experimental: true, unmatched: [], contractDigest: hash(RELATION_CONTRACTS) });
    return { plan, checks, labels: { schema: "interlinked.relation-labels/1", planId: plan.id, blinded: true, labels: packets.map((p, i) => ({ packetId: p.id, caseId: RELATION_FIXTURES[i]!.id, split: "development", source: "fixture_execution", reviewer: "authored requirement + executed counterexample/control; not independent natural-code truth", choice: RELATION_FIXTURES[i]!.choice, rationale: `Executed check: ${RELATION_FIXTURES[i]!.check}. Semantic labels are authored expectations; the test substantiates the specified behavior only.`, evidence: [RELATION_FIXTURES[i]!.check] })) } };
}

function relationFixtureSnapshot(files: Record<string, { text: string; hash: string; }>, units: Unit[]) {
    const history = { status: "available" as const, boundary: { tip: "authored-fixtures", since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:00:00Z", maxCommits: 1 }, commits: [], map: {}, digest: hash("fixture-no-history"), reason: null, complete: true };
    const snapshotBody = { schema: "interlinked.relation-snapshot/1" as const, repository: "authored-executable-fixtures", revision: hash(files), tree: hash(files), files, units, history, omitted: [] };
    const snapshot = { ...snapshotBody, digest: hash(snapshotBody) };
    return snapshot;
}

function buildRelationFixtureSources(files: Record<string, { text: string; hash: string; }>, units: Unit[], invariants: InvariantDefinition[], scenarios: ScenarioDefinition[]) {
    for (const fixture of RELATION_FIXTURES) {
        // Descriptive test IDs stay in reference records, never model-visible metadata.
        const evidenceId = fixtureEvidenceId(fixture.id);
        const file = `fixtures/${evidenceId}.js`, content = fixture.code.join("\n");
        files[file] = { text: content, hash: textHash(content) };
        fixture.code.forEach((text, i) => units.push({ id: `${file}#function:participant${i}@${i + 1}`, kind: "function", file, name: `participant${i}`, line: i + 1, endLine: i + 1, text, hash: textHash(text) }));
        invariants.push({ id: evidenceId, version: "1", statement: fixture.id.includes("target-schema") ? "Verification identity must remain bound to the requested target." : "A verification verdict may be true only for a completed passed check. Failed, unavailable and deferred checks do not pass.", applicability: fixture.id.startsWith("B") ? "The exact directional scenario and supplied participants." : "Supplied implementations and their composition. A presentation-only helper makes no verification claim.", clauses: ["Missing execution does not establish pass."], exceptions: fixture.exception ? [fixture.exception] : [], participants: units.filter(u => u.file === file).map(u => u.id), groups: [], contextFiles: [] });
        if (fixture.scenario) scenarios.push({ id: evidenceId, version: "1", statement: fixture.scenario, applicability: "Assume exactly the stated change; do not invent other changes.", invariantId: evidenceId });
    }
}
