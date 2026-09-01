// =========================================================
// Mutation cloud v3 — durable prepare/authenticate/activate onboarding
// =========================================================

import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import {
	captureMutationOnboardingSource,
	MUTATION_ONBOARDING_ARCHIVE_PREFIX,
	MUTATION_ONBOARDING_SOURCE_FORMAT,
	type CapturedMutationOnboardingSource,
} from "./mutation-cloud-v3-onboarding-source.js";
import type { MutationCloudV3Submitter } from "./mutation-cloud-v3-submission.js";
import type {
	MutationJournal,
	MutationOnboardingIntent,
	PrepareMutationOnboardingIntent,
} from "./mutation-journal-types.js";
import { canonicalJson } from "./protocol-v3/canonical.js";
import { deriveAdmission, parseMutationJobRequestV3 } from "./protocol-v3/request.js";

const ONBOARDING_RANDOM_BYTES = 32;

type MutationCloudV3OnboardingFaultPoint =
	| "after_onboarding_prepare"
	| "after_onboarding_acceptance"
	| "after_onboarding_activation";

export interface MutationCloudV3OnboardingDependencies {
	captureSource?: (input: {
		root: string;
		repository: string;
		targetFile: string;
		maxTestScope?: number;
	}) => CapturedMutationOnboardingSource;
	randomBytes?: (size: number) => Uint8Array;
	faultInjector?: (point: MutationCloudV3OnboardingFaultPoint) => void;
}

interface ActivateMutationCloudOnboardingInput {
	root: string;
	targetFile: string;
	repository: string;
	tenant: string;
	project: string;
	journal: MutationJournal;
	submitter: MutationCloudV3Submitter;
	clockMs: () => number;
	maxTestScope?: number;
}

export interface MutationCloudV3OnboardingOutcome {
	kind: "activated";
	jobId: string;
	format: typeof MUTATION_ONBOARDING_SOURCE_FORMAT;
	preparedReplay: boolean;
	authenticatedReplay: boolean;
	activationReplay: boolean;
}

function mintJobKey(randomBytes: (size: number) => Uint8Array): string {
	const entropy = randomBytes(ONBOARDING_RANDOM_BYTES);
	if (!(entropy instanceof Uint8Array) || entropy.byteLength !== ONBOARDING_RANDOM_BYTES) {
		throw new Error(`mutation onboarding randomness must return exactly ${ONBOARDING_RANDOM_BYTES} bytes`);
	}
	return `job_onboard_${Buffer.from(entropy).toString("hex")}`;
}

function assertCapturedIdentity(args: {
	captured: CapturedMutationOnboardingSource;
	repository: string;
	targetFile: string;
}): void {
	const { captured } = args;
	if (captured.repository !== args.repository) {
		throw new Error("mutation onboarding captured a foreign repository identity");
	}
	if (captured.targetFile !== args.targetFile) {
		throw new Error("mutation onboarding captured a foreign target");
	}
	if (
		captured.format !== MUTATION_ONBOARDING_SOURCE_FORMAT ||
		captured.archivePrefix !== MUTATION_ONBOARDING_ARCHIVE_PREFIX
	) throw new Error("mutation onboarding captured a foreign source artifact format");
	const expectedArtifactId = `src_git_archive_v1_${captured.sourceArtifactSha256}`;
	if (captured.sourceArtifactId !== expectedArtifactId) {
		throw new Error("mutation onboarding captured a foreign source artifact identity");
	}
}

function buildPreparedIntent(args: {
	captured: CapturedMutationOnboardingSource;
	jobKey: string;
	tenant: string;
	project: string;
	createdAtMs: number;
}): PrepareMutationOnboardingIntent {
	const { captured } = args;
	const parsed = parseMutationJobRequestV3({
		request_version: "1",
		protocol_version: "interlinked-mutation/3.0",
		job: {
			tenant: args.tenant,
			project: args.project,
			repository: captured.repository,
			commit: captured.commit,
			target_file: captured.targetFile,
			target_content_hash: captured.targetSha256,
			job_key: args.jobKey,
		},
		source_artifact: {
			format: captured.format,
			artifact_id: captured.sourceArtifactId,
			sha256: captured.sourceArtifactSha256,
			bytes: captured.sourceArtifactBytes.byteLength,
		},
		scope_mode: captured.scopeMode,
		test_files: captured.testFiles,
		changeset: [{ path: captured.targetFile, content_hash: captured.targetSha256 }],
	});
	if (!parsed.ok) throw new Error(`mutation onboarding generated an invalid request: ${parsed.reason}`);
	const requestBytes = Buffer.from(canonicalJson(parsed.request), "utf8");
	const admission = deriveAdmission(parsed.request);
	return {
		formatVersion: 1,
		jobKey: args.jobKey,
		tenant: args.tenant,
		project: args.project,
		repository: captured.repository,
		commit: captured.commit,
		targetFile: captured.targetFile,
		requestBytes,
		requestSha256: createDigest(requestBytes),
		sourceArtifactId: captured.sourceArtifactId,
		sourceArtifactFormat: captured.format,
		sourceArtifactBytes: captured.sourceArtifactBytes,
		sourceArtifactSha256: captured.sourceArtifactSha256,
		targetBytes: captured.targetBytes,
		targetSha256: captured.targetSha256,
		requestHash: admission.request_hash,
		changesetHash: admission.changeset_hash,
		createdAtMs: args.createdAtMs,
	};
}

function createDigest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function existingIdentity(
	journal: MutationJournal,
	captured: CapturedMutationOnboardingSource,
	authority: { tenant: string; project: string },
): MutationOnboardingIntent | null {
	return journal.getOnboardingIntent({
		tenant: authority.tenant,
		project: authority.project,
		repository: captured.repository,
		commit: captured.commit,
		targetFile: captured.targetFile,
	});
}

/** Prepare exact bytes before networking; durable authenticated acceptance is
 * still unclaimable; only the final SQLite activation creates a pending job. */
export async function activateMutationCloudOnboarding(
	input: ActivateMutationCloudOnboardingInput,
	dependencies: MutationCloudV3OnboardingDependencies = {},
): Promise<MutationCloudV3OnboardingOutcome> {
	const captureSource = dependencies.captureSource ?? ((args) => captureMutationOnboardingSource(args));
	const randomBytes = dependencies.randomBytes ?? cryptoRandomBytes;
	const fault = dependencies.faultInjector ?? (() => {});
	const captured = captureSource({
		root: input.root,
		repository: input.repository,
		targetFile: input.targetFile,
		...(input.maxTestScope === undefined ? {} : { maxTestScope: input.maxTestScope }),
	});
	assertCapturedIdentity({ captured, repository: input.repository, targetFile: input.targetFile });
	const existing = existingIdentity(input.journal, captured, input);
	const prepared = input.journal.prepareOnboardingIntent(buildPreparedIntent({
		captured,
		jobKey: existing?.jobKey ?? mintJobKey(randomBytes),
		tenant: input.tenant,
		project: input.project,
		createdAtMs: existing?.createdAtMs ?? input.clockMs(),
	}));
	fault("after_onboarding_prepare");
	let intent = prepared.intent;
	let authenticatedReplay = intent.state !== "prepared";
	if (intent.state === "prepared") {
		const acceptance = await input.submitter.authenticatePrepared({
			requestBytes: intent.requestBytes,
			sourceArtifactBytes: intent.sourceArtifactBytes,
			targetBytes: intent.targetBytes,
		});
		input.journal.activateOnboardingIntent({
			kind: "accept",
			jobKey: intent.jobKey,
			acceptanceReceiptHash: acceptance.acceptanceReceiptHash,
		});
		intent = input.journal.getOnboardingIntent(intent) ?? intent;
		authenticatedReplay = acceptance.idempotentReplay;
		fault("after_onboarding_acceptance");
	}
	if (intent.state === "activated") {
		return {
			kind: "activated",
			jobId: intent.jobKey,
			format: MUTATION_ONBOARDING_SOURCE_FORMAT,
			preparedReplay: true,
			authenticatedReplay: true,
			activationReplay: true,
		};
	}
	input.journal.activateOnboardingIntent({
		kind: "activate",
		jobKey: intent.jobKey,
		activatedAtMs: input.clockMs(),
	});
	fault("after_onboarding_activation");
	return {
		kind: "activated",
		jobId: intent.jobKey,
		format: MUTATION_ONBOARDING_SOURCE_FORMAT,
		preparedReplay: prepared.kind === "replay",
		authenticatedReplay,
		activationReplay: false,
	};
}
