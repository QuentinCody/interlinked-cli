// interlinked-tdd: exempt -- durable-journal contract types; executable
// state transitions live in mutation-journal-sqlite.ts and its companion test.
// ===========================================
// Durable mutation journal — public contracts
// ===========================================

import type { V3SourceArtifactBinding } from "./protocol-v3/types.js";

type MutationJobStatus = "pending" | "evaluated" | "acked" | "dead_letter";
type MutationClaimPhase = "poll" | "ack";
export type MutationBaselineIntent = "require_established" | "adopt_current";

/** Caller-derived job binding retained before any remote result is trusted. */
interface JournalExpectedJob {
	tenant: string;
	project: string;
	repository: string;
	commit: string;
	target_file: string;
	target_content_hash: string;
	job_key: string;
}

/** Caller-derived admission identity; never reconstructed from a response. */
interface JournalExpectedAdmission {
	request_hash: string;
	changeset_hash: string;
	/** Caller-held source bundle binding submitted for admission. This must
	 * never be reconstructed from a remote receipt or result envelope. */
	source_artifact: V3SourceArtifactBinding;
}

export interface EnqueueMutationJob {
	jobId: string;
	remoteJobId: string;
	acceptanceReceiptHash: string;
	expectedJob: JournalExpectedJob;
	expectedAdmission: JournalExpectedAdmission;
	/** Exact proposed target bytes submitted for measurement. */
	targetBytes: Uint8Array;
	targetSha256: string;
	baselineIntent: MutationBaselineIntent;
	createdAtMs: number;
}

export interface MutationOnboardingBinding {
	tenant: string;
	project: string;
	repository: string;
	commit: string;
	targetFile: string;
}

/** Exact immutable-HEAD onboarding material persisted before network I/O. */
export interface PrepareMutationOnboardingIntent extends MutationOnboardingBinding {
	formatVersion: 1;
	jobKey: string;
	requestBytes: Uint8Array;
	requestSha256: string;
	sourceArtifactId: string;
	sourceArtifactFormat: "git-archive-tar-v1";
	sourceArtifactBytes: Uint8Array;
	sourceArtifactSha256: string;
	targetBytes: Uint8Array;
	targetSha256: string;
	requestHash: string;
	changesetHash: string;
	createdAtMs: number;
}

export interface MutationOnboardingIntent extends PrepareMutationOnboardingIntent {
	state: "prepared" | "accepted" | "activated";
	acceptanceReceiptHash: string | null;
	activatedAtMs: number | null;
}

export type PrepareMutationOnboardingOutcome =
	| { kind: "prepared"; intent: MutationOnboardingIntent }
	| { kind: "replay"; intent: MutationOnboardingIntent };

export type ActivateMutationOnboardingIntent =
	| { kind: "accept"; jobKey: string; acceptanceReceiptHash: string }
	| { kind: "activate"; jobKey: string; activatedAtMs: number };

export type ActivateMutationOnboardingOutcome =
	| { kind: "accepted"; jobId: string }
	| { kind: "activated"; jobId: string }
	| { kind: "replay"; jobId: string; state: "accepted" | "activated" };

export interface ClaimMutationJob {
	/** Exact caller-held authority. A worker cannot lease another runtime's
	 * rows, even when both runtimes share one local journal. */
	authority: MutationManifestAuthority;
	owner: string;
	nowMs: number;
	leaseMs: number;
}

export interface ClaimMutationJobById extends ClaimMutationJob {
	jobId: string;
}

export interface RenewMutationLease {
	jobId: string;
	leaseToken: string;
	nowMs: number;
	leaseMs: number;
}

export interface ReleaseMutationLease {
	jobId: string;
	leaseToken: string;
	nowMs: number;
}

export interface RedriveDeadLetter {
	jobId: string;
	redriveToken: string;
	nowMs: number;
}

interface ScheduleMutationRetryBase {
	jobId: string;
	leaseToken: string;
	nowMs: number;
}

/** A normal not-ready response is deferred without consuming the failure
 * budget. Operational/parser/evaluator failures use the bounded failure
 * budget and retain their most recent diagnostic. */
export type ScheduleMutationRetry =
	| (ScheduleMutationRetryBase & { kind: "pending" })
	| (ScheduleMutationRetryBase & { kind: "failure"; error: string });

export type ScheduleMutationRetryOutcome =
	| { kind: "scheduled"; nextAttemptAtMs: number; failureCount: number }
	| { kind: "dead_letter"; failureCount: number; lastError: string };

export interface ClaimedMutationJob extends EnqueueMutationJob {
	phase: MutationClaimPhase;
	leaseToken: string;
	leaseExpiresAtMs: number;
	claimCount: number;
	/** Present in the journal-before-ack phase. */
	committedResult?: {
		resultHash: string;
		evaluatorPolicyVersion: string;
	};
	/** Re-minted from committed rows when `phase === "ack"`, including after
	 * restart/lease recovery. */
	ack?: MutationJournalAck;
}

export interface JournalFinding {
	findingId: string;
	payload: unknown;
}

export interface JournalManifestHead {
	readonly version: number;
	readonly snapshot: unknown;
	readonly hash: string;
}

/** Exact caller-held authority for one v3 baseline lineage. Manifest state is
 * never shared across tenants, projects, or repositories.
 *
 * The contract digest and evaluator policy version are deliberately not part
 * of this key: a manifest stores mechanical mutant identities/statuses, never
 * a prior clean verdict or policy decision. Every new result is authenticated
 * under the currently pinned contract and re-evaluated under the current
 * policy; a missing prior mutant in an unchanged symbol makes that evaluation
 * not-measured rather than clean. Evaluation rows and receipts retain the
 * policy version separately for audit and replay identity. */
export interface MutationManifestAuthority {
	tenant: string;
	project: string;
	repository: string;
}

/** Canonical authenticated JSON retained for offline verification. The
 * original HTTP whitespace and object-key order are intentionally not part of
 * the durable contract; the protocol canonical form is. */
export interface JournalRetainedCanonicalJson {
	canonicalJson: string;
	sha256: string;
}

/** Exact report bytes that passed protocol verification. */
export interface JournalRetainedReport {
	bytes: Uint8Array;
	sha256: string;
}

/** Format v1 is a complete, replayable authenticated evidence projection.
 * Exactly one receipt arm is present. A report is absent only when the
 * authenticated envelope carries no report pointer. */
export interface JournalRetainedEvidence {
	formatVersion: 1;
	envelope: JournalRetainedCanonicalJson;
	acceptanceReceipt: JournalRetainedCanonicalJson;
	executionReceipt: JournalRetainedCanonicalJson | null;
	terminalizationRecord: JournalRetainedCanonicalJson | null;
	report: JournalRetainedReport | null;
}

export interface InitializeMutationManifestHead {
	authority: MutationManifestAuthority;
	snapshot: unknown;
	initializedAtMs: number;
}

export type InitializeManifestHeadOutcome =
	| { kind: "initialized"; head: JournalManifestHead }
	| { kind: "existing"; head: JournalManifestHead };

export interface CommitMutationEvaluation {
	jobId: string;
	leaseToken: string;
	nowMs: number;
	manifestAuthority: MutationManifestAuthority;
	expectedManifestVersion: number;
	acceptanceReceiptHash: string;
	resultHash: string;
	authenticatedEvidenceHash: string;
	evaluatorPolicyVersion: string;
	retainedEvidence: JournalRetainedEvidence;
	evaluation: unknown;
	decision: unknown;
	manifestSnapshot: unknown;
	receipt: unknown;
	runRow: unknown;
	findings: readonly JournalFinding[];
}

declare const JOURNAL_ACK: unique symbol;

/** Minted only after the evaluation transaction commits. Safe to use as the
 * remote acknowledgement input; if acknowledgement crashes, the journal
 * retains an `evaluated` row for restart-safe retry. */
export interface MutationJournalAck {
	readonly jobId: string;
	readonly leaseToken: string;
	readonly acceptanceReceiptHash: string;
	readonly resultHash: string;
	readonly evaluatorPolicyVersion: string;
	readonly [JOURNAL_ACK]: true;
}

export type CommitEvaluationOutcome =
	| { kind: "committed"; ack: MutationJournalAck }
	| { kind: "replay"; ack: MutationJournalAck };

export interface JournalJobView {
	jobId: string;
	status: MutationJobStatus;
	leaseOwner: string | null;
	leaseToken: string | null;
	leaseExpiresAtMs: number | null;
	claimCount: number;
	acceptanceReceiptHash: string;
	nextAttemptAtMs: number;
	failureCount: number;
	lastError: string | null;
	deadLetteredAtMs: number | null;
	deadLetterToken: string | null;
}

export interface DeadLetteredMutationJob {
	jobId: string;
	phase: MutationClaimPhase;
	failureCount: number;
	lastError: string;
	deadLetteredAtMs: number;
	redriveToken: string;
}

export interface JournalEvaluationView {
	jobId: string;
	acceptanceReceiptHash: string;
	resultHash: string;
	authenticatedEvidenceHash: string;
	evaluatorPolicyVersion: string;
	evaluation: unknown;
	decision: unknown;
	manifestSnapshot: unknown;
	manifestBaseVersion: number;
	manifestCommittedVersion: number;
	manifestSnapshotHash: string;
	receipt: unknown;
	runRow: unknown;
	findings: JournalFinding[];
	/** Present for every schema-v6 journal read. Optional only so external
	 * read-view mocks from the v5 API remain source-compatible. */
	retainedEvidence?: JournalRetainedEvidence;
}

export interface ClaimedOutboxEntry {
	outboxId: string;
	evaluationId: number;
	topic: "mutation.finding";
	payload: unknown;
	leaseToken: string;
	leaseExpiresAtMs: number;
	attemptCount: number;
}

export interface OutboxLeaseRef {
	outboxId: string;
	leaseToken: string;
	nowMs: number;
}

export interface RenewOutboxLease extends OutboxLeaseRef {
	leaseMs: number;
}

/** Raw compatibility capture for audit only. Legacy JSON/JSONL bytes never
 * mint or replace an authoritative v3 manifest head; v3 state is established
 * only through its authenticated authority-bound workflow. */
export interface LegacyMutationImport {
	sourceId: string;
	capturedAtMs: number;
	pendingRuns?: unknown;
	manifestSnapshot?: unknown;
	receipts?: unknown;
	runRows?: unknown;
}

export type JournalFaultPoint =
	| "before_transaction"
	| "after_manifest_head_update"
	| "inside_transaction"
	| "inside_onboarding_activation"
	| "after_commit";

export interface MutationJournalOptions {
	faultInjector?: (point: JournalFaultPoint) => void;
}

export interface MutationJournal {
	readonly path: string;
	enqueue(input: EnqueueMutationJob): "inserted" | "existing";
	getOnboardingIntent(input: MutationOnboardingBinding): MutationOnboardingIntent | null;
	prepareOnboardingIntent(input: PrepareMutationOnboardingIntent): PrepareMutationOnboardingOutcome;
	activateOnboardingIntent(input: ActivateMutationOnboardingIntent): ActivateMutationOnboardingOutcome;
	claimNext(input: ClaimMutationJob): ClaimedMutationJob | null;
	claimJob(input: ClaimMutationJobById): ClaimedMutationJob | null;
	renew(input: RenewMutationLease): boolean;
	release(input: ReleaseMutationLease): boolean;
	scheduleRetry(input: ScheduleMutationRetry): ScheduleMutationRetryOutcome | null;
	listDeadLetters(limit: number): DeadLetteredMutationJob[];
	redriveDeadLetter(input: RedriveDeadLetter): boolean;
	initializeManifestHead(input: InitializeMutationManifestHead): InitializeManifestHeadOutcome;
	getManifestHead(authority: MutationManifestAuthority): JournalManifestHead | null;
	commitEvaluation(input: CommitMutationEvaluation): CommitEvaluationOutcome;
	acknowledge(ack: MutationJournalAck, acknowledgedAtMs: number): boolean;
	getJob(jobId: string): JournalJobView | null;
	getEvaluation(jobId: string): JournalEvaluationView | null;
	claimOutbox(owner: string, nowMs: number, leaseMs: number): ClaimedOutboxEntry | null;
	renewOutbox(input: RenewOutboxLease): boolean;
	releaseOutbox(input: OutboxLeaseRef): boolean;
	acknowledgeOutbox(input: OutboxLeaseRef): boolean;
	importLegacy(input: LegacyMutationImport): "inserted" | "existing";
	close(): void;
}
