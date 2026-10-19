import { describe, expect, it } from "vitest";
import weights from "./fp-filter-weights.json" with { type: "json" };
import {
	countByCheck,
	extractFpFeatures,
	FP_FILTER_DEFAULT_THRESHOLD,
	FP_FILTER_PROVENANCE,
	formatFpFilterTrailer,
	normalizeFindingPath,
	scoreFinding,
} from "./fp-filter.js";

const msg = (n: number): string => "x".repeat(n);

describe("scoreFinding — parity with the Python fit (fit_for_ship.py)", () => {
	it("reproduces every shipped parity sample to 1e-9", () => {
		expect(weights.parity.length).toBeGreaterThan(10);
		for (const s of weights.parity) {
			const got = scoreFinding({ check: s.check, file: s.file, severity: s.severity, message: msg(s.message_len), repeatCount: s.repeat_count });
			expect(Math.abs(got.p - s.p)).toBeLessThan(1e-9);
		}
	});

	it("ships the train-set threshold and holdout provenance the report quotes", () => {
		expect(FP_FILTER_DEFAULT_THRESHOLD).toBe(weights.threshold);
		expect(FP_FILTER_PROVENANCE.operating_point.holdout_tp_kept).toBe(26);
		expect(FP_FILTER_PROVENANCE.operating_point.holdout_fp_suppressed).toBe(66);
		expect(FP_FILTER_PROVENANCE.operating_point.holdout_fp).toBe(122);
	});
});

describe("scoreFinding — positive (must keep a known-TP-shaped finding)", () => {
	it("P1: magic_number in product source is kept", () => {
		const s = scoreFinding({ check: "magic_number", file: "src/lib/metrics/evidence-store.ts", severity: "warning", message: msg(60), repeatCount: 1 });
		expect(s.suppress).toBe(false);
		expect(s.p).toBeGreaterThan(0.5);
	});

	it("P2: unjustified_cast in product source is kept", () => {
		const s = scoreFinding({ check: "unjustified_cast", file: "src/harness/foo.ts", message: msg(70) });
		expect(s.suppress).toBe(false);
	});
});

describe("scoreFinding — negative (must suppress a known-FP-shaped finding)", () => {
	it("N1: function_arg_count in product source is suppressed (0/30 TP in E18)", () => {
		const s = scoreFinding({ check: "function_arg_count", file: "src/harness/checks/shared-text-utils-ast.ts", severity: "warning", message: msg(76) });
		expect(s.suppress).toBe(true);
		expect(s.p).toBeLessThan(FP_FILTER_DEFAULT_THRESHOLD);
	});

	it("N2: a scratch-path print-debug finding is suppressed", () => {
		const s = scoreFinding({ check: "ubs_print_debug_leak", file: "scratch/probe/assemble.py", message: msg(129), repeatCount: 1 });
		expect(s.suppress).toBe(true);
	});

	it("N3: an absolute path under cwd scores like its repo-relative form", () => {
		const rel = scoreFinding({ check: "expression_size", file: ".interlinked/agent-output/x.mjs", message: msg(139) });
		const abs = scoreFinding({ check: "expression_size", file: "/repo/.interlinked/agent-output/x.mjs", message: msg(139), cwd: "/repo" });
		expect(abs.p).toBe(rel.p);
		expect(abs.suppress).toBe(true);
	});
});

describe("scoreFinding — threshold override", () => {
	it("min_p replaces the shipped threshold", () => {
		const f = { check: "magic_number", file: "src/a.ts", message: msg(60) };
		expect(scoreFinding(f, 0.99).suppress).toBe(true);
		expect(scoreFinding(f, 0.99).threshold).toBe(0.99);
		expect(scoreFinding(f, Number.NaN).threshold).toBe(FP_FILTER_DEFAULT_THRESHOLD);
	});
});

describe("extractFpFeatures", () => {
	it("one-hot encodes known checks and routes the rest to chk_other", () => {
		const known = extractFpFeatures({ check: "magic_number", file: "src/a.ts", message: "ab" });
		expect(known.chk_magic_number).toBe(1);
		expect(known.chk_other).toBe(0);
		const other = extractFpFeatures({ check: "never_seen_check", file: "src/a.ts", message: "ab" });
		expect(other.chk_other).toBe(1);
		expect(other.chk_magic_number).toBe(0);
	});

	it("classifies test, scratch and archived paths with the E18 regexes", () => {
		expect(extractFpFeatures({ check: "c", file: "src/a.test.ts", message: "" }).is_test).toBe(1);
		expect(extractFpFeatures({ check: "c", file: "tests/test_a.py", message: "" }).is_test).toBe(1);
		expect(extractFpFeatures({ check: "c", file: "src/a.ts", message: "" }).is_test).toBe(0);
		expect(extractFpFeatures({ check: "c", file: "scratch/a.ts", message: "" }).path_scratch).toBe(1);
		expect(extractFpFeatures({ check: "c", file: "pkg/tmp/a.ts", message: "" }).path_scratch).toBe(1);
		expect(extractFpFeatures({ check: "c", file: "src/scratchy.ts", message: "" }).path_scratch).toBe(0);
		expect(extractFpFeatures({ check: "c", file: "src/__fixtures__/a.ts", message: "" }).path_archived).toBe(1);
		expect(extractFpFeatures({ check: "c", file: "src/a.ts", message: "" }).path_archived).toBe(0);
	});

	it("counts message length in code points and reads severity and repeats", () => {
		const f = extractFpFeatures({ check: "c", severity: "error", message: "a😀", repeatCount: 3 });
		expect(f.message_len).toBe(2);
		expect(f.sev_error).toBe(1);
		expect(f.repeat_count).toBe(3);
		expect(extractFpFeatures({ check: "c", message: "" }).repeat_count).toBe(0);
	});
});

describe("normalizeFindingPath", () => {
	it("strips the cwd prefix and leading ./, keeps foreign absolute paths", () => {
		expect(normalizeFindingPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
		expect(normalizeFindingPath("/repo/src/a.ts", "/repo/")).toBe("src/a.ts");
		expect(normalizeFindingPath("././src/a.ts", undefined)).toBe("src/a.ts");
		expect(normalizeFindingPath("/other/a.ts", "/repo")).toBe("/other/a.ts");
		expect(normalizeFindingPath(undefined, "/repo")).toBe("");
	});
});

describe("formatFpFilterTrailer", () => {
	const entries = [{ check: "function_arg_count", p: 0.01 }, { check: "function_arg_count", p: 0.01 }, { check: "data_clump", p: 0.02 }];

	it("downgrade names the suppressed checks with counts", () => {
		const line = formatFpFilterTrailer(entries, "downgrade", FP_FILTER_DEFAULT_THRESHOLD);
		expect(line).toBe("[interlinked:fp-filter] [heuristic] 3 findings suppressed by fp_filter (p<0.0235): function_arg_count×2, data_clump; audit: interlinked query checks --where fp_filter_suppressed=true");
	});

	it("hide carries only the count", () => {
		const line = formatFpFilterTrailer(entries.slice(0, 1), "hide", 0.5);
		expect(line).toBe("[interlinked:fp-filter] [heuristic] 1 finding suppressed by fp_filter (p<0.500); audit: interlinked query checks --where fp_filter_suppressed=true");
	});

	it("returns null when nothing was suppressed", () => {
		expect(formatFpFilterTrailer([], "downgrade", 0.0235)).toBeNull();
	});

	it("countByCheck orders by count then name", () => {
		expect(countByCheck([{ check: "b" }, { check: "a" }, { check: "b" }, { check: "c" }])).toBe("b×2, a, c");
	});
});
