// ===========================================
// Authenticated zero-mutant census proof
// ===========================================
// A legacy runner returning `mutants: []` proves nothing: an empty/partial
// report was one of the original false-clean paths. Protocol v3's
// `not_mutatable` arm is different because the signed receipts and structural
// report bind an exact zero-mutant census to the requested target. This
// module turns that verified fact into a process-local capability that the
// existing evaluator can recognize without accepting a caller-controlled
// boolean or string discriminator.

import {
	isVerifiedEvidenceBundle,
	type VerifiedEvidenceBundle,
} from "./protocol-v3/verify.js";

export interface AuthenticatedZeroMutantCensusBinding {
	readonly resultHash: string;
	readonly targetFile: string;
	readonly targetContentHash: string;
}

const mintedProofs = new WeakMap<object, AuthenticatedZeroMutantCensusBinding>();

export interface AuthenticatedNoTestPolicyBinding extends AuthenticatedZeroMutantCensusBinding {
	readonly policyId: string;
}

const mintedNoTestPolicies = new WeakMap<object, AuthenticatedNoTestPolicyBinding>();

export interface AuthenticatedZeroMutantCensus extends AuthenticatedZeroMutantCensusBinding {}

/** Opaque permission to treat zero executed tests as intentional evidence.
 * It is meaningful only for the authenticated v3 `not_mutatable` arm; legacy
 * v2 callers cannot manufacture it from a boolean or policy-shaped string. */
export interface AuthenticatedNoTestPolicy extends AuthenticatedNoTestPolicyBinding {}

function isExactZeroCensus(census: {
	readonly generated: number;
	readonly executable: number;
	readonly approved_excluded: number;
}): boolean {
	return census.generated === 0 && census.executable === 0 && census.approved_excluded === 0;
}

/** Mint the zero-census capability only from the verifier's branded bundle. */
export function mintAuthenticatedZeroMutantCensus(
	bundle: VerifiedEvidenceBundle,
): AuthenticatedZeroMutantCensus | null {
	if (!isVerifiedEvidenceBundle(bundle)) return null;
	const envelope = bundle.envelope;
	if (envelope.kind !== "not_mutatable") return null;
	if (
		envelope.census.generated !== 0 ||
		envelope.census.executable !== 0 ||
		envelope.census.approved_excluded !== 0
	) {
		return null;
	}
	const binding = Object.freeze({
		resultHash: envelope.result_hash,
		targetFile: envelope.job.target_file,
		targetContentHash: envelope.job.target_content_hash,
	});
	const proof = Object.freeze({ ...binding });
	mintedProofs.set(proof, binding);
	return proof;
}

/** Mint the no-test capability only when the authenticated result proves an
 * exact zero-mutant target and its signed acceptance approved the named
 * policy. Verification already enforces the approval; the repeat check keeps
 * this capability's security invariant local and auditable. */
export function mintAuthenticatedNoTestPolicy(
	bundle: VerifiedEvidenceBundle,
): AuthenticatedNoTestPolicy | null {
	if (!isVerifiedEvidenceBundle(bundle)) return null;
	const envelope = bundle.envelope;
	if (envelope.kind !== "not_mutatable") return null;
	const policyId = envelope.no_test_policy;
	const authorized =
		envelope.test_run.executed_test_count === 0 &&
		policyId !== undefined &&
		isExactZeroCensus(envelope.census) &&
		bundle.acceptance.approved_policy_ids.includes(policyId);
	if (!authorized) return null;
	const binding = Object.freeze({
		resultHash: envelope.result_hash,
		targetFile: envelope.job.target_file,
		targetContentHash: envelope.job.target_content_hash,
		policyId,
	});
	const proof = Object.freeze({ ...binding });
	mintedNoTestPolicies.set(proof, binding);
	return proof;
}

/** Runtime check: structurally similar or cross-target caller data is not a
 * proof. The WeakMap binding, not the caller-visible object fields, is the
 * authority compared with the evaluator's current result/target/content. */
export function isAuthenticatedZeroMutantCensus(
	value: AuthenticatedZeroMutantCensus | undefined,
	expected: AuthenticatedZeroMutantCensusBinding,
): value is AuthenticatedZeroMutantCensus {
	if (value === undefined) return false;
	const binding = mintedProofs.get(value);
	return binding !== undefined &&
		binding.resultHash === expected.resultHash &&
		binding.targetFile === expected.targetFile &&
		binding.targetContentHash === expected.targetContentHash;
}

/** Runtime provenance/binding check for the authenticated no-test policy. */
export function isAuthenticatedNoTestPolicy(
	value: AuthenticatedNoTestPolicy | undefined,
	expected: AuthenticatedZeroMutantCensusBinding,
): value is AuthenticatedNoTestPolicy {
	if (value === undefined) return false;
	const binding = mintedNoTestPolicies.get(value);
	return binding !== undefined &&
		binding.resultHash === expected.resultHash &&
		binding.targetFile === expected.targetFile &&
		binding.targetContentHash === expected.targetContentHash;
}
