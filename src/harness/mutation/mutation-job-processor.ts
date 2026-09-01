// =========================================================
// Durable mutation jobs — one immediate/background processor
// =========================================================

import type {
	ClaimedMutationJob,
	CommitMutationEvaluation,
	JournalManifestHead,
	MutationManifestAuthority,
	MutationJournal,
	MutationJournalAck,
} from "./mutation-journal-types.js";
import { hasExactJsonKeys } from "./mutation-cloud-v3-http.js";

export interface RemoteMutationJobIdentity {
	remoteJobId: string;
	acceptanceReceiptHash: string;
}

export interface RemoteMutationJobClient {
	/** Claim or poll the remote result. The outer shape is checked here; the
	 * injected evaluator owns authentication and evidence-schema validation. */
	claimResult(job: RemoteMutationJobIdentity): Promise<unknown>;
	/** The branded ack can only be obtained from a committed journal row. */
	acknowledge(job: RemoteMutationJobIdentity, ack: MutationJournalAck): Promise<void>;
}

export type CommitMutationEvaluationDraft = Omit<
	CommitMutationEvaluation,
	| "jobId"
	| "leaseToken"
	| "nowMs"
	| "acceptanceReceiptHash"
	| "manifestAuthority"
	| "expectedManifestVersion"
>;

export interface MutationJobEvaluator {
	evaluate(input: {
		job: Readonly<ClaimedMutationJob>;
		evidence: unknown;
		manifestHead: Readonly<JournalManifestHead>;
	}): Promise<CommitMutationEvaluationDraft>;
}

interface MutationJobProcessorOptions {
	journal: MutationJournal;
	remote: RemoteMutationJobClient;
	evaluator: MutationJobEvaluator;
	authority: MutationManifestAuthority;
	owner: string;
	leaseMs: number;
	clock?: () => number;
}

type MutationJobProcessorStage =
	| "poll"
	| "parse"
	| "evaluate"
	| "commit"
	| "remote_ack"
	| "journal_ack";

export type MutationJobProcessorOutcome =
	| { kind: "idle" }
	| { kind: "pending"; jobId: string }
	| { kind: "acknowledged"; jobId: string; phase: "poll" | "ack" }
	| { kind: "retry"; jobId: string; stage: MutationJobProcessorStage; reason: string }
	| { kind: "dead_letter"; jobId: string; stage: MutationJobProcessorStage; reason: string; failureCount: number }
	| { kind: "lost_lease"; jobId: string; stage: MutationJobProcessorStage };

type ParsedRemoteResult =
	| { kind: "pending" }
	| { kind: "terminal"; evidence: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRemoteResult(value: unknown): ParsedRemoteResult {
	if (!isRecord(value)) throw new Error("remote mutation result must be an object");
	if (value.kind === "pending" && hasExactJsonKeys(value, ["kind"])) return { kind: "pending" };
	if (value.kind === "terminal" && hasExactJsonKeys(value, ["kind", "evidence"])) {
		if (value.evidence === undefined) throw new Error("terminal mutation result is missing evidence");
		return { kind: "terminal", evidence: value.evidence };
	}
	throw new Error("remote mutation result must be exactly pending or terminal evidence");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function remoteIdentity(job: ClaimedMutationJob): RemoteMutationJobIdentity {
	return {
		remoteJobId: job.remoteJobId,
		acceptanceReceiptHash: job.acceptanceReceiptHash,
	};
}

function manifestAuthority(job: ClaimedMutationJob): MutationManifestAuthority {
	return {
		tenant: job.expectedJob.tenant,
		project: job.expectedJob.project,
		repository: job.expectedJob.repository,
	};
}

function claimedAuthorityMatches(
	job: ClaimedMutationJob,
	authority: MutationManifestAuthority,
): boolean {
	const claimed = manifestAuthority(job);
	return claimed.tenant === authority.tenant &&
		claimed.project === authority.project &&
		claimed.repository === authority.repository;
}

function processAuthorityMismatch(
	options: MutationJobProcessorOptions,
	job: ClaimedMutationJob,
	clock: () => number,
): MutationJobProcessorOutcome | null {
	if (claimedAuthorityMatches(job, options.authority)) return null;
	return releaseForRetry(
		options,
		job,
		"poll",
		new Error("claimed mutation job authority differs from the configured runtime"),
		clock,
	);
}

function releaseForRetry(
	options: MutationJobProcessorOptions,
	job: ClaimedMutationJob,
	stage: MutationJobProcessorStage,
	error: unknown,
	clock: () => number,
): MutationJobProcessorOutcome {
	const reason = errorMessage(error);
	try {
		const scheduled = options.journal.scheduleRetry({
			jobId: job.jobId,
			leaseToken: job.leaseToken,
			nowMs: clock(),
			kind: "failure",
			error: `${stage}: ${reason}`,
		});
		if (scheduled === null) return { kind: "lost_lease", jobId: job.jobId, stage };
		if (scheduled.kind === "dead_letter") {
			return { kind: "dead_letter", jobId: job.jobId, stage, reason, failureCount: scheduled.failureCount };
		}
	} catch (releaseError) {
		return {
			kind: "retry",
			jobId: job.jobId,
			stage,
			reason: `${reason}; retry scheduling failed: ${errorMessage(releaseError)}`,
		};
	}
	return { kind: "retry", jobId: job.jobId, stage, reason };
}

function deferPendingResult(
	options: MutationJobProcessorOptions,
	job: ClaimedMutationJob,
	clock: () => number,
): MutationJobProcessorOutcome {
	try {
		const scheduled = options.journal.scheduleRetry({
			jobId: job.jobId,
			leaseToken: job.leaseToken,
			nowMs: clock(),
			kind: "pending",
		});
		return scheduled === null
			? { kind: "lost_lease", jobId: job.jobId, stage: "poll" }
			: { kind: "pending", jobId: job.jobId };
	} catch (error) {
		return { kind: "retry", jobId: job.jobId, stage: "poll", reason: errorMessage(error) };
	}
}

function renewForStage(
	options: MutationJobProcessorOptions,
	job: ClaimedMutationJob,
	stage: MutationJobProcessorStage,
	nowMs: number,
): MutationJobProcessorOutcome | null {
	try {
		const renewed = options.journal.renew({
			jobId: job.jobId,
			leaseToken: job.leaseToken,
			nowMs,
			leaseMs: options.leaseMs,
		});
		return renewed
			? null
			: releaseForRetry(options, job, stage, new Error(`lease expired before ${stage}`), () => nowMs);
	} catch (error) {
		return releaseForRetry(options, job, stage, error, () => nowMs);
	}
}

async function acknowledgeCommitted(
	options: MutationJobProcessorOptions,
	job: ClaimedMutationJob,
	ack: MutationJournalAck,
	phase: "poll" | "ack",
	clock: () => number,
): Promise<MutationJobProcessorOutcome> {
	const lease = renewForStage(options, job, "remote_ack", clock());
	if (lease !== null) return lease;
	try {
		await options.remote.acknowledge(remoteIdentity(job), ack);
	} catch (error) {
		return releaseForRetry(options, job, "remote_ack", error, clock);
	}
	const journalLease = renewForStage(options, job, "journal_ack", clock());
	if (journalLease !== null) return journalLease;
	try {
		if (!options.journal.acknowledge(ack, clock())) {
			return { kind: "lost_lease", jobId: job.jobId, stage: "journal_ack" };
		}
	} catch (error) {
		return releaseForRetry(options, job, "journal_ack", error, clock);
	}
	return { kind: "acknowledged", jobId: job.jobId, phase };
}

async function processPollClaim(
	options: MutationJobProcessorOptions,
	job: ClaimedMutationJob,
	clock: () => number,
): Promise<MutationJobProcessorOutcome> {
	let rawResult: unknown;
	try {
		rawResult = await options.remote.claimResult(remoteIdentity(job));
	} catch (error) {
		return releaseForRetry(options, job, "poll", error, clock);
	}

	let result: ParsedRemoteResult;
	try {
		result = parseRemoteResult(rawResult);
	} catch (error) {
		return releaseForRetry(options, job, "parse", error, clock);
	}
	if (result.kind === "pending") {
		return deferPendingResult(options, job, clock);
	}

	const evaluatorLease = renewForStage(options, job, "evaluate", clock());
	if (evaluatorLease !== null) return evaluatorLease;
	const authority = manifestAuthority(job);
	const manifestHead = options.journal.getManifestHead(authority);
	if (manifestHead === null) {
		return releaseForRetry(options, job, "evaluate", new Error("mutation manifest head is not initialized"), clock);
	}
	let draft: CommitMutationEvaluationDraft;
	try {
		draft = await options.evaluator.evaluate({ job, evidence: result.evidence, manifestHead });
	} catch (error) {
		return releaseForRetry(options, job, "evaluate", error, clock);
	}

	const commitAtMs = clock();
	const commitLease = renewForStage(options, job, "commit", commitAtMs);
	if (commitLease !== null) return commitLease;
	let ack: MutationJournalAck;
	try {
		const committed = options.journal.commitEvaluation({
			...draft,
			jobId: job.jobId,
			leaseToken: job.leaseToken,
			nowMs: commitAtMs,
			acceptanceReceiptHash: job.acceptanceReceiptHash,
			manifestAuthority: authority,
			expectedManifestVersion: manifestHead.version,
		});
		ack = committed.ack;
	} catch (error) {
		return releaseForRetry(options, job, "commit", error, clock);
	}
	return acknowledgeCommitted(options, job, ack, "poll", clock);
}

async function processClaimedMutationJob(
	options: MutationJobProcessorOptions,
	job: ClaimedMutationJob,
	clock: () => number,
): Promise<MutationJobProcessorOutcome> {
	if (job.phase === "ack") {
		if (job.ack === undefined) {
			return releaseForRetry(options, job, "journal_ack", new Error("ack-phase job has no journal ack"), clock);
		}
		return acknowledgeCommitted(options, job, job.ack, "ack", clock);
	}
	return processPollClaim(options, job, clock);
}

/** Process one specific newly-submitted job without letting an older pending
 * row steal the immediate poll. Background workers use processNextMutationJob
 * and reach this exact processor after their queue claim. */
export async function processMutationJobById(
	options: MutationJobProcessorOptions,
	jobId: string,
): Promise<MutationJobProcessorOutcome> {
	const clock = options.clock ?? Date.now;
	const job = options.journal.claimJob({
		jobId,
		authority: options.authority,
		owner: options.owner,
		nowMs: clock(),
		leaseMs: options.leaseMs,
	});
	if (job === null) return { kind: "idle" };
	const mismatch = processAuthorityMismatch(options, job, clock);
	if (mismatch !== null) return mismatch;
	return processClaimedMutationJob(options, job, clock);
}

/** Process at most one durable mutation job. Background callers invoke this
 * on a timer; it shares every post-claim step with the immediate keyed path. */
export async function processNextMutationJob(
	options: MutationJobProcessorOptions,
): Promise<MutationJobProcessorOutcome> {
	const clock = options.clock ?? Date.now;
	const job = options.journal.claimNext({
		authority: options.authority,
		owner: options.owner,
		nowMs: clock(),
		leaseMs: options.leaseMs,
	});
	if (job === null) return { kind: "idle" };
	const mismatch = processAuthorityMismatch(options, job, clock);
	return mismatch ?? processClaimedMutationJob(options, job, clock);
}
