import { describe, expect, it } from "vitest";
import { PartialToolReportError } from "../tool-errors.js";
import { parseCompleteGitleaksReport, parseCompleteSemgrepReport, requireGenericProcessVerdict } from "./generic-process-verdict.js";

const finding = { path: "/repo/a.ts", start: { line: 3, col: 1 }, check_id: "fixture", extra: { message: "retained finding" } };
describe("generic process report completeness", () => {
	it.each(["malformed", "", "{}", "null", "[null]", '[{"File":"a.ts"}]'])("rejects incomplete Gitleaks JSON %s", output => {
		expect(() => parseCompleteGitleaksReport(output)).toThrow(PartialToolReportError);
	});
	it("accepts empty Gitleaks JSON and retains valid rows beside invalid rows", () => {
		expect(parseCompleteGitleaksReport("[]")).toEqual([]);
		const row = { File: "a.ts", StartLine: 2, RuleID: "fixture", Description: "redacted fixture" };
		expect(parseCompleteGitleaksReport(JSON.stringify([row]))).toMatchObject([{ file: "a.ts", line: 2 }]);
		expect(() => parseCompleteGitleaksReport(JSON.stringify([row, null]))).toThrow(PartialToolReportError);
		try { parseCompleteGitleaksReport(JSON.stringify([row, null])); }
		catch (error) {
			if (!(error instanceof PartialToolReportError)) throw error;
			expect(error.results).toHaveLength(1);
		}
	});
	it("retains native path-only findings with an unknown line", () => {
		expect(parseCompleteGitleaksReport(JSON.stringify([{ File: "audit.p12", StartLine: 0, RuleID: "pkcs12-file" }]))).toMatchObject([{ file: "audit.p12", line: 0 }]);
	});
	it("preserves Gitleaks UTF-8 BOM and surrounding whitespace compatibility", () => {
		expect(parseCompleteGitleaksReport("\uFEFF []\n")).toEqual([]);
	});
	it("retains positive Semgrep findings alongside unavailable scope errors", () => {
		try {
			parseCompleteSemgrepReport(JSON.stringify({ results: [finding], errors: [{ message: "rule timed out" }] }), "/repo");
			throw new Error("Expected partial report");
		} catch (error) {
			expect(error).toBeInstanceOf(PartialToolReportError);
			if (!(error instanceof PartialToolReportError)) throw error;
			expect(error.results).toMatchObject([{ ruleId: "fixture", line: 3 }]);
			expect(error.message).toContain("rule timed out");
		}
	});
	it.each(["{ malformed", "null", "{}", '{"results":[],"errors":{}}'])("rejects an invalid successful Semgrep report %s", output => {
		expect(() => parseCompleteSemgrepReport(output, "/repo")).toThrow("no complete");
	});
	it("accepts a successful complete empty Semgrep report", () => {
		expect(parseCompleteSemgrepReport('{"results":[],"errors":[]}', "/repo")).toEqual([]);
	});
	it("preserves existing UTF-8 BOM and whitespace transport compatibility", () => {
		expect(parseCompleteSemgrepReport(`\uFEFF ${JSON.stringify({ results: [finding], errors: [] })}\n`, "/repo")).toMatchObject([{ ruleId: "fixture" }]);
	});
	it.each([null, false, "finding", {}, { ...finding, check_id: "" }, { ...finding, path: "" },
		{ ...finding, start: null }, { ...finding, start: { line: 0, col: 1 } },
		{ ...finding, start: { line: 1.5, col: 1 } }, { ...finding, start: { line: 1, col: "bad" } },
		{ ...finding, extra: [] }, { ...finding, extra: { message: 7 } },
	])("MUST-FIRE: invalid Semgrep result rows cannot establish complete evidence %j", row => {
		expect(() => parseCompleteSemgrepReport(JSON.stringify({ results: [row], errors: [] }), "/repo")).toThrow("invalid result rows");
	});
	it("retains valid Semgrep positives beside malformed rows", () => {
		try {
			parseCompleteSemgrepReport(JSON.stringify({ results: [null, finding, { path: "incomplete.ts" }], errors: [] }), "/repo");
			throw new Error("Expected partial report");
		} catch (error) {
			expect(error).toBeInstanceOf(PartialToolReportError);
			if (!(error instanceof PartialToolReportError)) throw error;
			expect(error.results).toMatchObject([{ ruleId: "fixture", file: "a.ts", line: 3 }]);
			expect(error.message).toContain("invalid result rows");
		}
	});
	it("MUST-NOT-FIRE: retains native complex optional fields and finding metadata named errors", () => {
		const row = { ...finding, start: { line: 3, col: 1, offset: 12 }, end: { line: 4, col: 8, offset: 32 },
			extra: { message: "retained finding", severity: "ERROR", fingerprint: "requires login", engine_kind: "OSS", validation_state: "NO_VALIDATOR",
				metadata: { errors: ["domain-specific annotation"], cwe: ["CWE-89"], custom: { nested: [true, null, 1] } },
				metavars: { "$VALUE": { start: { line: 3, col: 1 }, end: { line: 3, col: 8 }, abstract_content: "value" } }, dataflow_trace: { taint_source: ["CliLoc", ["source"]] } } };
		expect(parseCompleteSemgrepReport(JSON.stringify({ results: [row], errors: [], paths: { scanned: ["a.ts"] }, skipped_rules: [], version: "1.156.0" }), "/repo")).toMatchObject([{ file: "a.ts", line: 3, message: "fixture: retained finding" }]);
	});
	it("distinguishes native scan errors from malformed result rows while retaining valid findings", () => {
		try {
			parseCompleteSemgrepReport(JSON.stringify({ results: [finding, null], errors: [{ type: "PartialParsing", code: 3, level: "warn", path: "other.ts", message: "native parser incomplete" }] }), "/repo");
			throw new Error("Expected native partial report");
		} catch (error) {
			if (!(error instanceof PartialToolReportError)) throw error;
			expect(error.results).toHaveLength(1);
			expect(error.message).toContain("native parser incomplete");
			expect(error.message).toContain("invalid result rows");
		}
	});
	it("retains parsed findings when process completion fails", () => {
		const results = parseCompleteSemgrepReport(JSON.stringify({ results: [finding] }), "/repo");
		expect(() => requireGenericProcessVerdict("semgrep", { stdout: "", stderr: "failure", code: 2, timedOut: false, killed: false }, results)).toThrow(PartialToolReportError);
	});
});
