import { describe, expect, it } from "vitest";
import {
	canonicalToCoverageSummary,
	parseLcov,
	perFileCoverageFromCanonical,
} from "./coverage-lcov.js";
import type { CanonicalCoverage, CanonicalFileCoverage } from "./coverage-canonical.js";

describe("parseLcov — normalizeSourcePath backslash handling (P1: must fire)", () => {
	it("converts backslashes to forward slashes in a non-absolute SF path", () => {
		const cov = parseLcov("SF:src\\foo\\bar.ts\nDA:1,1\nend_of_record\n");
		expect(Array.from(cov.files.keys())).toEqual(["src/foo/bar.ts"]);
	});

	it("trims whitespace surrounding the SF path", () => {
		const cov = parseLcov("SF: src/foo.ts \nDA:1,1\nend_of_record\n");
		expect(Array.from(cov.files.keys())).toEqual(["src/foo.ts"]);
	});
});
describe("resolveSfAcc — empty path leaves current file unchanged (P1)", () => {
	it("drops detail records when SF path is empty and no prior file is current", () => {
		const cov = parseLcov("SF:\nDA:1,1\nend_of_record\n");
		expect(cov.files.size).toBe(0);
		expect(cov.files.has("")).toBe(false);
	});

	it("leaves the current file unchanged (does not overwrite to null) on an empty SF path", () => {
		const cov = parseLcov("SF:a.ts\nDA:1,1\nSF:\nDA:2,1\nend_of_record\n");
		const a = cov.files.get("a.ts");
		expect(a).toBeDefined();
		// Original: second DA still lands on a.ts because cur is preserved.
		// Mutant (acc -> true / unconditional assign): cur gets clobbered to
		// null, so the second DA is dropped.
		expect(a?.lines.total).toBe(2);
	});
});

describe("splitFirstComma via applyFnRecord (P1)", () => {
	it("treats a comma-less FN rest as [whole string, ''] and skips (empty name)", () => {
		const cov = parseLcov("SF:x.ts\nFN:123\nend_of_record\n");
		const f = cov.files.get("x.ts");
		expect(f?.functions.total).toBe(0);
	});
});

describe("applyFnRecord guard (name present, ln invalid) — kills ConditionalExpression + LogicalOperator", () => {
	it("skips a malformed FN record whose line is not a finite number", () => {
		const cov = parseLcov("SF:x.ts\nFN:notanumber,myFn\nend_of_record\n");
		const f = cov.files.get("x.ts");
		expect(f?.functions.total).toBe(0);
	});
});

describe("applyFndaRecord guard (name present, hits invalid) — kills ConditionalExpression + LogicalOperator", () => {
	it("skips a malformed FNDA entry and does not desync positional pairing", () => {
		// Two FN entries for the same name "a" at lines 1 and 5, and FNDA entries
		// in order: a malformed one (should be skipped) then a valid 7.
		// If the malformed FNDA is NOT skipped, it consumes index 0 in the
		// positional pairing, shifting the real hit count away from FN line 1.
		const cov = parseLcov(
			[
				"SF:x.ts",
				"FN:1,a",
				"FNDA:notanumber,a",
				"FNDA:7,a",
				"end_of_record",
			].join("\n"),
		);
		const f = cov.files.get("x.ts");
		const fn = f?.perFunction.find((p) => p.name === "a" && p.line === 1);
		expect(fn?.hits).toBe(7);
	});
});

describe("applyDaRecord guard (ln valid, hits invalid) — kills LogicalOperator", () => {
	it("skips a DA record whose hits token does not parse", () => {
		const cov = parseLcov("SF:x.ts\nDA:5,bogus\nend_of_record\n");
		const f = cov.files.get("x.ts");
		expect(f?.lines.total).toBe(0);
	});
});

describe("applyBrdaRecord guards (P1)", () => {
	it("skips a BRDA record with fewer than 4 parts", () => {
		const cov = parseLcov("SF:x.ts\nBRDA:1,2\nend_of_record\n");
		const f = cov.files.get("x.ts");
		expect(f?.branches.total).toBe(0);
	});

	it("skips a BRDA record whose taken token is not '-' and not a finite number", () => {
		const cov = parseLcov("SF:x.ts\nBRDA:1,0,0,bogus\nend_of_record\n");
		const f = cov.files.get("x.ts");
		expect(f?.branches.total).toBe(0);
	});
});

describe("finalizeFile branch-covered counting — kills EqualityOperator", () => {
	it("counts only branches with taken > 0 as covered", () => {
		const cov = parseLcov(
			["SF:x.ts", "BRDA:1,0,0,0", "BRDA:2,0,0,0", "end_of_record"].join("\n"),
		);
		const f = cov.files.get("x.ts");
		expect(f?.branches.total).toBe(2);
		expect(f?.branches.covered).toBe(0);
	});
});

describe("main loop — rawLine.trim() (P1)", () => {
	it("recognizes SF tag even with leading indentation on the raw line", () => {
		const cov = parseLcov("  SF:foo.ts\nDA:1,1\nend_of_record\n");
		expect(cov.files.size).toBe(1);
		expect(cov.files.has("foo.ts")).toBe(true);
	});
});

describe("main loop — end_of_record resets `cur` (P1)", () => {
	it("does not attribute a stray detail record after end_of_record to the prior file", () => {
		const cov = parseLcov(
			["SF:a.ts", "DA:1,1", "end_of_record", "DA:2,1", "SF:b.ts", "DA:3,1", "end_of_record"].join(
				"\n",
			),
		);
		const a = cov.files.get("a.ts");
		const b = cov.files.get("b.ts");
		expect(a?.lines.total).toBe(1);
		expect(b?.lines.total).toBe(1);
	});
});

describe("main loop — colon===-1 guard skips lines with no colon (P1)", () => {
	it("does not misinterpret a colon-less garbage line as a tag record", () => {
		const cov = parseLcov("SFX\n");
		expect(cov.files.size).toBe(0);
	});
});

describe("canonicalToCoverageSummary — functions field bridging (P1)", () => {
	it("carries the pct/covered/total triple through for functions", () => {
		const cov: CanonicalCoverage = {
			source: "lcov",
			files: new Map<string, CanonicalFileCoverage>([
				[
					"x.ts",
					{
						path: "x.ts",
						lines: { covered: 1, total: 1, pct: 100 },
						branches: { covered: 0, total: 0, pct: 100 },
						functions: { covered: 2, total: 3, pct: 66.67 },
						perFunction: [],
						lineHits: new Map(),
					},
				],
			]),
		};
		const summary = canonicalToCoverageSummary(cov);
		expect(summary["x.ts"]?.functions).toEqual({ pct: 66.67, covered: 2, total: 3 });
	});
});

describe("perFileCoverageFromCanonical — fallback hits from covered>0 (P1)", () => {
	it("reports hits=1 when the line-range has a covered line and no FNDA entry exists", () => {
		const lineHits = new Map<number, number>([
			[1, 1],
			[2, 0],
		]);
		const canonicalFile: CanonicalFileCoverage = {
			path: "x.ts",
			lines: { covered: 1, total: 2, pct: 50 },
			branches: { covered: 0, total: 0, pct: 100 },
			functions: { covered: 0, total: 0, pct: 100 },
			perFunction: [], // no FNDA entries -> fnEntryHits map is empty
			lineHits,
		};
		const result = perFileCoverageFromCanonical(canonicalFile, "x.ts", 0, [
			{ name: "f", line: 1, endLine: 2 },
		]);
		expect(result.functions[0]?.hits).toBe(1);
	});
});
