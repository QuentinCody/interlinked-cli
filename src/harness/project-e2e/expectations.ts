// ===========================================
// Expectation lifecycle — proposed → accepted / disputed / superseded
// ===========================================
// Plan 31 §6.4 and §14. Authority and execution status are separate axes: a
// green run never accepts an expectation, and acceptance binds to the exact
// revision digest the reviewer saw (a stale before-digest is refused
// atomically, PE-60). Every review carries authority "configured" — a local
// decision is a recorded configuration, never authenticated human approval.
// This module is pure over the policy value; the store layer owns the files.

import { readContractFile } from "../contracts/paths.js";
import { digestOf, expectationRevision, parseE2ePolicy, type E2eExpectation, type E2ePolicy, type E2eReview, type ExpectationDraft } from "./policy.js";

export { expectationRevision, type ExpectationDraft };
export interface ExpectationDecision { expectationId: string; revision: string; rationale: string; }
export interface ReplacementDecision extends ExpectationDecision { replacement: ExpectationDraft; }
export interface ExpectationChange { field: string; before: unknown; after: unknown; }
export type SourceProvenance = "matched" | "stale" | "unavailable";

const REVISION_FIELDS = ["id", "projectId", "scenarioIds", "statement", "origin", "sources", "assumptions", "questions", "examples", "contractIds"] as const;

function fail(message: string): never { throw new Error(`e2e expectation: ${message}`); }
function draftOf(row: ExpectationDraft): ExpectationDraft {
    return {
        id: row.id, projectId: row.projectId, scenarioIds: [...row.scenarioIds], statement: row.statement, origin: row.origin,
        sources: row.sources.map(source => ({ ...source })), assumptions: [...row.assumptions], questions: [...row.questions],
        examples: { positive: [...row.examples.positive], negative: [...row.examples.negative] }, contractIds: [...row.contractIds],
    };
}
function revalidate(policy: E2ePolicy): E2ePolicy {
    return parseE2ePolicy(JSON.stringify(policy));
}
function newRecord(draft: ExpectationDraft, atMs: number, rationale: string): E2eExpectation {
    const revision = expectationRevision(draft);
    return { ...draftOf(draft), lifecycle: "proposed", revision, history: [{ atMs, action: "propose", revision, rationale, authority: "configured" }] };
}
function appendProposal(policy: E2ePolicy, draft: ExpectationDraft, atMs: number, rationale: string): E2ePolicy {
    if (policy.expectations.some(row => row.id === draft.id)) fail(`expectation ${draft.id} already exists`);
    return revalidate({ ...policy, expectations: [...policy.expectations, newRecord(draft, atMs, rationale)] });
}
/** A proposal is visible pending interpretation; it is not a blocker and not an acceptance. */
export function proposeExpectation(policy: E2ePolicy, draft: ExpectationDraft, atMs: number): E2ePolicy {
    return appendProposal(policy, draft, atMs, "proposed");
}
function current(policy: E2ePolicy, decision: ExpectationDecision): E2eExpectation {
    const row = policy.expectations.find(item => item.id === decision.expectationId);
    if (!row) fail(`unknown expectation ${decision.expectationId}`);
    if (row.lifecycle === "superseded") fail(`expectation ${row.id} is superseded by ${row.supersededBy ?? "another record"}`);
    // Recompute from content (R6): a stored digest is a claim, the record's fields are the fact.
    const actual = expectationRevision(row);
    if (actual !== row.revision) fail(`stored revision ${row.revision.slice(0, 12)} does not match the record's content (${actual.slice(0, 12)}); the record was edited without re-proposal`);
    if (actual !== decision.revision) fail(`revision ${decision.revision} does not match current revision ${actual}; re-review before deciding`);
    if (!decision.rationale.trim()) fail("a decision needs a rationale");
    return row;
}
function transition(policy: E2ePolicy, row: E2eExpectation, next: Partial<E2eExpectation>, review: E2eReview): E2ePolicy {
    const updated: E2eExpectation = { ...row, ...next, history: [...row.history, review] };
    return { ...policy, expectations: policy.expectations.map(item => item.id === row.id ? updated : item) };
}
/** Records a configured decision bound to the exact revision. Returns the contract ids so the store can accept their digests. */
export function acceptExpectation(policy: E2ePolicy, decision: ExpectationDecision, atMs: number): { policy: E2ePolicy; contractIds: string[] } {
    const row = current(policy, decision);
    const next = transition(policy, row, { lifecycle: "accepted" }, { atMs, action: "accept", revision: row.revision, rationale: decision.rationale, authority: "configured" });
    return { policy: revalidate(next), contractIds: [...row.contractIds] };
}
export function disputeExpectation(policy: E2ePolicy, decision: ExpectationDecision, atMs: number): { policy: E2ePolicy; affectedScenarioIds: string[] } {
    const row = current(policy, decision);
    const next = transition(policy, row, { lifecycle: "disputed" }, { atMs, action: "dispute", revision: row.revision, rationale: decision.rationale, authority: "configured" });
    return { policy: revalidate(next), affectedScenarioIds: [...row.scenarioIds] };
}
/** Supersedes atomically: the old record keeps its history; the replacement starts proposed and must qualify on its own. */
export function replaceExpectation(policy: E2ePolicy, decision: ReplacementDecision, atMs: number): { policy: E2ePolicy; affectedScenarioIds: string[] } {
    const row = current(policy, decision);
    if (policy.expectations.some(item => item.id === decision.replacement.id)) fail(`expectation ${decision.replacement.id} already exists`);
    const superseded = transition(policy, row, { lifecycle: "superseded", supersededBy: decision.replacement.id }, { atMs, action: "replace", revision: row.revision, rationale: decision.rationale, authority: "configured" });
    const next = appendProposal(superseded, decision.replacement, atMs, `replaces ${row.id}: ${decision.rationale}`);
    return { policy: next, affectedScenarioIds: [...new Set([...row.scenarioIds, ...decision.replacement.scenarioIds])] };
}
/** Field-level before/after for the reviewable diff (§6.4 step 5). */
export function expectationDiff(before: ExpectationDraft, after: ExpectationDraft): ExpectationChange[] {
    const changes: ExpectationChange[] = [];
    for (const field of REVISION_FIELDS) {
        if (digestOf(before[field]) !== digestOf(after[field])) changes.push({ field, before: before[field], after: after[field] });
    }
    return changes;
}
/** Citation integrity only: matched bytes prove the quote exists, never semantic agreement (PE-59). */
export function inspectExpectationSources(root: string, row: ExpectationDraft): Array<{ path: string; provenance: SourceProvenance }> {
    return row.sources.map(source => {
        try {
            const content = readContractFile(root, source.path);
            const matched = digestOf(content) === source.sha256 && content.includes(source.quote);
            return { path: source.path, provenance: matched ? "matched" : "stale" };
        } catch { return { path: source.path, provenance: "unavailable" }; }
    });
}
