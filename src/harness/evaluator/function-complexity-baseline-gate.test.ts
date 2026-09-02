import { describe, expect, it } from "vitest";
import {
	detectFunctionComplexityBaseline,
	detectSiblingBaseline,
	isFunctionComplexityBaselinePath,
	isSiblingBaselinePath,
	ledgerCreationBlock,
} from "./function-complexity-baseline-gate.js";

const LEDGER = "/repo/.interlinked/function-complexity-baseline.json";

function entry(file: string, name: string, value: number, line = 1) {
	return { file, name, line, value };
}

type Section = { cap: unknown; entries: unknown[] };
function ledger(cyclomatic: Section, cognitive?: Section) {
	return { version: 1, metrics: cognitive ? { cyclomatic, cognitive } : { cyclomatic } };
}

function detect(before: unknown, after: unknown) {
	return detectFunctionComplexityBaseline(LEDGER, JSON.stringify(before), JSON.stringify(after));
}

describe("isFunctionComplexityBaselinePath", () => {
	it("P1: matches the ledger by absolute and relative path", () => {
		expect(isFunctionComplexityBaselinePath(LEDGER)).toBe(true);
		expect(isFunctionComplexityBaselinePath(".interlinked/function-complexity-baseline.json")).toBe(true);
		expect(isFunctionComplexityBaselinePath("C:\\repo\\.interlinked\\function-complexity-baseline.json")).toBe(true);
	});

	it("N1: does not match the previous-snapshot sibling, a .bak copy, or other baselines", () => {
		expect(isFunctionComplexityBaselinePath("/repo/.interlinked/function-complexity-baseline.previous.json")).toBe(false);
		expect(isFunctionComplexityBaselinePath(`${LEDGER}.bak`)).toBe(false);
		expect(isFunctionComplexityBaselinePath("/repo/.interlinked/metric-caps.json")).toBe(false);
	});
});

describe("detectFunctionComplexityBaseline — positive (must fire)", () => {
	const base = ledger({ cap: 16, entries: [entry("src/a.ts", "big", 20), entry("src/b.ts", "other", 30)] });

	it("blocks raising a metric cap", () => {
		const found = detect(base, ledger({ cap: 18, entries: base.metrics.cyclomatic.entries }));
		expect(found).toHaveLength(1);
		expect(found[0]?.rule).toBe("cyclomatic:cap");
		expect(found[0]?.message).toContain("raised 16→18");
	});

	it("blocks raising an entry's recorded value", () => {
		const after = ledger({ cap: 16, entries: [entry("src/a.ts", "big", 21), entry("src/b.ts", "other", 30)] });
		const found = detect(base, after);
		expect(found).toHaveLength(1);
		expect(found[0]?.rule).toBe("cyclomatic:grandfather:src/a.ts:big");
		expect(found[0]?.before).toBe(20);
		expect(found[0]?.after).toBe(21);
		expect(found[0]?.message).toContain("20→21");
	});

	it("blocks adding an entry", () => {
		const after = ledger({ cap: 16, entries: [...base.metrics.cyclomatic.entries, entry("src/c.ts", "fresh", 25)] });
		const found = detect(base, after);
		expect(found).toHaveLength(1);
		expect(found[0]?.rule).toBe("cyclomatic:grandfather-new:src/c.ts:fresh");
		expect(found[0]?.message).toContain("pre-authorizes");
	});

	it("blocks adding a second same-named entry (a duplicate is also an addition)", () => {
		const after = ledger({ cap: 16, entries: [...base.metrics.cyclomatic.entries, entry("src/a.ts", "big", 19, 90)] });
		expect(detect(base, after).map((f) => f.rule)).toEqual(["cyclomatic:grandfather-new:src/a.ts:big"]);
	});

	it("blocks a whole new metric section that carries entries", () => {
		const after = ledger(base.metrics.cyclomatic, { cap: 30, entries: [entry("src/a.ts", "deep", 40)] });
		const found = detect(base, after);
		expect(found.map((f) => f.rule)).toEqual(["cognitive:grandfather-new:src/a.ts:deep"]);
	});

	it("reports every loosening in one pass", () => {
		const after = ledger({ cap: 20, entries: [entry("src/a.ts", "big", 22), entry("src/b.ts", "other", 30), entry("src/c.ts", "x", 21)] });
		expect(detect(base, after).map((f) => f.rule).sort()).toEqual([
			"cyclomatic:cap",
			"cyclomatic:grandfather-new:src/c.ts:x",
			"cyclomatic:grandfather:src/a.ts:big",
		]);
	});

	it("P7: a tightening cannot smuggle in an entry ABOVE the old cap (never allowed under the old regime)", () => {
		const after = ledger({ cap: 12, entries: [...base.metrics.cyclomatic.entries, entry("src/c.ts", "huge", 17)] });
		expect(detect(base, after).map((f) => f.rule)).toEqual(["cyclomatic:grandfather-new:src/c.ts:huge"]);
	});

	it("P8: with the cap unchanged, an entry within the old cap is still an addition", () => {
		const after = ledger({ cap: 16, entries: [...base.metrics.cyclomatic.entries, entry("src/c.ts", "mid", 14)] });
		expect(detect(base, after).map((f) => f.rule)).toEqual(["cyclomatic:grandfather-new:src/c.ts:mid"]);
	});
});

describe("detectFunctionComplexityBaseline — negative (must not fire)", () => {
	const base = ledger({
		cap: 16,
		entries: [entry("src/a.ts", "big", 20), entry("src/a.ts", "dup", 18, 30), entry("src/a.ts", "dup", 24, 60)],
	});

	it("allows tightening a cap", () => {
		expect(detect(base, ledger({ cap: 12, entries: base.metrics.cyclomatic.entries }))).toEqual([]);
	});

	it("allows lowering an entry's value and removing an entry", () => {
		const after = ledger({ cap: 16, entries: [entry("src/a.ts", "big", 17), entry("src/a.ts", "dup", 24, 60)] });
		expect(detect(base, after)).toEqual([]);
	});

	it("allows an unchanged ledger, a moved line number, and a reordered list", () => {
		const moved = ledger({
			cap: 16,
			entries: [entry("src/a.ts", "dup", 24, 61), entry("src/a.ts", "dup", 18, 31), entry("src/a.ts", "big", 20, 7)],
		});
		expect(detect(base, base)).toEqual([]);
		expect(detect(base, moved)).toEqual([]);
	});

	it("N7: a tightening may list functions in (newCap, oldCap] — exactly what `caps ratchet` writes", () => {
		const after = ledger({ cap: 12, entries: [...base.metrics.cyclomatic.entries, entry("src/c.ts", "mid", 14), entry("src/c.ts", "edge", 16)] });
		expect(detect(base, after)).toEqual([]);
	});

	it("allows a new metric section with a cap and no entries", () => {
		expect(detect(base, ledger(base.metrics.cyclomatic, { cap: 30, entries: [] }))).toEqual([]);
	});

	it("allows removing a whole metric section (drops every grandfather)", () => {
		const both = ledger(base.metrics.cyclomatic, { cap: 30, entries: [entry("src/a.ts", "deep", 40)] });
		expect(detect(both, base)).toEqual([]);
	});

	it("fails open on unparseable JSON, a missing before-text, or a non-object", () => {
		expect(detectFunctionComplexityBaseline(LEDGER, "", JSON.stringify(base))).toEqual([]);
		expect(detectFunctionComplexityBaseline(LEDGER, "{nope", JSON.stringify(base))).toEqual([]);
		expect(detectFunctionComplexityBaseline(LEDGER, JSON.stringify(base), "[1]")).toEqual([]);
	});

	it("ignores non-numeric caps and values rather than string-comparing them", () => {
		const weird = ledger({ cap: 16, entries: [{ file: "src/a.ts", name: "big", line: 1, value: "99" }] });
		expect(detect(ledger({ cap: 16, entries: [entry("src/a.ts", "big", 20)] }), weird)).toEqual([]);
		expect(detect(ledger({ cap: "16", entries: [] }), ledger({ cap: 99, entries: [] }))).toEqual([]);
	});
});

describe("ledgerCreationBlock — a hand-written first ledger", () => {
	it("P1: blocks under the baseline_integrity_gate rule id and names the ratchet", () => {
		const d = ledgerCreationBlock(LEDGER);
		expect(d.decision).toBe("block");
		expect(d.rule_id).toBe("baseline_integrity_gate");
		expect(d.reason).toContain("interlinked caps ratchet");
		expect(d.reason).toContain(LEDGER);
	});
});

describe("detectSiblingBaseline / isSiblingBaselinePath — the delegation seam", () => {
	it("N1: the complexity ledger is a WATER-LINE now, not a sibling (baseline-integrity-gate dispatches it via KIND_MAP)", () => {
		expect(isSiblingBaselinePath(LEDGER)).toBe(false);
		const before = ledger({ cap: 16, entries: [] });
		const after = ledger({ cap: 20, entries: [] });
		expect(detectSiblingBaseline(LEDGER, JSON.stringify(before), JSON.stringify(after))).toEqual([]);
	});

	it("still routes the disposition ledger to its own detector", () => {
		const path = "/repo/.interlinked/mutation-dispositions.json";
		expect(isSiblingBaselinePath(path)).toBe(true);
		expect(detectSiblingBaseline(path, '{"records":[]}', '{"records":[]}')).toEqual([]);
	});

	it("is inert for any other path", () => {
		expect(isSiblingBaselinePath("/repo/.interlinked/other.json")).toBe(false);
		expect(detectSiblingBaseline("/repo/.interlinked/other.json", "{}", "{}")).toEqual([]);
	});
});
