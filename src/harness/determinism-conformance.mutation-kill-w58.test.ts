import { parseWire, wireArray, wireLiteral, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	canonicalizeFindings,
	checkRepeatDeterminism,
	classifyDivergence,
	type ConformanceFinding,
	runCorpusConformance,
	runInlinePipeline,
} from "./determinism-conformance.js";

const F = (over: Partial<ConformanceFinding> = {}): ConformanceFinding => ({
	check_id: "chk",
	severity: "warning",
	line: 1,
	text: "hello",
	...over,
});

describe("strcmp / compareFindings ordering (mutant 1e75f8cfaa64ee32: a > b -> false)", () => {
	// test-contract: public-api — canonicalizeFindings is documented to produce
	// a stable total order over findings; a>b must resolve to +1 or the sort
	// silently degrades to insertion order for descending pairs.
	it("sorts findings ascending by check_id even when inserted descending", () => {
		const findings = [F({ check_id: "zeta" }), F({ check_id: "alpha" })];
		const raw = canonicalizeFindings(findings);
		// SAFETY: raw is the JSON.stringify of a ConformanceFinding[] produced
		// two lines above by this same test — the shape is known, not external input.
		const out = parseWire(JSON.parse(raw), wireArray(wireObject({ "check_id": wireString, "severity": wireLiteral("error", "warning"), "line": wireNumber, "text": wireString })), "test JSON value");
		expect(out[0]?.check_id).toBe("alpha");
		expect(out[1]?.check_id).toBe("zeta");
	});
});

describe("trunc length boundary (mutant fb74f9d0d150a12d: s.length > n -> >=)", () => {
	// test-contract: boundary — trunc's doc comment truncates only when the
	// text exceeds 80 chars; a string of exactly 80 chars must pass through
	// unmodified (no slice, no ellipsis appended).
	it("does not truncate/ellipsize text exactly at the 80-char boundary", () => {
		const text80 = "a".repeat(80);
		const fa = F({ text: text80 });
		const fb = F({ text: "b".repeat(80) });
		const div = classifyDivergence([fa], [fb]);
		expect(div.kind).toBe("text");
		expect(div.detail).not.toContain("…");
		expect(div.detail).toContain(text80);
	});
});

describe("classifyDivergence sort-before-compare (mutants b39a61ff8dbc2166 / 2c27830d273fa46f)", () => {
	// test-contract: invariant — classifyDivergence's own doc comment says pure
	// reordering must never surface as a divergence, which only holds if both
	// input arrays are actually sorted before the element-wise comparison.
	it("reports 'none' when both sides carry the same multiset in different order", () => {
		const x = F({ check_id: "a", line: 1, text: "t1" });
		const y = F({ check_id: "b", line: 2, text: "t2" });
		const div = classifyDivergence([y, x], [x, y]);
		expect(div.kind).toBe("none");
	});
});

describe("classifyDivergence loop bound (mutant 6c1aa3e0541244d8: i < sa.length -> i <=)", () => {
	// test-contract: boundary — an off-by-one loop bound reads one element past
	// the array end; nonNull() on that undefined slot throws, so equal
	// single-element inputs must return cleanly with no exception.
	it("does not throw when comparing two identical single-element arrays", () => {
		const a = [F({ text: "same" })];
		const b = [F({ text: "same" })];
		expect(() => classifyDivergence(a, b)).not.toThrow();
	});

	// test-contract: boundary — companion assertion on the return value itself.
	it("returns kind 'none' for two identical single-element arrays", () => {
		const a = [F({ text: "same" })];
		const b = [F({ text: "same" })];
		expect(classifyDivergence(a, b).kind).toBe("none");
	});
});

describe("classifyDivergence text-must-differ guard (mutant 5a5c87faf717986b: condition -> true)", () => {
	// test-contract: invariant — the timestamp branch is documented to fire
	// only on a genuine text difference; two findings whose text is byte-equal
	// but differ in another field must fall through to the 'text' classification.
	it("classifies as 'text' (not 'timestamp') when text is identical but another field differs", () => {
		const fa = F({ line: 1, text: "2026-01-01T00:00 same-text" });
		const fb = F({ line: 2, text: "2026-01-01T00:00 same-text" });
		const div = classifyDivergence([fa], [fb]);
		expect(div.kind).toBe("text");
	});
});

describe("classifyDivergence timestamp OR (mutant a940d1175afbe556: || -> &&)", () => {
	// test-contract: bug — TIMESTAMP_RE.test(fa) || TIMESTAMP_RE.test(fb) means
	// a leak on EITHER side is enough to flag; requiring both (AND) would miss
	// the common case where only one run's finding embeds the clock.
	it("classifies as 'timestamp' when only ONE side's text matches the timestamp shape", () => {
		const fa = F({ text: "2026-01-01T00:00 leaked clock" });
		const fb = F({ text: "totally different, no dates here" });
		const div = classifyDivergence([fa], [fb]);
		expect(div.kind).toBe("timestamp");
	});
});

describe("checkRepeatDeterminism checkIds sort (mutant 1bd6953e91d8063a)", () => {
	// test-contract: public-api — checkRepeatDeterminism's `checkIds` field is
	// documented as sorted via strcmp; content that fires multiple real
	// detectors must come back in ascending order regardless of fire order.
	it("returns checkIds in ascending order for content that fires several checks", () => {
		const content = `
const password = "hunter2SuperSecret";
eval(userInput);
function foo(a,b,c,d,e,f) { if(a){if(b){if(c){if(d){if(e){return f;}}}}} }
`;
		const result = checkRepeatDeterminism(content, "probe-file.ts", 1);
		expect(result.checkIds.length).toBeGreaterThanOrEqual(2);
		const sorted = [...result.checkIds].sort();
		expect(result.checkIds).toEqual(sorted);
	});
});

describe("runCorpusConformance totalFindings accumulation (mutant 33e0ba4a852f72be: += -> -=)", () => {
	// test-contract: public-api — CorpusReport.totalFindings is documented as
	// an aggregate SUM of per-item findingCount; two identical positive-finding
	// items must sum to double one item's count, never a negative number.
	it("sums findingCount across corpus items to a positive total", () => {
		const content = `eval(userInput);\n`;
		const single = runInlinePipeline(content, "corpus-item.ts").length;
		expect(single).toBeGreaterThan(0);
		const report = runCorpusConformance(
			[
				{ path: "a.ts", content },
				{ path: "b.ts", content },
			],
			1,
		);
		expect(report.totalFindings).toBe(single * 2);
	});
});

describe("checkRepeatDeterminism runs loop bound (mutant a0213c1384a7f5da: i < runs -> i <=)", () => {
	afterEach(() => {
		vi.doUnmock("./check-registry/index.js");
		vi.resetModules();
	});

	// test-contract: boundary — `for (i=1; i<runs; i++)` performs runs-1
	// repeat calls beyond the initial run; with runs=1 the loop body must
	// never execute, so the pipeline (and its inner detector build) runs
	// exactly once total.
	it("calls the pipeline exactly `runs` times, never runs+1", async () => {
		vi.resetModules();
		const fnSpy = vi.fn(() => [{ line: 1, text: "m" }]);
		const buildAgentSafetyChecksMock = vi.fn(() => [
			{ name: "mock_check", severity: "warning" as const, fn: fnSpy },
		]);
		vi.doMock("./check-registry/index.js", () => ({
			buildAgentSafetyChecks: buildAgentSafetyChecksMock,
		}));
		const mod = await import("./determinism-conformance.js");
		mod.checkRepeatDeterminism("content", "file.ts", 1);
		expect(buildAgentSafetyChecksMock.mock.calls.length).toBe(1);
	});
});
