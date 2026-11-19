import { describe, expect, it } from "vitest";
import { validateMetricContract } from "./serialization.js";

const base = {
	id: "c1", version: "1", construct: "k", unit: "function", population: "p", question: "q",
	kind: "score", on: [], aggregation: "mean", validation: "v", phase: "pilot",
};

describe("serialization mutation kills", () => {
	// test-contract: boundary — a score contract with a single level is rejected
	it("rejects a score contract with one level", () => {
		expect(() => validateMetricContract({ ...base, levels: ["only"] })).toThrow("invalid score levels");
	});

	// test-contract: boundary — a score contract with two levels is accepted
	it("accepts a score contract with two levels", () => {
		expect(validateMetricContract({ ...base, levels: ["lo", "hi"] }).id).toBe("c1");
	});
});
