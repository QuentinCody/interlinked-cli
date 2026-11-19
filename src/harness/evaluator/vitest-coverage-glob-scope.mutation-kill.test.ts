import { describe, expect, it } from "vitest";
import { compareCoverageGlobScope } from "./vitest-coverage-glob-scope.js";

describe("compareCoverageGlobScope — dot segments", () => {
	// test-contract: bug — a dot-directory segment is unsupported glob syntax, so the comparison abstains instead of proving a reduction
	it("returns undecidable for src/.hidden/**", () => {
		const result = compareCoverageGlobScope(
			{ include: ["src/.hidden/**"], exclude: [] },
			{ include: ["src/.hidden/**"], exclude: ["src/.hidden/**"] },
		);
		expect(result.kind).toBe("undecidable");
	});
});
