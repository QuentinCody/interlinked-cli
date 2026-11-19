import { describe, expect, it } from "vitest";
import { PartialToolReportError } from "../tool-errors.js";
import { parseCompleteBiomeReport } from "./biome-process-verdict.js";

const diagnostic = { category: "lint/suspicious/noDebugger", severity: "warning", message: "fixture warning", location: { path: "a.js", start: { line: 3, column: 1 } } };
function report(diagnostics: unknown[] = [], summary: Record<string, unknown> = {}) {
	return JSON.stringify({ diagnostics, summary: { errors: 0, warnings: diagnostics.length, infos: 0, skipped: 0, diagnosticsNotPrinted: 0, ...summary } });
}

describe("complete Biome machine report", () => {
	it("retains every warning beyond the native terminal diagnostic default", () => {
		const results = parseCompleteBiomeReport(report(Array.from({ length: 33 }, () => diagnostic)), "/repo");
		expect(results).toHaveLength(33);
		expect(results[0]).toMatchObject({ tool: "biome", severity: "warning", file: "a.js", line: 3 });
	});
	it.each(["{ malformed", "{}", '{"diagnostics":[],"summary":{}}'])("rejects malformed or incomplete reporting %s", output => {
		expect(() => parseCompleteBiomeReport(output, "/repo")).toThrow(PartialToolReportError);
	});
	it.each([{ diagnosticsNotPrinted: 13 }, { skipped: 1 }, { warnings: 34 }])("retains positives with incomplete summary %j", summary => {
		try { parseCompleteBiomeReport(report([diagnostic], summary), "/repo"); }
		catch (error) {
			if (!(error instanceof PartialToolReportError)) throw error;
			expect(error.results).toHaveLength(1);
			return;
		}
		throw new Error("Expected incomplete report");
	});
	it("keeps a native size-skip diagnostic unavailable while retaining other findings", () => {
		const skipped = { severity: "warning", category: "check", message: "", location: { path: "large.js", start: { line: 0, column: 0 } } };
		expect(() => parseCompleteBiomeReport(report([diagnostic, skipped]), "/repo")).toThrow("large.js");
		try { parseCompleteBiomeReport(report([diagnostic, skipped]), "/repo"); }
		catch (error) {
			if (!(error instanceof PartialToolReportError)) throw error;
			expect(error.results).toHaveLength(1);
		}
	});
	it("keeps an unlocated filesystem diagnostic at project scope without inventing a filename", () => {
		const unavailable = { severity: "warning", category: "check", message: "" };
		expect(() => parseCompleteBiomeReport(report([diagnostic, unavailable]), "/repo")).toThrow("<project>");
	});
	it("retains an error severity and an absolute path relative to the selected project", () => {
		const error = { ...diagnostic, severity: "error", location: { path: "/repo/a.js", start: { line: 3, column: 1 } } };
		expect(parseCompleteBiomeReport(report([error], { errors: 1, warnings: 0 }), "/repo")).toMatchObject([{ file: "a.js", severity: "error" }]);
	});
	it("accepts a valid empty report and skipped suggested fixes", () => {
		expect(parseCompleteBiomeReport(report([], { suggestedFixesSkipped: 20 }), "/repo")).toEqual([]);
	});
});
