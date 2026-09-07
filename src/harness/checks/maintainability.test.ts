// Tests for Halstead metrics and the maintainability index.
//
// Labeled per the Check Evidence Contract: the check ships with MUST-FIRE and
// MUST-NOT-FIRE cases from day one (no grandfathering for new checks).

import { describe, expect, it } from "vitest";
import {
	computeMaintainability,
	HALSTEAD_DIFFICULTY_CEILING,
	HALSTEAD_VOLUME_FLOOR,
	MIN_TEXT_FOR_TALLY,
	maintainabilityCheck,
	maintainabilityIndex,
} from "./maintainability.js";

/**
 * Extreme density with NO branching: two operands reused across many distinct
 * operators, so cyclomatic reads 1 while Halstead difficulty runs far above the
 * p99.9 of real code.
 */
const DENSE_FLAT = `
export function serialize(a, b) {
	const r1 = a + b - a * b / a % b ** a & b | a ^ b;
	const r2 = (a << b) >>> (b >> a) | (~a & ~b) ^ (a || b) ?? (a && b);
	const r3 = a > b ? a < b : a >= b ? a <= b : a === b ? a !== b : !a;
	const r4 = a + b + a - b - a * b * a / b / a % b % a ** b ** a;
	const r5 = (a & b) | (a ^ b) | (a << b) | (a >> b) | (a >>> b);
	const r6 = a + a + a + b + b + b - a - a - b - b + a * a * b * b;
	const r7 = a | b | a | b | a & b & a & b ^ a ^ b ^ a ^ b;
	const r8 = a + b * a - b / a % b + a ** b - (a & b) + (a | b);
	return r1 + r2 + r3 + r4 + r5 + r6 + r7 + r8 + a + b;
}
`;

/** Moderately dense — around p90 of real code, so it must stay silent. */
const MODERATELY_DENSE = `
export function serialize(a, b, c, d, e, f, g, h) {
	const p1 = a * 2 + b * 3 - c / 4 + d % 5;
	const p2 = e ** 2 + f * 7 - g / 8 + h % 9;
	const p3 = (p1 & p2) | (p1 ^ p2) | (~p1 >>> 2) | (p2 << 3);
	const p4 = \`\${a}-\${b}-\${c}-\${d}-\${e}-\${f}-\${g}-\${h}\`;
	const p5 = [a, b, c, d, e, f, g, h].map((x) => x + 1).join(",");
	const p6 = { a, b, c, d, e, f, g, h, p1, p2, p3, p4, p5 };
	const p7 = JSON.stringify(p6) + String(p3) + Number(p1).toFixed(3);
	const p8 = p7.slice(0, 40).padEnd(60, "_").toUpperCase().trim();
	const p9 = p8.replace(/A/g, "z").split("").reverse().join("");
	return p9 + p4 + p5 + p7 + String(p1 + p2 + p3);
}
`;

const TINY = `
export function add(a, b) {
	return a + b;
}
`;

function fnNamed(src: string, name: string) {
	const all = computeMaintainability(src, "src/thing.ts");
	return all?.find((f) => f.name === name);
}

describe("maintainabilityIndex", () => {
	it("returns 100 for a degenerate empty function", () => {
		expect(maintainabilityIndex(0, 1, 0)).toBeGreaterThan(99);
	});

	it("never returns a negative index", () => {
		expect(maintainabilityIndex(1e9, 200, 5000)).toBe(0);
	});

	it("is clamped to 100 at the top", () => {
		expect(maintainabilityIndex(0, 0, 0)).toBe(100);
	});

	it("falls as volume rises, holding other terms fixed", () => {
		expect(maintainabilityIndex(5000, 5, 40)).toBeLessThan(maintainabilityIndex(50, 5, 40));
	});

	it("falls as cyclomatic rises, holding other terms fixed", () => {
		expect(maintainabilityIndex(500, 40, 40)).toBeLessThan(maintainabilityIndex(500, 1, 40));
	});

	it("falls as length rises, holding other terms fixed", () => {
		expect(maintainabilityIndex(500, 5, 400)).toBeLessThan(maintainabilityIndex(500, 5, 10));
	});
});

describe("computeMaintainability — Halstead", () => {
	it("counts distinct operands separately from operators", () => {
		const fn = fnNamed(TINY, "add");
		expect(fn?.halstead.unique_operands).toBeGreaterThan(0);
		expect(fn?.halstead.unique_operators).toBeGreaterThan(0);
	});

	it("derives vocabulary and length from the tallies", () => {
		const h = fnNamed(TINY, "add")?.halstead;
		expect(h?.vocabulary).toBe((h?.unique_operators ?? 0) + (h?.unique_operands ?? 0));
		expect(h?.length).toBe((h?.total_operators ?? 0) + (h?.total_operands ?? 0));
	});

	it("gives a dense function a far larger volume than a tiny one", () => {
		const dense = fnNamed(DENSE_FLAT, "serialize")?.halstead.volume ?? 0;
		const tiny = fnNamed(TINY, "add")?.halstead.volume ?? 0;
		expect(dense).toBeGreaterThan(tiny * 5);
	});

	it("reports effort as difficulty times volume", () => {
		const h = fnNamed(DENSE_FLAT, "serialize")?.halstead;
		expect(h?.effort).toBeCloseTo((h?.difficulty ?? 0) * (h?.volume ?? 0), 5);
	});

	it("measures the vocabulary dimension control-flow metrics miss", () => {
		// The dense function's only branching is ternaries; its difficulty is an
		// order of magnitude above ordinary code, which the complexity gates
		// cannot see at all.
		const fn = fnNamed(DENSE_FLAT, "serialize");
		expect(fn?.halstead.volume).toBeGreaterThan(200);
		expect(fn?.halstead.difficulty).toBeGreaterThan(80);
	});
});

describe("maintainabilityCheck — positive (must fire)", () => {
	it("P1: fires on a flat but dense function", () => {
		const found = maintainabilityCheck(DENSE_FLAT, "src/thing.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toMatch(/Halstead difficulty [\d.]+ > 80/);
	});

	it("P2: names the function and reports its inputs", () => {
		const found = maintainabilityCheck(DENSE_FLAT, "src/thing.ts");
		expect(found[0]?.text).toMatch(/serialize/);
		expect(found[0]?.text).toMatch(/volume \d+/);
		expect(found[0]?.text).toMatch(/cyclomatic \d+/);
	});

	it("P3: anchors the finding at the function's own line", () => {
		const found = maintainabilityCheck(DENSE_FLAT, "src/thing.ts");
		expect(found[0]?.line).toBe(2);
	});

	it("P4: reports each offending function separately", () => {
		const two = `${DENSE_FLAT}\n${DENSE_FLAT.replace("serialize", "serializeTwo")}`;
		expect(maintainabilityCheck(two, "src/thing.ts").length).toBeGreaterThanOrEqual(2);
	});
});

describe("maintainabilityCheck — negative (must NOT fire)", () => {
	it("N1: a tiny function is silent", () => {
		expect(maintainabilityCheck(TINY, "src/thing.ts")).toEqual([]);
	});

	it("N2: an ordinary readable function is silent", () => {
		const src = `
export function greet(name: string): string {
	if (!name) return "hello, stranger";
	return \`hello, \${name}\`;
}
`;
		expect(maintainabilityCheck(src, "src/thing.ts")).toEqual([]);
	});

	it("N3: a long but simple function is silent", () => {
		// Length alone must not trip the check — that is the line cap's job.
		// This case is why the check gates on Halstead difficulty rather than
		// on the maintainability index: MI scored this function 42 and the
		// dense 12-liner 54, i.e. it ranked trivial-but-long as the WORSE code.
		const body = Array.from({ length: 40 }, (_, i) => `\tconst v${i} = ${i};`).join("\n");
		const src = `export function longButSimple() {\n${body}\n\treturn 0;\n}`;
		expect(maintainabilityCheck(src, "src/thing.ts")).toEqual([]);
	});

	it("N8: moderately dense code around p90 of the real corpus is silent", () => {
		// Difficulty ~34, i.e. the 90th percentile of this repo's 9023 functions.
		// The first draft of this check fired here; the corpus run showed that
		// threshold produced 2226 hits, so p90 code must stay silent.
		expect(maintainabilityCheck(MODERATELY_DENSE, "src/thing.ts")).toEqual([]);
	});

	it("N7: a short high-difficulty expression under the volume floor is silent", () => {
		expect(maintainabilityCheck("export function f(a, b) { return a & b | ~a; }", "src/x.ts")).toEqual([]);
	});

	it("N4: a file with no functions is silent", () => {
		expect(maintainabilityCheck("export const X = 1;", "src/thing.ts")).toEqual([]);
	});

	it("N5: an empty file is silent", () => {
		expect(maintainabilityCheck("", "src/thing.ts")).toEqual([]);
	});

	it("N6: a type-only declaration file is silent", () => {
		expect(maintainabilityCheck("export interface A { x: number }", "src/a.ts")).toEqual([]);
	});
});

describe("computeMaintainability — structure", () => {
	it("returns functions sorted by line", () => {
		const src = `${TINY}\n${DENSE_FLAT}`;
		const all = computeMaintainability(src, "src/thing.ts") ?? [];
		expect(all.length).toBeGreaterThanOrEqual(2);
		for (let i = 1; i < all.length; i++) {
			expect(all[i]?.line ?? 0).toBeGreaterThanOrEqual(all[i - 1]?.line ?? 0);
		}
	});

	it("the performance pre-filter can never change a verdict", () => {
		// MIN_TEXT_FOR_TALLY skips the expensive token walk for short functions.
		// It must be strictly weaker than the reporting floor, or it would
		// silently suppress findings instead of merely saving work.
		expect(MIN_TEXT_FOR_TALLY).toBeLessThanOrEqual(HALSTEAD_VOLUME_FLOOR);
	});

	it("still measures a function just above the pre-filter length", () => {
		const src = `export function f(a, b) {\n${"\tconst x = a + b;\n".repeat(20)}\treturn a;\n}`;
		expect(src.length).toBeGreaterThan(MIN_TEXT_FOR_TALLY);
		expect(fnNamed(src, "f")?.halstead.volume ?? 0).toBeGreaterThan(0);
	});

	it("gates on thresholds that separate the measured fixtures", () => {
		// Calibrated from the corpus run over 9023 real functions:
		// p90=35.0, p99=58.6, p99.9=85.4. The ceiling must sit above p99 so an
		// advisory fire is rare and meaningful, and below the observed max.
		expect(HALSTEAD_DIFFICULTY_CEILING).toBeGreaterThan(58.6);
		expect(HALSTEAD_DIFFICULTY_CEILING).toBeLessThan(164);
		expect(HALSTEAD_VOLUME_FLOOR).toBeGreaterThan(100);
	});
});
