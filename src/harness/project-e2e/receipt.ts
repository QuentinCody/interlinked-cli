// ===========================================
// Versioned run receipt — evidence with explicit scope, never a certificate
// ===========================================
// Plan 31 §11. One receipt per supervised run, written once (`wx`) under its
// own run directory so an old report cannot be copied into a new run
// (PE-10). Every dimension the qualification predicate reads is a separate
// field: selection, attempts, provenance, authority, completion. The reader
// is a constructing parser: every discriminant qualification consumes is
// validated, and an unknown value (a `skipped` case, a missing flag) makes
// the whole receipt unreadable — unverified, never green.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { contractPath } from "../contracts/paths.js";
import type { ContractEvidence, ContractState } from "../contracts/types.js";
import type { InputFile } from "./generation.js";
import { OBSERVABLE_KEYS, type E2eDesignated, type ExpectationLifecycle, type ExpectationOrigin } from "./policy.js";
import type { RuntimeObservationSummary } from "./runtime-observations.js";
import type { SensitivityRecord, SideOutcome } from "./sensitivity.js";
import type { ServiceRecord } from "./services.js";

export const E2E_RUNS_DIRECTORY = ".interlinked/test-runs/e2e";
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const CASE_STATES: readonly ContractState[] = ["passed", "failed", "unavailable", "stale", "not-run"];
const AUTHORITIES = ["configured", "proposed"] as const;
const PROVENANCES: readonly ContractEvidence["provenance"][] = ["matched", "stale", "inferred", "unavailable", "conflict"];
const RUNNER_KINDS = ["process", "http", "structured", "browser"] as const;
const REPORT_FORMATS = ["json", "junit", "playwright"] as const;
const SERVICE_STAGES = ["browser", "contracts"] as const;
const LIFECYCLES: readonly ExpectationLifecycle[] = ["proposed", "accepted", "disputed", "superseded"];
const ORIGINS: readonly ExpectationOrigin[] = ["user-requirement", "approved-specification", "regression-report", "existing-behavior", "agent-inference"];

export interface ReceiptCase {
    id: string; digest: string; authority: "configured" | "proposed"; provenance: ContractEvidence["provenance"]; state: ContractState;
    /** `structured`: a native case normalized from the suite's JSON/JUnit report (execution evidence only, no boundary). */ runnerKind: "process" | "http" | "structured" | "browser"; details: string[]; inputHash?: string; observations?: ContractEvidence["observations"];
    /** The OWNED service an http case was driven through (Unit D1); absent on a literal-URL case, which no supervisor owns. */ service?: string;
    /** `browser` (Unit E2): requests the supervisor's proxy observed inside this case's attempt window; 0 ⇒ the case never reached the owned app. */ boundaryRequests?: number;
    /** `browser` (review E5): the observed requests themselves (bounded), so qualification can demand the operation under test, not any request. */ boundaryObservations?: BoundaryObservation[];
}
export interface BoundaryObservation { method: string; path: string; status: number; }
/** The structured report a run produced in its snapshot, bound by digest so a later copy cannot stand in for it. */
export interface ReceiptReport { format: "json" | "junit" | "playwright"; path: string; sha256: string; cases: number; }
export interface PrepareResult { argv: string[]; exitCode: number | null; ok: boolean; durationMs: number; stdoutSha256: string; stderrSha256: string; preview: string; }
export interface ReceiptAuthority { expectationId: string; lifecycle: ExpectationLifecycle; origin: ExpectationOrigin; revision: string; }
export interface ReceiptCompletion { generationBefore: string; generationAfter: string; inputsChangedDuringRun: boolean; complete: boolean; durationMs: number; reasons: string[]; }
export interface E2eReceipt {
    version: 1; runId: string; requestIds: string[]; initiator?: string;
    project: { id: string; root: string; canonicalRoot: string }; scenarioIds: string[];
    policyDigest: string; generation: string; /** Per-scenario generation when one run covered several scenarios. */ scenarioGenerations?: Record<string, string>; target: { mode: "working-tree" };
    inputs: InputFile[]; inputGaps: string[];
    runtime: { interlinked: string; node: string; platform: string; arch: string };
    prepare: PrepareResult[]; artifacts: InputFile[];
    /** structured-runner suites: the test command's outcome and the report it wrote. */ execution?: PrepareResult; report?: ReceiptReport;
    /** Owned services this run started (Unit D1, §11 build/services): identity, readiness, restarts and shutdown outcome. */ services?: ServiceRecord[];
    /** Per scenario id: the comparison side and the classified verdict for a non-execution proof mode (Unit D3, §11 sensitivity). */ sensitivity?: Record<string, SensitivityRecord>;
    /** The stability-cohort attempt this run was (Unit E1, §11 stability): cohort id, attempt index, the seed and clock every owned process saw. */ stability?: { cohortId: string; attempt: number; seed: string; clock: string };
    /** Runtime observation summary (Unit E4, §7.4): present only when the project declares a profile; the edges live in `path` beside the receipt. */ observations?: RuntimeObservationSummary;
    selection: { required: string[]; observed: string[] };
    cases: ReceiptCase[]; authority: ReceiptAuthority[]; completion: ReceiptCompletion;
    startedAt: string; finishedAt: string;
}
export interface ReceiptSeed { runId: string; project: E2eReceipt["project"]; scenarioIds: string[]; policyDigest: string; generation: string; }

export function emptyReceipt(seed: ReceiptSeed): E2eReceipt {
    const now = new Date().toISOString();
    return {
        version: 1, runId: seed.runId, requestIds: [], project: seed.project, scenarioIds: [...seed.scenarioIds], policyDigest: seed.policyDigest, generation: seed.generation,
        target: { mode: "working-tree" }, inputs: [], inputGaps: [], runtime: { interlinked: "unknown", node: process.versions.node, platform: process.platform, arch: process.arch },
        prepare: [], artifacts: [], selection: { required: [], observed: [] }, cases: [], authority: [],
        completion: { generationBefore: seed.generation, generationAfter: "", inputsChangedDuringRun: false, complete: false, durationMs: 0, reasons: [] },
        startedAt: now, finishedAt: now,
    };
}
function receiptPath(runId: string): string { return `${E2E_RUNS_DIRECTORY}/${runId}/receipt.json`; }
/** Writes once and atomically: the bytes land in a temp file and are renamed into place (a crash mid-write leaves no half receipt, C3); a second write to the same run directory throws (no substitution). Returns the project-relative path. */
export function writeE2eReceipt(root: string, receipt: E2eReceipt): string {
    const path = receiptPath(receipt.runId);
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    if (existsSync(absolute)) throw new Error(`receipt already published for run ${receipt.runId}; a run publishes once`);
    const temp = `${absolute}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, absolute);
    return path;
}

// ---- constructing parser -------------------------------------------------
class Invalid extends Error {}
function fail(message: string): never { throw new Invalid(message); }
function obj(value: unknown, where: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
    // SAFETY: guarded above.
    return value as Record<string, unknown>;
}
function str(value: unknown, where: string): string { if (typeof value !== "string") fail(`${where} must be a string`); return value; }
function hex(value: unknown, where: string): string { const text = str(value, where); if (!HEX.test(text)) fail(`${where} must be a sha256 digest`); return text; }
function bool(value: unknown, where: string): boolean { if (typeof value !== "boolean") fail(`${where} must be a boolean`); return value; }
function num(value: unknown, where: string): number { if (typeof value !== "number" || !Number.isFinite(value)) fail(`${where} must be a finite number`); return value; }
function strings(value: unknown, where: string): string[] { if (!Array.isArray(value)) fail(`${where} must be a list`); return value.map((item, index) => str(item, `${where}[${index}]`)); }
function member<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail(`${where} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`);
    // SAFETY: membership checked.
    return value as T;
}
function inputFiles(value: unknown, where: string): InputFile[] {
    if (!Array.isArray(value)) fail(`${where} must be a list`);
    return value.map((item, index) => {
        const row = obj(item, `${where}[${index}]`);
        const file: InputFile = { path: str(row.path, `${where}[${index}].path`), sha256: hex(row.sha256, `${where}[${index}].sha256`) };
        if (row.mode !== undefined) file.mode = num(row.mode, `${where}[${index}].mode`);
        return file;
    });
}
function parseCase(value: unknown, where: string): ReceiptCase {
    const row = obj(value, where);
    const result: ReceiptCase = {
        id: str(row.id, `${where}.id`), digest: hex(row.digest, `${where}.digest`), authority: member(row.authority, AUTHORITIES, `${where}.authority`),
        provenance: member(row.provenance, PROVENANCES, `${where}.provenance`), state: member(row.state, CASE_STATES, `${where}.state`),
        runnerKind: member(row.runnerKind, RUNNER_KINDS, `${where}.runnerKind`), details: strings(row.details, `${where}.details`),
    };
    if (row.inputHash !== undefined) result.inputHash = hex(row.inputHash, `${where}.inputHash`);
    if (row.service !== undefined) result.service = str(row.service, `${where}.service`);
    if (row.boundaryRequests !== undefined) result.boundaryRequests = num(row.boundaryRequests, `${where}.boundaryRequests`);
    if (row.boundaryObservations !== undefined) result.boundaryObservations = list(row.boundaryObservations, `${where}.boundaryObservations`, (item, at) => { const seen = obj(item, at); return { method: str(seen.method, `${at}.method`), path: str(seen.path, `${at}.path`), status: num(seen.status, `${at}.status`) }; });
    if (row.observations !== undefined) {
        const observations = obj(row.observations, `${where}.observations`);
        result.observations = { stdoutSha256: hex(observations.stdoutSha256, `${where}.observations.stdoutSha256`), stderrSha256: hex(observations.stderrSha256, `${where}.observations.stderrSha256`), stdoutPreview: str(observations.stdoutPreview, `${where}.observations.stdoutPreview`) };
        if (observations.exitCode !== undefined) result.observations.exitCode = num(observations.exitCode, `${where}.observations.exitCode`);
        if (observations.status !== undefined) result.observations.status = num(observations.status, `${where}.observations.status`);
        if (observations.pid !== undefined) result.observations.pid = num(observations.pid, `${where}.observations.pid`);
        if (observations.matched !== undefined) result.observations.matched = strings(observations.matched, `${where}.observations.matched`);
        if (observations.mismatched !== undefined) result.observations.mismatched = strings(observations.mismatched, `${where}.observations.mismatched`);
    }
    return result;
}
function parsePrepare(value: unknown, where: string): PrepareResult {
    const row = obj(value, where);
    const exitCode = row.exitCode === null ? null : num(row.exitCode, `${where}.exitCode`);
    return { argv: strings(row.argv, `${where}.argv`), exitCode, ok: bool(row.ok, `${where}.ok`), durationMs: num(row.durationMs, `${where}.durationMs`), stdoutSha256: hex(row.stdoutSha256, `${where}.stdoutSha256`), stderrSha256: hex(row.stderrSha256, `${where}.stderrSha256`), preview: str(row.preview, `${where}.preview`) };
}
function parseAuthority(value: unknown, where: string): ReceiptAuthority {
    const row = obj(value, where);
    return { expectationId: str(row.expectationId, `${where}.expectationId`), lifecycle: member(row.lifecycle, LIFECYCLES, `${where}.lifecycle`), origin: member(row.origin, ORIGINS, `${where}.origin`), revision: hex(row.revision, `${where}.revision`) };
}
function parseCompletion(value: unknown, where: string): ReceiptCompletion {
    const row = obj(value, where);
    return { generationBefore: hex(row.generationBefore, `${where}.generationBefore`), generationAfter: str(row.generationAfter, `${where}.generationAfter`), inputsChangedDuringRun: bool(row.inputsChangedDuringRun, `${where}.inputsChangedDuringRun`), complete: bool(row.complete, `${where}.complete`), durationMs: num(row.durationMs, `${where}.durationMs`), reasons: strings(row.reasons, `${where}.reasons`) };
}
function parseGenerations(value: unknown, where: string): Record<string, string> {
    const row = obj(value, where);
    return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, hex(item, `${where}.${key}`)]));
}
/** Unit C2 optional fields: the structured test command's outcome and the report it wrote (digest-bound). */
function parseStructuredFields(row: Record<string, unknown>, receipt: E2eReceipt): void {
    if (row.execution !== undefined) receipt.execution = parsePrepare(row.execution, "receipt.execution");
    if (row.report === undefined) return;
    const report = obj(row.report, "receipt.report");
    receipt.report = { format: member(report.format, REPORT_FORMATS, "receipt.report.format"), path: str(report.path, "receipt.report.path"), sha256: hex(report.sha256, "receipt.report.sha256"), cases: num(report.cases, "receipt.report.cases") };
}
function nullableNum(value: unknown, where: string): number | null { return value === null ? null : num(value, where); }
function nullableStr(value: unknown, where: string): string | null { return value === null ? null : str(value, where); }
function parseShutdown(value: unknown, where: string): ServiceRecord["shutdown"] {
    if (value === null) return null;
    const row = obj(value, where);
    const shutdown: NonNullable<ServiceRecord["shutdown"]> = { ok: bool(row.ok, `${where}.ok`), exitCode: nullableNum(row.exitCode, `${where}.exitCode`), signal: nullableStr(row.signal, `${where}.signal`), timedOut: bool(row.timedOut, `${where}.timedOut`), portSilent: bool(row.portSilent, `${where}.portSilent`) };
    if (row.reason !== undefined) shutdown.reason = str(row.reason, `${where}.reason`);
    return shutdown;
}
/** Unit D1: one owned service's lifecycle; every flag qualification reads (ready.ok, shutdown.ok, portSilent) is validated. */
function parseService(value: unknown, where: string): ServiceRecord {
    const row = obj(value, where), ready = obj(row.ready, `${where}.ready`);
    const record: ServiceRecord = {
        id: str(row.id, `${where}.id`), argv: strings(row.argv, `${where}.argv`), port: num(row.port, `${where}.port`), pid: nullableNum(row.pid, `${where}.pid`),
        ready: { ok: bool(ready.ok, `${where}.ready.ok`), status: nullableNum(ready.status, `${where}.ready.status`), attempts: num(ready.attempts, `${where}.ready.attempts`), durationMs: num(ready.durationMs, `${where}.ready.durationMs`) },
        restarts: num(row.restarts, `${where}.restarts`), shutdown: parseShutdown(row.shutdown, `${where}.shutdown`),
        pids: row.pids === undefined ? [] : list(row.pids, `${where}.pids`, (item, at) => num(item, at)),
        stage: row.stage === undefined ? "contracts" : member(row.stage, SERVICE_STAGES, `${where}.stage`),
    };
    if (ready.reason !== undefined) record.ready.reason = str(ready.reason, `${where}.ready.reason`);
    return record;
}
const PROOF_MODES = ["old-new", "controlled-fault", "characterization"] as const;
const COMPARISON_KINDS = ["revision", "fault"] as const;
const SENSITIVITY_VERDICTS = ["demonstrated", "preserved", "not-demonstrated", "inconclusive"] as const;
const SENSITIVITY_CATEGORIES = ["designated-expectation-mismatch", "setup-build-dependency-failure", "unrelated-assertion-failure", "generic-runner-timeout-crash", "comparison-passes", "candidate-not-passing", "comparison-unavailable", "comparison-lifecycle-failure", "action-evidence-undeclared"] as const;
/** A designated case as the policy declared it (review round 2): id plus its outcome/action split — the evidence the verdict was read against. */
function parseDesignated(item: unknown, at: string): E2eDesignated {
    const row = obj(item, at);
    const entry: E2eDesignated = { id: str(row.id, `${at}.id`) };
    if (row.outcome !== undefined) entry.outcome = list(row.outcome, `${at}.outcome`, (key, where) => member(key, OBSERVABLE_KEYS, where));
    if (row.action !== undefined) entry.action = strings(row.action, `${at}.action`);
    return entry;
}
function sideOutcome(item: unknown, at: string): SideOutcome {
    const row = obj(item, at);
    const outcome: SideOutcome = { id: str(row.id, `${at}.id`), state: member(row.state, CASE_STATES, `${at}.state`) };
    if (row.matched !== undefined) outcome.matched = strings(row.matched, `${at}.matched`);
    if (row.mismatched !== undefined) outcome.mismatched = strings(row.mismatched, `${at}.mismatched`);
    if (row.primaryOutput !== undefined) outcome.primaryOutput = bool(row.primaryOutput, `${at}.primaryOutput`);
    if (row.exitCode !== undefined) outcome.exitCode = nullableNum(row.exitCode, `${at}.exitCode`);
    if (row.status !== undefined) outcome.status = num(row.status, `${at}.status`);
    return outcome;
}
/** The comparison side's lifecycle evidence (review D2): completion, its reasons and every owned service's record. */
function parseLifecycle(value: unknown, where: string): NonNullable<SensitivityRecord["lifecycle"]> {
    const row = obj(value, where);
    const lifecycle: NonNullable<SensitivityRecord["lifecycle"]> = { complete: bool(row.complete, `${where}.complete`), reasons: strings(row.reasons, `${where}.reasons`) };
    if (row.services !== undefined) lifecycle.services = list(row.services, `${where}.services`, parseService);
    return lifecycle;
}
/** Unit D3: every discriminant qualification reads (mode, verdict, category) is validated; both sides' outcomes are constructed. */
function parseSensitivity(value: unknown, where: string): SensitivityRecord {
    const row = obj(value, where), comparison = obj(row.comparison, `${where}.comparison`);
    const record: SensitivityRecord = {
        mode: member(row.mode, PROOF_MODES, `${where}.mode`), verdict: member(row.verdict, SENSITIVITY_VERDICTS, `${where}.verdict`), category: member(row.category, SENSITIVITY_CATEGORIES, `${where}.category`),
        comparison: { kind: member(comparison.kind, COMPARISON_KINDS, `${where}.comparison.kind`), identity: str(comparison.identity, `${where}.comparison.identity`), description: str(comparison.description, `${where}.comparison.description`) },
        designated: list(row.designated, `${where}.designated`, parseDesignated), candidate: list(row.candidate, `${where}.candidate`, sideOutcome), compared: list(row.compared, `${where}.compared`, sideOutcome), reasons: strings(row.reasons, `${where}.reasons`),
    };
    if (row.lifecycle !== undefined) record.lifecycle = parseLifecycle(row.lifecycle, `${where}.lifecycle`);
    return record;
}
/** Unit D optional groups: owned services (D1) and per-scenario sensitivity (D3). */
function parseUnitDFields(row: Record<string, unknown>, receipt: E2eReceipt): void {
    if (row.services !== undefined) receipt.services = list(row.services, "receipt.services", parseService);
    if (row.sensitivity !== undefined) receipt.sensitivity = Object.fromEntries(Object.entries(obj(row.sensitivity, "receipt.sensitivity")).map(([id, item]) => [id, parseSensitivity(item, `receipt.sensitivity.${id}`)]));
    if (row.observations !== undefined) receipt.observations = parseObservations(row.observations);
    if (row.stability === undefined) return;
    const stability = obj(row.stability, "receipt.stability");
    receipt.stability = { cohortId: str(stability.cohortId, "receipt.stability.cohortId"), attempt: num(stability.attempt, "receipt.stability.attempt"), seed: str(stability.seed, "receipt.stability.seed"), clock: str(stability.clock, "receipt.stability.clock") };
}
function parseObservations(value: unknown): RuntimeObservationSummary {
    const row = obj(value, "receipt.observations"), where = "receipt.observations";
    if (row.version !== 1 || typeof row.complete !== "boolean") fail(`${where} needs version 1 and a boolean complete`);
    return {
        version: 1, runtime: member(row.runtime, ["node"] as const, `${where}.runtime`), method: member(row.method, ["NODE_V8_COVERAGE"] as const, `${where}.method`), attribution: member(row.attribution, ["run"] as const, `${where}.attribution`),
        complete: row.complete, files: num(row.files, `${where}.files`), edges: num(row.edges, `${where}.edges`), limits: strings(row.limits, `${where}.limits`), path: str(row.path, `${where}.path`),
    };
}
function list<T>(value: unknown, where: string, parse: (item: unknown, at: string) => T): T[] {
    if (!Array.isArray(value)) fail(`${where} must be a list`);
    return value.map((item, index) => parse(item, `${where}[${index}]`));
}
/** Rebuilds a typed receipt field by field; throws `Invalid` on the first unknown discriminant or missing flag. */
export function parseE2eReceipt(value: unknown): E2eReceipt {
    const row = obj(value, "receipt");
    if (row.version !== 1) fail("receipt version must be 1");
    const project = obj(row.project, "receipt.project"), runtime = obj(row.runtime, "receipt.runtime"), selection = obj(row.selection, "receipt.selection"), target = obj(row.target, "receipt.target");
    if (target.mode !== "working-tree") fail("receipt.target.mode must be working-tree");
    const receipt: E2eReceipt = {
        version: 1, runId: str(row.runId, "receipt.runId"), requestIds: strings(row.requestIds, "receipt.requestIds"),
        project: { id: str(project.id, "receipt.project.id"), root: str(project.root, "receipt.project.root"), canonicalRoot: str(project.canonicalRoot, "receipt.project.canonicalRoot") },
        scenarioIds: strings(row.scenarioIds, "receipt.scenarioIds"), policyDigest: hex(row.policyDigest, "receipt.policyDigest"), generation: hex(row.generation, "receipt.generation"),
        target: { mode: "working-tree" }, inputs: inputFiles(row.inputs, "receipt.inputs"), inputGaps: strings(row.inputGaps, "receipt.inputGaps"),
        runtime: { interlinked: str(runtime.interlinked, "receipt.runtime.interlinked"), node: str(runtime.node, "receipt.runtime.node"), platform: str(runtime.platform, "receipt.runtime.platform"), arch: str(runtime.arch, "receipt.runtime.arch") },
        prepare: list(row.prepare, "receipt.prepare", parsePrepare), artifacts: inputFiles(row.artifacts, "receipt.artifacts"),
        selection: { required: strings(selection.required, "receipt.selection.required"), observed: strings(selection.observed, "receipt.selection.observed") },
        cases: list(row.cases, "receipt.cases", parseCase), authority: list(row.authority, "receipt.authority", parseAuthority), completion: parseCompletion(row.completion, "receipt.completion"),
        startedAt: str(row.startedAt, "receipt.startedAt"), finishedAt: str(row.finishedAt, "receipt.finishedAt"),
    };
    if (row.initiator !== undefined) receipt.initiator = str(row.initiator, "receipt.initiator");
    if (row.scenarioGenerations !== undefined) receipt.scenarioGenerations = parseGenerations(row.scenarioGenerations, "receipt.scenarioGenerations");
    parseStructuredFields(row, receipt);
    parseUnitDFields(row, receipt);
    if (new Set(receipt.cases.map(item => item.id)).size !== receipt.cases.length) fail("receipt.cases has duplicate case ids");
    return receipt;
}
export type ReadReceipt = { receipt: E2eReceipt; issue?: undefined } | { receipt: null; issue: string };
/** Reads a confined receipt. Anything that does not parse strictly is reported as an issue — unverified, never a guess. */
export function readE2eReceiptDetailed(root: string, path: string): ReadReceipt {
    try {
        const content = readFileSync(contractPath(root, path), "utf8");
        if (Buffer.byteLength(content) > MAX_RECEIPT_BYTES) return { receipt: null, issue: "receipt exceeds 8 MiB" };
        return { receipt: parseE2eReceipt(JSON.parse(content)) };
    } catch (error) { return { receipt: null, issue: error instanceof Error ? error.message : String(error) }; }
}
export function readE2eReceipt(root: string, path: string): E2eReceipt | null {
    return readE2eReceiptDetailed(root, path).receipt;
}
