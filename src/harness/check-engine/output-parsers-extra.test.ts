import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	parseCargoJson,
	parseGolangciLintJson,
	parseOsvScannerJson,
	parseRuffJson,
} from "./output-parsers-extra.js";

describe("parseOsvScannerJson", () => {
	it("returns null when the parsed JSON has no usable 'results' shape", () => {
		expect(parseOsvScannerJson(JSON.stringify(null))).toBeNull();
		expect(parseOsvScannerJson(JSON.stringify({}))).toBeNull();
		expect(parseOsvScannerJson(JSON.stringify({ results: "not-an-array" }))).toBeNull();
	});

	it("skips a 'result' entry with no packages field entirely", () => {
		expect(parseOsvScannerJson(JSON.stringify({ results: [{}] }))).toBeNull();
	});

	it("skips a package with no vulnerabilities field, and a vulnerability with no id", () => {
		const payload = JSON.stringify({
			results: [
				{
					packages: [
						// No `vulnerabilities` key at all (buildVulnScoreMap's `?? []`).
						{ groups: [{ ids: ["X"], max_severity: "9.9" }] },
						// A vulnerability entry with no `id` — skipped by `!v.id continue`.
						{ vulnerabilities: [{ severity: [{ score: "9.9" }] }], groups: [{ ids: [] }] },
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		expect(r).toMatchObject({ critical: 1, low: 1, total: 2 });
	});

	it("skips a package with no groups field entirely", () => {
		const payload = JSON.stringify({
			results: [{ packages: [{ vulnerabilities: [{ id: "A" }] }] }],
		});
		expect(parseOsvScannerJson(payload)).toBeNull();
	});

	it("buckets every CVSS tier (critical/high/moderate/low) from groups[].max_severity", () => {
		const payload = JSON.stringify({
			results: [
				{
					packages: [
						{ vulnerabilities: [{ id: "A" }], groups: [{ ids: ["A"], max_severity: "9.8" }] },
						{ vulnerabilities: [{ id: "B" }], groups: [{ ids: ["B"], max_severity: "7.5" }] },
						{ vulnerabilities: [{ id: "C" }], groups: [{ ids: ["C"], max_severity: "5.0" }] },
						{ vulnerabilities: [{ id: "D" }], groups: [{ ids: ["D"], max_severity: "2.0" }] },
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		expect(r).toMatchObject({ critical: 1, high: 1, moderate: 1, low: 1, total: 4 });
	});

	it("falls back to per-vuln severity score when max_severity is absent/invalid, preferring the max among a group's ids", () => {
		const payload = JSON.stringify({
			results: [
				{
					packages: [
						{
							vulnerabilities: [
								{ id: "A", severity: [{ score: "5.0" }] },
								{ id: "B", severity: [{ score: "9.0" }] },
								{ id: "C", severity: [{ score: "1.0" }] },
							],
							// "missing" has no vulnScore entry (exercises the s===undefined
							// skip); "not-a-number" has an unparseable max_severity (exercises
							// the Number.isNaN(n) skip in resolveGroupScore).
							groups: [{ ids: ["missing", "A", "B", "C"], max_severity: "not-a-number" }],
						},
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		// Highest of A/B/C is B's 9.0 -> critical bucket.
		expect(r).toMatchObject({ critical: 1, total: 1 });
	});

	it("buckets a group with no ids and no max_severity as low (score stays null)", () => {
		const payload = JSON.stringify({
			results: [{ packages: [{ vulnerabilities: [], groups: [{}] }] }],
		});
		const r = parseOsvScannerJson(payload);
		expect(r).toMatchObject({ low: 1, total: 1 });
	});

	it("extractNumericScore skips a missing score and a non-numeric score, using the first valid one", () => {
		const payload = JSON.stringify({
			results: [
				{
					packages: [
						{
							vulnerabilities: [
								{
									id: "X",
									severity: [{}, { score: "not-a-number" }, { score: "9.1" }],
								},
							],
							groups: [{ ids: ["X"] }],
						},
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		expect(r).toMatchObject({ critical: 1, total: 1 });
	});

	it("preserves the tool name and renders every nonzero bucket in order", () => {
		const payload = JSON.stringify({
			results: [{
				packages: [{
					groups: [
						{ ids: ["C"], max_severity: "9.0" },
						{ ids: ["H"], max_severity: "7.0" },
						{ ids: ["M"], max_severity: "4.0" },
						{ ids: ["L"], max_severity: "3.9" },
					],
				}],
			}],
		});
		expect(parseOsvScannerJson(payload)).toEqual({
			tool: "osv-scanner",
			total: 4,
			critical: 1,
			high: 1,
			moderate: 1,
			low: 1,
			detail: "1 critical, 1 high, 1 moderate, 1 low — C, H, M, L",
		});
	});

	it("does not render zero-valued buckets or an empty id suffix", () => {
		const highOnly = JSON.stringify({
			results: [{ packages: [{ groups: [{ ids: ["H"], max_severity: "7.0" }] }] }],
		});
		const noIds = JSON.stringify({
			results: [{ packages: [{ groups: [{ max_severity: "2.0" }] }] }],
		});
		expect(parseOsvScannerJson(highOnly)?.detail).toBe("1 high — H");
		expect(parseOsvScannerJson(noIds)?.detail).toBe("1 low");
	});

	it("uses vulnerability scores only when max_severity is absent, and keeps the first five ids", () => {
		const groups = Array.from({ length: 6 }, (_, i) => ({ ids: [`V${i}`] }));
		const payload = JSON.stringify({
			results: [{
				packages: [{
					vulnerabilities: [{ id: "V0", severity: [{ score: "9.0" }] }],
					groups,
				}],
			}],
		});
		const result = parseOsvScannerJson(payload);
		expect(result).toMatchObject({ critical: 1, low: 5, total: 6 });
		expect(result?.detail).toBe("1 critical, 5 low — V0, V1, V2, V3, V4");
	});

	it("prefers an explicit max_severity over a higher member vulnerability score", () => {
		const payload = JSON.stringify({
			results: [{
				packages: [{
					vulnerabilities: [{ id: "V", severity: [{ score: "9.9" }] }],
					groups: [{ ids: ["V"], max_severity: "4.0" }],
				}],
			}],
		});
		expect(parseOsvScannerJson(payload)).toMatchObject({ moderate: 1, critical: 0 });
	});

	it("does not treat CVSS-prefixed strings as numeric scores, but accepts a parseable bare score", () => {
		const payload = JSON.stringify({
			results: [{
				packages: [{
					vulnerabilities: [
						{ id: "vector", severity: [{ score: "CVSS:3.1/AV:N" }] },
						{ id: "bare", severity: [{ score: "7.2CVSS" }] },
					],
				groups: [{ ids: ["vector"] }, { ids: ["bare"] }],
				}],
			}],
		});
		expect(parseOsvScannerJson(payload)).toMatchObject({ high: 1, low: 1, total: 2 });
	});

	it("does not index a vulnerability whose id is empty", () => {
		const payload = JSON.stringify({
			results: [{
				packages: [{
					vulnerabilities: [{ id: "", severity: [{ score: "9.9" }] }],
					groups: [{ ids: [""] }],
				}],
			}],
		});
		expect(parseOsvScannerJson(payload)).toMatchObject({ low: 1, critical: 0, total: 1 });
	});

	// test-contract: boundary — an OSV group without ids has no member vulnerability to score
	it("does not use a vulnerability id as an implicit group member", () => {
		const payload = JSON.stringify({
			results: [{
				packages: [{
					vulnerabilities: [{ id: "Stryker was here", severity: [{ score: "9.9" }] }],
					groups: [{}],
				}],
			}],
		});
		expect(parseOsvScannerJson(payload)).toMatchObject({ low: 1, critical: 0, total: 1 });
	});
});

describe("parseRuffJson", () => {
	it("prefers finding.row/finding.column when present", () => {
		const payload = JSON.stringify([
			{ filename: "a.py", row: 3, column: 1, code: "E1", message: "m1" },
		]);
		const results = parseRuffJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({ line: 3, column: 1 });
	});

	it("falls back to finding.location.row/column when row/column are absent", () => {
		const payload = JSON.stringify([
			{ filename: "a.py", location: { row: 7, column: 4 }, code: "E2", message: "m2" },
		]);
		const results = parseRuffJson(payload);
		expect(nonNull(results[0])).toMatchObject({ line: 7, column: 4 });
	});

	it("defaults line to 0 and column to undefined when neither row nor location is present", () => {
		const payload = JSON.stringify([{ filename: "a.py", code: "E3", message: "m3" }]);
		const results = parseRuffJson(payload);
		expect(nonNull(results[0])).toMatchObject({ line: 0 });
		expect(nonNull(results[0]).column).toBeUndefined();
	});

	it("defaults file to '' when filename is absent", () => {
		const payload = JSON.stringify([{ row: 1, code: "E4", message: "m4" }]);
		const results = parseRuffJson(payload);
		expect(nonNull(results[0]).file).toBe("");
	});

	it("returns no findings for valid JSON that is not an array", () => {
		expect(parseRuffJson("{}")).toEqual([]);
		expect(parseRuffJson("null")).toEqual([]);
	});

	it("includes the autofix hint only when applicability is a string", () => {
		const payload = JSON.stringify([
			{ filename: "a.py", code: "E1", message: "m1", fix: { applicability: "safe" } },
			{ filename: "b.py", code: "E2", message: "m2", fix: { applicability: 42 } },
		]);
		expect(parseRuffJson(payload)).toEqual([
			{
				tool: "ruff",
				severity: "warning",
				file: "a.py",
				line: 0,
				column: undefined,
				message: "E1: m1 [safe autofix: `ruff check --fix`]",
				ruleId: "E1",
			},
			{
				tool: "ruff",
				severity: "warning",
				file: "b.py",
				line: 0,
				column: undefined,
				message: "E2: m2",
				ruleId: "E2",
			},
		]);
	});

	it("keeps the parser's exact finding identity and defaults", () => {
		expect(parseRuffJson(JSON.stringify([{ code: "E4", message: "m4" }]))).toEqual([
			{
				tool: "ruff",
				severity: "warning",
				file: "",
				line: 0,
				column: undefined,
				message: "E4: m4",
				ruleId: "E4",
			},
		]);
	});

	// test-contract: boundary — Ruff JSON findings are defined as an array, not any iterable JSON value
	it("returns no findings for a valid JSON string", () => {
		expect(parseRuffJson(JSON.stringify("diagnostic text"))).toEqual([]);
	});
});

describe("parseCargoJson", () => {
	it("parses an error-level compiler-message with a full span, and maps a non-error level to warning with defaults", () => {
		const lines = [
			JSON.stringify({
				reason: "compiler-message",
				message: {
					level: "error",
					spans: [{ file_name: "a.rs", line_start: 5, column_start: 2 }],
					message: "boom",
					code: { code: "E001" },
				},
			}),
			JSON.stringify({
				reason: "compiler-message",
				message: {
					level: "warning",
					spans: [{}],
				},
			}),
		];
		const results = parseCargoJson(lines.join("\n"), "cargo-check");
		expect(results).toHaveLength(2);
		expect(nonNull(results[0])).toMatchObject({
			tool: "cargo-check",
			severity: "error",
			file: "a.rs",
			line: 5,
			column: 2,
			message: "boom",
			ruleId: "E001",
		});
		expect(nonNull(results[1])).toMatchObject({
			tool: "cargo-check",
			severity: "warning",
			file: "",
			line: 0,
			message: "",
			ruleId: undefined,
		});
	});

	it("P1: a non-JSON line interleaved between two valid compiler-message lines is skipped, not fatal", () => {
		const lines = [
			JSON.stringify({
				reason: "compiler-message",
				message: {
					level: "warning",
					spans: [{ file_name: "a.rs", line_start: 1, column_start: 1 }],
					message: "first",
				},
			}),
			"Compiling foo v0.1.0 (/path/to/foo)",
			JSON.stringify({
				reason: "compiler-message",
				message: {
					level: "error",
					spans: [{ file_name: "b.rs", line_start: 2, column_start: 2 }],
					message: "second",
				},
			}),
		];
		const results = parseCargoJson(lines.join("\n"), "cargo-clippy");
		expect(results).toHaveLength(2);
		expect(results.map((r) => r.file)).toEqual(["a.rs", "b.rs"]);
	});

	it("N1: a numeric nested code.code is not leaked into ruleId", () => {
		const lines = [
			JSON.stringify({
				reason: "compiler-message",
				message: {
					level: "error",
					spans: [{ file_name: "a.rs", line_start: 1, column_start: 1 }],
					message: "boom",
					code: { code: 42 },
				},
			}),
		];
		const results = parseCargoJson(lines.join("\n"), "cargo-check");
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).ruleId).toBeUndefined();
	});

	it("skips malformed messages, empty spans, and non-compiler cargo events", () => {
		const lines = [
			JSON.stringify({ reason: "compiler-message", message: null }),
			JSON.stringify({ reason: "compiler-message", message: { level: "error", spans: [] } }),
			JSON.stringify({
				reason: "build-finished",
				message: { level: "error", spans: [{ file_name: "not-a-finding.rs", line_start: 1 }] },
			}),
			"null",
			"   ",
		];
		expect(parseCargoJson(lines.join("\n"), "cargo-check")).toEqual([]);
	});

	it("accepts a null span as a compiler message with safe span defaults", () => {
		const line = JSON.stringify({
			reason: "compiler-message",
			message: { level: "warning", spans: [null], message: "missing location" },
		});
		expect(parseCargoJson(line, "cargo-check")).toEqual([
			{
				tool: "cargo-check",
				severity: "warning",
				file: "",
				line: 0,
				column: undefined,
				message: "missing location",
				ruleId: undefined,
			},
		]);
	});

	it("does not accept a nonnumeric span column", () => {
		const line = JSON.stringify({
			reason: "compiler-message",
			message: {
				level: "error",
				spans: [{ file_name: "a.rs", line_start: 3, column_start: "4" }],
				message: "bad column",
			},
		});
		expect(parseCargoJson(line, "cargo-check")).toMatchObject([{ line: 3, column: undefined }]);
	});
});

describe("parseGolangciLintJson", () => {
	it("reads file/line from issue.Pos when present", () => {
		const payload = JSON.stringify({
			Issues: [{ FromLinter: "govet", Text: "bad", Pos: { Filename: "a.go", Line: 10, Column: 2 } }],
		});
		const results = parseGolangciLintJson(payload);
		expect(nonNull(results[0])).toMatchObject({ file: "a.go", line: 10, column: 2 });
	});

	it("defaults file to '' and line to 0 when issue.Pos is entirely absent", () => {
		const payload = JSON.stringify({ Issues: [{ FromLinter: "govet", Text: "bad" }] });
		const results = parseGolangciLintJson(payload);
		expect(nonNull(results[0])).toMatchObject({ file: "", line: 0 });
		expect(nonNull(results[0]).column).toBeUndefined();
	});

	it("P1: processes multiple issues through the field-by-field validator", () => {
		const payload = JSON.stringify({
			Issues: [
				{ FromLinter: "govet", Text: "bad1", Pos: { Filename: "a.go", Line: 1, Column: 1 } },
				{ FromLinter: "staticcheck", Text: "bad2", Pos: { Filename: "b.go", Line: 2, Column: 2 } },
			],
		});
		const results = parseGolangciLintJson(payload);
		expect(results).toHaveLength(2);
		expect(results.map((r) => r.ruleId)).toEqual(["govet", "staticcheck"]);
		expect(results.map((r) => r.file)).toEqual(["a.go", "b.go"]);
	});

	it("N1: a numeric FromLinter is not leaked into ruleId (stays string | undefined)", () => {
		const payload = JSON.stringify({
			Issues: [{ FromLinter: 42, Text: "bad", Pos: { Filename: "a.go", Line: 1 } }],
		});
		const results = parseGolangciLintJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).ruleId).toBeUndefined();
	});

	it("validates issue text and preserves the complete finding shape", () => {
		const payload = JSON.stringify({
			Issues: [
				{ FromLinter: "govet", Text: "bad", Pos: { Filename: "a.go", Line: 10, Column: 2 } },
				{ FromLinter: "govet", Text: 42, Pos: { Filename: "b.go", Line: 11, Column: "3" } },
			],
		});
		expect(parseGolangciLintJson(payload)).toEqual([
			{
				tool: "golangci-lint",
				severity: "warning",
				file: "a.go",
				line: 10,
				column: 2,
				message: "govet: bad",
				ruleId: "govet",
			},
			{
				tool: "golangci-lint",
				severity: "warning",
				file: "b.go",
				line: 11,
				column: undefined,
				message: "govet: undefined",
				ruleId: "govet",
			},
		]);
	});

	it("skips null and malformed top-level issue containers", () => {
		expect(parseGolangciLintJson("null")).toEqual([]);
		expect(parseGolangciLintJson(JSON.stringify({ Issues: {} }))).toEqual([]);
		expect(parseGolangciLintJson(JSON.stringify({ Issues: [null] }))).toEqual([]);
	});

	it("does not let one malformed issue discard neighboring valid findings", () => {
		const payload = JSON.stringify({
			Issues: [
				{ FromLinter: "govet", Text: "first", Pos: { Filename: "a.go", Line: 1 } },
				null,
				{ FromLinter: "staticcheck", Text: "last", Pos: { Filename: "b.go", Line: 2 } },
			],
		});
		expect(parseGolangciLintJson(payload).map((result) => result.message)).toEqual([
			"govet: first",
			"staticcheck: last",
		]);
	});

	// test-contract: boundary — golangci-lint location fields must retain CheckResult's typed shape
	it("defaults non-string filenames and nonnumeric lines", () => {
		const payload = JSON.stringify({
			Issues: [{
				FromLinter: "govet",
				Text: "bad location types",
				Pos: { Filename: 42, Line: "10", Column: 3 },
			}],
		});
		expect(parseGolangciLintJson(payload)).toEqual([{
			tool: "golangci-lint",
			severity: "warning",
			file: "",
			line: 0,
			column: 3,
			message: "govet: bad location types",
			ruleId: "govet",
		}]);
	});
});
