// ===========================================
// Per-edit mutation — typed survivor dispositions (plan 16 §7)
// ===========================================
// A surviving mutant used to have exactly two states: untouched, or
// `status: "equivalent"` + `accepted_reason: <prose>`. That binary is what makes
// the escape hatch attractive — prose is auditable *text*, not evidence, and
// every survivor that is not an equivalence had to be either ignored or
// mislabelled to make the gate stop charging it.
//
// This module replaces the prose with a discriminated union. Two members are not
// in the classic mutation-testing taxonomy; both are forced by measured data and
// must not be collapsed into the others:
//
//   dead_code   — the mutant is unkillable because the code SHOULD NOT EXIST
//                 (verified: structure/adoption.ts, where `hasConfigFile` cannot
//                 alter any return value; 14 mutants). This is NOT
//                 proved_equivalent: the code is wrong and the resolution is a
//                 source change. Recording it as an accepted equivalence would
//                 seal a real defect in as "reviewed" and bury an unimplemented
//                 intent — so `acceptMutant` refuses it by construction.
//   unresolved  — first-class, so an un-examined survivor is distinguishable
//                 from an examined-but-unproved one. Counterexample search can
//                 prove a mutant killable; failing to find one proves NOTHING,
//                 so "8M fuzz cases passed" lands here with its evidence
//                 attached, never in proved_equivalent.
//
// Certificates carry their own invalidation inputs (source symbol hash, mutant
// id, environment, dependency-graph version). The defensive-guard equivalence
// class (replay/sse-reassembly.ts, 6 mutants) is equivalent ONLY while the
// guarded call stays last; add one statement after it and the mutants become
// killable again. Prose has no invalidation inputs, so it went stale silently.
//
// Ids are plain `string` here rather than `StableId` on purpose: the dependency
// edge runs types.ts → disposition.ts (MutantRecord carries a disposition), and
// importing back would make it a cycle.

import { isJsonObject } from "../../lib/json-types.js";
import type { JsonObject } from "../../lib/json-types.js";

/** What must happen to the source for a `dead_code` survivor to go away. */
export type DeadCodeResolution = "delete" | "implement";

/** Algebraic rewrite: original and mutant normalize to the same AST. The hashes
 *  ARE the mechanism — a lemma whose two hashes differ proves nothing. */
export interface RewriteLemma {
	kind: "rewrite_lemma";
	/** Identifier of the rewrite applied, e.g. "demorgan" / "double-negation". */
	lemmaId: string;
	normalizedOriginalHash: string;
	normalizedMutantHash: string;
}

/** Real proof over a genuinely small domain (enum × enum, small tagged unions).
 *  A SAMPLED domain is not this — `domainComplete` is literally typed `true`. */
export interface BoundedExhaustive {
	kind: "bounded_exhaustive";
	/** The enumerated domain, e.g. "MutantStatus × boolean". */
	domain: string;
	casesEnumerated: number;
	domainComplete: true;
}

/** Solver-backed relational equivalence. Only UNSAT is a proof: SAT is a
 *  counterexample and `unknown` is a timeout, so the type admits neither. */
export interface SmtRelational {
	kind: "smt_relational";
	solver: string;
	solverVersion: string;
	result: "unsat";
	queryHash: string;
}

export type ProofMethod = RewriteLemma | BoundedExhaustive | SmtRelational;

/** The inputs that invalidate a certificate. All must still hold at read time. */
export interface CertificateValidity {
	/** The exact mutant the proof was produced against. */
	mutantId: string;
	/** Normalized-source hash of the enclosing symbol when the proof was made. */
	sourceSymbolHash: string;
	environmentHash: string;
	dependencyGraphVersion: string;
	/** Present when the proof assumed a declared contract. */
	contractHash?: string;
}

export interface ProofCertificate {
	/** The verifier that produced this — never the accept command itself. */
	producedBy: string;
	verifierVersion: string;
	/** ISO timestamp. */
	producedAt: string;
	validity: CertificateValidity;
}

/** An approval the coding agent cannot manufacture: a signed review, a protected
 *  label, a policy file outside the agent's write scope (plan 16 §8.1). The
 *  artifact is referenced, never inlined — inlined "approval" is self-approval. */
export interface HumanApproval {
	approvedBy: string;
	approvedAt: string;
	artifactRef: string;
}

/** Search that FAILED to find a counterexample. Evidence, never proof. */
export interface CounterexampleSearchEvidence {
	strategy: "property" | "fuzz" | "differential" | "bounded_exhaustive" | "test_suite";
	runs: number;
	seed: string;
	budgetMs: number;
	/** ISO timestamp. */
	searchedAt: string;
}

export type SurvivorDisposition =
	| { kind: "killed" }
	| { kind: "dead_code"; resolution: DeadCodeResolution; issueRef?: string }
	| { kind: "proved_equivalent"; method: ProofMethod; certificate: ProofCertificate }
	| { kind: "proved_unreachable"; invariantRef: string; certificate: ProofCertificate }
	| { kind: "duplicate"; representativeMutantId: string; certificate: ProofCertificate }
	| {
			kind: "outside_contract";
			contractHash: string;
			observationModelHash: string;
			approval: HumanApproval;
	  }
	| { kind: "accepted_risk"; owner: string; issue: string; expiresAt: string; approval: HumanApproval }
	| { kind: "unresolved"; evidence?: CounterexampleSearchEvidence };

export type SurvivorDispositionKind = SurvivorDisposition["kind"];

export type ProvedEquivalent = Extract<SurvivorDisposition, { kind: "proved_equivalent" }>;

// ===========================================
// Mechanical judgement — is this disposition actually a proof?
// ===========================================

/** Does the declared method carry its own mechanism, or is it a bare claim? */
export function methodProves(method: ProofMethod): boolean {
	if (method.kind === "rewrite_lemma") {
		return (
			method.lemmaId.trim() !== "" && method.normalizedOriginalHash === method.normalizedMutantHash
		);
	}
	if (method.kind === "bounded_exhaustive") {
		// `domainComplete` is literally typed `true` (see BoundedExhaustive) —
		// the only thing left to check is that cases were actually enumerated.
		return method.casesEnumerated > 0;
	}
	// `result` is literally typed "unsat" (see SmtRelational) — the only thing
	// left to check is that the query is identifiable.
	return method.queryHash.trim() !== "";
}

/** The state a certificate was proved against; a mismatch means it went stale. */
export interface CertificateContext {
	mutantId: string;
	sourceSymbolHash: string;
	environmentHash: string;
	dependencyGraphVersion: string;
}

/** Does the certificate still bind to THIS mutant in THIS state? */
export function certificateHolds(cert: ProofCertificate, ctx: CertificateContext): boolean {
	const v = cert.validity;
	if (v.mutantId !== ctx.mutantId) return false;
	if (v.sourceSymbolHash !== ctx.sourceSymbolHash) return false;
	if (v.environmentHash !== ctx.environmentHash) return false;
	return v.dependencyGraphVersion === ctx.dependencyGraphVersion;
}

/** `proved_equivalent` is the ONLY kind that may buy `status: "equivalent"`. */
export function grantsEquivalence(d: SurvivorDisposition): d is ProvedEquivalent {
	return d.kind === "proved_equivalent";
}

/** Why a kind may not be recorded as an accepted equivalence — null when it may.
 *  Keyed by kind so adding a member without deciding its answer fails to compile. */
const EQUIVALENCE_REFUSALS: Record<SurvivorDispositionKind, string | null> = {
	killed: "a killed mutant needs no disposition — nothing is being accepted",
	dead_code:
		"dead code is not an equivalence: the mutant survives because the code should not exist. Delete or implement it — accepting would seal the defect in as reviewed",
	proved_equivalent: null,
	proved_unreachable:
		"unreachability is proved against an invariant, not against behaviour — it needs the judge (plan 16 §8), not the accept path",
	duplicate:
		"a duplicate is resolved by pointing at its representative, not by accepting it here",
	outside_contract:
		"an out-of-contract survivor needs an approval artifact the coding agent cannot manufacture (plan 16 §8.1)",
	accepted_risk:
		"accepted risk needs an owner, an expiry and an approval artifact the coding agent cannot manufacture (plan 16 §8.1)",
	unresolved:
		"unresolved is the honest resting state for a survivor — recording it must not silence the gate",
};

/** Refusal text for a kind that cannot be accepted, or null if it can be. */
export function equivalenceRefusal(d: SurvivorDisposition): string | null {
	return EQUIVALENCE_REFUSALS[d.kind];
}

// ===========================================
// Human-readable rendering (back-compat for `accepted_reason`)
// ===========================================

/** One line describing the judgment — written to the legacy `accepted_reason`
 *  field so pre-typed-disposition readers keep seeing a WHY. */
export function describeDisposition(d: SurvivorDisposition): string {
	switch (d.kind) {
		case "killed":
			return "killed";
		case "dead_code":
			return `dead code (${d.resolution})${d.issueRef ? ` — ${d.issueRef}` : ""}`;
		case "proved_equivalent":
			return `proved equivalent via ${d.method.kind} (certificate by ${d.certificate.producedBy} ${d.certificate.verifierVersion})`;
		case "proved_unreachable":
			return `proved unreachable under invariant ${d.invariantRef}`;
		case "duplicate":
			return `duplicate of ${d.representativeMutantId}`;
		case "outside_contract":
			return `outside contract ${d.contractHash} (approved by ${d.approval.approvedBy})`;
		case "accepted_risk":
			return `accepted risk owned by ${d.owner} until ${d.expiresAt} (${d.issue})`;
		case "unresolved":
			return d.evidence
				? `unresolved — ${d.evidence.runs} ${d.evidence.strategy} run(s), seed ${d.evidence.seed}, no counterexample found`
				: "unresolved";
	}
}

// ===========================================
// Parsing — a manifest is untrusted JSON
// ===========================================

function str(v: unknown): string | null {
	return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Narrow ONCE at the boundary; every parser below reads a `JsonObject`, never
 *  a bare `Record<string, unknown>`, and never re-derives this check. */

function parseValidity(v: unknown): CertificateValidity | null {
	if (!isJsonObject(v)) return null;
	const o = v;
	const mutantId = str(o.mutantId);
	const sourceSymbolHash = str(o.sourceSymbolHash);
	const environmentHash = str(o.environmentHash);
	const dependencyGraphVersion = str(o.dependencyGraphVersion);
	if (!mutantId || !sourceSymbolHash || !environmentHash || !dependencyGraphVersion) return null;
	const contractHash = str(o.contractHash);
	const base = { mutantId, sourceSymbolHash, environmentHash, dependencyGraphVersion };
	return contractHash ? { ...base, contractHash } : base;
}

function parseCertificate(v: unknown): ProofCertificate | null {
	if (!isJsonObject(v)) return null;
	const o = v;
	const producedBy = str(o.producedBy);
	const verifierVersion = str(o.verifierVersion);
	const producedAt = str(o.producedAt);
	const validity = parseValidity(o.validity);
	if (!producedBy || !verifierVersion || !producedAt || !validity) return null;
	return { producedBy, verifierVersion, producedAt, validity };
}

function parseMethod(v: unknown): ProofMethod | null {
	if (!isJsonObject(v)) return null;
	const o = v;
	if (o.kind === "rewrite_lemma") return parseRewriteLemma(o);
	if (o.kind === "bounded_exhaustive") return parseBoundedExhaustive(o);
	if (o.kind === "smt_relational") return parseSmtRelational(o);
	return null;
}

function parseRewriteLemma(o: JsonObject): RewriteLemma | null {
	const lemmaId = str(o.lemmaId);
	const normalizedOriginalHash = str(o.normalizedOriginalHash);
	const normalizedMutantHash = str(o.normalizedMutantHash);
	if (!lemmaId || !normalizedOriginalHash || !normalizedMutantHash) return null;
	return { kind: "rewrite_lemma", lemmaId, normalizedOriginalHash, normalizedMutantHash };
}

function parseBoundedExhaustive(o: JsonObject): BoundedExhaustive | null {
	const domain = str(o.domain);
	if (!domain || typeof o.casesEnumerated !== "number" || o.domainComplete !== true) return null;
	return {
		kind: "bounded_exhaustive",
		domain,
		casesEnumerated: o.casesEnumerated,
		domainComplete: true,
	};
}

function parseSmtRelational(o: JsonObject): SmtRelational | null {
	const solver = str(o.solver);
	const solverVersion = str(o.solverVersion);
	const queryHash = str(o.queryHash);
	if (!solver || !solverVersion || !queryHash || o.result !== "unsat") return null;
	return { kind: "smt_relational", solver, solverVersion, result: "unsat", queryHash };
}

function parseApproval(v: unknown): HumanApproval | null {
	if (!isJsonObject(v)) return null;
	const o = v;
	const approvedBy = str(o.approvedBy);
	const approvedAt = str(o.approvedAt);
	const artifactRef = str(o.artifactRef);
	if (!approvedBy || !approvedAt || !artifactRef) return null;
	return { approvedBy, approvedAt, artifactRef };
}

const SEARCH_STRATEGIES: ReadonlySet<string> = new Set([
	"property",
	"fuzz",
	"differential",
	"bounded_exhaustive",
	"test_suite",
]);

function parseEvidence(v: unknown): CounterexampleSearchEvidence | null {
	if (!isJsonObject(v)) return null;
	const o = v;
	const seed = str(o.seed);
	const searchedAt = str(o.searchedAt);
	const strategy = str(o.strategy);
	if (!seed || !searchedAt || !strategy || !SEARCH_STRATEGIES.has(strategy)) return null;
	if (typeof o.runs !== "number" || typeof o.budgetMs !== "number") return null;
	return {
		strategy: strategy as CounterexampleSearchEvidence["strategy"],
		runs: o.runs,
		seed,
		budgetMs: o.budgetMs,
		searchedAt,
	};
}

function parseDeadCode(o: JsonObject): SurvivorDisposition | null {
	if (o.resolution !== "delete" && o.resolution !== "implement") return null;
	const issueRef = str(o.issueRef);
	return issueRef
		? { kind: "dead_code", resolution: o.resolution, issueRef }
		: { kind: "dead_code", resolution: o.resolution };
}

function parseProvedEquivalent(o: JsonObject): SurvivorDisposition | null {
	const method = parseMethod(o.method);
	const certificate = parseCertificate(o.certificate);
	return method && certificate ? { kind: "proved_equivalent", method, certificate } : null;
}

function parseProvedUnreachable(o: JsonObject): SurvivorDisposition | null {
	const invariantRef = str(o.invariantRef);
	const certificate = parseCertificate(o.certificate);
	return invariantRef && certificate ? { kind: "proved_unreachable", invariantRef, certificate } : null;
}

function parseDuplicate(o: JsonObject): SurvivorDisposition | null {
	const representativeMutantId = str(o.representativeMutantId);
	const certificate = parseCertificate(o.certificate);
	return representativeMutantId && certificate
		? { kind: "duplicate", representativeMutantId, certificate }
		: null;
}

function parseOutsideContract(o: JsonObject): SurvivorDisposition | null {
	const contractHash = str(o.contractHash);
	const observationModelHash = str(o.observationModelHash);
	const approval = parseApproval(o.approval);
	if (!contractHash || !observationModelHash || !approval) return null;
	return { kind: "outside_contract", contractHash, observationModelHash, approval };
}

function parseAcceptedRisk(o: JsonObject): SurvivorDisposition | null {
	const owner = str(o.owner);
	const issue = str(o.issue);
	const expiresAt = str(o.expiresAt);
	const approval = parseApproval(o.approval);
	if (!owner || !issue || !expiresAt || !approval) return null;
	return { kind: "accepted_risk", owner, issue, expiresAt, approval };
}

function parseUnresolved(o: JsonObject): SurvivorDisposition | null {
	const evidence = parseEvidence(o.evidence);
	return evidence ? { kind: "unresolved", evidence } : { kind: "unresolved" };
}

type KindParser = (o: JsonObject) => SurvivorDisposition | null;

const PARSERS: Record<SurvivorDispositionKind, KindParser> = {
	killed: () => ({ kind: "killed" }),
	dead_code: parseDeadCode,
	proved_equivalent: parseProvedEquivalent,
	proved_unreachable: parseProvedUnreachable,
	duplicate: parseDuplicate,
	outside_contract: parseOutsideContract,
	accepted_risk: parseAcceptedRisk,
	unresolved: parseUnresolved,
};

/**
 * A well-formed disposition, or null for anything else — garbage, a partial
 * record, or a kind written by a NEWER build. Null is never an error: the caller
 * falls back to the legacy view, which is what keeps old manifests loadable.
 */
export function parseDisposition(value: unknown): SurvivorDisposition | null {
	if (!isJsonObject(value)) return null;
	const o = value;
	if (typeof o.kind !== "string") return null;
	const parser = PARSERS[o.kind as SurvivorDispositionKind] as KindParser | undefined;
	return parser ? parser(o) : null;
}

// ===========================================
// Reading a record — old and new schemas at once
// ===========================================

/** The subset of a MutantRecord this module reads. Structural on purpose: it
 *  keeps the import edge one-directional (types.ts depends on this file). */
export interface DispositionCarrier {
	status?: string;
	accepted_reason?: string;
	disposition?: unknown;
}

export interface DispositionView {
	disposition: SurvivorDisposition;
	/** Where the view came from — `legacy_prose` means a pre-typed manifest. */
	source: "typed" | "legacy_prose" | "none";
	/** Verbatim pre-typed prose, preserved rather than reinterpreted. */
	legacyReason?: string;
}

/**
 * The disposition of a mutant record under EITHER schema.
 *
 * Backward compatibility is the whole point: a record written before typed
 * dispositions carries only `status: "equivalent"` + `accepted_reason`. Prose is
 * not a mechanism, so it reads as `unresolved` — but the text is returned
 * verbatim in `legacyReason` and is never removed from the record, so nothing is
 * lost and nothing is silently promoted to "proved". `status` is untouched by
 * this read, so the gate's accepted-survivor floor is unchanged.
 */
export function dispositionOf(record: DispositionCarrier): DispositionView {
	const typed = parseDisposition(record.disposition);
	if (typed) return { disposition: typed, source: "typed" };
	const legacy = str(record.accepted_reason);
	if (legacy) {
		return { disposition: { kind: "unresolved" }, source: "legacy_prose", legacyReason: legacy };
	}
	if (record.status === "killed") return { disposition: { kind: "killed" }, source: "none" };
	return { disposition: { kind: "unresolved" }, source: "none" };
}
