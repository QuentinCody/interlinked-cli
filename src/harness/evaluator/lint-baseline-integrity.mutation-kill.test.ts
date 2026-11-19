// Mutation-directed companion for lint-baseline-integrity.ts (kill-proof
// census 2026-11-05). Fault: the default prior count for a fingerprint absent
// from the adopted scope (`: 0`) replaced by +Infinity, which lets a NEW
// allowance be reseeded inside an already-adopted scope without a finding.
import { describe, expect, it } from "vitest";
import { detectBaselineGaming } from "./baseline-integrity-gate.js";
import { detectLintBaselineGaming } from "./lint-baseline-integrity.js";

const FILE = "/repo/.interlinked/lint-baseline.json";

describe("lint baseline integrity — new fingerprint inside an adopted scope", () => {
	// test-contract: invariant - a fingerprint that had no allowance before counts as 0, so adding one with a positive count is an increase the gate must report
	it("reports a brand-new fingerprint added to an adopted scope as an allowance increase from 0", () => {
		const before = { version: 1, entries: { "ruff:.": { existing: 1 } } };
		const after = { version: 1, entries: { "ruff:.": { existing: 1, reseeded: 3 } } };
		expect(detectLintBaselineGaming(FILE, before, after)).toEqual([
			expect.objectContaining({ rule: "lint-allowance-increased", before: 0, after: 3 }),
		]);
	});

	// test-contract: public-api - the same reseed reaches the shared baseline-integrity surface and blocks there
	it("blocks the reseed through the shared detectBaselineGaming surface", () => {
		const before = JSON.stringify({ version: 1, entries: { "ruff:.": { existing: 1 } } });
		const after = JSON.stringify({ version: 1, entries: { "ruff:.": { existing: 1, reseeded: 1 } } });
		const findings = detectBaselineGaming(FILE, before, after);
		expect(findings.map((f) => f.rule)).toEqual(["lint-allowance-increased"]);
		expect(findings[0]?.before).toBe(0);
	});
});
