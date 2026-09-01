// ===========================================
// Durable mutation journal — values + validation
// ===========================================

import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./mutation-journal-driver.js";
import { checkSourceArtifactBinding } from "./protocol-v3/field-checks.js";
import { normalizeRetainedEvidence } from "./mutation-journal-retained.js";
import type {
	CommitMutationEvaluation,
	EnqueueMutationJob,
	JournalFinding,
	JournalRetainedEvidence,
	MutationBaselineIntent,
	MutationManifestAuthority,
	MutationJournalAck,
	RedriveDeadLetter,
	ReleaseMutationLease,
	RenewMutationLease,
	ScheduleMutationRetry,
	ScheduleMutationRetryOutcome,
} from "./mutation-journal-types.js";

export { normalizeRetainedEvidence } from "./mutation-journal-retained.js";

export type DbRow = Record<string, unknown>;

const SHA256_RE = /^[0-9a-f]{64}$/;

export const MUTATION_PENDING_POLL_DELAY_MS = 1_000;
export const MUTATION_RETRY_BASE_DELAY_MS = 1_000;
const MUTATION_RETRY_MAX_DELAY_MS = 60_000;
export const MUTATION_RETRY_MAX_FAILURES = 8;
const MUTATION_LAST_ERROR_MAX_CHARS = 2_048;

export interface MutationRetryPlan {
	readonly outcome: ScheduleMutationRetryOutcome;
	readonly nextAttemptAtMs: number;
	readonly failureCount: number;
	readonly lastError: string | null;
	readonly deadLetteredAtMs: number | null;
}

function retryTimestamp(nowMs: number, delayMs: number): number {
	const next = nowMs + delayMs;
	if (!Number.isSafeInteger(next)) throw new Error("mutation retry timestamp must be a safe integer");
	return next;
}

/** Pure persisted retry policy. A successful not-ready poll clears prior
 * failures; actual failures back off exponentially and dead-letter after the
 * bounded failure budget is exhausted. */
function mutationRetryPlan(
	input: ScheduleMutationRetry,
	previousFailureCount: number,
): MutationRetryPlan {
	requireTimestamp(input.nowMs, "nowMs");
	if (!Number.isSafeInteger(previousFailureCount) || previousFailureCount < 0) {
		throw new Error("mutation retry failure count is invalid");
	}
	if (input.kind === "pending") {
		const nextAttemptAtMs = retryTimestamp(input.nowMs, MUTATION_PENDING_POLL_DELAY_MS);
		return {
			outcome: { kind: "scheduled", nextAttemptAtMs, failureCount: 0 },
			nextAttemptAtMs,
			failureCount: 0,
			lastError: null,
			deadLetteredAtMs: null,
		};
	}
	requireString(input.error, "retry error");
	const failureCount = previousFailureCount + 1;
	const lastError = input.error.slice(0, MUTATION_LAST_ERROR_MAX_CHARS);
	if (failureCount >= MUTATION_RETRY_MAX_FAILURES) {
		return {
			outcome: { kind: "dead_letter", failureCount, lastError },
			nextAttemptAtMs: input.nowMs,
			failureCount,
			lastError,
			deadLetteredAtMs: input.nowMs,
		};
	}
	const exponentialDelay = MUTATION_RETRY_BASE_DELAY_MS * (2 ** (failureCount - 1));
	const delayMs = Math.min(exponentialDelay, MUTATION_RETRY_MAX_DELAY_MS);
	const nextAttemptAtMs = retryTimestamp(input.nowMs, delayMs);
	return {
		outcome: { kind: "scheduled", nextAttemptAtMs, failureCount },
		nextAttemptAtMs,
		failureCount,
		lastError,
		deadLetteredAtMs: null,
	};
}

export function scheduleMutationRetry(
	db: SqliteDatabase,
	input: ScheduleMutationRetry,
): ScheduleMutationRetryOutcome | null {
	requireString(input.jobId, "jobId");
	requireString(input.leaseToken, "leaseToken");
	return inTransaction(db, () => {
		const found = db.prepare(`SELECT status, lease_token, retry_failure_count,
			dead_lettered_at_ms FROM mutation_jobs WHERE job_id = ?`).get(input.jobId);
		if (found === undefined) return null;
		const row = asRow(found, "retry");
		if (row.status === "acked" || row.lease_token !== input.leaseToken || row.dead_lettered_at_ms !== null) {
			return null;
		}
		const plan = mutationRetryPlan(input, numberField(row, "retry_failure_count"));
		const deadLetterToken = plan.outcome.kind === "dead_letter" ? randomUUID() : null;
		const updated = db.prepare(`UPDATE mutation_jobs SET lease_owner = NULL,
			lease_token = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?,
			next_attempt_at_ms = ?, retry_failure_count = ?, last_error = ?, dead_lettered_at_ms = ?,
			dead_letter_token = ?
			WHERE job_id = ? AND lease_token = ? AND status != 'acked' AND dead_lettered_at_ms IS NULL`)
			.run(input.nowMs, plan.nextAttemptAtMs, plan.failureCount, plan.lastError,
				plan.deadLetteredAtMs, deadLetterToken, input.jobId, input.leaseToken);
		return changes(updated) === 1 ? plan.outcome : null;
	});
}

export function renewMutationLease(db: SqliteDatabase, input: RenewMutationLease): boolean {
	const expires = leaseExpiry(input.nowMs, input.leaseMs);
	const result = db.prepare(`UPDATE mutation_jobs SET lease_expires_at_ms = ?, updated_at_ms = ?
		WHERE job_id = ? AND lease_token = ? AND status != 'acked'
		  AND dead_lettered_at_ms IS NULL AND lease_expires_at_ms > ?`)
		.run(expires, input.nowMs, input.jobId, input.leaseToken, input.nowMs);
	return changes(result) === 1;
}

export function releaseMutationLease(db: SqliteDatabase, input: ReleaseMutationLease): boolean {
	requireTimestamp(input.nowMs, "nowMs");
	const result = db.prepare(`UPDATE mutation_jobs SET lease_owner = NULL, lease_token = NULL,
		lease_expires_at_ms = NULL, updated_at_ms = ?
		WHERE job_id = ? AND lease_token = ? AND status != 'acked'`)
		.run(input.nowMs, input.jobId, input.leaseToken);
	return changes(result) === 1;
}

export function redriveMutationDeadLetter(db: SqliteDatabase, input: RedriveDeadLetter): boolean {
	requireString(input.jobId, "jobId");
	requireString(input.redriveToken, "redriveToken");
	requireTimestamp(input.nowMs, "nowMs");
	const result = db.prepare(`UPDATE mutation_jobs SET dead_lettered_at_ms = NULL,
		dead_letter_token = NULL, retry_failure_count = 0, last_error = NULL,
		next_attempt_at_ms = ?, updated_at_ms = ?
		WHERE job_id = ? AND dead_lettered_at_ms IS NOT NULL
		  AND dead_letter_token = ? AND lease_token IS NULL`)
		.run(input.nowMs, input.nowMs, input.jobId, input.redriveToken);
	return changes(result) === 1;
}

function storedJobAuthority(row: DbRow): string {
	return stableJson({
		tenant: row.authority_tenant,
		project: row.authority_project,
		repository: row.authority_repository,
	});
}

export function assertSameEnqueue(
	row: DbRow,
	input: EnqueueMutationJob,
	expectedJob: string,
	expectedAdmission: string,
): void {
	const same =
		storedJobAuthority(row) === stableJson({
			tenant: input.expectedJob.tenant,
			project: input.expectedJob.project,
			repository: input.expectedJob.repository,
		}) &&
		stringField(row, "remote_job_id") === input.remoteJobId &&
		stringField(row, "acceptance_receipt_hash") === input.acceptanceReceiptHash &&
		stringField(row, "expected_job_json") === expectedJob &&
		stringField(row, "expected_admission_json") === expectedAdmission &&
		stringField(row, "target_sha256") === input.targetSha256 &&
		mutationBaselineIntentField(row, "baseline_intent") === input.baselineIntent &&
		Buffer.from(bytesField(row, "target_bytes")).equals(Buffer.from(input.targetBytes));
	if (!same) throw new Error(`mutation job "${input.jobId}" already exists with different immutable inputs`);
}

export function assertCommitLease(job: DbRow, input: CommitMutationEvaluation): void {
	if (stringField(job, "acceptance_receipt_hash") !== input.acceptanceReceiptHash) {
		throw new Error("evaluation acceptanceReceiptHash differs from the enqueued job");
	}
	assertJobAuthority(job, input.manifestAuthority);
	if (job.lease_token !== input.leaseToken) throw new Error("mutation job lease token is not current");
	const expires = nullableNumber(job, "lease_expires_at_ms");
	if (expires === null || expires <= input.nowMs) throw new Error("mutation job lease expired before commit");
}

export function assertJobAuthority(job: DbRow, authority: MutationManifestAuthority): void {
	validateManifestAuthority(authority);
	const expectedJob = asRow(parsedJson(stringField(job, "expected_job_json")), "expected job");
	const expectedJobAuthority = stableJson({
		tenant: stringField(expectedJob, "tenant"),
		project: stringField(expectedJob, "project"),
		repository: stringField(expectedJob, "repository"),
	});
	const storedAuthority = storedJobAuthority(job);
	const claimedAuthority = stableJson(authority);
	if (expectedJobAuthority !== claimedAuthority || storedAuthority !== claimedAuthority) {
		throw new Error("evaluation manifest authority differs from the enqueued job");
	}
}

export function ackIdentityMatches(row: DbRow, ack: MutationJournalAck): boolean {
	return row.acceptance_receipt_hash === ack.acceptanceReceiptHash &&
		row.result_hash === ack.resultHash &&
		row.evaluator_policy_version === ack.evaluatorPolicyVersion;
}

function assertJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
		return;
	}
	if (typeof value !== "object") throw new Error(`${path} contains a non-JSON value`);
	if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);
	const prototype: unknown = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${path} contains a non-plain object`);
	}
	ancestors.add(value);
	const entries = Array.isArray(value)
		? value.map((item, index) => [String(index), item] as const)
		: Object.entries(value);
	for (const [key, item] of entries) assertJsonValue(item, `${path}.${key}`, ancestors);
	ancestors.delete(value);
}

export function detached<T>(value: T, label: string): T {
	try {
		return structuredClone(value);
	} catch (error) {
		throw new Error(`${label} must be detached structured-clone data`, { cause: error });
	}
}

export function stableJson(value: unknown): string {
	const snapshot = detached(value, "journal value");
	assertJsonValue(snapshot, "journal value", new Set());
	const encoded = JSON.stringify(snapshot, (_key, item: unknown) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
		const source = item as Record<string, unknown>; // SAFETY: guarded object, non-array.
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) sorted[key] = source[key];
		return sorted;
	});
	if (encoded === undefined) throw new Error("mutation journal values must be JSON-serializable");
	return encoded;
}

export function stableJsonHash(encoded: string): string {
	return createHash("sha256").update(encoded).digest("hex");
}

export function parsedJson(text: unknown): unknown {
	if (typeof text !== "string") throw new Error("mutation journal row contains non-text JSON");
	try {
		return JSON.parse(text) as unknown; // SAFETY: caller receives unknown and narrows it.
	} catch (error) {
		throw new Error("mutation journal contains corrupt JSON", { cause: error });
	}
}

export function requireString(value: string, label: string): void {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must not be empty`);
}

export function requireHash(value: string, label: string): void {
	if (!SHA256_RE.test(value)) throw new Error(`${label} must be a lowercase 64-hex sha-256`);
}

export function requireTimestamp(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

export function validateManifestAuthority(authority: MutationManifestAuthority): void {
	for (const [label, value] of [
		["manifestAuthority.tenant", authority.tenant],
		["manifestAuthority.project", authority.project],
		["manifestAuthority.repository", authority.repository],
	] as const) requireString(value, label);
}

export function leaseExpiry(nowMs: number, leaseMs: number): number {
	requireTimestamp(nowMs, "nowMs");
	if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
		throw new Error("leaseMs must be a positive safe integer");
	}
	const expires = nowMs + leaseMs;
	if (!Number.isSafeInteger(expires)) throw new Error("lease expiry must be a safe integer");
	return expires;
}

export function changes(result: { changes: number | bigint }): number {
	return Number(result.changes);
}

export function asRow(value: unknown, context: string): DbRow {
	if (typeof value !== "object" || value === null) throw new Error(`mutation journal ${context} row is missing`);
	return value as DbRow; // SAFETY: guarded non-null database row object.
}

export function numberField(row: DbRow, key: string): number {
	const value = row[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new Error(`mutation journal row has invalid ${key}`);
	}
	return value;
}

export function stringField(row: DbRow, key: string): string {
	const value = row[key];
	if (typeof value !== "string") throw new Error(`mutation journal row has invalid ${key}`);
	return value;
}

export function nullableString(row: DbRow, key: string): string | null {
	const value = row[key];
	if (value === null) return null;
	return stringField(row, key);
}

export function nullableNumber(row: DbRow, key: string): number | null {
	const value = row[key];
	if (value === null) return null;
	return numberField(row, key);
}

export function mutationBaselineIntentField(row: DbRow, key: string): MutationBaselineIntent {
	const value = stringField(row, key);
	if (value !== "require_established" && value !== "adopt_current") {
		throw new Error(`mutation journal row has invalid ${key}`);
	}
	return value;
}

export function bytesField(row: DbRow, key: string): Uint8Array {
	const value = row[key];
	if (!(value instanceof Uint8Array)) throw new Error(`mutation journal row has invalid ${key}`);
	return Uint8Array.from(value);
}

export function inTransaction<T>(db: SqliteDatabase, work: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const value = work();
		db.exec("COMMIT");
		return value;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function validateEnqueue(input: EnqueueMutationJob): void {
	for (const [label, value] of [
		["jobId", input.jobId],
		["remoteJobId", input.remoteJobId],
		["expectedJob.tenant", input.expectedJob.tenant],
		["expectedJob.project", input.expectedJob.project],
		["expectedJob.repository", input.expectedJob.repository],
		["expectedJob.commit", input.expectedJob.commit],
		["expectedJob.target_file", input.expectedJob.target_file],
		["expectedJob.job_key", input.expectedJob.job_key],
	] as const) requireString(value, label);
	requireHash(input.acceptanceReceiptHash, "acceptanceReceiptHash");
	requireHash(input.targetSha256, "targetSha256");
	requireHash(input.expectedAdmission.request_hash, "expectedAdmission.request_hash");
	requireHash(input.expectedAdmission.changeset_hash, "expectedAdmission.changeset_hash");
	if (input.baselineIntent !== "require_established" && input.baselineIntent !== "adopt_current") {
		throw new Error("baselineIntent must be require_established or adopt_current");
	}
	const sourceArtifactFailure = checkSourceArtifactBinding(
		input.expectedAdmission.source_artifact,
		"expectedAdmission.source_artifact",
	);
	if (sourceArtifactFailure !== null) throw new Error(sourceArtifactFailure);
	requireTimestamp(input.createdAtMs, "createdAtMs");
	if (sha256(input.targetBytes) !== input.targetSha256) throw new Error("targetBytes do not match targetSha256");
	if (input.expectedJob.target_content_hash !== input.targetSha256) {
		throw new Error("expectedJob.target_content_hash does not match targetSha256");
	}
}

export function validateCommit(input: CommitMutationEvaluation): void {
	validateManifestAuthority(input.manifestAuthority);
	for (const [label, value] of [
		["jobId", input.jobId],
		["leaseToken", input.leaseToken],
		["evaluatorPolicyVersion", input.evaluatorPolicyVersion],
	] as const) requireString(value, label);
	for (const [label, value] of [
		["acceptanceReceiptHash", input.acceptanceReceiptHash],
		["resultHash", input.resultHash],
		["authenticatedEvidenceHash", input.authenticatedEvidenceHash],
	] as const) requireHash(value, label);
	requireTimestamp(input.nowMs, "nowMs");
	requireTimestamp(input.expectedManifestVersion, "expectedManifestVersion");
	const ids = new Set<string>();
	for (const finding of input.findings) {
		requireString(finding.findingId, "findingId");
		if (ids.has(finding.findingId)) throw new Error(`duplicate findingId "${finding.findingId}"`);
		ids.add(finding.findingId);
	}
}

export function mintAck(input: {
	jobId: string;
	leaseToken: string;
	acceptanceReceiptHash: string;
	resultHash: string;
	evaluatorPolicyVersion: string;
}): MutationJournalAck {
	// SAFETY: callers invoke this only after a committed row is read/written;
	// this is the sole mint site of the compile-time journal-before-ack brand.
	return Object.freeze({ ...input }) as MutationJournalAck;
}

export interface EncodedEvaluation {
	evaluation: string;
	decision: string;
	manifest: string;
	manifestHash: string;
	receipt: string;
	runRow: string;
	findings: Array<JournalFinding & { encoded: string }>;
	retainedEvidence: JournalRetainedEvidence;
}

export function encodeEvaluation(input: CommitMutationEvaluation): EncodedEvaluation {
	const manifest = stableJson(input.manifestSnapshot);
	return {
		evaluation: stableJson(input.evaluation),
		decision: stableJson(input.decision),
		manifest,
		manifestHash: stableJsonHash(manifest),
		receipt: stableJson(input.receipt),
		runRow: stableJson(input.runRow),
		retainedEvidence: normalizeRetainedEvidence(input.retainedEvidence),
		findings: [...input.findings]
			.sort((a, b) => a.findingId.localeCompare(b.findingId))
			.map((finding) => ({ ...finding, encoded: stableJson(finding.payload) })),
	};
}
