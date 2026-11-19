// Mutation-directed companion for coverage-edit-baseline-integrity.ts
// (kill-proof census 2026-11-05). Fault: the high-water short-circuit
// `after !== null && after >= before` becomes `after === null || after >= before`,
// so DELETING an entry's high-water (or re-keying a full-suite value to a
// scoped one) is allowed silently instead of producing the `coverage-edit-hw`
// finding.
import { describe, expect, it } from "vitest";
import { detectCoverageEdit } from "./coverage-edit-baseline-integrity.js";

const FILE = "/repo/.interlinked/coverage-edit-baseline.json";
const SCOPE = "scoped:0123456789ab";
const always = () => true;

describe("detectCoverageEdit — a removed high-water is a loosening", () => {
	// test-contract: invariant - deleting `hw` from a kept scoped entry with f and scope untouched must fire coverage-edit-hw naming the removal
	it("fires when the explicit high-water is deleted from an otherwise unchanged scoped entry", () => {
		const findings = detectCoverageEdit(FILE, { "src/a.ts": { f: 0.996, scope: SCOPE, hw: 1 } }, { "src/a.ts": { f: 0.996, scope: SCOPE } }, always);
		expect(findings.map((f) => f.rule)).toEqual(["coverage-edit-hw:src/a.ts"]);
		expect(findings[0]).toEqual(expect.objectContaining({ before: 1, after: undefined }));
		expect(findings[0]?.message).toMatch(/high-water for src\/a\.ts removed/);
	});

	// test-contract: boundary - re-keying a legacy full-suite 1 to an equal scoped value loses the implied high-water, so both the re-key and the hw removal are reported
	it("fires the high-water removal alongside the re-key when a full-suite value becomes scoped at equal f", () => {
		const rules = detectCoverageEdit(FILE, { "src/a.ts": 1 }, { "src/a.ts": { f: 1, scope: SCOPE } }, always).map((f) => f.rule);
		expect(rules).toEqual(["coverage-edit-scope:src/a.ts", "coverage-edit-hw:src/a.ts"]);
	});
});
