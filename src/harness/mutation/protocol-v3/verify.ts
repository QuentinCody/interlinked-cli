// ===========================================
// Protocol v3 — the TRUST boundary (verify after parse)
// ===========================================
// parseUntrustedEnvelope proves SHAPE; this module proves AUTHENTICITY and
// BINDING, and only it can mint `VerifiedEvidenceBundle` — the sole type
// the evidence classifier, the evaluator, and the journal may accept.
// Review 2026-08-31 fourth pass closed three holes: receipts are now
// STRICT SIGNED SCHEMAS with exact-field cross-echoes (receipts.ts, never
// substring matching), the report is STRUCTURALLY verified against the
// envelope's rows (report.ts, never text search, r2_sha256 included), and
// policies resolve against the SIGNED acceptance receipt.
//
// THE SIGNING CONTRACT (exact; mirrored in protocol/mutation-v3/README.md):
// - result_hash = sha256( canonicalJson(payload) ) over UTF-8, where the
//   payload is every envelope field EXCEPT seq, occurred_at, result_hash,
//   and signature. seq stays unhashed (plan 27 r5.3); occurred_at is
//   signed via the attestation instead, so it does not change result
//   identity but cannot be forged either.
// - signature.value = base64( Ed25519-sign(
//     utf8( canonicalJson({ key_id, occurred_at, result_hash }) ) ) ).
//   key_id and occurred_at ARE signed. The result key id MUST equal the
//   verified execution-receipt signer on the execution arm, or the verified
//   terminalization-receipt signer on the control arm.
// - Receipts: {payload, signature}; signature over
//   utf8(canonicalJson({key_id, payload})) — key_id is INSIDE the signed
//   bytes; the envelope binds sha256(canonicalJson(payload)).
// - canonicalJson: recursive lexicographic key sort, JSON.stringify
//   serialization, no whitespace. For this schema (safe integers only,
//   ASCII field names) it is RFC 8785 (JCS) equivalent.

import { createHash } from "node:crypto";
import {
	canonicalJson,
	type DeepReadonly,
	keyRegistryFailure,
	registryRoleConflictFailure,
	safeStructuredClone,
} from "./canonical.js";
import { parseUntrustedEnvelope, type ParsedEnvelope } from "./parse.js";
import {
	type AcceptanceReceiptPayload,
	type ExecutionReceiptPayload,
	parseSignedReceipt,
	type TerminalizationPayload,
} from "./receipts.js";
import { verifyReportAgainstEnvelope } from "./report.js";
import { computeResultHash, signatureFailure, timeFailure } from "./verify-attestation.js";
import {
	admissionAnchorFailure,
	authorityFailure,
	type ExpectedAdmission,
	jobEchoMismatch,
	sourceArtifactMismatch,
	type V3ServerAuthority,
} from "./verify-bindings.js";
import type {
	V3EngineIdentity,
	V3Envelope,
	V3ExcludedRow,
	V3JobBinding,
	V3RunnerIdentity,
	V3ScopeEcho,
} from "./types.js";

// canonicalJson lives in canonical.ts (leaf) — re-exported below for
// existing consumers.
export { canonicalJson } from "./canonical.js";

export { attestationPayload, computeResultHash, resultHashPayload } from "./verify-attestation.js";

export { type V3KeyRegistry } from "./canonical.js";
import type { V3KeyRegistry } from "./canonical.js";

/** The envelope inside a verified bundle. Never the evaluator boundary by
 *  itself — the bundle is (review 2026-08-31 fourth pass). */
export type AuthenticatedEnvelope = DeepReadonly<ParsedEnvelope>;

const VERIFIED_BUNDLE: unique symbol = Symbol("interlinked.protocol-v3.verified-bundle");
/** THE evaluator/classifier/journal boundary: the authenticated envelope
 *  plus its verified structural artifacts. Only verifyEnvelope mints it. */
export interface VerifiedEvidenceBundle {
	readonly envelope: AuthenticatedEnvelope;
	readonly acceptance: DeepReadonly<AcceptanceReceiptPayload>;
	readonly execution: DeepReadonly<ExecutionReceiptPayload> | null;
	readonly terminalization: DeepReadonly<TerminalizationPayload> | null;
	readonly [VERIFIED_BUNDLE]: true;
}

/** Runtime provenance for the compile-time bundle brand. A structural cast is
 * never authenticated: only {@link mintBundle} inserts into this process-local
 * registry after the complete parse/signature/receipt/report chain passes. */
const verifiedEvidenceBundles = new WeakSet<object>();

export function isVerifiedEvidenceBundle(value: unknown): value is VerifiedEvidenceBundle {
	return value !== null && typeof value === "object" && verifiedEvidenceBundles.has(value);
}

export interface V3ReceiptInputs {
	/** Raw text of the SIGNED acceptance receipt ({payload, signature}). */
	acceptance: string;
	/** Raw text of the SIGNED execution receipt (execution arm). */
	execution?: string;
	/** Raw text of the SIGNED terminalization record (pre-execution arm). */
	terminalization?: string;
}

/** Caller-derived admission identity — NEVER taken from the response
 *  (review 2026-08-31 sixth pass P0: without it, a re-signed acceptance
 *  receipt with foreign request/changeset hashes authenticated). */
export type { ExpectedAdmission, V3ServerAuthority } from "./verify-bindings.js";

/** Authority derived by the server from authenticated context. It is
 *  deliberately separate from the caller-supplied request/job echo. */
export interface VerifyInputs {
	expectedJob: V3JobBinding;
	/** Independently derived from authentication; never copied from the
	 *  request or terminal envelope. */
	serverAuthority: V3ServerAuthority;
	/** The admission the CLI actually submitted. */
	expectedAdmission: ExpectedAdmission;
	keyRegistry: V3KeyRegistry;
	/** Validated clock (RFC3339). Malformed ⇒ fail closed. */
	now: string;
	receipts: V3ReceiptInputs;
	/** Raw report bytes — REQUIRED when the envelope carries a report
	 *  pointer; verified STRUCTURALLY against the envelope (report.ts). */
	report?: Uint8Array;
}

export type VerifyOutcome =
	| { ok: true; bundle: VerifiedEvidenceBundle }
	| { ok: false; reason: string };

/** Detach every caller-owned verification input before any trust check.
 *  `structuredClone` already copies ordinary ArrayBuffers; the explicit
 *  Uint8Array copy also detaches a view backed by SharedArrayBuffer. */
function snapshotVerifyInputs(inputs: VerifyInputs): VerifyInputs | null {
	const snapshot = safeStructuredClone(inputs);
	if (snapshot === null) return null;
	if (snapshot.report !== undefined) {
		if (!(snapshot.report instanceof Uint8Array)) return null;
		snapshot.report = Uint8Array.from(snapshot.report);
	}
	return snapshot;
}

interface EnvelopeEvidenceBlocks {
	scope?: V3ScopeEcho;
	engine?: V3EngineIdentity;
	runner?: V3RunnerIdentity;
	excluded?: V3ExcludedRow[];
	no_test_policy?: string;
}

function evidenceBlocks(envelope: V3Envelope): EnvelopeEvidenceBlocks {
	// SAFETY: keyed projection across the union; absent keys stay undefined.
	return envelope as EnvelopeEvidenceBlocks;
}

/** Policies must be approved by the SIGNED acceptance receipt. */
function policyApprovalFailure(envelope: V3Envelope, acceptance: AcceptanceReceiptPayload): string | null {
	const blocks = evidenceBlocks(envelope);
	const policies = [
		...(blocks.no_test_policy === undefined ? [] : [blocks.no_test_policy]),
		...(blocks.excluded ?? []).map((row) => row.policy_id),
	];
	for (const id of policies) {
		if (!acceptance.approved_policy_ids.includes(id)) {
			return `policy "${id}" is not approved by the signed acceptance receipt — syntax is not approval`;
		}
	}
	return null;
}

/** Acceptance cross-echoes: signed job, policy approvals, and intended
 *  image/config/scope against the envelope's actuals (when present). */
function acceptanceEchoFailure(envelope: V3Envelope, acceptance: AcceptanceReceiptPayload): string | null {
	const jobMismatch = jobEchoMismatch(envelope.job, acceptance.job);
	if (jobMismatch !== null) return `acceptance receipt ${jobMismatch}`;
	const policies = policyApprovalFailure(envelope, acceptance);
	if (policies !== null) return policies;
	const blocks = evidenceBlocks(envelope);
	if (blocks.runner !== undefined && blocks.runner.image_digest !== acceptance.intended_image_digest) {
		return `runner image ${blocks.runner.image_digest} differs from the acceptance-intended ${acceptance.intended_image_digest}`;
	}
	if (blocks.engine !== undefined && blocks.engine.config_hash !== acceptance.intended_engine_config_hash) {
		return "engine config hash differs from the acceptance-intended configuration";
	}
	if (blocks.scope !== undefined && blocks.scope.mode !== acceptance.intended_scope_mode) {
		return `scope mode ${blocks.scope.mode} differs from the acceptance-intended ${acceptance.intended_scope_mode}`;
	}
	if (blocks.scope !== undefined && acceptance.test_scope_hash !== testListHash(blocks.scope.test_files)) {
		return "actual test scope differs from the acceptance-intended test_scope_hash";
	}
	return null;
}

/** Hash of a test-file list: sha256 over its canonical JSON. */
function testListHash(files: readonly string[]): string {
	return createHash("sha256").update(canonicalJson(files), "utf8").digest("hex");
}

/** Execution cross-echoes: exact attempt/job/image/engine/selection
 *  field equality against the envelope's actuals (when present). */
function executionEchoFailure(envelope: V3Envelope, execution: ExecutionReceiptPayload): string | null {
	if (execution.attempt_id !== envelope.attempt_id) {
		return `execution receipt attempt_id "${execution.attempt_id}" does not equal the envelope's "${envelope.attempt_id}"`;
	}
	if (execution.job_key !== envelope.job.job_key) {
		return "execution receipt job_key does not equal the envelope's job binding";
	}
	const blocks = evidenceBlocks(envelope);
	if (blocks.runner !== undefined && blocks.runner.image_digest !== execution.image_digest) {
		return "runner image differs from the execution receipt's image_digest";
	}
	return executionEngineEchoFailure(envelope, execution, blocks);
}

/** Engine + test-selection cross-echoes for the execution receipt. */
function executionEngineEchoFailure(
	envelope: V3Envelope,
	execution: ExecutionReceiptPayload,
	blocks: EnvelopeEvidenceBlocks,
): string | null {
	if (blocks.engine !== undefined) {
		if (blocks.engine.config_hash !== execution.engine_config_hash) {
			return "engine config hash differs from the execution receipt's engine_config_hash";
		}
		if (blocks.engine.name !== execution.engine_name || blocks.engine.version !== execution.engine_version) {
			return "engine name/version differs from the execution receipt";
		}
	}
	const testRun = "test_run" in envelope ? envelope.test_run : undefined;
	if (testRun !== undefined && testRun.command_hash !== execution.test_command_hash) {
		return "test command hash differs from the execution receipt's test_command_hash";
	}
	if (blocks.scope !== undefined) {
		if (execution.selected_test_hash !== testListHash(blocks.scope.test_files)) {
			return "actual test list differs from the execution receipt's selected_test_hash";
		}
		if (execution.selected_test_count !== blocks.scope.test_files.length) {
			return "test count differs from the execution receipt's selected_test_count";
		}
	}
	return null;
}

interface VerifiedReceipts {
	acceptance: AcceptanceReceiptPayload;
	execution: ExecutionReceiptPayload | null;
	terminalization: TerminalizationPayload | null;
}

type ReceiptsOutcome = { ok: true; receipts: VerifiedReceipts } | { ok: false; reason: string };

/** The admission anchor: the SIGNED acceptance must carry the request and
 *  change-set identity the CLI actually submitted. */
function verifyReceipts(envelope: V3Envelope, inputs: VerifyInputs): ReceiptsOutcome {
	const acceptance = parseSignedReceipt(inputs.receipts.acceptance, "acceptance", inputs.keyRegistry);
	if (!acceptance.ok) return acceptance;
	if (acceptance.canonical_hash !== envelope.acceptance_receipt_hash) {
		return { ok: false, reason: "acceptance receipt does not match acceptance_receipt_hash" };
	}
	const anchor = admissionAnchorFailure(acceptance.payload, inputs.expectedAdmission);
	if (anchor !== null) return { ok: false, reason: anchor };
	const echo = acceptanceEchoFailure(envelope, acceptance.payload);
	if (echo !== null) return { ok: false, reason: echo };
	if (envelope.execution_receipt_hash !== undefined) {
		return verifyExecutionArm(envelope, inputs, acceptance.payload);
	}
	return verifyTerminalizationArm(envelope, inputs, acceptance.payload);
}

/** Chain binding + chronology for the execution arm (sixth pass): the
 *  attempt must have executed under EXACTLY the envelope's acceptance
 *  receipt, and the signed timestamps must be ordered. */
function executionChainFailure(
	envelope: V3Envelope,
	acceptance: AcceptanceReceiptPayload,
	execution: ExecutionReceiptPayload,
): string | null {
	if (execution.acceptance_receipt_hash !== envelope.acceptance_receipt_hash) {
		return "execution receipt binds a different acceptance receipt — receipt mix-and-match";
	}
	return (
		chronologyFailure("acceptance.issued_at", acceptance.issued_at, "execution.issued_at", execution.issued_at) ??
		chronologyFailure("execution.issued_at", execution.issued_at, "result.occurred_at", envelope.occurred_at)
	);
}

function verifyExecutionArm(
	envelope: V3Envelope,
	inputs: VerifyInputs,
	acceptance: AcceptanceReceiptPayload,
): ReceiptsOutcome {
	if (inputs.receipts.execution === undefined) {
		return { ok: false, reason: "signed execution receipt required — the envelope binds one" };
	}
	const execution = parseSignedReceipt(inputs.receipts.execution, "execution", inputs.keyRegistry);
	if (!execution.ok) return execution;
	if (execution.canonical_hash !== envelope.execution_receipt_hash) {
		return { ok: false, reason: "execution receipt does not match execution_receipt_hash" };
	}
	if (execution.signing_key_id !== envelope.signature.key_id) {
		return {
			ok: false,
			reason: "result signer must equal the verified execution receipt signer on the execution arm",
		};
	}
	const chain =
		executionChainFailure(envelope, acceptance, execution.payload) ??
		sourceArtifactMismatch(execution.payload.source_artifact, acceptance.source_artifact) ??
		executionEchoFailure(envelope, execution.payload);
	if (chain !== null) return { ok: false, reason: chain };
	return { ok: true, receipts: { acceptance, execution: execution.payload, terminalization: null } };
}

/** Terminalization cross-echoes (fifth pass P0): the signed record must
 *  AGREE with the envelope — a signed contradiction is a rejection. */
function terminalizationEchoFailure(envelope: V3Envelope, term: TerminalizationPayload): string | null {
	if (term.terminal_state !== envelope.kind) {
		return `terminalization terminal_state "${term.terminal_state}" contradicts the envelope kind "${envelope.kind}"`;
	}
	if (term.acceptance_receipt_hash !== envelope.acceptance_receipt_hash) {
		return "terminalization record binds a different acceptance receipt than the envelope";
	}
	if (term.occurred_at !== envelope.occurred_at) {
		return "terminalization occurred_at differs from the envelope's occurred_at";
	}
	const reason = envelopeTerminalReason(envelope);
	if (reason !== null && term.reason_code !== reason) {
		return `terminalization reason_code "${term.reason_code}" contradicts the envelope's reason "${reason}"`;
	}
	return null;
}

/** The envelope-side reason the terminalization record must echo. */
function envelopeTerminalReason(envelope: V3Envelope): string | null {
	switch (envelope.kind) {
		case "cancelled":
			return envelope.cancellation_reason;
		case "expired":
			return envelope.expiry_reason;
		case "execution_failed":
			return envelope.failure_classification;
		default:
			return null;
	}
}

function verifyTerminalizationArm(
	envelope: V3Envelope,
	inputs: VerifyInputs,
	acceptance: AcceptanceReceiptPayload,
): ReceiptsOutcome {
	if (inputs.receipts.terminalization === undefined) {
		return { ok: false, reason: "signed terminalization record required — the envelope binds one" };
	}
	const term = parseSignedReceipt(inputs.receipts.terminalization, "terminalization", inputs.keyRegistry);
	if (!term.ok) return term;
	if (term.canonical_hash !== envelope.terminalization_record_hash) {
		return { ok: false, reason: "terminalization record does not match terminalization_record_hash" };
	}
	if (term.signing_key_id !== envelope.signature.key_id) {
		return {
			ok: false,
			reason: "result signer must equal the verified terminalization receipt signer on the control arm",
		};
	}
	const contradiction = terminalizationEchoFailure(envelope, term.payload);
	if (contradiction !== null) return { ok: false, reason: contradiction };
	// Policy continuity + chronology (sixth pass P1).
	if (term.payload.policy_version !== acceptance.policy_version) {
		return { ok: false, reason: "terminalization policy_version differs from the acceptance receipt's" };
	}
	const chronology = chronologyFailure(
		"acceptance.issued_at",
		acceptance.issued_at,
		"terminalization.occurred_at",
		term.payload.occurred_at,
	);
	if (chronology !== null) return { ok: false, reason: chronology };
	if (term.payload.job_key !== envelope.job.job_key) {
		return { ok: false, reason: "terminalization record job_key does not equal the envelope's job binding" };
	}
	return { ok: true, receipts: { acceptance, execution: null, terminalization: term.payload } };
}

/** Hash + registry sanity + clock + attestation + caller job echo. */
function preReceiptFailure(envelope: ParsedEnvelope, inputs: VerifyInputs): string | null {
	if (computeResultHash(envelope) !== envelope.result_hash) {
		return "result_hash mismatch — the envelope's evidence differs from what was hashed";
	}
	return (
		keyRegistryFailure(inputs.keyRegistry) ??
		registryRoleConflictFailure(inputs.keyRegistry) ??
		timeFailure(envelope, inputs.now) ??
		signatureFailure(envelope, inputs.keyRegistry) ??
		authorityFailure(envelope.job, inputs.serverAuthority) ??
		jobEchoMismatch(envelope.job, inputs.expectedJob)
	);
}

/** Signed-timestamp ordering: `earlier` must not be after `later`. Both
 *  values are RFC3339-validated by their schemas, so Date.parse is finite. */
function chronologyFailure(earlierLabel: string, earlier: string, laterLabel: string, later: string): string | null {
	const earlierMs = Date.parse(earlier);
	const laterMs = Date.parse(later);
	if (!Number.isFinite(earlierMs) || !Number.isFinite(laterMs)) {
		return `${earlierLabel} or ${laterLabel} is malformed — receipt chronology cannot be verified`;
	}
	if (earlierMs > laterMs) {
		return `${earlierLabel} (${earlier}) is after ${laterLabel} (${later}) — receipt chronology violated`;
	}
	return null;
}

/** Structural report binding; a bound pointer with no bytes fails. */
function reportBindingFailure(envelope: ParsedEnvelope, report: Uint8Array | undefined): string | null {
	if (report !== undefined) return verifyReportAgainstEnvelope(envelope, report);
	const hasPointer = "report" in envelope;
	return hasPointer ? "report bytes required — the envelope binds a report pointer" : null;
}

function mintBundle(envelope: ParsedEnvelope, receipts: VerifiedReceipts): VerifyOutcome {
	// SAFETY: every check in verifyEnvelope passed — this is the one place
	// the bundle brand is minted. The envelope was deep-frozen at parse and
	// the receipt payloads at receipt verification; freezing the container
	// completes tenth-pass P0-1 (authenticated evidence is immutable).
	const bundle: VerifiedEvidenceBundle = Object.freeze({
		envelope,
		acceptance: receipts.acceptance,
		execution: receipts.execution,
		terminalization: receipts.terminalization,
		[VERIFIED_BUNDLE]: true as const,
	});
	verifiedEvidenceBundles.add(bundle);
	return { ok: true, bundle };
}

/** Verify one PARSED envelope — parse-before-verify is enforced by the
 *  ParsedEnvelope brand. The only mint of `VerifiedEvidenceBundle`. */
export function verifyEnvelope(envelope: ParsedEnvelope, inputs: VerifyInputs): VerifyOutcome {
	// Verification configuration is a trust input too. Snapshot it before
	// the first check so accessors/proxies and caller-owned nested objects
	// cannot present one key/admission/job to validation and another to a
	// later signature or echo check. The snapshot is local and is never
	// retained by the returned bundle (report bytes and trust registry
	// included).
	const snapshot = snapshotVerifyInputs(inputs);
	if (snapshot === null) {
		return { ok: false, reason: "verification inputs must be detached structured-clone data" };
	}
	const pre = preReceiptFailure(envelope, snapshot);
	if (pre !== null) return { ok: false, reason: pre };
	const receipts = verifyReceipts(envelope, snapshot);
	if (!receipts.ok) return receipts;
	const report = reportBindingFailure(envelope, snapshot.report);
	if (report !== null) return { ok: false, reason: report };
	return mintBundle(envelope, receipts.receipts);
}

/** The one public entry point: raw wire value → verified evidence bundle. */
export function parseAndVerify(raw: unknown, inputs: VerifyInputs): VerifyOutcome {
	const parsed = parseUntrustedEnvelope(raw);
	if (!parsed.ok) return { ok: false, reason: `parse: ${parsed.reason}` };
	return verifyEnvelope(parsed.envelope, inputs);
}
