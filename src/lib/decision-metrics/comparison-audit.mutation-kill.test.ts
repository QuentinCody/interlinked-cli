import { describe, expect, it } from "vitest";
import { auditComparison } from "./comparison-audit.js";
import type { AuditCase } from "./audit.js";

function cases(ruleProbability: number): AuditCase[] {
	return [false, true].map((positive, i) => ({
		id: String(i),
		timestamp: "2026-01-01",
		group: String(i),
		repository: "repo",
		family: "feature",
		positive,
		probability: positive ? 0.9 : 0.1,
		status: "answered" as const,
		size: [i],
		structural: [i],
		ruleProbability,
		reviewers: ["a", "b"],
		adjudicated: true,
	}));
}

describe("auditComparison — census kill", () => {
	// test-contract: error-path — arms with different baseline rule probabilities are rejected
	it("throws when the arms differ only in ruleProbability", () => {
		expect(() =>
			auditComparison(cases(0.2), cases(0.7), { cutoff: "2025-06-01", band: [0.2, 0.8] }),
		).toThrow("comparison labels, time split, and baseline evidence must be identical");
	});
});
