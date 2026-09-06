// ===========================================
// Protocol v3 — strict envelope parser (unit pins)
// ===========================================
// The fixture-driven cross-repo matrix lives in acceptance.test.ts; these
// are the parser's own P/N pins, built from the one valid baseline each
// case perturbs. Review 2026-08-31 second pass: the negative set now
// carries the reviewer's adversarial reproductions (truncated census,
// nested unknown keys, format/path/timestamp abuse, receipt-kind
// mismatches, red mutation_result, arbitrary no-test policies). A trailing
// unlabeled describe (2026-09-04) adds behavior-only branch coverage: a
// test_files length ceiling, a closed scope.mode enum, engine exit_code
// integer strictness, red_witness_satisfied tri-state strictness, the
// not_mutatable green-suite requirement, and execution_failed's two
// partial-evidence rules (no receipt yet, uncoupled census group).

import { describe, expect, it } from "vitest";
import { MAX_REPORT_BYTES, MAX_TEST_FILES } from "./field-checks.js";
import { parseUntrustedEnvelope } from "./parse.js";
import { validMutationResult, validNotMutatable } from "./test-envelopes.js";

/** The parse verdict flattened for assertion: "ACCEPTED" or the reason. */
function parseVerdict(raw: unknown): string {
	const outcome = parseUntrustedEnvelope(raw);
	return outcome.ok ? "ACCEPTED" : outcome.reason;
}

/** A valid pre-execution cancelled envelope (terminalization arm). */
function validCancelled(): Record<string, unknown> {
	// SAFETY: widened deliberately — keys are deleted to build the
	// pre-execution shape; the parser under test re-narrows it.
	const env = {
		...validMutationResult(),
		kind: "cancelled",
		cancellation_reason: "operator_stop",
	} as Record<string, unknown>;
	for (const key of ["execution_receipt_hash", "attempt_id", "scope", "engine", "runner", "census", "excluded", "mutants", "identity_algorithm", "test_run", "report"]) {
		delete env[key];
	}
	env.terminalization_record_hash = "c".repeat(64);
	return env;
}

describe("parseUntrustedEnvelope — positive (must accept)", () => {
	// test-contract: public-api — a complete terminal mutation_result parses
	// and round-trips its discriminant.
	it("P1: accepts a complete mutation_result", () => {
		const outcome = parseUntrustedEnvelope(validMutationResult());
		expect(outcome.ok).toBe(true);
	});

	// test-contract: public-api — a controlled not_mutatable satisfying the
	// full proof contract parses.
	it("P2: accepts a controlled not_mutatable", () => {
		expect(parseVerdict(validNotMutatable())).toBe("ACCEPTED");
	});

	// test-contract: boundary — the pre-execution terminal pair: cancelled
	// with a terminalization record hash and NO attempt id.
	it("P3: accepts a cancelled envelope bound to a terminalization record", () => {
		expect(parseVerdict(validCancelled())).toBe("ACCEPTED");
	});
});

describe("parseUntrustedEnvelope — negative (must reject)", () => {
	// test-contract: security — the versioned identity is the contract; an
	// unknown version or kind never half-parses.
	it("N1: rejects wrong protocol_version, unknown kind, and non-objects", () => {
		expect(
			parseVerdict({ ...validMutationResult(), protocol_version: "interlinked-mutation/2.0" }),
		).toContain("protocol_version");
		expect(parseVerdict({ ...validMutationResult(), kind: "partial_result" })).toContain("kind");
		expect(parseVerdict("not an object")).toContain("object");
	});

	// test-contract: security — portable identity is a versioned, complete
	// tuple. An engine-local id or missing structural component cannot enter
	// the authenticated boundary.
	it("N1b: rejects v1/engine ids and incomplete v2 provenance", () => {
		const base = validMutationResult();
		expect(parseVerdict({ ...base, identity_algorithm: "interlinked-site-v1" })).toContain(
			"interlinked-site-v2",
		);
		expect(
			parseVerdict({
				...base,
				mutants: [{ ...base.mutants[0]!, mutant_id: "stryker-1" }, base.mutants[1]!],
			}),
		).toContain("mutant_id");
		const missingContext = { ...base.mutants[0] } as Partial<(typeof base.mutants)[number]>;
		delete missingContext.symbol_context;
		expect(parseVerdict({ ...base, mutants: [missingContext, base.mutants[1]!] })).toContain(
			"symbol_context",
		);
	});

	// test-contract: invariant — EXACTLY ONE of execution_receipt_hash /
	// terminalization_record_hash binds the result; evidence kinds require
	// the execution arm; an attempt id without execution is a contradiction.
	it("N2: rejects receipt-binding violations", () => {
		const both = { ...validMutationResult(), terminalization_record_hash: "d".repeat(64) };
		expect(parseVerdict(both)).toContain("exactly one");
		// SAFETY: widened deliberately to delete a key for the probe.
		const neither = { ...validMutationResult() } as Record<string, unknown>;
		delete neither.execution_receipt_hash;
		delete neither.attempt_id;
		expect(parseVerdict(neither)).toContain("exactly one");
		// SAFETY: widened deliberately to swap the receipt arm.
		const termOnEvidence = { ...validMutationResult() } as Record<string, unknown>;
		delete termOnEvidence.execution_receipt_hash;
		delete termOnEvidence.attempt_id;
		termOnEvidence.terminalization_record_hash = "d".repeat(64);
		expect(parseVerdict(termOnEvidence)).toContain("requires an execution receipt");
		const attemptWithoutExec = { ...validCancelled(), attempt_id: "attempt_9" };
		expect(parseVerdict(attemptWithoutExec)).toContain("no attempt ran");
	});

	// test-contract: bug — the reviewer's truncated-census repro: generated
	// 10 with 2 executable rows and 1 exclusion parsed under the old
	// bound-only check. Exact arithmetic now rejects it.
	it("N3: rejects inexact census arithmetic (the truncated-census hole)", () => {
		const truncated = {
			...validMutationResult(),
			census: { generated: 10, executable: 2, approved_excluded: 1 },
		};
		expect(parseVerdict(truncated)).toContain("generated must equal executable + approved_excluded");
		const shortBase = validMutationResult();
		const rowsShort = {
			...shortBase,
			mutants: [shortBase.mutants[0]],
		};
		expect(parseVerdict(rowsShort)).toContain("one status row per executable mutant");
		const exclusionsShort = { ...validMutationResult(), excluded: [] };
		expect(parseVerdict(exclusionsShort)).toContain("one excluded row per approved exclusion");
		const overlap = {
			...validMutationResult(),
			excluded: [
				{
					...validMutationResult().excluded[0]!,
					mutant_id: validMutationResult().mutants[0]!.mutant_id,
					policy_id: "policy-string-literal-noise",
				},
			],
		};
		expect(parseVerdict(overlap)).toContain("disjoint");
	});

	// test-contract: security — unknown keys are rejected RECURSIVELY, so a
	// producer cannot smuggle unvalidated evidence at any level.
	it("N4: rejects unknown top-level AND nested keys", () => {
		expect(parseVerdict({ ...validMutationResult(), extra_field: true })).toContain("unknown key");
		const nested = {
			...validMutationResult(),
			engine: { name: "stryker", version: "8.2.0", config_hash: "f".repeat(64), exit_code: 0, smuggled: 1 },
		};
		expect(parseVerdict(nested)).toContain('unknown key "smuggled"');
	});

	// test-contract: bug — execution-proof gaps: zero executed tests, a red
	// overlay on mutation_result, a non-zero engine exit, zero generated
	// mutants dressed as mutation_result.
	it("N5: rejects execution-proof gaps", () => {
		const base = validMutationResult();
		expect(
			parseVerdict({ ...base, test_run: { ...base.test_run, executed_test_count: 0 } }),
		).toContain("executed_test_count");
		expect(
			parseVerdict({ ...base, test_run: { ...base.test_run, overlay_green: false } }),
		).toContain("suite_red kind");
		expect(
			parseVerdict({ ...base, engine: { ...base.engine, exit_code: 1 } }),
		).toContain("exit_code 0");
		const zeroGenerated = {
			...base,
			census: { generated: 0, executable: 0, approved_excluded: 0 },
			excluded: [],
			mutants: [],
		};
		expect(parseVerdict(zeroGenerated)).toContain("not_mutatable kind");
	});

	// test-contract: security — format strictness: hash charset/length,
	// RFC3339 timestamps, traversal paths, duplicate test files.
	it("N6: rejects malformed hashes, timestamps, paths, and duplicates", () => {
		const base = validMutationResult();
		expect(parseVerdict({ ...base, result_hash: "XYZ" })).toContain("sha-256");
		expect(parseVerdict({ ...base, occurred_at: "yesterday" })).toContain("RFC3339");
		expect(
			parseVerdict({ ...base, job: { ...base.job, target_file: "../../etc/passwd" } }),
		).toContain("repo-relative");
		expect(
			parseVerdict({
				...base,
				scope: { ...base.scope, test_files: ["src/a.test.ts", "src/a.test.ts"] },
			}),
		).toContain("duplicates");
		expect(
			parseVerdict({
				...base,
				runner: { build: "b", image_digest: "latest" },
			}),
		).toContain("image digest");
	});

	// test-contract: security — the signed pointer is also an allocation
	// budget. An authenticated producer cannot make the CLI buffer an
	// arbitrarily large R2 object before discovering it is unusable.
	it("N6b: rejects report pointers above the fixed memory ceiling", () => {
		const base = validMutationResult();
		expect(
			parseVerdict({
				...base,
				report: { ...base.report, bytes: MAX_REPORT_BYTES + 1 },
			}),
		).toContain(`1 through ${MAX_REPORT_BYTES}`);
	});

	// test-contract: invariant — v1 scope: incremental must be false and
	// mutation_scope must be whole_file.
	it("N7: rejects incremental and non-whole-file scope echoes", () => {
		const base = validMutationResult();
		expect(parseVerdict({ ...base, scope: { ...base.scope, incremental: true } })).toContain(
			"incremental",
		);
		expect(
			parseVerdict({ ...base, scope: { ...base.scope, mutation_scope: "range" } }),
		).toContain("whole_file");
	});

	// test-contract: security — the zero-test escape takes a CONTROLLED
	// policy id, never arbitrary prose.
	it("N8: rejects arbitrary no_test_policy values", () => {
		const nm = validNotMutatable();
		const zeroTests = {
			...nm,
			test_run: { ...nm.test_run, executed_test_count: 0 },
			no_test_policy: "trust-me",
		};
		expect(parseVerdict(zeroTests)).toContain("policy-");
		expect(
			parseVerdict({ ...nm, census: { generated: 1, executable: 0, approved_excluded: 1 } }),
		).toContain("not_mutatable");
	});

	// test-contract: invariant — partial-evidence coupling: suite_red rows
	// travel as a group; execution_failed must mark completeness explicitly.
	it("N9: rejects uncoupled or unmarked partial evidence", () => {
		const base = validMutationResult();
		// SAFETY: widened deliberately to build a suite_red missing mutants.
		const redWithCensusOnly = {
			...base,
			kind: "suite_red",
			test_run: { ...base.test_run, overlay_green: false },
		} as Record<string, unknown>;
		delete redWithCensusOnly.report;
		delete redWithCensusOnly.mutants;
		expect(parseVerdict(redWithCensusOnly)).toContain("travel together");
		const failedNoneWithBlocks = {
			...validCancelled(),
			kind: "execution_failed",
			failure_classification: "sandbox_oom",
			evidence_completeness: "none",
			mutants: [{ ...validMutationResult().mutants[0], mutant_id: "5".repeat(64), status: "survived" }],
		};
		// SAFETY: widened by validCancelled; extra keys added for the probe.
		delete (failedNoneWithBlocks as Record<string, unknown>).cancellation_reason;
		expect(parseVerdict(failedNoneWithBlocks)).toContain('forbids evidence blocks');
	});
});

describe("parseUntrustedEnvelope — additional branch coverage (must reject)", () => {
	// test-contract: boundary — test_files has an upper bound, not merely a
	// per-entry shape check; a too-long array rejects before any entry is read.
	it("rejects a test_files array beyond the configured maximum", () => {
		const base = validMutationResult();
		const tooMany = Array.from({ length: MAX_TEST_FILES + 1 }, (_unused, i) => `f${i}`);
		expect(
			parseVerdict({ ...base, scope: { ...base.scope, test_files: tooMany } }),
		).toContain(`at most ${MAX_TEST_FILES} paths`);
	});

	// test-contract: invariant — scope.mode is a closed enum, not a free string.
	it("rejects a scope.mode value outside the closed enum", () => {
		const base = validMutationResult();
		expect(
			parseVerdict({ ...base, scope: { ...base.scope, mode: "manual_pick" } }),
		).toContain("mode must be one of");
	});

	// test-contract: invariant — engine.exit_code must be a safe integer; a
	// fractional value cannot describe a process exit status.
	it("rejects a non-integer engine exit_code", () => {
		const base = validMutationResult();
		expect(
			parseVerdict({ ...base, engine: { ...base.engine, exit_code: 1.5 } }),
		).toContain("exit_code must be a safe integer");
	});

	// test-contract: invariant — red_witness_satisfied is a tri-state
	// (true/false/null); any other value type is rejected outright.
	it("rejects a non-boolean, non-null red_witness_satisfied", () => {
		const base = validMutationResult();
		expect(
			parseVerdict({ ...base, test_run: { ...base.test_run, red_witness_satisfied: "yes" } }),
		).toContain("red_witness_satisfied must be a boolean or null");
	});

	// test-contract: bug — a not_mutatable proof requires a GREEN affected
	// suite; a red overlay cannot certify "nothing to mutate".
	it("rejects a not_mutatable envelope whose affected suite is red", () => {
		const nm = validNotMutatable();
		expect(
			parseVerdict({ ...nm, test_run: { ...nm.test_run, overlay_green: false } }),
		).toContain("requires a green affected suite");
	});

	// test-contract: invariant — partial evidence cannot precede the
	// execution it claims to describe.
	it("rejects execution_failed partial evidence with no execution receipt", () => {
		// SAFETY: widened deliberately — keys are deleted/added to build the
		// partial-evidence-without-execution-receipt shape the parser rejects.
		const partialNoExecReceipt = {
			...validCancelled(),
			kind: "execution_failed",
			failure_classification: "sandbox_oom",
			evidence_completeness: "partial",
			scope: validMutationResult().scope,
		} as Record<string, unknown>;
		delete partialNoExecReceipt.cancellation_reason;
		expect(parseVerdict(partialNoExecReceipt)).toContain(
			"evidence cannot precede execution",
		);
	});

	// test-contract: invariant — execution_failed's partial-evidence census
	// group must travel together or not at all, the same rule suite_red
	// enforces on its own (separately-implemented) copy of the check.
	it("rejects execution_failed partial evidence with an uncoupled census group", () => {
		// SAFETY: widened deliberately to delete keys not allowed alongside
		// execution_failed's evidence-group fixture below.
		const base = { ...validMutationResult() } as Record<string, unknown>;
		delete base.report;
		delete base.excluded;
		delete base.mutants;
		delete base.identity_algorithm;
		const partialUncoupled = {
			...base,
			kind: "execution_failed",
			failure_classification: "sandbox_oom",
			evidence_completeness: "partial",
		};
		expect(parseVerdict(partialUncoupled)).toBe(
			"partial evidence: census, excluded, mutants, and identity_algorithm must travel together or not at all",
		);
	});
});
