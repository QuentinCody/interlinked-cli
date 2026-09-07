import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../lib/json-types.js";
import { summarizeTestQualitySections, TEST_QUALITY_JSON_KEYS } from "./output-json-test-quality.js";
import { emptyResults } from "./tool-results-types.js";

const stubSummarizer = (list: readonly { file: string }[]): JsonObject => ({ count: list.length });

describe("summarizeTestQualitySections — positive (must hold)", () => {
	it("P1: emits one snake_case key per test-quality bucket, in registry order", () => {
		const out = summarizeTestQualitySections(emptyResults(), stubSummarizer);
		expect(Object.keys(out)).toEqual([...TEST_QUALITY_JSON_KEYS]);
	});

	it("P2: routes each bucket through the summarizer it is given", () => {
		const r = emptyResults();
		r.fixedPortInTest.push({ file: "a.test.ts", line: 3, message: "m", check: "fixed_port_in_test" });
		const out = summarizeTestQualitySections(r, stubSummarizer);
		expect(out.fixed_port_in_test).toEqual({ count: 1 });
		expect(out.mock_only_test).toEqual({ count: 0 });
	});
});

describe("summarizeTestQualitySections — negative (must not hold)", () => {
	it("N1: never emits a key outside the nineteen test-quality ids", () => {
		const out = summarizeTestQualitySections(emptyResults(), stubSummarizer);
		for (const key of Object.keys(out)) {
			expect(TEST_QUALITY_JSON_KEYS, key).toContain(key);
		}
		expect(Object.keys(out)).toHaveLength(19);
	});
});
