// SQLite transactions and leases for the explicit mutation-cloud runtime.
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import {
	ackIdentityMatches,
	assertJobAuthority,
	assertCommitLease,
	assertSameEnqueue,
	asRow,
	bytesField,
	changes,
	detached,
	encodeEvaluation,
	type EncodedEvaluation,
	inTransaction,
	leaseExpiry,
	mintAck,
	mutationBaselineIntentField,
	numberField,
	parsedJson,
	redriveMutationDeadLetter,
	releaseMutationLease,
	requireString,
	requireTimestamp,
	renewMutationLease,
	scheduleMutationRetry,
	stableJson,
	stringField,
	type DbRow,
	validateCommit,
	validateEnqueue,
	validateManifestAuthority,
} from "./mutation-journal-codec.js";
import { openNodeSqlite, type SqliteDatabase } from "./mutation-journal-driver.js";
import { insertRetainedEvidence, retainedEvidenceMatches } from "./mutation-journal-evidence.js";
import { importLegacyMutationRow } from "./mutation-journal-legacy.js";
import {
	activateMutationOnboardingIntent,
	getMutationOnboardingIntent,
	prepareMutationOnboardingIntent,
} from "./mutation-journal-onboarding.js";
import {
	advanceManifestHead,
	initializeManifestHead as initializeManifestHeadRow,
	readManifestHead,
} from "./mutation-journal-manifest.js";
import { readCommittedResult, readDeadLetteredJobs, readJournalEvaluation, readJournalJob } from "./mutation-journal-read.js";
import {
	acknowledgeMutationOutbox,
	claimMutationOutbox,
	releaseMutationOutbox,
	renewMutationOutbox,
} from "./mutation-journal-outbox.js";
import { migrateMutationJournal } from "./mutation-journal-schema.js";
import { secureMutationStateFilePath } from "./mutation-local-state.js";
import type {
	ClaimedMutationJob,
	ClaimedOutboxEntry,
	ClaimMutationJob,
	ClaimMutationJobById,
	CommitEvaluationOutcome,
	CommitMutationEvaluation,
	DeadLetteredMutationJob,
	EnqueueMutationJob,
	InitializeManifestHeadOutcome,
	InitializeMutationManifestHead,
	JournalEvaluationView,
	JournalJobView,
	JournalManifestHead,
	LegacyMutationImport,
	ActivateMutationOnboardingIntent,
	MutationOnboardingBinding,
	MutationJournal,
	MutationJournalAck,
	MutationJournalOptions,
	MutationManifestAuthority,
	OutboxLeaseRef,
	RedriveDeadLetter,
	ReleaseMutationLease,
	RenewMutationLease,
	RenewOutboxLease,
	ScheduleMutationRetry,
	ScheduleMutationRetryOutcome,
	PrepareMutationOnboardingIntent,
} from "./mutation-journal-types.js";

const MUTATION_JOURNAL_RELATIVE_PATH = join(".interlinked", "mutation-journal.sqlite");

export function mutationJournalPath(root: string): string {
	return join(root, MUTATION_JOURNAL_RELATIVE_PATH);
}

class SqliteMutationJournal implements MutationJournal {
	readonly path: string;
	readonly #db: SqliteDatabase;
	readonly #fault: NonNullable<MutationJournalOptions["faultInjector"]>;

	constructor(root: string, options: MutationJournalOptions = {}) {
		this.path = secureMutationStateFilePath(root, "mutation-journal.sqlite");
		this.#db = openNodeSqlite(this.path);
		this.#fault = options.faultInjector ?? (() => {});
		try {
			// The journal contains exact source bytes plus authenticated decisions.
			// It is local runtime state, not a shareable database; make the privacy
			// boundary independent of the caller's umask.
			chmodSync(this.path, 0o600);
			migrateMutationJournal(this.#db);
		} catch (error) {
			this.#db.close();
			throw error;
		}
	}

	enqueue(input: EnqueueMutationJob): "inserted" | "existing" {
		const snapshot = detached(input, "mutation job");
		validateEnqueue(snapshot);
		const expectedJob = stableJson(snapshot.expectedJob);
		const expectedAdmission = stableJson(snapshot.expectedAdmission);
		return inTransaction(this.#db, () => {
			const existing = this.#db.prepare("SELECT * FROM mutation_jobs WHERE job_id = ?").get(snapshot.jobId);
			if (existing !== undefined) {
				assertSameEnqueue(asRow(existing, "job"), snapshot, expectedJob, expectedAdmission);
				return "existing";
			}
			this.#db.prepare(`INSERT INTO mutation_jobs (
                job_id, remote_job_id, acceptance_receipt_hash, status,
                expected_job_json, expected_admission_json, target_bytes,
                target_sha256, baseline_intent, created_at_ms, updated_at_ms, next_attempt_at_ms,
				authority_tenant, authority_project, authority_repository
            ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(
					snapshot.jobId,
					snapshot.remoteJobId,
					snapshot.acceptanceReceiptHash,
					expectedJob,
					expectedAdmission,
					Uint8Array.from(snapshot.targetBytes),
					snapshot.targetSha256,
					snapshot.baselineIntent,
					snapshot.createdAtMs,
					snapshot.createdAtMs,
					snapshot.createdAtMs,
					snapshot.expectedJob.tenant,
					snapshot.expectedJob.project,
					snapshot.expectedJob.repository,
				);
			return "inserted";
		});
	}

	getOnboardingIntent(input: MutationOnboardingBinding) {
		return getMutationOnboardingIntent(this.#db, input);
	}

	prepareOnboardingIntent(input: PrepareMutationOnboardingIntent) {
		return prepareMutationOnboardingIntent(this.#db, input);
	}

	activateOnboardingIntent(input: ActivateMutationOnboardingIntent) {
		return activateMutationOnboardingIntent({ db: this.#db, input, fault: this.#fault });
	}

	claimNext(input: ClaimMutationJob): ClaimedMutationJob | null {
		requireString(input.owner, "owner");
		validateManifestAuthority(input.authority);
		const expires = leaseExpiry(input.nowMs, input.leaseMs);
		return inTransaction(this.#db, () => {
			const found = this.#db.prepare(`SELECT * FROM mutation_jobs
				WHERE status IN ('pending', 'evaluated')
				  AND authority_tenant = ? AND authority_project = ? AND authority_repository = ?
				  AND dead_lettered_at_ms IS NULL AND next_attempt_at_ms <= ?
                  AND (lease_token IS NULL OR lease_expires_at_ms <= ?)
				ORDER BY CASE status WHEN 'evaluated' THEN 0 ELSE 1 END, created_at_ms, job_id
				LIMIT 1`).get(
				input.authority.tenant,
				input.authority.project,
				input.authority.repository,
				input.nowMs,
				input.nowMs,
			);
			if (found === undefined) return null;
			return this.#claimRow(asRow(found, "claim"), input, expires);
		});
	}

	claimJob(input: ClaimMutationJobById): ClaimedMutationJob | null {
		requireString(input.owner, "owner");
		requireString(input.jobId, "jobId");
		validateManifestAuthority(input.authority);
		const expires = leaseExpiry(input.nowMs, input.leaseMs);
		return inTransaction(this.#db, () => {
			const found = this.#db.prepare(`SELECT * FROM mutation_jobs
				WHERE job_id = ? AND status IN ('pending', 'evaluated')
				  AND authority_tenant = ? AND authority_project = ? AND authority_repository = ?
				  AND dead_lettered_at_ms IS NULL AND next_attempt_at_ms <= ?
				  AND (lease_token IS NULL OR lease_expires_at_ms <= ?)`)
				.get(
					input.jobId,
					input.authority.tenant,
					input.authority.project,
					input.authority.repository,
					input.nowMs,
					input.nowMs,
				);
			return found === undefined ? null : this.#claimRow(asRow(found, "claim"), input, expires);
		});
	}

	renew(input: RenewMutationLease): boolean {
		return renewMutationLease(this.#db, input);
	}

	scheduleRetry(input: ScheduleMutationRetry): ScheduleMutationRetryOutcome | null {
		return scheduleMutationRetry(this.#db, input);
	}

	release(input: ReleaseMutationLease): boolean {
		return releaseMutationLease(this.#db, input);
	}

	initializeManifestHead(input: InitializeMutationManifestHead): InitializeManifestHeadOutcome {
		return initializeManifestHeadRow(this.#db, detached(input, "mutation manifest seed"));
	}

	getManifestHead(authority: MutationManifestAuthority): JournalManifestHead | null {
		return readManifestHead(this.#db, authority);
	}

	commitEvaluation(input: CommitMutationEvaluation): CommitEvaluationOutcome {
		const snapshot = detached(input, "mutation evaluation");
		validateCommit(snapshot);
		const encoded = encodeEvaluation(snapshot);
		this.#fault("before_transaction");
		const outcome = inTransaction(this.#db, () => this.#commitInside(snapshot, encoded));
		this.#fault("after_commit");
		return outcome;
	}

	acknowledge(ack: MutationJournalAck, acknowledgedAtMs: number): boolean {
		requireTimestamp(acknowledgedAtMs, "acknowledgedAtMs");
		return inTransaction(this.#db, () => {
			const row = this.#db.prepare(`SELECT j.status, j.lease_token, e.acceptance_receipt_hash,
                    e.result_hash, e.evaluator_policy_version
                FROM mutation_jobs j JOIN mutation_evaluations e ON e.job_id = j.job_id
                WHERE j.job_id = ?`).get(ack.jobId);
			if (row === undefined) return false;
			const record = asRow(row, "ack");
			if (!ackIdentityMatches(record, ack)) return false;
			if (record.status === "acked") return true;
			if (record.status !== "evaluated" || record.lease_token !== ack.leaseToken) return false;
			const result = this.#db.prepare(`UPDATE mutation_jobs SET status = 'acked',
                    acknowledged_at_ms = ?, updated_at_ms = ?, lease_owner = NULL,
                    lease_token = NULL, lease_expires_at_ms = NULL
                WHERE job_id = ? AND status = 'evaluated' AND lease_token = ?`)
				.run(acknowledgedAtMs, acknowledgedAtMs, ack.jobId, ack.leaseToken);
			return changes(result) === 1;
		});
	}

	getJob(jobId: string): JournalJobView | null {
		return readJournalJob(this.#db, jobId);
	}

	listDeadLetters(limit: number): DeadLetteredMutationJob[] {
		return readDeadLetteredJobs(this.#db, limit);
	}

	redriveDeadLetter(input: RedriveDeadLetter): boolean {
		return redriveMutationDeadLetter(this.#db, input);
	}

	getEvaluation(jobId: string): JournalEvaluationView | null {
		return readJournalEvaluation(this.#db, jobId);
	}

	claimOutbox(owner: string, nowMs: number, leaseMs: number): ClaimedOutboxEntry | null {
		return claimMutationOutbox(this.#db, owner, nowMs, leaseMs);
	}

	renewOutbox(input: RenewOutboxLease): boolean {
		return renewMutationOutbox(this.#db, input);
	}

	releaseOutbox(input: OutboxLeaseRef): boolean {
		return releaseMutationOutbox(this.#db, input);
	}

	acknowledgeOutbox(input: OutboxLeaseRef): boolean {
		return acknowledgeMutationOutbox(this.#db, input);
	}

	importLegacy(input: LegacyMutationImport): "inserted" | "existing" {
		return importLegacyMutationRow(this.#db, input);
	}

	close(): void {
		this.#db.close();
	}

	#claimRow(row: DbRow, input: ClaimMutationJob, expires: number): ClaimedMutationJob {
		assertJobAuthority(row, input.authority);
		const jobId = stringField(row, "job_id");
		const token = randomUUID();
		this.#db.prepare(`UPDATE mutation_jobs
			SET lease_owner = ?, lease_token = ?, lease_expires_at_ms = ?,
				claim_count = claim_count + 1, updated_at_ms = ?
			WHERE job_id = ?`).run(input.owner, token, expires, input.nowMs, jobId);
		return this.#claimed(row, token, expires);
	}

	#claimed(row: DbRow, token: string, expires: number): ClaimedMutationJob {
		const jobId = stringField(row, "job_id");
		const status = stringField(row, "status");
		// SAFETY: these JSON fields were written only by enqueue after
		// validateEnqueue checked the complete expected-job/admission types;
		// the database schema makes both non-null and immutable thereafter.
		const expectedJob = parsedJson(row.expected_job_json) as ClaimedMutationJob["expectedJob"];
		const expectedAdmission = parsedJson(
			row.expected_admission_json,
		) as ClaimedMutationJob["expectedAdmission"];
		const base: ClaimedMutationJob = {
			jobId,
			remoteJobId: stringField(row, "remote_job_id"),
			acceptanceReceiptHash: stringField(row, "acceptance_receipt_hash"),
			expectedJob,
			expectedAdmission,
			targetBytes: bytesField(row, "target_bytes"),
			targetSha256: stringField(row, "target_sha256"),
			baselineIntent: mutationBaselineIntentField(row, "baseline_intent"),
			createdAtMs: numberField(row, "created_at_ms"),
			phase: status === "evaluated" ? "ack" : "poll",
			leaseToken: token,
			leaseExpiresAtMs: expires,
			claimCount: numberField(row, "claim_count") + 1,
		};
		if (status === "evaluated") {
			base.committedResult = readCommittedResult(this.#db, jobId);
			base.ack = mintAck({
				jobId,
				leaseToken: token,
				acceptanceReceiptHash: base.acceptanceReceiptHash,
				resultHash: base.committedResult.resultHash,
				evaluatorPolicyVersion: base.committedResult.evaluatorPolicyVersion,
			});
		}
		return base;
	}

	#commitInside(input: CommitMutationEvaluation, encoded: EncodedEvaluation): CommitEvaluationOutcome {
		const job = asRow(
			this.#db.prepare("SELECT * FROM mutation_jobs WHERE job_id = ?").get(input.jobId),
			"job",
		);
		assertCommitLease(job, input);
		if (job.status === "evaluated") return this.#replayedEvaluation(input, encoded);
		if (job.status !== "pending") throw new Error(`mutation job "${input.jobId}" is already acknowledged`);
		const committedManifestVersion = advanceManifestHead({
			db: this.#db,
			authority: input.manifestAuthority,
			expectedVersion: input.expectedManifestVersion,
			snapshotJson: encoded.manifest,
			snapshotHash: encoded.manifestHash,
			updatedAtMs: input.nowMs,
		});
		this.#fault("after_manifest_head_update");
		const inserted = this.#db.prepare(`INSERT INTO mutation_evaluations (
            job_id, acceptance_receipt_hash, result_hash, authenticated_evidence_hash,
            evaluator_policy_version, evaluation_json, decision_json, committed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				input.jobId,
				input.acceptanceReceiptHash,
				input.resultHash,
				input.authenticatedEvidenceHash,
				input.evaluatorPolicyVersion,
				encoded.evaluation,
				encoded.decision,
				input.nowMs,
			);
		const evaluationId = Number(inserted.lastInsertRowid);
		this.#insertArtifacts(evaluationId, input, encoded, committedManifestVersion);
		this.#db.prepare(`UPDATE mutation_jobs SET status = 'evaluated', updated_at_ms = ?,
			next_attempt_at_ms = ?, retry_failure_count = 0, last_error = NULL
			WHERE job_id = ?`)
			.run(input.nowMs, input.nowMs, input.jobId);
		this.#fault("inside_transaction");
		return { kind: "committed", ack: mintAck(input) };
	}

	#insertArtifacts(
		evaluationId: number,
		input: CommitMutationEvaluation,
		encoded: EncodedEvaluation,
		committedManifestVersion: number,
	): void {
		this.#db.prepare(`INSERT INTO mutation_manifest_snapshots
			(evaluation_id, snapshot_json, base_version, committed_version, snapshot_sha256)
			VALUES (?, ?, ?, ?, ?)`).run(
			evaluationId,
			encoded.manifest,
			input.expectedManifestVersion,
			committedManifestVersion,
			encoded.manifestHash,
		);
		this.#db.prepare("INSERT INTO mutation_receipts VALUES (?, ?)").run(evaluationId, encoded.receipt);
		this.#db.prepare("INSERT INTO mutation_run_rows VALUES (?, ?)").run(evaluationId, encoded.runRow);
		insertRetainedEvidence(this.#db, evaluationId, encoded.retainedEvidence);
		const findingStatement = this.#db.prepare(
			"INSERT INTO mutation_findings (evaluation_id, finding_id, payload_json) VALUES (?, ?, ?)",
		);
		const outboxStatement = this.#db.prepare(`INSERT INTO mutation_outbox
            (outbox_id, evaluation_id, topic, payload_json, state, created_at_ms)
            VALUES (?, ?, 'mutation.finding', ?, 'pending', ?)`);
		for (const finding of encoded.findings) {
			findingStatement.run(evaluationId, finding.findingId, finding.encoded);
			outboxStatement.run(`${evaluationId}:${finding.findingId}`, evaluationId, finding.encoded, input.nowMs);
		}
	}

	#replayedEvaluation(input: CommitMutationEvaluation, encoded: EncodedEvaluation): CommitEvaluationOutcome {
		const row = asRow(
			this.#db.prepare("SELECT * FROM mutation_evaluations WHERE job_id = ?").get(input.jobId),
			"evaluation",
		);
		const sameCore =
			stringField(row, "acceptance_receipt_hash") === input.acceptanceReceiptHash &&
			stringField(row, "result_hash") === input.resultHash &&
			stringField(row, "authenticated_evidence_hash") === input.authenticatedEvidenceHash &&
			stringField(row, "evaluator_policy_version") === input.evaluatorPolicyVersion &&
			stringField(row, "evaluation_json") === encoded.evaluation &&
			stringField(row, "decision_json") === encoded.decision;
		if (!sameCore || !this.#artifactsMatch(numberField(row, "evaluation_id"), input, encoded)) {
			throw new Error("evaluated mutation job replay differs from its committed decision or artifacts");
		}
		return { kind: "replay", ack: mintAck(input) };
	}

	#artifactsMatch(
		evaluationId: number,
		input: CommitMutationEvaluation,
		encoded: EncodedEvaluation,
	): boolean {
		const row = asRow(
			this.#db.prepare(`SELECT m.snapshot_json, m.base_version, m.committed_version,
					m.snapshot_sha256, r.receipt_json, l.run_row_json
                FROM mutation_manifest_snapshots m
                JOIN mutation_receipts r USING (evaluation_id)
                JOIN mutation_run_rows l USING (evaluation_id)
                WHERE m.evaluation_id = ?`).get(evaluationId),
			"evaluation artifacts",
		);
		if (
			row.snapshot_json !== encoded.manifest ||
			row.snapshot_sha256 !== encoded.manifestHash ||
			row.base_version !== input.expectedManifestVersion ||
			row.committed_version !== input.expectedManifestVersion + 1 ||
			row.receipt_json !== encoded.receipt ||
			row.run_row_json !== encoded.runRow
		) return false;
		if (!retainedEvidenceMatches(this.#db, evaluationId, encoded.retainedEvidence)) return false;
		const findings = this.#db.prepare(`SELECT finding_id, payload_json FROM mutation_findings
            WHERE evaluation_id = ? ORDER BY finding_id`).all(evaluationId);
		if (findings.length !== encoded.findings.length) return false;
		return findings.every((value, index) => {
			const actual = asRow(value, "finding");
			const expected = encoded.findings[index];
			return expected !== undefined &&
				actual.finding_id === expected.findingId && actual.payload_json === expected.encoded;
		});
	}

}

/** Open the repo-local real SQLite journal. */
export function openMutationJournal(root: string, options: MutationJournalOptions = {}): MutationJournal {
	return new SqliteMutationJournal(root, options);
}
