// test-contract: invariant — durable mutation processing never consumes a
// remote result before the local evaluation transaction commits.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MUTATION_RETRY_MAX_FAILURES } from "./mutation-journal-codec.js";
import { openMutationJournal } from "./mutation-journal-sqlite.js";
import type {
	EnqueueMutationJob,
	JournalFaultPoint,
	JournalRetainedEvidence,
	MutationManifestAuthority,
	MutationJournal,
	MutationJournalAck,
} from "./mutation-journal-types.js";
import {
	processNextMutationJob,
	processMutationJobById,
	type CommitMutationEvaluationDraft,
	type MutationJobEvaluator,
	type RemoteMutationJobClient,
	type RemoteMutationJobIdentity,
} from "./mutation-job-processor.js";

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

function retainedEvidence(): JournalRetainedEvidence {
	const canonicalJson = "{}";
	const sha256 = digest(Buffer.from(canonicalJson, "utf8"));
	return {
		formatVersion: 1,
		envelope: { canonicalJson, sha256 },
		acceptanceReceipt: { canonicalJson, sha256 },
		executionReceipt: { canonicalJson, sha256 },
		terminalizationRecord: null,
		report: null,
	};
}

function enqueuedJob(jobId = "local-job-1"): EnqueueMutationJob {
	const targetBytes = Buffer.from("export const answer = 42;\n", "utf8");
	const targetSha256 = digest(targetBytes);
	return {
		jobId,
		remoteJobId: `remote-${jobId}`,
		acceptanceReceiptHash: ACCEPTANCE_HASH,
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
		createdAtMs: 90,
	};
}

function evaluationDraft(overrides: Partial<CommitMutationEvaluationDraft> = {}): CommitMutationEvaluationDraft {
	return {
		resultHash: RESULT_HASH,
		authenticatedEvidenceHash: EVIDENCE_HASH,
		evaluatorPolicyVersion: "mutation-policy-v1",
		retainedEvidence: retainedEvidence(),
		evaluation: { completeness: "complete", survived: 0 },
		decision: { kind: "measured", decision: "allow" },
		manifestSnapshot: { version: 1, generation: 4, files: {} },
		receipt: { outcome: "measured_clean", result_hash: RESULT_HASH },
		runRow: { source: "background", mutants: 4, killed: 4, survived: 0 },
		findings: [],
		...overrides,
	};
}

function scriptedClock(...values: number[]): () => number {
	let index = 0;
	return () => {
		const value = values[index] ?? values.at(-1);
		if (value === undefined) throw new Error("clock fixture needs at least one reading");
		index += 1;
		return value;
	};
}

interface RemoteHarness extends RemoteMutationJobClient {
	claimCalls: RemoteMutationJobIdentity[];
	ackCalls: Array<{ job: RemoteMutationJobIdentity; ack: MutationJournalAck }>;
}

function remoteHarness(
	claim: () => Promise<unknown>,
	acknowledge: (job: RemoteMutationJobIdentity, ack: MutationJournalAck) => Promise<void> = async () => {},
): RemoteHarness {
	const claimCalls: RemoteMutationJobIdentity[] = [];
	const ackCalls: Array<{ job: RemoteMutationJobIdentity; ack: MutationJournalAck }> = [];
	return {
		claimCalls,
		ackCalls,
		async claimResult(job) {
			claimCalls.push(job);
			return claim();
		},
		async acknowledge(job, ack) {
			ackCalls.push({ job, ack });
			await acknowledge(job, ack);
		},
	};
}

interface EvaluatorHarness extends MutationJobEvaluator {
	calls: unknown[];
}

function evaluatorHarness(
	evaluate: MutationJobEvaluator["evaluate"] = async () => evaluationDraft(),
): EvaluatorHarness {
	const calls: unknown[] = [];
	return {
		calls,
		async evaluate(input) {
			calls.push(input.evidence);
			return evaluate(input);
		},
	};
}

let root = "";
let journal: MutationJournal | null = null;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-mutation-processor-"));
});

afterEach(() => {
	journal?.close();
	journal = null;
	rmSync(root, { recursive: true, force: true });
});

function openWithJob(faultInjector?: (point: JournalFaultPoint) => void): MutationJournal {
	journal = faultInjector === undefined
		? openMutationJournal(root)
		: openMutationJournal(root, { faultInjector });
	journal.initializeManifestHead({
		authority: AUTHORITY,
		snapshot: { version: 1, generation: 0, files: {} },
		initializedAtMs: 80,
	});
	journal.enqueue(enqueuedJob());
	return journal;
}

function options(
	activeJournal: MutationJournal,
	remote: RemoteMutationJobClient,
	evaluator: MutationJobEvaluator,
	clock: () => number,
	authority: MutationManifestAuthority = AUTHORITY,
) {
	return {
		journal: activeJournal,
		remote,
		evaluator,
		authority,
		owner: "processor-a",
		leaseMs: 1_000,
		clock,
	};
}

describe("durable mutation job processor — one immediate/background path", () => {
	it("P0-authority: a foreign runtime cannot claim or contact an authority's queued job", async () => {
		const active = openWithJob();
		const remote = remoteHarness(async () => ({ kind: "pending" }));
		const foreign = await processNextMutationJob(options(
			active,
			remote,
			evaluatorHarness(),
			scriptedClock(100),
			FOREIGN_AUTHORITY,
		));
		expect(foreign).toEqual({ kind: "idle" });
		expect(remote.claimCalls).toEqual([]);
		expect(active.getJob("local-job-1")?.claimCount).toBe(0);

		const local = await processNextMutationJob(options(
			active,
			remote,
			evaluatorHarness(),
			scriptedClock(101, 102),
		));
		expect(local).toEqual({ kind: "pending", jobId: "local-job-1" });
		expect(remote.claimCalls).toHaveLength(1);
	});

	it("N0: a foreign authority head is a miss and terminal evidence never reaches the evaluator", async () => {
		journal = openMutationJournal(root);
		journal.initializeManifestHead({
			authority: FOREIGN_AUTHORITY,
			snapshot: { version: 1, generation: 9, files: { foreign: {} } },
			initializedAtMs: 80,
		});
		journal.enqueue(enqueuedJob());
		const evaluator = evaluatorHarness();

		const outcome = await processNextMutationJob(options(
			journal,
			remoteHarness(async () => ({ kind: "terminal", evidence: { signed: true } })),
			evaluator,
			scriptedClock(100, 110, 120),
		));

		expect(outcome).toMatchObject({
			kind: "retry",
			stage: "evaluate",
			reason: "mutation manifest head is not initialized",
		});
		expect(evaluator.calls).toHaveLength(0);
		expect(journal.getManifestHead(FOREIGN_AUTHORITY)?.version).toBe(0);
	});

	it("P0: the immediate keyed path cannot be stolen by an older pending row", async () => {
		const active = openWithJob();
		active.enqueue(enqueuedJob("newly-submitted"));
		const outcome = await processMutationJobById(
			options(
				active,
				remoteHarness(async () => ({ kind: "pending" })),
				evaluatorHarness(),
				scriptedClock(100, 110),
			),
			"newly-submitted",
		);
		expect(outcome).toEqual({ kind: "pending", jobId: "newly-submitted" });
		expect(active.getJob("local-job-1")?.claimCount).toBe(0);
		expect(active.getJob("newly-submitted")?.claimCount).toBe(1);
		expect(await processMutationJobById(
			options(active, remoteHarness(async () => ({ kind: "pending" })), evaluatorHarness(), scriptedClock(120)),
			"newly-submitted",
		)).toEqual({ kind: "idle" });
	});

	it("P1: pending defers its next poll and cannot hot-loop without evaluation or acknowledgement", async () => {
		const active = openWithJob();
		const remote = remoteHarness(async () => ({ kind: "pending" }));
		const evaluator = evaluatorHarness();

		const first = await processNextMutationJob(options(active, remote, evaluator, scriptedClock(100, 110)));
		expect(first).toEqual({ kind: "pending", jobId: "local-job-1" });
		expect(active.getJob("local-job-1")).toMatchObject({ status: "pending", leaseToken: null, claimCount: 1 });
		expect(active.getEvaluation("local-job-1")).toBeNull();
		expect(evaluator.calls).toHaveLength(0);
		expect(remote.ackCalls).toHaveLength(0);
		expect(active.getJob("local-job-1")).toMatchObject({
			nextAttemptAtMs: 1_110,
			failureCount: 0,
			lastError: null,
		});
		expect(await processNextMutationJob(options(active, remote, evaluator, scriptedClock(120)))).toEqual({
			kind: "idle",
		});

		const second = await processNextMutationJob(options(active, remote, evaluator, scriptedClock(1_110, 1_120)));
		expect(second.kind).toBe("pending");
		expect(active.getJob("local-job-1")?.claimCount).toBe(2);
		expect(remote.claimCalls).toHaveLength(2);
	});

	it("P1b: a poison retry cannot starve a later healthy pending job", async () => {
		const active = openWithJob();
		active.enqueue({ ...enqueuedJob("later-job"), createdAtMs: 91 });
		let calls = 0;
		const remote = remoteHarness(async () => {
			calls += 1;
			if (calls === 1) throw new Error("poison result");
			return { kind: "pending" };
		});
		const evaluator = evaluatorHarness();

		expect(await processNextMutationJob(
			options(active, remote, evaluator, scriptedClock(100, 110)),
		)).toMatchObject({ kind: "retry", jobId: "local-job-1" });
		expect(await processNextMutationJob(
			options(active, remote, evaluator, scriptedClock(120, 130)),
		)).toEqual({ kind: "pending", jobId: "later-job" });
		expect(remote.claimCalls.map((job) => job.remoteJobId)).toEqual([
			"remote-local-job-1",
			"remote-later-job",
		]);
	});

	it("P2: terminal evidence evaluates, commits atomically, then sends the journal-minted ack", async () => {
		const active = openWithJob();
		const remote = remoteHarness(
			async () => ({ kind: "terminal", evidence: { kind: "mutation_result", result_hash: RESULT_HASH } }),
			async (_job, ack) => {
				expect(active.getEvaluation(ack.jobId)?.resultHash).toBe(ack.resultHash);
				expect(Object.isFrozen(ack)).toBe(true);
			},
		);
		const evaluator = evaluatorHarness(async ({ manifestHead }) => {
			expect(manifestHead).toMatchObject({ version: 0, snapshot: { generation: 0 } });
			return evaluationDraft();
		});

		const outcome = await processNextMutationJob(
			options(active, remote, evaluator, scriptedClock(100, 110, 120, 130, 140)),
		);

		expect(outcome).toEqual({ kind: "acknowledged", jobId: "local-job-1", phase: "poll" });
		expect(active.getJob("local-job-1")?.status).toBe("acked");
		expect(active.getEvaluation("local-job-1")?.decision).toEqual({ kind: "measured", decision: "allow" });
		expect(remote.claimCalls).toHaveLength(1);
		expect(evaluator.calls).toHaveLength(1);
		expect(remote.ackCalls).toHaveLength(1);
	});

	it("P3: adverse authenticated evidence uses the same evaluator/transaction/ack path", async () => {
		const active = openWithJob();
		const remote = remoteHarness(async () => ({
			kind: "terminal",
			evidence: { kind: "suite_red", failed_tests: ["src/answer.test.ts"] },
		}));
		const evaluator = evaluatorHarness(async () => evaluationDraft({
			evaluation: { completeness: "complete", suiteRed: true },
			decision: { kind: "measured", decision: "block" },
			receipt: { outcome: "finding", result_hash: RESULT_HASH },
			findings: [{ findingId: "red-suite", payload: { severity: "error" } }],
		}));

		const outcome = await processNextMutationJob(
			options(active, remote, evaluator, scriptedClock(100, 110, 120, 130, 140)),
		);

		expect(outcome.kind).toBe("acknowledged");
		expect(active.getEvaluation("local-job-1")).toMatchObject({
			decision: { kind: "measured", decision: "block" },
			findings: [{ findingId: "red-suite" }],
		});
		expect(remote.ackCalls).toHaveLength(1);
	});

	it("N1: malformed terminal data schedules a durable retry and never consumes the remote result", async () => {
		const active = openWithJob();
		const remote = remoteHarness(async () => ({ kind: "terminal" }));
		const evaluator = evaluatorHarness();

		const outcome = await processNextMutationJob(options(active, remote, evaluator, scriptedClock(100, 110)));

		expect(outcome).toMatchObject({ kind: "retry", stage: "parse" });
		expect(active.getJob("local-job-1")).toMatchObject({
			status: "pending",
			leaseToken: null,
			nextAttemptAtMs: 1_110,
			failureCount: 1,
			lastError: "parse: remote mutation result must be exactly pending or terminal evidence",
		});
		expect(active.getEvaluation("local-job-1")).toBeNull();
		expect(evaluator.calls).toHaveLength(0);
		expect(remote.ackCalls).toHaveLength(0);
	});

	it("N2: remote and evaluator failures release for retry without acknowledgement", async () => {
		const active = openWithJob();
		const pollFailure = remoteHarness(async () => {
			throw new Error("remote unavailable");
		});
		const unusedEvaluator = evaluatorHarness();
		const first = await processNextMutationJob(
			options(active, pollFailure, unusedEvaluator, scriptedClock(100, 110)),
		);
		expect(first).toMatchObject({ kind: "retry", stage: "poll", reason: "remote unavailable" });

		const terminal = remoteHarness(async () => ({ kind: "terminal", evidence: { malformed: true } }));
		const failingEvaluator = evaluatorHarness(async () => {
			throw new Error("authentication failed");
		});
		const second = await processNextMutationJob(
			options(active, terminal, failingEvaluator, scriptedClock(1_120, 1_130, 1_140)),
		);
		expect(second).toMatchObject({ kind: "retry", stage: "evaluate", reason: "authentication failed" });
		expect(active.getEvaluation("local-job-1")).toBeNull();
		expect(pollFailure.ackCalls).toHaveLength(0);
		expect(terminal.ackCalls).toHaveLength(0);
	});

	it("N2b: the processor dead-letters the final bounded failure and stops claiming it", async () => {
		const active = openWithJob();
		let dueAtMs = 100;
		for (let failure = 1; failure < MUTATION_RETRY_MAX_FAILURES; failure += 1) {
			const lease = active.claimNext({ authority: AUTHORITY, owner: "setup", nowMs: dueAtMs, leaseMs: 100 });
			if (lease === null) throw new Error(`dead-letter setup lease ${failure} was unavailable`);
			const scheduled = active.scheduleRetry({
				jobId: lease.jobId,
				leaseToken: lease.leaseToken,
				nowMs: dueAtMs,
				kind: "failure",
				error: `poll: setup-${failure}`,
			});
			if (scheduled?.kind !== "scheduled") throw new Error(`setup failure ${failure} was not scheduled`);
			dueAtMs = scheduled.nextAttemptAtMs;
		}
		const outcome = await processNextMutationJob(options(
			active,
			remoteHarness(async () => {
				throw new Error("permanent poison");
			}),
			evaluatorHarness(),
			scriptedClock(dueAtMs, dueAtMs + 1),
		));
		expect(outcome).toEqual({
			kind: "dead_letter",
			jobId: "local-job-1",
			stage: "poll",
			reason: "permanent poison",
			failureCount: MUTATION_RETRY_MAX_FAILURES,
		});
		expect(active.getJob("local-job-1")).toMatchObject({
			status: "dead_letter",
			lastError: "poll: permanent poison",
		});
		expect(active.claimNext({
			authority: AUTHORITY,
			owner: "after-dead-letter",
			nowMs: dueAtMs + 1_000_000,
			leaseMs: 100,
		}))
			.toBeNull();
	});

	it("P4: an after-commit crash restarts in ack-only phase without polling or evaluating again", async () => {
		let crashOnce = true;
		const active = openWithJob((point) => {
			if (point === "after_commit" && crashOnce) {
				crashOnce = false;
				throw new Error("simulated process crash after commit");
			}
		});
		const firstRemote = remoteHarness(async () => ({ kind: "terminal", evidence: { complete: true } }));
		const firstEvaluator = evaluatorHarness();

		const first = await processNextMutationJob(
			options(active, firstRemote, firstEvaluator, scriptedClock(100, 110, 120, 130)),
		);
		expect(first).toMatchObject({ kind: "retry", stage: "commit" });
		expect(active.getJob("local-job-1")?.status).toBe("evaluated");
		expect(firstRemote.ackCalls).toHaveLength(0);

		active.close();
		journal = openMutationJournal(root);
		const restartRemote = remoteHarness(async () => {
			throw new Error("ack-only recovery must not poll");
		});
		const restartEvaluator = evaluatorHarness(async () => {
			throw new Error("ack-only recovery must not evaluate");
		});
		const recovered = await processNextMutationJob(
			options(journal, restartRemote, restartEvaluator, scriptedClock(1_130, 1_140, 1_150, 1_160)),
		);

		expect(recovered).toEqual({ kind: "acknowledged", jobId: "local-job-1", phase: "ack" });
		expect(restartRemote.claimCalls).toHaveLength(0);
		expect(restartEvaluator.calls).toHaveLength(0);
		expect(restartRemote.ackCalls).toHaveLength(1);
		expect(journal.getJob("local-job-1")?.status).toBe("acked");
	});

	it("P5: an idempotently applied remote ack retries from the committed row after transport failure", async () => {
		const active = openWithJob();
		const applied = new Set<string>();
		let failResponseOnce = true;
		const remote = remoteHarness(
			async () => ({ kind: "terminal", evidence: { complete: true } }),
			async (_job, ack) => {
				applied.add(`${ack.jobId}:${ack.resultHash}`);
				if (failResponseOnce) {
					failResponseOnce = false;
					throw new Error("ack response lost");
				}
			},
		);
		const evaluator = evaluatorHarness();

		const first = await processNextMutationJob(
			options(active, remote, evaluator, scriptedClock(100, 110, 120, 130, 140)),
		);
		expect(first).toMatchObject({ kind: "retry", stage: "remote_ack" });
		expect(active.getJob("local-job-1")?.status).toBe("evaluated");
		active.close();
		journal = openMutationJournal(root);
		expect(await processNextMutationJob(
			options(journal, remote, evaluator, scriptedClock(150)),
		)).toEqual({ kind: "idle" });

		const second = await processNextMutationJob(
			options(journal, remote, evaluator, scriptedClock(1_140, 1_150, 1_160, 1_170)),
		);
		expect(second).toEqual({ kind: "acknowledged", jobId: "local-job-1", phase: "ack" });
		expect(remote.claimCalls).toHaveLength(1);
		expect(evaluator.calls).toHaveLength(1);
		expect(remote.ackCalls).toHaveLength(2);
		expect(applied).toEqual(new Set([`local-job-1:${RESULT_HASH}`]));
	});

	it("N3: an expired lease before commit fences persistence and acknowledgement", async () => {
		const active = openWithJob();
		const remote = remoteHarness(async () => ({ kind: "terminal", evidence: { complete: true } }));
		const evaluator = evaluatorHarness();

		const outcome = await processNextMutationJob(
			options(active, remote, evaluator, scriptedClock(100, 110, 2_000)),
		);

		expect(outcome).toEqual({
			kind: "retry",
			jobId: "local-job-1",
			stage: "commit",
			reason: "lease expired before commit",
		});
		expect(active.getEvaluation("local-job-1")).toBeNull();
		expect(active.getJob("local-job-1")).toMatchObject({
			nextAttemptAtMs: 3_000,
			lastError: "commit: lease expired before commit",
		});
		expect(remote.ackCalls).toHaveLength(0);
	});

	it("N4: an expired lease after commit prevents the remote ack", async () => {
		const active = openWithJob();
		const remote = remoteHarness(async () => ({ kind: "terminal", evidence: { complete: true } }));
		const evaluator = evaluatorHarness();

		const outcome = await processNextMutationJob(
			options(active, remote, evaluator, scriptedClock(100, 110, 120, 2_000)),
		);

		expect(outcome).toEqual({
			kind: "retry",
			jobId: "local-job-1",
			stage: "remote_ack",
			reason: "lease expired before remote_ack",
		});
		expect(active.getJob("local-job-1")?.status).toBe("evaluated");
		expect(active.getJob("local-job-1")?.nextAttemptAtMs).toBe(3_000);
		expect(remote.ackCalls).toHaveLength(0);
	});

	it("N5: losing the fence after a remote ack leaves the journal retryable, never falsely acknowledged", async () => {
		const active = openWithJob();
		const remote = remoteHarness(async () => ({ kind: "terminal", evidence: { complete: true } }));
		const evaluator = evaluatorHarness();

		const outcome = await processNextMutationJob(
			options(active, remote, evaluator, scriptedClock(100, 110, 120, 130, 2_000)),
		);

		expect(outcome).toEqual({
			kind: "retry",
			jobId: "local-job-1",
			stage: "journal_ack",
			reason: "lease expired before journal_ack",
		});
		expect(remote.ackCalls).toHaveLength(1);
		expect(active.getJob("local-job-1")?.status).toBe("evaluated");
	});
});
