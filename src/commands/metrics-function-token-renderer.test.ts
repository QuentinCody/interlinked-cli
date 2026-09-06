// ===========================================
// metrics-function-token-renderer tests — the "not measured" render path
// ===========================================
// Every other renderer line here is exercised transitively through
// `interlinked metrics`; this file targets the one branch that isn't: a report
// whose `notMeasured` list is non-empty (the summary and inventory renderers
// both special-case it, and the empty-array early return was the only path
// prior coverage took).
import { describe, expect, it } from "vitest";
import type { FunctionTokenMetricsReport } from "./metrics-function-tokens.js";
import {
	renderFunctionTokenInventoryLines,
	renderFunctionTokenSummaryLines,
} from "./metrics-function-token-renderer.js";

const EMPTY_SUMMARY = {
	count: 0,
	sum: 0,
	min: null,
	mean: null,
	p50: null,
	p75: null,
	p90: null,
	p95: null,
	p99: null,
	max: null,
};

function reportWithNotMeasured(
	notMeasured: FunctionTokenMetricsReport["notMeasured"],
): FunctionTokenMetricsReport {
	return {
		schemaVersion: 1,
		tokenizer: "interlinked-code-v2",
		cap: 500,
		elapsedMs: 1,
		scope: {
			includeTests: false,
			discoveredFiles: 1,
			candidateFiles: 1,
			measuredFiles: 0,
			filesWithFunctions: 0,
			productFiles: 0,
			testFiles: 0,
			unmeasuredFiles: notMeasured.length,
			functionCount: 0,
			productFunctions: 0,
			testFunctions: 0,
		},
		totals: {
			summedFunctionTokens: 0,
			functionsOverCap: 0,
			enforcedFunctionsOverCap: 0,
			functionTokens: EMPTY_SUMMARY,
			summedFileFunctionTokens: EMPTY_SUMMARY,
		},
		distributions: { functions: {}, files: {} },
		topFunctions: [],
		topFiles: [],
		functions: [],
		files: [],
		notMeasured,
	};
}

describe("renderFunctionTokenInventoryLines — not-measured section", () => {
	it("P1: a non-empty notMeasured list prints each file's reason, with an advisory suffix for test-scope entries", () => {
		const lines = renderFunctionTokenInventoryLines(
			reportWithNotMeasured([
				{
					file: "src/weird.exotic",
					language: "exotic",
					reason: "the exotic exact function-token analyzer was unavailable",
					kind: "unavailable",
					sourceScope: "product",
					capEnforced: true,
				},
				{
					file: "src/weird.exotic.test.ts",
					language: "exotic",
					reason: "the exotic exact function-token analyzer was unavailable",
					kind: "unavailable",
					sourceScope: "test",
					capEnforced: false,
				},
			]),
		);
		const text = lines.join("\n");
		expect(text).toContain("Files not measured (2)");
		expect(text).toContain(
			"src/weird.exotic — the exotic exact function-token analyzer was unavailable",
		);
		expect(text).toContain(
			"src/weird.exotic.test.ts [advisory test] — the exotic exact function-token analyzer was unavailable",
		);
	});

	it("N1: an empty notMeasured list adds no section at all", () => {
		const lines = renderFunctionTokenInventoryLines(reportWithNotMeasured([]));
		expect(lines.join("\n")).not.toContain("Files not measured");
	});
});

describe("renderFunctionTokenSummaryLines — not-measured preview", () => {
	it("P1: the preview lists a product-scope file with no advisory suffix", () => {
		const lines = renderFunctionTokenSummaryLines(
			reportWithNotMeasured([
				{
					file: "src/weird.exotic",
					language: "exotic",
					reason: "the exotic exact function-token analyzer was unavailable",
					kind: "unavailable",
					sourceScope: "product",
					capEnforced: true,
				},
			]),
		);
		const text = lines.join("\n");
		expect(text).toContain(
			"src/weird.exotic — the exotic exact function-token analyzer was unavailable",
		);
		expect(text).not.toContain("src/weird.exotic [advisory test]");
	});
});
