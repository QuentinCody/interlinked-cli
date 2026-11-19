// ===========================================
// file-checks-shared unit tests
// ===========================================
// Pins the behaviour of the primitives extracted to break the
// file-checks ↔ group-file runtime import cycle. `toIssues` is the only
// value export; the rest are types (compile-time only).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { toIssues } from "./file-checks-shared.js";
import { currentVerifyTimings, recordVerifyInputDeferral, withVerifyTimings } from "./check-timing.js";
import { getEffectiveSkipChecks } from "./advisory-skips.js";
import { checkRoot, reportNotMeasured, withCheckRoot } from "../../harness/checks/check-root.js";
import { captureVerifyCheckEvidence } from "./file-checks-shared.js";
import { getProjectCheckEvidence, withProjectCheckEvidence } from "../../harness/checks/project-check-evidence.js";

describe("toIssues", () => {
	it.each([
		[undefined, undefined, false],
		[undefined, true, true],
		["dead_exports", true, false],
	] as const)("executes inline detectors only in the selected scope (%s, %s)", async (skip, all, selected) => {
		const root = mkdtempSync(join(tmpdir(), "verify-inline-selection-"));
		const previousExitCode = process.exitCode;
		const detector = vi.fn(() => [{ line: 2, text: "candidate" }]);
		try {
			await withVerifyTimings(root, () => {
				const result = toIssues("dead_exports", "library.ts", detector);
				expect(result).toHaveLength(selected ? 1 : 0);
				expect(currentVerifyTimings()).toHaveLength(selected ? 1 : 0);
			}, { skipChecks: getEffectiveSkipChecks(skip, all) });
			expect(detector).toHaveBeenCalledTimes(selected ? 1 : 0);
			expect(process.exitCode).toBe(previousExitCode);
			// Selection is scoped to this invocation; it must not suppress later hooks or scans.
			expect(toIssues("dead_exports", "library.ts", detector)).toHaveLength(1);
		} finally {
			process.exitCode = previousExitCode;
			rmSync(root, { recursive: true, force: true });
		}
	});
    it("retains the complete expression span for machine-readable diagnostics", () => {
        expect(toIssues("expression_size", "a.ts", [{ line: 2, endLine: 7, startOffset: 20, endOffset: 99, text: "large computation" }]))
            .toEqual([{ check: "expression_size", file: "a.ts", line: 2, endLine: 7, startOffset: 20, endOffset: 99, message: "large computation" }]);
    });
	it("retains supplied secondary-source hashes without reading or replacing them", () => {
		const sourceEvidence = [{ file: "parse.ts", sha256: "a".repeat(64), line: 2, role: "producer" as const },
			{ file: "service.ts", sha256: "b".repeat(64), line: 9, role: "consumer" as const }];
		const result = toIssues("numeric_zero_default", "service.ts", [{ line: 9, text: "numeric fallback", sourceEvidence }]);
		expect(result[0]?.sourceEvidence).toEqual(sourceEvidence);
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

describe("captureVerifyCheckEvidence", () => {
	it("P2 composes with captured project bytes and its single structured gap callback", async () => {
		const root = mkdtempSync(join(process.cwd(), "scratch", "verify-project-evidence-")), file = join(root, "service.ts");
		const previousExitCode = process.exitCode;
		writeFileSync(file, "export const captured = 1;");
		try {
			await withVerifyTimings(root, () => withProjectCheckEvidence(root, [file], () => {
				const project = getProjectCheckEvidence(root)!;
				expect(project.readFile(file)).toBe("export const captured = 1;");
				writeFileSync(file, "export const later = 2;");
				const matches = captureVerifyCheckEvidence("numeric_zero_default", "service.ts", root, () => {
					expect(getProjectCheckEvidence(root)).toBe(project);
					expect(project.readFile(file)).toBe("export const captured = 1;");
					project.reportUnavailable("numeric_zero_default", "helper.ts", "unavailable helper control");
					return [{ line: 1, text: "retained independent numeric candidate" }];
				});
				expect(matches).toHaveLength(1);
				expect(currentVerifyTimings()).toEqual([expect.objectContaining({ check: "numeric_zero_default", skipped: 1,
					unavailable_inputs: [{ file: "helper.ts", reason: "unavailable helper control" }] })]);
			}, gap => recordVerifyInputDeferral(gap.check, { file: gap.file, reason: gap.reason })));
			expect(process.exitCode).toBe(75);
		} finally { process.exitCode = previousExitCode; rmSync(root, { recursive: true, force: true }); }
	});

	it("P1 retains positive matches and one structured gap while composing nested roots", async () => {
		const root = mkdtempSync(join(process.cwd(), "scratch", "verify-scoped-evidence-"));
		const previousExitCode = process.exitCode;
		try {
			await withVerifyTimings(root, () => {
				const outer = withCheckRoot("/outer-selected-root", () => {
					const result = captureVerifyCheckEvidence("unvalidated_input_boundary", "service.ts", root, () => {
						expect(checkRoot()).toBe(root);
						reportNotMeasured("unvalidated_input_boundary", "partial parser coverage control");
						reportNotMeasured("unvalidated_input_boundary", "partial parser coverage control");
						return [{ line: 4, text: "retained lexical candidate" }];
					});
					expect(checkRoot()).toBe("/outer-selected-root");
					return result;
				});
				expect(outer.result).toEqual([{ line: 4, text: "retained lexical candidate" }]);
				expect(outer.notMeasured).toHaveLength(1);
				expect(currentVerifyTimings()).toEqual([expect.objectContaining({ check: "unvalidated_input_boundary", skipped: 1,
					unavailable_inputs: [{ file: "service.ts", reason: expect.stringContaining("partial parser coverage control") }] })]);
			});
			expect(process.exitCode).toBe(75);
		} finally { process.exitCode = previousExitCode; rmSync(root, { recursive: true, force: true }); }
	});

	it("N1 retains unavailable disclosure outside a timed public verification run", () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			captureVerifyCheckEvidence("unvalidated_input_boundary", "service.ts", process.cwd(), () => {
				reportNotMeasured("unvalidated_input_boundary", "compatibility coverage control");
				return [];
			});
			expect(stderr.mock.calls.map(call => String(call[0])).join("")).toContain("compatibility coverage control");
		} finally { stderr.mockRestore(); }
	});
});
