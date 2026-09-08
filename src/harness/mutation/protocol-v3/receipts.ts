// ===========================================
// Protocol v3 — signed receipt schemas (production contract)
// ===========================================
// Review 2026-08-31 fifth pass: receipts carry the FULL plan-27 bindings
// (request/scope/changeset/quota identity on acceptance; engine, lockfile,
// runtime, selection identity on execution; the complete terminalization
// record), a SIGNED timestamp for key-window checks, and are verified
// under key PURPOSES — a result key cannot mint an acceptance receipt.
// A receipt is `{payload, signature}`: signature = Ed25519 over
// utf8(canonicalJson({key_id, payload})) — key_id is INSIDE the signed
// bytes; the envelope binds sha256(canonicalJson(payload)).

import { createHash, verify as edVerify } from "node:crypto";
import {
	canonicalJson,
	deepFreeze,
	keyPurposeFailure,
	keyWindowFailure,
	type V3KeyRegistry,
} from "./canonical.js";
import {
	checkBoundedString,
	checkFullGitCommitSha,
	checkImageDigest,
	checkPolicyId,
	checkRepoRelativePath,
	checkRfc3339,
	checkSafeNonNegInt,
	checkSha256Hex,
	checkSourceArtifactBinding,
	firstReason,
	isRecord,
	type Reason,
	unknownKeysIn,
} from "./field-checks.js";
import {
	PROTOCOL_V3_VERSION,
	type V3JobBinding,
	type V3SourceArtifactBinding,
} from "./types.js";

export interface AcceptanceReceiptPayload {
	receipt_version: "1";
	kind: "acceptance";
	/** The protocol this acceptance authorizes (tenth pass P1-4). */
	protocol_version: typeof PROTOCOL_V3_VERSION;
	/** Signed issuance instant — the key-window anchor for this receipt. */
	issued_at: string;
	job: V3JobBinding;
	/** The policies this job was AUTHORIZED to use. */
	approved_policy_ids: string[];
	/** Version of the policy set the approvals came from. */
	policy_version: string;
	/** Hash of the canonical accepted request. */
	request_hash: string;
	/** Hash of the INTENDED test scope (canonicalJson of the test list). */
	test_scope_hash: string;
	quota_reservation_id: string;
	/** Change-set / overlay-set identity the job measures. */
	changeset_hash: string;
	/** Opaque, hash/length-bound source bundle accepted for execution. */
	source_artifact: V3SourceArtifactBinding;
	intended_image_digest: string;
	intended_engine_config_hash: string;
	intended_scope_mode: "import_graph" | "companion_fallback" | "glob_fallback";
}

export interface ExecutionReceiptPayload {
	receipt_version: "1";
	kind: "execution";
	/** Signed issuance instant — the key-window anchor for this receipt. */
	issued_at: string;
	/** The exact acceptance receipt this attempt executed under — closes
	 *  receipt mix-and-match (review 2026-08-31 sixth pass P0). */
	acceptance_receipt_hash: string;
	/** Exact accepted source bundle mounted by the Sandbox. */
	source_artifact: V3SourceArtifactBinding;
	job_key: string;
	attempt_id: string;
	image_digest: string;
	engine_name: string;
	engine_version: string;
	engine_config_hash: string;
	/** Dependency snapshot the attempt ran under. */
	lockfile_hash: string;
	runtime_identity: string;
	package_manager_identity: string;
	/** Hash of the exact test command. */
	test_command_hash: string;
	test_selection_algorithm: string;
	/** Hash of the ACTUAL selected test list (canonicalJson of the array). */
	selected_test_hash: string;
	selected_test_count: number;
}

/** The full plan-27 terminalization record payload. `occurred_at` is its
 *  signed timestamp (the terminal event instant). */
export interface TerminalizationPayload {
	receipt_version: "1";
	kind: "terminalization";
	job_key: string;
	acceptance_receipt_hash: string;
	terminal_state: string;
	actor: string;
	authority: string;
	reason_code: string;
	occurred_at: string;
	policy_version: string;
}

interface PayloadByKind {
	acceptance: AcceptanceReceiptPayload;
	execution: ExecutionReceiptPayload;
	terminalization: TerminalizationPayload;
}

export type ReceiptKind = keyof PayloadByKind;

export type ReceiptOutcome<K extends ReceiptKind> =
	| { ok: true; payload: PayloadByKind[K]; canonical_hash: string; signing_key_id: string }
	| { ok: false; reason: string };

/** The hash the envelope binds: over the CANONICAL payload. */
export function canonicalReceiptHash(payload: unknown): string {
	return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

const SCOPE_MODES = ["import_graph", "companion_fallback", "glob_fallback"];
/** MUST equal maxItems in schema/receipts.schema.json (parity-pinned). */
export const MAX_APPROVED_POLICY_IDS = 256;

const ACCEPTANCE_KEYS = [
	"receipt_version",
	"kind",
	"protocol_version",
	"issued_at",
	"job",
	"approved_policy_ids",
	"policy_version",
	"request_hash",
	"test_scope_hash",
	"quota_reservation_id",
	"changeset_hash",
	"source_artifact",
	"intended_image_digest",
	"intended_engine_config_hash",
	"intended_scope_mode",
];

const EXECUTION_KEYS = [
	"receipt_version",
	"kind",
	"issued_at",
	"acceptance_receipt_hash",
	"source_artifact",
	"job_key",
	"attempt_id",
	"image_digest",
	"engine_name",
	"engine_version",
	"engine_config_hash",
	"lockfile_hash",
	"runtime_identity",
	"package_manager_identity",
	"test_command_hash",
	"test_selection_algorithm",
	"selected_test_hash",
	"selected_test_count",
];

const TERMINALIZATION_KEYS = [
	"receipt_version",
	"kind",
	"job_key",
	"acceptance_receipt_hash",
	"terminal_state",
	"actor",
	"authority",
	"reason_code",
	"occurred_at",
	"policy_version",
];

function checkReceiptJob(o: Record<string, unknown>, where: string): Reason {
	const fields = ["tenant", "project", "repository", "commit", "target_file", "target_content_hash", "job_key"];
	const keys = unknownKeysIn(o, fields, where);
	if (keys !== null) return keys;
	return firstReason([
		checkBoundedString(o.tenant, `${where}.tenant`),
		checkBoundedString(o.project, `${where}.project`),
		checkBoundedString(o.repository, `${where}.repository`),
		checkFullGitCommitSha(o.commit, `${where}.commit`),
		checkRepoRelativePath(o.target_file, `${where}.target_file`),
		checkSha256Hex(o.target_content_hash, `${where}.target_content_hash`),
		checkBoundedString(o.job_key, `${where}.job_key`),
	]);
}

function checkAcceptancePayload(o: Record<string, unknown>): Reason {
	const keys = unknownKeysIn(o, ACCEPTANCE_KEYS, "acceptance");
	if (keys !== null) return keys;
	if (!isRecord(o.job)) return "acceptance.job must be an object";
	const policies = o.approved_policy_ids;
	if (!Array.isArray(policies)) return "acceptance.approved_policy_ids must be an array";
	if (new Set(policies).size !== policies.length) {
		return "acceptance.approved_policy_ids must not contain duplicates";
	}
	// Parity with schema/receipts.schema.json maxItems (seventh pass P0-2).
	if (policies.length > MAX_APPROVED_POLICY_IDS) {
		return `acceptance.approved_policy_ids exceeds ${MAX_APPROVED_POLICY_IDS} entries`;
	}
	return firstReason([
		o.protocol_version === PROTOCOL_V3_VERSION
			? null
			: `acceptance.protocol_version must be exactly "${PROTOCOL_V3_VERSION}"`,
		checkRfc3339(o.issued_at, "acceptance.issued_at"),
		checkReceiptJob(o.job, "acceptance.job"),
		...policies.map((p) => checkPolicyId(p, "acceptance.approved_policy_ids[]")),
		checkBoundedString(o.policy_version, "acceptance.policy_version"),
		checkSha256Hex(o.request_hash, "acceptance.request_hash"),
		checkSha256Hex(o.test_scope_hash, "acceptance.test_scope_hash"),
		checkBoundedString(o.quota_reservation_id, "acceptance.quota_reservation_id"),
		checkSha256Hex(o.changeset_hash, "acceptance.changeset_hash"),
		checkSourceArtifactBinding(o.source_artifact, "acceptance.source_artifact"),
		checkImageDigest(o.intended_image_digest, "acceptance.intended_image_digest"),
		checkSha256Hex(o.intended_engine_config_hash, "acceptance.intended_engine_config_hash"),
		typeof o.intended_scope_mode === "string" && SCOPE_MODES.includes(o.intended_scope_mode)
			? null
			: `acceptance.intended_scope_mode must be one of ${SCOPE_MODES.join("|")}`,
	]);
}

function checkExecutionPayload(o: Record<string, unknown>): Reason {
	const keys = unknownKeysIn(o, EXECUTION_KEYS, "execution");
	if (keys !== null) return keys;
	return firstReason([
		checkRfc3339(o.issued_at, "execution.issued_at"),
		checkSha256Hex(o.acceptance_receipt_hash, "execution.acceptance_receipt_hash"),
		checkSourceArtifactBinding(o.source_artifact, "execution.source_artifact"),
		checkBoundedString(o.job_key, "execution.job_key"),
		checkBoundedString(o.attempt_id, "execution.attempt_id"),
		checkImageDigest(o.image_digest, "execution.image_digest"),
		checkBoundedString(o.engine_name, "execution.engine_name"),
		checkBoundedString(o.engine_version, "execution.engine_version"),
		checkSha256Hex(o.engine_config_hash, "execution.engine_config_hash"),
		checkSha256Hex(o.lockfile_hash, "execution.lockfile_hash"),
		checkBoundedString(o.runtime_identity, "execution.runtime_identity"),
		checkBoundedString(o.package_manager_identity, "execution.package_manager_identity"),
		checkSha256Hex(o.test_command_hash, "execution.test_command_hash"),
		checkBoundedString(o.test_selection_algorithm, "execution.test_selection_algorithm"),
		checkSha256Hex(o.selected_test_hash, "execution.selected_test_hash"),
		checkSafeNonNegInt(o.selected_test_count, "execution.selected_test_count"),
	]);
}

function checkTerminalizationPayload(o: Record<string, unknown>): Reason {
	const keys = unknownKeysIn(o, TERMINALIZATION_KEYS, "terminalization");
	if (keys !== null) return keys;
	return firstReason([
		checkBoundedString(o.job_key, "terminalization.job_key"),
		checkSha256Hex(o.acceptance_receipt_hash, "terminalization.acceptance_receipt_hash"),
		checkBoundedString(o.terminal_state, "terminalization.terminal_state"),
		checkBoundedString(o.actor, "terminalization.actor"),
		checkBoundedString(o.authority, "terminalization.authority"),
		checkBoundedString(o.reason_code, "terminalization.reason_code"),
		checkRfc3339(o.occurred_at, "terminalization.occurred_at"),
		checkBoundedString(o.policy_version, "terminalization.policy_version"),
	]);
}

const PAYLOAD_CHECKS: Record<ReceiptKind, (o: Record<string, unknown>) => Reason> = {
	acceptance: checkAcceptancePayload,
	execution: checkExecutionPayload,
	terminalization: checkTerminalizationPayload,
};

/** The signed timestamp anchoring each receipt's key-window check. */
function signedAtOf(kind: ReceiptKind, payload: Record<string, unknown>): string | undefined {
	const timestamp = kind === "terminalization" ? payload.occurred_at : payload.issued_at;
	return typeof timestamp === "string" ? timestamp : undefined;
}

function signatureFields(signature: Record<string, unknown>): { keyId: string; value: string } | null {
	if (typeof signature.key_id !== "string" || typeof signature.value !== "string") return null;
	return { keyId: signature.key_id, value: signature.value };
}

function receiptKeyFailure(
	kind: ReceiptKind,
	payload: Record<string, unknown>,
	signature: Record<string, unknown>,
	registry: V3KeyRegistry,
): Reason {
	const bad = firstReason([
		unknownKeysIn(signature, ["key_id", "value"], "receipt.signature"),
		checkBoundedString(signature.key_id, "receipt.signature.key_id"),
		checkBoundedString(signature.value, "receipt.signature.value"),
	]);
	if (bad !== null) return bad;
	const fields = signatureFields(signature);
	if (fields === null) return "receipt.signature fields must be strings";
	const keyId = fields.keyId;
	const signedAt = signedAtOf(kind, payload);
	if (signedAt === undefined) return "receipt signed timestamp must be a string";
	const record = registry[keyId];
	if (record === undefined) return `receipt signed by unknown key "${keyId}"`;
	return (
		keyPurposeFailure(keyId, record, kind) ??
		keyWindowFailure(keyId, record, Date.parse(signedAt)) ??
		receiptSignatureFailure(payload, keyId, record.public_key_pem, fields.value)
	);
}

function receiptSignatureFailure(
	payload: Record<string, unknown>,
	keyId: string,
	publicKeyPem: string,
	signatureValue: string,
): Reason {
	let valid = false;
	try {
		// The SIGNED bytes include key_id (review 2026-08-31 sixth pass P0:
		// an unsigned key id could be relabeled to a same-key alias with a
		// different purpose).
		valid = edVerify(
			null,
			Buffer.from(canonicalJson({ key_id: keyId, payload }), "utf8"),
			publicKeyPem,
			Buffer.from(signatureValue, "base64"),
		);
	} catch {
		return `receipt signature by "${keyId}" errored — malformed key or signature encoding`;
	}
	return valid ? null : "receipt signature verification failed";
}

/** Parse and verify ONE signed receipt of the expected kind: strict
 *  schema, key purpose, key window vs the SIGNED timestamp, signature. */
export function parseSignedReceipt<K extends ReceiptKind>(
	text: string,
	kind: K,
	registry: V3KeyRegistry,
): ReceiptOutcome<K> {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, reason: `${kind} receipt is not valid JSON` };
	}
	if (!isRecord(raw) || !isRecord(raw.payload) || !isRecord(raw.signature)) {
		return { ok: false, reason: `${kind} receipt must be {payload, signature}` };
	}
	const envelope = unknownKeysIn(raw, ["payload", "signature"], `${kind} receipt`);
	if (envelope !== null) return { ok: false, reason: envelope };
	const payload = raw.payload;
	if (payload.receipt_version !== "1") return { ok: false, reason: `${kind} receipt_version must be "1"` };
	if (payload.kind !== kind) return { ok: false, reason: `receipt kind is "${String(payload.kind)}", expected "${kind}"` };
	const shape = PAYLOAD_CHECKS[kind](payload);
	if (shape !== null) return { ok: false, reason: shape };
	const key = receiptKeyFailure(kind, payload, raw.signature, registry);
	if (key !== null) return { ok: false, reason: key };
	// SAFETY: receiptKeyFailure validated this as a bounded non-empty string
	// and verified the signature over the same key id.
	const signingKeyId = raw.signature.key_id as string;
	// Tenth pass P0-1: the payload is own data (parsed from text) — freeze
	// it so a verified receipt can never be mutated afterward.
	deepFreeze(payload);
	// SAFETY: the kind-specific schema check above validated every field of
	// the asserted payload shape.
	return {
		ok: true,
		payload: payload as unknown as PayloadByKind[K],
		canonical_hash: canonicalReceiptHash(payload),
		signing_key_id: signingKeyId,
	};
}
