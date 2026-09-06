// test-contract: composition — authenticated protocol-v3 observations flow
// through the existing local evaluator; no cloud verdict or second evaluator.

import { describe, expect, it } from "vitest";
import {
	type AuthenticatedNoTestPolicy,
	mintAuthenticatedNoTestPolicy,
	mintAuthenticatedZeroMutantCensus,
	type AuthenticatedZeroMutantCensus,
} from "../authenticated-zero-census.js";
import { evaluateMutation, v2RunEvidenceGaps } from "../evaluate.js";
import { emptyManifest } from "../manifest.js";
import type { MutationGateOutcome, MutationManifest } from "../types.js";
import { canonicalReceiptHash } from "./receipts.js";
import { authenticateFixture, seal, signReceipt } from "./test-authentication.js";
import {
	MUTATION_RESULT_TARGET_CONTENT,
	NOT_MUTATABLE_TARGET_CONTENT,
	validMutationResult,
	validNotMutatable,
} from "./test-envelopes.js";
import { evaluateVerifiedMutationEvidence } from "./verified-evaluator.js";
import { parseAndVerify, type VerifiedEvidenceBundle } from "./verify.js";

const META = {
	engine: "stryker",
	engineVersion: "8.2.0",
	dependencyGraphVersion: "fixture",
	environmentHash: "fixture",
	authoritativeAt: "2026-08-31T11:00:00.000Z",
};

function authenticate(raw: Record<string, unknown>): VerifiedEvidenceBundle {
	const fixture = authenticateFixture(raw);
	const verified = parseAndVerify(fixture.raw, fixture.inputs);
	if (!verified.ok) throw new Error(verified.reason);
	return verified.bundle;
}

function bundleOf(raw: object): VerifiedEvidenceBundle {
	// SAFETY: test builders create JSON objects; parseAndVerify below validates
	// and authenticates the complete shape before returning the branded value.
	return authenticate(raw as Record<string, unknown>);
}

function certifiableMutationResult() {
	const result = validMutationResult();
	result.excluded = [];
	result.census = { generated: 2, executable: 2, approved_excluded: 0 };
	return result;
}

function zeroTestNotMutatable() {
	const result = validNotMutatable();
	result.test_run = { ...result.test_run, executed_test_count: 0 };
	result.no_test_policy = "policy-no-test-allowed";
	return result;
}

function evaluate(
	bundle: VerifiedEvidenceBundle,
	targetContent: string,
	baseManifest: MutationManifest = emptyManifest(META),
	baselineIntent: "require_established" | "adopt_current" = "adopt_current",
): MutationGateOutcome {
	return evaluateVerifiedMutationEvidence({
		bundle,
		targetContent,
		baseManifest,
		siteCountThreshold: 50,
		at: "2026-08-31T13:00:00.000Z",
		baselineIntent,
	}).outcome;
}

function adopted(outcome: MutationGateOutcome): Extract<MutationGateOutcome, { kind: "baseline_adoption_ready" }> {
	if (outcome.kind !== "baseline_adoption_ready") throw new Error(`expected adoption, got ${outcome.kind}`);
	return outcome;
}

function measured(outcome: MutationGateOutcome): Extract<MutationGateOutcome, { kind: "measured" }> {
	if (outcome.kind !== "measured") throw new Error(`expected measured, got ${outcome.kind}`);
	return outcome;
}

describe("evaluateVerifiedMutationEvidence", () => {
	it("P: adopts an authenticated first sighting, then measures it clean against that floor", () => {
		const bundle = bundleOf(certifiableMutationResult());
		const first = adopted(evaluate(bundle, MUTATION_RESULT_TARGET_CONTENT));
		expect(first.receipt.outcome).toBe("baseline_adopted");
		const second = measured(evaluate(bundle, MUTATION_RESULT_TARGET_CONTENT, first.refreshedManifest));
		expect(second.decision).toBe("allow");
		expect(second.receipt.outcome).toBe("measured_clean");
	});

	it("N: a first proposed edit cannot adopt itself without explicit onboarding intent", () => {
		const outcome = evaluate(
			bundleOf(certifiableMutationResult()),
			MUTATION_RESULT_TARGET_CONTENT,
			emptyManifest(META),
			"require_established",
		);
		expect(outcome).toMatchObject({
			kind: "unavailable",
			reason: expect.stringContaining("background onboarding"),
		});
	});

	it("N: rejects a structural bundle copy that lacks verifier runtime provenance", () => {
		const genuine = bundleOf(validMutationResult());
		// SAFETY: deliberate type forgery exercises the runtime trust boundary.
		const forged = { ...genuine } as unknown as VerifiedEvidenceBundle;
		expect(() => evaluate(forged, MUTATION_RESULT_TARGET_CONTENT)).toThrow("not minted by the verifier");
	});

	it("N: a signed survivor still blocks through the existing baseline ratchet", () => {
		const cleanBundle = bundleOf(certifiableMutationResult());
		const baseline = adopted(evaluate(cleanBundle, MUTATION_RESULT_TARGET_CONTENT)).refreshedManifest;
		const survivor = validMutationResult();
		survivor.mutants[0] = { ...survivor.mutants[0]!, status: "survived" };
		const outcome = measured(evaluate(bundleOf(survivor), MUTATION_RESULT_TARGET_CONTENT, baseline));
		expect(outcome.decision).toBe("block");
		expect(outcome.receipt.outcome).toBe("finding");
	});

	it("N: approved exclusions stay an evidence gap instead of certifying clean", () => {
		const outcome = evaluate(bundleOf(validMutationResult()), MUTATION_RESULT_TARGET_CONTENT);
		expect(outcome).toMatchObject({
			kind: "unavailable",
			reason: expect.stringContaining("approved exclusion rows"),
		});
	});

	it("N: inconclusive authenticated evidence stays not-measured and cannot refresh", () => {
		const inconclusive = certifiableMutationResult();
		inconclusive.mutants[0] = { ...inconclusive.mutants[0]!, status: "timeout" };
		const outcome = evaluate(bundleOf(inconclusive), MUTATION_RESULT_TARGET_CONTENT);
		expect(outcome.kind).toBe("unavailable");
		if (outcome.kind === "unavailable") expect(outcome.reason).toContain("inconclusive");
	});

	it("P: authenticated not_mutatable is the only zero-row census that can adopt and later certify", () => {
		const bundle = bundleOf(validNotMutatable());
		const first = adopted(evaluate(bundle, NOT_MUTATABLE_TARGET_CONTENT));
		expect(first.receipt.sites).toEqual([]);
		const second = measured(evaluate(bundle, NOT_MUTATABLE_TARGET_CONTENT, first.refreshedManifest));
		expect(second.decision).toBe("allow");
	});

	it("P: signed approval makes zero executed tests complete only for authenticated not_mutatable", () => {
		const bundle = bundleOf(zeroTestNotMutatable());
		expect(mintAuthenticatedNoTestPolicy(bundle)).not.toBeNull();
		const first = adopted(evaluate(bundle, NOT_MUTATABLE_TARGET_CONTENT));
		const second = measured(evaluate(bundle, NOT_MUTATABLE_TARGET_CONTENT, first.refreshedManifest));
		expect(second.decision).toBe("allow");
	});

	it("N: zero tests without a named policy never authenticate", () => {
		const raw = validNotMutatable();
		raw.test_run = { ...raw.test_run, executed_test_count: 0 };
		expect(() => bundleOf(raw)).toThrow("no_test_policy");
	});

	it("N: a named policy omitted from the signed acceptance never authenticates", () => {
		const fixture = authenticateFixture({ ...zeroTestNotMutatable() });
		const acceptance = JSON.parse(fixture.inputs.receipts.acceptance) as { payload: Record<string, unknown> };
		const unapproved = { ...acceptance.payload, approved_policy_ids: [] };
		const acceptanceHash = canonicalReceiptHash(unapproved);
		fixture.raw.acceptance_receipt_hash = acceptanceHash;
		const execution = JSON.parse(fixture.inputs.receipts.execution ?? "") as { payload: Record<string, unknown> };
		const reboundExecution = { ...execution.payload, acceptance_receipt_hash: acceptanceHash };
		fixture.raw.execution_receipt_hash = canonicalReceiptHash(reboundExecution);
		seal(fixture.raw);
		const outcome = parseAndVerify(fixture.raw, {
			...fixture.inputs,
			receipts: {
				acceptance: signReceipt(unapproved, "k_control"),
				execution: signReceipt(reboundExecution, "k_runner"),
			},
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain("not approved by the signed acceptance receipt");
	});

	it("N: wrong-kind authenticated evidence cannot mint the no-test capability", () => {
		expect(mintAuthenticatedNoTestPolicy(bundleOf(certifiableMutationResult()))).toBeNull();
	});

	it("N: a structurally forged no-test capability cannot weaken the evaluator", () => {
		const forged: AuthenticatedNoTestPolicy = {
			resultHash: "f".repeat(64),
			targetFile: "src/lib/constants.ts",
			targetContentHash: "e".repeat(64),
			policyId: "policy-no-test-allowed",
		};
		const outcome = evaluateMutation({
			file: forged.targetFile,
			baseManifest: emptyManifest(META),
			overlayContent: NOT_MUTATABLE_TARGET_CONTENT,
			adapted: [],
			siteCountThreshold: 50,
			testRun: { overlayGreen: true, redWitnessSatisfied: null },
			executedTestCount: 0,
			engineExitCode: 0,
			authenticatedNoTestPolicy: forged,
			authenticatedEvidenceResultHash: forged.resultHash,
			at: "2026-08-31T13:00:00.000Z",
		});
		expect(outcome.kind).toBe("unavailable");
		if (outcome.kind === "unavailable") expect(outcome.reason).toContain("zero tests executed");
	});

	it("N: the public v2 evidence floor still rejects every zero executed-test count", () => {
		const gaps = v2RunEvidenceGaps({
			testRun: { overlayGreen: true, redWitnessSatisfied: null },
			executedTestCount: 0,
			engineExitCode: 0,
		});
		expect(gaps).toEqual([expect.stringContaining("zero tests executed")]);
	});

	it("N: a structurally forged zero-census token does not make a legacy empty report clean", () => {
		const forged: AuthenticatedZeroMutantCensus = {
			resultHash: "f".repeat(64),
			targetFile: "src/lib/constants.ts",
			targetContentHash: "e".repeat(64),
		};
		const outcome = evaluateMutation({
			file: "src/lib/constants.ts",
			baseManifest: emptyManifest(META),
			overlayContent: NOT_MUTATABLE_TARGET_CONTENT,
			adapted: [],
			siteCountThreshold: 50,
			testRun: { overlayGreen: true, redWitnessSatisfied: null },
			executedTestCount: 1,
			engineExitCode: 0,
			authenticatedZeroMutantCensus: forged,
			authenticatedEvidenceResultHash: forged.resultHash,
			at: "2026-08-31T13:00:00.000Z",
		});
		expect(outcome.kind).toBe("unavailable");
		if (outcome.kind === "unavailable") expect(outcome.reason).toContain("zero mutants");
	});

	it("N: zero-census proof cannot be forged or replayed across result, target, or content", () => {
		const bundle = bundleOf(validNotMutatable());
		const proof = mintAuthenticatedZeroMutantCensus(bundle);
		expect(proof).not.toBeNull();
		if (proof === null) return;
		const base = {
			file: bundle.envelope.job.target_file,
			baseManifest: emptyManifest(META),
			overlayContent: NOT_MUTATABLE_TARGET_CONTENT,
			adapted: [],
			siteCountThreshold: 50,
			testRun: { overlayGreen: true, redWitnessSatisfied: null },
			executedTestCount: 1,
			engineExitCode: 0,
			authenticatedZeroMutantCensus: proof,
			authenticatedEvidenceResultHash: bundle.envelope.result_hash,
			at: "2026-08-31T13:00:00.000Z",
		};
		expect(evaluateMutation(base).kind).toBe("baseline_adoption_ready");
		for (const replay of [
			{ ...base, authenticatedEvidenceResultHash: "0".repeat(64) },
			{ ...base, file: "src/lib/other-constants.ts" },
			{ ...base, overlayContent: `${NOT_MUTATABLE_TARGET_CONTENT}// changed\n` },
		]) {
			const outcome = evaluateMutation(replay);
			expect(outcome.kind).toBe("unavailable");
			if (outcome.kind === "unavailable") expect(outcome.reason).toContain("zero mutants");
		}

		const structuralBundle = {
			envelope: {
				kind: "not_mutatable",
				result_hash: "f".repeat(64),
				job: { target_file: "src/lib/forged.ts", target_content_hash: "e".repeat(64) },
				census: { generated: 0, executable: 0, approved_excluded: 0 },
			},
		} as unknown as VerifiedEvidenceBundle;
		expect(mintAuthenticatedZeroMutantCensus(structuralBundle)).toBeNull();
	});

	it("N: exact local overlay bytes remain mandatory after authentication", () => {
		const outcome = evaluate(bundleOf(validMutationResult()), `${MUTATION_RESULT_TARGET_CONTENT}// changed\n`);
		expect(outcome.kind).toBe("unavailable");
		if (outcome.kind === "unavailable") expect(outcome.reason).toContain("target_content_hash");
	});

	it("N: an authenticated cancellation short-circuits with none-completeness before any bridging runs", () => {
		const base = validMutationResult() as unknown as Record<string, unknown>;
		const cancelled: Record<string, unknown> = {
			...base,
			kind: "cancelled",
			cancellation_reason: "operator_stop",
		};
		for (const key of [
			"execution_receipt_hash",
			"attempt_id",
			"scope",
			"engine",
			"runner",
			"census",
			"excluded",
			"mutants",
			"identity_algorithm",
			"test_run",
			"report",
		]) {
			delete cancelled[key];
		}
		const outcome = evaluate(authenticate(cancelled), MUTATION_RESULT_TARGET_CONTENT);
		expect(outcome).toMatchObject({
			kind: "unavailable",
			reason: "cancelled: operator_stop",
		});
	});

	it("N: authenticated suite-red evidence blocks even though its mutant census is partial", () => {
		const base = validMutationResult();
		const redShape = {
			...base,
			kind: "suite_red",
			test_run: { ...base.test_run, overlay_green: false },
		};
		// SAFETY: widened to build the suite_red wire arm by deleting the
		// mutation_result-only report/census group before production parsing.
		const red = redShape as Record<string, unknown>;
		for (const key of ["report", "census", "excluded", "mutants", "identity_algorithm"]) delete red[key];
		const outcome = measured(evaluate(authenticate(red), MUTATION_RESULT_TARGET_CONTENT));
		expect(outcome.decision).toBe("block");
		expect(outcome.suiteRed).toBe(true);
	});
});
