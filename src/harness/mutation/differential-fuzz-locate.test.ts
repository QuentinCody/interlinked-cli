import { describe, expect, it } from "vitest";
import { loadTsModule } from "./differential-fuzz-deps.js";
import {
	FUZZ_TARGET_EXPORT,
	applyMutant,
	findExportedFunction,
	lexemeCandidates,
	locateMutantOffset,
	parseSource,
	syntheticExportSuffix,
} from "./differential-fuzz-locate.js";
import type { FuzzMutantTarget } from "./differential-fuzz-types.js";
import { computeSymbolHashes } from "./identity.js";

function requireTs() {
	const ts = loadTsModule();
	if (ts === null) throw new Error("typescript is required for this suite");
	return ts;
}

const SOURCE = [
	"export function lt(a: number, b: number): boolean {",
	"\treturn a < b;",
	"}",
	"function hidden(x: number): number {",
	"\treturn x < 3 ? 1 : 0;",
	"}",
	"export { hidden as shown };",
	"export const arrow = (n: number): number => {",
	"\tconst inner = (m: number) => m + 1;",
	"\treturn inner(n) + 2;",
	"};",
	"class K {",
	"\tgo(a: number) {",
	"\t\treturn a + 1;",
	"\t}",
	"}",
	"export const top = 1 + 1;",
].join("\n");

function targetFor(partial: Partial<FuzzMutantTarget>): FuzzMutantTarget {
	return {
		file: "fixture.ts",
		absPath: "/nonexistent/fixture.ts",
		qualifiedName: "lt",
		symbolId: "s",
		mutantId: "m",
		mutator: "EqualityOperator",
		originalLexeme: "a < b",
		replacement: "a <= b",
		ordinalWithinSymbol: 0,
		...partial,
	};
}

describe("differential-fuzz-locate — positive (must fire)", () => {
	it("P1: lexemeCandidates returns every node whose text equals the lexeme, once per offset", () => {
		const ts = requireTs();
		const sf = parseSource(ts, "fixture.ts", SOURCE);
		const offsets = lexemeCandidates(sf, SOURCE, "+");
		// m + 1, inner(n) + 2, a + 1 (class method), 1 + 1
		expect(offsets.length).toBe(4);
		expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
	});

	it("P2: locateMutantOffset trusts an explicit startOffset when the lexeme is there", () => {
		const ts = requireTs();
		const offset = SOURCE.indexOf("a < b");
		const res = locateMutantOffset(ts, targetFor({ startOffset: offset }), SOURCE);
		expect(res).toEqual({ ok: true, offset });
	});

	it("P3: locateMutantOffset re-derives the offset from qualifiedName + ordinal when none is given", () => {
		const ts = requireTs();
		const res = locateMutantOffset(ts, targetFor({}), SOURCE);
		expect(res).toEqual({ ok: true, offset: SOURCE.indexOf("a < b") });
	});

	it("P4: findExportedFunction resolves an `export function` declaration", () => {
		const ts = requireTs();
		const sf = parseSource(ts, "fixture.ts", SOURCE);
		const res = findExportedFunction(ts, sf, SOURCE.indexOf("a < b"));
		expect(res.ok && [res.localName, res.exportName]).toEqual(["lt", "lt"]);
	});

	it("P5: findExportedFunction follows `export { local as alias }`", () => {
		const ts = requireTs();
		const sf = parseSource(ts, "fixture.ts", SOURCE);
		const res = findExportedFunction(ts, sf, SOURCE.indexOf("x < 3"));
		expect(res.ok && [res.localName, res.exportName]).toEqual(["hidden", "shown"]);
	});

	it("P5b: a non-exported top-level function declaration resolves to the synthetic export", () => {
		const ts = requireTs();
		const src = "function priv(a: number) { return a + 1; }\nexport const x = 1;";
		const res = findExportedFunction(ts, parseSource(ts, "f.ts", src), src.indexOf("a + 1"));
		expect(res.ok && [res.localName, res.exportName, res.exported]).toEqual(["priv", FUZZ_TARGET_EXPORT, false]);
	});

	it("P5c: a non-exported module-level arrow const resolves to the synthetic export", () => {
		const ts = requireTs();
		const src = "const priv = (a: number): number => a + 1;\nexport const x = 1;";
		const res = findExportedFunction(ts, parseSource(ts, "f.ts", src), src.indexOf("a + 1"));
		expect(res.ok && [res.localName, res.exportName, res.exported]).toEqual(["priv", FUZZ_TARGET_EXPORT, false]);
	});

	it("P5d: the synthetic export suffix re-exports the local under the reserved name", () => {
		expect(syntheticExportSuffix("priv")).toBe(`\nexport { priv as ${FUZZ_TARGET_EXPORT} };\n`);
	});

	it("P6: a mutant inside a nested closure resolves to the outermost exported function", () => {
		const ts = requireTs();
		const sf = parseSource(ts, "fixture.ts", SOURCE);
		const res = findExportedFunction(ts, sf, SOURCE.indexOf("m + 1"));
		expect(res.ok && res.exportName).toBe("arrow");
	});

	it("P7: applyMutant swaps exactly the lexeme span", () => {
		const offset = SOURCE.indexOf("a < b");
		const out = applyMutant(SOURCE, offset, "a < b", "a <= b");
		expect(out).toContain("return a <= b;");
		expect(out.length).toBe(SOURCE.length + 1);
	});
});

describe("differential-fuzz-locate — re-location after a body edit — positive (must fire)", () => {
	const symbolHashOf = (content: string, qn: string): string => {
		const entry = [...(computeSymbolHashes("fixture.ts", content)?.values() ?? [])].find((e) => e.qualifiedName === qn);
		if (entry === undefined) throw new Error(`${qn} not hashed`);
		return entry.symbolHash;
	};

	it("P9: a changed symbol hash AND a changed site count is refused as ambiguous, never ranked", () => {
		const ts = requireTs();
		const drifted = SOURCE.replace("\treturn a < b;", "\tconst probe = a < b;\n\tvoid probe;\n\treturn a < b;");
		const target = targetFor({ symbolHash: symbolHashOf(SOURCE, "lt"), measuredSites: 1 });
		expect(locateMutantOffset(ts, target, drifted)).toEqual({
			ok: false,
			reason: "ambiguous re-location: a < b now occurs 2 times in lt (was 1); re-measure the file",
		});
	});

	it("P10: a symbol that no longer exists is named instead of counted as candidate tokens", () => {
		const ts = requireTs();
		const renamed = SOURCE.replace("export function lt(", "export function lessThan(");
		const res = locateMutantOffset(ts, targetFor({ mutantId: "91a09824f621fd65" }), renamed);
		expect(res).toEqual({ ok: false, reason: "source drift: symbol lt not found (mutant 91a09824f621fd65)" });
	});

	it("P11: a shrunken site count is refused too (one occurrence of two was removed)", () => {
		const ts = requireTs();
		const two = SOURCE.replace("\treturn a < b;", "\tvoid (a < b);\n\treturn a < b;");
		const target = targetFor({ symbolHash: symbolHashOf(two, "lt"), measuredSites: 2, ordinalWithinSymbol: 1 });
		const res = locateMutantOffset(ts, target, SOURCE);
		expect(!res.ok && res.reason).toBe("ambiguous re-location: a < b now occurs 1 time in lt (was 2); re-measure the file");
	});
});

describe("differential-fuzz-locate — re-location after a body edit — negative (must not fire)", () => {
	const currentHash = (): string => {
		const entry = [...(computeSymbolHashes("fixture.ts", SOURCE)?.values() ?? [])].find((e) => e.qualifiedName === "lt");
		if (entry === undefined) throw new Error("lt not hashed");
		return entry.symbolHash;
	};

	it("N9: an unchanged symbol hash keeps the ordinal rule whatever the recorded count says", () => {
		const ts = requireTs();
		const res = locateMutantOffset(ts, targetFor({ symbolHash: currentHash(), measuredSites: 7 }), SOURCE);
		expect(res).toEqual({ ok: true, offset: SOURCE.indexOf("a < b") });
	});

	it("N10: a target without symbolHash / measuredSites (the fuzz engine's own targets) is re-located as before", () => {
		const ts = requireTs();
		const drifted = SOURCE.replace("\treturn a < b;", "\tconst probe = a < b;\n\tvoid probe;\n\treturn a < b;");
		const res = locateMutantOffset(ts, targetFor({}), drifted);
		expect(res).toEqual({ ok: true, offset: drifted.indexOf("a < b") });
	});

	it("N11: a changed hash with the SAME site count (an unrelated statement) still re-locates", () => {
		const ts = requireTs();
		const edited = SOURCE.replace("\treturn a < b;", "\tconst unrelated = a + b;\n\tvoid unrelated;\n\treturn a < b;");
		const target = targetFor({ symbolHash: currentHash(), measuredSites: 1 });
		expect(locateMutantOffset(ts, target, edited)).toEqual({ ok: true, offset: edited.indexOf("a < b") });
	});

	it("N12: a count of 0 is drift (no site), not ambiguity", () => {
		const ts = requireTs();
		const gone = SOURCE.replace("\treturn a < b;", "\treturn a <= b;");
		const res = locateMutantOffset(ts, targetFor({ symbolHash: currentHash(), measuredSites: 1 }), gone);
		expect(!res.ok && res.reason).toContain("no site among");
	});
});

describe("differential-fuzz-locate — negative (must not fire)", () => {
	it("N1: an explicit offset that no longer holds the lexeme is reported as source drift", () => {
		const ts = requireTs();
		const res = locateMutantOffset(ts, targetFor({ startOffset: 3 }), SOURCE);
		expect(res.ok).toBe(false);
		expect(!res.ok && res.reason).toContain("source drift");
	});

	it("N2: an ordinal that matches no candidate is source drift, not a silent first-match", () => {
		const ts = requireTs();
		const res = locateMutantOffset(ts, targetFor({ originalLexeme: "a > b", mutantId: "nope" }), SOURCE);
		expect(res.ok).toBe(false);
	});

	it("N3: a non-exported function nested in a class is not a target", () => {
		const ts = requireTs();
		const src = "class Priv { go(a: number) { return a + 1; } }\nexport const x = 1;";
		const res = findExportedFunction(ts, parseSource(ts, "f.ts", src), src.indexOf("a + 1"));
		expect(!res.ok && res.reason).toContain("not inside a named top-level function");
	});

	it("N3b: a file that already uses the synthetic export name is not a target for a non-exported function", () => {
		const ts = requireTs();
		const src = `function priv(a: number) { return a + 1; }\nexport const ${FUZZ_TARGET_EXPORT} = 1;`;
		const res = findExportedFunction(ts, parseSource(ts, "f.ts", src), src.indexOf("a + 1"));
		expect(!res.ok && res.reason).toContain(FUZZ_TARGET_EXPORT);
	});

	it("N3c: an exported function is never given the synthetic export name", () => {
		const ts = requireTs();
		const sf = parseSource(ts, "fixture.ts", SOURCE);
		const res = findExportedFunction(ts, sf, SOURCE.indexOf("a < b"));
		expect(res.ok && [res.exported, res.exportName]).toEqual([true, "lt"]);
	});

	it("N4: a class method is not a target", () => {
		const ts = requireTs();
		const sf = parseSource(ts, "fixture.ts", SOURCE);
		const res = findExportedFunction(ts, sf, SOURCE.indexOf("a + 1"));
		expect(!res.ok && res.reason).toContain("ClassDeclaration");
	});

	it("N5: a module-level expression is not a target", () => {
		const ts = requireTs();
		const sf = parseSource(ts, "fixture.ts", SOURCE);
		const res = findExportedFunction(ts, sf, SOURCE.lastIndexOf("1 + 1"));
		expect(res.ok).toBe(false);
	});

	it("N6: a generator function is not a target", () => {
		const ts = requireTs();
		const src = "export function* gen(a: number) { yield a + 1; }";
		const res = findExportedFunction(ts, parseSource(ts, "f.ts", src), src.indexOf("a + 1"));
		expect(!res.ok && res.reason).toContain("generator");
	});
});
