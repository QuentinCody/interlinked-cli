// ===========================================
// Protocol v3 — mechanical evidence classification (unit pins)
// ===========================================
// Fourth pass 2026-08-31: classification accepts ONLY the verified
// bundle — every pin below runs the FULL trust chain (signed receipts,
// structural report, sealing) through the shared fabricators before it
// can classify anything. No clean verdict exists at this layer.

import { describe, expect, it } from "vitest";
import { classifyEvidence } from "./evidence.js";
import { authenticateFixture } from "./test-authentication.js";
import { validMutationResult, validNotMutatable } from "./test-envelopes.js";
import { IDENTITY_ALGORITHM } from "./types.js";
import { parseAndVerify, type VerifiedEvidenceBundle } from "./verify.js";

/** Full chain: fabricate receipts/report, seal, parse, verify. */
function bundleOf(rawInput: Record<string, unknown>): VerifiedEvidenceBundle {
	const { raw, inputs } = authenticateFixture(rawInput);
	const outcome = parseAndVerify(raw, inputs);
	if (!outcome.ok) throw new Error(`fixture must authenticate: ${outcome.reason}`);
	return outcome.bundle;
}

describe("classifyEvidence — positive (must fire)", () => {
	// test-contract: public-api — a complete all-killed run is complete with
	// zero adverse observations; a survivor is an OBSERVATION, never a
	// verdict (the earlier P0: a survivor-carrying result must not read as
	// certifying clean at this layer).
	it("P1: complete runs classify complete; survivors are counted, not judged", () => {
		const clean = classifyEvidence(bundleOf({ ...validMutationResult() }));
		expect(clean.completeness).toBe("complete");
		expect(clean.observations).toEqual({
			killed: 2,
			survived: 0,
			uncovered: 0,
			inconclusive: 0,
			suite_red: false,
		});
		const base = validMutationResult();
		const withSurvivor = classifyEvidence(
			bundleOf({
				...base,
				mutants: [
					{ ...base.mutants[0], mutant_id: "1".repeat(64), status: "killed" },
					{ ...base.mutants[1], mutant_id: "3".repeat(64), status: "survived" },
				],
			}),
		);
		expect(withSurvivor.completeness).toBe("complete");
		expect(withSurvivor.observations.survived).toBe(1);
	});

	// test-contract: invariant — uncovered is mutation DEBT, distinct from
	// survivors; timeout/indeterminate are INCONCLUSIVE and make the
	// evidence partial with a reason.
	it("P2: uncovered ≠ survivor; inconclusive rows degrade completeness", () => {
		const base = validMutationResult();
		const mixed = classifyEvidence(
			bundleOf({
				...base,
				census: { generated: 4, executable: 3, approved_excluded: 1 },
				mutants: [
					{ ...base.mutants[0], mutant_id: "1".repeat(64), status: "uncovered" },
					{ ...base.mutants[1], mutant_id: "3".repeat(64), status: "timeout" },
					{ ...base.mutants[1], mutant_id: "4".repeat(64), status: "indeterminate" },
				],
			}),
		);
		expect(mixed.observations.uncovered).toBe(1);
		expect(mixed.observations.survived).toBe(0);
		expect(mixed.observations.inconclusive).toBe(2);
		expect(mixed.completeness).toBe("partial");
		expect(mixed.incompleteness_reasons.join(" ")).toContain("inconclusive");
	});

	// test-contract: public-api — a controlled not_mutatable (structurally
	// verified zero-mutant report) is complete evidence with nothing
	// observed.
	it("P3: not_mutatable classifies complete and empty", () => {
		const nm = classifyEvidence(bundleOf({ ...validNotMutatable() }));
		expect(nm.completeness).toBe("complete");
		expect(nm.observations.suite_red).toBe(false);
	});
});

describe("classifyEvidence — negative (must not overclaim)", () => {
	it("N0: rejects a structural copy that lacks verifier runtime provenance", () => {
		const genuine = bundleOf({ ...validMutationResult() });
		// SAFETY: deliberate type forgery exercises the runtime trust boundary.
		const forged = { ...genuine };
		expect(() => classifyEvidence(forged)).toThrow("not minted by the verifier");
	});

	// test-contract: security — a red suite is never complete evidence; its
	// mutant work-list is not authoritative.
	it("N1: suite_red is partial with the red observation", () => {
		const base = validMutationResult();
		// SAFETY: widened deliberately to drop the report for the red shape.
		const red = {
			...base,
			kind: "suite_red",
			test_run: { ...base.test_run, overlay_green: false },
		} as Record<string, unknown>;
		delete red.report;
		delete red.census;
		delete red.excluded;
		delete red.mutants;
		delete red.identity_algorithm;
		const c = classifyEvidence(bundleOf(red));
		expect(c.completeness).toBe("partial");
		expect(c.observations.suite_red).toBe(true);
		expect(c.incompleteness_reasons.length).toBeGreaterThan(0);
	});

	// test-contract: invariant — execution_failed inherits its EXPLICIT
	// marker; cancelled/expired carry no evidence at all.
	it("N2: failure and terminal-only kinds never classify complete", () => {
		const provenance = validMutationResult().mutants[0];
		const partial = bundleOf({
			...terminalFailed(),
			evidence_completeness: "partial",
			mutants: [{ ...provenance, mutant_id: "5".repeat(64), status: "survived" }],
			census: { generated: 1, executable: 1, approved_excluded: 0 },
			excluded: [],
			identity_algorithm: IDENTITY_ALGORITHM,
		});
		const cp = classifyEvidence(partial);
		expect(cp.completeness).toBe("partial");
		expect(cp.observations.survived).toBe(1);
		const none = classifyEvidence(bundleOf(terminalFailed()));
		expect(none.completeness).toBe("none");
		expect(none.incompleteness_reasons.join(" ")).toContain("sandbox_oom");
	});
});

function terminalFailed(): Record<string, unknown> {
	const base = validMutationResult();
	// SAFETY: widened deliberately — evidence keys are stripped to build the
	// bare failure shape; the parser re-narrows it.
	const env = {
		...base,
		kind: "execution_failed",
		failure_classification: "sandbox_oom",
		evidence_completeness: "none",
	} as Record<string, unknown>;
	for (const key of ["scope", "engine", "runner", "census", "excluded", "mutants", "identity_algorithm", "test_run", "report"]) {
		delete env[key];
	}
	return env;
}
