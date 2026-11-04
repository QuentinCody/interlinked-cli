import { describe, expect, it } from "vitest";
import { loadFastCheck, loadTsModule } from "./differential-fuzz-deps.js";
import { asFcApi, collectDictionary, deriveArbitraries, type FcApi } from "./differential-fuzz-arbitraries.js";
import { findExportedFunction, parseSource } from "./differential-fuzz-locate.js";

async function setup(source: string) {
	const ts = loadTsModule();
	const fc = asFcApi(await loadFastCheck());
	if (ts === null || fc === null) throw new Error("typescript and fast-check are required for this suite");
	const sf = parseSource(ts, "fixture.ts", source);
	const located = findExportedFunction(ts, sf, source.indexOf("return"));
	if (!located.ok) throw new Error(located.reason);
	return { ts, fc, sf, fn: located.fn };
}

async function derive(source: string) {
	const { ts, fc, sf, fn } = await setup(source);
	return { fc, result: deriveArbitraries(ts, sf, fc, fn, collectDictionary(ts, fn)) };
}

function sampleParam(fc: FcApi, arbs: unknown[], index: number): unknown[] {
	return fc.sample(arbs[index], { numRuns: 200, seed: 7 });
}

describe("differential-fuzz-arbitraries — positive (must fire)", () => {
	it("P1: asFcApi accepts the real fast-check module and exposes the search entry points", async () => {
		const fc = asFcApi(await loadFastCheck());
		expect(fc).not.toBeNull();
		expect(typeof fc?.check).toBe("function");
	});

	it("P2: a number parameter is seeded with the literals in the body and their neighbours", async () => {
		const { fc, result } = await derive("export function f(x: number) { return x < 1234 ? 1 : 0; }");
		if (!result.ok) throw new Error(result.reason);
		const samples = sampleParam(fc, result.arbs, 0);
		for (const boundary of [1233, 1234, 1235]) expect(samples).toContain(boundary);
		expect(samples.every((s) => typeof s === "number")).toBe(true);
	});

	it("P3: a string parameter reuses string literals from the body, bare and as a prefix", async () => {
		const { fc, result } = await derive('export function f(s: string) { return s.startsWith("zebra"); }');
		if (!result.ok) throw new Error(result.reason);
		const samples = sampleParam(fc, result.arbs, 0);
		expect(samples.some((s) => s === "zebra")).toBe(true);
		expect(samples.some((s) => typeof s === "string" && s.startsWith("zebra") && s !== "zebra")).toBe(true);
	});

	it("P4: arrays, tuples, object literals, optional members and literal unions derive from the declared type", async () => {
		const { fc, result } = await derive(
			"export function f(xs: number[], t: [string, boolean], o: { a: number; b?: string }, k: 'u' | 'v') { return 1; }",
		);
		if (!result.ok) throw new Error(result.reason);
		expect(result.specs.map((s) => s.name)).toEqual(["xs", "t", "o", "k"]);
		expect(sampleParam(fc, result.arbs, 0).every((v) => Array.isArray(v))).toBe(true);
		const tuples = sampleParam(fc, result.arbs, 1);
		expect(tuples.every((v) => Array.isArray(v) && v.length === 2)).toBe(true);
		const objs = sampleParam(fc, result.arbs, 2);
		expect(objs.some((v) => typeof v === "object" && v !== null && !("b" in v))).toBe(true);
		expect(new Set(sampleParam(fc, result.arbs, 3))).toEqual(new Set(["u", "v"]));
	});

	it("P5: optional parameters and defaults may be omitted; same-file aliases and interfaces resolve", async () => {
		const { fc, result } = await derive(
			"type P = { n: number };\ninterface Q { s: string }\nexport function f(p: P, q: Q, r?: number, w = 5) { return 1; }",
		);
		if (!result.ok) throw new Error(result.reason);
		expect(sampleParam(fc, result.arbs, 2)).toContain(undefined);
		expect(sampleParam(fc, result.arbs, 3)).toContain(undefined);
		expect(sampleParam(fc, result.arbs, 0).every((v) => typeof v === "object")).toBe(true);
	});

	it("P6: collectDictionary gathers numeric and string literals from the function body only", async () => {
		const { ts, fn } = await setup("const OUT = 99;\nexport function f(a: number) { return a === 7 ? 'hit' : 'miss'; }");
		const dict = collectDictionary(ts, fn);
		expect(dict.numbers).toEqual(expect.arrayContaining([6, 7, 8]));
		expect(dict.numbers).not.toContain(99);
		expect(dict.strings).toEqual(expect.arrayContaining(["hit", "miss"]));
	});
});

describe("differential-fuzz-arbitraries — negative (must not fire)", () => {
	it("N1: a callback parameter is unsupported and the reason names the parameter", async () => {
		const { result } = await derive("export function f(cb: () => void) { return 1; }");
		expect(!result.ok && result.reason).toContain("cb");
	});

	it("N2: a class-instance parameter (Date) is unsupported and names the parameter", async () => {
		const { result } = await derive("export function f(when: Date) { return 1; }");
		expect(!result.ok && result.reason).toContain("when");
	});

	it("N3: an untyped parameter is unsupported", async () => {
		const { result } = await derive("export function f(x) { return 1; }");
		expect(!result.ok && result.reason).toContain("x");
	});

	it("N4: rest parameters, generics and any/unknown are unsupported", async () => {
		for (const sig of ["...xs: number[]", "x: T", "x: any", "x: unknown"]) {
			const generic = sig === "x: T" ? "<T>" : "";
			const { result } = await derive(`export function f${generic}(${sig}) { return 1; }`);
			expect(result.ok).toBe(false);
		}
	});

	it("N5: a self-referential alias is unsupported instead of recursing forever", async () => {
		const { result } = await derive("type Tree = { kids: Tree[] };\nexport function f(t: Tree) { return 1; }");
		expect(!result.ok && result.reason).toContain("recursive");
	});

	it("N6: an interface that extends another is unsupported", async () => {
		const { result } = await derive("interface A { a: number }\ninterface B extends A { b: number }\nexport function f(x: B) { return 1; }");
		expect(!result.ok && result.reason).toContain("x");
	});

	it("N7: a body with no literals yields an empty dictionary, so numbers stay plain numbers", async () => {
		const { ts, fn } = await setup("export function f(a: number, b: number) { return a + b; }");
		expect(collectDictionary(ts, fn)).toEqual({ numbers: [], strings: [] });
	});
});
