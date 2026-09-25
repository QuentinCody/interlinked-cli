// ===========================================
// Project e2e policy — versioned, project-owned, language-independent
// ===========================================
// `.interlinked/e2e-policy.json` is the authority for required behavior
// (plan 31 §4.1, §5). Discovery proposes; this file decides. The parser is
// strict on purpose: an unknown key, an unknown version, a shell string where
// argv belongs, or a path that escapes the project is a refusal, never a
// guess. Expectation records live here too (§6.4, §14) so acceptance binds to
// the same digest the scenario is judged against.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, globList, id, oneOf, onlyKeys, record, relativePath, stringList, unique } from "./policy-primitives.js";
import { parseStability } from "./policy-stability.js";
import { parseSuite } from "./policy-suites.js";

export { E2E_PLACEHOLDERS, SERVICE_PLACEHOLDERS } from "./policy-primitives.js";
export const E2E_POLICY_PATH = ".interlinked/e2e-policy.json";
const MAX_POLICY_BYTES = 1024 * 1024;
/** Surface ids carry the extractor's `<kind>:<address>` shape (`cli:orders`, `http:GET /orders/{id}`), so they admit `:`, `/`, space and braces. */
const SURFACE_ID = /^[a-zA-Z0-9_.:/{} -]{1,200}$/;

export interface E2eArgvStep { argv: string[]; }
export type ReportFormat = "json" | "junit" | "playwright";
/** A managed HTTP service the supervisor OWNS for a managed-contracts suite (Unit D1, §5.3/§9.1): argv/env may use `{port}`, readiness is an HTTP status at a path. */
export interface E2eService { id: string; argv: string[]; env?: Record<string, string>; ready: { kind: "http"; path: string; status: number }; }
/** A structured-runner suite (Unit C, §10.1): an arbitrary test command plus a JSON-protocol or JUnit report it writes in the snapshot. Execution evidence only. */
export interface E2eSuite { id: string; adapter: "managed-contracts" | "structured-runner" | "playwright"; prepare?: E2eArgvStep[]; artifacts?: string[]; run?: E2eArgvStep; report?: { format: ReportFormat; path: string }; services?: E2eService[]; }
/** `service` names the suite's owned service an `http` boundary is driven through; `real` components must be establishable by the adapter. */
/** One request the supervisor's proxy must observe during the browser case (E5): the operation under test, never the page shell. `path` may end in `*` for a prefix. */
export interface E2eRequiredRequest { method: string; path: string; }
export interface E2eBoundary { entry: "process" | "http" | "browser"; service?: string; real: string[]; allowedDoubles?: string[]; /** browser only (required there): the API operations the case must drive through the owned app. */ requests?: E2eRequiredRequest[]; }
/** Evidence modes (§9.4): execution is the default; the others require a comparison side the supervisor builds itself. */
export type ProofMode = "execution" | "old-new" | "controlled-fault" | "characterization";
/** One recorded behavior-breaking alternative: stable id, exact changed bytes (find → replace, exactly one occurrence) and the rationale. */
export interface E2eFault { id: string; path: string; find: string; replace: string; rationale: string; }
/** A contract case's observable keys (the members of its `expect` block): what a designated outcome may name. */
export const OBSERVABLE_KEYS = ["files", "stdout", "stderr", "exitCode", "status", "json", "headers"] as const;
export type ObservableKey = typeof OBSERVABLE_KEYS[number];
/**
 * One designated case of a proof (§9.4 step 4, review round 2). A comparison demonstrates a requirement only when the case's
 * ACTION is established by declared evidence and its designated OUTCOME differs: `outcome` names the observables that ARE the
 * outcome (every other observable the case declares must hold on the comparison side), `action` names cases that must PASS on
 * the comparison side first (a workflow's earlier steps: create before read-back). Output presence and exit/status classes are
 * never evidence; without a declaration the cause of a failure is unknown and the proof is inconclusive.
 */
export interface E2eDesignated { id: string; outcome?: ObservableKey[]; action?: string[]; }
export interface E2eProof {
    mode: ProofMode;
    /** old-new / characterization: the git revision whose export is the comparison side. */ revision?: string;
    /** controlled-fault: the fault applied to a copy of the candidate. */ fault?: E2eFault;
    /** old-new / controlled-fault (required): the cases whose designated outcome must fail on the comparison, with their action evidence; characterization (optional): the cases that must hold on both sides (default: every bound contract). */ designated?: E2eDesignated[];
}
/** §9.5 stability profile: `qualificationRuns` independent attempts must all pass at qualification; the baseline seed and an optional fixed clock are recorded and passed to every owned process. */
export interface E2eStability { qualificationRuns: number; seed?: string; clock?: string; }
export interface E2eScenario {
    id: string; suite: string; description?: string; affects: string[]; contractIds: string[]; proof?: E2eProof; stability?: E2eStability;
    /** Declared NATIVE case ids a structured-runner suite's report must contain (explicit selection; never inferred from the report). */ caseIds?: string[];
    expectationIds?: string[]; /** Explicit surface mappings (plan §6.5); discovery proposes, only policy binds. */ surfaceIds?: string[]; required: boolean; boundary?: E2eBoundary;
}
/** `review: "require"` makes a bound PROPOSED expectation block completion (plan §6.4: opt-in, never inferred). */
export interface E2eGates { stop?: "warn" | "off"; commit?: "require" | "warn" | "off"; ci?: "require" | "warn" | "off"; review?: "require" | "advisory"; }
/** What the shipped managed-contracts adapter can actually establish (plan §10.2). Anything else is refused, not silently passed. */
export const SUPPORTED_BOUNDARY_ENTRIES = ["process", "http", "browser"] as const;
/** `fixture-store` is establishable only for an `http` boundary whose owned service binds `{fixture-directory}` in its env (§5.3). */
export const SUPPORTED_REAL_COMPONENTS = ["application", "fixture-store"] as const;
/** An explicitly declared addressable entry point (plan §6.5): the language-independent fallback for interfaces no extractor knows. */
export interface E2eSurface { id: string; kind: "cli" | "http" | "other"; address: string; method?: string; description?: string; }
/** §7.4 (Unit E4): optional runtime observation profile. `node` collects NODE_V8_COVERAGE from owned Node processes as an optional gap; `node-required` makes incomplete observations a qualification failure. */
export interface E2eObservations { runtimeCoverage: "off" | "node" | "node-required"; }
export interface E2eProject {
    id: string; root: string; contractManifest?: string; protectedInputs: string[]; sharedInputs?: string[];
    mode: "advisory" | "required"; gates?: E2eGates; suites: E2eSuite[]; scenarios: E2eScenario[]; surfaces?: E2eSurface[]; observations?: E2eObservations;
}
export type ExpectationLifecycle = "proposed" | "accepted" | "disputed" | "superseded";
export type ExpectationOrigin = "user-requirement" | "approved-specification" | "regression-report" | "existing-behavior" | "agent-inference";
export interface E2eSourceRef { kind: "requirement" | "example" | "regression" | "conversation" | "inferred"; path: string; sha256: string; quote: string; }
export interface E2eReview { atMs: number; action: "propose" | "accept" | "dispute" | "replace"; revision: string; rationale: string; authority: "configured"; }
export interface E2eExpectation {
    id: string; projectId: string; scenarioIds: string[]; statement: string; origin: ExpectationOrigin;
    sources: E2eSourceRef[]; assumptions: string[]; questions: string[]; examples: { positive: string[]; negative: string[] };
    contractIds: string[]; lifecycle: ExpectationLifecycle; revision: string; history: E2eReview[]; supersededBy?: string;
}
/** Adopted automatic execution bounds (§9.3, Unit C5); every field optional, resolved against `DEFAULT_SCHEDULING` (autoRun defaults to false). */
export interface E2eScheduling { autoRun?: boolean; quietMs?: number; minIntervalMs?: number; budgetMs?: number; }
export interface E2ePolicy { version: 1; sharedInputs?: string[]; projects: E2eProject[]; expectations: E2eExpectation[]; scheduling?: E2eScheduling; }
const SCHEDULING_BOUNDS: Record<"quietMs" | "minIntervalMs" | "budgetMs", [number, number]> = { quietMs: [1_000, 60_000], minIntervalMs: [10_000, 3_600_000], budgetMs: [10_000, 600_000] };

/** An `http` or `browser` boundary must name an OWNED service of the suite; `fixture-store` is real only when that service's env binds `{fixture-directory}`. */
function serviceBoundary(row: Record<string, unknown>, where: string, suite: E2eSuite, real: string[]): string {
    const serviceId = id(row.service, `${where}.service`);
    const owned = suite.services?.find(item => item.id === serviceId);
    if (!owned) fail(`${where}.service "${serviceId}" is not an owned service of suite ${suite.id}; an unowned responder cannot certify a real application`);
    if (real.includes("fixture-store") && !Object.values(owned.env ?? {}).some(item => item.includes("{fixture-directory}"))) fail(`${where}.real "fixture-store" needs service ${serviceId} to bind {fixture-directory} in its env; otherwise the store is not the run's disposable fixture`);
    return serviceId;
}
const HTTP_METHOD = /^[A-Z]{3,10}$/;
/** E5: a browser boundary names the requests that ARE the behavior under test; a page load or a health check cannot stand in for them. */
function requiredRequests(value: unknown, where: string): E2eRequiredRequest[] {
    if (!Array.isArray(value) || !value.length || value.length > 32) fail(`${where} must list 1–32 requests the browser case must drive through the owned application (e.g. {"method":"POST","path":"/orders"}); a page shell earns no boundary`);
    return value.map((item, index) => {
        const row = record(item, `${where}[${index}]`);
        onlyKeys(row, ["method", "path"], `${where}[${index}]`);
        if (typeof row.method !== "string" || !HTTP_METHOD.test(row.method)) fail(`${where}[${index}].method must be an upper-case HTTP method`);
        if (typeof row.path !== "string" || !row.path.startsWith("/") || row.path.length > 512) fail(`${where}[${index}].path must start with "/" (a trailing * matches a prefix)`);
        return { method: row.method, path: row.path };
    });
}
function boundary(value: unknown, where: string, suite: E2eSuite): E2eBoundary {
    const row = record(value, where);
    onlyKeys(row, ["entry", "service", "real", "allowedDoubles", "requests"], where);
    const entry = oneOf(row.entry, SUPPORTED_BOUNDARY_ENTRIES, `${where}.entry`);
    const real = stringList(row.real, `${where}.real`, 32);
    for (const component of real) {
        if (!(SUPPORTED_REAL_COMPONENTS as readonly string[]).includes(component)) fail(`${where}.real "${component}" cannot be established by the managed-contracts adapter (supported: ${SUPPORTED_REAL_COMPONENTS.join(", ")}); declaring it would certify nothing`);
    }
    const result: E2eBoundary = { entry, real };
    if (entry === "http" || entry === "browser") result.service = serviceBoundary(row, where, suite, real);
    else if (row.service !== undefined) fail(`${where}.service belongs to an http or browser boundary`);
    else if (real.includes("fixture-store")) fail(`${where}.real "fixture-store" is establishable only through an owned http service`);
    if (row.allowedDoubles !== undefined) result.allowedDoubles = stringList(row.allowedDoubles, `${where}.allowedDoubles`, 32);
    if (entry === "browser") result.requests = requiredRequests(row.requests, `${where}.requests`);
    else if (row.requests !== undefined) fail(`${where}.requests belongs to a browser boundary`);
    return result;
}
/** Native case ids belong to a structured-runner or playwright suite; a structured report establishes no boundary, so a boundary claim there is refused (§10.1) — a playwright suite's owned app can (E2). */
function nativeSelection(row: Record<string, unknown>, where: string, suite: E2eSuite, result: E2eScenario): void {
    if (suite.adapter === "managed-contracts") { if (row.caseIds !== undefined) fail(`${where}.caseIds is only valid on a structured-runner or playwright suite (${suite.id} is managed-contracts)`); return; }
    const caseIds = stringList(row.caseIds, `${where}.caseIds`, 4096);
    if (!caseIds.length) fail(`${where}.caseIds must declare at least one native case id for ${suite.adapter} suite ${suite.id}; selection is never inferred from the report`);
    unique(caseIds, `${where}.caseIds`);
    if (row.boundary !== undefined && suite.adapter === "structured-runner") fail(`${where}.boundary cannot be declared on a structured-runner suite: a JSON/JUnit report establishes no boundary; bind portable contracts (contractIds) for boundary evidence`);
    result.caseIds = caseIds;
}
const REVISION = /^[A-Za-z0-9_./~^@{}-]{1,128}$/;
function fault(value: unknown, where: string): E2eFault {
    const row = record(value, where);
    onlyKeys(row, ["id", "path", "find", "replace", "rationale"], where);
    for (const key of ["find", "replace", "rationale"] as const) if (typeof row[key] !== "string" || (key !== "replace" && !String(row[key]).trim())) fail(`${where}.${key} must be a non-empty string`);
    return { id: id(row.id, where), path: relativePath(row.path, `${where}.path`), find: String(row.find), replace: String(row.replace), rationale: String(row.rationale) };
}
/** The comparison input a mode needs is mandatory, and nothing a mode does not use may be declared (a stray revision would suggest a comparison that never runs). */
function proofComparison(row: Record<string, unknown>, where: string, result: E2eProof): void {
    const needsRevision = result.mode === "old-new" || result.mode === "characterization", needsFault = result.mode === "controlled-fault";
    if (needsRevision !== (row.revision !== undefined)) fail(`${where}.revision is ${needsRevision ? "required" : "not used"} for mode ${result.mode}`);
    if (needsFault !== (row.fault !== undefined)) fail(`${where}.fault is ${needsFault ? "required" : "not used"} for mode ${result.mode}`);
    if (typeof row.revision === "string") { if (!REVISION.test(row.revision)) fail(`${where}.revision must be a git revision name`); result.revision = row.revision; }
    else if (row.revision !== undefined) fail(`${where}.revision must be a string`);
    if (row.fault !== undefined) result.fault = fault(row.fault, `${where}.fault`);
}
function designatedOutcome(value: unknown, where: string): ObservableKey[] {
    const outcome = stringList(value, where, OBSERVABLE_KEYS.length);
    if (!outcome.length) fail(`${where} must name at least one observable (${OBSERVABLE_KEYS.join(", ")})`);
    unique(outcome, where);
    return outcome.map(key => oneOf(key, OBSERVABLE_KEYS, where));
}
function designatedAction(value: unknown, where: string, contractIds: readonly string[], self: string): string[] {
    const action = stringList(value, where, 64);
    if (!action.length) fail(`${where} must name at least one case`);
    unique(action, where);
    for (const caseId of action) if (caseId === self || !contractIds.includes(caseId)) fail(`${where} "${caseId}" must be another of the scenario's contractIds`);
    return action;
}
/** Characterization compares whole observations, so it takes no outcome/action split; the counterfactual modes REQUIRE action evidence (review round 2). */
function designatedEvidence(entry: E2eDesignated, where: string, mode: ProofMode): void {
    const declared = entry.outcome !== undefined || entry.action !== undefined;
    if (mode === "characterization" && declared) fail(`${where}.outcome/action are not used for mode characterization (every designated observation must hold on both sides)`);
    if (mode !== "characterization" && !declared) fail(`${where} needs action evidence: \`outcome\` (the observables that ARE the designated outcome; the case's other observables must hold on the comparison) and/or \`action\` (cases that must pass on the comparison first). Without it a comparison cannot tell a setup failure from a behavioral red (§9.4)`);
}
function designatedEntry(value: unknown, where: string, contractIds: readonly string[], mode: ProofMode): E2eDesignated {
    const row = typeof value === "string" ? { id: value } : record(value, where);
    onlyKeys(row, ["id", "outcome", "action"], where);
    if (typeof row.id !== "string" || !contractIds.includes(row.id)) fail(`${where} "${String(row.id)}" is not one of the scenario's contractIds`);
    const entry: E2eDesignated = { id: row.id };
    if (row.outcome !== undefined) entry.outcome = designatedOutcome(row.outcome, `${where}.outcome`);
    if (row.action !== undefined) entry.action = designatedAction(row.action, `${where}.action`, contractIds, entry.id);
    designatedEvidence(entry, where, mode);
    return entry;
}
function proofDesignated(value: unknown, where: string, contractIds: readonly string[], mode: ProofMode): E2eDesignated[] {
    if (!Array.isArray(value) || !value.length || value.length > 64) fail(`${where} must be a non-empty list of at most 64 designated cases`);
    const entries = value.map((item, index) => designatedEntry(item, `${where}[${index}]`, contractIds, mode));
    unique(entries.map(entry => entry.id), where);
    return entries;
}
/** §9.4 (D3): explicit per-scenario proof mode; execution is the default and declares nothing else. */
function proof(value: unknown, where: string, contractIds: readonly string[]): E2eProof {
    const row = record(value, where);
    onlyKeys(row, ["mode", "revision", "fault", "designated"], where);
    const result: E2eProof = { mode: oneOf(row.mode, ["execution", "old-new", "controlled-fault", "characterization"] as const, `${where}.mode`) };
    proofComparison(row, where, result);
    if (result.mode === "execution") { if (row.designated !== undefined) fail(`${where}.designated is not used for mode execution`); return result; }
    if (row.designated === undefined) {
        if (result.mode !== "characterization") fail(`${where}.designated is required for mode ${result.mode}: name the case(s) whose designated outcome must fail on the comparison, with their action evidence`);
        return result;
    }
    result.designated = proofDesignated(row.designated, `${where}.designated`, contractIds, result.mode);
    return result;
}
function scenario(value: unknown, where: string, suites: ReadonlyMap<string, E2eSuite>): E2eScenario {
    const row = record(value, where);
    onlyKeys(row, ["id", "suite", "description", "affects", "contractIds", "caseIds", "expectationIds", "surfaceIds", "required", "boundary", "proof", "stability"], where);
    const suiteId = id(row.suite, `${where}.suite`);
    const declared = suites.get(suiteId);
    if (!declared) fail(`${where}.suite "${suiteId}" is not a declared suite`);
    if (typeof row.required !== "boolean") fail(`${where}.required must be true or false`);
    const contractIds = stringList(row.contractIds, `${where}.contractIds`, 64);
    if (!contractIds.length) fail(`${where}.contractIds must name at least one portable contract case`);
    const result: E2eScenario = { id: id(row.id, where), suite: suiteId, affects: globList(row.affects, `${where}.affects`), contractIds, required: row.required };
    nativeSelection(row, where, declared, result);
    if (row.description !== undefined) result.description = String(row.description);
    if (row.expectationIds !== undefined) result.expectationIds = stringList(row.expectationIds, `${where}.expectationIds`, 64);
    if (row.surfaceIds !== undefined) result.surfaceIds = stringList(row.surfaceIds, `${where}.surfaceIds`, 256);
    if (row.boundary !== undefined) result.boundary = boundary(row.boundary, `${where}.boundary`, declared);
    if (row.proof !== undefined) result.proof = proof(row.proof, `${where}.proof`, contractIds);
    if (row.stability !== undefined) result.stability = parseStability(row.stability, `${where}.stability`);
    return result;
}
function gates(value: unknown, where: string): E2eGates {
    const row = record(value, where);
    onlyKeys(row, ["stop", "commit", "ci", "review"], where);
    const result: E2eGates = {};
    if (row.stop !== undefined) result.stop = oneOf(row.stop, ["warn", "off"], `${where}.stop`);
    if (row.commit !== undefined) result.commit = oneOf(row.commit, ["require", "warn", "off"], `${where}.commit`);
    if (row.ci !== undefined) result.ci = oneOf(row.ci, ["require", "warn", "off"], `${where}.ci`);
    if (row.review !== undefined) result.review = oneOf(row.review, ["require", "advisory"], `${where}.review`);
    return result;
}
function surface(value: unknown, where: string): E2eSurface {
    const row = record(value, where);
    onlyKeys(row, ["id", "kind", "address", "method", "description"], where);
    if (typeof row.address !== "string" || !row.address.trim()) fail(`${where}.address must be a non-empty string`);
    if (typeof row.id !== "string" || !SURFACE_ID.test(row.id) || !row.id.trim()) fail(`${where} needs an id matching ${SURFACE_ID}`);
    const result: E2eSurface = { id: row.id, kind: oneOf(row.kind, ["cli", "http", "other"], `${where}.kind`), address: row.address };
    if (row.method !== undefined) { if (typeof row.method !== "string" || !row.method.trim()) fail(`${where}.method must be a non-empty string`); result.method = row.method; }
    if (row.description !== undefined) result.description = String(row.description);
    return result;
}
function surfaces(value: unknown, where: string): E2eSurface[] {
    if (!Array.isArray(value) || value.length > 256) fail(`${where} must be a list of at most 256 surface declarations`);
    const result = value.map((item, index) => surface(item, `${where}[${index}]`));
    unique(result.map(item => item.id), where);
    return result;
}
function project(value: unknown, where: string): E2eProject {
    const row = record(value, where);
    onlyKeys(row, ["id", "root", "contractManifest", "protectedInputs", "sharedInputs", "mode", "gates", "suites", "scenarios", "surfaces", "observations"], where);
    const mode = oneOf(row.mode, ["advisory", "required"], `${where}.mode`);
    if (!Array.isArray(row.suites) || !Array.isArray(row.scenarios)) fail(`${where} needs suites and scenarios lists`);
    const suites = row.suites.map((item, index) => parseSuite(item, `${where}.suites[${index}]`));
    unique(suites.map(item => item.id), `${where}.suites`);
    const suiteIds = new Map(suites.map(item => [item.id, item]));
    const scenarios = row.scenarios.map((item, index) => scenario(item, `${where}.scenarios[${index}]`, suiteIds));
    unique(scenarios.map(item => item.id), `${where}.scenarios`);
    const root = row.root === "." ? "." : relativePath(row.root, `${where}.root`);
    const result: E2eProject = { id: id(row.id, where), root, protectedInputs: globList(row.protectedInputs, `${where}.protectedInputs`), mode, suites, scenarios };
    if (row.contractManifest !== undefined) result.contractManifest = relativePath(row.contractManifest, `${where}.contractManifest`);
    if (row.sharedInputs !== undefined) result.sharedInputs = globList(row.sharedInputs, `${where}.sharedInputs`);
    if (row.gates !== undefined) result.gates = gates(row.gates, `${where}.gates`);
    if (row.surfaces !== undefined) result.surfaces = surfaces(row.surfaces, `${where}.surfaces`);
    if (row.observations !== undefined) {
        const observations = record(row.observations, `${where}.observations`);
        onlyKeys(observations, ["runtimeCoverage"], `${where}.observations`);
        result.observations = { runtimeCoverage: oneOf(observations.runtimeCoverage, ["off", "node", "node-required"], `${where}.observations.runtimeCoverage`) };
    }
    return result;
}
function sourceRef(value: unknown, where: string): E2eSourceRef {
    const row = record(value, where);
    onlyKeys(row, ["kind", "path", "sha256", "quote"], where);
    const kind = oneOf(row.kind, ["requirement", "example", "regression", "conversation", "inferred"], `${where}.kind`);
    if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) || typeof row.quote !== "string" || !row.quote.trim()) fail(`${where} needs a sha256 digest and a non-empty quote`);
    return { kind, path: relativePath(row.path, `${where}.path`), sha256: row.sha256, quote: row.quote };
}
function review(value: unknown, where: string): E2eReview {
    const row = record(value, where);
    onlyKeys(row, ["atMs", "action", "revision", "rationale", "authority"], where);
    if (row.authority !== "configured") fail(`${where} needs authority "configured"; local records never claim human approval`);
    const action = oneOf(row.action, ["propose", "accept", "dispute", "replace"], `${where}.action`);
    if (typeof row.atMs !== "number" || !Number.isInteger(row.atMs) || typeof row.revision !== "string" || typeof row.rationale !== "string" || !row.rationale.trim()) fail(`${where} needs atMs, revision and rationale`);
    return { atMs: row.atMs, action, revision: row.revision, rationale: row.rationale, authority: "configured" };
}
const ORIGINS: readonly ExpectationOrigin[] = ["user-requirement", "approved-specification", "regression-report", "existing-behavior", "agent-inference"];
const LIFECYCLES: readonly ExpectationLifecycle[] = ["proposed", "accepted", "disputed", "superseded"];
function expectation(value: unknown, where: string, projects: ReadonlySet<string>): E2eExpectation {
    const row = record(value, where);
    onlyKeys(row, ["id", "projectId", "scenarioIds", "statement", "origin", "sources", "assumptions", "questions", "examples", "contractIds", "lifecycle", "revision", "history", "supersededBy"], where);
    const projectId = id(row.projectId, `${where}.projectId`);
    if (!projects.has(projectId)) fail(`${where}.projectId "${projectId}" is not a declared project`);
    const origin = oneOf(row.origin, ORIGINS, `${where}.origin`);
    const lifecycle = oneOf(row.lifecycle, LIFECYCLES, `${where}.lifecycle`);
    if (typeof row.statement !== "string" || !row.statement.trim()) fail(`${where}.statement must be an observable statement`);
    if (typeof row.revision !== "string" || !/^[a-f0-9]{64}$/.test(row.revision)) fail(`${where}.revision must be a sha256 digest`);
    if (!Array.isArray(row.sources) || !Array.isArray(row.history)) fail(`${where} needs sources and history lists`);
    const examples = record(row.examples, `${where}.examples`);
    onlyKeys(examples, ["positive", "negative"], `${where}.examples`);
    const result: E2eExpectation = {
        id: id(row.id, where), projectId, scenarioIds: stringList(row.scenarioIds, `${where}.scenarioIds`, 64), statement: row.statement, origin, lifecycle,
        sources: row.sources.map((item, index) => sourceRef(item, `${where}.sources[${index}]`)),
        assumptions: stringList(row.assumptions, `${where}.assumptions`), questions: stringList(row.questions, `${where}.questions`),
        examples: { positive: stringList(examples.positive, `${where}.examples.positive`), negative: stringList(examples.negative, `${where}.examples.negative`) },
        contractIds: stringList(row.contractIds, `${where}.contractIds`, 64), revision: row.revision,
        history: row.history.map((item, index) => review(item, `${where}.history[${index}]`)),
    };
    if (row.supersededBy !== undefined) result.supersededBy = id(row.supersededBy, `${where}.supersededBy`);
    const actual = expectationRevision(result);
    if (actual !== result.revision) fail(`${where}.revision ${result.revision.slice(0, 12)} does not match the record's content (${actual.slice(0, 12)}); a decision bound to the stored digest would accept different text`);
    return result;
}
/** Meaning-bearing fields only — lifecycle, history and supersession never move the revision. */
export type ExpectationDraft = Pick<E2eExpectation, "id" | "projectId" | "scenarioIds" | "statement" | "origin" | "sources" | "assumptions" | "questions" | "examples" | "contractIds">;
export function expectationRevision(row: ExpectationDraft): string {
    return digestOf({
        id: row.id, projectId: row.projectId, scenarioIds: row.scenarioIds, statement: row.statement, origin: row.origin, sources: row.sources,
        assumptions: row.assumptions, questions: row.questions, examples: { positive: row.examples.positive, negative: row.examples.negative }, contractIds: row.contractIds,
    });
}
function checkScenarioExpectationRefs(proj: E2eProject, expectations: ReadonlyMap<string, E2eExpectation>): void {
    for (const scen of proj.scenarios) {
        for (const ref of scen.expectationIds ?? []) {
            const row = expectations.get(ref);
            if (!row) fail(`scenario ${scen.id} references unknown expectation ${ref}`);
            if (row.projectId !== proj.id) fail(`scenario ${scen.id} references expectation ${ref} from another project`);
        }
    }
}
function checkExpectationRefs(row: E2eExpectation, policy: E2ePolicy, expectations: ReadonlyMap<string, E2eExpectation>): void {
    const proj = policy.projects.find(item => item.id === row.projectId);
    for (const scenarioId of row.scenarioIds) {
        if (!proj?.scenarios.some(item => item.id === scenarioId)) fail(`expectation ${row.id} names unknown scenario ${scenarioId}`);
    }
    if (row.supersededBy !== undefined && !expectations.has(row.supersededBy)) fail(`expectation ${row.id} is superseded by unknown ${row.supersededBy}`);
}
function crossCheck(policy: E2ePolicy): void {
    const expectations = new Map(policy.expectations.map(row => [row.id, row]));
    for (const proj of policy.projects) checkScenarioExpectationRefs(proj, expectations);
    for (const row of policy.expectations) checkExpectationRefs(row, policy, expectations);
}

function scheduling(value: unknown): E2eScheduling {
    const row = record(value, "scheduling");
    onlyKeys(row, ["autoRun", "quietMs", "minIntervalMs", "budgetMs"], "scheduling");
    const result: E2eScheduling = {};
    if (row.autoRun !== undefined) { if (typeof row.autoRun !== "boolean") fail("scheduling.autoRun must be true or false"); result.autoRun = row.autoRun; }
    for (const key of ["quietMs", "minIntervalMs", "budgetMs"] as const) {
        const item = row[key];
        if (item === undefined) continue;
        const [low, high] = SCHEDULING_BOUNDS[key];
        if (typeof item !== "number" || !Number.isInteger(item) || item < low || item > high) fail(`scheduling.${key} must be an integer from ${low} to ${high} ms`);
        result[key] = item;
    }
    return result;
}
/** Strict parse. Unknown keys and versions are refusals, never guesses. */
export function parseE2ePolicy(content: string): E2ePolicy {
    if (Buffer.byteLength(content) > MAX_POLICY_BYTES) fail("file exceeds 1 MiB");
    const row = record(JSON.parse(content), "policy");
    onlyKeys(row, ["version", "sharedInputs", "projects", "expectations", "scheduling"], "policy");
    if (row.version !== 1) fail(`unknown schema version ${JSON.stringify(row.version)}; this build reads version 1`);
    if (!Array.isArray(row.projects) || !row.projects.length || row.projects.length > 64) fail("policy needs 1–64 projects");
    const projects = row.projects.map((item, index) => project(item, `projects[${index}]`));
    unique(projects.map(item => item.id), "projects");
    const projectIds = new Set(projects.map(item => item.id));
    const rawExpectations = row.expectations === undefined ? [] : row.expectations;
    if (!Array.isArray(rawExpectations) || rawExpectations.length > 1024) fail("expectations must be a list of at most 1024 records");
    const expectations = rawExpectations.map((item, index) => expectation(item, `expectations[${index}]`, projectIds));
    unique(expectations.map(item => item.id), "expectations");
    const policy: E2ePolicy = { version: 1, projects, expectations };
    if (row.sharedInputs !== undefined) policy.sharedInputs = globList(row.sharedInputs, "sharedInputs");
    if (row.scheduling !== undefined) policy.scheduling = scheduling(row.scheduling);
    crossCheck(policy);
    return policy;
}

/** Key-sorted JSON so two semantically equal policies share one digest. */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        // SAFETY: non-null, non-array object per the guard above.
        const row = value as Record<string, unknown>;
        return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
/** sha256 of a string, a Buffer's bytes, or the canonical JSON of anything else — one identity for file bytes however they were read. */
export function digestOf(value: unknown): string {
    if (Buffer.isBuffer(value)) return createHash("sha256").update(value).digest("hex");
    return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}
export function policyDigest(policy: E2ePolicy): string { return digestOf(policy); }

export type LoadedPolicy =
    | { status: "configured"; policy: E2ePolicy; digest: string; path: string }
    | { status: "unconfigured"; path: string }
    | { status: "invalid"; path: string; reason: string };

/** UNCONFIGURED is a distinct outcome; it is never a pass and never a guess. */
export function loadE2ePolicy(root: string): LoadedPolicy {
    const path = join(root, E2E_POLICY_PATH);
    if (!existsSync(path)) return { status: "unconfigured", path };
    try {
        const policy = parseE2ePolicy(readFileSync(path, "utf8"));
        return { status: "configured", policy, digest: policyDigest(policy), path };
    } catch (error) { return { status: "invalid", path, reason: error instanceof Error ? error.message : String(error) }; }
}
