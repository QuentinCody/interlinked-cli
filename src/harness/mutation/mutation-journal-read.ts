// ===========================================
// Durable mutation journal — read projections
// ===========================================

import {
	asRow,
	nullableNumber,
	nullableString,
	numberField,
	parsedJson,
	stringField,
} from "./mutation-journal-codec.js";
import type { SqliteDatabase } from "./mutation-journal-driver.js";
import { readRetainedEvidence } from "./mutation-journal-evidence.js";
import type {
	ClaimedMutationJob,
	DeadLetteredMutationJob,
	JournalEvaluationView,
	JournalJobView,
} from "./mutation-journal-types.js";

const MAX_DEAD_LETTER_LIST = 100;

function jobStatus(value: string): JournalJobView["status"] {
	if (value === "pending" || value === "evaluated" || value === "acked" || value === "dead_letter") return value;
	throw new Error("mutation journal job has invalid status");
}

export function readCommittedResult(
	db: SqliteDatabase,
	jobId: string,
): NonNullable<ClaimedMutationJob["committedResult"]> {
	const row = asRow(
		db.prepare(`SELECT result_hash, evaluator_policy_version FROM mutation_evaluations
			WHERE job_id = ?`).get(jobId),
		"committed result",
	);
	return {
		resultHash: stringField(row, "result_hash"),
		evaluatorPolicyVersion: stringField(row, "evaluator_policy_version"),
	};
}

export function readJournalJob(db: SqliteDatabase, jobId: string): JournalJobView | null {
	const value = db.prepare("SELECT * FROM mutation_jobs WHERE job_id = ?").get(jobId);
	if (value === undefined) return null;
	const row = asRow(value, "job");
	const deadLetteredAtMs = nullableNumber(row, "dead_lettered_at_ms");
	return {
		jobId,
		status: deadLetteredAtMs === null
			? jobStatus(stringField(row, "status"))
			: "dead_letter",
		leaseOwner: nullableString(row, "lease_owner"),
		leaseToken: nullableString(row, "lease_token"),
		leaseExpiresAtMs: nullableNumber(row, "lease_expires_at_ms"),
		claimCount: numberField(row, "claim_count"),
		acceptanceReceiptHash: stringField(row, "acceptance_receipt_hash"),
		nextAttemptAtMs: numberField(row, "next_attempt_at_ms"),
		failureCount: numberField(row, "retry_failure_count"),
		lastError: nullableString(row, "last_error"),
		deadLetteredAtMs,
		deadLetterToken: nullableString(row, "dead_letter_token"),
	};
}

export function readDeadLetteredJobs(db: SqliteDatabase, limit: number): DeadLetteredMutationJob[] {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DEAD_LETTER_LIST) {
		throw new Error(`dead-letter list limit must be an integer from 1 through ${MAX_DEAD_LETTER_LIST}`);
	}
	return db.prepare(`SELECT job_id, status, retry_failure_count, last_error,
		dead_lettered_at_ms, dead_letter_token FROM mutation_jobs
		WHERE dead_lettered_at_ms IS NOT NULL
		ORDER BY dead_lettered_at_ms, job_id LIMIT ?`).all(limit).map((value) => {
		const row = asRow(value, "dead letter");
		const status = stringField(row, "status");
		if (status !== "pending" && status !== "evaluated") {
			throw new Error("mutation journal dead letter has invalid underlying status");
		}
		return {
			jobId: stringField(row, "job_id"),
			phase: status === "evaluated" ? "ack" : "poll",
			failureCount: numberField(row, "retry_failure_count"),
			lastError: stringField(row, "last_error"),
			deadLetteredAtMs: numberField(row, "dead_lettered_at_ms"),
			redriveToken: stringField(row, "dead_letter_token"),
		};
	});
}

export function readJournalEvaluation(db: SqliteDatabase, jobId: string): JournalEvaluationView | null {
	const found = db.prepare(`SELECT e.*, m.snapshot_json, m.base_version, m.committed_version,
			m.snapshot_sha256, r.receipt_json, l.run_row_json
		FROM mutation_evaluations e
		JOIN mutation_manifest_snapshots m USING (evaluation_id)
		JOIN mutation_receipts r USING (evaluation_id)
		JOIN mutation_run_rows l USING (evaluation_id)
		WHERE e.job_id = ?`).get(jobId);
	if (found === undefined) return null;
	const row = asRow(found, "evaluation");
	const evaluationId = numberField(row, "evaluation_id");
	const findingRows = db.prepare(`SELECT finding_id, payload_json
		FROM mutation_findings WHERE evaluation_id = ? ORDER BY finding_id`).all(evaluationId);
	return {
		jobId,
		acceptanceReceiptHash: stringField(row, "acceptance_receipt_hash"),
		resultHash: stringField(row, "result_hash"),
		authenticatedEvidenceHash: stringField(row, "authenticated_evidence_hash"),
		evaluatorPolicyVersion: stringField(row, "evaluator_policy_version"),
		evaluation: parsedJson(row.evaluation_json),
		decision: parsedJson(row.decision_json),
		manifestSnapshot: parsedJson(row.snapshot_json),
		manifestBaseVersion: numberField(row, "base_version"),
		manifestCommittedVersion: numberField(row, "committed_version"),
		manifestSnapshotHash: stringField(row, "snapshot_sha256"),
		receipt: parsedJson(row.receipt_json),
		runRow: parsedJson(row.run_row_json),
		findings: findingRows.map((item) => {
			const finding = asRow(item, "finding");
			return { findingId: stringField(finding, "finding_id"), payload: parsedJson(finding.payload_json) };
		}),
		retainedEvidence: readRetainedEvidence(db, evaluationId),
	};
}
