import { describe, expect, it } from "vitest";
import { parseAnswer } from "./answers.js";
import type { DecisionQuestion } from "./types.js";

const contract = { kind: "choose", options: { a: "A", b: "B" } } as unknown as DecisionQuestion;

describe("answers mutation kills", () => {
	// test-contract: boundary — a distribution summing to 0.95 is rejected (tolerance is 0.01)
	it("rejects a distribution that sums to 0.95", () => {
		expect(() => parseAnswer({ kind: "choice", probabilities: { a: 0.5, b: 0.45 } }, contract)).toThrow(
			"distribution does not sum to one",
		);
	});

	// test-contract: boundary — a distribution within 0.01 of one is accepted
	it("accepts a distribution that sums to 1.005", () => {
		expect(parseAnswer({ kind: "choice", probabilities: { a: 0.5, b: 0.505 } }, contract).kind).toBe("choice");
	});
});
