// ===========================================
// file-checks-shared unit tests
// ===========================================
// Pins the behaviour of the primitives extracted to break the
// file-checks ↔ group-file runtime import cycle. `toIssues` is the only
// value export; the rest are types (compile-time only).

import { describe, expect, it } from "vitest";

import { toIssues } from "./file-checks-shared.js";

describe("toIssues", () => {
    it("retains the complete expression span for machine-readable diagnostics", () => {
        expect(toIssues("expression_size", "a.ts", [{ line: 2, endLine: 7, startOffset: 20, endOffset: 99, text: "large computation" }]))
            .toEqual([{ check: "expression_size", file: "a.ts", line: 2, endLine: 7, startOffset: 20, endOffset: 99, message: "large computation" }]);
    });
	it("maps each match to a CodeQualityIssue carrying check, file, line, message", () => {
		const issues = toIssues("console_statements", "src/a.ts", [
			{ line: 12, text: "console.log left in" },
		]);
		expect(issues).toEqual([
			{ check: "console_statements", file: "src/a.ts", line: 12, message: "console.log left in" },
		]);
	});

	it("returns [] when there are no matches", () => {
		expect(toIssues("silent_catches", "src/b.ts", [])).toEqual([]);
	});

	it("preserves the order of the input matches", () => {
		const issues = toIssues("complexity", "src/c.ts", [
			{ line: 3, text: "first" },
			{ line: 1, text: "second" },
			{ line: 2, text: "third" },
		]);
		expect(issues.map((i) => i.message)).toEqual(["first", "second", "third"]);
		expect(issues.map((i) => i.line)).toEqual([3, 1, 2]);
	});

	it("stamps the same check + file onto every produced issue", () => {
		const issues = toIssues("missing_return_types", "src/d.ts", [
			{ line: 5, text: "fn one" },
			{ line: 9, text: "fn two" },
		]);
		expect(issues).toHaveLength(2);
		for (const issue of issues) {
			expect(issue.check).toBe("missing_return_types");
			expect(issue.file).toBe("src/d.ts");
		}
	});
});
