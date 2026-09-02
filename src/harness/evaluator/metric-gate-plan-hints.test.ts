import { describe, expect, it } from "vitest";
import { appendPlanHints } from "./metric-gate-plan-hints.js";

const ANON = "<anonymous>";

describe("appendPlanHints — positive (must fire)", () => {
	it("P1: appends the plan line under the violation that names the function", () => {
		const out = appendPlanHints(
			["`parse` rises 20 → 24 (cap 22)", "`other` rises 5 → 9"],
			[{ name: "parse" }, { name: "other" }],
			ANON,
			(_after, _file, fn, cap) => (fn === "parse" ? `extract arm A (CC 6) → remaining ${cap - 1}` : null),
			"body",
			"src/x.ts",
			22,
		);
		expect(out[0]).toBe("`parse` rises 20 → 24 (cap 22)\n      ↳ plan: extract arm A (CC 6) → remaining 21");
		expect(out[1]).toBe("`other` rises 5 → 9");
	});

	it("P2: hints every distinct named over-cap function once, even when two violations mention it", () => {
		let calls = 0;
		const out = appendPlanHints(
			["`parse` a", "`parse` b"],
			[{ name: "parse" }],
			ANON,
			() => {
				calls += 1;
				return "plan";
			},
			"body",
			"src/x.ts",
			16,
		);
		expect(calls).toBe(1);
		expect(out.filter((v) => v.includes("↳ plan"))).toHaveLength(1);
	});
});

describe("appendPlanHints — negative (must not fire)", () => {
	it("N1: leaves violations untouched when the planner returns null", () => {
		const violations = ["`parse` rises 20 → 24"];
		const out = appendPlanHints(violations, [{ name: "parse" }], ANON, () => null, "b", "src/x.ts", 22);
		expect(out).toEqual(violations);
	});

	it("N2: never plans an anonymous unit (no stable identity to plan against)", () => {
		let called = false;
		appendPlanHints(
			[`${ANON} rises 20 → 24`],
			[{ name: ANON }],
			ANON,
			() => {
				called = true;
				return "plan";
			},
			"b",
			"src/x.ts",
			22,
		);
		expect(called).toBe(false);
	});

	it("N3: an over-cap function that no violation mentions (held, grandfathered) gets no plan", () => {
		let called = false;
		const out = appendPlanHints(
			["`fresh` new function at 30"],
			[{ name: "held" }, { name: "fresh" }],
			ANON,
			(_a, _f, fn) => {
				if (fn === "held") called = true;
				return fn === "fresh" ? "p" : null;
			},
			"b",
			"src/x.ts",
			22,
		);
		expect(called).toBe(false);
		expect(out[0]).toContain("↳ plan: p");
	});

	it("N4: an empty violation list is returned as-is without calling the planner", () => {
		let called = false;
		const out = appendPlanHints(
			[],
			[{ name: "parse" }],
			ANON,
			() => {
				called = true;
				return "p";
			},
			"b",
			"src/x.ts",
			22,
		);
		expect(out).toEqual([]);
		expect(called).toBe(false);
	});
});
