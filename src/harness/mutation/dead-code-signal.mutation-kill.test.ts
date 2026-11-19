import { describe, expect, it } from "vitest";
import { findDeadCodeCandidates, type SurvivorLike } from "./dead-code-signal.js";

const s = (id: string, replacement: string): SurvivorLike => ({
	id,
	line: 7,
	column: 1,
	endLine: 7,
	endColumn: 9,
	mutatorName: "ConditionalExpression",
	replacement,
});

describe("findDeadCodeCandidates — one report per line", () => {
	// test-contract: bug — a polarity-pair line with three survivors is reported once as high, not again as medium
	it("emits a single high candidate for a polarity pair plus a third survivor", () => {
		const hits = findDeadCodeCandidates([s("1", "true"), s("2", "false"), s("3", "true")]);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.confidence).toBe("high");
	});
});
