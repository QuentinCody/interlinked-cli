import { describe, expect, it } from "vitest";
import { c, kvLine, stripAnsi } from "../lib/formatter.js";
import {
	type MetricsReport,
	renderNormal,
	renderShort,
} from "./metrics-renderers.js";

function baseReport(overrides: Partial<MetricsReport> = {}): MetricsReport {
	return {
		scope: {
			files: 10,
			functions: 20,
			coverageAvailable: true,
			coverageSource: "istanbul",
			astComplexityAvailable: true,
		},
		caps: {
			crap: 30,
			cyclomatic: 25,
			cyclomaticReview: 15,
			minCoveragePct: 80,
		},
		gates: {
			functionsOverCrap: 0,
			functionsCyclomaticReview: 0,
			functionsCyclomaticBad: 0,
			filesMissingCompanion: 0,
			filesNoCoverage: 0,
		},
		distributions: {
			cyclomatic: {},
			crap: {},
		},
		hotspots: [],
		missingCompanion: [],
		files: [],
		...overrides,
	};
}

describe("renderShort — positive (must fire)", () => {
	// test-contract: public-api — coverage-available suffix must be empty, not the mutant sentinel
	it("P1: appends nothing (not the Stryker sentinel) when coverage is available", () => {
		const r = baseReport({ scope: { ...baseReport().scope, coverageAvailable: true } });
		const out = renderShort(r);
		expect(out.endsWith("no-companion: 0")).toBe(true);
		expect(out).not.toContain("Stryker was here");
	});
});

describe("renderNormal — positive (must fire)", () => {
	// test-contract: public-api — "Functions" label must render literally
	it("P1: includes the literal 'Functions' label", () => {
		const out = stripAnsi(renderNormal(baseReport()));
		expect(out).toContain(stripAnsi(kvLine("Functions", "20")));
	});

	// test-contract: public-api — "Coverage" label must render literally
	it("P2: includes the literal 'Coverage' label", () => {
		const out = stripAnsi(renderNormal(baseReport()));
		expect(out).toMatch(/Coverage\s+present \(istanbul\)/);
	});

	// test-contract: public-api — an unavailable exact parser must show the named Complexity gap.
	it("P3: shows unavailable Complexity when astComplexityAvailable is false", () => {
		const r = baseReport({
			scope: { ...baseReport().scope, astComplexityAvailable: false },
		});
		const out = stripAnsi(renderNormal(r));
		expect(out).toContain("Complexity");
		expect(out).toContain("JS/TS complexity unavailable");
	});

	// test-contract: public-api — an available exact parser carries no parser-unavailable warning.
	it("N3: omits the unavailable Complexity line when astComplexityAvailable is true", () => {
		const r = baseReport({
			scope: { ...baseReport().scope, astComplexityAvailable: true },
		});
		const out = stripAnsi(renderNormal(r));
		expect(out).not.toContain("JS/TS complexity unavailable");
	});

	// test-contract: public-api — "Complexity" label text itself must render literally
	it("P4: 'Complexity' label text is not blanked", () => {
		const r = baseReport({
			scope: { ...baseReport().scope, astComplexityAvailable: false },
		});
		const out = stripAnsi(renderNormal(r));
		expect(out).toMatch(/Complexity\s+JS\/TS complexity unavailable/);
	});

	// test-contract: public-api — "files no companion" label must render literally
	it("P5: includes the literal 'files no companion' label", () => {
		const out = stripAnsi(renderNormal(baseReport()));
		expect(out).toContain("files no companion");
	});

	// test-contract: public-api — CRAP distribution bucket lines must be emitted (BlockStatement/StringLiteral kill)
	it("P6: emits one padded line per CRAP distribution bucket", () => {
		const r = baseReport({ distributions: { cyclomatic: {}, crap: { "0-10": 3, "11-20": 1 } } });
		const out = stripAnsi(renderNormal(r));
		expect(out).toContain(`    ${"0-10".padEnd(10)} 3`);
		expect(out).toContain(`    ${"11-20".padEnd(10)} 1`);
	});

	// test-contract: public-api — hotspots header text "Top N CRAP hotspots" must render
	it("P7: renders 'Top N CRAP hotspots' header with the real count", () => {
		const r = baseReport({
			hotspots: [
				{ file: "a.ts", name: "fn", line: 1, cyclomatic: 5, coveragePct: 50, crap: 12 },
			],
		});
		const out = stripAnsi(renderNormal(r));
		expect(out).toContain("Top 1 CRAP hotspots");
	});

	it("P8: distinguishes missing coverage from an empty hotspot display", () => {
		const measured = baseReport();
		const unavailable = { ...measured, scope: { ...measured.scope, coverageAvailable: false } };
		expect(stripAnsi(renderNormal(unavailable))).toContain("no coverage data — CRAP unavailable");
		expect(stripAnsi(renderNormal(measured))).toContain("no CRAP hotspots to display");
		expect(stripAnsi(renderNormal(measured))).not.toContain("no coverage data — CRAP unavailable");
	});

	// test-contract: boundary — a non-empty hotspots list must NOT show the empty note
	it("N8: omits the empty-hotspots note when hotspots is non-empty", () => {
		const r = baseReport({
			hotspots: [
				{ file: "a.ts", name: "fn", line: 1, cyclomatic: 5, coveragePct: 50, crap: 12 },
			],
		});
		const out = stripAnsi(renderNormal(r));
		expect(out).not.toContain("no coverage data — CRAP unavailable");
	});

	// test-contract: boundary — h.crap nullish-coalesces to 0, not "&&" short-circuit (LogicalOperator kill)
	it("P9: renders crap=0 when a hotspot's crap is null (nullish coalesce, not &&)", () => {
		const r = baseReport({
			hotspots: [
				{ file: "a.ts", name: "fn", line: 1, cyclomatic: 5, coveragePct: 50, crap: null },
			],
		});
		const out = stripAnsi(renderNormal(r));
		expect(out).toContain(`${"0".padStart(6)}  cyc=`);
	});

	// test-contract: boundary — a real crap value (truthy) must render its own number, not the "&&" corruption
	it("N9: renders the real crap number when it is a truthy value", () => {
		const r = baseReport({
			hotspots: [
				{ file: "a.ts", name: "fn", line: 1, cyclomatic: 5, coveragePct: 50, crap: 42 },
			],
		});
		const out = stripAnsi(renderNormal(r));
		expect(out).toContain(`${"42".padStart(6)}  cyc=`);
	});

	// test-contract: public-api — output must join lines with real newlines, not concatenate
	it("P10: joins sections with real newline characters", () => {
		const out = renderNormal(baseReport());
		expect(out).toContain("\n");
		expect(out.split("\n").length).toBeGreaterThan(5);
	});

	// test-contract: boundary — every blank-separator push must stay truly blank, never leak the
	// mutation sentinel; kills the four "" -> "Stryker was here!" StringLiteral mutants at once
	it("P11: never leaks the mutation sentinel string anywhere in the report", () => {
		const r = baseReport({
			scope: { ...baseReport().scope, astComplexityAvailable: false },
			hotspots: [
				{ file: "a.ts", name: "fn", line: 1, cyclomatic: 5, coveragePct: 50, crap: 12 },
			],
			missingCompanion: ["x.ts"],
			distributions: { cyclomatic: {}, crap: { "0-10": 1 } },
		});
		const out = renderNormal(r);
		expect(out).not.toContain("Stryker was here");
	});

	// test-contract: boundary — the separator before threshold observations is an empty line.
	it("P12: has a truly blank line between scope and threshold observations", () => {
		const lines = stripAnsi(renderNormal(baseReport())).split("\n");
		const gatesIdx = lines.findIndex((l) => l.includes("Threshold observations"));
		expect(lines[gatesIdx - 1]).toBe("");
	});

	// test-contract: boundary — "\n" is the true join separator, not "" (kills the join-separator mutant)
	it("P13: does not collapse the whole report onto a single line", () => {
		const out = renderNormal(baseReport());
		const lineCount = out.split("\n").length;
		expect(lineCount).toBeGreaterThan(1);
	});
});

describe("gateStr (via renderNormal) — positive (must fire)", () => {
	// test-contract: boundary — n===0 must produce the exact green("0") token, distinguishing the
	// BlockStatement/Conditional/Equality/StringLiteral mutants that all coincide on plain "0" text
	it("P1: renders the exact color-tagged '0' token when the gate count is zero", () => {
		const r = baseReport({ gates: { ...baseReport().gates, functionsOverCrap: 0 } });
		const out = renderNormal(r);
		expect(out).toContain(c.green("0"));
	});

	// test-contract: boundary — nonzero must render the literal number, never "0" (kills ConditionalExpression->true)
	it("N1: renders the real nonzero count (not '0') when the gate count is nonzero", () => {
		const r = baseReport({ gates: { ...baseReport().gates, functionsOverCrap: 7 } });
		const out = stripAnsi(renderNormal(r));
		expect(out).toMatch(/CRAP ≥ 30\s+7/);
		expect(out).not.toMatch(/CRAP ≥ 30\s+0/);
	});
});

describe("missing-companion section (no coverage) — positive (must fire)", () => {
	// test-contract: public-api — no-coverage branch renders the flat capped list with the real files
	it("P1: renders the flat missing-companion list when coverage is unavailable", () => {
		const r = baseReport({
			scope: { ...baseReport().scope, coverageAvailable: false },
			missingCompanion: ["src/a.ts", "src/b.ts"],
		});
		const out = stripAnsi(renderNormal(r));
		expect(out).toContain("Files missing a companion test (2)");
		expect(out).toContain("src/a.ts");
		expect(out).toContain("src/b.ts");
	});

	// test-contract: boundary — the no-coverage suffix arrow always yields "" (never undefined, never a
	// sentinel); the rendered file line must be exactly "    ✗ <file>" with nothing appended after it
	it("P2: renders each file line with no trailing suffix text at all", () => {
		const r = baseReport({
			scope: { ...baseReport().scope, coverageAvailable: false },
			missingCompanion: ["src/a.ts"],
		});
		const lines = stripAnsi(renderNormal(r)).split("\n");
		const fileLine = lines.find((l) => l.includes("src/a.ts"));
		expect(fileLine).toBe("    ✗ src/a.ts");
	});
});

describe("missing-companion section (with coverage) — positive (must fire)", () => {
	function reportWithCoverageSplit(): MetricsReport {
		return baseReport({
			scope: { ...baseReport().scope, coverageAvailable: true },
			caps: { ...baseReport().caps, minCoveragePct: 80 },
			missingCompanion: ["under.ts", "at-threshold.ts", "over.ts"],
			files: [
				{ file: "under.ts", functions: 1, linePct: 40, maxCyclomatic: 1, maxCrap: null, companion: null, overGate: 0 },
				{ file: "at-threshold.ts", functions: 1, linePct: 80, maxCyclomatic: 1, maxCrap: null, companion: null, overGate: 0 },
				{ file: "over.ts", functions: 1, linePct: 95, maxCyclomatic: 1, maxCrap: null, companion: null, overGate: 0 },
			],
		});
	}

	// test-contract: boundary — pct < minCoveragePct is the uncovered set; strict '<' (EqualityOperator kill)
	it("P1: a file strictly under minCoveragePct lands in the uncovered set", () => {
		const out = stripAnsi(renderNormal(reportWithCoverageSplit()));
		expect(out).toContain("under.ts");
		expect(out).toContain("1 under 80% lines, 2 covered via other tests");
	});

	// test-contract: boundary — pct === minCoveragePct is NOT uncovered (kills the '<=' mutant)
	it("N1: a file exactly at minCoveragePct is NOT counted in the uncovered set", () => {
		const out = stripAnsi(renderNormal(reportWithCoverageSplit()));
		// Only under.ts (40%) qualifies as uncovered; at-threshold.ts (80%) and over.ts (95%) do not.
		expect(out).toContain("1 under 80% lines");
	});

	// test-contract: boundary — pct >= minCoveragePct is the covered set; kills the strict '>' mutant
	it("P2: a file exactly at minCoveragePct lands in the covered-elsewhere set", () => {
		const r = reportWithCoverageSplit();
		const out = stripAnsi(renderNormal(r));
		expect(out).toContain("at-threshold.ts");
		expect(out).toContain("covered elsewhere");
	});

	// test-contract: public-api — the >0 covered-list guard: with covered.length===0 the section is omitted
	it("N2: omits the 'covered elsewhere' block when nothing qualifies as covered", () => {
		const r = baseReport({
			scope: { ...baseReport().scope, coverageAvailable: true },
			caps: { ...baseReport().caps, minCoveragePct: 80 },
			missingCompanion: ["under.ts"],
			files: [
				{ file: "under.ts", functions: 1, linePct: 10, maxCyclomatic: 1, maxCrap: null, companion: null, overGate: 0 },
			],
		});
		const out = stripAnsi(renderNormal(r));
		expect(out).not.toContain("covered elsewhere");
	});

	// test-contract: boundary — pct(f) uses "" fallback arrow only for the no-coverage branch; real suffix must show "% lines" text with data
	it("P3: renders the coverage-% suffix (not an empty/undefined arrow) for a file with data", () => {
		const out = stripAnsi(renderNormal(reportWithCoverageSplit()));
		expect(out).toContain("(40% lines)");
	});

	// test-contract: boundary — a missing-companion file absent from r.files must render "(no coverage data)", not crash on undefined
	it("P4: renders '(no coverage data)' when the file has no matching FileMetric entry", () => {
		const r = baseReport({
			scope: { ...baseReport().scope, coverageAvailable: true },
			caps: { ...baseReport().caps, minCoveragePct: 80 },
			missingCompanion: ["ghost.ts"],
			files: [],
		});
		const out = stripAnsi(renderNormal(r));
		expect(out).toContain("(no coverage data)");
	});
});

describe("pushCappedFileList (via renderNormal) — positive (must fire)", () => {
	function manyMissingReport(count: number): MetricsReport {
		const files = Array.from({ length: count }, (_, i) => `f${i}.ts`);
		return baseReport({
			scope: { ...baseReport().scope, coverageAvailable: false },
			missingCompanion: files,
		});
	}

	// test-contract: boundary — exactly at the cap (25) must NOT show the overflow line, and must list all 25
	it("P1: lists all files and shows no overflow note at exactly the cap (25)", () => {
		const out = stripAnsi(renderNormal(manyMissingReport(25)));
		expect(out).toContain("f0.ts");
		expect(out).toContain("f24.ts");
		expect(out).not.toContain("more");
	});

	// test-contract: boundary — one over the cap (26) must slice to 25 entries and show "…and 1 more"
	it("N1: caps the list at 25 entries and shows the overflow note above the cap", () => {
		const out = stripAnsi(renderNormal(manyMissingReport(26)));
		expect(out).toContain("f0.ts");
		expect(out).toContain("f24.ts");
		expect(out).not.toContain("f25.ts");
		expect(out).toContain("and 1 more");
	});
});
