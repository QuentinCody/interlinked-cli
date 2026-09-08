// ===========================================
// tool-results-types smoke test
// ===========================================
// Type-only module — just verify that the types import successfully and the
// runtime structure cohesively matches the declaration.

import { describe, expect, it } from "vitest";
import type {
	AuditResult,
	CodeQualityIssue,
	CodeQualityResults,
	DiagnosticResult,
} from "./tool-results-types.js";

describe("tool-results-types", () => {
	it("CodeQualityIssue matches the expected shape", () => {
		const issue: CodeQualityIssue = {
			check: "strong_typing",
			file: "src/foo.ts",
			line: 7,
			message: "any usage",
		};
		expect(issue.check).toBe("strong_typing");
	});

	it("CodeQualityResults accepts empty arrays for all keys", () => {
		const empty: Partial<CodeQualityResults> = {
			strongTyping: [],
			suppressions: [],
			largeFiles: [],
		};
		expect(empty.strongTyping).toEqual([]);
	});

	it("DiagnosticResult is an alias for CheckResult (compile-time)", () => {
		const d: DiagnosticResult = {
			tool: "tsc",
			file: "x.ts",
			line: 1,
			severity: "error",
			message: "m",
		};
		expect(d.tool).toBe("tsc");
	});

	it("AuditResult shape has vulnerability counts (compile-time)", () => {
		const a: AuditResult = {
			tool: "npm" as const,
			total: 0,
			critical: 0,
			high: 0,
			moderate: 0,
			low: 0,
			detail: "",
		};
		expect(a.total).toBe(0);
	});
});
