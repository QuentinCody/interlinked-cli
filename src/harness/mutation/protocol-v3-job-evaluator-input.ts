// ==========================================================
// Durable mutation jobs — strict protocol-v3 input parsing
// ==========================================================
// The journal and remote response are both untrusted at this boundary. These
// helpers keep the evaluator focused on authentication and classification.

import { createHash } from "node:crypto";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import type { ClaimedMutationJob } from "./mutation-journal-types.js";
import { hasExactJsonKeys } from "./mutation-cloud-v3-http.js";
import {
	canonicalJson,
	safeStructuredClone,
} from "./protocol-v3/canonical.js";
import {
	checkBoundedString,
	checkFullGitCommitSha,
	checkRepoRelativePath,
	checkSha256Hex,
	checkSourceArtifactBinding,
	unknownKeysIn,
} from "./protocol-v3/field-checks.js";
import { parseUntrustedEnvelope, type ParsedEnvelope } from "./protocol-v3/parse.js";
import type { V3JobBinding, V3SourceArtifactBinding } from "./protocol-v3/types.js";
import type { ExpectedAdmission } from "./protocol-v3/verify.js";
import type { MutationManifest } from "./types.js";

const REMOTE_EVIDENCE_KEYS = [
	"envelope",
	"acceptance_receipt",
	"execution_receipt",
	"terminalization_record",
	"report_bytes",
] as const;
const EXPECTED_JOB_KEYS = [
	"tenant",
	"project",
	"repository",
	"commit",
	"target_file",
	"target_content_hash",
	"job_key",
] as const;
const EXPECTED_ADMISSION_KEYS = ["request_hash", "changeset_hash", "source_artifact"] as const;
const MANIFEST_KEYS = [
	"version",
	"generation",
	"authoritativeAt",
	"engine",
	"engineVersion",
	"dependencyGraphVersion",
	"environmentHash",
	"sourceRevision",
	"files",
	"fileProvenance",
] as const;

/** The only accepted terminal evidence wrapper from the remote job API. */
export interface ProtocolV3RemoteEvidence {
	envelope: unknown;
	acceptance_receipt: string;
	execution_receipt: string | null;
	terminalization_record: string | null;
	report_bytes: Uint8Array | null;
}

function fail(reason: string): never {
	throw new Error(`protocol-v3 mutation evidence: ${reason}`);
}

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function canonicalHash(value: unknown): string {
	return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function nonEmptyString(value: unknown, where: string): string {
	if (typeof value !== "string" || value.length === 0) fail(`${where} must be a non-empty string`);
	return value;
}

function nullableString(value: unknown, where: string): string | null {
	if (value === null) return null;
	return nonEmptyString(value, where);
}

export function parseProtocolV3RemoteEvidence(value: unknown): ProtocolV3RemoteEvidence {
	const snapshot = safeStructuredClone(value);
	if (snapshot === null || !isJsonObject(snapshot)) fail("terminal evidence must be detached object data");
	if (!hasExactJsonKeys(snapshot, REMOTE_EVIDENCE_KEYS)) {
		fail(`terminal evidence must contain exactly ${REMOTE_EVIDENCE_KEYS.join(", ")}`);
	}
	const execution = nullableString(snapshot.execution_receipt, "execution_receipt");
	const terminalization = nullableString(snapshot.terminalization_record, "terminalization_record");
	if ((execution === null) === (terminalization === null)) {
		fail("terminal evidence must carry exactly one execution_receipt or terminalization_record");
	}
	const report = snapshot.report_bytes;
	if (report !== null && !(report instanceof Uint8Array)) {
		fail("report_bytes must be a byte array or null");
	}
	return Object.freeze({
		envelope: snapshot.envelope,
		acceptance_receipt: nonEmptyString(snapshot.acceptance_receipt, "acceptance_receipt"),
		execution_receipt: execution,
		terminalization_record: terminalization,
		report_bytes: report,
	});
}

export function parseProtocolV3Envelope(value: unknown): ParsedEnvelope {
	const parsed = parseUntrustedEnvelope(value);
	if (!parsed.ok) fail(`envelope parse failed: ${parsed.reason}`);
	return parsed.envelope;
}

function assertReason(reason: string | null): void {
	if (reason !== null) fail(reason);
}

export function expectedJobFromJournal(value: unknown): V3JobBinding {
	if (!isJsonObject(value)) fail("journal expectedJob must be an object");
	assertReason(unknownKeysIn(value, EXPECTED_JOB_KEYS, "journal expectedJob"));
	assertReason(checkBoundedString(value.tenant, "journal expectedJob.tenant"));
	assertReason(checkBoundedString(value.project, "journal expectedJob.project"));
	assertReason(checkBoundedString(value.repository, "journal expectedJob.repository"));
	assertReason(checkFullGitCommitSha(value.commit, "journal expectedJob.commit"));
	assertReason(checkRepoRelativePath(value.target_file, "journal expectedJob.target_file"));
	assertReason(checkSha256Hex(value.target_content_hash, "journal expectedJob.target_content_hash"));
	assertReason(checkBoundedString(value.job_key, "journal expectedJob.job_key"));
	return {
		tenant: value.tenant as string,
		project: value.project as string,
		repository: value.repository as string,
		commit: value.commit as string,
		target_file: value.target_file as string,
		target_content_hash: value.target_content_hash as string,
		job_key: value.job_key as string,
	};
}

export function expectedAdmissionFromJournal(value: unknown): ExpectedAdmission {
	if (!isJsonObject(value)) fail("journal expectedAdmission must be an object");
	assertReason(unknownKeysIn(value, EXPECTED_ADMISSION_KEYS, "journal expectedAdmission"));
	assertReason(checkSha256Hex(value.request_hash, "journal expectedAdmission.request_hash"));
	assertReason(checkSha256Hex(value.changeset_hash, "journal expectedAdmission.changeset_hash"));
	assertReason(checkSourceArtifactBinding(value.source_artifact, "journal expectedAdmission.source_artifact"));
	// SAFETY: checkSourceArtifactBinding proved this exact four-field shape.
	const artifact = value.source_artifact as V3SourceArtifactBinding;
	return {
		request_hash: value.request_hash as string,
		changeset_hash: value.changeset_hash as string,
		source_artifact: {
			format: artifact.format,
			artifact_id: artifact.artifact_id,
			sha256: artifact.sha256,
			bytes: artifact.bytes,
		},
	};
}

export function targetContentFromJournal(job: Readonly<ClaimedMutationJob>, expectedJob: V3JobBinding): string {
	assertReason(checkSha256Hex(job.acceptanceReceiptHash, "journal acceptanceReceiptHash"));
	assertReason(checkSha256Hex(job.targetSha256, "journal targetSha256"));
	if (!(job.targetBytes instanceof Uint8Array)) fail("journal targetBytes must be a byte array");
	const bytes = Uint8Array.from(job.targetBytes);
	const actualHash = sha256(bytes);
	if (actualHash !== job.targetSha256) fail("journal targetBytes do not match targetSha256");
	if (actualHash !== expectedJob.target_content_hash) {
		fail("journal targetBytes do not match expectedJob.target_content_hash");
	}
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		fail("journal targetBytes are not valid UTF-8 source text");
	}
	if (!Buffer.from(content, "utf8").equals(bytes)) {
		fail("journal targetBytes cannot be losslessly represented as UTF-8 source text");
	}
	return content;
}

export function manifestFromHead(value: unknown): MutationManifest {
	const snapshot = safeStructuredClone(value);
	if (snapshot === null || !isJsonObject(snapshot)) fail("mutation manifest head snapshot must be an object");
	assertReason(unknownKeysIn(snapshot, MANIFEST_KEYS, "mutation manifest head snapshot"));
	if (snapshot.version !== 1) fail("mutation manifest head snapshot.version must be 1");
	if (typeof snapshot.generation !== "number" || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0) {
		fail("mutation manifest head snapshot.generation must be a non-negative safe integer");
	}
	for (const key of ["authoritativeAt", "engine", "engineVersion", "dependencyGraphVersion", "environmentHash"] as const) {
		if (typeof snapshot[key] !== "string") fail(`mutation manifest head snapshot.${key} must be a string`);
	}
	if (snapshot.sourceRevision !== undefined && typeof snapshot.sourceRevision !== "string") {
		fail("mutation manifest head snapshot.sourceRevision must be a string when present");
	}
	if (!isJsonObject(snapshot.files)) fail("mutation manifest head snapshot.files must be an object");
	if (snapshot.fileProvenance !== undefined && !isJsonObject(snapshot.fileProvenance)) {
		fail("mutation manifest head snapshot.fileProvenance must be an object when present");
	}
	// SAFETY: the versioned top-level shell is checked above. Nested records
	// are journal-authored MutationManifest data, matching manifest.ts's reader.
	return snapshot as unknown as MutationManifest;
}

function reportPointer(envelope: ParsedEnvelope): { bytes: number } | null {
	const raw = envelope as unknown as JsonObject;
	if (raw.report === undefined) return null;
	if (!isJsonObject(raw.report) || typeof raw.report.bytes !== "number") {
		fail("parsed envelope contains an invalid report pointer");
	}
	return { bytes: raw.report.bytes };
}

export function reportBytes(envelope: ParsedEnvelope, bytes: Uint8Array | null): Uint8Array | undefined {
	const pointer = reportPointer(envelope);
	if (pointer === null) {
		if (bytes !== null) fail("report_bytes must be null when the envelope has no report pointer");
		return undefined;
	}
	if (bytes === null) {
		fail("report_bytes is required when the envelope binds a report pointer");
	}
	if (bytes.byteLength !== pointer.bytes) {
		fail("report_bytes must match the declared report length");
	}
	// parseProtocolV3RemoteEvidence already detached the untrusted wrapper with
	// structuredClone. Returning that owned copy avoids the old
	// bytes→base64→bytes allocation chain.
	return bytes;
}

export function receiptInputs(wire: ProtocolV3RemoteEvidence, envelope: ParsedEnvelope) {
	const executionArm = envelope.execution_receipt_hash !== undefined;
	if (executionArm && (wire.execution_receipt === null || wire.terminalization_record !== null)) {
		fail("terminal evidence receipt arm disagrees with the envelope execution receipt hash");
	}
	if (!executionArm && (wire.terminalization_record === null || wire.execution_receipt !== null)) {
		fail("terminal evidence receipt arm disagrees with the envelope terminalization record hash");
	}
	return executionArm
		? { acceptance: wire.acceptance_receipt, execution: wire.execution_receipt as string }
		: { acceptance: wire.acceptance_receipt, terminalization: wire.terminalization_record as string };
}

export function authenticatedEvidenceHash(bundle: {
	envelope: unknown;
	acceptance: unknown;
	execution: unknown;
	terminalization: unknown;
}): string {
	return canonicalHash({
		envelope: bundle.envelope,
		acceptance: bundle.acceptance,
		execution: bundle.execution,
		terminalization: bundle.terminalization,
	});
}
