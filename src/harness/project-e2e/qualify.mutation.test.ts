import { describe, expect, it } from "vitest";
import { minimalPolicy } from "./__tests__/policy-fixture.js";
import type { E2eObligationState } from "./ledger.js";
import { parseE2ePolicy, type E2eBoundary, type E2ePolicy, type E2eScenario } from "./policy.js";
import { exitCodeFor, qualifyScenario, statusFor, type QualifyInput, type Reason, type ReasonCode, type ScenarioVerdict } from "./qualify.js";
import { emptyReceipt, type E2eReceipt, type ReceiptCase } from "./receipt.js";
import type { SensitivityRecord } from "./sensitivity.js";
import type { ServiceRecord } from "./services.js";

const G = "1".repeat(64), G2 = "2".repeat(64), P = "p".repeat(64), REV_A = "a".repeat(40), REV_B = "b".repeat(40);

function policy(): E2ePolicy { return parseE2ePolicy(JSON.stringify(minimalPolicy())); }
function caseRow(extra: Partial<ReceiptCase> = {}): ReceiptCase {
    return { id: "orders.create", digest: "d".repeat(64), authority: "configured", provenance: "matched", state: "passed", runnerKind: "process", details: [], ...extra };
}
function receiptWith(extra: Partial<E2eReceipt> = {}, cases: ReceiptCase[] = [caseRow()]): E2eReceipt {
    const base = emptyReceipt({ runId: "run-1", project: { id: "orders", root: ".", canonicalRoot: "/repo" }, scenarioIds: ["order-persists"], policyDigest: P, generation: G });
    return { ...base, cases, selection: { required: cases.map(row => row.id), observed: cases.map(row => row.id) }, completion: { ...base.completion, generationAfter: G, complete: true }, ...extra };
}
function state(extra: Partial<E2eObligationState> = {}): E2eObligationState {
    return { key: "orders/order-persists", generation: G, status: "satisfied", reason: "", updatedAtMs: 2, attempts: 1, lastRunId: "run-1", lastReceipt: ".interlinked/test-runs/e2e/run-1/receipt.json", ...extra };
}
function service(extra: Partial<ServiceRecord> = {}): ServiceRecord {
    return { id: "api", argv: ["node", "server.js"], port: 4100, pid: 1, ready: { ok: true, status: 200, attempts: 1, durationMs: 1 }, restarts: 0, shutdown: { ok: true, exitCode: 0, signal: null, timedOut: false, portSilent: true }, pids: [1], stage: "contracts", ...extra };
}
function sensitivity(extra: Partial<SensitivityRecord> = {}): SensitivityRecord {
    return { mode: "old-new", comparison: { kind: "revision", identity: REV_A, description: "HEAD~1" }, designated: [{ id: "orders.create" }], candidate: [], compared: [], verdict: "demonstrated", category: "designated-expectation-mismatch", reasons: [], ...extra };
}
/** Builds an input over the minimal policy, letting a test reshape the scenario and the project before qualification. */
function build(scenario: Partial<E2eScenario> = {}, extra: Partial<QualifyInput> = {}, project: Partial<ReturnType<typeof policy>["projects"][number]> = {}): QualifyInput {
    const base = policy();
    Object.assign(base.projects[0]!, project);
    Object.assign(base.projects[0]!.scenarios[0]!, scenario);
    return { policy: base, project: base.projects[0]!, scenario: base.projects[0]!.scenarios[0]!, policyDigest: P, generation: { generation: G, gaps: [] }, state: state(), receipt: receiptWith(), ...extra };
}
function codes(verdict: ScenarioVerdict): string[] { return verdict.reasons.map(row => row.code); }
function messageOf(verdict: ScenarioVerdict, code: string): string { return verdict.reasons.find(row => row.code === code)?.message ?? ""; }
const reason = (code: ReasonCode): Reason => ({ code, message: code });

describe("scope gaps — CONTRACT_MISSING classification", () => {
    it("a gap naming the contract manifest is also CONTRACT_MISSING", () => {
        const verdict = qualifyScenario(build({}, { generation: { generation: G, gaps: ["contract manifest m.json is absent"] } }));
        expect(codes(verdict)).toContain("SCOPE_INCOMPLETE");
        expect(codes(verdict)).toContain("CONTRACT_MISSING");
        expect(verdict.dimensions.scope).toBe("incomplete");
    });
    it("a gap naming a contract case is also CONTRACT_MISSING", () => {
        const verdict = qualifyScenario(build({}, { generation: { generation: G, gaps: ["contract case orders.create has no definition"] } }));
        expect(codes(verdict)).toContain("CONTRACT_MISSING");
    });
    it("an unrelated gap is SCOPE_INCOMPLETE only, never CONTRACT_MISSING", () => {
        const verdict = qualifyScenario(build({}, { generation: { generation: G, gaps: ["symlink at src/x was not followed"] } }));
        expect(codes(verdict)).toContain("SCOPE_INCOMPLETE");
        expect(codes(verdict)).not.toContain("CONTRACT_MISSING");
        expect(messageOf(verdict, "SCOPE_INCOMPLETE")).toBe("input scope incomplete: symlink at src/x was not followed");
    });
});

describe("authority dimension", () => {
    it("a proposed contract case with no bound expectation reports authority proposed", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({}, [caseRow({ authority: "proposed" })]) }));
        expect(verdict.dimensions.authority).toBe("proposed");
    });
    it("without a receipt the authority dimension is none", () => {
        expect(qualifyScenario(build({}, { receipt: null, state: undefined })).dimensions.authority).toBe("none");
    });
});

describe("receipt identity and generation binding", () => {
    it("a receipt that does not list the scenario is RECEIPT_MISMATCH", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({ scenarioIds: ["another-scenario"] }) }));
        expect(codes(verdict)).toEqual(["RECEIPT_MISMATCH"]);
        expect(messageOf(verdict, "RECEIPT_MISMATCH")).toMatch(/another project or scenario/);
    });
    it("a receipt is accepted when the ledger has no state to contradict it", () => {
        const verdict = qualifyScenario(build({}, { state: undefined }));
        expect(verdict.satisfied).toBe(true);
        expect(verdict.receipt).toBeUndefined();
    });
    it("a receipt is accepted when the ledger state carries no lastRunId", () => {
        const { lastRunId: _omitted, ...rest } = state();
        expect(qualifyScenario(build({}, { state: rest })).satisfied).toBe(true);
    });
    it("a stale lastRunId in the ledger names both run ids in RECEIPT_MISMATCH", () => {
        const verdict = qualifyScenario(build({}, { state: state({ lastRunId: "run-2" }) }));
        expect(messageOf(verdict, "RECEIPT_MISMATCH")).toBe("receipt run run-1 is not the ledger's attempt run-2");
    });
    it("the per-scenario generation overrides the receipt-wide generation", () => {
        const matching = qualifyScenario(build({}, { receipt: receiptWith({ generation: G2, scenarioGenerations: { "order-persists": G } }) }));
        expect(matching.satisfied).toBe(true);
        const stale = qualifyScenario(build({}, { receipt: receiptWith({ generation: G, scenarioGenerations: { "order-persists": G2 } }) }));
        expect(codes(stale)).toEqual(["STALE_GENERATION"]);
        expect(stale.status).toBe("stale");
    });
    it("a missing policy digest in the input disables the policy comparison", () => {
        const { policyDigest: _omitted, ...rest } = build();
        expect(qualifyScenario({ ...rest, receipt: receiptWith({ policyDigest: "z".repeat(64) }) }).satisfied).toBe(true);
    });
    it("a different policy digest is STALE_POLICY with exit code 2 (unavailable evidence)", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({ policyDigest: "z".repeat(64) }) }));
        expect(codes(verdict)).toEqual(["STALE_POLICY"]);
        expect(verdict.status).toBe("unavailable");
        expect(exitCodeFor([verdict])).toBe(2);
    });
    it("the verdict carries the run id, receipt path, key and generation", () => {
        const verdict = qualifyScenario(build());
        expect(verdict.runId).toBe("run-1");
        expect(verdict.receipt).toBe(".interlinked/test-runs/e2e/run-1/receipt.json");
        expect(verdict.key).toBe("orders/order-persists");
        expect(verdict.generation).toBe(G);
        expect(verdict.required).toBe(true);
    });
    it("without a receipt the verdict has no run id", () => {
        const { lastReceipt: _omitted, ...withoutReceiptPath } = state();
        const verdict = qualifyScenario(build({}, { receipt: null, state: withoutReceiptPath }));
        expect(verdict.runId).toBeUndefined();
        expect(verdict.receipt).toBeUndefined();
    });
});

describe("case evidence — provenance, digests and sticky execution state", () => {
    const two: Partial<E2eScenario> = { contractIds: ["a", "b"] };
    it("an inferred provenance is reported as the provenance dimension", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({}, [caseRow({ provenance: "inferred" })]) }));
        expect(verdict.dimensions.provenance).toBe("inferred");
    });
    it("the first non-matched provenance wins over a later different one", () => {
        const verdict = qualifyScenario(build(two, { receipt: receiptWith({}, [caseRow({ id: "a", provenance: "stale" }), caseRow({ id: "b", provenance: "inferred" })]) }));
        expect(verdict.dimensions.provenance).toBe("stale");
    });
    it("a conflicting provenance wins and the message carries the case details", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({}, [caseRow({ provenance: "conflict", details: ["example says 3"] })]) }));
        expect(verdict.dimensions.provenance).toBe("conflict");
        expect(messageOf(verdict, "CONTRACT_CONFLICT")).toBe("case orders.create: example says 3");
    });
    it("an executed digest equal to the live digest is accepted", () => {
        const verdict = qualifyScenario(build({}, { generation: { generation: G, gaps: [], caseDigests: { "orders.create": "d".repeat(64) } } }));
        expect(verdict.satisfied).toBe(true);
    });
    it("an executed digest that differs from the live digest is RECEIPT_MISMATCH and the case counts as not run", () => {
        const verdict = qualifyScenario(build({}, { generation: { generation: G, gaps: [], caseDigests: { "orders.create": "e".repeat(64) } }, receipt: receiptWith({}, [caseRow({ state: "failed" })]) }));
        expect(codes(verdict)).toEqual(["RECEIPT_MISMATCH"]);
        expect(verdict.dimensions.execution).toBe("not-run");
        expect(messageOf(verdict, "RECEIPT_MISMATCH")).toContain("dddddddddddd");
        expect(messageOf(verdict, "RECEIPT_MISMATCH")).toContain("eeeeeeeeeeee");
    });
    it("the first non-passing execution state is kept when later cases fail differently", () => {
        const verdict = qualifyScenario(build(two, { receipt: receiptWith({}, [caseRow({ id: "a", state: "failed" }), caseRow({ id: "b", state: "unavailable" })]) }));
        expect(verdict.dimensions.execution).toBe("failed");
        expect(codes(verdict)).toEqual(["CASE_FAILED", "CASE_UNAVAILABLE"]);
    });
    it("a failing case gets its detail text in the reason message", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({}, [caseRow({ state: "failed", details: ["exit 2"] })]) }));
        expect(messageOf(verdict, "CASE_FAILED")).toBe("case orders.create failed: exit 2");
    });
    it("two failing cases yield one CASE_FAILED reason (reasons are de-duplicated by code)", () => {
        const verdict = qualifyScenario(build(two, { receipt: receiptWith({}, [caseRow({ id: "a", state: "failed" }), caseRow({ id: "b", state: "failed" })]) }));
        expect(codes(verdict)).toEqual(["CASE_FAILED"]);
    });
    it("a missing required case is CASE_NOT_RUN naming the case", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({}, []) }));
        expect(messageOf(verdict, "CASE_NOT_RUN")).toBe("required case orders.create is absent from the run");
        expect(verdict.dimensions.execution).toBe("not-run");
    });
});

describe("http boundary — owned services", () => {
    const http: Partial<E2eScenario> = { boundary: { entry: "http", service: "api", real: ["application"] } };
    const httpCase = caseRow({ runnerKind: "http", service: "api" });
    it("an http case through an owned, ready, cleanly stopped declared service is the http-driver boundary", () => {
        const verdict = qualifyScenario(build(http, { receipt: receiptWith({ services: [service()] }, [httpCase]) }));
        expect(verdict.satisfied).toBe(true);
        expect(verdict.dimensions.boundary).toBe("http-driver");
    });
    it("an http case that targets a literal URL (no owned service) is BOUNDARY_UNSUPPORTED", () => {
        const verdict = qualifyScenario(build(http, { receipt: receiptWith({ services: [service()] }, [caseRow({ runnerKind: "http" })]) }));
        expect(messageOf(verdict, "BOUNDARY_UNSUPPORTED")).toContain("targets a literal URL nobody owns");
    });
    it("an http case naming a service the run never owned is BOUNDARY_UNSUPPORTED", () => {
        const verdict = qualifyScenario(build(http, { receipt: receiptWith({}, [httpCase]) }));
        expect(messageOf(verdict, "BOUNDARY_UNSUPPORTED")).toContain('names service "api" that the run never owned');
    });
    it("a service that was never ready is BOUNDARY_UNSUPPORTED with the readiness reason", () => {
        const down = service({ ready: { ok: false, status: null, attempts: 3, durationMs: 9, reason: "connection refused" } });
        const verdict = qualifyScenario(build(http, { receipt: receiptWith({ services: [down] }, [httpCase]) }));
        expect(messageOf(verdict, "BOUNDARY_UNSUPPORTED")).toContain('service "api" was never ready (connection refused)');
        expect(verdict.dimensions.boundary).toBe("unsupported");
    });
    it("a service that did not stop cleanly is BOUNDARY_UNSUPPORTED with the shutdown reason", () => {
        const leaked = service({ shutdown: { ok: false, exitCode: null, signal: null, timedOut: true, portSilent: false, reason: "port still answers" } });
        const verdict = qualifyScenario(build(http, { receipt: receiptWith({ services: [leaked] }, [httpCase]) }));
        expect(messageOf(verdict, "BOUNDARY_UNSUPPORTED")).toContain("did not stop cleanly (port still answers)");
    });
    it("a service with no shutdown record did not stop cleanly", () => {
        const verdict = qualifyScenario(build(http, { receipt: receiptWith({ services: [service({ shutdown: null })] }, [httpCase]) }));
        expect(messageOf(verdict, "BOUNDARY_UNSUPPORTED")).toContain("no shutdown record");
    });
    it("an http case judged by the contracts stage ignores a browser-stage lifetime of the same service", () => {
        const browserBad = service({ stage: "browser", ready: { ok: false, status: null, attempts: 1, durationMs: 1, reason: "browser lifetime" } });
        const verdict = qualifyScenario(build(http, { receipt: receiptWith({ services: [browserBad, service({ stage: "contracts" })] }, [httpCase]) }));
        expect(verdict.satisfied).toBe(true);
    });
    it("a lone record from another stage is still used when no record matches the case's stage", () => {
        const verdict = qualifyScenario(build(http, { receipt: receiptWith({ services: [service({ stage: "browser" })] }, [httpCase]) }));
        expect(verdict.satisfied).toBe(true);
    });
    it("an http case driven through a different service than declared is BOUNDARY_MISMATCH", () => {
        const verdict = qualifyScenario(build(http, { receipt: receiptWith({ services: [service({ id: "other" })] }, [caseRow({ runnerKind: "http", service: "other" })]) }));
        expect(codes(verdict)).toEqual(["BOUNDARY_MISMATCH"]);
        expect(messageOf(verdict, "BOUNDARY_MISMATCH")).toBe("case orders.create is driven through service other; the scenario declares service api");
        expect(verdict.dimensions.boundary).toBe("mismatch");
    });
    it("a process case under a declared http boundary is BOUNDARY_MISMATCH naming both mechanisms", () => {
        const verdict = qualifyScenario(build(http, {}));
        expect(messageOf(verdict, "BOUNDARY_MISMATCH")).toBe("case orders.create runs through process; the scenario declares http");
    });
    it("a structured case under a contract id is BOUNDARY_UNSUPPORTED", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({}, [caseRow({ runnerKind: "structured" })]) }));
        expect(messageOf(verdict, "BOUNDARY_UNSUPPORTED")).toContain("structured report");
    });
    it("a scenario with no declared boundary accepts a process case and reports process-driver", () => {
        const base = build();
        delete base.scenario.boundary;
        expect(qualifyScenario(base).dimensions.boundary).toBe("process-driver");
    });
});

describe("browser boundary", () => {
    const boundary: E2eBoundary = { entry: "browser", service: "web", real: ["application"], requests: [{ method: "POST", path: "/api/orders" }] };
    const browserCase = (extra: Partial<ReceiptCase> = {}): ReceiptCase => caseRow({ id: "pw.order", digest: "c".repeat(64), runnerKind: "browser", service: "web", boundaryRequests: 2, boundaryObservations: [{ method: "POST", path: "/api/orders", status: 201 }], ...extra });
    const run = (cases: ReceiptCase[], services: ServiceRecord[] = [service({ id: "web", stage: "browser" })], scenario: Partial<E2eScenario> = {}): ScenarioVerdict =>
        qualifyScenario(build({ boundary, caseIds: ["pw.order"], ...scenario }, { receipt: receiptWith({ services }, [caseRow(), ...cases]) }));
    it("a browser case that drove the declared operation through the owned app establishes browser-driver, with a process support case", () => {
        const verdict = run([browserCase()]);
        expect(verdict.satisfied).toBe(true);
        expect(verdict.dimensions.boundary).toBe("browser-driver");
        expect(verdict.dimensions.execution).toBe("passed");
    });
    it("a browser case is judged against its browser-stage service lifetime, not the contracts-stage one", () => {
        const contractsBad = service({ id: "web", stage: "contracts", ready: { ok: false, status: null, attempts: 1, durationMs: 1, reason: "contracts lifetime" } });
        expect(run([browserCase()], [contractsBad, service({ id: "web", stage: "browser" })]).satisfied).toBe(true);
        const browserBad = service({ id: "web", stage: "browser", ready: { ok: false, status: null, attempts: 1, durationMs: 1, reason: "browser lifetime" } });
        const verdict = run([browserCase()], [browserBad, service({ id: "web", stage: "contracts" })]);
        expect(messageOf(verdict, "BOUNDARY_UNSUPPORTED")).toContain("browser lifetime");
    });
    it("a browser case under a non-browser declared boundary is BOUNDARY_MISMATCH", () => {
        const verdict = run([browserCase()], undefined, { boundary: { entry: "process", real: ["application"] } });
        expect(messageOf(verdict, "BOUNDARY_MISMATCH")).toBe("case pw.order runs through a browser; the scenario declares process");
        expect(verdict.dimensions.boundary).toBe("mismatch");
    });
    it("a browser case against a service the supervisor did not own is BOUNDARY_UNSUPPORTED", () => {
        const verdict = run([browserCase()], [service({ id: "web", stage: "browser", ready: { ok: false, status: null, attempts: 1, durationMs: 1, reason: "boot failure" } })]);
        expect(codes(verdict)).toEqual(["BOUNDARY_UNSUPPORTED"]);
        expect(verdict.dimensions.boundary).toBe("unsupported");
    });
    it("a browser case driven through a service other than the declared one is BOUNDARY_MISMATCH", () => {
        const verdict = run([browserCase({ service: "admin" })], [service({ id: "admin", stage: "browser" })]);
        expect(messageOf(verdict, "BOUNDARY_MISMATCH")).toBe("case pw.order is driven through service admin; the scenario declares service web");
        expect(verdict.dimensions.boundary).toBe("mismatch");
    });
    it("a browser case with zero proxied requests certifies nothing even when its observations list the operation", () => {
        const verdict = run([browserCase({ boundaryRequests: 0 })]);
        expect(messageOf(verdict, "BOUNDARY_UNSUPPORTED")).toContain("drove no request");
        expect(verdict.dimensions.boundary).toBe("unsupported");
    });
    it("a browser case with no recorded request count certifies nothing", () => {
        const { boundaryRequests: _omitted, ...rest } = browserCase();
        expect(codes(run([rest]))).toContain("BOUNDARY_UNSUPPORTED");
    });
    it("the required operation must be answered below 500: 499 counts, 500 does not", () => {
        expect(run([browserCase({ boundaryObservations: [{ method: "POST", path: "/api/orders", status: 499 }] })]).satisfied).toBe(true);
        const refused = run([browserCase({ boundaryObservations: [{ method: "POST", path: "/api/orders", status: 500 }] })]);
        expect(messageOf(refused, "BOUNDARY_UNSUPPORTED")).toContain("did not drive POST /api/orders");
        expect(messageOf(refused, "BOUNDARY_UNSUPPORTED")).toContain("POST /api/orders → 500");
    });
    it("the observed status must be at least 100: 100 counts, 99 does not", () => {
        expect(run([browserCase({ boundaryObservations: [{ method: "POST", path: "/api/orders", status: 100 }] })]).satisfied).toBe(true);
        expect(codes(run([browserCase({ boundaryObservations: [{ method: "POST", path: "/api/orders", status: 99 }] })]))).toContain("BOUNDARY_UNSUPPORTED");
    });
    it("a different HTTP method does not satisfy the required operation", () => {
        const verdict = run([browserCase({ boundaryObservations: [{ method: "GET", path: "/api/orders", status: 200 }] })]);
        expect(messageOf(verdict, "BOUNDARY_UNSUPPORTED")).toContain("did not drive POST /api/orders");
    });
    it("a query string on the observed path is ignored when matching the required path", () => {
        const verdict = run([browserCase({ boundaryObservations: [{ method: "POST", path: "/api/orders?draft=1", status: 201 }] })]);
        expect(verdict.satisfied).toBe(true);
    });
    it("an exact required path does not match a longer observed path", () => {
        const verdict = run([browserCase({ boundaryObservations: [{ method: "POST", path: "/api/orders/42", status: 201 }] })]);
        expect(codes(verdict)).toContain("BOUNDARY_UNSUPPORTED");
    });
    it("a trailing star in the required path matches by prefix, excluding other prefixes", () => {
        const wildcard: E2eBoundary = { ...boundary, requests: [{ method: "POST", path: "/api/orders/*" }] };
        const hit = run([browserCase({ boundaryObservations: [{ method: "POST", path: "/api/orders/42", status: 201 }] })], undefined, { boundary: wildcard });
        expect(hit.satisfied).toBe(true);
        const miss = run([browserCase({ boundaryObservations: [{ method: "POST", path: "/api/other/42", status: 201 }] })], undefined, { boundary: wildcard });
        expect(codes(miss)).toContain("BOUNDARY_UNSUPPORTED");
    });
    it("a declared browser boundary with no browser case is BOUNDARY_UNSUPPORTED even when support contracts pass", () => {
        const verdict = qualifyScenario(build({ boundary }, {}));
        expect(messageOf(verdict, "BOUNDARY_UNSUPPORTED")).toContain("no browser case established it");
        expect(verdict.dimensions.boundary).toBe("unsupported");
    });
    it("a declared native case that is absent from the report is CASE_NOT_RUN", () => {
        const verdict = qualifyScenario(build({ boundary, caseIds: ["pw.missing"] }, {}));
        expect(messageOf(verdict, "CASE_NOT_RUN")).toBe("declared native case pw.missing is absent from the run's report");
    });
    it("a failing browser case keeps its native-case failure message", () => {
        const verdict = run([browserCase({ state: "failed", details: ["timeout"] })]);
        expect(messageOf(verdict, "CASE_FAILED")).toBe("native case pw.order failed: timeout");
    });
    it("a native structured case needs no boundary evidence and does not disturb a process boundary", () => {
        const verdict = qualifyScenario(build({ caseIds: ["unit.a"] }, { receipt: receiptWith({}, [caseRow(), caseRow({ id: "unit.a", runnerKind: "structured" })]) }));
        expect(verdict.satisfied).toBe(true);
        expect(verdict.dimensions.boundary).toBe("process-driver");
    });
    it("a native case id is never satisfied by a process case of the same id", () => {
        const verdict = qualifyScenario(build({ caseIds: ["orders.create"] }, {}));
        expect(codes(verdict)).toEqual(["CASE_NOT_RUN"]);
    });
});

describe("completion dimension", () => {
    it("a failed preparation step is PREPARE_FAILED and the run is incomplete", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({ prepare: [{ argv: ["node"], exitCode: 1, ok: false, durationMs: 1, stdoutSha256: "", stderrSha256: "", preview: "" }] }) }));
        expect(codes(verdict)).toEqual(["PREPARE_FAILED"]);
        expect(verdict.dimensions.completion).toBe("incomplete");
    });
    it("a passing preparation step does not fail the run", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({ prepare: [{ argv: ["node"], exitCode: 0, ok: true, durationMs: 1, stdoutSha256: "", stderrSha256: "", preview: "" }] }) }));
        expect(verdict.satisfied).toBe(true);
        expect(verdict.dimensions.completion).toBe("complete");
    });
    it("an incomplete run lists its reasons in the message, or says no completion record", () => {
        const withReasons = receiptWith();
        withReasons.completion = { ...withReasons.completion, complete: false, reasons: ["timeout", "oom"] };
        expect(messageOf(qualifyScenario(build({}, { receipt: withReasons })), "RUN_INCOMPLETE")).toBe("the run did not complete: timeout; oom");
        const bare = receiptWith();
        bare.completion = { ...bare.completion, complete: false, reasons: [] };
        expect(messageOf(qualifyScenario(build({}, { receipt: bare })), "RUN_INCOMPLETE")).toBe("the run did not complete: no completion record");
    });
    it("without a receipt completion is not-run", () => {
        expect(qualifyScenario(build({}, { receipt: null, state: undefined })).dimensions.completion).toBe("not-run");
    });
});

describe("sensitivity (proof modes)", () => {
    const proof = { mode: "old-new" as const, revision: "HEAD~1", designated: [{ id: "orders.create" }] };
    const withRecord = (record: SensitivityRecord | undefined, comparison: string | null = REV_A, scenario: Partial<E2eScenario> = { proof }): ScenarioVerdict =>
        qualifyScenario(build(scenario, { generation: { generation: G, gaps: [], ...(comparison === null ? {} : { comparison }) }, receipt: receiptWith(record ? { sensitivity: { "order-persists": record } } : {}) }));
    it("a demonstrated comparison whose revision still resolves to the recorded commit is satisfied", () => {
        const verdict = withRecord(sensitivity());
        expect(verdict.satisfied).toBe(true);
        expect(verdict.dimensions.sensitivity).toBe("demonstrated");
    });
    it("a proof revision that now resolves to another commit is SENSITIVITY_INCONCLUSIVE", () => {
        const verdict = withRecord(sensitivity(), REV_B);
        expect(codes(verdict)).toEqual(["SENSITIVITY_INCONCLUSIVE"]);
        expect(messageOf(verdict, "SENSITIVITY_INCONCLUSIVE")).toContain(`now resolves to ${REV_B.slice(0, 12)}`);
        expect(verdict.dimensions.sensitivity).toBe("inconclusive");
    });
    it("when the current revision is unknown the recorded comparison stands", () => {
        expect(withRecord(sensitivity(), null).satisfied).toBe(true);
    });
    it("a fault comparison is never stale because of the revision", () => {
        const fault = sensitivity({ mode: "controlled-fault", comparison: { kind: "fault", identity: "fault-1", description: "drop persistence" } });
        const verdict = withRecord(fault, REV_B, { proof: { mode: "controlled-fault", designated: [{ id: "orders.create" }] } });
        expect(verdict.satisfied).toBe(true);
    });
    it("an inconclusive record reports its own category reasons rather than the staleness message", () => {
        const record = sensitivity({ verdict: "inconclusive", category: "setup-build-dependency-failure", reasons: ["build failed"] });
        const verdict = withRecord(record, REV_B);
        expect(messageOf(verdict, "SENSITIVITY_INCONCLUSIVE")).toBe("old-new comparison inconclusive (setup-build-dependency-failure): build failed");
    });
    it("a comparison whose own lifecycle did not complete is SENSITIVITY_INCONCLUSIVE with the teardown reasons", () => {
        const verdict = withRecord(sensitivity({ lifecycle: { complete: false, reasons: ["port leaked"] } }));
        expect(messageOf(verdict, "SENSITIVITY_INCONCLUSIVE")).toContain("lifecycle did not complete (port leaked)");
        expect(withRecord(sensitivity({ lifecycle: { complete: true, reasons: [] } })).satisfied).toBe(true);
    });
    it("a lifecycle failure with no reasons says teardown failure", () => {
        expect(messageOf(withRecord(sensitivity({ lifecycle: { complete: false, reasons: [] } })), "SENSITIVITY_INCONCLUSIVE")).toContain("(teardown failure)");
    });
    it("a record for another proof mode is SENSITIVITY_INCONCLUSIVE naming the recorded mode", () => {
        const verdict = withRecord(sensitivity({ mode: "controlled-fault" }));
        expect(messageOf(verdict, "SENSITIVITY_INCONCLUSIVE")).toBe("proof mode old-new is required but the run recorded a controlled-fault comparison");
    });
    it("a required proof mode with no recorded comparison is SENSITIVITY_INCONCLUSIVE", () => {
        const verdict = withRecord(undefined);
        expect(messageOf(verdict, "SENSITIVITY_INCONCLUSIVE")).toBe("proof mode old-new is required but the run recorded no comparison");
        expect(exitCodeFor([verdict])).toBe(2);
    });
    it("a not-demonstrated verdict is SENSITIVITY_NOT_DEMONSTRATED and only that code", () => {
        const verdict = withRecord(sensitivity({ verdict: "not-demonstrated", category: "comparison-passes", reasons: ["both pass"] }));
        expect(codes(verdict)).toEqual(["SENSITIVITY_NOT_DEMONSTRATED"]);
        expect(verdict.dimensions.sensitivity).toBe("not-demonstrated");
        expect(messageOf(verdict, "SENSITIVITY_NOT_DEMONSTRATED")).toBe("old-new comparison did not demonstrate the requirement (comparison-passes): both pass");
    });
    it("a preserved characterization verdict is satisfied", () => {
        const record = sensitivity({ mode: "characterization", verdict: "preserved", category: "comparison-passes" });
        const verdict = withRecord(record, REV_A, { proof: { mode: "characterization", revision: "HEAD~1" } });
        expect(verdict.satisfied).toBe(true);
        expect(verdict.dimensions.sensitivity).toBe("preserved");
    });
    it("execution mode is not-required even if the receipt carries an unrelated record", () => {
        const verdict = withRecord(sensitivity({ verdict: "not-demonstrated" }), REV_A, {});
        expect(verdict.satisfied).toBe(true);
        expect(verdict.dimensions.sensitivity).toBe("not-required");
    });
});

describe("stability cohorts", () => {
    const stable: Partial<E2eScenario> = { stability: { qualificationRuns: 2 } };
    const cohort = (verdict: "in-progress" | "qualified" | "mixed" | "failed" | "unavailable" | "deferred") => ({ cohort: { cohortId: "c1", verdict, record: "cohorts/c1.json" } });
    it("a declared profile with no cohort is STABILITY_NOT_QUALIFIED and names the required run count", () => {
        const verdict = qualifyScenario(build(stable));
        expect(codes(verdict)).toEqual(["STABILITY_NOT_QUALIFIED"]);
        expect(verdict.dimensions.stability).toBe("not-qualified");
        expect(messageOf(verdict, "STABILITY_NOT_QUALIFIED")).toContain("2 independent qualification run(s)");
        expect(messageOf(verdict, "STABILITY_NOT_QUALIFIED")).toContain("--project orders --scenario order-persists");
        expect(exitCodeFor([verdict])).toBe(2);
    });
    it("a qualified cohort satisfies the stability dimension", () => {
        const verdict = qualifyScenario(build(stable, { state: state(cohort("qualified")) }));
        expect(verdict.satisfied).toBe(true);
        expect(verdict.dimensions.stability).toBe("qualified");
    });
    it("a scenario without a stability profile reports not-required", () => {
        expect(qualifyScenario(build({}, { state: state(cohort("mixed")) })).dimensions.stability).toBe("not-required");
    });
    it.each([
        ["mixed", "STABILITY_MIXED", "mixed", "failed"],
        ["failed", "STABILITY_FAILED", "failed", "failed"],
        ["deferred", "STABILITY_DEFERRED", "deferred", "unavailable"],
        ["unavailable", "STABILITY_UNAVAILABLE", "unavailable", "unavailable"],
        ["in-progress", "STABILITY_DEFERRED", "deferred", "unavailable"],
    ] as const)("a %s cohort is %s with dimension %s and status %s", (verdictName, code, dimension, status) => {
        const verdict = qualifyScenario(build(stable, { state: state(cohort(verdictName)) }));
        expect(codes(verdict)).toEqual([code]);
        expect(verdict.dimensions.stability).toBe(dimension);
        expect(verdict.status).toBe(status);
        expect(messageOf(verdict, code)).toBe(`stability cohort c1 is ${verdictName} (record cohorts/c1.json)`);
    });
    it("a quarantine row for the current generation fails the scenario even when a qualified cohort exists", () => {
        const quarantine = { key: "orders/order-persists", generation: G, cohortId: "c0", attempts: [], reason: "mixed attempts", atMs: 1, reviewAtMs: 2 };
        const verdict = qualifyScenario(build(stable, { state: state(cohort("qualified")), quarantine }));
        expect(codes(verdict)).toEqual(["STABILITY_QUARANTINED"]);
        expect(verdict.dimensions.stability).toBe("quarantined");
        expect(verdict.status).toBe("failed");
        expect(messageOf(verdict, "STABILITY_QUARANTINED")).toContain("quarantined since cohort c0: mixed attempts");
    });
});

describe("runtime observations", () => {
    const required = { observations: { runtimeCoverage: "node-required" as const } };
    const summary = (extra: Partial<NonNullable<E2eReceipt["observations"]>> = {}): NonNullable<E2eReceipt["observations"]> => ({ version: 1, runtime: "node", method: "NODE_V8_COVERAGE", attribution: "run", complete: true, files: 1, edges: 1, limits: [], path: "obs.jsonl", ...extra });
    it("complete observations satisfy a node-required project", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({ observations: summary() }) }, required));
        expect(verdict.satisfied).toBe(true);
        expect(verdict.dimensions.observations).toBe("complete");
    });
    it("incomplete observations are OBSERVATIONS_INCOMPLETE listing the limits", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({ observations: summary({ complete: false, limits: ["service api wrote no coverage"] }) }) }, required));
        expect(codes(verdict)).toEqual(["OBSERVATIONS_INCOMPLETE"]);
        expect(messageOf(verdict, "OBSERVATIONS_INCOMPLETE")).toBe("runtime observations incomplete: service api wrote no coverage");
        expect(verdict.dimensions.observations).toBe("incomplete");
    });
    it("incomplete observations without limits say no limit recorded", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({ observations: summary({ complete: false }) }) }, required));
        expect(messageOf(verdict, "OBSERVATIONS_INCOMPLETE")).toContain("no limit recorded");
    });
    it("a node-required project whose run recorded no observations is OBSERVATIONS_INCOMPLETE", () => {
        const verdict = qualifyScenario(build({}, {}, required));
        expect(messageOf(verdict, "OBSERVATIONS_INCOMPLETE")).toBe("the project requires node runtime observations but the run recorded none");
    });
    it("without a receipt the dimension is incomplete but adds no observation reason beyond NO_EVIDENCE", () => {
        const verdict = qualifyScenario(build({}, { receipt: null, state: undefined }, required));
        expect(codes(verdict)).toEqual(["NO_EVIDENCE"]);
        expect(verdict.dimensions.observations).toBe("incomplete");
    });
    it("optional node coverage never gates, even with incomplete observations", () => {
        const verdict = qualifyScenario(build({}, { receipt: receiptWith({ observations: summary({ complete: false }) }) }, { observations: { runtimeCoverage: "node" } }));
        expect(verdict.satisfied).toBe(true);
        expect(verdict.dimensions.observations).toBe("not-required");
    });
});

describe("statusFor and exitCodeFor", () => {
    it("no reasons is satisfied", () => { expect(statusFor([])).toBe("satisfied"); });
    it("only expectation-review codes is review-required", () => {
        expect(statusFor([reason("EXPECTATION_PROPOSED"), reason("EXPECTATION_DISPUTED"), reason("EXPECTATION_SUPERSEDED")])).toBe("review-required");
    });
    it("a review code mixed with a failure is failed, not review-required", () => {
        expect(statusFor([reason("EXPECTATION_PROPOSED"), reason("CASE_FAILED")])).toBe("failed");
    });
    it("a review code mixed with unavailable evidence is unavailable", () => {
        expect(statusFor([reason("EXPECTATION_PROPOSED"), reason("CASE_UNAVAILABLE")])).toBe("unavailable");
    });
    it("a single failure code among unavailable ones makes the status failed", () => {
        expect(statusFor([reason("CASE_UNAVAILABLE"), reason("CASE_FAILED")])).toBe("failed");
    });
    it.each(["CASE_FAILED", "STABILITY_MIXED", "STABILITY_FAILED", "STABILITY_QUARANTINED"] as const)("%s alone is failed", code => {
        expect(statusFor([reason(code)])).toBe("failed");
    });
    it("STALE_GENERATION is stale, and outranks unavailable evidence", () => {
        expect(statusFor([reason("STALE_GENERATION")])).toBe("stale");
        expect(statusFor([reason("CASE_UNAVAILABLE"), reason("STALE_GENERATION")])).toBe("stale");
    });
    it("evidence-missing codes that are neither failed nor unavailable are pending", () => {
        expect(statusFor([reason("NO_EVIDENCE")])).toBe("pending");
        expect(statusFor([reason("RECEIPT_MISMATCH"), reason("BOUNDARY_MISMATCH")])).toBe("pending");
    });
    it("a measured failure beside unavailable evidence exits 1", () => {
        const two = build({ contractIds: ["a", "b"] }, { receipt: receiptWith({}, [caseRow({ id: "a", state: "failed" }), caseRow({ id: "b", state: "unavailable" })]) });
        expect(exitCodeFor([qualifyScenario(two)])).toBe(1);
    });
    it("a non-required unsatisfied scenario never gates", () => {
        expect(exitCodeFor([qualifyScenario(build({ required: false }, { receipt: null, state: undefined }))])).toBe(0);
    });
});
