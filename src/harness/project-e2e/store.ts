// ===========================================
// Expectation store — the file-backed side of the lifecycle
// ===========================================
// Applies the pure `expectations.ts` transitions to `.interlinked/e2e-policy.json`,
// binds scenarios to expectation ids, records accepted contract digests in
// the existing `contract-policy.json` (one acceptance model, plan §6.1), and
// invalidates affected scenario obligations on replacement/dispute. Every
// operation computes its full result before writing anything, so a refused
// decision leaves both files byte-identical (PE-60).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_MANIFEST, CONTRACT_POLICY, contractDigest, readContractFile } from "../contracts/paths.js";
import { parseContractManifest, parseContractPolicy } from "../contracts/schema.js";
import type { ContractPolicy } from "../contracts/types.js";
import { acceptExpectation, disputeExpectation, expectationDiff, inspectExpectationSources, proposeExpectation, replaceExpectation, type ExpectationChange, type ExpectationDecision, type ExpectationDraft, type ReplacementDecision, type SourceProvenance } from "./expectations.js";
import { appendE2eTxn, readE2eTxns, reduceE2eLedger, scenarioKey } from "./ledger.js";
import { E2E_POLICY_PATH, loadE2ePolicy, parseE2ePolicy, type E2eExpectation, type E2ePolicy } from "./policy.js";
import { reconcileChanges } from "./reconcile.js";

export interface StoredExpectation { expectation: E2eExpectation; sources: Array<{ path: string; provenance: SourceProvenance }>; }
export interface ReviewRow extends StoredExpectation { diff?: ExpectationChange[]; }

function requirePolicy(root: string): E2ePolicy {
    const loaded = loadE2ePolicy(root);
    if (loaded.status === "unconfigured") throw new Error("e2e: UNCONFIGURED — no .interlinked/e2e-policy.json; declare the project first");
    if (loaded.status === "invalid") throw new Error(`e2e: policy invalid — ${loaded.reason}`);
    return loaded.policy;
}
function writeAtomically(path: string, content: string): void {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, content, { mode: 0o644 });
    renameSync(temp, path);
}
function writePolicy(root: string, policy: E2ePolicy): void {
    writeAtomically(join(root, E2E_POLICY_PATH), `${JSON.stringify(policy, null, 2)}\n`);
}
/** Acceptance lives beside the project's manifest, under the PROJECT root (F6), never the repository root by default. */
function projectRootOf(root: string, policy: E2ePolicy, projectId: string): string {
    const project = policy.projects.find(item => item.id === projectId);
    return !project || project.root === "." ? root : join(root, project.root);
}
function readContractPolicy(projectRoot: string): ContractPolicy {
    const path = join(projectRoot, CONTRACT_POLICY);
    return existsSync(path) ? parseContractPolicy(readFileSync(path, "utf8")) : { version: 1, accepted: {} };
}
function writeContractPolicy(projectRoot: string, policy: ContractPolicy): void {
    mkdirSync(join(projectRoot, ".interlinked"), { recursive: true });
    writeAtomically(join(projectRoot, CONTRACT_POLICY), `${JSON.stringify(policy, null, 2)}\n`);
}
/** Scenario identity is project-scoped (R12): only the named project's scenarios are (un)bound. */
function bind(policy: E2ePolicy, projectId: string, expectationId: string, scenarioIds: readonly string[], unbind?: string): E2ePolicy {
    const projects = policy.projects.map(project => project.id !== projectId ? project : ({
        ...project,
        scenarios: project.scenarios.map(scenario => {
            const ids = (scenario.expectationIds ?? []).filter(id => id !== unbind);
            if (scenarioIds.includes(scenario.id) && !ids.includes(expectationId)) ids.push(expectationId);
            const { expectationIds: _dropped, ...rest } = scenario;
            return ids.length ? { ...rest, expectationIds: ids } : rest;
        }),
    }));
    return parseE2ePolicy(JSON.stringify({ ...policy, projects })); // validate the final policy before anything is written
}
function record(policy: E2ePolicy, id: string): E2eExpectation {
    const row = policy.expectations.find(item => item.id === id);
    if (!row) throw new Error(`e2e expectation: unknown expectation ${id}`);
    return row;
}
/** Citations resolve under the PROJECT root — the same resolver generation uses (round 3, G3). */
function stored(root: string, policy: E2ePolicy, row: E2eExpectation): StoredExpectation {
    return { expectation: row, sources: inspectExpectationSources(projectRootOf(root, policy, row.projectId), row) };
}
/** Writes the record proposed and binds its scenarios. Never touches acceptance. */
export function proposeExpectationInStore(root: string, draft: ExpectationDraft, atMs: number): StoredExpectation {
    const next = bind(proposeExpectation(requirePolicy(root), draft, atMs), draft.projectId, draft.id, draft.scenarioIds);
    writePolicy(root, next);
    const projectRoot = projectRootOf(root, next, draft.projectId);
    if (!existsSync(join(projectRoot, CONTRACT_POLICY))) writeContractPolicy(projectRoot, { version: 1, accepted: {} });
    return stored(root, next, record(next, draft.id));
}
function contractDigestsFor(root: string, policy: E2ePolicy, row: E2eExpectation): Record<string, string> {
    const project = policy.projects.find(item => item.id === row.projectId);
    const projectRoot = projectRootOf(root, policy, row.projectId);
    const manifest = parseContractManifest(readContractFile(projectRoot, project?.contractManifest ?? CONTRACT_MANIFEST));
    const digests: Record<string, string> = {};
    for (const id of row.contractIds) {
        const contract = manifest.cases.find(item => item.id === id);
        if (!contract) throw new Error(`e2e expectation: contract case ${id} is not declared in the manifest; acceptance refused`);
        digests[contractDigest(contract)] = `expectation ${row.id}`;
    }
    return digests;
}
/** Records a configured decision; the linked contract digests become configured acceptance in contract-policy.json. */
export function acceptExpectationInStore(root: string, decision: ExpectationDecision, atMs: number): StoredExpectation & { acceptedContractDigests: Record<string, string> } {
    const policy = requirePolicy(root);
    const { policy: next } = acceptExpectation(policy, decision, atMs);
    const row = record(next, decision.expectationId);
    const acceptedContractDigests = contractDigestsFor(root, next, row);
    const projectRoot = projectRootOf(root, next, row.projectId);
    const contractPolicy = readContractPolicy(projectRoot);
    for (const [digest, reason] of Object.entries(acceptedContractDigests)) contractPolicy.accepted[digest] = `${reason}: ${decision.rationale}`;
    writePolicy(root, next);
    writeContractPolicy(projectRoot, contractPolicy);
    return { ...stored(root, next, row), acceptedContractDigests };
}
function invalidate(root: string, scenarioIds: readonly string[], projectId: string, reason: string, atMs: number): void {
    const ledger = reduceE2eLedger(readE2eTxns(root));
    for (const scenarioId of scenarioIds) {
        const state = ledger.get(scenarioKey(projectId, scenarioId));
        if (state) appendE2eTxn(root, { op: "invalidate", key: state.key, generation: state.generation, reason, atMs });
    }
    reconcileChanges({ root, changedPaths: "all", atMs });
}
/** Supersedes atomically and rebinds scenarios to the replacement; affected obligations are invalidated. */
export function replaceExpectationInStore(root: string, decision: ReplacementDecision, atMs: number): StoredExpectation & { affectedScenarioIds: string[] } {
    const policy = requirePolicy(root);
    const old = record(policy, decision.expectationId);
    const { policy: replaced, affectedScenarioIds } = replaceExpectation(policy, decision, atMs);
    const next = bind(replaced, decision.replacement.projectId, decision.replacement.id, decision.replacement.scenarioIds, old.id);
    writePolicy(root, next);
    invalidate(root, affectedScenarioIds, old.projectId, `expectation ${old.id} replaced by ${decision.replacement.id}`, atMs);
    return { ...stored(root, next, record(next, decision.replacement.id)), affectedScenarioIds };
}
export function disputeExpectationInStore(root: string, decision: ExpectationDecision, atMs: number): StoredExpectation & { affectedScenarioIds: string[] } {
    const policy = requirePolicy(root);
    const { policy: next, affectedScenarioIds } = disputeExpectation(policy, decision, atMs);
    const row = record(next, decision.expectationId);
    writePolicy(root, next);
    invalidate(root, affectedScenarioIds, row.projectId, `expectation ${row.id} disputed`, atMs);
    return { ...stored(root, next, row), affectedScenarioIds };
}
/** Every live record with its source provenance, questions and (when it replaced one) the field diff against its predecessor. */
export function reviewExpectations(root: string): ReviewRow[] {
    const policy = requirePolicy(root);
    return policy.expectations.filter(row => row.lifecycle !== "superseded").map(row => {
        const predecessor = policy.expectations.find(item => item.supersededBy === row.id);
        const review: ReviewRow = stored(root, policy, row);
        if (predecessor) review.diff = expectationDiff(predecessor, row);
        return review;
    });
}
