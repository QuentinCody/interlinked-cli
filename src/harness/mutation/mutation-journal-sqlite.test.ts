// ===========================================
// Durable mutation journal — real SQLite acceptance tests
// ===========================================

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "./protocol-v3/canonical.js";
import {
	MUTATION_PENDING_POLL_DELAY_MS,
	MUTATION_RETRY_MAX_FAILURES,
} from "./mutation-journal-codec.js";
import { openNodeSqlite } from "./mutation-journal-driver.js";
import {
	importLegacyMutationFiles,
	LEGACY_CAPTURE_MAX_FILE_BYTES,
} from "./mutation-journal-legacy.js";
import { MUTATION_JOURNAL_SCHEMA_VERSION } from "./mutation-journal-schema.js";
import { mutationJournalPath, openMutationJournal } from "./mutation-journal-sqlite.js";
import type {
	ClaimedMutationJob,
	CommitMutationEvaluation,
	EnqueueMutationJob,
	JournalFaultPoint,
	JournalRetainedCanonicalJson,
	JournalRetainedEvidence,
	MutationManifestAuthority,
	MutationJournal,
} from "./mutation-journal-types.js";

const ACCEPTANCE_HASH = "a".repeat(64);
const RESULT_HASH = "b".repeat(64);
const EVIDENCE_HASH = "c".repeat(64);
const AUTHORITY = Object.freeze({
	tenant: "tenant-1",
	project: "project-1",
	repository: "github.com/example/repo",
}) satisfies MutationManifestAuthority;
const FOREIGN_AUTHORITY = Object.freeze({
	tenant: "tenant-2",
	project: "project-2",
	repository: "github.com/foreign/repo",
}) satisfies MutationManifestAuthority;

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function retainedJson(value: unknown): JournalRetainedCanonicalJson {
	const encoded = canonicalJson(value);
	return { canonicalJson: encoded, sha256: digest(Buffer.from(encoded, "utf8")) };
}

function retainedEvidence(reportBytes = Uint8Array.from([0, 255, 128, 10, 13, 0])): JournalRetainedEvidence {
	return {
		formatVersion: 1,
		envelope: retainedJson({ kind: "mutation_result", result_hash: RESULT_HASH }),
		acceptanceReceipt: retainedJson({ payload: { kind: "acceptance" }, signature: "fixture" }),
		executionReceipt: retainedJson({ payload: { kind: "execution" }, signature: "fixture" }),
		terminalizationRecord: null,
		report: { bytes: Uint8Array.from(reportBytes), sha256: digest(reportBytes) },
	};
}

function job(jobId = "job-local-1", acceptanceReceiptHash = ACCEPTANCE_HASH): EnqueueMutationJob {
	const targetBytes = Buffer.from("export const answer = 42;\n", "utf8");
	const targetSha256 = digest(targetBytes);
	return {
		jobId,
		remoteJobId: `remote-${jobId}`,
		acceptanceReceiptHash,
		expectedJob: {
			tenant: "tenant-1",
			project: "project-1",
			repository: "github.com/example/repo",
			commit: "0123456789abcdef0123456789abcdef01234567",
			target_file: "src/answer.ts",
			target_content_hash: targetSha256,
			job_key: `key-${jobId}`,
		},
		expectedAdmission: {
			request_hash: "d".repeat(64),
			changeset_hash: "e".repeat(64),
			source_artifact: {
				format: "git-archive-tar-v1",
				artifact_id: "src_fixture_bundle_0001",
				sha256: "1".repeat(64),
				bytes: 128,
			},
		},
		targetBytes,
		targetSha256,
		baselineIntent: "require_established",
		createdAtMs: 100,
	};
}

function evaluation(claim: ClaimedMutationJob, expectedManifestVersion = 0): CommitMutationEvaluation {
	return {
		jobId: claim.jobId,
		leaseToken: claim.leaseToken,
		nowMs: 150,
		manifestAuthority: AUTHORITY,
		expectedManifestVersion,
		acceptanceReceiptHash: claim.acceptanceReceiptHash,
		resultHash: RESULT_HASH,
		authenticatedEvidenceHash: EVIDENCE_HASH,
		evaluatorPolicyVersion: "mutation-policy-v1",
		retainedEvidence: retainedEvidence(),
		evaluation: { completeness: "complete", survived: 0 },
		decision: { kind: "measured", decision: "allow" },
		manifestSnapshot: { version: 1, generation: 4, files: {} },
		receipt: { outcome: "measured_clean", result_hash: RESULT_HASH },
		runRow: { source: "background", mutants: 4, killed: 4, survived: 0 },
		findings: [{ findingId: "finding-1", payload: { severity: "medium", mutant_id: "m1" } }],
	};
}

function claimed(journal: MutationJournal, nowMs = 110): ClaimedMutationJob {
	if (journal.getManifestHead(AUTHORITY) === null) {
		journal.initializeManifestHead({
			authority: AUTHORITY,
			snapshot: { version: 1, generation: 0, files: {} },
			initializedAtMs: 90,
		});
	}
	const value = journal.claimNext({ authority: AUTHORITY, owner: "worker-a", nowMs, leaseMs: 1_000 });
	if (value === null) throw new Error("fixture job was not claimable");
	return value;
}

function deadLetterJob(active: MutationJournal, jobId: string, firstAttemptAtMs: number) {
	let dueAtMs = firstAttemptAtMs;
	for (let failure = 1; failure <= MUTATION_RETRY_MAX_FAILURES; failure += 1) {
		const lease = active.claimJob({
			jobId,
			authority: AUTHORITY,
			owner: "dead-letter-setup",
			nowMs: dueAtMs,
			leaseMs: 100,
		});
		if (lease === null) throw new Error(`job ${jobId} was not due for dead-letter failure ${failure}`);
		const outcome = active.scheduleRetry({
			jobId,
			leaseToken: lease.leaseToken,
			nowMs: dueAtMs,
			kind: "failure",
			error: `poll: poison-${failure}`,
		});
		if (outcome?.kind === "scheduled") dueAtMs = outcome.nextAttemptAtMs;
	}
	const found = active.listDeadLetters(100).find((item) => item.jobId === jobId);
	if (found === undefined) throw new Error(`job ${jobId} did not dead-letter`);
	return found;
}

let root = "";
let journal: MutationJournal | null = null;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-mutation-journal-"));
});

afterEach(() => {
	journal?.close();
	journal = null;
	rmSync(root, { recursive: true, force: true });
});

describe("SQLite mutation journal — enqueue and leases", () => {
	it("P0/N0: migrates a fresh database and refuses a future schema", () => {
		journal = openMutationJournal(root);
		journal.close();
		journal = null;
		const raw = openNodeSqlite(mutationJournalPath(root));
		// SAFETY: SQLite's PRAGMA user_version returns exactly one integer field.
		const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
		expect(version.user_version).toBe(MUTATION_JOURNAL_SCHEMA_VERSION);
		raw.exec(`PRAGMA user_version = ${MUTATION_JOURNAL_SCHEMA_VERSION + 1}`);
		raw.close();
		expect(() => openMutationJournal(root)).toThrow("newer than supported");
	});

	it("P0b: migrates an existing v2 journal to persisted retry scheduling", () => {
		journal = openMutationJournal(root);
		journal.enqueue(job());
		journal.close();
		journal = null;
		const raw = openNodeSqlite(mutationJournalPath(root));
		raw.exec(`
			DROP TABLE mutation_manifest_heads_v3;
			DROP TABLE mutation_onboarding_intents;
			DROP TABLE mutation_evidence_bundles;
			DROP INDEX mutation_jobs_claimable;
			ALTER TABLE mutation_jobs DROP COLUMN next_attempt_at_ms;
			ALTER TABLE mutation_jobs DROP COLUMN retry_failure_count;
			ALTER TABLE mutation_jobs DROP COLUMN last_error;
			ALTER TABLE mutation_jobs DROP COLUMN dead_lettered_at_ms;
			ALTER TABLE mutation_jobs DROP COLUMN dead_letter_token;
			ALTER TABLE mutation_jobs DROP COLUMN baseline_intent;
			PRAGMA user_version = 2;
		`);
		raw.close();

		journal = openMutationJournal(root);
		expect(journal.getJob("job-local-1")).toMatchObject({
			nextAttemptAtMs: 0,
			failureCount: 0,
			lastError: null,
			deadLetteredAtMs: null,
		});
		const migrated = journal.claimNext({ authority: AUTHORITY, owner: "migration-worker", nowMs: 0, leaseMs: 100 });
		expect(migrated).toMatchObject({ jobId: "job-local-1", baselineIntent: "require_established" });
	});

	it("P0d: v7 singleton state remains historical and is never attributed to a v3 authority", () => {
		journal = openMutationJournal(root);
		journal.close();
		journal = null;
		const legacySnapshot = '{"generation":41,"files":{"legacy":{}}}';
		const raw = openNodeSqlite(mutationJournalPath(root));
		raw.exec("DROP TABLE mutation_manifest_heads_v3");
		raw.prepare(`INSERT OR REPLACE INTO mutation_manifest_head
			(singleton, version, snapshot_json, snapshot_sha256, updated_at_ms)
			VALUES (1, 9, ?, ?, 100)`).run(
			legacySnapshot,
			digest(Buffer.from(legacySnapshot, "utf8")),
		);
		raw.exec("PRAGMA user_version = 7");
		raw.close();

		journal = openMutationJournal(root);
		expect(journal.getManifestHead(AUTHORITY)).toBeNull();
		expect(journal.getManifestHead(FOREIGN_AUTHORITY)).toBeNull();
		const migrated = openNodeSqlite(mutationJournalPath(root));
		// SAFETY: the compatibility table stores exactly one numeric version.
		const historical = migrated.prepare(
			"SELECT version FROM mutation_manifest_head WHERE singleton = 1",
		).get() as { version: number };
		expect(historical.version).toBe(9);
		migrated.close();
	});

	it("P0c/N0c: migrates v5 to the evidence table and rolls back a conflicting migration", () => {
		journal = openMutationJournal(root);
		journal.close();
		journal = null;
		const journalPath = mutationJournalPath(root);
		const v5 = openNodeSqlite(journalPath);
		v5.exec(`DROP TABLE mutation_manifest_heads_v3;
			DROP TABLE mutation_onboarding_intents;
			DROP TABLE mutation_evidence_bundles;
			PRAGMA user_version = 5;`);
		v5.close();

		journal = openMutationJournal(root);
		journal.close();
		journal = null;
		const migrated = openNodeSqlite(journalPath);
		// SAFETY: these SQLite projections each return exactly one scalar field.
		const migratedVersion = migrated.prepare("PRAGMA user_version").get() as { user_version: number };
		const evidenceTable = migrated.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mutation_evidence_bundles'",
		).get();
		expect(migratedVersion.user_version).toBe(MUTATION_JOURNAL_SCHEMA_VERSION);
		expect(evidenceTable).toMatchObject({ name: "mutation_evidence_bundles" });
		migrated.exec(`
			DROP TABLE mutation_manifest_heads_v3;
			DROP TABLE mutation_evidence_bundles;
			CREATE TABLE mutation_evidence_bundles (sentinel TEXT NOT NULL);
			PRAGMA user_version = 5;
		`);
		migrated.close();

		expect(() => openMutationJournal(root)).toThrow(/mutation_evidence_bundles already exists/);
		const rolledBack = openNodeSqlite(journalPath);
		// SAFETY: SQLite's PRAGMA user_version returns exactly one integer field.
		const rolledBackVersion = rolledBack.prepare("PRAGMA user_version").get() as { user_version: number };
		// SAFETY: PRAGMA table_info returns SQLite's documented name field.
		const columns = rolledBack.prepare("PRAGMA table_info(mutation_evidence_bundles)").all() as Array<{
			name: string;
		}>;
		expect(rolledBackVersion.user_version).toBe(5);
		expect(columns.map((column) => column.name)).toEqual(["sentinel"]);
		rolledBack.close();
	});

	it("P1: creates the repo-local database and stores detached immutable job inputs", () => {
		journal = openMutationJournal(root);
		const input = job();
		expect(journal.enqueue(input)).toBe("inserted");
		const journalPath = join(root, ".interlinked", "mutation-journal.sqlite");
		expect(existsSync(journalPath)).toBe(true);
		expect(statSync(journalPath).mode & 0o777).toBe(0o600);

		input.targetBytes.fill(0);
		input.expectedJob.project = "mutated-after-enqueue";
		input.expectedAdmission.request_hash = "f".repeat(64);
		input.expectedAdmission.source_artifact.artifact_id = "src_mutated_after_enqueue";
		const claim = claimed(journal);
		expect(Buffer.from(claim.targetBytes).toString("utf8")).toBe("export const answer = 42;\n");
		expect(claim.expectedJob.project).toBe("project-1");
		expect(claim.expectedAdmission.request_hash).toBe("d".repeat(64));
		expect(claim.expectedAdmission.source_artifact.artifact_id).toBe("src_fixture_bundle_0001");
		expect(claim.expectedJob.target_content_hash).toBe(claim.targetSha256);
		expect(claim.phase).toBe("poll");
	});

	it("N1: refuses a symlinked mutation-state directory", () => {
		const outside = mkdtempSync(join(tmpdir(), "mutation-journal-outside-"));
		try {
			symlinkSync(outside, join(root, ".interlinked"), "dir");
			expect(() => openMutationJournal(root)).toThrow(/must be a real directory/);
			expect(existsSync(join(outside, "mutation-journal.sqlite"))).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("N2: refuses a symlinked database without touching its target", () => {
		const outside = mkdtempSync(join(tmpdir(), "mutation-journal-target-"));
		const target = join(outside, "external.sqlite");
		const original = "external bytes stay private";
		try {
			mkdirSync(join(root, ".interlinked"));
			writeFileSync(target, original);
			symlinkSync(target, mutationJournalPath(root));
			expect(() => openMutationJournal(root)).toThrow(/must not be a symbolic link/);
			expect(readFileSync(target, "utf8")).toBe(original);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("P0e: exact authority fences both queue-order and keyed claims across restart", () => {
		journal = openMutationJournal(root);
		const local = job("job-authority-local");
		const foreign = job("job-authority-foreign");
		foreign.expectedJob = {
			...foreign.expectedJob,
			tenant: FOREIGN_AUTHORITY.tenant,
			project: FOREIGN_AUTHORITY.project,
			repository: FOREIGN_AUTHORITY.repository,
		};
		journal.enqueue(local);
		journal.enqueue(foreign);

		expect(journal.claimJob({
			jobId: local.jobId,
			authority: FOREIGN_AUTHORITY,
			owner: "foreign-keyed-worker",
			nowMs: 100,
			leaseMs: 100,
		})).toBeNull();
		const foreignClaim = journal.claimNext({
			authority: FOREIGN_AUTHORITY,
			owner: "foreign-worker",
			nowMs: 100,
			leaseMs: 100,
		});
		expect(foreignClaim?.jobId).toBe(foreign.jobId);
		if (foreignClaim === null) throw new Error("foreign fixture was not claimable");
		expect(journal.release({
			jobId: foreignClaim.jobId,
			leaseToken: foreignClaim.leaseToken,
			nowMs: 101,
		})).toBe(true);
		journal.close();
		journal = openMutationJournal(root);

		expect(journal.claimNext({
			authority: AUTHORITY,
			owner: "local-worker",
			nowMs: 102,
			leaseMs: 100,
		})?.jobId).toBe(local.jobId);
		expect(journal.claimNext({
			authority: FOREIGN_AUTHORITY,
			owner: "foreign-restart-worker",
			nowMs: 102,
			leaseMs: 100,
		})?.jobId).toBe(foreign.jobId);
	});

	it("P0f: v8 jobs are preserved but remain unbound and unclaimable", () => {
		journal = openMutationJournal(root);
		journal.enqueue(job("job-pre-v9"));
		journal.close();
		journal = null;
		const path = mutationJournalPath(root);
		const raw = openNodeSqlite(path);
		raw.exec(`DROP INDEX mutation_jobs_claimable;
			ALTER TABLE mutation_jobs DROP COLUMN authority_tenant;
			ALTER TABLE mutation_jobs DROP COLUMN authority_project;
			ALTER TABLE mutation_jobs DROP COLUMN authority_repository;
			PRAGMA user_version = 8;`);
		raw.close();

		journal = openMutationJournal(root);
		expect(journal.getJob("job-pre-v9")?.status).toBe("pending");
		expect(journal.claimNext({
			authority: AUTHORITY,
			owner: "local-worker",
			nowMs: 100,
			leaseMs: 100,
		})).toBeNull();
		expect(journal.claimNext({
			authority: FOREIGN_AUTHORITY,
			owner: "foreign-worker",
			nowMs: 100,
			leaseMs: 100,
		})).toBeNull();
		const migrated = openNodeSqlite(path);
		// SAFETY: this projection reads the three nullable v9 binding columns.
		const authority = migrated.prepare(`SELECT authority_tenant, authority_project,
			authority_repository FROM mutation_jobs WHERE job_id = 'job-pre-v9'`).get() as {
			authority_tenant: null;
			authority_project: null;
			authority_repository: null;
		};
		expect(authority).toEqual({
			authority_tenant: null,
			authority_project: null,
			authority_repository: null,
		});
		migrated.close();
	});

	it("N0e: a partial v9 authority schema rolls back without advancing or guessing attribution", () => {
		journal = openMutationJournal(root);
		journal.close();
		journal = null;
		const path = mutationJournalPath(root);
		const raw = openNodeSqlite(path);
		raw.exec(`DROP INDEX mutation_jobs_claimable;
			ALTER TABLE mutation_jobs DROP COLUMN authority_project;
			PRAGMA user_version = 8;`);
		raw.close();

		expect(() => openMutationJournal(root)).toThrow("mutation_jobs has incompatible v9 authority columns");
		const preserved = openNodeSqlite(path);
		// SAFETY: PRAGMA projections expose SQLite's integer version and column names.
		const version = preserved.prepare("PRAGMA user_version").get() as { user_version: number };
		// SAFETY: PRAGMA table_info returns the documented name field.
		const columns = preserved.prepare("PRAGMA table_info(mutation_jobs)").all() as Array<{ name: string }>;
		expect(version.user_version).toBe(8);
		expect(columns.map(({ name }) => name).filter((name) => name.startsWith("authority_")))
			.toEqual(["authority_tenant", "authority_repository"]);
		preserved.close();
	});

	it("P2/N1: identical enqueue replays preserve the first timestamp, while immutable drift rejects", () => {
		journal = openMutationJournal(root);
		expect(journal.enqueue(job())).toBe("inserted");
		expect(journal.enqueue(job())).toBe("existing");
		expect(journal.enqueue({ ...job(), createdAtMs: 999 })).toBe("existing");
		expect(claimed(journal, 1_000).createdAtMs).toBe(100);
		expect(() => journal?.enqueue({ ...job(), remoteJobId: "foreign" })).toThrow("different immutable inputs");
		expect(() => journal?.enqueue({
			...job(),
			expectedJob: { ...job().expectedJob, repository: "github.com/foreign/repo" },
		})).toThrow("different immutable inputs");
		expect(() => journal?.enqueue({
			...job(),
			expectedAdmission: { ...job().expectedAdmission, request_hash: "f".repeat(64) },
		})).toThrow("different immutable inputs");
		expect(() => journal?.enqueue({ ...job(), acceptanceReceiptHash: "f".repeat(64) }))
			.toThrow("different immutable inputs");
		expect(() => journal?.enqueue({ ...job(), baselineIntent: "adopt_current" }))
			.toThrow("different immutable inputs");
		const changedBytes = Buffer.from("export const answer = 43;\n", "utf8");
		const changedHash = digest(changedBytes);
		expect(() => journal?.enqueue({
			...job(),
			targetBytes: changedBytes,
			targetSha256: changedHash,
			expectedJob: { ...job().expectedJob, target_content_hash: changedHash },
		})).toThrow("different immutable inputs");
		const malformedArtifact = job("job-bad-artifact");
		malformedArtifact.expectedAdmission.source_artifact.bytes = 0;
		expect(() => journal?.enqueue(malformedArtifact)).toThrow(
			"expectedAdmission.source_artifact.bytes must be an integer from 1 through",
		);
	});

	it("P2b: adopt_current intent survives close/reopen and returns on the claimed job", () => {
		journal = openMutationJournal(root);
		journal.enqueue({ ...job("job-onboarding"), baselineIntent: "adopt_current" });
		journal.close();
		journal = openMutationJournal(root);
		expect(journal.claimJob({
			jobId: "job-onboarding",
			authority: AUTHORITY,
			owner: "onboarding-worker",
			nowMs: 100,
			leaseMs: 100,
		})?.baselineIntent).toBe("adopt_current");
	});

	it("P3: claim, renew, release, and expired reclaim use fencing tokens", () => {
		journal = openMutationJournal(root);
		expect(() =>
			journal?.claimNext({ authority: AUTHORITY, owner: "overflow", nowMs: Number.MAX_SAFE_INTEGER - 5, leaseMs: 10 }),
		).toThrow("lease expiry must be a safe integer");
		journal.enqueue(job());
		const first = claimed(journal, 110);
		expect(journal.claimNext({ authority: AUTHORITY, owner: "worker-b", nowMs: 120, leaseMs: 50 })).toBeNull();
		expect(journal.renew({ jobId: first.jobId, leaseToken: "wrong", nowMs: 120, leaseMs: 1_000 })).toBe(false);
		expect(journal.renew({ jobId: first.jobId, leaseToken: first.leaseToken, nowMs: 120, leaseMs: 1_000 })).toBe(true);
		expect(journal.release({ jobId: first.jobId, leaseToken: "wrong", nowMs: 130 })).toBe(false);
		expect(journal.release({ jobId: first.jobId, leaseToken: first.leaseToken, nowMs: 130 })).toBe(true);
		const second = journal.claimNext({ authority: AUTHORITY, owner: "worker-b", nowMs: 140, leaseMs: 20 });
		expect(second?.claimCount).toBe(2);
		const third = journal.claimNext({ authority: AUTHORITY, owner: "worker-c", nowMs: 161, leaseMs: 20 });
		expect(third?.claimCount).toBe(3);
		expect(third?.leaseToken).not.toBe(second?.leaseToken);
		if (second === null || third === null) throw new Error("lease fixture did not produce both claims");
		expect(journal.scheduleRetry({
			jobId: second.jobId,
			leaseToken: second.leaseToken,
			nowMs: 162,
			kind: "failure",
			error: "stale worker",
		})).toBeNull();
		expect(journal.getJob(third.jobId)?.leaseToken).toBe(third.leaseToken);
	});

	it("P4: persisted retry times let a later job run before the oldest retry", () => {
		journal = openMutationJournal(root);
		journal.enqueue(job("job-a"));
		journal.enqueue({ ...job("job-b"), createdAtMs: 101 });
		const first = claimed(journal, 110);
		const deferred = journal.scheduleRetry({
			jobId: first.jobId,
			leaseToken: first.leaseToken,
			nowMs: 120,
			kind: "failure",
			error: "remote unavailable",
		});
		expect(deferred).toEqual({ kind: "scheduled", nextAttemptAtMs: 1_120, failureCount: 1 });
		expect(journal.getJob("job-a")).toMatchObject({
			status: "pending",
			nextAttemptAtMs: 1_120,
			failureCount: 1,
			lastError: "remote unavailable",
		});

		const later = journal.claimNext({ authority: AUTHORITY, owner: "worker-b", nowMs: 121, leaseMs: 100 });
		expect(later?.jobId).toBe("job-b");
		if (later === null) throw new Error("later job was starved by the deferred retry");
		expect(journal.scheduleRetry({
			jobId: later.jobId,
			leaseToken: later.leaseToken,
			nowMs: 122,
			kind: "pending",
		})).toEqual({
			kind: "scheduled",
			nextAttemptAtMs: 122 + MUTATION_PENDING_POLL_DELAY_MS,
			failureCount: 0,
		});

		journal.close();
		journal = openMutationJournal(root);
		expect(journal.claimNext({ authority: AUTHORITY, owner: "restart", nowMs: 1_119, leaseMs: 100 })).toBeNull();
		const retried = journal.claimNext({ authority: AUTHORITY, owner: "restart", nowMs: 1_120, leaseMs: 100 });
		expect(retried?.jobId).toBe("job-a");
		if (retried === null) throw new Error("deferred job did not survive restart");
		expect(journal.scheduleRetry({
			jobId: retried.jobId,
			leaseToken: retried.leaseToken,
			nowMs: 1_121,
			kind: "pending",
		})).toMatchObject({ kind: "scheduled", failureCount: 0 });
		expect(journal.getJob("job-a")).toMatchObject({ failureCount: 0, lastError: null });
	});

	it("N2: consecutive failures dead-letter durably at the bounded retry limit", () => {
		journal = openMutationJournal(root);
		journal.enqueue(job());
		let dueAtMs = 100;
		const observedDelays: number[] = [];
		for (let failure = 1; failure <= MUTATION_RETRY_MAX_FAILURES; failure += 1) {
			const lease = journal.claimNext({ authority: AUTHORITY, owner: "poison-worker", nowMs: dueAtMs, leaseMs: 100 });
			if (lease === null) throw new Error(`poison fixture was not due for failure ${failure}`);
			const outcome = journal.scheduleRetry({
				jobId: lease.jobId,
				leaseToken: lease.leaseToken,
				nowMs: dueAtMs,
				kind: "failure",
				error: `poison-${failure}`,
			});
			if (outcome?.kind === "scheduled") {
				observedDelays.push(outcome.nextAttemptAtMs - dueAtMs);
				dueAtMs = outcome.nextAttemptAtMs;
			}
			if (failure === MUTATION_RETRY_MAX_FAILURES) {
				expect(outcome).toEqual({
					kind: "dead_letter",
					failureCount: MUTATION_RETRY_MAX_FAILURES,
					lastError: `poison-${MUTATION_RETRY_MAX_FAILURES}`,
				});
			}
		}
		expect(observedDelays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
		expect(journal.getJob("job-local-1")).toMatchObject({
			status: "dead_letter",
			failureCount: MUTATION_RETRY_MAX_FAILURES,
			lastError: `poison-${MUTATION_RETRY_MAX_FAILURES}`,
		});
		journal.close();
		journal = openMutationJournal(root);
		expect(journal.claimNext({ authority: AUTHORITY, owner: "restart", nowMs: Number.MAX_SAFE_INTEGER - 1, leaseMs: 1 })).toBeNull();
		expect(journal.getJob("job-local-1")?.status).toBe("dead_letter");
	});
});

describe("SQLite mutation journal — dead-letter operability", () => {
	it("lists dead letters in stable order and redrives only with the current fencing token", () => {
		journal = openMutationJournal(root);
		journal.enqueue(job("job-a"));
		journal.enqueue({ ...job("job-b"), createdAtMs: 101 });
		const first = deadLetterJob(journal, "job-a", 100);
		const second = deadLetterJob(journal, "job-b", 101);
		expect(first.phase).toBe("poll");
		expect(second.phase).toBe("poll");

		journal.close();
		journal = openMutationJournal(root);
		expect(journal.listDeadLetters(1).map((item) => item.jobId)).toEqual(["job-a"]);
		expect(journal.listDeadLetters(2).map((item) => item.jobId)).toEqual(["job-a", "job-b"]);
		expect(() => journal?.listDeadLetters(0)).toThrow("limit must be an integer from 1 through 100");
		expect(journal.redriveDeadLetter({
			jobId: first.jobId,
			redriveToken: "stale-token",
			nowMs: 200_000,
		})).toBe(false);
		expect(journal.getJob(first.jobId)?.status).toBe("dead_letter");
		expect(journal.redriveDeadLetter({
			jobId: first.jobId,
			redriveToken: first.redriveToken,
			nowMs: 200_000,
		})).toBe(true);
		expect(journal.getJob(first.jobId)).toMatchObject({
			status: "pending",
			nextAttemptAtMs: 200_000,
			failureCount: 0,
			lastError: null,
			deadLetteredAtMs: null,
			deadLetterToken: null,
		});
		expect(journal.redriveDeadLetter({
			jobId: first.jobId,
			redriveToken: first.redriveToken,
			nowMs: 200_001,
		})).toBe(false);
		expect(journal.claimJob({
			jobId: first.jobId,
			authority: AUTHORITY,
			owner: "redrive-worker",
			nowMs: 200_000,
			leaseMs: 100,
		})?.phase).toBe("poll");
	});

	it("retains an evaluated row across dead-letter, restart, and token-fenced redrive", () => {
		journal = openMutationJournal(root);
		journal.enqueue(job("job-evaluated"));
		const initial = claimed(journal, 110);
		expect(journal.commitEvaluation(evaluation(initial)).kind).toBe("committed");
		expect(journal.release({
			jobId: initial.jobId,
			leaseToken: initial.leaseToken,
			nowMs: 160,
		})).toBe(true);
		const dead = deadLetterJob(journal, initial.jobId, 160);
		expect(dead.phase).toBe("ack");

		journal.close();
		journal = openMutationJournal(root);
		const recovered = journal.listDeadLetters(1)[0];
		expect(recovered).toMatchObject({ jobId: initial.jobId, phase: "ack" });
		if (recovered === undefined) throw new Error("evaluated dead letter did not survive restart");
		expect(journal.redriveDeadLetter({
			jobId: recovered.jobId,
			redriveToken: recovered.redriveToken,
			nowMs: 300_000,
		})).toBe(true);
		const redriven = journal.claimJob({
			jobId: recovered.jobId,
			authority: AUTHORITY,
			owner: "ack-redrive-worker",
			nowMs: 300_000,
			leaseMs: 100,
		});
		expect(redriven?.phase).toBe("ack");
		expect(redriven?.ack).toBeDefined();
		expect(journal.getEvaluation(recovered.jobId)?.resultHash).toBe(RESULT_HASH);
	});

	it("backfills a fencing token when migrating an existing v3 dead letter", () => {
		journal = openMutationJournal(root);
		journal.enqueue(job());
		deadLetterJob(journal, "job-local-1", 100);
		journal.close();
		journal = null;
		const raw = openNodeSqlite(mutationJournalPath(root));
		raw.exec(`DROP TABLE mutation_manifest_heads_v3;
			DROP TABLE mutation_onboarding_intents;
			DROP TABLE mutation_evidence_bundles;
			ALTER TABLE mutation_jobs DROP COLUMN dead_letter_token;
			ALTER TABLE mutation_jobs DROP COLUMN baseline_intent;
			PRAGMA user_version = 3;`);
		raw.close();

		journal = openMutationJournal(root);
		const migrated = journal.listDeadLetters(1)[0];
		expect(migrated?.redriveToken).toMatch(/^[0-9a-f]{32}$/);
		if (migrated === undefined) throw new Error("v3 dead letter was not migrated");
		expect(journal.redriveDeadLetter({
			jobId: migrated.jobId,
			redriveToken: migrated.redriveToken,
			nowMs: 400_000,
		})).toBe(true);
	});
});

describe("SQLite mutation journal — atomic evaluation and journal-before-ack", () => {
	it("P4: commits decision, evidence, manifest, receipt, run row, finding and outbox in one transaction", () => {
		journal = openMutationJournal(root);
		journal.enqueue(job());
		const claim = claimed(journal);
		const input = evaluation(claim);
		const committed = journal.commitEvaluation(input);
		input.decision = { kind: "mutated-after-commit", decision: "block" };
		input.manifestSnapshot = { generation: 999 };
		expect(committed.kind).toBe("committed");
		expect(journal.getJob(claim.jobId)?.status).toBe("evaluated");
		expect(journal.getEvaluation(claim.jobId)).toMatchObject({
			resultHash: RESULT_HASH,
			authenticatedEvidenceHash: EVIDENCE_HASH,
			manifestBaseVersion: 0,
			manifestCommittedVersion: 1,
			manifestSnapshotHash: journal.getManifestHead(AUTHORITY)?.hash,
			decision: { kind: "measured", decision: "allow" },
			manifestSnapshot: { version: 1, generation: 4, files: {} },
			receipt: { outcome: "measured_clean", result_hash: RESULT_HASH },
			findings: [{ findingId: "finding-1" }],
			retainedEvidence: {
				formatVersion: 1,
				report: { bytes: Uint8Array.from([0, 255, 128, 10, 13, 0]) },
			},
		});

		const outbox = journal.claimOutbox("delivery-a", 160, 100);
		expect(outbox).toMatchObject({ topic: "mutation.finding", attemptCount: 1 });
		expect(journal.claimOutbox("delivery-b", 170, 100)).toBeNull();
		if (outbox === null) throw new Error("finding was not put in the outbox");
		expect(journal.renewOutbox({ outboxId: outbox.outboxId, leaseToken: outbox.leaseToken, nowMs: 170, leaseMs: 100 })).toBe(true);
		expect(journal.releaseOutbox({ outboxId: outbox.outboxId, leaseToken: outbox.leaseToken, nowMs: 180 })).toBe(true);
		const reclaimed = journal.claimOutbox("delivery-b", 181, 100);
		if (reclaimed === null) throw new Error("released finding was not claimable");
		expect(reclaimed.attemptCount).toBe(2);
		expect(journal.acknowledgeOutbox({ outboxId: reclaimed.outboxId, leaseToken: reclaimed.leaseToken, nowMs: 190 })).toBe(true);
		expect(journal.acknowledgeOutbox({ outboxId: reclaimed.outboxId, leaseToken: reclaimed.leaseToken, nowMs: 191 })).toBe(true);
		expect(journal.claimOutbox("delivery-c", 200, 100)).toBeNull();

		expect(journal.acknowledge(committed.ack, 210)).toBe(true);
		expect(journal.acknowledge(committed.ack, 211)).toBe(true);
		expect(journal.getJob(claim.jobId)?.status).toBe("acked");
	});

	it("P5/N2: exact evaluation replay is idempotent; changed artifacts reject", () => {
		journal = openMutationJournal(root);
		journal.enqueue(job());
		const claim = claimed(journal);
		const input = evaluation(claim);
		expect(journal.commitEvaluation(input).kind).toBe("committed");
		expect(journal.getManifestHead(AUTHORITY)?.version).toBe(1);
		expect(journal.commitEvaluation(input).kind).toBe("replay");
		expect(journal.getManifestHead(AUTHORITY)?.version).toBe(1);
		expect(() =>
			journal?.commitEvaluation({ ...input, manifestSnapshot: { version: 1, generation: 999, files: {} } }),
		).toThrow("differs from its committed decision or artifacts");
		const changedEnvelope = retainedJson({ kind: "mutation_result", result_hash: "f".repeat(64) });
		expect(() => journal?.commitEvaluation({
			...input,
			retainedEvidence: { ...input.retainedEvidence, envelope: changedEnvelope },
		})).toThrow("differs from its committed decision or artifacts");
		const changedReportBytes = Uint8Array.from([0, 255, 128, 10, 13, 1]);
		expect(() => journal?.commitEvaluation({
			...input,
			retainedEvidence: {
				...input.retainedEvidence,
				report: { bytes: changedReportBytes, sha256: digest(changedReportBytes) },
			},
		})).toThrow("differs from its committed decision or artifacts");
	});

	it("P5b: exact evidence BLOBs and canonical metadata survive caller mutation and close/reopen", () => {
		journal = openMutationJournal(root);
		journal.enqueue(job());
		const claim = claimed(journal);
		const input = evaluation(claim);
		const original = Uint8Array.from(input.retainedEvidence.report?.bytes ?? []);
		journal.commitEvaluation(input);
		input.retainedEvidence.report?.bytes.fill(42);
		input.retainedEvidence.envelope.canonicalJson = "{}";
		journal.close();
		journal = openMutationJournal(root);

		const retained = journal.getEvaluation(claim.jobId)?.retainedEvidence;
		expect(retained?.envelope).toEqual(retainedEvidence().envelope);
		expect(retained?.report?.bytes).toEqual(original);
		expect(retained?.report?.sha256).toBe(digest(original));
	});

	it("N2b: storage tampering is detected when the retained evidence projection is read", () => {
		journal = openMutationJournal(root);
		journal.enqueue(job());
		const claim = claimed(journal);
		journal.commitEvaluation(evaluation(claim));
		journal.close();
		journal = null;
		const raw = openNodeSqlite(mutationJournalPath(root));
		raw.prepare("UPDATE mutation_evidence_bundles SET report_bytes = ? WHERE evaluation_id = 1")
			.run(Uint8Array.from([9, 8, 7]));
		raw.close();

		journal = openMutationJournal(root);
		expect(() => journal?.getEvaluation(claim.jobId)).toThrow(
			"retainedEvidence.report.bytes do not match their sha256",
		);
	});

	it("N3: two jobs evaluated from one head cannot commit divergent manifest floors", () => {
		journal = openMutationJournal(root);
		journal.initializeManifestHead({
			authority: AUTHORITY,
			snapshot: { generation: 0, files: {} },
			initializedAtMs: 90,
		});
		journal.enqueue(job("job-a"));
		journal.enqueue(job("job-b"));
		const first = claimed(journal, 110);
		const second = claimed(journal, 111);
		const firstInput = { ...evaluation(first, 0), manifestSnapshot: { generation: 1, files: { a: {} } }, findings: [] };
		const staleInput = {
			...evaluation(second, 0),
			resultHash: "f".repeat(64),
			manifestSnapshot: { generation: 1, files: { b: {} } },
			findings: [{ findingId: "must-rollback", payload: { mutant_id: "stale" } }],
		};

		expect(journal.commitEvaluation(firstInput).kind).toBe("committed");
		expect(() => journal?.commitEvaluation(staleInput)).toThrow(
			"stale mutation manifest head: expected version 0, current version 1",
		);
		expect(journal.getManifestHead(AUTHORITY)).toMatchObject({
			version: 1,
			snapshot: { generation: 1, files: { a: {} } },
		});
		expect(journal.getEvaluation(second.jobId)).toBeNull();
		expect(journal.getJob(second.jobId)?.status).toBe("pending");
		expect(journal.claimOutbox("delivery", 160, 100)).toBeNull();
	});

	it("N4: decision uniqueness rejects a second job for the same acceptance/result/policy tuple", () => {
		journal = openMutationJournal(root);
		journal.enqueue(job("job-a"));
		journal.enqueue(job("job-b"));
		const first = claimed(journal);
		journal.commitEvaluation(evaluation(first));
		const second = claimed(journal);
		expect(() => journal?.commitEvaluation(evaluation(second, 1))).toThrow(/UNIQUE constraint failed/);
		expect(journal.getEvaluation(second.jobId)).toBeNull();
		expect(journal.getManifestHead(AUTHORITY)?.version).toBe(1);
	});

	it("N4b: a claimed job cannot commit against another authority's manifest head", () => {
		journal = openMutationJournal(root);
		journal.initializeManifestHead({
			authority: AUTHORITY,
			snapshot: { version: 1, generation: 0, files: {} },
			initializedAtMs: 80,
		});
		journal.initializeManifestHead({
			authority: FOREIGN_AUTHORITY,
			snapshot: { version: 1, generation: 7, files: { foreign: {} } },
			initializedAtMs: 81,
		});
		journal.enqueue(job());
		const claim = claimed(journal);
		const foreignCommit = { ...evaluation(claim), manifestAuthority: FOREIGN_AUTHORITY };

		expect(() => journal?.commitEvaluation(foreignCommit)).toThrow(
			"evaluation manifest authority differs from the enqueued job",
		);
		expect(journal.getManifestHead(AUTHORITY)?.version).toBe(0);
		expect(journal.getManifestHead(FOREIGN_AUTHORITY)).toMatchObject({
			version: 0,
			snapshot: { version: 1, generation: 7, files: { foreign: {} } },
		});
		expect(journal.getEvaluation(claim.jobId)).toBeNull();
	});
});

describe("SQLite mutation journal — crash and restart recovery", () => {
	function openWithFault(point: JournalFaultPoint): {
		active: MutationJournal;
		claim: ClaimedMutationJob;
		input: CommitMutationEvaluation;
	} {
		const active = openMutationJournal(root, {
			faultInjector: (at) => {
				if (at === point) throw new Error(`crash:${point}`);
			},
		});
		journal = active;
		active.enqueue(job());
		const claim = claimed(active);
		return { active, claim, input: evaluation(claim) };
	}

	for (const point of ["before_transaction", "after_manifest_head_update", "inside_transaction"] as const) {
		it(`N5: ${point} leaves no partial evaluation artifacts or manifest advance`, () => {
			const { active, claim, input } = openWithFault(point);
			expect(() => active.commitEvaluation(input)).toThrow(`crash:${point}`);
			expect(active.getEvaluation(claim.jobId)).toBeNull();
			expect(active.getJob(claim.jobId)?.status).toBe("pending");
			expect(active.getManifestHead(AUTHORITY)).toMatchObject({
				version: 0,
				snapshot: { version: 1, generation: 0, files: {} },
			});
			expect(active.claimOutbox("rollback-check", 160, 100)).toBeNull();
			const raw = openNodeSqlite(mutationJournalPath(root));
			// SAFETY: COUNT(*) returns exactly one integer field.
			const retained = raw.prepare("SELECT COUNT(*) AS count FROM mutation_evidence_bundles").get() as {
				count: number;
			};
			expect(retained.count).toBe(0);
			raw.close();
		});
	}

	it("P6: crash after commit recovers as an ack-only leased claim after restart", () => {
		const { active, claim, input } = openWithFault("after_commit");
		expect(() => active.commitEvaluation(input)).toThrow("crash:after_commit");
		expect(active.getEvaluation(claim.jobId)).not.toBeNull();
		expect(active.getJob(claim.jobId)?.status).toBe("evaluated");
		active.close();
		journal = openMutationJournal(root);
		const recovered = journal.claimNext({ authority: AUTHORITY, owner: "restart-worker", nowMs: 1_111, leaseMs: 100 });
		expect(recovered?.phase).toBe("ack");
		expect(recovered?.committedResult?.resultHash).toBe(RESULT_HASH);
		if (recovered?.ack === undefined) throw new Error("ack was not recovered from committed rows");
		expect(journal.acknowledge(recovered.ack, 1_120)).toBe(true);
		expect(journal.getJob(claim.jobId)?.status).toBe("acked");
	});

	it("P7: an uncommitted leased job survives process restart and lease expiry", () => {
		journal = openMutationJournal(root);
		journal.enqueue(job());
		const first = claimed(journal, 110);
		journal.close();
		journal = openMutationJournal(root);
		expect(journal.claimNext({ authority: AUTHORITY, owner: "too-early", nowMs: 1_000, leaseMs: 50 })).toBeNull();
		const recovered = journal.claimNext({ authority: AUTHORITY, owner: "restart-worker", nowMs: 1_111, leaseMs: 50 });
		expect(recovered?.phase).toBe("poll");
		expect(recovered?.claimCount).toBe(first.claimCount + 1);
	});
});

describe("SQLite mutation journal — manifest authority isolation", () => {
	it("reuses one exact authority across restart while keeping a switched authority independent", () => {
		journal = openMutationJournal(root);
		const first = journal.initializeManifestHead({
			authority: AUTHORITY,
			snapshot: { version: 1, generation: 4, files: { owned: {} } },
			initializedAtMs: 100,
		});
		expect(first.kind).toBe("initialized");
		expect(journal.getManifestHead(FOREIGN_AUTHORITY)).toBeNull();
		const foreign = journal.initializeManifestHead({
			authority: FOREIGN_AUTHORITY,
			snapshot: { version: 1, generation: 8, files: { foreign: {} } },
			initializedAtMs: 101,
		});
		expect(foreign.kind).toBe("initialized");
		journal.close();

		journal = openMutationJournal(root);
		expect(journal.initializeManifestHead({
			authority: AUTHORITY,
			snapshot: { version: 1, generation: 99, files: {} },
			initializedAtMs: 200,
		})).toEqual({ kind: "existing", head: first.head });
		expect(journal.getManifestHead(FOREIGN_AUTHORITY)).toEqual(foreign.head);
	});
});

describe("SQLite mutation journal — legacy compatibility seam", () => {
	it("P8: captures a legacy manifest for audit without minting or replacing v3 authority state", () => {
		journal = openMutationJournal(root);
		journal.initializeManifestHead({
			authority: AUTHORITY,
			snapshot: { version: 1, generation: 3, files: { current: {} } },
			initializedAtMs: 400,
		});
		const authoritative = journal.getManifestHead(AUTHORITY);
		const dir = join(root, ".interlinked");
		mkdirSync(dir, { recursive: true });
		const manifestPath = join(dir, "mutation-manifest.json");
		writeFileSync(manifestPath, '{"version":1,"generation":7,"files":{}}\n');
		expect(importLegacyMutationFiles(journal, root, 500)).toMatchObject({
			kind: "inserted",
			manifestCapture: "captured",
		});
		expect(journal.getManifestHead(AUTHORITY)).toEqual(authoritative);
		expect(journal.getManifestHead(FOREIGN_AUTHORITY)).toBeNull();

		journal.close();
		journal = openMutationJournal(root);
		writeFileSync(manifestPath, '{"version":1,"generation":99,"files":{"foreign":{}}}\n');
		expect(importLegacyMutationFiles(journal, root, 600)).toMatchObject({
			kind: "inserted",
			manifestCapture: "captured",
		});
		expect(journal.getManifestHead(AUTHORITY)).toEqual(authoritative);
		expect(journal.getManifestHead(FOREIGN_AUTHORITY)).toBeNull();
		expect(readFileSync(manifestPath, "utf8")).toContain('"generation":99');
	});

	it("P9/N6: captures legacy stores idempotently without interpreting incomplete rows", () => {
		journal = openMutationJournal(root);
		const legacy = {
			sourceId: "legacy-files-v1",
			capturedAtMs: 100,
			pendingRuns: [{ file: "src/a.ts", jobId: "old-job" }],
			manifestSnapshot: { version: 1, generation: 3 },
			receipts: [{ outcome: "baseline_adopted" }],
			runRows: [{ source: "per-edit", mutants: 2 }],
		};
		expect(journal.importLegacy(legacy)).toBe("inserted");
		expect(journal.importLegacy(legacy)).toBe("existing");
		expect(() => journal?.importLegacy({ ...legacy, runRows: [{ source: "changed" }] })).toThrow(
			"different bytes",
		);
	});

	it("P10: captures exact legacy file bytes without deleting or rewriting them", () => {
		journal = openMutationJournal(root);
		const dir = join(root, ".interlinked");
		mkdirSync(dir, { recursive: true });
		const manifestPath = join(dir, "mutation-manifest.json");
		const receiptPath = join(dir, "mutation-receipts.jsonl");
		writeFileSync(manifestPath, '{"version":1,"generation":7}\n');
		writeFileSync(receiptPath, '{"outcome":"baseline_adopted"}\n');
		const manifestBefore = readFileSync(manifestPath);
		const receiptsBefore = readFileSync(receiptPath);
		const first = importLegacyMutationFiles(journal, root, 500);
		expect(first).toMatchObject({ kind: "inserted", files: 2, manifestCapture: "captured" });
		expect(importLegacyMutationFiles(journal, root, 600)).toMatchObject({ kind: "existing", files: 2 });
		expect(journal.getManifestHead(AUTHORITY)).toBeNull();
		expect(readFileSync(manifestPath)).toEqual(manifestBefore);
		expect(readFileSync(receiptPath)).toEqual(receiptsBefore);
	});

	it("N10: an oversized legacy manifest records bounded skip metadata and never promotes a baseline", () => {
		journal = openMutationJournal(root);
		const dir = join(root, ".interlinked");
		mkdirSync(dir, { recursive: true });
		const manifestPath = join(dir, "mutation-manifest.json");
		writeFileSync(manifestPath, Buffer.alloc(LEGACY_CAPTURE_MAX_FILE_BYTES + 1, 65));

		const imported = importLegacyMutationFiles(journal, root, 700);
		expect(imported).toMatchObject({
			kind: "inserted",
			files: 1,
			manifestCapture: "captured",
		});
		expect(journal.getManifestHead(AUTHORITY)).toBeNull();
		if (imported.kind === "none") throw new Error("oversized audit capture was not recorded");
		journal.close();
		journal = null;
		const raw = openNodeSqlite(mutationJournalPath(root));
		// SAFETY: the source id is primary-key unique and payload_json is text.
		const row = raw.prepare(
			"SELECT payload_json FROM mutation_legacy_imports WHERE source_id = ?",
		).get(imported.sourceId) as { payload_json: string };
		raw.close();
		expect(row.payload_json).toContain('"skipReason":"oversized"');
		expect(row.payload_json).not.toContain('"base64"');
		expect(row.payload_json.length).toBeLessThan(2_048);
	});
});
