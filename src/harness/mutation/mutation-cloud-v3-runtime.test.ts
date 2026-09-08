// test-contract: integration — the opt-in runtime composes authenticated
// submission, restart-safe polling, one evaluator, journal-before-ack, and
// ack-only recovery over the real SQLite store.

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isJsonObject } from "../../lib/json-types.js";
import type { MutationCloudFetch } from "./mutation-cloud-v3-client.js";
import type { MutationCloudSubmissionFetch } from "./mutation-cloud-v3-submission.js";
import {
	MutationCloudV3Runtime,
	type MutationCloudV3RuntimeConfig,
} from "./mutation-cloud-v3-runtime.js";
import {
	MUTATION_RETRY_BASE_DELAY_MS,
	MUTATION_RETRY_MAX_FAILURES,
} from "./mutation-journal-codec.js";
import { openNodeSqlite } from "./mutation-journal-driver.js";
import { LEGACY_CAPTURE_MAX_FILE_BYTES } from "./mutation-journal-legacy.js";
import { mutationJournalPath, openMutationJournal } from "./mutation-journal-sqlite.js";
import type {
	ClaimedMutationJob,
	JournalRetainedEvidence,
	MutationJournal,
} from "./mutation-journal-types.js";
import {
	authenticateFixture,
	TEST_NOW,
	TEST_REGISTRY,
	TEST_SOURCE_ARTIFACT_TEXT,
} from "./protocol-v3/test-authentication.js";
import {
	deriveAdmission,
	parseMutationJobRequestV3,
	type ValidMutationJobRequest,
} from "./protocol-v3/request.js";
import { MUTATION_RESULT_TARGET_CONTENT, validMutationResult } from "./protocol-v3/test-envelopes.js";
import { PROTOCOL_V3_CONTRACT_DIGEST as CONTRACT_DIGEST } from "./protocol-v3/contract-identity.js";

const NOW_MS = Date.parse(TEST_NOW);

function syntheticRetainedEvidence(): JournalRetainedEvidence {
	const canonicalJson = "{}";
	const sha256 = createHash("sha256").update(canonicalJson).digest("hex");
	return {
		formatVersion: 1,
		envelope: { canonicalJson, sha256 },
		acceptanceReceipt: { canonicalJson, sha256 },
		executionReceipt: { canonicalJson, sha256 },
		terminalizationRecord: null,
		report: null,
	};
}

interface RuntimeFixture {
	request: ValidMutationJobRequest;
	authenticated: ReturnType<typeof authenticateFixture>;
	sourceBytes: Uint8Array;
	targetBytes: Uint8Array;
}

function fixture(): RuntimeFixture {
	const raw = validMutationResult();
	raw.excluded = [];
	raw.census = { generated: raw.mutants.length, executable: raw.mutants.length, approved_excluded: 0 };
	// SAFETY: validMutationResult constructs a JSON object; authenticateFixture
	// rebuilds and production-parses every protocol field before use.
	const authenticated = authenticateFixture(raw as unknown as Record<string, unknown>);
	const envelope = authenticated.raw;
	const scope = envelope.scope;
	if (!isJsonObject(scope)) {
		throw new Error("fixture envelope scope is missing");
	}
	const testFiles = scope.test_files;
	if (!Array.isArray(testFiles) || testFiles.some((value) => typeof value !== "string")) {
		throw new Error("fixture envelope test files are missing");
	}
	const parsed = parseMutationJobRequestV3({
		request_version: "1",
		protocol_version: "interlinked-mutation/3.0",
		job: authenticated.inputs.expectedJob,
		source_artifact: authenticated.inputs.expectedAdmission.source_artifact,
		scope_mode: scope.mode,
		test_files: testFiles,
		changeset: [{
			path: authenticated.inputs.expectedJob.target_file,
			content_hash: authenticated.inputs.expectedJob.target_content_hash,
		}],
	});
	if (!parsed.ok) throw new Error(parsed.reason);
	return {
		request: parsed.request,
		authenticated,
		sourceBytes: Buffer.from(TEST_SOURCE_ARTIFACT_TEXT, "utf8"),
		targetBytes: Buffer.from(MUTATION_RESULT_TARGET_CONTENT, "utf8"),
	};
}

function authority(view: RuntimeFixture) {
	return {
		tenant: view.request.job.tenant,
		project: view.request.job.project,
		repository: view.request.job.repository,
	};
}

function config(view: RuntimeFixture): MutationCloudV3RuntimeConfig {
	return {
		submission: {
			baseUrl: "https://mutation.example",
			token: "runtime-test-credential",
			projectRef: view.request.job.project,
			repository: view.request.job.repository,
			timeoutMs: 5_000,
			contractDigest: CONTRACT_DIGEST,
			keyRegistry: TEST_REGISTRY,
			serverAuthority: {
				tenant: view.request.job.tenant,
				project: view.request.job.project,
			},
		},
		client: {
			baseUrl: "https://mutation.example",
			token: "runtime-test-credential",
			projectRef: view.request.job.project,
			claimantId: "runtime-test-installation",
			timeoutMs: 5_000,
		},
		evaluator: {
			keyRegistry: TEST_REGISTRY,
			serverAuthority: {
				tenant: view.request.job.tenant,
				project: view.request.job.project,
			},
			evaluatorPolicyVersion: "runtime-test-policy",
			siteCountThreshold: 50,
		},
		owner: "runtime-test-owner",
		leaseMs: 15_000,
	};
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function submissionFetch(view: RuntimeFixture): MutationCloudSubmissionFetch {
	return async (_url, init) => {
		if (init.method === "GET") {
			return json({
				protocol_version: "interlinked-mutation/3.0",
				contract_digest: CONTRACT_DIGEST,
				keys: TEST_REGISTRY,
			});
		}
		if (init.method === "PUT") {
			return json({ ...view.request.source_artifact, idempotent_replay: false }, 201);
		}
		return json({
			job_key: view.request.job.job_key,
			project_ref: view.request.job.project,
			execution_state: "accepted",
			execution_instance_id: "workflow-runtime-test",
			request_hash: view.authenticated.inputs.expectedAdmission.request_hash,
			changeset_hash: view.authenticated.inputs.expectedAdmission.changeset_hash,
			acceptance_receipt: JSON.parse(view.authenticated.inputs.receipts.acceptance),
			idempotent_replay: false,
		}, 202);
	};
}

function leasedClaim(view: RuntimeFixture, body: string | undefined): Record<string, unknown> {
	const parsed: unknown = JSON.parse(body ?? "{}");
	if (!isJsonObject(parsed)) {
		throw new Error("claim body must be an object");
	}
	return {
		state: "leased",
		job_key: view.request.job.job_key,
		lease_id: parsed.lease_id,
		lease_until: "2026-08-31T13:05:00.000Z",
		result_hash: view.authenticated.raw.result_hash,
		bundle: {
			envelope: view.authenticated.raw,
			acceptance_receipt: JSON.parse(view.authenticated.inputs.receipts.acceptance),
			execution_receipt: JSON.parse(view.authenticated.inputs.receipts.execution ?? "null"),
		},
	};
}

function terminalFetch(view: RuntimeFixture, ackStatus: number, calls: string[]): MutationCloudFetch {
	return async (url, init) => {
		calls.push(url);
		if (url.includes("/report?")) {
			return new Response(Buffer.from(view.authenticated.inputs.report ?? new Uint8Array()), { status: 200 });
		}
		if (url.endsWith("/ack")) {
			return ackStatus === 200
				? json({ state: "acknowledged", job_key: view.request.job.job_key })
				: json({ error: "injected ack outage" }, ackStatus);
		}
		return json(leasedClaim(view, init.body));
	};
}

function enqueueJournalJob(journal: MutationJournal, view: RuntimeFixture): void {
	const admission = deriveAdmission(view.request);
	journal.enqueue({
		jobId: view.request.job.job_key,
		remoteJobId: view.request.job.job_key,
		acceptanceReceiptHash: String(view.authenticated.raw.acceptance_receipt_hash),
		expectedJob: { ...view.request.job },
		expectedAdmission: {
			request_hash: admission.request_hash,
			changeset_hash: admission.changeset_hash,
			source_artifact: { ...admission.source_artifact },
		},
		targetBytes: view.targetBytes,
		targetSha256: view.request.job.target_content_hash,
		baselineIntent: "require_established",
		createdAtMs: NOW_MS,
	});
}

function commitSyntheticEvaluation(journal: MutationJournal, claim: ClaimedMutationJob, nowMs: number): void {
	const manifestAuthority = {
		tenant: claim.expectedJob.tenant,
		project: claim.expectedJob.project,
		repository: claim.expectedJob.repository,
	};
	const head = journal.getManifestHead(manifestAuthority);
	if (head === null) throw new Error("runtime test manifest head was not initialized");
	journal.commitEvaluation({
		jobId: claim.jobId,
		leaseToken: claim.leaseToken,
		nowMs,
		manifestAuthority,
		expectedManifestVersion: head.version,
		acceptanceReceiptHash: claim.acceptanceReceiptHash,
		resultHash: "b".repeat(64),
		authenticatedEvidenceHash: "c".repeat(64),
		evaluatorPolicyVersion: "runtime-test-policy",
		retainedEvidence: syntheticRetainedEvidence(),
		evaluation: { completeness: "none" },
		decision: { verdict: "not_measured" },
		manifestSnapshot: head.snapshot,
		receipt: { verdict: "not_measured" },
		runRow: { source: "runtime-test" },
		findings: [],
	});
}

function deadLetterJob(
	journal: MutationJournal,
	jobId: string,
	firstDueAtMs: number,
	manifestAuthority: ReturnType<typeof authority>,
): number {
	let dueAtMs = firstDueAtMs;
	for (let failure = 1; failure <= MUTATION_RETRY_MAX_FAILURES; failure += 1) {
		const claim = journal.claimJob({
			jobId,
			authority: manifestAuthority,
			owner: "runtime-dead-letter",
			nowMs: dueAtMs,
			leaseMs: 1_000,
		});
		if (claim === null) throw new Error(`runtime dead-letter claim ${failure} was unavailable`);
		const scheduled = journal.scheduleRetry({
			jobId,
			leaseToken: claim.leaseToken,
			nowMs: dueAtMs,
			kind: "failure",
			error: `remote_ack: outage-${failure}`,
		});
		if (scheduled?.kind === "scheduled") dueAtMs = scheduled.nextAttemptAtMs;
	}
	return dueAtMs;
}

function legacyImportCount(repositoryRoot: string): number {
	const raw = openNodeSqlite(mutationJournalPath(repositoryRoot));
	// SAFETY: COUNT(*) returns exactly one numeric field.
	const row = raw.prepare("SELECT COUNT(*) AS count FROM mutation_legacy_imports").get() as { count: number };
	raw.close();
	return row.count;
}

let root = "";

afterEach(() => {
	if (root !== "") rmSync(root, { recursive: true, force: true });
	root = "";
});

describe("MutationCloudV3Runtime", () => {
	it("prepares and submits one explicit proposed edit with require_established journal semantics", async () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-v3-runtime-edit-"));
		const view = fixture();
		const preparePerEdit = vi.fn(() => ({
			request: view.request,
			sourceArtifactBytes: Uint8Array.from(view.sourceBytes),
			targetBytes: Uint8Array.from(view.targetBytes),
		}));
		const runtime = new MutationCloudV3Runtime(root, config(view), {
			submissionFetch: submissionFetch(view),
			clientFetch: async () => json({ error: "not ready" }, 409),
			clockMs: () => NOW_MS,
			preparePerEdit,
		});

		const result = await runtime.submitEdit(view.request.job.target_file, view.targetBytes);

		expect(preparePerEdit).toHaveBeenCalledExactlyOnceWith({
			root,
			targetFile: view.request.job.target_file,
			proposedBytes: view.targetBytes,
			authority: {
				tenant: view.request.job.tenant,
				project: view.request.job.project,
				repository: view.request.job.repository,
			},
		});
		expect(result.immediate.processor).toMatchObject({ kind: "pending" });
		runtime.close();

		const journal = openMutationJournal(root);
		const claimed = journal.claimJob({
			jobId: view.request.job.job_key,
			authority: authority(view),
			owner: "runtime-edit-assertion",
			nowMs: NOW_MS + MUTATION_RETRY_BASE_DELAY_MS,
			leaseMs: 1_000,
		});
		expect(claimed?.baselineIntent).toBe("require_established");
		journal.close();
	});

	it("persists pending submission, commits before a failed ack, then resumes ack-only after restart", async () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-v3-runtime-"));
		const view = fixture();
		const pending = new MutationCloudV3Runtime(root, config(view), {
			submissionFetch: submissionFetch(view),
			clientFetch: async () => json({ error: "not ready" }, 409),
			clockMs: () => NOW_MS,
		});
		const submitted = await pending.submit({
			request: view.request,
			sourceArtifactBytes: view.sourceBytes,
			targetBytes: view.targetBytes,
			createdAtMs: NOW_MS,
		});
		expect(submitted.immediate.processor).toMatchObject({ kind: "pending" });
		expect(submitted.immediate.evaluation).toBeNull();
		pending.close();

		const failedAckCalls: string[] = [];
		const terminal = new MutationCloudV3Runtime(root, config(view), {
			submissionFetch: submissionFetch(view),
			clientFetch: terminalFetch(view, 503, failedAckCalls),
			clockMs: () => NOW_MS + MUTATION_RETRY_BASE_DELAY_MS,
		});
		const committed = await terminal.processNext();
		expect(committed.processor).toMatchObject({ kind: "retry", stage: "remote_ack" });
		expect(committed.evaluation?.decision).toMatchObject({ verdict: "not_measured" });
		expect(committed.evaluation?.receipt).toMatchObject({ verdict: "not_measured" });
		expect(failedAckCalls.some((url) => url.endsWith("/ack"))).toBe(true);
		terminal.close();

		const recoveryCalls: string[] = [];
		const recovered = new MutationCloudV3Runtime(root, config(view), {
			submissionFetch: submissionFetch(view),
			clientFetch: terminalFetch(view, 200, recoveryCalls),
			clockMs: () => NOW_MS + (2 * MUTATION_RETRY_BASE_DELAY_MS),
		});
		const acknowledged = await recovered.processNext();
		expect(acknowledged.processor).toEqual({
			kind: "acknowledged",
			jobId: view.request.job.job_key,
			phase: "ack",
		});
		expect(acknowledged.evaluation?.resultHash).toBe(committed.evaluation?.resultHash);
		expect(recoveryCalls.some((url) => url.endsWith("/ack"))).toBe(true);
		recovered.close();

		const journal = openMutationJournal(root);
		expect(journal.getJob(view.request.job.job_key)?.status).toBe("acked");
		expect(journal.getEvaluation(view.request.job.job_key)?.decision).toMatchObject({ verdict: "not_measured" });
		journal.close();
	});

	it("captures a corrupt legacy manifest for audit without treating it as authoritative v3 state", () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-v3-runtime-corrupt-"));
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		const manifestPath = join(root, ".interlinked", "mutation-manifest.json");
		const corrupt = "{ definitely-not-json\n";
		writeFileSync(manifestPath, corrupt, "utf8");
		const view = fixture();
		const runtime = new MutationCloudV3Runtime(root, config(view), {
			submissionFetch: submissionFetch(view),
			clientFetch: async () => json({ error: "not ready" }, 409),
			clockMs: () => NOW_MS,
		});
		runtime.close();
		expect(readFileSync(manifestPath, "utf8")).toBe(corrupt);
		expect(legacyImportCount(root)).toBe(0);
		const journal = openMutationJournal(root);
		expect(journal.getManifestHead({
			tenant: view.request.job.tenant,
			project: view.request.job.project,
			repository: view.request.job.repository,
		})).toMatchObject({ version: 0, snapshot: { generation: 0, files: {} } });
		journal.close();
	});

	it("does not read or import an oversized legacy manifest during ordinary startup", () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-v3-runtime-oversized-legacy-"));
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		const manifestPath = join(root, ".interlinked", "mutation-manifest.json");
		writeFileSync(manifestPath, Buffer.alloc(LEGACY_CAPTURE_MAX_FILE_BYTES + 1, 65));
		const view = fixture();

		new MutationCloudV3Runtime(root, config(view), { clockMs: () => NOW_MS }).close();

		expect(legacyImportCount(root)).toBe(0);
		expect(readFileSync(manifestPath).byteLength).toBe(LEGACY_CAPTURE_MAX_FILE_BYTES + 1);
	});

	it("does not import a changing legacy manifest across repeated opens or restart", () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-v3-runtime-changing-legacy-"));
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		const manifestPath = join(root, ".interlinked", "mutation-manifest.json");
		writeFileSync(manifestPath, '{"version":1,"generation":1,"files":{}}\n');
		const view = fixture();
		const authority = {
			tenant: view.request.job.tenant,
			project: view.request.job.project,
			repository: view.request.job.repository,
		};
		new MutationCloudV3Runtime(root, config(view), { clockMs: () => NOW_MS }).close();
		const journal = openMutationJournal(root);
		const initialHead = journal.getManifestHead(authority);
		journal.close();
		writeFileSync(manifestPath, '{"version":1,"generation":999,"files":{"foreign":{}}}\n');

		new MutationCloudV3Runtime(root, config(view), { clockMs: () => NOW_MS + 1 }).close();

		expect(legacyImportCount(root)).toBe(0);
		const restarted = openMutationJournal(root);
		expect(restarted.getManifestHead(authority)).toEqual(initialHead);
		restarted.close();
	});

	it("reuses the same configured authority after restart but isolates a repository switch", () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-v3-runtime-authority-"));
		const view = fixture();
		const original = config(view);
		new MutationCloudV3Runtime(root, original, { clockMs: () => NOW_MS }).close();
		const journal = openMutationJournal(root);
		const authority = {
			tenant: original.submission.serverAuthority.tenant,
			project: original.submission.serverAuthority.project,
			repository: original.submission.repository,
		};
		const first = journal.getManifestHead(authority);
		journal.close();

		new MutationCloudV3Runtime(root, original, { clockMs: () => NOW_MS + 1 }).close();
		const switched = config(view);
		switched.submission.repository = "github.com/example/other-repo";
		new MutationCloudV3Runtime(root, switched, { clockMs: () => NOW_MS + 2 }).close();
		const reopened = openMutationJournal(root);
		expect(reopened.getManifestHead(authority)).toEqual(first);
		expect(reopened.getManifestHead({ ...authority, repository: switched.submission.repository })).toMatchObject({
			version: 0,
			snapshot: { generation: 0, files: {} },
		});
		reopened.close();
	});

	it("rejects split submission/result authority before opening network work", () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-v3-runtime-config-"));
		const view = fixture();
		const split = config(view);
		split.client.projectRef = "foreign-project";
		expect(() => new MutationCloudV3Runtime(root, split)).toThrow("must use one projectRef");
	});

	it("rejects a non-positive or unsafe leaseMs before any journal work begins", () => {
		const view = fixture();
		const invalid = config(view);
		invalid.leaseMs = 0;
		expect(() => new MutationCloudV3Runtime("unused-runtime-root", invalid))
			.toThrow("mutation cloud runtime leaseMs must be a positive safe integer");
	});

	it("rejects a submission/client baseUrl mismatch", () => {
		const view = fixture();
		const mismatched = config(view);
		mismatched.client.baseUrl = "https://mutation.example/other";
		expect(() => new MutationCloudV3Runtime("unused-runtime-root", mismatched))
			.toThrow("mutation cloud submission and result clients must use one baseUrl");
	});

	it("rejects a submission/client credential mismatch", () => {
		const view = fixture();
		const mismatched = config(view);
		mismatched.client.token = "a-different-credential";
		expect(() => new MutationCloudV3Runtime("unused-runtime-root", mismatched))
			.toThrow("mutation cloud submission and result clients must use one credential");
	});

	it("rejects a submission/client timeoutMs mismatch", () => {
		const view = fixture();
		const mismatched = config(view);
		mismatched.client.timeoutMs = 6_000;
		expect(() => new MutationCloudV3Runtime("unused-runtime-root", mismatched))
			.toThrow("mutation cloud submission and result clients must use one timeoutMs");
	});

	it("rejects a leaseMs shorter than 3x the client timeout", () => {
		const view = fixture();
		const shortLease = config(view);
		shortLease.leaseMs = shortLease.client.timeoutMs * 3 - 1;
		expect(() => new MutationCloudV3Runtime("unused-runtime-root", shortLease))
			.toThrow("mutation cloud leaseMs must be at least 3 × timeoutMs");
	});

	it("rejects a submission/evaluator authority mismatch", () => {
		const view = fixture();
		const mismatched = config(view);
		mismatched.evaluator.serverAuthority = {
			...mismatched.evaluator.serverAuthority,
			tenant: `${mismatched.evaluator.serverAuthority.tenant}-other`,
		};
		expect(() => new MutationCloudV3Runtime("unused-runtime-root", mismatched))
			.toThrow("mutation cloud submission and evaluator must use one authenticated authority");
	});

	it("closes only an owned journal when constructor-time manifest seeding fails, but always rethrows", () => {
		const view = fixture();
		const close = vi.fn();
		// SAFETY: getManifestHead throws before any journal method except close can run; this fixture isolates ownership cleanup on that path.
		const fakeJournal = {
			getManifestHead: () => {
				throw new Error("injected manifest head lookup failure");
			},
			close,
		} as unknown as MutationJournal;
		expect(() => new MutationCloudV3Runtime("unused-runtime-root", config(view), { journal: fakeJournal }))
			.toThrow("injected manifest head lookup failure");
		expect(close).not.toHaveBeenCalled();
	});

	it("lists and token-redrives an ack-phase dead letter without processing it", () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-v3-runtime-redrive-"));
		const view = fixture();
		const journal = openMutationJournal(root);
		let clockMs = NOW_MS;
		const clientFetch = vi.fn<MutationCloudFetch>();
		const runtime = new MutationCloudV3Runtime(root, config(view), {
			journal,
			clientFetch,
			clockMs: () => clockMs,
		});
		enqueueJournalJob(journal, view);
		const initial = journal.claimJob({
			jobId: view.request.job.job_key,
			authority: authority(view),
			owner: "runtime-evaluator",
			nowMs: NOW_MS,
			leaseMs: 1_000,
		});
		if (initial === null) throw new Error("runtime evaluation claim was unavailable");
		commitSyntheticEvaluation(journal, initial, NOW_MS + 1);
		expect(journal.release({
			jobId: initial.jobId,
			leaseToken: initial.leaseToken,
			nowMs: NOW_MS + 2,
		})).toBe(true);
		clockMs = deadLetterJob(journal, initial.jobId, NOW_MS + 2, authority(view)) + 1;

		const listed = runtime.listDeadLetters(1);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ jobId: initial.jobId, phase: "ack", failureCount: 8 });
		const dead = listed[0];
		if (dead === undefined) throw new Error("runtime dead letter was not listed");
		expect(runtime.redriveDeadLetter(dead.jobId, dead.redriveToken)).toEqual({
			kind: "redriven",
			jobId: dead.jobId,
			dueAtMs: clockMs,
		});
		expect(runtime.listDeadLetters(1)).toEqual([]);
		const reclaimed = journal.claimJob({
			jobId: dead.jobId,
			authority: authority(view),
			owner: "runtime-ack-redrive",
			nowMs: clockMs,
			leaseMs: 1_000,
		});
		expect(reclaimed?.phase).toBe("ack");
		expect(reclaimed?.ack).toBeDefined();
		expect(clientFetch).not.toHaveBeenCalled();
		runtime.close();
		journal.close();
	});

	it("refuses a stale redrive token and leaves the dead letter fenced", () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-v3-runtime-stale-redrive-"));
		const view = fixture();
		const journal = openMutationJournal(root);
		let clockMs = NOW_MS;
		const runtime = new MutationCloudV3Runtime(root, config(view), { journal, clockMs: () => clockMs });
		enqueueJournalJob(journal, view);
		clockMs = deadLetterJob(journal, view.request.job.job_key, NOW_MS, authority(view)) + 1;

		expect(() => runtime.redriveDeadLetter(view.request.job.job_key, "stale-token"))
			.toThrow("not found or its redrive token is stale");
		expect(runtime.listDeadLetters(1)).toMatchObject([{
			jobId: view.request.job.job_key,
			phase: "poll",
			failureCount: 8,
		}]);
		runtime.close();
		journal.close();
	});
});
