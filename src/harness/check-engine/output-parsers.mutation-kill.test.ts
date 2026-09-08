// ===========================================
// Check Engine — Output Parsers — mutation-kill companion
// ===========================================
// output-parsers.ts had zero test coverage before this file (see
// scratch/fleet-r3/CONTRACT-W6.md, LEAN MODE). Every case below targets a
// specific surviving mutant's OBSERVABLE behavior, not "kills the mutant."
// Receipts (including the suspected_equivalent mutants this file does not
// cover) live in scratch/fleet-r3/receipts/src_harness_check-engine_output-parsers.ts.jsonl.

import { describe, expect, it } from "vitest";
import {
	parseActionlintOutput,
	parseEslintOutput,
	parseNpmAuditJson,
	parseOxlintJson,
	parseSemgrepJson,
	parseShellcheckJson,
	parseTscOutput,
} from "./output-parsers.js";

describe("parseTscOutput", () => {
	// test-contract: invariant — the file/line/col diagnostic header must start
	// the line; a line that only contains one later in its text (e.g. after a
	// byte "." cannot cross, like a bare CR) is not a diagnostic to report.
	it("does not report a diagnostic whose header is not at the start of the line", () => {
		const output = "\rfoo.ts(1,2): error TS1234: bad thing";
		expect(parseTscOutput(output)).toEqual([]);
	});
});

describe("parseEslintOutput", () => {
	// test-contract: invariant — same anchored-header requirement as
	// parseTscOutput, for the eslint --format unix line shape.
	it("does not report a finding whose header is not at the start of the line", () => {
		const output = "\rfoo.ts:1:2: bad thing";
		expect(parseEslintOutput(output)).toEqual([]);
	});
});

describe("parseActionlintOutput", () => {
	// test-contract: invariant — same anchored-header requirement as
	// parseTscOutput, for the actionlint line shape.
	it("does not report a finding whose header is not at the start of the line", () => {
		const output = "\rfoo.yml:1:2: bad thing [rule]";
		expect(parseActionlintOutput(output)).toEqual([]);
	});
});

describe("parseSemgrepJson", () => {
	// test-contract: public-api — a finding whose check_id/start.line/start.col/
	// extra.message are the wrong JSON type must fall back to the documented
	// default (unknown/0/undefined/empty) rather than passing the raw,
	// wrong-typed value straight into the CheckResult.
	it("defaults wrong-typed check_id, start.line, start.col, and extra.message", () => {
		const payload = JSON.stringify({
			results: [
				{
					check_id: 123,
					path: "/repo/src/a.ts",
					start: { line: "5", col: "7" },
					extra: { message: 42 },
				},
			],
		});
		expect(parseSemgrepJson(payload, "/repo")).toEqual([
			{
				tool: "semgrep",
				severity: "warning",
				file: "src/a.ts",
				line: 0,
				column: undefined,
				message: "unknown:",
				ruleId: undefined,
			},
		]);
	});

	// test-contract: boundary — a non-string `path` must be treated as absent
	// (finding still reported, file falls back to "") rather than handed
	// raw to node:path's relative(), which throws on a non-string argument
	// and would silently drop the whole batch via the outer catch.
	it("treats a non-string path as absent instead of passing it to path.relative", () => {
		const payload = JSON.stringify({
			results: [
				{
					check_id: "rule",
					path: 123,
					start: { line: 1, col: 2 },
					extra: { message: "msg" },
				},
			],
		});
		expect(parseSemgrepJson(payload, "")).toEqual([
			{
				tool: "semgrep",
				severity: "warning",
				file: "",
				line: 1,
				column: 2,
				message: "rule: msg",
				ruleId: "rule",
			},
		]);
	});
});

describe("parseNpmAuditJson", () => {
	// test-contract: public-api — a non-numeric vulnerability count must fall
	// back to 0. If it were passed through raw, `+` between a number and a
	// string string-concatenates the whole running total instead of adding,
	// so the "all zero -> null" short-circuit would never fire.
	it("falls back to 0 for non-numeric high/moderate/low and reports no findings", () => {
		const payload = JSON.stringify({
			metadata: { vulnerabilities: { critical: 0, high: "5", moderate: "3", low: "1" } },
		});
		expect(parseNpmAuditJson(payload)).toBeNull();
		// Distinguish from a stub that always returns null: genuinely numeric
		// vulnerabilities must produce a real, fully-populated result.
		const validPayload = JSON.stringify({
			metadata: { vulnerabilities: { critical: 0, high: 5, moderate: 3, low: 1 } },
		});
		expect(parseNpmAuditJson(validPayload)).toEqual({
			tool: "npm audit",
			total: 9,
			critical: 0,
			high: 5,
			moderate: 3,
			low: 1,
			detail: "5 high, 3 moderate, 1 low",
		});
	});
});

describe("parseOxlintJson", () => {
	// test-contract: public-api — a diagnostic entry that isn't a JSON object
	// is skipped outright (no crash, no defaulted placeholder finding), and a
	// wrong-typed labels[0].span.line/column falls back to 0/undefined rather
	// than passing the raw value through.
	it("skips a non-object diagnostic entry and defaults a wrong-typed span", () => {
		const payload = JSON.stringify({
			diagnostics: [
				"not-a-diagnostic-object",
				{
					message: "m1",
					code: "c1",
					severity: 1,
					filename: "f1.js",
					labels: [{ span: { line: "9", column: "2" } }],
				},
				{
					message: "m2",
					code: "c2",
					severity: "error",
					filename: "f2.js",
					labels: [{ span: { line: 7, column: 3 } }],
				},
			],
		});
		expect(parseOxlintJson(payload)).toEqual([
			{
				tool: "oxlint",
				severity: "warning",
				file: "f1.js",
				line: 0,
				column: undefined,
				message: "m1",
				ruleId: "c1",
			},
			{
				tool: "oxlint",
				severity: "error",
				file: "f2.js",
				line: 7,
				column: 3,
				message: "m2",
				ruleId: "c2",
			},
		]);
	});
});

describe("parseShellcheckJson", () => {
	// test-contract: public-api — a comment entry that isn't a JSON object is
	// skipped outright (no crash, no defaulted placeholder finding), and a
	// wrong-typed line/column falls back to 0/undefined rather than passing
	// the raw value through.
	it("skips a non-object comment entry and defaults a wrong-typed line/column", () => {
		const payload = JSON.stringify({
			comments: [
				"not-a-comment-object",
				{ level: "warning", file: "f1.sh", line: "9", column: "2", message: "m1", code: "C1" },
				{ level: "error", file: "f2.sh", line: 5, column: 1, message: "m2", code: 2 },
			],
		});
		expect(parseShellcheckJson(payload)).toEqual([
			{
				tool: "shellcheck",
				severity: "warning",
				file: "f1.sh",
				line: 0,
				column: undefined,
				message: "m1",
				ruleId: "SCC1",
			},
			{
				tool: "shellcheck",
				severity: "error",
				file: "f2.sh",
				line: 5,
				column: 1,
				message: "m2",
				ruleId: "SC2",
			},
		]);
	});
});
