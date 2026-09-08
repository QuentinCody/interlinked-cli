import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import {
	filterResultsToFile,
	parseActionlintOutput,
	parseBiomeOutput,
	parseDocsCheckOutput,
	parseEslintOutput,
	parseGitleaksJson,
	parseHadolintJson,
	parseKnipJson,
	parseMypyOutput,
	parseNpmAuditJson,
	parseOsvScannerJson,
	parseOxlintJson,
	parseRuffJson,
	parseSemgrepJson,
	parseShellcheckJson,
	parseTaploOutput,
	parseTscOutput,
} from "../output-parsers.js";

describe("parseTscOutput", () => {
	it("parses file-level errors with line/column/ruleId", () => {
		const out = "src/a.ts(12,5): error TS2345: Argument not assignable";
		const results = parseTscOutput(out);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			tool: "tsc",
			severity: "error",
			file: "src/a.ts",
			line: 12,
			column: 5,
			ruleId: "TS2345",
			message: "TS2345: Argument not assignable",
		});
	});

	it("parses project-level errors without a file reference", () => {
		const out = "error TS2688: Cannot find type definition for 'node'.";
		const results = parseTscOutput(out);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			tool: "tsc",
			severity: "error",
			file: "tsconfig.json",
			line: 0,
			ruleId: "TS2688",
			message: "TS2688: Cannot find type definition for 'node'.",
		});
	});

	it("returns [] on empty output", () => {
		expect(parseTscOutput("")).toEqual([]);
	});

	it("requires 1+ digits for line/column (not just a single digit)", () => {
		const out = "a.ts(10,23): error TS1: msg";
		const results = parseTscOutput(out);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ line: 10, column: 23 });
	});

	it("allows arbitrary whitespace runs around 'error' and before the message", () => {
		const out = "a.ts(1,2):  error   TS1:   spaced message";
		const results = parseTscOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).message).toBe("TS1: spaced message");
	});

	it("captures the full multi-word message, not just its first character", () => {
		const out = "a.ts(1,2): error TS1: multiple words here";
		const results = parseTscOutput(out);
		expect(nonNull(results[0]).message).toBe("TS1: multiple words here");
	});

	it("allows arbitrary whitespace before a project-level message too", () => {
		const out = "error   TS2688:   spaced project message";
		const results = parseTscOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).message).toBe("TS2688: spaced project message");
	});

	it("does not treat 'error TSxxxx' appearing mid-line as a project-level error", () => {
		// The project-level regex must anchor to the start of the line — a line
		// that merely CONTAINS "error TSxxxx:" partway through (e.g. quoted or
		// nested in other prose) must not be misread as its own finding.
		const out = "note: see nested error TS9999: this is not a real diagnostic line";
		expect(parseTscOutput(out)).toEqual([]);
	});


});

describe("parseBiomeOutput", () => {
	it("parses biome lint lines", () => {
		const out = "src/a.ts:10:5 lint/suspicious/noDoubleEquals ━━━━━━";
		const results = parseBiomeOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).tool).toBe("biome");
		expect(nonNull(results[0]).ruleId).toBe("lint/suspicious/noDoubleEquals");
	});

	it("returns [] on empty output", () => {
		expect(parseBiomeOutput("")).toEqual([]);
	});
});

describe("parseEslintOutput", () => {
	it("parses eslint --format unix output with rule id", () => {
		const out = "src/a.ts:5:10: Missing semicolon. [semi]";
		const results = parseEslintOutput(out);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			tool: "eslint",
			severity: "warning",
			file: "src/a.ts",
			line: 5,
			column: 10,
			message: "Missing semicolon. [semi]",
			ruleId: "semi",
		});
	});

	it("leaves ruleId undefined when there is no trailing [rule] bracket", () => {
		const out = "src/a.ts:5:10: Missing semicolon.";
		const results = parseEslintOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).ruleId).toBeUndefined();
		expect(nonNull(results[0]).message).toBe("Missing semicolon.");
	});

	it("only extracts a ruleId when the bracket is the LAST thing on the line", () => {
		// A bracketed aside earlier in the message must not be mistaken for
		// the trailing rule marker.
		const out = "src/a.ts:5:10: warns about [notLast] then keeps talking";
		const results = parseEslintOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).ruleId).toBeUndefined();
	});

	it("trims trailing whitespace out of the message", () => {
		const out = "src/a.ts:5:10: trailing spaces here   ";
		const results = parseEslintOutput(out);
		expect(nonNull(results[0]).message).toBe("trailing spaces here");
	});

	it("ignores non-matching lines and only counts real eslint findings", () => {
		const out = ["src/a.ts:5:10: real finding", "", "not an eslint line at all"].join("\n");
		const results = parseEslintOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).file).toBe("src/a.ts");
	});

	it("requires 1+ digits for line/column (not just a single digit)", () => {
		const out = "src/a.ts:12:34: multi-digit position";
		const results = parseEslintOutput(out);
		expect(results[0]).toMatchObject({ line: 12, column: 34 });
	});


});

describe("parseMypyOutput", () => {
	it("parses standard mypy output", () => {
		const out = "foo.py:5: error: Incompatible return type [return-value]";
		const results = parseMypyOutput(out);
		expect(results.length).toBeGreaterThan(0);
		expect(nonNull(results[0]).tool).toBe("mypy");
	});

	it("returns [] on empty", () => {
		expect(parseMypyOutput("")).toEqual([]);
	});
});

describe("parseRuffJson", () => {
	it("parses ruff's JSON array format", () => {
		const payload = JSON.stringify([
			{
				filename: "foo.py",
				location: { row: 3, column: 1 },
				code: "E501",
				message: "line too long",
			},
		]);
		const results = parseRuffJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).ruleId).toBe("E501");
	});

	it("returns [] on malformed JSON", () => {
		expect(parseRuffJson("not json")).toEqual([]);
	});
});

describe("parseSemgrepJson", () => {
	it("parses semgrep results with check_id / start.line", () => {
		const payload = JSON.stringify({
			results: [
				{
					check_id: "demo.rule",
					path: "/proj/src/a.ts",
					start: { line: 10, col: 1 },
					extra: { severity: "ERROR", message: "uh oh" },
				},
			],
		});
		const results = parseSemgrepJson(payload, "/proj");
		expect(results.length).toBe(1);
		expect(nonNull(results[0])).toMatchObject({
			tool: "semgrep",
			severity: "warning",
			file: "src/a.ts",
			line: 10,
			column: 1,
			message: "demo.rule: uh oh",
			ruleId: "demo.rule",
		});
	});

	it("returns [] on malformed JSON", () => {
		expect(parseSemgrepJson("not json", "/tmp")).toEqual([]);
	});

	it("defaults line to 0 and column to undefined when start is missing", () => {
		const payload = JSON.stringify({
			results: [{ check_id: "demo.rule", path: "/proj/src/a.ts", extra: { message: "uh oh" } }],
		});
		const results = parseSemgrepJson(payload, "/proj");
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).line).toBe(0);
		expect(nonNull(results[0]).column).toBeUndefined();
	});

	it("falls back to 'unknown' when check_id is absent and trims a missing message", () => {
		const payload = JSON.stringify({ results: [{ path: "/proj/src/a.ts", start: { line: 1, col: 1 } }] });
		const results = parseSemgrepJson(payload, "/proj");
		expect(results).toHaveLength(1);
		// No check_id and no extra.message: "unknown: " trimmed down to "unknown:".
		expect(nonNull(results[0]).message).toBe("unknown:");
		expect(nonNull(results[0]).ruleId).toBeUndefined();
	});

	it("returns [] when there are no results at all", () => {
		expect(parseSemgrepJson(JSON.stringify({ results: [] }), "/proj")).toEqual([]);
	});

	it("returns [] when the 'results' key is absent entirely (not just empty)", () => {
		expect(parseSemgrepJson(JSON.stringify({}), "/proj")).toEqual([]);
	});

	it("defaults a finding's file to '' when 'path' is absent", () => {
		const payload = JSON.stringify({ results: [{ check_id: "c", start: { line: 1, col: 1 } }] });
		// relative(cwd, "") resolves to "" — a deterministic assertion that
		// doesn't depend on any particular projectRoot value.
		const results = parseSemgrepJson(payload, process.cwd());
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).file).toBe("");
	});

	it("P1: processes a batch of well-formed findings through the field-by-field validator, in order", () => {
		const payload = JSON.stringify({
			results: [
				{ check_id: "rule.a", path: "/proj/a.ts", start: { line: 1, col: 1 }, extra: { message: "first" } },
				{ check_id: "rule.b", path: "/proj/b.ts", start: { line: 2, col: 2 }, extra: { message: "second" } },
			],
		});
		const results = parseSemgrepJson(payload, "/proj");
		expect(results).toHaveLength(2);
		expect(results.map((r) => r.ruleId)).toEqual(["rule.a", "rule.b"]);
		expect(results.map((r) => r.file)).toEqual(["a.ts", "b.ts"]);
	});

	it("N1: a non-object entry in results[] is dropped, not pushed as a garbage finding", () => {
		const payload = JSON.stringify({
			results: ["not-an-object", { check_id: "real.rule", path: "/proj/a.ts", start: { line: 1, col: 1 } }],
		});
		const results = parseSemgrepJson(payload, "/proj");
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).ruleId).toBe("real.rule");
	});
});

describe("parseGitleaksJson", () => {
	it("parses the gitleaks json array", () => {
		const payload = JSON.stringify([
			{
				File: "src/a.ts",
				StartLine: 7,
				Description: "generic api key",
				RuleID: "generic-api-key",
				Secret: "x",
			},
		]);
		const results = parseGitleaksJson(payload);
		expect(results.length).toBe(1);
		expect(nonNull(results[0])).toMatchObject({
			tool: "gitleaks",
			severity: "error",
			file: "src/a.ts",
			line: 7,
			message: "generic-api-key: generic api key",
			ruleId: "generic-api-key",
		});
	});

	it("returns [] on empty / non-array", () => {
		expect(parseGitleaksJson("")).toEqual([]);
		expect(parseGitleaksJson("{}")).toEqual([]);
	});

	it("returns [] for a non-array that is still iterable (a bare JSON string)", () => {
		// Regression guard: a naive `!Array.isArray` skip must not fall through
		// to iterating the string's characters as fake findings.
		expect(parseGitleaksJson(JSON.stringify("nonarray"))).toEqual([]);
	});

	it("falls back to defaults when File/StartLine/RuleID/Description are absent", () => {
		const results = parseGitleaksJson(JSON.stringify([{}]));
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({
			file: "",
			line: 0,
			message: "secret: secret detected",
			ruleId: undefined,
		});
	});
});

describe("parseNpmAuditJson", () => {
	it("extracts vulnerability counts", () => {
		const payload = JSON.stringify({
			metadata: {
				vulnerabilities: { critical: 2, high: 0, moderate: 1, low: 0, total: 3 },
			},
		});
		const r = parseNpmAuditJson(payload);
		expect(r).toMatchObject({
			tool: "npm audit",
			total: 3,
			critical: 2,
			high: 0,
			moderate: 1,
			low: 0,
			// Zero-valued buckets must not appear in the human-readable detail.
			detail: "2 critical, 1 moderate",
		});
	});

	it("returns null on malformed JSON", () => {
		expect(parseNpmAuditJson("garbage")).toBeNull();
	});

	it("returns null when every bucket is zero", () => {
		const payload = JSON.stringify({
			metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 } },
		});
		expect(parseNpmAuditJson(payload)).toBeNull();
	});

	it("sums all four buckets precisely and reports every non-zero one", () => {
		// Distinct powers of two: any dropped/flipped term in the sum, or any
		// bucket silently defaulted to 0, changes this total or detail string.
		const payload = JSON.stringify({
			metadata: { vulnerabilities: { critical: 1, high: 2, moderate: 4, low: 8 } },
		});
		const r = parseNpmAuditJson(payload);
		expect(r).toMatchObject({
			total: 15,
			critical: 1,
			high: 2,
			moderate: 4,
			low: 8,
			detail: "1 critical, 2 high, 4 moderate, 8 low",
		});
	});

	it("returns null when metadata.vulnerabilities is absent entirely", () => {
		expect(parseNpmAuditJson(JSON.stringify({ metadata: {} }))).toBeNull();
		expect(parseNpmAuditJson(JSON.stringify({}))).toBeNull();
	});

	it("omits a zero-valued bucket from detail even when the total is non-zero", () => {
		// critical and moderate are exactly 0 here (not just unset) while the
		// total is non-zero, so the early-return-on-zero-total path can't mask
		// a "push regardless of value" bug in the per-bucket detail builder.
		const payload = JSON.stringify({
			metadata: { vulnerabilities: { critical: 0, high: 3, moderate: 0, low: 5 } },
		});
		const r = parseNpmAuditJson(payload);
		expect(r?.detail).toBe("3 high, 5 low");
	});

	it("P1: extra unrecognized buckets on vulnerabilities (e.g. 'info') do not affect the four tracked buckets", () => {
		const payload = JSON.stringify({
			metadata: { vulnerabilities: { critical: 1, high: 1, moderate: 1, low: 1, info: 99, total: 4 } },
		});
		const r = parseNpmAuditJson(payload);
		expect(r).toMatchObject({ total: 4, critical: 1, high: 1, moderate: 1, low: 1 });
	});

	it("N1: a string-typed critical count is treated as 0, not string-concatenated into a garbage total", () => {
		// Under the pre-fix `(v.critical || 0) + ...` arithmetic, a string
		// operand forces `+` to concatenate instead of add, and the leaked
		// `critical: v.critical || 0` would keep the raw string (violating the
		// `critical: number` contract). The validator now types-checks first.
		const payload = JSON.stringify({
			metadata: { vulnerabilities: { critical: "2", high: 3, moderate: 0, low: 0 } },
		});
		const r = parseNpmAuditJson(payload);
		expect(r).toMatchObject({ total: 3, critical: 0, high: 3, detail: "3 high" });
	});
});

describe("parseOsvScannerJson", () => {
	it("returns null on malformed JSON", () => {
		expect(parseOsvScannerJson("garbage")).toBeNull();
	});

	it("returns null when there are no vulnerabilities", () => {
		expect(parseOsvScannerJson(JSON.stringify({ results: [] }))).toBeNull();
	});

	it("buckets groups[].max_severity into CVSS v3 severity tiers", () => {
		const payload = JSON.stringify({
			results: [
				{
					source: { path: "/p/go.mod", type: "lockfile" },
					packages: [
						{
							package: { name: "a", version: "1", ecosystem: "Go" },
							vulnerabilities: [{ id: "GO-1" }],
							groups: [{ ids: ["GO-1"], max_severity: "9.8" }],
						},
						{
							package: { name: "b", version: "1", ecosystem: "Go" },
							vulnerabilities: [{ id: "GO-2" }],
							groups: [{ ids: ["GO-2"], max_severity: "7.5" }],
						},
						{
							package: { name: "c", version: "1", ecosystem: "Go" },
							vulnerabilities: [{ id: "GO-3" }],
							groups: [{ ids: ["GO-3"], max_severity: "5.0" }],
						},
						{
							package: { name: "d", version: "1", ecosystem: "Go" },
							vulnerabilities: [{ id: "GO-4" }],
							groups: [{ ids: ["GO-4"], max_severity: "2.0" }],
						},
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		expect(r?.tool).toBe("osv-scanner");
		expect(r?.critical).toBe(1);
		expect(r?.high).toBe(1);
		expect(r?.moderate).toBe(1);
		expect(r?.low).toBe(1);
		expect(r?.total).toBe(4);
		expect(r?.detail).toContain("GO-1");
	});

	it("falls back to vulnerabilities[].severity numeric score when max_severity absent", () => {
		const payload = JSON.stringify({
			results: [
				{
					packages: [
						{
							vulnerabilities: [{ id: "X", severity: [{ type: "CVSS_V3", score: "8.1" }] }],
							groups: [{ ids: ["X"] }],
						},
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		expect(r?.high).toBe(1);
		expect(r?.total).toBe(1);
	});

	it("CVSS vector strings without max_severity bucket as low (no inline calc)", () => {
		const payload = JSON.stringify({
			results: [
				{
					packages: [
						{
							vulnerabilities: [
								{
									id: "Y",
									severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N" }],
								},
							],
							groups: [{ ids: ["Y"] }],
						},
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		expect(r?.low).toBe(1);
	});

	it("caps topIds at 5", () => {
		const packages = Array.from({ length: 10 }, (_, i) => ({
			vulnerabilities: [{ id: `V-${i}` }],
			groups: [{ ids: [`V-${i}`], max_severity: "5.0" }],
		}));
		const r = parseOsvScannerJson(JSON.stringify({ results: [{ packages }] }));
		expect(r?.total).toBe(10);
		const idsInDetail = (r?.detail ?? "").split(" — ")[1]?.split(", ") ?? [];
		expect(idsInDetail).toHaveLength(5);
	});
});

describe("parseShellcheckJson", () => {
	it("parses shellcheck's { comments: [...] } payload", () => {
		const payload = JSON.stringify({
			comments: [
				{
					file: "a.sh",
					line: 5,
					column: 2,
					level: "warning",
					code: 2086,
					message: "quote this",
				},
			],
		});
		const results = parseShellcheckJson(payload);
		expect(results.length).toBe(1);
		expect(nonNull(results[0])).toMatchObject({
			tool: "shellcheck",
			severity: "warning",
			file: "a.sh",
			line: 5,
			column: 2,
			message: "quote this",
			ruleId: "SC2086",
		});
	});

	it("returns [] on malformed JSON", () => {
		expect(parseShellcheckJson("not json")).toEqual([]);
	});

	it("filters out style and info comments, keeping error/warning", () => {
		const payload = JSON.stringify({
			comments: [
				{ file: "a.sh", line: 1, level: "style", message: "styley" },
				{ file: "a.sh", line: 2, level: "info", message: "infoy" },
				{ file: "a.sh", line: 3, level: "error", message: "errory", code: 1000 },
			],
		});
		const results = parseShellcheckJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({ severity: "error", line: 3, message: "errory" });
	});

	it("maps a non-error level to 'warning' severity", () => {
		const payload = JSON.stringify({
			comments: [{ file: "a.sh", line: 1, level: "warning", message: "m" }],
		});
		expect(nonNull(parseShellcheckJson(payload)[0]).severity).toBe("warning");
	});

	it("returns [] for a non-array comments field that is still iterable", () => {
		expect(parseShellcheckJson(JSON.stringify({ comments: "abc" }))).toEqual([]);
	});

	it("defaults file and message to '' when both are absent", () => {
		const payload = JSON.stringify({ comments: [{ level: "warning" }] });
		const results = parseShellcheckJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({ file: "", message: "" });
	});

	it("P1: filters style/info while stringifying both string- and number-typed 'code' fields for survivors", () => {
		const payload = JSON.stringify({
			comments: [
				{ file: "a.sh", line: 1, level: "style", code: 9999, message: "ignored" },
				{ file: "a.sh", line: 2, level: "error", code: 2086, message: "numeric code" },
				{ file: "a.sh", line: 3, level: "warning", code: "1234", message: "string code" },
			],
		});
		const results = parseShellcheckJson(payload);
		expect(results).toHaveLength(2);
		expect(results.map((r) => r.ruleId)).toEqual(["SC2086", "SC1234"]);
	});

	it("N1: a non-number non-string 'code' (e.g. an array) does not leak into ruleId", () => {
		const payload = JSON.stringify({
			comments: [{ file: "a.sh", line: 1, level: "warning", code: [1, 2], message: "m" }],
		});
		const results = parseShellcheckJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).ruleId).toBeUndefined();
	});
});

describe("parseHadolintJson", () => {
	it("retains valid Hadolint diagnostics beside malformed rows", () => {
		const findings = parseHadolintJson(JSON.stringify([
			null,
			{ message: 5 },
			{ message: "Use COPY", code: "DL3020", file: "Dockerfile", line: 4, level: "error" },
		]));
		expect(findings).toEqual([{
			tool: "hadolint", severity: "error", file: "Dockerfile", line: 4,
			message: "DL3020: Use COPY", ruleId: "DL3020",
		}]);
	});

	it("parses hadolint's JSON diagnostics", () => {
		const payload = JSON.stringify([
			{
				file: "Dockerfile",
				line: 3,
				column: 1,
				level: "warning",
				code: "DL3003",
				message: "x",
			},
		]);
		const results = parseHadolintJson(payload);
		expect(results.length).toBe(1);
		expect(nonNull(results[0])).toMatchObject({
			tool: "hadolint",
			severity: "warning",
			file: "Dockerfile",
			line: 3,
			message: "DL3003: x",
			ruleId: "DL3003",
		});
	});

	it("maps level 'error' to severity 'error'", () => {
		const payload = JSON.stringify([{ file: "Dockerfile", line: 1, level: "error", code: "DL1", message: "bad" }]);
		expect(nonNull(parseHadolintJson(payload)[0]).severity).toBe("error");
	});

	it("defaults file/line/message/ruleId and trims the composed message when both are absent", () => {
		const results = parseHadolintJson(JSON.stringify([{ level: "warning" }]));
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({
			file: "",
			line: 0,
			// "" + ": " + "" trimmed down to just the colon.
			message: ":",
			ruleId: undefined,
		});
	});

	it("returns [] for a non-array payload that is still iterable", () => {
		expect(parseHadolintJson(JSON.stringify("xyz"))).toEqual([]);
	});

	it("returns [] on malformed JSON", () => {
		expect(parseHadolintJson("not json")).toEqual([]);
	});
});

describe("filterResultsToFile", () => {
	it("narrows results to a single target file", () => {
		const all = [
			{
				tool: "tsc" as const,
				severity: "error" as const,
				file: "/p/a.ts",
				line: 1,
				message: "x",
			},
			{
				tool: "tsc" as const,
				severity: "error" as const,
				file: "/p/b.ts",
				line: 1,
				message: "y",
			},
		];
		const filtered = filterResultsToFile(all, "/p/a.ts");
		expect(filtered.length).toBe(1);
		expect(nonNull(filtered[0]).file).toBe("/p/a.ts");
	});

	it("is an identity when no match", () => {
		const all = [
			{
				tool: "tsc" as const,
				severity: "error" as const,
				file: "/p/a.ts",
				line: 1,
				message: "x",
			},
		];
		expect(filterResultsToFile(all, "/p/other.ts")).toEqual([]);
	});

	it("matches on a path SUFFIX even when it is not an exact match", () => {
		const all = [
			{
				tool: "tsc" as const,
				severity: "error" as const,
				file: "/very/long/path/to/a.ts",
				line: 1,
				message: "x",
			},
		];
		// filePath is a suffix of the result's file, not a prefix — this can only
		// pass via the endsWith() branch of the OR, never the === branch.
		expect(filterResultsToFile(all, "a.ts")).toHaveLength(1);
	});

	it("does NOT match on a path PREFIX that isn't also a suffix", () => {
		const all = [
			{
				tool: "tsc" as const,
				severity: "error" as const,
				file: "/p/a.ts/extra",
				line: 1,
				message: "x",
			},
		];
		// filePath is a prefix here, not a suffix and not an exact match —
		// startsWith() would wrongly include this; endsWith() correctly excludes it.
		expect(filterResultsToFile(all, "/p/a.ts")).toEqual([]);
	});
});

describe("parseDocsCheckOutput", () => {
	it("parses a [docs:fail] block and folds expected/actual into the message", () => {
		const out = [
			"[docs:fail] /abs/path/to/file: <marker> drift",
			"  expected: 106",
			"  actual:   105",
			"1 doc-accuracy failure(s). Run 'npm run docs:build' to fix.",
		].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({
			tool: "docs-check",
			severity: "error",
			file: "/abs/path/to/file",
			line: 0,
			message: "<marker> drift (expected 106, actual 105)",
		});
	});

	it("leaves the message unfolded when only 'expected' (no 'actual') follows", () => {
		const out = ["[docs:fail] file.md: some drift", "  expected: 5", "not an actual line"].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).message).toBe("some drift");
	});

	it("ignores blank lines and the trailing summary line", () => {
		const out = ["", "", "2 doc-accuracy failure(s). Run 'npm run docs:build' to fix.", ""].join("\n");
		expect(parseDocsCheckOutput(out)).toEqual([]);
	});

	it("requires '[docs:fail]' at the very start of the line, not merely present partway through", () => {
		const out = "noise before [docs:fail] a.md: x drift";
		expect(parseDocsCheckOutput(out)).toEqual([]);
	});

	it("tolerates extra whitespace after '[docs:fail]' and zero whitespace before the message", () => {
		const out = "[docs:fail]  a.md:driftnospace";
		const results = parseDocsCheckOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({ file: "a.md", message: "driftnospace" });
	});

	it("does not throw when a [docs:fail] line is the very last line of the output", () => {
		// Regression guard: `lines[i + 1]`/`lines[i + 2]` are out of bounds here —
		// an unguarded `.match` on that would throw instead of gracefully
		// leaving the message unfolded.
		const results = parseDocsCheckOutput("[docs:fail] solo.md: solo drift");
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).message).toBe("solo drift");
	});

	it("does not fold 'expected' when it appears mid-line rather than at the line's start", () => {
		// `act` (the next line down) is a REAL match here so this test isolates
		// `exp`'s anchor: if only exp's `^` were dropped, exp would wrongly
		// match and — since act already matches for real — folding would wrongly
		// fire. Both const bindings are evaluated unconditionally before the
		// `if (exp && act)` check, so `exp` alone determines the outcome.
		const out = ["[docs:fail] a.md: drift", "  some text before expected: 1", "  actual:   2"].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(nonNull(results[0]).message).toBe("drift");
	});

	it("does not fold 'actual' when it appears mid-line rather than at the line's start", () => {
		// Symmetric to the above: `exp` is a REAL match here so `act`'s anchor is
		// what's actually under test — if only act's `^` were dropped, act would
		// wrongly match and folding would wrongly fire even though `exp` alone
		// is unmutated and genuinely valid.
		const out = ["[docs:fail] a.md: drift", "  expected: 1", "  and before actual:   2"].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(nonNull(results[0]).message).toBe("drift");
	});

	it("folds expected/actual even with zero whitespace after the colon, without truncating multi-digit values", () => {
		const out = ["[docs:fail] a.md: drift", "expected:106", "actual:105"].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(nonNull(results[0]).message).toBe("drift (expected 106, actual 105)");
	});

	it("parses multiple stacked failure blocks independently", () => {
		const out = [
			"[docs:fail] a.md: drift a",
			"  expected: 1",
			"  actual:   2",
			"[docs:fail] b.md: drift b",
			"  expected: 3",
			"  actual:   4",
		].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(results).toHaveLength(2);
		expect(nonNull(results[0]).message).toBe("drift a (expected 1, actual 2)");
		expect(nonNull(results[1]).message).toBe("drift b (expected 3, actual 4)");
	});

	it("trims whitespace around folded expected/actual values", () => {
		const out = ["[docs:fail] a.md: drift", "  expected:   1  ", "  actual:     2  "].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(nonNull(results[0]).message).toBe("drift (expected 1, actual 2)");
	});

	it("returns [] on empty output", () => {
		expect(parseDocsCheckOutput("")).toEqual([]);
	});

	it("does not trim extra whitespace out of the file/message header capture itself", () => {
		// Only the folded expected/actual VALUES get trimmed — the raw header
		// capture does not, so extra whitespace here must survive verbatim in
		// the untrimmed field and get absorbed by the greedy separator in the
		// trimmed one.
		const out = "[docs:fail]  double.md: drift with  double space";
		const results = parseDocsCheckOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({
			file: "double.md",
			message: "drift with  double space",
		});
	});

	it("requires 'expected:'/'actual:' to anchor at the start of their line", () => {
		// A line that merely CONTAINS "expected:"/"actual:" partway through
		// must not be folded in — only a genuine (optionally indented)
		// expected/actual line following the header counts.
		const out = ["[docs:fail] a.md: drift", "junk expected: 1", "  actual:   2"].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(nonNull(results[0]).message).toBe("drift");
	});

	it("requires 'actual:' to anchor at the start of its line even when 'expected:' matched cleanly", () => {
		// Isolates the "actual" line's own anchor: with a genuinely-matching
		// "expected" line, `exp` is truthy regardless of what happens to
		// `act` — so this is the only case that can prove the "actual" match
		// alone drives the fold decision.
		const out = ["[docs:fail] a.md: drift", "  expected: 1", "junk actual: 2"].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(nonNull(results[0]).message).toBe("drift");
	});

	it("requires at least one character after 'expected:'/'actual:' (no fold on a bare colon)", () => {
		const out = ["[docs:fail] a.md: drift", "  expected:1", "  actual:2"].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(nonNull(results[0]).message).toBe("drift (expected 1, actual 2)");
	});

	it("AUDIT: actually exercises a bare colon with zero content — the test above never does", () => {
		// The preceding test's title promises "no fold on a bare colon" but its
		// body only ever supplies non-empty content ("1"/"2"), so it can't
		// distinguish the real `(.+)$` (1+ chars required) from a `(.*)$`
		// mutant (0+ chars allowed) — both produce an identical fold on that
		// input. This case supplies a genuinely empty value after the colon,
		// which is the only input that actually discriminates the two: real
		// code declines to fold (message stays "drift"); a `(.*)$` mutant would
		// fold in empty values ("drift (expected , actual )"). Verified via
		// scratch/audit-docscheck-barecolon-probe.mjs against a copy of both.
		const out = ["[docs:fail] a.md: drift", "  expected:", "  actual:"].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(nonNull(results[0]).message).toBe("drift");
	});

	it("does not throw when a [docs:fail] header is the very last line (no follow-up lines at all)", () => {
		const results = parseDocsCheckOutput("[docs:fail] a.md: solo drift");
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).message).toBe("solo drift");
	});

	it("does not throw when only one line follows the header (no second follow-up line)", () => {
		const out = ["[docs:fail] a.md: drift", "  expected: 1"].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).message).toBe("drift");
	});

	it("does not match a [docs:fail] header line that carries a trailing carriage return", () => {
		// `.` never matches CR (U+000D) any more than it matches LF, so the
		// header regex's trailing `$` cannot be satisfied right after the
		// captured message when a stray `\r` follows it on the same split-by-\n
		// line (e.g. a source with mixed CRLF endings) — the whole match fails.
		expect(parseDocsCheckOutput("[docs:fail] a.md: drift\r")).toEqual([]);
	});

	it("does not fold an 'expected:' line that carries a trailing carriage return", () => {
		const out = ["[docs:fail] a.md: drift", "  expected: 1\r", "  actual:   2"].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).message).toBe("drift");
	});

	it("does not fold an 'actual:' line that carries a trailing carriage return", () => {
		const out = ["[docs:fail] a.md: drift", "  expected: 1", "  actual:   2\r"].join("\n");
		const results = parseDocsCheckOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).message).toBe("drift");
	});
});

describe("parseOxlintJson", () => {
	it("parses a diagnostic with a span into line/column", () => {
		const payload = JSON.stringify({
			diagnostics: [
				{
					message: "no unused vars",
					code: "no-unused-vars",
					severity: "error",
					filename: "a.ts",
					labels: [{ span: { line: 5, column: 3 } }],
				},
			],
		});
		const results = parseOxlintJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({
			tool: "oxlint",
			severity: "error",
			file: "a.ts",
			line: 5,
			column: 3,
			message: "no unused vars",
			ruleId: "no-unused-vars",
		});
	});

	it("maps a non-'error' severity to 'warning'", () => {
		const payload = JSON.stringify({
			diagnostics: [{ message: "m", severity: "warning", filename: "a.ts" }],
		});
		expect(nonNull(parseOxlintJson(payload)[0]).severity).toBe("warning");
	});

	it("defaults line to 0 when labels is missing or empty", () => {
		const missing = JSON.stringify({ diagnostics: [{ message: "m", filename: "a.ts" }] });
		const empty = JSON.stringify({ diagnostics: [{ message: "m", filename: "a.ts", labels: [] }] });
		expect(nonNull(parseOxlintJson(missing)[0]).line).toBe(0);
		expect(nonNull(parseOxlintJson(empty)[0]).line).toBe(0);
	});

	it("defaults file/message to '' and ruleId to undefined when absent", () => {
		const results = parseOxlintJson(JSON.stringify({ diagnostics: [{}] }));
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).file).toBe("");
		expect(nonNull(results[0]).message).toBe("");
		expect(nonNull(results[0]).ruleId).toBeUndefined();
	});

	it("returns [] when diagnostics is not an array (including a bare iterable string)", () => {
		expect(parseOxlintJson(JSON.stringify({ diagnostics: "abc" }))).toEqual([]);
		expect(parseOxlintJson(JSON.stringify({}))).toEqual([]);
	});

	it("returns [] on malformed JSON", () => {
		expect(parseOxlintJson("not json")).toEqual([]);
	});

	it("P1: only labels[0]'s span is used when a diagnostic carries multiple labels", () => {
		const payload = JSON.stringify({
			diagnostics: [
				{
					message: "m",
					filename: "a.ts",
					labels: [{ span: { line: 5, column: 1 } }, { span: { line: 99, column: 99 } }],
				},
			],
		});
		const results = parseOxlintJson(payload);
		expect(nonNull(results[0])).toMatchObject({ line: 5, column: 1 });
	});

	it("N1: a numeric 'code' field is not leaked into ruleId (must stay string | undefined)", () => {
		const payload = JSON.stringify({ diagnostics: [{ message: "m", code: 1234, filename: "a.ts" }] });
		const results = parseOxlintJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).ruleId).toBeUndefined();
	});
});

describe("parseKnipJson", () => {
	it("reports each unused file with a fixed message and ruleId", () => {
		const results = parseKnipJson(JSON.stringify({ files: ["a.ts", "b.ts"] }));
		expect(results).toHaveLength(2);
		expect(nonNull(results[0])).toMatchObject({
			tool: "knip",
			severity: "warning",
			file: "a.ts",
			line: 0,
			message: "unused file — not imported by any other module",
			ruleId: "unused-file",
		});
		expect(nonNull(results[1]).file).toBe("b.ts");
	});

	it("reports unused exports, unused type exports, and unlisted dependencies per issue", () => {
		const payload = JSON.stringify({
			issues: [
				{
					file: "x.ts",
					exports: [{ name: "foo", line: 5 }],
					types: [{ name: "Bar", line: 9 }],
					unlisted: [{ name: "left-pad" }, "bare-string-dep"],
				},
			],
		});
		const results = parseKnipJson(payload);
		expect(results).toHaveLength(4);
		expect(results.map((r) => r.message)).toEqual([
			"unused export: foo",
			"unused type export: Bar",
			"unlisted dependency: left-pad",
			"unlisted dependency: bare-string-dep",
		]);
		expect(nonNull(results[0])).toMatchObject({ tool: "knip", severity: "warning", file: "x.ts", line: 5, ruleId: "unused-export" });
		expect(nonNull(results[1])).toMatchObject({ tool: "knip", severity: "warning", file: "x.ts", line: 9, ruleId: "unused-type" });
		expect(nonNull(results[2])).toMatchObject({ tool: "knip", severity: "warning", file: "x.ts", line: 0, ruleId: "unlisted-dep" });
	});

	it("produces no export-derived results when an issue omits 'exports' entirely", () => {
		const payload = JSON.stringify({
			issues: [{ file: "x.ts", types: [{ name: "Bar", line: 9 }], unlisted: [] }],
		});
		const results = parseKnipJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).ruleId).toBe("unused-type");
	});

	it("defaults an issue's file to '' when absent", () => {
		const payload = JSON.stringify({ issues: [{ exports: [{ name: "foo", line: 1 }] }] });
		expect(nonNull(parseKnipJson(payload)[0]).file).toBe("");
	});

	it("still reports issue-derived findings when 'files' is entirely absent", () => {
		const payload = JSON.stringify({ issues: [{ file: "y.ts", exports: [{ name: "z", line: 2 }] }] });
		const results = parseKnipJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).message).toBe("unused export: z");
	});

	it("still reports file-derived findings when 'issues' is entirely absent", () => {
		const results = parseKnipJson(JSON.stringify({ files: ["only.ts"] }));
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).ruleId).toBe("unused-file");
	});

	it("returns [] when neither files nor issues is present, and on malformed JSON", () => {
		expect(parseKnipJson(JSON.stringify({}))).toEqual([]);
		expect(parseKnipJson("not json")).toEqual([]);
	});

	it("P1: a well-formed export entry is kept even when a sibling entry in the same array is malformed", () => {
		const payload = JSON.stringify({
			issues: [{ file: "x.ts", exports: [{ line: 3 }, { name: "keepMe", line: 4 }] }],
		});
		const results = parseKnipJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({ message: "unused export: keepMe", line: 4 });
	});

	it("N1: a malformed 'unlisted' entry (neither string nor {name}) is dropped, not stringified", () => {
		const payload = JSON.stringify({ issues: [{ file: "x.ts", unlisted: [42, { name: "good-dep" }] }] });
		const results = parseKnipJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).message).toBe("unlisted dependency: good-dep");
	});
});

describe("parseActionlintOutput", () => {
	it("parses a line with a trailing [rule] bracket", () => {
		const results = parseActionlintOutput("file.yml:3:5: something wrong [rule-name]");
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({
			tool: "actionlint",
			severity: "warning",
			file: "file.yml",
			line: 3,
			column: 5,
			message: "something wrong",
			ruleId: "rule-name",
		});
	});

	it("leaves ruleId undefined without a trailing bracket", () => {
		const results = parseActionlintOutput("file.yml:3:5: something wrong");
		expect(nonNull(results[0]).ruleId).toBeUndefined();
		expect(nonNull(results[0]).message).toBe("something wrong");
	});

	it("strips trailing whitespace even without a rule bracket", () => {
		const results = parseActionlintOutput("file.yml:3:5: msg here   ");
		expect(nonNull(results[0]).message).toBe("msg here");
	});

	it("strips trailing whitespace after a rule bracket too", () => {
		const results = parseActionlintOutput("file.yml:3:5: bad thing [some-rule]   ");
		expect(nonNull(results[0])).toMatchObject({ message: "bad thing", ruleId: "some-rule" });
	});

	it("requires 1+ digits for line/column (multi-digit positions)", () => {
		const results = parseActionlintOutput("file.yml:12:34: msg");
		expect(nonNull(results[0])).toMatchObject({ line: 12, column: 34 });
	});

	it("ignores non-matching lines and keeps only real findings", () => {
		const out = ["not a match", "file.yml:1:1: ok"].join("\n");
		const results = parseActionlintOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).file).toBe("file.yml");
	});

	it("returns [] on empty output", () => {
		expect(parseActionlintOutput("")).toEqual([]);
	});

	it("allows zero whitespace between the final colon and the message", () => {
		// The separator before the message is 0+ whitespace, not 1+ — a message
		// that starts immediately after the colon must still parse.
		const results = parseActionlintOutput("file.yml:1:1:nospacehere");
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).message).toBe("nospacehere");
	});

	it("normalizes a message that is pure trailing whitespace (no real text, no bracket) to an empty string", () => {
		// The lazy `(.+?)` message group requires at least one character, so
		// when there is no real message text at all, it is FORCED to capture
		// some of the trailing whitespace itself (there is nothing else for it
		// to settle on) rather than being left empty by the regex alone —
		// unlike the "real text + trailing spaces" case above, where the lazy
		// group already stops right after the real text. Only the `.trim()`
		// call normalizes this forced whitespace capture down to "".
		const results = parseActionlintOutput("file.yml:59:39:\t");
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).message).toBe("");
	});
});

describe("parseTaploOutput", () => {
	it("parses an error with a rule bracket and a following location line", () => {
		const out = ["error[syntax]: unexpected token", "  --> config.toml:5:3"].join("\n");
		const results = parseTaploOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({
			tool: "taplo",
			severity: "error",
			file: "config.toml",
			line: 5,
			column: 3,
			message: "unexpected token",
			ruleId: "syntax",
		});
	});

	it("leaves ruleId undefined without a rule bracket", () => {
		const results = parseTaploOutput("error: bad file");
		expect(nonNull(results[0]).ruleId).toBeUndefined();
		expect(nonNull(results[0]).message).toBe("bad file");
	});

	it("falls back to the filePath argument when there is no location line", () => {
		const results = parseTaploOutput("error: bad file", "fallback.toml");
		expect(nonNull(results[0])).toMatchObject({ file: "fallback.toml", line: 0 });
		expect(nonNull(results[0]).column).toBeUndefined();
	});

	it("falls back to '' when there is no location line and no filePath argument", () => {
		const results = parseTaploOutput("error: bad file");
		expect(nonNull(results[0]).file).toBe("");
	});

	it("prefers the location line's file over the filePath argument when both are present", () => {
		const out = ["error[x]: msg", "  --> real.toml:1:1"].join("\n");
		const results = parseTaploOutput(out, "fallback.toml");
		expect(nonNull(results[0]).file).toBe("real.toml");
	});

	it("parses two stacked error+location blocks independently", () => {
		const out = ["error[a]: msg1", "  --> f1.toml:1:1", "error[b]: msg2", "  --> f2.toml:2:2"].join("\n");
		const results = parseTaploOutput(out);
		expect(results).toHaveLength(2);
		expect(nonNull(results[0])).toMatchObject({ file: "f1.toml", line: 1, column: 1, ruleId: "a" });
		expect(nonNull(results[1])).toMatchObject({ file: "f2.toml", line: 2, column: 2, ruleId: "b" });
	});

	it("trims trailing whitespace from the message when there is no location line", () => {
		const results = parseTaploOutput("error: msg with trailing space   ");
		expect(nonNull(results[0]).message).toBe("msg with trailing space");
	});

	it("requires 1+ digits for line/column (multi-digit positions)", () => {
		const out = ["error: e", "  --> file.toml:12:34"].join("\n");
		const results = parseTaploOutput(out);
		expect(nonNull(results[0])).toMatchObject({ line: 12, column: 34 });
	});

	it("requires 'error' at the very start of the line, not merely present partway through", () => {
		const out = "note: nested error: this should not parse as a taplo diagnostic";
		expect(parseTaploOutput(out)).toEqual([]);
	});

	it("returns [] on empty output", () => {
		expect(parseTaploOutput("")).toEqual([]);
	});

	it("allows zero whitespace between the colon and the message", () => {
		const results = parseTaploOutput("error:nospacehere");
		expect(nonNull(results[0]).message).toBe("nospacehere");
	});

	it("does not leave a leading space in the location's file when it is separated by extra whitespace", () => {
		// The file capture in the location line is never trimmed downstream, so
		// the regex's own whitespace-consumption must do the trimming.
		const out = ["error[x]: msg", "  -->  file.toml:1:2"].join("\n");
		const results = parseTaploOutput(out);
		expect(nonNull(results[0]).file).toBe("file.toml");
	});

	it("does not treat a line with junk before '-->' as a location line", () => {
		// The location regex must anchor to (optional leading whitespace then)
		// the arrow — a line that merely CONTAINS "--> file:line:col" after some
		// other text must not be misread as the error's location.
		const out = ["error: msg", "junk --> file.toml:1:2"].join("\n");
		const results = parseTaploOutput(out);
		expect(nonNull(results[0])).toMatchObject({ file: "", line: 0 });
		expect(nonNull(results[0]).column).toBeUndefined();
	});
});
