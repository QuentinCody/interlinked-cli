// ===========================================
// The ONE qualification predicate — plan 31 §11, decision 6
// ===========================================
// CLI check, verify, Stop and (later) git/CI gates all call this. Pure over
// its inputs: policy, current generation, ledger state and the receipt.
// Dimensions stay visible (authority / execution / boundary / provenance /
// scope / completion); the aggregate is satisfied only when every applicable
// condition holds. One green dimension never overwrites a missing one, and
// evidence the reader could not validate is unavailable, never green.

import type { E2eObligationState, ObligationStatus } from "./ledger.js";
import type { E2eBoundary, E2ePolicy, E2eProject, E2eRequiredRequest, E2eScenario } from "./policy.js";
import type { E2eReceipt, ReceiptCase } from "./receipt.js";
import type { SensitivityRecord } from "./sensitivity.js";
import type { QuarantineRecord } from "./stability.js";

export type ReasonCode =
    | "NO_EVIDENCE" | "RECEIPT_INVALID" | "STALE_GENERATION" | "STALE_POLICY" | "RECEIPT_MISMATCH" | "SCOPE_INCOMPLETE" | "CONTRACT_MISSING" | "CONTRACT_CONFLICT"
    | "CASE_FAILED" | "CASE_UNAVAILABLE" | "CASE_STALE" | "CASE_NOT_RUN" | "EXPECTATION_PROPOSED" | "EXPECTATION_DISPUTED" | "EXPECTATION_SUPERSEDED"
    | "BOUNDARY_MISMATCH" | "BOUNDARY_UNSUPPORTED" | "PREPARE_FAILED" | "INPUTS_CHANGED_DURING_RUN" | "RUN_INCOMPLETE"
    | "SENSITIVITY_NOT_DEMONSTRATED" | "SENSITIVITY_INCONCLUSIVE"
    | "STABILITY_NOT_QUALIFIED" | "STABILITY_MIXED" | "STABILITY_FAILED" | "STABILITY_DEFERRED" | "STABILITY_UNAVAILABLE" | "STABILITY_QUARANTINED"
    | "OBSERVATIONS_INCOMPLETE";
export interface Reason { code: ReasonCode; message: string; }
export interface Dimensions {
    authority: "accepted" | "proposed" | "disputed" | "none"; execution: "passed" | "failed" | "unavailable" | "stale" | "not-run";
    boundary: "process-driver" | "http-driver" | "browser-driver" | "unsupported" | "mismatch" | "not-run"; provenance: "matched" | "inferred" | "stale" | "conflict" | "unavailable" | "not-run";
    scope: "complete" | "incomplete"; completion: "complete" | "incomplete" | "not-run";
    /** §9.4 (D3): the required proof mode's verdict; `not-required` for execution mode. */ sensitivity: "demonstrated" | "preserved" | "not-demonstrated" | "inconclusive" | "not-required";
    /** §9.5 (E1): the stability cohort's verdict for this generation; `not-required` when the scenario declares no stability profile. */ stability: "qualified" | "mixed" | "failed" | "deferred" | "unavailable" | "quarantined" | "not-qualified" | "not-required";
    /** §7.4 (E4): runtime observations of the owned processes; `not-required` unless the project declares `observations.runtimeCoverage: "node-required"`. */ observations: "complete" | "incomplete" | "not-required";
}
export interface QualifyInput {
    policy: E2ePolicy; project: E2eProject; scenario: E2eScenario; policyDigest?: string;
    /** Canonical (realpath) root of the project being evaluated; a receipt from another worktree is rejected (R4). */
    canonicalRoot?: string;
    generation: { generation: string; gaps: string[]; /** Expected contract digest per case id; an executed case with another digest is not the accepted test (F1). */ caseDigests?: Record<string, string>; /** D3: what the scenario's proof revision resolves to NOW; a receipt whose comparison ran against another commit is stale evidence (review D3). */ comparison?: string };
    state: E2eObligationState | undefined; receipt: E2eReceipt | null;
    /** Why the ledger's receipt could not be read, when it names one (R5). */
    receiptIssue?: string;
    /** The quarantine row for this key at the CURRENT generation, if any (E1): an unchanged rerun cannot erase it. */ quarantine?: QuarantineRecord | null;
}
export interface ScenarioVerdict {
    key: string; projectId: string; scenarioId: string; required: boolean; satisfied: boolean; status: ObligationStatus;
    generation: string; reasons: Reason[]; /** Visible, non-blocking notes (a bound proposed expectation under advisory review). */ advisories: string[];
    dimensions: Dimensions; receipt?: string; runId?: string;
}
type CaseDimensions = Pick<Dimensions, "execution" | "provenance" | "boundary" | "authority">;

const UNAVAILABLE_CODES: ReadonlySet<ReasonCode> = new Set(["RECEIPT_INVALID", "CASE_UNAVAILABLE", "CASE_STALE", "SCOPE_INCOMPLETE", "CONTRACT_MISSING", "PREPARE_FAILED", "INPUTS_CHANGED_DURING_RUN", "RUN_INCOMPLETE", "STALE_POLICY", "BOUNDARY_UNSUPPORTED", "SENSITIVITY_NOT_DEMONSTRATED", "SENSITIVITY_INCONCLUSIVE", "STABILITY_NOT_QUALIFIED", "STABILITY_DEFERRED", "STABILITY_UNAVAILABLE", "OBSERVATIONS_INCOMPLETE"]);
const FAILED_CODES: ReadonlySet<ReasonCode> = new Set(["CASE_FAILED", "STABILITY_MIXED", "STABILITY_FAILED", "STABILITY_QUARANTINED"]);
const REVIEW_CODES: ReadonlySet<ReasonCode> = new Set(["EXPECTATION_PROPOSED", "EXPECTATION_DISPUTED", "EXPECTATION_SUPERSEDED"]);
const CASE_STATE_CODE: Record<ReceiptCase["state"], ReasonCode | null> = { passed: null, failed: "CASE_FAILED", unavailable: "CASE_UNAVAILABLE", stale: "CASE_STALE", "not-run": "CASE_NOT_RUN" };
const LIFECYCLE_CODE = { proposed: "EXPECTATION_PROPOSED", disputed: "EXPECTATION_DISPUTED", superseded: "EXPECTATION_SUPERSEDED" } as const;

class Reasons {
    readonly rows: Reason[] = [];
    readonly advisories: string[] = [];
    add(code: ReasonCode, message: string): void { if (!this.rows.some(row => row.code === code)) this.rows.push({ code, message }); }
}
function scopeReasons(input: QualifyInput, reasons: Reasons): void {
    for (const gap of input.generation.gaps) {
        reasons.add("SCOPE_INCOMPLETE", `input scope incomplete: ${gap}`);
        if (gap.startsWith("contract manifest") || gap.startsWith("contract case")) reasons.add("CONTRACT_MISSING", gap);
    }
}
/** Bound expectations: disputed/superseded always block; PROPOSED blocks only under gates.review "require" (§6.4, R11). */
function boundExpectationAuthority(input: QualifyInput, reasons: Reasons): Dimensions["authority"] | null {
    const bound = (input.scenario.expectationIds ?? []).map(id => input.policy.expectations.find(row => row.id === id)).filter(row => row !== undefined);
    if (!bound.length) return null;
    const reviewRequired = input.project.gates?.review === "require";
    let authority: Dimensions["authority"] = "accepted";
    for (const row of bound) {
        if (row.lifecycle === "accepted") continue;
        authority = row.lifecycle === "proposed" ? "proposed" : "disputed";
        const message = `expectation ${row.id} is ${row.lifecycle}; execution evidence cannot accept it`;
        if (row.lifecycle === "proposed" && !reviewRequired) reasons.advisories.push(`${message} (pending interpretation; gates.review is advisory)`);
        else reasons.add(LIFECYCLE_CODE[row.lifecycle], message);
    }
    return authority;
}
/** Is this receipt about THIS project, scenario, worktree and ledger attempt? (PE-10, PE-11, R4) */
function identityReasons(input: QualifyInput, receipt: E2eReceipt, reasons: Reasons): void {
    if (receipt.project.id !== input.project.id || !receipt.scenarioIds.includes(input.scenario.id)) reasons.add("RECEIPT_MISMATCH", "the receipt names another project or scenario");
    if (input.canonicalRoot !== undefined && receipt.project.canonicalRoot !== input.canonicalRoot) reasons.add("RECEIPT_MISMATCH", `the receipt was produced in another worktree (${receipt.project.canonicalRoot})`);
    const lastRunId = input.state?.lastRunId;
    if (lastRunId !== undefined && lastRunId !== receipt.runId) reasons.add("RECEIPT_MISMATCH", `receipt run ${receipt.runId} is not the ledger's attempt ${lastRunId}`);
}
function evidenceReasons(input: QualifyInput, reasons: Reasons): void {
    const { receipt } = input;
    if (!receipt) {
        if (input.receiptIssue) reasons.add("RECEIPT_INVALID", `the ledger's receipt could not be validated: ${input.receiptIssue}`);
        else reasons.add("NO_EVIDENCE", "no qualifying run for the current generation");
        return;
    }
    const receiptGeneration = receipt.scenarioGenerations?.[input.scenario.id] ?? receipt.generation;
    if (receiptGeneration !== input.generation.generation) reasons.add("STALE_GENERATION", "the latest receipt belongs to an older input generation");
    if (input.policyDigest !== undefined && receipt.policyDigest !== input.policyDigest) reasons.add("STALE_POLICY", "the receipt was produced under a different policy");
    identityReasons(input, receipt, reasons);
}
function applyProvenance(id: string, row: ReceiptCase, reasons: Reasons, dims: CaseDimensions): void {
    if (row.provenance === "conflict") { reasons.add("CONTRACT_CONFLICT", `case ${id}: ${row.details.join(" ") || "expectation contradicts its cited example"}`); dims.provenance = "conflict"; return; }
    if (row.provenance !== "matched" && dims.provenance === "matched") dims.provenance = row.provenance;
}
/** Why an http case's service does not establish a real boundary, or null: the receipt must show it OWNED, READY and CLEANLY STOPPED (Unit D1, PE-19/26). */
function ownedServiceIssue(input: QualifyInput, row: ReceiptCase): string | null {
    if (row.service === undefined) return "targets a literal URL nobody owns";
    // Round 2 R1: a receipt keeps one record per service LIFETIME; a browser case is judged against the instance that served the browser stage, an http case against the contracts stage.
    const stage = row.runnerKind === "browser" ? "browser" : "contracts";
    const records = input.receipt?.services?.filter(item => item.id === row.service) ?? [];
    const record = records.find(item => item.stage === stage) ?? records[0];
    if (!record) return `names service "${row.service}" that the run never owned`;
    if (!record.ready.ok) return `service "${row.service}" was never ready (${record.ready.reason ?? "no readiness record"})`;
    if (!record.shutdown?.ok) return `service "${row.service}" did not stop cleanly (${record.shutdown?.reason ?? "no shutdown record"})`;
    return null;
}
/** The managed process driver and an OWNED http service are the supported real boundaries; a structured report or an unowned responder certifies nothing (R3, D1). */
function unsupportedBoundary(input: QualifyInput, row: ReceiptCase): string | null {
    if (row.runnerKind === "structured") return "runs through a structured report; no managed service adapter can establish that boundary";
    return row.runnerKind === "http" ? ownedServiceIssue(input, row) : null;
}
/**
 * A portable contract case's mechanism must match the declared boundary — except under a BROWSER boundary (review E1), where
 * the portable contracts are SUPPORT cases judged against their own owned service/process while the browser case carries the
 * declared entry; an http support case still has to run through the declared service.
 */
function boundaryMismatch(declared: E2eBoundary | undefined, row: ReceiptCase): string | null {
    if (!declared) return null;
    if (declared.entry !== "browser" && declared.entry !== row.runnerKind) return `runs through ${row.runnerKind}; the scenario declares ${declared.entry}`;
    if (declared.service !== undefined && row.runnerKind !== "process" && declared.service !== row.service) return `is driven through service ${row.service ?? "none"}; the scenario declares service ${declared.service}`;
    return null;
}
function applyBoundary(input: QualifyInput, id: string, row: ReceiptCase, reasons: Reasons, dims: CaseDimensions): void {
    const unsupported = unsupportedBoundary(input, row);
    if (unsupported) { reasons.add("BOUNDARY_UNSUPPORTED", `case ${id} ${unsupported}; an unowned responder cannot certify a real application`); dims.boundary = "unsupported"; return; }
    const mismatch = boundaryMismatch(input.scenario.boundary, row);
    if (mismatch) { reasons.add("BOUNDARY_MISMATCH", `case ${id} ${mismatch}`); dims.boundary = "mismatch"; return; }
    if (row.runnerKind === "http" && dims.boundary === "process-driver") dims.boundary = "http-driver";
}
function applyCase(input: QualifyInput, id: string, reasons: Reasons, dims: CaseDimensions): void {
    const row = input.receipt?.cases.find(item => item.id === id);
    if (!row) { reasons.add("CASE_NOT_RUN", `required case ${id} is absent from the run`); dims.execution = "not-run"; return; }
    const expected = input.generation.caseDigests?.[id];
    if (expected !== undefined && expected !== row.digest) { reasons.add("RECEIPT_MISMATCH", `case ${id} executed digest ${row.digest.slice(0, 12)} is not the live contract ${expected.slice(0, 12)}; the run tested a different definition`); dims.execution = "not-run"; return; }
    applyProvenance(id, row, reasons, dims);
    const code = CASE_STATE_CODE[row.state];
    if (code) { reasons.add(code, `case ${id} ${row.state}: ${row.details.join(" ")}`.trim()); if (dims.execution === "passed") dims.execution = row.state; }
    if (row.authority === "proposed") { reasons.add("EXPECTATION_PROPOSED", `case ${id} is not an accepted contract; a green run does not accept it`); dims.authority = "proposed"; }
    applyBoundary(input, id, row, reasons, dims);
}
/** Unit E2 (§10.2): a browser case earns the boundary only when the supervisor's proxy saw it reach the OWNED, ready, cleanly stopped app. */
function browserBoundaryIssue(input: QualifyInput, row: ReceiptCase): { code: "BOUNDARY_UNSUPPORTED" | "BOUNDARY_MISMATCH"; text: string } | null {
    const declared = input.scenario.boundary!;
    if (declared.entry !== "browser") return { code: "BOUNDARY_MISMATCH", text: `runs through a browser; the scenario declares ${declared.entry}` };
    const owned = ownedServiceIssue(input, row);
    if (owned) return { code: "BOUNDARY_UNSUPPORTED", text: owned };
    if (declared.service !== undefined && declared.service !== row.service) return { code: "BOUNDARY_MISMATCH", text: `is driven through service ${row.service}; the scenario declares service ${declared.service}` };
    if (!(row.boundaryRequests !== undefined && row.boundaryRequests > 0)) return { code: "BOUNDARY_UNSUPPORTED", text: "drove no request through the owned application during its attempt; a browser test that never reaches the app certifies nothing" };
    const missing = (declared.requests ?? []).filter(required => !(row.boundaryObservations ?? []).some(seen => requestMatches(required, seen)));
    if (missing.length) return { code: "BOUNDARY_UNSUPPORTED", text: `did not drive ${missing.map(row => `${row.method} ${row.path}`).join(", ")} through the owned application (observed: ${(row.boundaryObservations ?? []).map(seen => `${seen.method} ${seen.path} → ${seen.status}`).join(", ") || "nothing"}); a page shell, health check or intercepted API cannot stand in for the operation under test` };
    return null;
}
/** E5: the required operation must reach the owned app AND be answered by it (a proxy 502 or an app 5xx establishes nothing). A trailing `*` in the declared path matches a prefix. */
function requestMatches(required: E2eRequiredRequest, seen: { method: string; path: string; status: number }): boolean {
    if (seen.method !== required.method || seen.status < 100 || seen.status >= 500) return false;
    const path = seen.path.split("?")[0] ?? seen.path;
    return required.path.endsWith("*") ? path.startsWith(required.path.slice(0, -1)) : path === required.path;
}
function applyBrowserBoundary(input: QualifyInput, id: string, row: ReceiptCase, reasons: Reasons, dims: CaseDimensions): void {
    if (!input.scenario.boundary) return;
    const issue = browserBoundaryIssue(input, row);
    if (issue) { reasons.add(issue.code, `case ${id} ${issue.text}`); dims.boundary = issue.code === "BOUNDARY_MISMATCH" ? "mismatch" : "unsupported"; return; }
    if (dims.boundary === "process-driver" || dims.boundary === "http-driver") dims.boundary = "browser-driver";
}
/** A declared NATIVE case from a structured report (C2) or a browser run (E2): execution evidence, plus the browser boundary when the scenario declares one. */
function applyNativeCase(input: QualifyInput, id: string, reasons: Reasons, dims: CaseDimensions): void {
    const row = input.receipt?.cases.find(item => item.id === id && (item.runnerKind === "structured" || item.runnerKind === "browser"));
    if (!row) { reasons.add("CASE_NOT_RUN", `declared native case ${id} is absent from the run's report`); dims.execution = "not-run"; return; }
    const code = CASE_STATE_CODE[row.state];
    if (code) { reasons.add(code, `native case ${id} ${row.state}: ${row.details.join(" ")}`.trim()); if (dims.execution === "passed") dims.execution = row.state; }
    if (row.runnerKind === "browser") applyBrowserBoundary(input, id, row, reasons, dims);
}
function caseReasons(input: QualifyInput, reasons: Reasons): CaseDimensions {
    if (!input.receipt) return { execution: "not-run", provenance: "not-run", boundary: "not-run", authority: "none" };
    const dims: CaseDimensions = { execution: "passed", provenance: "matched", boundary: "process-driver", authority: "accepted" };
    for (const id of input.scenario.contractIds) applyCase(input, id, reasons, dims);
    for (const id of input.scenario.caseIds ?? []) applyNativeCase(input, id, reasons, dims);
    // E1: a browser boundary is established only by a browser case; support contracts alone leave it unestablished.
    if (input.scenario.boundary?.entry === "browser" && (dims.boundary === "process-driver" || dims.boundary === "http-driver")) { reasons.add("BOUNDARY_UNSUPPORTED", "the scenario declares a browser boundary but no browser case established it"); dims.boundary = "unsupported"; }
    return dims;
}
function completionReasons(receipt: E2eReceipt | null, reasons: Reasons): Dimensions["completion"] {
    if (!receipt) return "not-run";
    let complete = true;
    if (receipt.prepare.some(step => !step.ok)) { reasons.add("PREPARE_FAILED", "a preparation step failed; the application under test was not built"); complete = false; }
    if (receipt.completion.inputsChangedDuringRun) { reasons.add("INPUTS_CHANGED_DURING_RUN", "inputs changed while the run executed; the result cannot certify either generation"); complete = false; }
    if (!receipt.completion.complete) { reasons.add("RUN_INCOMPLETE", `the run did not complete: ${receipt.completion.reasons.join("; ") || "no completion record"}`); complete = false; }
    return complete ? "complete" : "incomplete";
}
/**
 * Evidence-level defects of a recorded comparison, whatever its verdict says (review D2/D3): the proof revision now resolves to
 * another commit (the record certifies a comparison nobody selects any more), or the comparison's own lifecycle did not complete
 * (its observations were taken beside a service that never stopped cleanly). Null when the record's evidence stands.
 */
function staleSensitivity(record: SensitivityRecord, current: string | undefined): string | null {
    if (record.verdict === "inconclusive") return null; // its own reason is the more specific one
    if (record.comparison.kind === "revision" && current !== undefined && current !== record.comparison.identity) return `the proof revision now resolves to ${current.slice(0, 12)}; the recorded comparison ran against ${record.comparison.identity.slice(0, 12)} — a moved ref selects a different comparison`;
    if (record.lifecycle && !record.lifecycle.complete) return `the comparison lifecycle did not complete (${record.lifecycle.reasons.join("; ") || "teardown failure"}); its observations certify nothing`;
    return null;
}
/** §9.4 / §11 condition 10: an explicitly required proof mode must be present, current and demonstrated; the evaluator never infers one. */
function sensitivityReasons(input: QualifyInput, reasons: Reasons): Dimensions["sensitivity"] {
    const mode = input.scenario.proof?.mode ?? "execution";
    if (mode === "execution") return "not-required";
    const record = input.receipt?.sensitivity?.[input.scenario.id];
    if (!record || record.mode !== mode) { reasons.add("SENSITIVITY_INCONCLUSIVE", `proof mode ${mode} is required but the run recorded ${record ? `a ${record.mode} comparison` : "no comparison"}`); return "inconclusive"; }
    const stale = staleSensitivity(record, input.generation.comparison);
    if (stale) { reasons.add("SENSITIVITY_INCONCLUSIVE", stale); return "inconclusive"; }
    if (record.verdict === "inconclusive") reasons.add("SENSITIVITY_INCONCLUSIVE", `${mode} comparison inconclusive (${record.category}): ${record.reasons.join("; ")}`);
    else if (record.verdict === "not-demonstrated") reasons.add("SENSITIVITY_NOT_DEMONSTRATED", `${mode} comparison did not demonstrate the requirement (${record.category}): ${record.reasons.join("; ")}`);
    return record.verdict;
}
const COHORT_CODE = { qualified: null, mixed: "STABILITY_MIXED", failed: "STABILITY_FAILED", deferred: "STABILITY_DEFERRED", "in-progress": "STABILITY_DEFERRED", unavailable: "STABILITY_UNAVAILABLE" } as const;
/** §9.5 / §11 condition (stability): a declared profile needs a qualified cohort for THIS generation; a quarantined generation stays failed until repaired (a new generation). */
function stabilityReasons(input: QualifyInput, reasons: Reasons): Dimensions["stability"] {
    const profile = input.scenario.stability;
    if (!profile) return "not-required";
    if (input.quarantine) { reasons.add("STABILITY_QUARANTINED", `quarantined since cohort ${input.quarantine.cohortId}: ${input.quarantine.reason}; a repair (new generation) and a fresh qualification cohort are required — rerunning the unchanged profile cannot erase the failure`); return "quarantined"; }
    const cohort = input.state?.cohort;
    if (!cohort) { reasons.add("STABILITY_NOT_QUALIFIED", `${profile.qualificationRuns} independent qualification run(s) are required for this generation; none recorded — run interlinked tests e2e qualify --project ${input.project.id} --scenario ${input.scenario.id}`); return "not-qualified"; }
    const code = COHORT_CODE[cohort.verdict];
    if (code) reasons.add(code, `stability cohort ${cohort.cohortId} is ${cohort.verdict} (record ${cohort.record})`);
    return cohort.verdict === "in-progress" ? "deferred" : cohort.verdict;
}
/** §7.4 (E4): a required node observation profile needs COMPLETE observations on the run; `node` (optional) and `off` never gate. */
function observationReasons(input: QualifyInput, reasons: Reasons): Dimensions["observations"] {
    if (input.project.observations?.runtimeCoverage !== "node-required") return "not-required";
    const summary = input.receipt?.observations;
    if (!input.receipt) return "incomplete";
    if (summary?.complete) return "complete";
    reasons.add("OBSERVATIONS_INCOMPLETE", summary ? `runtime observations incomplete: ${summary.limits.join("; ") || "no limit recorded"}` : "the project requires node runtime observations but the run recorded none");
    return "incomplete";
}
export function statusFor(reasons: Reason[]): ObligationStatus {
    if (!reasons.length) return "satisfied";
    const codes = reasons.map(row => row.code);
    if (codes.every(code => REVIEW_CODES.has(code))) return "review-required";
    if (codes.some(code => FAILED_CODES.has(code))) return "failed";
    if (codes.includes("STALE_GENERATION")) return "stale";
    if (codes.some(code => UNAVAILABLE_CODES.has(code))) return "unavailable";
    return "pending";
}
/** Satisfied only when ALL applicable conditions hold (plan §11, 1–10 as scoped to Unit A). */
export function qualifyScenario(input: QualifyInput): ScenarioVerdict {
    const reasons = new Reasons();
    scopeReasons(input, reasons);
    const boundAuthority = boundExpectationAuthority(input, reasons);
    evidenceReasons(input, reasons);
    const cases = caseReasons(input, reasons);
    const completion = completionReasons(input.receipt, reasons);
    const sensitivity = sensitivityReasons(input, reasons);
    const stability = stabilityReasons(input, reasons);
    const observations = observationReasons(input, reasons);
    const dimensions: Dimensions = { ...cases, authority: boundAuthority ?? cases.authority, scope: input.generation.gaps.length ? "incomplete" : "complete", completion, sensitivity, stability, observations };
    const verdict: ScenarioVerdict = {
        key: `${input.project.id}/${input.scenario.id}`, projectId: input.project.id, scenarioId: input.scenario.id, required: input.scenario.required,
        satisfied: reasons.rows.length === 0, status: statusFor(reasons.rows), generation: input.generation.generation, reasons: reasons.rows, advisories: reasons.advisories, dimensions,
    };
    if (input.receipt) verdict.runId = input.receipt.runId;
    if (input.state?.lastReceipt) verdict.receipt = input.state.lastReceipt;
    return verdict;
}
/** Exit contract (plan §14): 0 satisfied / not applicable, 1 measured failure or unsatisfied requirement, 2 unavailable evidence. */
export function exitCodeFor(verdicts: readonly ScenarioVerdict[]): 0 | 1 | 2 {
    const open = verdicts.filter(row => row.required && !row.satisfied);
    if (!open.length) return 0;
    const codes = open.flatMap(row => row.reasons.map(reason => reason.code));
    return codes.some(code => !UNAVAILABLE_CODES.has(code)) ? 1 : 2;
}
