// =========================================================
// Durable mutation journal — safe cloud-onboarding intents
// =========================================================

import { createHash } from "node:crypto";
import {
	asRow,
	assertSameEnqueue,
	bytesField,
	changes,
	detached,
	inTransaction,
	nullableNumber,
	nullableString,
	numberField,
	requireHash,
	requireString,
	requireTimestamp,
	stableJson,
	stringField,
	validateEnqueue,
} from "./mutation-journal-codec.js";
import type { SqliteDatabase } from "./mutation-journal-driver.js";
import type {
	ActivateMutationOnboardingIntent,
	ActivateMutationOnboardingOutcome,
	EnqueueMutationJob,
	JournalFaultPoint,
	MutationOnboardingBinding,
	MutationOnboardingIntent,
	PrepareMutationOnboardingIntent,
	PrepareMutationOnboardingOutcome,
} from "./mutation-journal-types.js";
import { canonicalJson } from "./protocol-v3/canonical.js";
import { MAX_SOURCE_ARTIFACT_BYTES, MAX_TARGET_SOURCE_BYTES } from "./protocol-v3/field-checks.js";
import {
	deriveAdmission,
	parseMutationJobRequestV3,
	type ValidMutationJobRequest,
} from "./protocol-v3/request.js";

const MAX_ONBOARDING_REQUEST_BYTES = 1024 * 1024;
const ONBOARDING_JOB_KEY_RE = /^job_onboard_[a-f0-9]{64}$/;

interface ValidatedPreparedIntent {
	intent: PrepareMutationOnboardingIntent;
	request: ValidMutationJobRequest;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function requireBytes(value: unknown, label: string, minBytes: number, maxBytes: number): Uint8Array {
	if (!(value instanceof Uint8Array) || value.byteLength < minBytes || value.byteLength > maxBytes) {
		throw new Error(`${label} must contain ${minBytes}..${maxBytes} bytes`);
	}
	return Uint8Array.from(value);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	if (actual !== expected) throw new Error(`mutation onboarding ${label} differs from requestBytes`);
}

function validateBinding(input: MutationOnboardingBinding): void {
	requireString(input.tenant, "tenant");
	requireString(input.project, "project");
	requireString(input.repository, "repository");
	requireString(input.commit, "commit");
	requireString(input.targetFile, "targetFile");
	if (!/^[a-f0-9]{40}$/.test(input.commit)) {
		throw new Error("commit must be a full lowercase 40-hex Git commit SHA");
	}
}

function validateScalarFields(input: PrepareMutationOnboardingIntent): void {
	validateBinding(input);
	for (const [label, value] of [
		["jobKey", input.jobKey],
		["tenant", input.tenant],
		["project", input.project],
		["sourceArtifactId", input.sourceArtifactId],
	] as const) requireString(value, label);
	if (!ONBOARDING_JOB_KEY_RE.test(input.jobKey)) {
		throw new Error("mutation onboarding jobKey must use the job_onboard_<64-hex> domain");
	}
	for (const [label, value] of [
		["requestSha256", input.requestSha256],
		["sourceArtifactSha256", input.sourceArtifactSha256],
		["targetSha256", input.targetSha256],
		["requestHash", input.requestHash],
		["changesetHash", input.changesetHash],
	] as const) requireHash(value, label);
	requireTimestamp(input.createdAtMs, "createdAtMs");
}

function normalizedBytes(input: PrepareMutationOnboardingIntent): {
	requestBytes: Uint8Array;
	sourceArtifactBytes: Uint8Array;
	targetBytes: Uint8Array;
} {
	const requestBytes = requireBytes(input.requestBytes, "requestBytes", 1, MAX_ONBOARDING_REQUEST_BYTES);
	const sourceArtifactBytes = requireBytes(
		input.sourceArtifactBytes,
		"sourceArtifactBytes",
		1,
		MAX_SOURCE_ARTIFACT_BYTES,
	);
	const targetBytes = requireBytes(input.targetBytes, "targetBytes", 0, MAX_TARGET_SOURCE_BYTES);
	assertEqual(sha256(requestBytes), input.requestSha256, "request sha256");
	assertEqual(sha256(sourceArtifactBytes), input.sourceArtifactSha256, "source artifact sha256");
	assertEqual(sha256(targetBytes), input.targetSha256, "target sha256");
	return { requestBytes, sourceArtifactBytes, targetBytes };
}

function parseCanonicalRequest(requestBytes: Uint8Array): ValidMutationJobRequest {
	let decoded: string;
	let parsedJson: unknown;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(requestBytes);
		parsedJson = JSON.parse(decoded) as unknown;
	} catch (error) {
		throw new Error("mutation onboarding requestBytes must be valid UTF-8 JSON", { cause: error });
	}
	const parsed = parseMutationJobRequestV3(parsedJson);
	if (!parsed.ok) throw new Error(`mutation onboarding request is invalid: ${parsed.reason}`);
	if (canonicalJson(parsed.request) !== decoded) {
		throw new Error("mutation onboarding requestBytes must use protocol canonical JSON");
	}
	return parsed.request;
}

function assertRequestBinding(
	input: PrepareMutationOnboardingIntent,
	request: ValidMutationJobRequest,
	sourceBytes: Uint8Array,
): void {
	assertEqual(request.job.job_key, input.jobKey, "job key");
	assertEqual(request.job.tenant, input.tenant, "tenant");
	assertEqual(request.job.project, input.project, "project");
	assertEqual(request.job.repository, input.repository, "repository");
	assertEqual(request.job.commit, input.commit, "commit");
	assertEqual(request.job.target_file, input.targetFile, "target file");
	assertEqual(request.job.target_content_hash, input.targetSha256, "target hash");
	assertEqual(request.source_artifact.artifact_id, input.sourceArtifactId, "source artifact id");
	assertEqual(request.source_artifact.format, input.sourceArtifactFormat, "source artifact format");
	assertEqual(request.source_artifact.sha256, input.sourceArtifactSha256, "source artifact hash");
	assertEqual(request.source_artifact.bytes, sourceBytes.byteLength, "source artifact length");
	const admission = deriveAdmission(request);
	assertEqual(admission.request_hash, input.requestHash, "request hash");
	assertEqual(admission.changeset_hash, input.changesetHash, "changeset hash");
}

function validatePreparedIntent(raw: PrepareMutationOnboardingIntent): ValidatedPreparedIntent {
	const input = detached(raw, "mutation onboarding intent");
	validateScalarFields(input);
	const bytes = normalizedBytes(input);
	const request = parseCanonicalRequest(bytes.requestBytes);
	assertRequestBinding(input, request, bytes.sourceArtifactBytes);
	return { intent: { ...input, ...bytes }, request };
}

function activationFields(row: ReturnType<typeof asRow>): {
	state: "prepared" | "accepted" | "activated";
	acceptanceReceiptHash: string | null;
	activatedAtMs: number | null;
} {
	const rawState = stringField(row, "state");
	if (rawState !== "prepared" && rawState !== "accepted" && rawState !== "activated") {
		throw new Error("mutation journal onboarding intent has an invalid state");
	}
	const acceptanceReceiptHash = nullableString(row, "acceptance_receipt_hash");
	const activatedAtMs = nullableNumber(row, "activated_at_ms");
	const inconsistent = !activationMetadataMatches(rawState, acceptanceReceiptHash, activatedAtMs);
	if (inconsistent) throw new Error("mutation journal onboarding intent has inconsistent activation metadata");
	if (acceptanceReceiptHash !== null) requireHash(acceptanceReceiptHash, "acceptanceReceiptHash");
	return { state: rawState, acceptanceReceiptHash, activatedAtMs };
}

function activationMetadataMatches(
	state: "prepared" | "accepted" | "activated",
	receiptHash: string | null,
	activatedAtMs: number | null,
): boolean {
	if (state === "prepared") return receiptHash === null && activatedAtMs === null;
	if (state === "accepted") return receiptHash !== null && activatedAtMs === null;
	return receiptHash !== null && activatedAtMs !== null;
}

function readIntentRow(value: unknown): MutationOnboardingIntent {
	const row = asRow(value, "onboarding intent");
	if (numberField(row, "format_version") !== 1) {
		throw new Error("mutation journal onboarding intent has an unsupported format_version");
	}
	const rawFormat = stringField(row, "source_artifact_format");
	if (rawFormat !== "git-archive-tar-v1") {
		throw new Error("mutation journal onboarding intent has an invalid source_artifact_format");
	}
	const prepared: PrepareMutationOnboardingIntent = {
		formatVersion: 1,
		jobKey: stringField(row, "job_key"),
		tenant: stringField(row, "tenant"),
		project: stringField(row, "project"),
		repository: stringField(row, "repository"),
		commit: stringField(row, "commit_sha"),
		targetFile: stringField(row, "target_file"),
		requestBytes: bytesField(row, "request_bytes"),
		requestSha256: stringField(row, "request_sha256"),
		sourceArtifactId: stringField(row, "source_artifact_id"),
		sourceArtifactFormat: rawFormat,
		sourceArtifactBytes: bytesField(row, "source_artifact_bytes"),
		sourceArtifactSha256: stringField(row, "source_artifact_sha256"),
		targetBytes: bytesField(row, "target_bytes"),
		targetSha256: stringField(row, "target_sha256"),
		requestHash: stringField(row, "request_hash"),
		changesetHash: stringField(row, "changeset_hash"),
		createdAtMs: numberField(row, "created_at_ms"),
	};
	return { ...validatePreparedIntent(prepared).intent, ...activationFields(row) };
}

function exactPreparedMatch(actual: MutationOnboardingIntent, expected: PrepareMutationOnboardingIntent): boolean {
	return actual.jobKey === expected.jobKey && actual.tenant === expected.tenant &&
		actual.project === expected.project && actual.repository === expected.repository &&
		actual.commit === expected.commit && actual.targetFile === expected.targetFile &&
		actual.requestSha256 === expected.requestSha256 && actual.sourceArtifactId === expected.sourceArtifactId &&
		actual.sourceArtifactSha256 === expected.sourceArtifactSha256 &&
		actual.targetSha256 === expected.targetSha256 && actual.requestHash === expected.requestHash &&
		actual.changesetHash === expected.changesetHash && actual.createdAtMs === expected.createdAtMs &&
		sameBytes(actual.requestBytes, expected.requestBytes) &&
		sameBytes(actual.sourceArtifactBytes, expected.sourceArtifactBytes) &&
		sameBytes(actual.targetBytes, expected.targetBytes);
}

function enqueueFor(intent: MutationOnboardingIntent, acceptanceReceiptHash: string): EnqueueMutationJob {
	const validated = validatePreparedIntent(intent);
	const enqueue: EnqueueMutationJob = {
		jobId: intent.jobKey,
		remoteJobId: intent.jobKey,
		acceptanceReceiptHash,
		expectedJob: validated.request.job,
		expectedAdmission: deriveAdmission(validated.request),
		targetBytes: intent.targetBytes,
		targetSha256: intent.targetSha256,
		baselineIntent: "adopt_current",
		createdAtMs: intent.createdAtMs,
	};
	validateEnqueue(enqueue);
	return enqueue;
}

function assertStoredJob(db: SqliteDatabase, enqueue: EnqueueMutationJob): void {
	const existing = db.prepare("SELECT * FROM mutation_jobs WHERE job_id = ?").get(enqueue.jobId);
	if (existing === undefined) throw new Error("activated mutation onboarding intent has no durable job");
	assertSameEnqueue(
		asRow(existing, "onboarding job"),
		enqueue,
		stableJson(enqueue.expectedJob),
		stableJson(enqueue.expectedAdmission),
	);
}

export function getMutationOnboardingIntent(
	db: SqliteDatabase,
	input: MutationOnboardingBinding,
): MutationOnboardingIntent | null {
	validateBinding(input);
	const value = db.prepare(`SELECT * FROM mutation_onboarding_intents
		WHERE tenant = ? AND project = ? AND repository = ? AND commit_sha = ? AND target_file = ?`)
		.get(input.tenant, input.project, input.repository, input.commit, input.targetFile);
	return value === undefined ? null : readIntentRow(value);
}

export function prepareMutationOnboardingIntent(
	db: SqliteDatabase,
	raw: PrepareMutationOnboardingIntent,
): PrepareMutationOnboardingOutcome {
	const input = validatePreparedIntent(raw).intent;
	return inTransaction(db, () => {
		const rows = db.prepare(`SELECT * FROM mutation_onboarding_intents WHERE job_key = ? OR
			(tenant = ? AND project = ? AND repository = ? AND commit_sha = ? AND target_file = ?)`).all(
			input.jobKey,
			input.tenant,
			input.project,
			input.repository,
			input.commit,
			input.targetFile,
		);
		if (rows.length > 1) throw new Error("mutation onboarding identity collides with a different intent");
		if (rows.length === 1) {
			const existing = readIntentRow(rows[0]);
			if (!exactPreparedMatch(existing, input)) {
				throw new Error("mutation onboarding replay differs from its exact prepared bytes or metadata");
			}
			return { kind: "replay", intent: existing };
		}
		db.prepare(`INSERT INTO mutation_onboarding_intents (
			job_key, format_version, state, tenant, project, repository, commit_sha, target_file,
			request_bytes, request_sha256, source_artifact_id, source_artifact_format, source_artifact_bytes,
			source_artifact_sha256, target_bytes, target_sha256, request_hash, changeset_hash, created_at_ms
		) VALUES (?, 1, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
			input.jobKey,
			input.tenant,
			input.project,
			input.repository,
			input.commit,
			input.targetFile,
			input.requestBytes,
			input.requestSha256,
			input.sourceArtifactId,
			input.sourceArtifactFormat,
			input.sourceArtifactBytes,
			input.sourceArtifactSha256,
			input.targetBytes,
			input.targetSha256,
			input.requestHash,
			input.changesetHash,
			input.createdAtMs,
		);
		const persisted = db.prepare("SELECT * FROM mutation_onboarding_intents WHERE job_key = ?")
			.get(input.jobKey);
		return { kind: "prepared", intent: readIntentRow(persisted) };
	});
}

function insertActivatedJob(db: SqliteDatabase, enqueue: EnqueueMutationJob): void {
	db.prepare(`INSERT INTO mutation_jobs (
		job_id, remote_job_id, acceptance_receipt_hash, status,
		expected_job_json, expected_admission_json, target_bytes,
		target_sha256, baseline_intent, created_at_ms, updated_at_ms, next_attempt_at_ms,
		authority_tenant, authority_project, authority_repository
	) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, 'adopt_current', ?, ?, ?, ?, ?, ?)`).run(
		enqueue.jobId,
		enqueue.remoteJobId,
		enqueue.acceptanceReceiptHash,
		stableJson(enqueue.expectedJob),
		stableJson(enqueue.expectedAdmission),
		enqueue.targetBytes,
		enqueue.targetSha256,
		enqueue.createdAtMs,
		enqueue.createdAtMs,
		enqueue.createdAtMs,
		enqueue.expectedJob.tenant,
		enqueue.expectedJob.project,
		enqueue.expectedJob.repository,
	);
}

function recordOnboardingAcceptance(
	db: SqliteDatabase,
	intent: MutationOnboardingIntent,
	acceptanceReceiptHash: string,
): ActivateMutationOnboardingOutcome {
	if (intent.state !== "prepared") {
		if (intent.acceptanceReceiptHash !== acceptanceReceiptHash) {
			throw new Error("mutation onboarding acceptance replay differs from its authenticated receipt");
		}
		return { kind: "replay", jobId: intent.jobKey, state: intent.state };
	}
	const accepted = db.prepare(`UPDATE mutation_onboarding_intents
		SET state = 'accepted', acceptance_receipt_hash = ?
		WHERE job_key = ? AND state = 'prepared'`).run(acceptanceReceiptHash, intent.jobKey);
	if (changes(accepted) !== 1) throw new Error("mutation onboarding acceptance lost its prepared intent");
	return { kind: "accepted", jobId: intent.jobKey };
}

function activateAcceptedOnboarding(args: {
	db: SqliteDatabase;
	intent: MutationOnboardingIntent;
	activatedAtMs: number;
	fault: (point: JournalFaultPoint) => void;
}): ActivateMutationOnboardingOutcome {
	const { db, intent } = args;
	if (intent.state === "prepared" || intent.acceptanceReceiptHash === null) {
		throw new Error("mutation onboarding cannot activate before authenticated acceptance is durable");
	}
	const enqueue = enqueueFor(intent, intent.acceptanceReceiptHash);
	if (intent.state === "activated") {
		if (intent.activatedAtMs !== args.activatedAtMs) {
			throw new Error("mutation onboarding activation replay differs from its committed metadata");
		}
		assertStoredJob(db, enqueue);
		return { kind: "replay", jobId: intent.jobKey, state: "activated" };
	}
	if (db.prepare("SELECT job_id FROM mutation_jobs WHERE job_id = ?").get(intent.jobKey) !== undefined) {
		throw new Error("accepted mutation onboarding intent unexpectedly has a claimable job");
	}
	insertActivatedJob(db, enqueue);
	args.fault("inside_onboarding_activation");
	const updated = db.prepare(
		"UPDATE mutation_onboarding_intents SET state = 'activated', activated_at_ms = ? WHERE job_key = ? AND state = 'accepted'",
	).run(args.activatedAtMs, intent.jobKey);
	if (changes(updated) !== 1) throw new Error("mutation onboarding activation lost its accepted intent");
	return { kind: "activated", jobId: intent.jobKey };
}

export function activateMutationOnboardingIntent(args: {
	db: SqliteDatabase;
	input: ActivateMutationOnboardingIntent;
	fault: (point: JournalFaultPoint) => void;
}): ActivateMutationOnboardingOutcome {
	requireString(args.input.jobKey, "jobKey");
	if (args.input.kind === "accept") requireHash(args.input.acceptanceReceiptHash, "acceptanceReceiptHash");
	else requireTimestamp(args.input.activatedAtMs, "activatedAtMs");
	return inTransaction(args.db, () => {
		const stored = args.db.prepare("SELECT * FROM mutation_onboarding_intents WHERE job_key = ?")
			.get(args.input.jobKey);
		const intent = readIntentRow(stored);
		if (args.input.kind === "accept") {
			return recordOnboardingAcceptance(args.db, intent, args.input.acceptanceReceiptHash);
		}
		return activateAcceptedOnboarding({
			db: args.db,
			intent,
			activatedAtMs: args.input.activatedAtMs,
			fault: args.fault,
		});
	});
}
