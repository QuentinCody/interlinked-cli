import { expect, it } from "vitest";
import { contentCheckRunner } from "./file-checks-content.js";
import type { CodeQualityIssue } from "./tool-results-types.js";

it("retains every finding in detector order when a file exceeds the argument limit", () => {
	const rows: CodeQualityIssue[] = [];
	const runCheck = contentCheckRunner({ content: "input", file: "/repo/a.ts", relPath: "a.ts" });
	runCheck("sample", rows, (content, file) => Array.from({ length: 150_001 }, (_, index) => ({
		line: index + 1, text: content + file,
	})));
	expect(rows).toHaveLength(150_001);
	expect(rows[0]).toEqual({ check: "sample", file: "a.ts", line: 1, message: "input/repo/a.ts" });
	expect(rows.at(-1)?.line).toBe(150_001);
});
