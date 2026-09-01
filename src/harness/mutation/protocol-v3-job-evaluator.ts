// ==========================================================
// Durable mutation jobs — protocol-v3 authenticated evaluator
// ==========================================================
// This adapter is deliberately separate from the live hook. It turns the
// transport-only terminal wrapper into authenticated protocol evidence,
// applies the one local mutation evaluator, and returns one journal commit
// draft. Remote data never supplies trust keys, authority, admission anchors,
// a clock, or a verdict.

import { createHash } from "node:crypto";
import { isJsonObject } from "../../lib/json-types.js";
import type { MutationJobEvaluator, CommitMutationEvaluationDraft } from "./mutation-job-processor.js";
import type {
	ClaimedMutationJob,
	JournalFinding,
	JournalManifestHead,
	JournalRetainedCanonicalJson,
	JournalRetainedEvidence,
	JournalRetainedReport,
} from "./mutation-journal-types.js";
import type { MutationGateOutcome, MutationManifest } from "./types.js";
import { mutationOutcomeToDecision } from "./verdict.js";
import {
	canonicalJson,
	deepFreeze,
	keyRegistryFailure,
	registryRoleConflictFailure,
	safeStructuredClone,
	type V3KeyRegistry,
} from "./protocol-v3/canonical.js";
import { checkBoundedString, checkSha256Hex } from "./protocol-v3/field-checks.js";
import { hasExactJsonKeys } from "./mutation-cloud-v3-http.js";
import {
	authenticatedEvidenceHash,
	canonicalHash,
	expectedAdmissionFromJournal,
	expectedJobFromJournal,
	manifestFromHead,
	parseProtocolV3Envelope,
	parseProtocolV3RemoteEvidence,
	receiptInputs,
	reportBytes,
	targetContentFromJournal,
	type ProtocolV3RemoteEvidence,
} from "./protocol-v3-job-evaluator-input.js";
import { evaluateVerifiedMutationEvidence } from "./protocol-v3/verified-evaluator.js";
import {
	verifyEnvelope,
	type V3ServerAuthority,
} from "./protocol-v3/verify.js";

export type { ProtocolV3RemoteEvidence };

export interface ProtocolV3MutationJobEvaluatorOptions {
	/** Trusted local configuration, never populated from remote evidence. */
	keyRegistry: V3KeyRegistry;
	/** Independently authenticated server context, not a request/result echo. */
	serverAuthority: V3ServerAuthority;
	/** Returns the RFC3339 verification/evaluation instant. Read once per job. */
	clock: () => string;
	/** Must change whenever effective local evaluation policy changes. */
	evaluatorPolicyVersion: string;
	siteCountThreshold: number;
	cwd?: string;
}

type LocalMutationVerdict = "clean" | "adverse" | "not_measured" | "baseline_adopted";

interface EvaluationInput {
	job: Readonly<ClaimedMutationJob>;
	evidence: unknown;
	manifestHead: Readonly<JournalManifestHead>;
}

function fail(reason: string): never {
	throw new Error(`protocol-v3 mutation evidence: ${reason}`);
}

function assertReason(reason: string | null): void {
	if (reason !== null) fail(reason);
}

function retainedSha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function retainedCanonicalJson(value: unknown): JournalRetainedCanonicalJson {
	const encoded = canonicalJson(value);
	return { canonicalJson: encoded, sha256: retainedSha256(encoded) };
}

function retainedSignedJson(value: string, label: string): JournalRetainedCanonicalJson {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error(`protocol-v3 mutation evidence: authenticated ${label} is not JSON`, { cause: error });
	}
	return retainedCanonicalJson(parsed);
}

function retainedReport(value: Uint8Array | undefined): JournalRetainedReport | null {
	if (value === undefined) return null;
	const bytes = Uint8Array.from(value);
	return { bytes, sha256: retainedSha256(bytes) };
}

/** Build retention only from inputs that have already passed verifyEnvelope.
 * Signed JSON is deliberately normalized: protocol canonical bytes, rather
 * than transport whitespace or key order, are the durable contract. */
function retentionFromAuthenticatedEvidence(
	envelope: unknown,
	wire: ProtocolV3RemoteEvidence,
	report: Uint8Array | undefined,
): JournalRetainedEvidence {
	return {
		formatVersion: 1,
		envelope: retainedCanonicalJson(envelope),
		acceptanceReceipt: retainedSignedJson(wire.acceptance_receipt, "acceptance receipt"),
		executionReceipt: wire.execution_receipt === null
			? null
			: retainedSignedJson(wire.execution_receipt, "execution receipt"),
		terminalizationRecord: wire.terminalization_record === null
			? null
			: retainedSignedJson(wire.terminalization_record, "terminalization record"),
		report: retainedReport(report),
	};
}

function verdictOf(outcome: MutationGateOutcome): LocalMutationVerdict {
	if (outcome.kind === "unavailable") return "not_measured";
	if (outcome.kind === "baseline_adoption_ready") return "baseline_adopted";
	return outcome.decision === "allow" ? "clean" : "adverse";
}

function manifestForOutcome(outcome: MutationGateOutcome, base: MutationManifest): MutationManifest {
	if (outcome.kind === "baseline_adoption_ready") return outcome.refreshedManifest;
	if (outcome.kind === "measured" && outcome.decision === "allow") {
		if (outcome.refreshedManifest === undefined) {
			fail("local evaluator returned a clean decision without a refreshed manifest");
		}
		return outcome.refreshedManifest;
	}
	return base;
}

function journalOutcome(outcome: MutationGateOutcome): unknown {
	if (outcome.kind === "unavailable") return { ...outcome };
	if (outcome.kind === "baseline_adoption_ready") {
		return {
			kind: outcome.kind,
			receipt: outcome.receipt,
			warning: outcome.warning,
			...(outcome.redWitnessFailed === undefined ? {} : { redWitnessFailed: outcome.redWitnessFailed }),
		};
	}
	return {
		kind: outcome.kind,
		decision: outcome.decision,
		receipt: outcome.receipt,
		newSurvivors: outcome.newSurvivors,
		uncoveredSites: outcome.uncoveredSites,
		changedSiteCount: outcome.changedSiteCount,
		siteCountThreshold: outcome.siteCountThreshold,
		...(outcome.suiteRed === undefined ? {} : { suiteRed: outcome.suiteRed }),
		...(outcome.redWitnessFailed === undefined ? {} : { redWitnessFailed: outcome.redWitnessFailed }),
	};
}

function findingCategory(outcome: MutationGateOutcome): string | null {
	if (outcome.kind === "unavailable") return "not_measured";
	if (outcome.kind === "baseline_adoption_ready") return "baseline_adoption";
	if (outcome.decision === "block") return "adverse";
	return outcome.redWitnessFailed ? "red_witness" : null;
}

function findingMessage(outcome: MutationGateOutcome): string {
	const decision = mutationOutcomeToDecision(outcome);
	if (decision.reason !== undefined) return decision.reason;
	if (decision.warnings !== undefined && decision.warnings.length > 0) return decision.warnings.join("\n");
	return "Mutation evaluation produced a surfaced finding.";
}

function journalFindings(input: {
	job: Readonly<ClaimedMutationJob>;
	outcome: MutationGateOutcome;
	resultHash: string;
	evaluatorPolicyVersion: string;
	verdict: LocalMutationVerdict;
	evidenceCompleteness: string;
}): JournalFinding[] {
	const category = findingCategory(input.outcome);
	if (category === null) return [];
	const identity = {
		tenant_id: input.job.expectedJob.tenant,
		project_id: input.job.expectedJob.project,
		repo: input.job.expectedJob.repository,
	};
	const deliveryFindingId = canonicalHash({
		...identity,
		acceptance_receipt_hash: input.job.acceptanceReceiptHash,
		result_hash: input.resultHash,
		evaluator_policy_version: input.evaluatorPolicyVersion,
		finding_category_or_mutant_id: category,
	});
	const semanticFindingFingerprint = canonicalHash({
		...identity,
		target: input.job.expectedJob.target_file,
		mutant_identity_or_finding_category: category,
	});
	return [{
		findingId: deliveryFindingId,
		payload: {
			finding_version: "1",
			delivery_finding_id: deliveryFindingId,
			semantic_finding_fingerprint: semanticFindingFingerprint,
			category,
			severity: input.verdict === "adverse" ? "error" : "warning",
			verdict: input.verdict,
			message: findingMessage(input.outcome),
			target: input.job.expectedJob.target_file,
			acceptance_receipt_hash: input.job.acceptanceReceiptHash,
			result_hash: input.resultHash,
			evaluator_policy_version: input.evaluatorPolicyVersion,
			evidence_completeness: input.evidenceCompleteness,
		},
	}];
}

/** Production protocol-v3 adapter for the shared durable job processor. */
export class ProtocolV3MutationJobEvaluator implements MutationJobEvaluator {
	readonly #keyRegistry: V3KeyRegistry;
	readonly #serverAuthority: V3ServerAuthority;
	readonly #clock: () => string;
	readonly #evaluatorPolicyVersion: string;
	readonly #siteCountThreshold: number;
	readonly #cwd: string | undefined;

	constructor(options: ProtocolV3MutationJobEvaluatorOptions) {
		const registry = safeStructuredClone(options.keyRegistry);
		if (registry === null) fail("trusted key registry must be detached structured-clone data");
		const registryFailure = keyRegistryFailure(registry);
		if (registryFailure !== null) fail(`trusted ${registryFailure}`);
		const trustedRegistry = registry as V3KeyRegistry;
		const roleConflict = registryRoleConflictFailure(trustedRegistry);
		if (roleConflict !== null) fail(`trusted ${roleConflict}`);

		const authority = safeStructuredClone(options.serverAuthority);
		if (authority === null || !isJsonObject(authority) || !hasExactJsonKeys(authority, ["tenant", "project"])) {
			fail("serverAuthority must contain exactly tenant and project");
		}
		assertReason(checkBoundedString(authority.tenant, "serverAuthority.tenant"));
		assertReason(checkBoundedString(authority.project, "serverAuthority.project"));
		assertReason(checkBoundedString(options.evaluatorPolicyVersion, "evaluatorPolicyVersion"));
		if (!Number.isSafeInteger(options.siteCountThreshold)) {
			fail("siteCountThreshold must be a safe integer");
		}

		this.#keyRegistry = deepFreeze(trustedRegistry);
		this.#serverAuthority = deepFreeze({
			tenant: authority.tenant as string,
			project: authority.project as string,
		});
		this.#clock = options.clock;
		this.#evaluatorPolicyVersion = options.evaluatorPolicyVersion;
		this.#siteCountThreshold = options.siteCountThreshold;
		this.#cwd = options.cwd;
	}

	async evaluate(input: EvaluationInput): Promise<CommitMutationEvaluationDraft> {
		const job = safeStructuredClone(input.job);
		if (job === null) fail("journal job must be detached structured-clone data");
		const wire = parseProtocolV3RemoteEvidence(input.evidence);
		const envelope = parseProtocolV3Envelope(wire.envelope);

		// This journal binding is checked before verifyEnvelope by design. It is
		// the processor's claim identity and must not be learned from the result.
		assertReason(checkSha256Hex(job.acceptanceReceiptHash, "journal acceptanceReceiptHash"));
		if (envelope.acceptance_receipt_hash !== job.acceptanceReceiptHash) {
			fail("envelope acceptance_receipt_hash does not match the journal claim");
		}

		const expectedJob = expectedJobFromJournal(job.expectedJob);
		const expectedAdmission = expectedAdmissionFromJournal(job.expectedAdmission);
		const targetContent = targetContentFromJournal(job, expectedJob);
		const baseManifest = manifestFromHead(input.manifestHead.snapshot);
		const report = reportBytes(envelope, wire.report_bytes);
		const now = this.#clock();
		const verified = verifyEnvelope(envelope, {
			expectedJob,
			serverAuthority: this.#serverAuthority,
			expectedAdmission,
			keyRegistry: this.#keyRegistry,
			now,
			receipts: receiptInputs(wire, envelope),
			...(report === undefined ? {} : { report }),
		});
		if (!verified.ok) fail(`authentication failed: ${verified.reason}`);
		const retainedEvidence = retentionFromAuthenticatedEvidence(verified.bundle.envelope, wire, report);

		const evaluated = evaluateVerifiedMutationEvidence({
			bundle: verified.bundle,
			targetContent,
			baseManifest,
			siteCountThreshold: this.#siteCountThreshold,
			at: now,
			// The intent was written before remote execution and survived in the
			// journal; it is never inferred from the result being evaluated.
			baselineIntent: job.baselineIntent,
			...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
		});
		const verdict = verdictOf(evaluated.outcome);
		const evidenceHash = authenticatedEvidenceHash(verified.bundle);
		const harnessDecision = mutationOutcomeToDecision(evaluated.outcome);
		const mutationReceipt = evaluated.outcome.kind === "unavailable" ? null : evaluated.outcome.receipt;

		return {
			resultHash: evaluated.resultHash,
			authenticatedEvidenceHash: evidenceHash,
			evaluatorPolicyVersion: this.#evaluatorPolicyVersion,
			retainedEvidence,
			evaluation: {
				evaluation_version: "1",
				protocol_version: verified.bundle.envelope.protocol_version,
				result_hash: evaluated.resultHash,
				evidence: evaluated.evidence,
				outcome: journalOutcome(evaluated.outcome),
			},
			decision: {
				decision_version: "1",
				verdict,
				harness: harnessDecision,
			},
			manifestSnapshot: manifestForOutcome(evaluated.outcome, baseManifest),
			receipt: {
				receipt_version: "1",
				kind: "local_mutation_evaluation",
				acceptance_receipt_hash: job.acceptanceReceiptHash,
				result_hash: evaluated.resultHash,
				authenticated_evidence_hash: evidenceHash,
				evaluator_policy_version: this.#evaluatorPolicyVersion,
				evaluated_at: now,
				verdict,
				mutation_receipt: mutationReceipt,
			},
			runRow: {
				run_row_version: "1",
				source: "durable_job",
				job_id: job.jobId,
				remote_job_id: job.remoteJobId,
				target: expectedJob.target_file,
				result_hash: evaluated.resultHash,
				evaluated_at: now,
				verdict,
				evidence_completeness: evaluated.evidence.completeness,
				incompleteness_reasons: evaluated.evidence.incompleteness_reasons,
				observations: evaluated.evidence.observations,
				mutation_receipt_outcome: mutationReceipt?.outcome ?? null,
			},
			findings: journalFindings({
				job,
				outcome: evaluated.outcome,
				resultHash: evaluated.resultHash,
				evaluatorPolicyVersion: this.#evaluatorPolicyVersion,
				verdict,
				evidenceCompleteness: evaluated.evidence.completeness,
			}),
		};
	}
}
