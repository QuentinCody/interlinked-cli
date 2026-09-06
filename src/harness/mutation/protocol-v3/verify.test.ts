// ===========================================
// Protocol v3 — trust boundary (signed vectors + tamper pins)
// ===========================================
// Fifth pass 2026-08-31: receipts carry production payloads under key
// PURPOSES plus arm-bound result authority: control signs acceptance and
// terminalization-arm results; runner signs execution and execution-arm
// results. Terminalization records must AGREE with the envelope; the shared
// tamper cases in signed-vectors.json EXECUTE.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { V3KeyRegistry } from "./canonical.js";
import { classifyEvidence } from "./evidence.js";
import { canonicalReceiptHash } from "./receipts.js";
import {
	authenticateFixture,
	RUNNER_PEM,
	seal,
	signReceipt,
	TEST_REGISTRY,
} from "./test-authentication.js";
import { validMutationResult } from "./test-envelopes.js";
import { PROTOCOL_V3_VERSION } from "./types.js";
import {
	computeResultHash,
	isVerifiedEvidenceBundle,
	parseAndVerify,
	type VerifiedEvidenceBundle,
	type VerifyInputs,
} from "./verify.js";

function authenticated(): { raw: Record<string, unknown>; inputs: VerifyInputs } {
	return authenticateFixture({ ...validMutationResult() });
}

function reasonOf(raw: unknown, inputs: VerifyInputs): string {
	const outcome = parseAndVerify(raw, inputs);
	return outcome.ok ? "AUTHENTICATED" : outcome.reason;
}

/** Authenticate the mutation_result fixture and hand back the bundle plus its
 *  mutant rows, narrowed through the discriminated union (no casts). */
function authenticatedMutationRows(): {
	raw: Record<string, unknown>;
	bundle: VerifiedEvidenceBundle;
	rows: ReadonlyArray<{ readonly status: string }>;
} {
	const { raw, inputs } = authenticated();
	const outcome = parseAndVerify(raw, inputs);
	if (!outcome.ok) throw new Error(outcome.reason);
	const envelope = outcome.bundle.envelope;
	if (envelope.kind !== "mutation_result") throw new Error(`unexpected kind ${envelope.kind}`);
	return { raw, bundle: outcome.bundle, rows: envelope.mutants };
}

/** The registry with the RUNNER (result) key's window overridden. */
function runnerKeyWindow(window: { not_before?: string; revoked_at?: string }): V3KeyRegistry {
	return {
		...TEST_REGISTRY,
		k_runner: { public_key_pem: RUNNER_PEM, purposes: ["execution", "result"], ...window },
	};
}

/** A terminal-arm ("cancelled") fixture — no execution receipt, so
 *  verifyReceipts routes through verifyTerminalizationArm. Mirrors the
 *  inline construction N2/N4c already use; factored here because the
 *  terminalization-echo cases below build several variants of it. */
function cancelledFixture(): { raw: Record<string, unknown>; inputs: VerifyInputs } {
	const base = validMutationResult();
	// SAFETY: widened deliberately to build the pre-execution shape (mirrors
	// N2/N4c's inline cast below).
	const cancelled = {
		...base,
		kind: "cancelled",
		cancellation_reason: "operator_stop",
	} as Record<string, unknown>;
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
	return authenticateFixture(cancelled);
}

/** A terminal-arm ("execution_failed") fixture — no execution receipt (the
 *  attempt never produced evidence), so verifyReceipts routes through
 *  verifyTerminalizationArm and envelopeTerminalReason's "execution_failed"
 *  case (verify.ts:345) supplies the expected reason_code. Sibling to
 *  {@link cancelledFixture}; factored so both the positive no-evidence case
 *  and its reason_code-contradiction negative share one construction. */
function executionFailedFixture(failureClassification: string): {
	raw: Record<string, unknown>;
	inputs: VerifyInputs;
} {
	const base = validMutationResult();
	// SAFETY: widened deliberately to build the pre-execution shape (mirrors
	// cancelledFixture above).
	const executionFailed = {
		...base,
		kind: "execution_failed",
		failure_classification: failureClassification,
		evidence_completeness: "none",
	} as Record<string, unknown>;
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
		delete executionFailed[key];
	}
	return authenticateFixture(executionFailed);
}

describe("parseAndVerify — positive (must authenticate)", () => {
	// test-contract: public-api — the full chain: parse, hash, attestation,
	// signed production receipts (+exact echoes), structural report.
	it("P1: the fabricated vector authenticates end to end", () => {
		const { raw, inputs } = authenticated();
		expect(reasonOf(raw, inputs)).toBe("AUTHENTICATED");
	});

	// test-contract: invariant — the immutable identity EXCLUDES seq (plan
	// 27 r5.3): changing it never changes result_hash.
	it("P2: seq does not participate in result identity", () => {
		const { raw } = authenticated();
		// SAFETY: sealed fixture; result_hash is a string by construction.
		const sealedHash = raw.result_hash as string;
		expect(computeResultHash({ ...raw, seq: 999 } as never)).toBe(sealedHash);
	});

	// test-contract: boundary — a result key revoked AFTER the result
	// occurred still verifies (revocation is not retroactive).
	it("P3: revocation after occurred_at does not invalidate", () => {
		const { raw, inputs } = authenticated();
		const registry = runnerKeyWindow({ revoked_at: "2026-09-01T00:00:00Z" });
		expect(reasonOf(raw, { ...inputs, keyRegistry: registry })).toBe("AUTHENTICATED");
	});

	// test-contract: invariant — round 33 P0-1: the authenticated bundle is a
	// SNAPSHOT. Mutating the caller's raw object AFTER verification must not
	// reach the bundle, and the bundle itself must be deep-frozen.
	it("P4: post-authentication mutation of the raw input never reaches the bundle", () => {
		const { raw, bundle, rows } = authenticatedMutationRows();
		const before = rows[0]?.status;
		const beforeClassification = classifyEvidence(bundle);
		// SAFETY: attacker model — the caller retains the raw reference and
		// mutates it after authentication; the fixture always has row 0.
		(raw.mutants as Array<{ status: string }>)[0]!.status = "survived";
		expect(rows[0]?.status).toBe(before);
		expect(rows[0]).not.toBe((raw.mutants as unknown[])[0]);
		expect(classifyEvidence(bundle)).toEqual(beforeClassification);
	});

	it("P5: the authenticated bundle envelope is deep-frozen", () => {
		const { bundle, rows } = authenticatedMutationRows();
		expect(Object.isFrozen(bundle)).toBe(true);
		expect(Object.isFrozen(bundle.envelope)).toBe(true);
		expect(Object.isFrozen(rows)).toBe(true);
		expect(Object.isFrozen(rows[0])).toBe(true);
		expect(Object.isFrozen(bundle.acceptance)).toBe(true);
		expect(Object.isFrozen(bundle.acceptance.job)).toBe(true);
		expect(Object.isFrozen(bundle.acceptance.approved_policy_ids)).toBe(true);
		expect(Object.isFrozen(bundle.execution)).toBe(true);
		expect(() => {
			// SAFETY: deliberate mutation attempt against the frozen row —
			// the TypeError IS the assertion.
			(rows as Array<{ status: string }>)[0]!.status = "survived";
		}).toThrow(TypeError);
		expect(() => {
			// SAFETY: deliberate mutation attempt against a frozen signed
			// receipt payload — the TypeError IS the assertion.
			(bundle.acceptance.approved_policy_ids as string[]).push("policy.evil");
		}).toThrow(TypeError);
	});

	it("P6: only the exact verifier-minted bundle carries runtime provenance", () => {
		const { bundle } = authenticatedMutationRows();
		expect(isVerifiedEvidenceBundle(bundle)).toBe(true);
		// SAFETY: adversarial structural copy retains every authenticated field
		// but was not itself returned by the verifier.
		const structuralCopy = { ...bundle } as unknown as VerifiedEvidenceBundle;
		expect(isVerifiedEvidenceBundle(structuralCopy)).toBe(false);
	});

	// test-contract: security — the caller-owned trust registry is read
	// once into a detached snapshot before any validation/signature pass.
	// A getter cannot supply a valid key for one pass and a different key
	// for the next.
	it("P7: snapshots verification inputs before checking the trust chain", () => {
		const { raw, inputs } = authenticated();
		const original = inputs.keyRegistry;
		const reads = { control: 0, runner: 0 };
		const registry = {} as V3KeyRegistry;
		Object.defineProperties(registry, {
			k_control: {
				enumerable: true,
				get: () => {
					reads.control++;
					return reads.control === 1
						? original.k_control
						: { public_key_pem: "not-a-key", purposes: [] };
				},
			},
			k_runner: {
				enumerable: true,
				get: () => {
					reads.runner++;
					return reads.runner === 1
						? original.k_runner
						: { public_key_pem: "not-a-key", purposes: [] };
				},
			},
		});
		const outcome = parseAndVerify(raw, { ...inputs, keyRegistry: registry });
		expect(outcome.ok).toBe(true);
		expect(reads).toEqual({ control: 1, runner: 1 });
	});

	it("N0: rejects proxy-backed verification inputs before trust checks", () => {
		const { raw, inputs } = authenticated();
		const outcome = parseAndVerify(raw, new Proxy(inputs, {}));
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("proxy verification inputs unexpectedly authenticated");
		expect(outcome.reason).toContain("detached structured-clone data");
	});

	// test-contract: boundary — an execution_failed envelope with NO evidence
	// (execution never started) carries no execution receipt at all, so it
	// authenticates through the terminalization arm and its failure_classification
	// becomes the terminalization record's expected reason_code.
	it("an execution_failed envelope with no evidence authenticates via the terminalization arm", () => {
		const { raw, inputs } = executionFailedFixture("infra_error");
		expect(reasonOf(raw, inputs)).toBe("AUTHENTICATED");
	});
});

describe("parseAndVerify — negative (must fail)", () => {
	// test-contract: security — the KILL test: a SIGNED envelope the parser
	// rejects can never verify (parse-before-verify brand).
	it("N0: a signed but parser-rejected envelope cannot authenticate", () => {
		const { raw, inputs } = authenticated();
		// SAFETY: deliberate invalid wire value under test.
		raw.scope = { ...(raw.scope as Record<string, unknown>), incremental: true };
		seal(raw);
		const reason = reasonOf(raw, inputs);
		expect(reason).toContain("parse:");
		expect(reason).toContain("incremental");
	});

	// test-contract: security — purpose separation prevents a runner from
	// approving policy, while exact signer equality binds the generic result
	// purpose to the receipt that authorizes the selected arm.
	it("N1: purpose and signer binding reject every cross-role signature", () => {
		const { raw, inputs } = authenticated();
		const acceptance = JSON.parse(inputs.receipts.acceptance) as { payload: Record<string, unknown> };
		const runnerSigned = signReceipt(acceptance.payload, "k_runner");
		expect(
			reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, acceptance: runnerSigned } }),
		).toContain('not trusted for purpose "acceptance"');
		// This is a REAL control signature, and control is trusted for the
		// generic result purpose. It still cannot sign an execution-arm result.
		seal(raw, "k_control");
		expect(reasonOf(raw, inputs)).toContain("must equal the verified execution receipt signer");

		const base = validMutationResult();
		const cancelled = {
			...base,
			kind: "cancelled",
			cancellation_reason: "operator_stop",
		} as Record<string, unknown>;
		for (const key of ["execution_receipt_hash", "attempt_id", "scope", "engine", "runner", "census", "excluded", "mutants", "identity_algorithm", "test_run", "report"]) {
			delete cancelled[key];
		}
		const terminal = authenticateFixture(cancelled);
		const terminalization = JSON.parse(terminal.inputs.receipts.terminalization ?? "") as {
			payload: Record<string, unknown>;
		};
		expect(
			reasonOf(terminal.raw, {
				...terminal.inputs,
				receipts: {
					...terminal.inputs.receipts,
					terminalization: signReceipt(terminalization.payload, "k_runner"),
				},
			}),
		).toContain('not trusted for purpose "terminalization"');
		// Symmetric attack: a REAL runner result signature cannot authorize the
		// terminal arm, whose receipt was verified under control authority.
		seal(terminal.raw, "k_runner");
		expect(reasonOf(terminal.raw, terminal.inputs)).toContain(
			"must equal the verified terminalization receipt signer",
		);
	});

	// test-contract: security — fifth-pass P0: a signed terminalization
	// record that CONTRADICTS the envelope rejects (terminal_state, reason,
	// acceptance binding, occurred_at).
	it("N2: contradictory terminalization evidence rejects", () => {
		const base = validMutationResult();
		// SAFETY: widened deliberately to build the pre-execution shape.
		const cancelled = {
			...base,
			kind: "cancelled",
			cancellation_reason: "operator_stop",
		} as Record<string, unknown>;
		for (const key of ["execution_receipt_hash", "attempt_id", "scope", "engine", "runner", "census", "excluded", "mutants", "identity_algorithm", "test_run", "report"]) {
			delete cancelled[key];
		}
		const { raw, inputs } = authenticateFixture(cancelled);
		expect(reasonOf(raw, inputs)).toBe("AUTHENTICATED");
		// Contradiction: a correctly signed record claiming a different state.
		const term = JSON.parse(inputs.receipts.terminalization ?? "") as { payload: Record<string, unknown> };
		const contradictory = { ...term.payload, terminal_state: "succeeded", reason_code: "contradicts-envelope" };
		raw.terminalization_record_hash = canonicalReceiptHash(contradictory);
		seal(raw);
		expect(
			reasonOf(raw, {
				...inputs,
				receipts: { ...inputs.receipts, terminalization: signReceipt(contradictory, "k_control") },
			}),
		).toContain("contradicts the envelope kind");
	});

	// test-contract: security — receipt key windows use the receipt's OWN
	// signed timestamp: receipts signed by a revoked key reject even when
	// the envelope's result key is valid.
	it("N3: a revoked receipt key rejects independently", () => {
		const { raw, inputs } = authenticated();
		const registry: V3KeyRegistry = {
			...TEST_REGISTRY,
			k_control: {
				...TEST_REGISTRY.k_control,
				revoked_at: "2026-08-01T00:00:00Z",
			} as V3KeyRegistry[string],
		};
		expect(reasonOf(raw, { ...inputs, keyRegistry: registry })).toContain("revoked");
	});

	// test-contract: security — execution cross-echoes are exact fields:
	// engine name/version, test command hash, and the selected-test list.
	it("N4: execution receipt echo mismatches reject", () => {
		const { raw, inputs } = authenticated();
		const execution = JSON.parse(inputs.receipts.execution ?? "") as { payload: Record<string, unknown> };
		const wrongEngine = { ...execution.payload, engine_version: "9.9.9" };
		raw.execution_receipt_hash = canonicalReceiptHash(wrongEngine);
		seal(raw);
		expect(
			reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, execution: signReceipt(wrongEngine, "k_runner") } }),
		).toContain("engine name/version");
	});

	// test-contract: security — sixth-pass P0 repro: a re-signed acceptance
	// with foreign request/changeset hashes must fail the CALLER-anchored
	// admission; and mixing an execution receipt from a different
	// acceptance fails the chain binding.
	it("N4b: admission anchoring and receipt mix-and-match reject", () => {
		const { raw, inputs } = authenticated();
		const acceptance = JSON.parse(inputs.receipts.acceptance) as { payload: Record<string, unknown> };
		const foreign = { ...acceptance.payload, request_hash: "0".repeat(64), changeset_hash: "1".repeat(64) };
		raw.acceptance_receipt_hash = canonicalReceiptHash(foreign);
		seal(raw);
		expect(
			reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, acceptance: signReceipt(foreign, "k_control") } }),
		).toContain("request_hash does not match the request the CLI submitted");
		// Mix-and-match: original envelope + original acceptance, but an
		// execution receipt that binds a DIFFERENT acceptance hash.
		const fresh = authenticated();
		const execution = JSON.parse(fresh.inputs.receipts.execution ?? "") as { payload: Record<string, unknown> };
		const mixed = { ...execution.payload, acceptance_receipt_hash: "2".repeat(64) };
		fresh.raw.execution_receipt_hash = canonicalReceiptHash(mixed);
		seal(fresh.raw);
		expect(
			reasonOf(fresh.raw, {
				...fresh.inputs,
				receipts: { ...fresh.inputs.receipts, execution: signReceipt(mixed, "k_runner") },
			}),
		).toContain("receipt mix-and-match");
	});

	// test-contract: security — sixth-pass P1 repro: receipts issued in
	// 2099 for a 2026 result violate chronology; terminalization under a
	// different policy_version violates continuity.
	it("N4c: chronology and policy continuity reject", () => {
		const { raw, inputs } = authenticated();
		const execution = JSON.parse(inputs.receipts.execution ?? "") as { payload: Record<string, unknown> };
		const future = { ...execution.payload, issued_at: "2099-01-01T00:00:00.000Z" };
		raw.execution_receipt_hash = canonicalReceiptHash(future);
		seal(raw);
		expect(
			reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, execution: signReceipt(future, "k_runner") } }),
		).toContain("chronology violated");
		// Policy continuity on the terminalization arm.
		const base = validMutationResult();
		// SAFETY: widened deliberately to build the pre-execution shape.
		const cancelled = { ...base, kind: "cancelled", cancellation_reason: "operator_stop" } as Record<string, unknown>;
		for (const key of ["execution_receipt_hash", "attempt_id", "scope", "engine", "runner", "census", "excluded", "mutants", "identity_algorithm", "test_run", "report"]) {
			delete cancelled[key];
		}
		const term = authenticateFixture(cancelled);
		const termReceipt = JSON.parse(term.inputs.receipts.terminalization ?? "") as { payload: Record<string, unknown> };
		const otherPolicy = { ...termReceipt.payload, policy_version: "policy-set-2020-01" };
		term.raw.terminalization_record_hash = canonicalReceiptHash(otherPolicy);
		seal(term.raw);
		expect(
			reasonOf(term.raw, {
				...term.inputs,
				receipts: { ...term.inputs.receipts, terminalization: signReceipt(otherPolicy, "k_control") },
			}),
		).toContain("policy_version differs");
	});

	// test-contract: security — sixth-pass P0: a registry where one public
	// key spans control and runner roles is rejected outright.
	it("N4d: a role-spanning key registry rejects", () => {
		const { raw, inputs } = authenticated();
		const conflicted: V3KeyRegistry = {
			...TEST_REGISTRY,
			k_alias: { public_key_pem: RUNNER_PEM, purposes: ["acceptance"] },
		};
		expect(reasonOf(raw, { ...inputs, keyRegistry: conflicted })).toContain("spans control");
	});

	// test-contract: security — clock hardening and job echo.
	it("N5: clock failures and foreign jobs reject", () => {
		const { raw, inputs } = authenticated();
		expect(reasonOf(raw, { ...inputs, now: "garbage" })).toContain("failing closed");
		expect(reasonOf(raw, { ...inputs, now: "2026-08-31T11:00:00.000Z" })).toContain(
			"unreasonably in the future",
		);
		expect(
			reasonOf(raw, { ...inputs, expectedJob: { ...inputs.expectedJob, job_key: "job_9999" } }),
		).toContain("job_key");
	});

	// test-contract: security — acceptanceEchoFailure's runner-image branch:
	// the acceptance receipt's intended_image_digest must equal the
	// envelope's actual runner.image_digest.
	it("acceptance-intended runner image differing from the envelope's rejects", () => {
		const { raw, inputs } = authenticated();
		const acceptance = JSON.parse(inputs.receipts.acceptance) as { payload: Record<string, unknown> };
		const wrongImage = { ...acceptance.payload, intended_image_digest: `sha256:${"1".repeat(64)}` };
		raw.acceptance_receipt_hash = canonicalReceiptHash(wrongImage);
		seal(raw);
		expect(
			reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, acceptance: signReceipt(wrongImage, "k_control") } }),
		).toBe(`runner image sha256:${"0".repeat(64)} differs from the acceptance-intended sha256:${"1".repeat(64)}`);
	});

	// test-contract: security — acceptanceEchoFailure's engine-config branch.
	it("acceptance-intended engine config hash differing from the envelope's rejects", () => {
		const { raw, inputs } = authenticated();
		const acceptance = JSON.parse(inputs.receipts.acceptance) as { payload: Record<string, unknown> };
		const wrongConfig = { ...acceptance.payload, intended_engine_config_hash: "9".repeat(64) };
		raw.acceptance_receipt_hash = canonicalReceiptHash(wrongConfig);
		seal(raw);
		expect(
			reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, acceptance: signReceipt(wrongConfig, "k_control") } }),
		).toBe("engine config hash differs from the acceptance-intended configuration");
	});

	// test-contract: security — acceptanceEchoFailure's scope-mode branch.
	it("acceptance-intended scope mode differing from the envelope's rejects", () => {
		const { raw, inputs } = authenticated();
		const acceptance = JSON.parse(inputs.receipts.acceptance) as { payload: Record<string, unknown> };
		const wrongMode = { ...acceptance.payload, intended_scope_mode: "glob_fallback" };
		raw.acceptance_receipt_hash = canonicalReceiptHash(wrongMode);
		seal(raw);
		expect(
			reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, acceptance: signReceipt(wrongMode, "k_control") } }),
		).toBe("scope mode import_graph differs from the acceptance-intended glob_fallback");
	});

	// test-contract: security — acceptanceEchoFailure's test-scope-hash branch.
	it("acceptance-intended test_scope_hash differing from the envelope's actual scope rejects", () => {
		const { raw, inputs } = authenticated();
		const acceptance = JSON.parse(inputs.receipts.acceptance) as { payload: Record<string, unknown> };
		const wrongScopeHash = { ...acceptance.payload, test_scope_hash: "0".repeat(64) };
		raw.acceptance_receipt_hash = canonicalReceiptHash(wrongScopeHash);
		seal(raw);
		expect(
			reasonOf(raw, {
				...inputs,
				receipts: { ...inputs.receipts, acceptance: signReceipt(wrongScopeHash, "k_control") },
			}),
		).toBe("actual test scope differs from the acceptance-intended test_scope_hash");
	});

	// test-contract: security — verifyReceipts: the acceptance receipt's own
	// canonical hash must equal the envelope's acceptance_receipt_hash (the
	// envelope's recorded hash is left untouched here, so a legitimately
	// re-signed but otherwise unrelated payload still fails the binding).
	it("an acceptance receipt not matching acceptance_receipt_hash rejects", () => {
		const { raw, inputs } = authenticated();
		const acceptance = JSON.parse(inputs.receipts.acceptance) as { payload: Record<string, unknown> };
		const tampered = { ...acceptance.payload, quota_reservation_id: "quota_tampered" };
		const newReceipt = signReceipt(tampered, "k_control");
		expect(reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, acceptance: newReceipt } })).toBe(
			"acceptance receipt does not match acceptance_receipt_hash",
		);
	});

	// test-contract: security — executionEchoFailure's attempt_id branch.
	it("execution receipt attempt_id differing from the envelope's rejects", () => {
		const { raw, inputs } = authenticated();
		const execution = JSON.parse(inputs.receipts.execution ?? "") as { payload: Record<string, unknown> };
		const wrongAttempt = { ...execution.payload, attempt_id: "attempt_wrong" };
		raw.execution_receipt_hash = canonicalReceiptHash(wrongAttempt);
		seal(raw);
		expect(
			reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, execution: signReceipt(wrongAttempt, "k_runner") } }),
		).toBe(`execution receipt attempt_id "attempt_wrong" does not equal the envelope's "attempt_0001"`);
	});

	// test-contract: security — executionEchoFailure's job_key branch.
	it("execution receipt job_key differing from the envelope's job binding rejects", () => {
		const { raw, inputs } = authenticated();
		const execution = JSON.parse(inputs.receipts.execution ?? "") as { payload: Record<string, unknown> };
		const wrongJobKey = { ...execution.payload, job_key: "job_9999" };
		raw.execution_receipt_hash = canonicalReceiptHash(wrongJobKey);
		seal(raw);
		expect(
			reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, execution: signReceipt(wrongJobKey, "k_runner") } }),
		).toBe("execution receipt job_key does not equal the envelope's job binding");
	});

	// test-contract: security — executionEchoFailure's runner-image branch.
	it("execution receipt image_digest differing from the envelope's runner rejects", () => {
		const { raw, inputs } = authenticated();
		const execution = JSON.parse(inputs.receipts.execution ?? "") as { payload: Record<string, unknown> };
		const wrongImage = { ...execution.payload, image_digest: `sha256:${"1".repeat(64)}` };
		raw.execution_receipt_hash = canonicalReceiptHash(wrongImage);
		seal(raw);
		expect(
			reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, execution: signReceipt(wrongImage, "k_runner") } }),
		).toBe("runner image differs from the execution receipt's image_digest");
	});

	// test-contract: security — executionEngineEchoFailure's engine-config branch.
	it("execution receipt engine_config_hash differing from the envelope's engine rejects", () => {
		const { raw, inputs } = authenticated();
		const execution = JSON.parse(inputs.receipts.execution ?? "") as { payload: Record<string, unknown> };
		const wrongConfig = { ...execution.payload, engine_config_hash: "9".repeat(64) };
		raw.execution_receipt_hash = canonicalReceiptHash(wrongConfig);
		seal(raw);
		expect(
			reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, execution: signReceipt(wrongConfig, "k_runner") } }),
		).toBe("engine config hash differs from the execution receipt's engine_config_hash");
	});

	// test-contract: security — executionEngineEchoFailure's test-command-hash branch.
	it("execution receipt test_command_hash differing from the envelope's test_run rejects", () => {
		const { raw, inputs } = authenticated();
		const execution = JSON.parse(inputs.receipts.execution ?? "") as { payload: Record<string, unknown> };
		const wrongCommand = { ...execution.payload, test_command_hash: "6".repeat(64) };
		raw.execution_receipt_hash = canonicalReceiptHash(wrongCommand);
		seal(raw);
		expect(
			reasonOf(raw, {
				...inputs,
				receipts: { ...inputs.receipts, execution: signReceipt(wrongCommand, "k_runner") },
			}),
		).toBe("test command hash differs from the execution receipt's test_command_hash");
	});

	// test-contract: security — executionEngineEchoFailure's selected-test-hash branch.
	it("execution receipt selected_test_hash differing from the envelope's actual test list rejects", () => {
		const { raw, inputs } = authenticated();
		const execution = JSON.parse(inputs.receipts.execution ?? "") as { payload: Record<string, unknown> };
		const wrongTestHash = { ...execution.payload, selected_test_hash: "0".repeat(64) };
		raw.execution_receipt_hash = canonicalReceiptHash(wrongTestHash);
		seal(raw);
		expect(
			reasonOf(raw, {
				...inputs,
				receipts: { ...inputs.receipts, execution: signReceipt(wrongTestHash, "k_runner") },
			}),
		).toBe("actual test list differs from the execution receipt's selected_test_hash");
	});

	// test-contract: security — executionEngineEchoFailure's selected-test-count branch.
	it("execution receipt selected_test_count differing from the envelope's actual test list rejects", () => {
		const { raw, inputs } = authenticated();
		const execution = JSON.parse(inputs.receipts.execution ?? "") as { payload: Record<string, unknown> };
		const wrongCount = { ...execution.payload, selected_test_count: 2 };
		raw.execution_receipt_hash = canonicalReceiptHash(wrongCount);
		seal(raw);
		expect(
			reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, execution: signReceipt(wrongCount, "k_runner") } }),
		).toBe("test count differs from the execution receipt's selected_test_count");
	});

	// test-contract: security — verifyExecutionArm: the envelope binds an
	// execution_receipt_hash but the caller supplied no execution receipt.
	it("a missing execution receipt when the envelope binds one rejects", () => {
		const { raw, inputs } = authenticated();
		const { execution: _execution, ...rest } = inputs.receipts;
		expect(reasonOf(raw, { ...inputs, receipts: rest })).toBe(
			"signed execution receipt required — the envelope binds one",
		);
	});

	// test-contract: security — terminalizationEchoFailure's acceptance-binding
	// branch: the record must bind the SAME acceptance receipt as the envelope.
	it("terminalization record binding a different acceptance receipt rejects", () => {
		const { raw, inputs } = cancelledFixture();
		const term = JSON.parse(inputs.receipts.terminalization ?? "") as { payload: Record<string, unknown> };
		const wrongAcceptance = { ...term.payload, acceptance_receipt_hash: "9".repeat(64) };
		raw.terminalization_record_hash = canonicalReceiptHash(wrongAcceptance);
		seal(raw);
		expect(
			reasonOf(raw, {
				...inputs,
				receipts: { ...inputs.receipts, terminalization: signReceipt(wrongAcceptance, "k_control") },
			}),
		).toBe("terminalization record binds a different acceptance receipt than the envelope");
	});

	// test-contract: security — terminalizationEchoFailure's occurred_at branch.
	it("terminalization occurred_at differing from the envelope's occurred_at rejects", () => {
		const { raw, inputs } = cancelledFixture();
		const term = JSON.parse(inputs.receipts.terminalization ?? "") as { payload: Record<string, unknown> };
		const wrongOccurred = { ...term.payload, occurred_at: "2026-08-31T12:01:00.000Z" };
		raw.terminalization_record_hash = canonicalReceiptHash(wrongOccurred);
		seal(raw);
		expect(
			reasonOf(raw, {
				...inputs,
				receipts: { ...inputs.receipts, terminalization: signReceipt(wrongOccurred, "k_control") },
			}),
		).toBe("terminalization occurred_at differs from the envelope's occurred_at");
	});

	// test-contract: security — terminalizationEchoFailure's reason_code branch:
	// only the reason_code differs (terminal_state matches, unlike N2's
	// combined-tamper case), isolating this specific echo check.
	it("terminalization reason_code contradicting the envelope's reason rejects", () => {
		const { raw, inputs } = cancelledFixture();
		const term = JSON.parse(inputs.receipts.terminalization ?? "") as { payload: Record<string, unknown> };
		const wrongReason = { ...term.payload, reason_code: "deadline_exceeded" };
		raw.terminalization_record_hash = canonicalReceiptHash(wrongReason);
		seal(raw);
		expect(
			reasonOf(raw, {
				...inputs,
				receipts: { ...inputs.receipts, terminalization: signReceipt(wrongReason, "k_control") },
			}),
		).toBe(`terminalization reason_code "deadline_exceeded" contradicts the envelope's reason "operator_stop"`);
	});

	// test-contract: security — envelopeTerminalReason's "execution_failed"
	// case (verify.ts:345): distinct from the "cancelled" case the test above
	// pins, this exercises failure_classification as the expected reason_code
	// on the terminal arm's own dedicated fixture (no execution receipt).
	it("terminalization reason_code contradicting an execution_failed envelope's failure_classification rejects", () => {
		const { raw, inputs } = executionFailedFixture("infra_error");
		const term = JSON.parse(inputs.receipts.terminalization ?? "") as { payload: Record<string, unknown> };
		const wrongReason = { ...term.payload, reason_code: "operator_stop" };
		raw.terminalization_record_hash = canonicalReceiptHash(wrongReason);
		seal(raw);
		expect(
			reasonOf(raw, {
				...inputs,
				receipts: { ...inputs.receipts, terminalization: signReceipt(wrongReason, "k_control") },
			}),
		).toBe(`terminalization reason_code "operator_stop" contradicts the envelope's reason "infra_error"`);
	});

	// test-contract: security — verifyTerminalizationArm: the envelope binds a
	// terminalization_record_hash but the caller supplied no record.
	it("a missing terminalization record when the envelope binds one rejects", () => {
		const { raw, inputs } = cancelledFixture();
		const { terminalization: _terminalization, ...rest } = inputs.receipts;
		expect(reasonOf(raw, { ...inputs, receipts: rest })).toBe(
			"signed terminalization record required — the envelope binds one",
		);
	});

	// test-contract: security — verifyTerminalizationArm: the record's own
	// canonical hash must equal the envelope's terminalization_record_hash.
	it("a terminalization record not matching terminalization_record_hash rejects", () => {
		const { raw, inputs } = cancelledFixture();
		const term = JSON.parse(inputs.receipts.terminalization ?? "") as { payload: Record<string, unknown> };
		const tampered = { ...term.payload, actor: "tampered-actor" };
		const newReceipt = signReceipt(tampered, "k_control");
		expect(reasonOf(raw, { ...inputs, receipts: { ...inputs.receipts, terminalization: newReceipt } })).toBe(
			"terminalization record does not match terminalization_record_hash",
		);
	});

	// test-contract: security — verifyTerminalizationArm's job_key continuity
	// check, past the echo/policy/chronology checks that ran before it.
	it("terminalization record job_key differing from the envelope's job binding rejects", () => {
		const { raw, inputs } = cancelledFixture();
		const term = JSON.parse(inputs.receipts.terminalization ?? "") as { payload: Record<string, unknown> };
		const wrongJobKey = { ...term.payload, job_key: "job_9999" };
		raw.terminalization_record_hash = canonicalReceiptHash(wrongJobKey);
		seal(raw);
		expect(
			reasonOf(raw, {
				...inputs,
				receipts: { ...inputs.receipts, terminalization: signReceipt(wrongJobKey, "k_control") },
			}),
		).toBe("terminalization record job_key does not equal the envelope's job binding");
	});
});

interface SignedVector {
	registry: V3KeyRegistry;
	acceptance_receipt: string;
	execution_receipt: string;
	report_text: string;
	verification_now: string;
	envelope: Record<string, unknown>;
	expected_job: VerifyInputs["expectedJob"];
	server_authority: VerifyInputs["serverAuthority"];
	expected_admission: VerifyInputs["expectedAdmission"];
	tamper_cases: Array<{ name: string; patch_path: string; value: unknown; expected_failure_includes: string }>;
}

const VECTOR_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../protocol/mutation-v3/fixtures/signed-vectors.json",
);
// SAFETY: repo-committed fixture this suite exists to validate; drift
// fails the assertions below loudly.
const vector = (JSON.parse(readFileSync(VECTOR_PATH, "utf-8")) as { vector: SignedVector }).vector;

function vectorInputs(): VerifyInputs {
	return {
		// Independently supplied by the fixture — never from the response.
		expectedJob: vector.expected_job,
		serverAuthority: vector.server_authority,
		expectedAdmission: vector.expected_admission,
		keyRegistry: vector.registry,
		now: vector.verification_now,
		receipts: { acceptance: vector.acceptance_receipt, execution: vector.execution_receipt },
		report: Buffer.from(vector.report_text, "utf8"),
	};
}

/** Apply one "a.b[2].c"-style patch path to a deep-cloned envelope. */
function applyPatch(envelope: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
	// SAFETY: deep clone of a plain-JSON fixture.
	const clone = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
	const steps = path.split(".").flatMap((part) =>
		part
			.split(/[[\]]/)
			.filter((s) => s.length > 0)
			.map((s) => (/^\d+$/.test(s) ? Number(s) : s)),
	);
	let cursor: unknown = clone;
	for (const step of steps.slice(0, -1)) {
		// SAFETY: the fixture's patch paths address existing containers.
		cursor = (cursor as Record<string | number, unknown>)[step];
	}
	// SAFETY: same invariant — the final step addresses an existing slot.
	(cursor as Record<string | number, unknown>)[steps[steps.length - 1] as string | number] = value;
	return clone;
}

describe("shared signed vector (protocol/mutation-v3/fixtures/signed-vectors.json)", () => {
	// test-contract: invariant — the CLI reproduces and authenticates the
	// exact shared bytes; the cloud producer must reproduce the SAME bytes
	// with WebCrypto.
	it("P4: the shared vector authenticates and its hash reproduces", () => {
		// SAFETY: the vector envelope is a sealed valid fixture.
		expect(computeResultHash(vector.envelope as never)).toBe(vector.envelope.result_hash);
		expect(reasonOf(vector.envelope, vectorInputs())).toBe("AUTHENTICATED");
	});

	for (const tamper of vector.tamper_cases) {
		// test-contract: security — every shared tamper case EXECUTES and
		// fails as declared.
		it(`tamper: ${tamper.name}`, () => {
			const patched = applyPatch(vector.envelope, tamper.patch_path, tamper.value);
			expect(reasonOf(patched, vectorInputs())).toContain(tamper.expected_failure_includes);
		});
	}
});

interface SharedBundle {
	name: string;
	envelope: Record<string, unknown>;
	/** INDEPENDENTLY supplied expectations — never derived from the
	 *  response envelope (sixth-pass P1). */
	expected_job: VerifyInputs["expectedJob"];
	server_authority: VerifyInputs["serverAuthority"];
	expected_admission: VerifyInputs["expectedAdmission"];
	acceptance_receipt: string;
	execution_receipt?: string;
	terminalization_receipt?: string;
	report_text?: string;
	registry_override?: Record<string, { not_before?: string; revoked_at?: string }>;
	expected_failure_includes?: string;
}

const BUNDLES_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../protocol/mutation-v3/fixtures/signed-bundles.json",
);
// SAFETY: repo-committed fixture this suite exists to validate.
const bundles = JSON.parse(readFileSync(BUNDLES_PATH, "utf-8")) as {
	contract_version: string;
	verification_now: string;
	registry: V3KeyRegistry;
	vectors: SharedBundle[];
	negative_cases: SharedBundle[];
};

function bundleInputs(bundle: SharedBundle): VerifyInputs {
	// The fixture is SELF-CONTAINED: registry, clock, and expectations come
	// from the file, so another repository can execute it independently.
	let registry = bundles.registry;
	for (const [keyId, override] of Object.entries(bundle.registry_override ?? {})) {
		// SAFETY: overrides only narrow validity windows of declared keys.
		registry = { ...registry, [keyId]: { ...registry[keyId], ...override } as V3KeyRegistry[string] };
	}
	const inputs: VerifyInputs = {
		expectedJob: bundle.expected_job,
		serverAuthority: bundle.server_authority,
		expectedAdmission: bundle.expected_admission,
		keyRegistry: registry,
		now: bundles.verification_now,
		receipts: { acceptance: bundle.acceptance_receipt },
	};
	if (bundle.execution_receipt !== undefined) inputs.receipts.execution = bundle.execution_receipt;
	if (bundle.terminalization_receipt !== undefined) {
		inputs.receipts.terminalization = bundle.terminalization_receipt;
	}
	if (bundle.report_text !== undefined) inputs.report = Buffer.from(bundle.report_text, "utf8");
	return inputs;
}

describe("shared signed bundles (protocol/mutation-v3/fixtures/signed-bundles.json)", () => {
	// test-contract: invariant — the fixture's contract version is ASSERTED
	// against the implementation's (seventh pass P1-7), not merely typed.
	it("declares the implementation's contract version", () => {
		expect(bundles.contract_version).toBe(PROTOCOL_V3_VERSION);
	});

	// test-contract: invariant — one complete signed bundle per kind; an
	// emptied fixture must not pass silently.
	it("carries all six kinds", () => {
		// SAFETY: bundle envelopes are plain-JSON fixtures.
		const kinds = bundles.vectors.map((b) => (b.envelope as { kind: string }).kind).sort();
		expect(kinds).toEqual([
			"cancelled",
			"execution_failed",
			"expired",
			"mutation_result",
			"not_mutatable",
			"suite_red",
		]);
	});

	for (const bundle of bundles.vectors) {
		// test-contract: public-api — every shared bundle authenticates end
		// to end; the cloud producer must emit these exact shapes.
		it(`bundle: ${bundle.name}`, () => {
			expect(reasonOf(bundle.envelope, bundleInputs(bundle))).toBe("AUTHENTICATED");
		});
	}

	for (const negative of bundles.negative_cases) {
		// test-contract: security — every shared negative case (receipt,
		// report, key-window, cross-echo) EXECUTES and fails as declared.
		it(`negative: ${negative.name}`, () => {
			expect(reasonOf(negative.envelope, bundleInputs(negative))).toContain(
				negative.expected_failure_includes ?? "",
			);
		});
	}
});
