import { describe, expect, it } from "vitest";
import { coverageSpan } from "./coverage-span.js";

describe("coverageSpan — census kill", () => {
	// test-contract: invariant — an open-ended (null) end column becomes the maximum safe integer
	it("maps a null end column to Number.MAX_SAFE_INTEGER", () => {
		const span = coverageSpan({ start: { line: 3, column: 4 }, end: { line: 5, column: null } });
		expect(span.endColumn).toBe(Number.MAX_SAFE_INTEGER);
		expect(span.endLine).toBe(5);
	});
});
