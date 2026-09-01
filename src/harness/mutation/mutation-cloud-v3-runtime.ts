// =========================================================
// Mutation cloud v3 — one durable CLI runtime composition
// =========================================================
// Submission, immediate polling, later polling after restart, and remote
// acknowledgement all meet here.  This module deliberately owns no mutation
// policy: every terminal result goes through ProtocolV3MutationJobEvaluator,
// and every acknowledgement is minted by the SQLite journal after its atomic
// evaluation transaction commits.

import { emptyManifest } from "./manifest.js";
import {
	MutationCloudV3Client,
	type MutationCloudFetch,
	type MutationCloudV3ClientConfig,
} from "./mutation-cloud-v3-client.js";
import {
	MutationCloudV3Submitter,
	type MutationCloudSubmissionFetch,
	type MutationCloudV3SubmissionConfig,
	type SubmitMutationJobInput,
	type SubmitMutationJobOutcome,
} from "./mutation-cloud-v3-submission.js";
import {
	deliverOneMutationFinding,
	type MutationFindingDeliveryOutcome,
} from "./mutation-cloud-v3-finding-delivery.js";
import { prepareMutationCloudV3PerEdit } from "./mutation-cloud-v3-per-edit.js";
import {
	activateMutationCloudOnboarding,
	type MutationCloudV3OnboardingDependencies,
	type MutationCloudV3OnboardingOutcome,
} from "./mutation-cloud-v3-onboarding.js";
import {
	processMutationJobById,
	processNextMutationJob,
	type MutationJobProcessorOutcome,
} from "./mutation-job-processor.js";
import { openMutationJournal } from "./mutation-journal-sqlite.js";
import type {
	DeadLetteredMutationJob,
	JournalEvaluationView,
	MutationManifestAuthority,
	MutationJournal,
} from "./mutation-journal-types.js";
import {
	ProtocolV3MutationJobEvaluator,
	type ProtocolV3MutationJobEvaluatorOptions,
} from "./protocol-v3-job-evaluator.js";

export interface MutationCloudV3RuntimeConfig {
	submission: MutationCloudV3SubmissionConfig;
	client: MutationCloudV3ClientConfig;
	evaluator: Omit<ProtocolV3MutationJobEvaluatorOptions, "clock">;
	owner: string;
	leaseMs: number;
}

interface MutationCloudV3RuntimeDependencies {
	journal?: MutationJournal;
	submissionFetch?: MutationCloudSubmissionFetch;
	clientFetch?: MutationCloudFetch;
	clockMs?: () => number;
	onboarding?: MutationCloudV3OnboardingDependencies;
	preparePerEdit?: typeof prepareMutationCloudV3PerEdit;
}

export interface MutationCloudV3ProcessResult {
	processor: MutationJobProcessorOutcome;
	/** Present as soon as SQLite committed the authenticated local decision,
	 * including when the subsequent remote acknowledgement must be retried. */
	evaluation: JournalEvaluationView | null;
}

export interface MutationCloudV3SubmitResult {
	submission: SubmitMutationJobOutcome;
	immediate: MutationCloudV3ProcessResult;
}

export interface MutationCloudV3OnboardResult {
	onboarding: MutationCloudV3OnboardingOutcome;
	immediate: MutationCloudV3ProcessResult;
}

export interface MutationCloudV3RedriveResult {
	kind: "redriven";
	jobId: string;
	/** The row is eligible to be claimed at this time. Redrive itself never
	 * claims, evaluates, acknowledges, or returns a mutation verdict. */
	dueAtMs: number;
}

function evaluationFor(journal: MutationJournal, outcome: MutationJobProcessorOutcome): JournalEvaluationView | null {
	return "jobId" in outcome ? journal.getEvaluation(outcome.jobId) : null;
}

function runtimeManifestAuthority(config: MutationCloudV3RuntimeConfig): MutationManifestAuthority {
	return {
		tenant: config.submission.serverAuthority.tenant,
		project: config.submission.serverAuthority.project,
		repository: config.submission.repository,
	};
}

function validateRuntimeConfig(config: MutationCloudV3RuntimeConfig): void {
	if (config.owner.length === 0) throw new Error("mutation cloud runtime owner is required");
	if (!Number.isSafeInteger(config.leaseMs) || config.leaseMs <= 0) {
		throw new Error("mutation cloud runtime leaseMs must be a positive safe integer");
	}
	if (config.submission.baseUrl !== config.client.baseUrl) {
		throw new Error("mutation cloud submission and result clients must use one baseUrl");
	}
	if (config.submission.token !== config.client.token) {
		throw new Error("mutation cloud submission and result clients must use one credential");
	}
	if (config.submission.projectRef !== config.client.projectRef) {
		throw new Error("mutation cloud submission and result clients must use one projectRef");
	}
	if (config.submission.timeoutMs !== config.client.timeoutMs) {
		throw new Error("mutation cloud submission and result clients must use one timeoutMs");
	}
	if (config.leaseMs < config.client.timeoutMs * 3) {
		throw new Error("mutation cloud leaseMs must be at least 3 × timeoutMs");
	}
	if (
		config.submission.serverAuthority.tenant !== config.evaluator.serverAuthority.tenant ||
		config.submission.serverAuthority.project !== config.evaluator.serverAuthority.project
	) {
		throw new Error("mutation cloud submission and evaluator must use one authenticated authority");
	}
}

/**
 * The real opt-in CLI composition.  Opening it never submits work and never
 * enables the edit gate.  It only opens the local SQLite journal, captures
	 * no legacy file scan or import. It seeds only this configured
	 * tenant/project/repository's authoritative journal head.
 */
export class MutationCloudV3Runtime {
	readonly #journal: MutationJournal;
	readonly #submitter: MutationCloudV3Submitter;
	readonly #client: MutationCloudV3Client;
	readonly #evaluator: ProtocolV3MutationJobEvaluator;
	readonly #owner: string;
	readonly #leaseMs: number;
	readonly #clockMs: () => number;
	readonly #ownsJournal: boolean;
	readonly #config: MutationCloudV3RuntimeConfig;
	readonly #onboarding: MutationCloudV3OnboardingDependencies;
	readonly #preparePerEdit: typeof prepareMutationCloudV3PerEdit;

	constructor(
		readonly root: string,
		config: MutationCloudV3RuntimeConfig,
		dependencies: MutationCloudV3RuntimeDependencies = {},
	) {
		validateRuntimeConfig(config);
		this.#config = config;
		this.#onboarding = dependencies.onboarding ?? {};
		this.#preparePerEdit = dependencies.preparePerEdit ?? prepareMutationCloudV3PerEdit;
		this.#clockMs = dependencies.clockMs ?? Date.now;
		this.#owner = config.owner;
		this.#leaseMs = config.leaseMs;
		this.#submitter = new MutationCloudV3Submitter(
			config.submission,
			dependencies.submissionFetch,
			this.#clockMs,
		);
		this.#client = new MutationCloudV3Client(config.client, dependencies.clientFetch);
		this.#evaluator = new ProtocolV3MutationJobEvaluator({
			...config.evaluator,
			clock: () => new Date(this.#clockMs()).toISOString(),
		});
		// Validate every network/trust component before opening a file handle.
		this.#journal = dependencies.journal ?? openMutationJournal(root);
		this.#ownsJournal = dependencies.journal === undefined;

		try {
			const authority = runtimeManifestAuthority(config);
			if (this.#journal.getManifestHead(authority) === null) {
				const at = new Date(this.#clockMs()).toISOString();
				this.#journal.initializeManifestHead({
					authority,
					snapshot: emptyManifest({
						engine: "",
						engineVersion: "",
						dependencyGraphVersion: "",
						environmentHash: "",
						authoritativeAt: at,
					}),
					initializedAtMs: this.#clockMs(),
				});
			}
		} catch (error) {
			if (this.#ownsJournal) this.#journal.close();
			throw error;
		}
	}

	/** Submit, journal the authenticated acceptance, and make one immediate
	 * processing attempt.  A pending result remains leased remotely only for
	 * the claim call and remains pending locally for a later invocation. */
	async submit(input: Omit<SubmitMutationJobInput, "journal">): Promise<MutationCloudV3SubmitResult> {
		const submission = await this.#submitter.submit({ ...input, journal: this.#journal });
		return { submission, immediate: await this.#processJob(submission.jobId) };
	}

	/** Prepare immutable HEAD plus the caller-supplied current target overlay,
	 * then submit its exact request/artifact/target tuple. This explicit path
	 * never adopts a baseline and never enables the live edit gate. */
	async submitEdit(targetFile: string, proposedBytes: Uint8Array): Promise<MutationCloudV3SubmitResult> {
		const prepared = this.#preparePerEdit({
			root: this.root,
			targetFile,
			proposedBytes,
			authority: {
				tenant: this.#config.submission.serverAuthority.tenant,
				project: this.#config.submission.serverAuthority.project,
				repository: this.#config.submission.repository,
			},
		});
		return await this.submit({ ...prepared, createdAtMs: this.#clockMs() });
	}

	/** Capture one clean immutable HEAD, authenticate it remotely, atomically
	 * activate adopt_current, then use the same single evaluator as all jobs. */
	async onboard(targetFile: string): Promise<MutationCloudV3OnboardResult> {
		const onboarding = await activateMutationCloudOnboarding({
			root: this.root,
			targetFile,
			repository: this.#config.submission.repository,
			tenant: this.#config.submission.serverAuthority.tenant,
			project: this.#config.submission.serverAuthority.project,
			journal: this.#journal,
			submitter: this.#submitter,
			clockMs: this.#clockMs,
		}, this.#onboarding);
		return { onboarding, immediate: await this.#processJob(onboarding.jobId) };
	}

	async #processJob(jobId: string): Promise<MutationCloudV3ProcessResult> {
		const processor = await processMutationJobById({
			journal: this.#journal,
			remote: this.#client,
			evaluator: this.#evaluator,
			authority: runtimeManifestAuthority(this.#config),
			owner: this.#owner,
			leaseMs: this.#leaseMs,
			clock: this.#clockMs,
		}, jobId);
		return { processor, evaluation: evaluationFor(this.#journal, processor) };
	}

	/** The same processor used after submission and after a process restart. */
	async processNext(): Promise<MutationCloudV3ProcessResult> {
		const processor = await processNextMutationJob({
			journal: this.#journal,
			remote: this.#client,
			evaluator: this.#evaluator,
			authority: runtimeManifestAuthority(this.#config),
			owner: this.#owner,
			leaseMs: this.#leaseMs,
			clock: this.#clockMs,
		});
		return { processor, evaluation: evaluationFor(this.#journal, processor) };
	}

	/** Deliver at most one committed finding after the SQLite evaluation
	 * transaction. The append is fsynced before its exact outbox lease is
	 * acknowledged; a daemon restart therefore retries rather than losing it. */
	async deliverOneFinding(): Promise<MutationFindingDeliveryOutcome> {
		return await deliverOneMutationFinding({
			root: this.root,
			owner: this.#owner,
			leaseMs: Math.min(this.#leaseMs, 60_000),
			journal: this.#journal,
			clock: this.#clockMs,
		});
	}

	/** Inspect bounded dead-letter state without claiming or processing rows. */
	listDeadLetters(limit: number): DeadLetteredMutationJob[] {
		return this.#journal.listDeadLetters(limit);
	}

	/** Make one token-fenced dead letter due again. The journal retains its
	 * underlying pending/evaluated status, so a poll row resumes polling and an
	 * evaluated row resumes acknowledgement only. */
	redriveDeadLetter(jobId: string, redriveToken: string): MutationCloudV3RedriveResult {
		const dueAtMs = this.#clockMs();
		const redriven = this.#journal.redriveDeadLetter({ jobId, redriveToken, nowMs: dueAtMs });
		if (!redriven) {
			throw new Error(`mutation cloud dead letter "${jobId}" was not found or its redrive token is stale`);
		}
		return { kind: "redriven", jobId, dueAtMs };
	}

	close(): void {
		if (this.#ownsJournal) this.#journal.close();
	}
}
