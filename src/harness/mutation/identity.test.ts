import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	computeSymbolHashes,
	deriveIdentities,
	derivePortableIdentities,
	mutationIdentityAvailable,
	PORTABLE_IDENTITY_ALGORITHM,
} from "./identity.js";
import { PROTOCOL_V3_VERSION } from "./protocol-v3/types.js";
import type { MutantIdentity, RawMutant } from "./types.js";

const FILE = "src/example.ts";

interface RawSpec {
	needle: string;
	lexeme: string;
	replacement: string;
	mutator?: string;
}

/** Strict-safe positional access (the tsconfig's noUncheckedIndexedAccess is on). */
function nth<T>(arr: readonly T[], i: number): T {
	const v = arr[i];
	if (v === undefined) throw new Error(`expected element ${i}`);
	return v;
}

/** A RawMutant whose token starts at the first occurrence of `spec.needle`. */
function rawAt(content: string, spec: RawSpec): RawMutant {
	const idx = content.indexOf(spec.needle);
	if (idx < 0) throw new Error(`needle not found: ${spec.needle}`);
	return {
		file: FILE,
		mutator: spec.mutator ?? "RelationalOperator",
		originalLexeme: spec.lexeme,
		replacement: spec.replacement,
		startOffset: idx,
	};
}

/** Derive identities for `specs` against `content`, asserting the dep is present. */
function derive(content: string, specs: RawSpec[]): MutantIdentity[] {
	const ids = deriveIdentities(
		FILE,
		content,
		specs.map((s) => rawAt(content, s)),
	);
	if (!ids) throw new Error("typescript unavailable — identity derivation returned null");
	return ids;
}

describe("mutationIdentityAvailable", () => {
	it("is true when the optional typescript dep is present", () => {
		expect(mutationIdentityAvailable()).toBe(true);
	});
});

describe("deriveIdentities", () => {
	const SRC_A = `function bar(x: number): boolean {\n  return x > 0 && x < 10;\n}\n`;
	const GT: RawSpec = { needle: "> 0", lexeme: ">", replacement: ">=" };

	it("is deterministic", () => {
		expect(derive(SRC_A, [GT])).toEqual(derive(SRC_A, [GT]));
	});

	it("anchors identity to the enclosing symbol, not the line — invariant under edits above", () => {
		const SRC_B = `function unrelated(): void {\n  // padding that shifts every offset below\n  return;\n}\n\n${SRC_A}`;
		expect(SRC_B.indexOf("> 0")).not.toBe(SRC_A.indexOf("> 0")); // the raw offset really did move

		const idA = nth(derive(SRC_A, [GT]), 0);
		const idB = nth(derive(SRC_B, [GT]), 0);
		expect(idB.symbolId).toBe(idA.symbolId);
		expect(idB.siteId).toBe(idA.siteId);
		expect(idB.mutantId).toBe(idA.mutantId);
		expect(idB.qualifiedName).toBe("bar");
	});

	it("distinguishes site (lexeme) from mutant (replacement)", () => {
		const ids = derive(SRC_A, [
			GT,
			{ needle: "< 10", lexeme: "<", replacement: "<=" },
			{ needle: "> 0", lexeme: ">", replacement: "<" }, // same token as GT, different replacement
		]);
		const gt = nth(ids, 0);
		const lt = nth(ids, 1);
		const gt2 = nth(ids, 2);
		expect(lt.siteId).not.toBe(gt.siteId); // different lexeme → different site
		expect(gt2.siteId).toBe(gt.siteId); // same token offset → same site
		expect(gt2.mutantId).not.toBe(gt.mutantId); // different replacement → different mutant
	});

	it("ranks identical operators by source order and keeps it stable under shift", () => {
		const TWO = `function twogt(a: number, b: number, c: number): boolean {\n  return a > b && b > c;\n}\n`;
		const first: RawSpec = { needle: "> b", lexeme: ">", replacement: ">=" };
		const second: RawSpec = { needle: "> c", lexeme: ">", replacement: ">=" };
		const ids = derive(TWO, [first, second]);
		const f = nth(ids, 0);
		const s = nth(ids, 1);
		expect(f.ordinalWithinSymbol).toBe(0);
		expect(s.ordinalWithinSymbol).toBe(1);
		expect(f.siteId).not.toBe(s.siteId);

		const SHIFTED = `// leading comment\n\n${TWO}`;
		const shifted = derive(SHIFTED, [first, second]);
		expect(nth(shifted, 0).siteId).toBe(f.siteId);
		expect(nth(shifted, 1).siteId).toBe(s.siteId);
	});
});

describe("derivePortableIdentities", () => {
	const SOURCE = "function compare(x: number): boolean { return x > 0 && x > -1; }";
	const raws = [
		rawAt(SOURCE, { needle: "> 0", lexeme: ">", replacement: ">=" }),
		rawAt(SOURCE, { needle: "> -1", lexeme: ">", replacement: "<=" }),
	];

	it("uses a versioned full-SHA256 identity at every wire level", () => {
		expect(PORTABLE_IDENTITY_ALGORITHM).toBe("interlinked-site-v2");
		const ids = derivePortableIdentities(FILE, SOURCE, raws);
		expect(ids).not.toBeNull();
		for (const identity of ids ?? []) {
			expect(identity.symbolId).toMatch(/^[0-9a-f]{64}$/);
			expect(identity.siteId).toMatch(/^[0-9a-f]{64}$/);
			expect(identity.mutantId).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it("matches the pinned cross-runtime v2 identity vector", () => {
		const vectorPath = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../../protocol/mutation-v3/fixtures/identity-vectors.json",
		);
		// SAFETY: repo-committed cross-runtime contract fixture; every consumed
		// field is asserted by the exact derivation comparison below.
		const fixture = JSON.parse(readFileSync(vectorPath, "utf8")) as {
			protocol_version: string;
			identity_algorithm: string;
			vectors: Array<{
				file: string;
				content: string;
				mutants: Array<{
					mutator: string;
					original_lexeme: string;
					replacement: string;
					start_offset: number;
					expected: {
						symbol_id: string;
						site_id: string;
						mutant_id: string;
						qualified_name: string;
						symbol_context: string;
						ordinal_within_symbol: number;
					};
				}>;
			}>;
		};
		expect(fixture.protocol_version).toBe(PROTOCOL_V3_VERSION);
		expect(fixture.identity_algorithm).toBe(PORTABLE_IDENTITY_ALGORITHM);
		for (const vector of fixture.vectors) {
			const identities = derivePortableIdentities(
				vector.file,
				vector.content,
				vector.mutants.map((row) => ({
					file: vector.file,
					mutator: row.mutator,
					originalLexeme: row.original_lexeme,
					replacement: row.replacement,
					startOffset: row.start_offset,
				})),
			);
			expect(identities).toHaveLength(vector.mutants.length);
			for (let index = 0; index < vector.mutants.length; index++) {
				const actual = nth(identities ?? [], index);
				const expected = nth(vector.mutants, index).expected;
				expect({
					symbol_id: actual.symbolId,
					site_id: actual.siteId,
					mutant_id: actual.mutantId,
					qualified_name: actual.qualifiedName,
					symbol_context: actual.symbolContext,
					ordinal_within_symbol: actual.ordinalWithinSymbol,
				}).toEqual(expected);
			}
		}
	});

	it("keeps line-shift-invariant semantic identity without changing legacy v1 ids", () => {
		const shifted = `function unrelated(): void {}\n${SOURCE}`;
		const shiftedRaws = [
			rawAt(shifted, { needle: "> 0", lexeme: ">", replacement: ">=" }),
			rawAt(shifted, { needle: "> -1", lexeme: ">", replacement: "<=" }),
		];
		const base = derivePortableIdentities(FILE, SOURCE, raws);
		const after = derivePortableIdentities(FILE, shifted, shiftedRaws);
		expect(after).toEqual(base);
		const legacy = deriveIdentities(FILE, SOURCE, raws);
		expect(legacy?.every((identity) => identity.mutantId.length === 16)).toBe(true);
	});

	it("uses full intermediate identities rather than padding or trusting an engine id", () => {
		const ids = derivePortableIdentities(FILE, SOURCE, raws);
		expect(ids?.[0]?.mutantId).not.toBe(`${derive(SOURCE, [{ needle: "> 0", lexeme: ">", replacement: ">=" }])[0]?.mutantId}${"0".repeat(48)}`);
		expect(ids?.[0]?.ordinalWithinSymbol).toBe(0);
		expect(ids?.[1]?.ordinalWithinSymbol).toBe(1);
	});

	it("disambiguates anonymous sibling symbols with a stable structural context", () => {
		const source = "[1].map((x) => x > 0); [2].filter((x) => x > 0);";
		const firstOffset = source.indexOf("> 0");
		const secondOffset = source.indexOf("> 0", firstOffset + 1);
		const ids = derivePortableIdentities(FILE, source, [
			{ file: FILE, mutator: "EqualityOperator", originalLexeme: ">", replacement: ">=", startOffset: firstOffset },
			{ file: FILE, mutator: "EqualityOperator", originalLexeme: ">", replacement: ">=", startOffset: secondOffset },
		]);
		expect(ids?.[0]?.qualifiedName).toBe("(anonymous)");
		expect(ids?.[1]?.qualifiedName).toBe("(anonymous)");
		expect(ids?.[0]?.symbolContext).toBe("(anonymous)#anonymous-0");
		expect(ids?.[1]?.symbolContext).toBe("(anonymous)#anonymous-1");
		expect(ids?.[0]?.symbolId).not.toBe(ids?.[1]?.symbolId);
	});

	it("anchors an anonymous callback's ordinal to its enclosing NAMED function, not the whole file", () => {
		// Two named functions, each wrapping two anonymous callbacks. The
		// ordinal walk must stop at the nearest named-function boundary
		// (`outer`) rather than counting from the source-file root — if the
		// boundary search never found `outer` (the loop fell through without
		// ever setting `boundary`), the walk would start from the file root,
		// where the FIRST thing it meets descending into `outer` is `outer`
		// itself: a NAMED function, which prunes the walk before it ever
		// reaches either callback, and the ordinal would stay at its default
		// (0) instead of counting up to the second callback's real position.
		const source =
			"function outer() { const a = [1].map((x) => x > 0); const b = [2].map((x) => x > 1); return [a, b]; }";
		const secondOffset = source.indexOf("> 1");
		const ids = derivePortableIdentities(FILE, source, [
			{ file: FILE, mutator: "EqualityOperator", originalLexeme: ">", replacement: ">=", startOffset: secondOffset },
		]);
		expect(ids?.[0]?.qualifiedName).toBe("outer.(anonymous)");
		expect(ids?.[0]?.symbolContext).toBe("outer.(anonymous)#anonymous-1");
	});

	it("uses an unambiguous tuple encoding even when provenance contains NUL", () => {
		const content = "const value = 1;";
		const ids = derivePortableIdentities(FILE, content, [
			{ file: FILE, mutator: "A\0B", originalLexeme: "C", replacement: "R", startOffset: 0 },
			{ file: FILE, mutator: "A", originalLexeme: "B\0C", replacement: "R", startOffset: 0 },
		]);
		expect(ids?.[0]?.siteId).not.toBe(ids?.[1]?.siteId);
		expect(ids?.[0]?.mutantId).not.toBe(ids?.[1]?.mutantId);
	});
});

describe("computeSymbolHashes", () => {
	function onlyEntry(content: string): { qualifiedName: string; symbolHash: string } {
		const map = computeSymbolHashes(FILE, content);
		if (!map) throw new Error("typescript unavailable");
		return nth([...map.values()], 0);
	}

	it("is stable under reformatting (operator spacing + comments)", () => {
		const tight = onlyEntry(`function bar(x: number){return x>0;}`);
		const loose = onlyEntry(`function bar(x: number) {\n  // a comment\n  return x > 0;\n}`);
		expect(tight.qualifiedName).toBe("bar");
		expect(loose.symbolHash).toBe(tight.symbolHash);
	});

	it("changes when the body's tokens change", () => {
		expect(onlyEntry(`function bar(x: number){return x<0;}`).symbolHash).not.toBe(
			onlyEntry(`function bar(x: number){return x>0;}`).symbolHash,
		);
	});
});

describe("source-kind and naming coverage", () => {
	const GT: RawSpec = { needle: "> 0", lexeme: ">", replacement: ">=" };

	it("parses tsx / jsx / js script kinds", () => {
		for (const ext of ["tsx", "jsx", "js"]) {
			const file = `src/x.${ext}`;
			const src = `function bar(x){ return x > 0; }`;
			const ids = deriveIdentities(file, src, [
				{ file, mutator: "Op", originalLexeme: ">", replacement: ">=", startOffset: src.indexOf("> 0") },
			]);
			expect(ids?.length).toBe(1);
		}
	});

	it("derives qualified names across function forms", () => {
		const cases: Array<[string, string]> = [
			["class C { foo(x: number) { return x > 0; } }", "C.foo"],
			["const foo = (x: number) => x > 0;", "foo"],
			["const o = { foo: (x: number) => x > 0 };", "foo"],
			["[1].map(function (x: number) { return x > 0; });", "(anonymous)"],
		];
		for (const [src, expected] of cases) {
			expect(nth(derive(src, [GT]), 0).qualifiedName).toBe(expected);
		}
	});
});

// ---------------------------------------------------------------------------
// Phase D ratchet: 43 survivors of 143 in this module. Mutant IDENTITY is what
// lets a manifest compare two runs, so a wrong answer here does not look like a
// bug — it looks like a survivor appearing or vanishing on its own.
// ---------------------------------------------------------------------------

/** Same derivation, but for an arbitrary file path (script-kind depends on it). */
function deriveFor(file: string, content: string, spec: RawSpec): MutantIdentity[] {
	const idx = content.indexOf(spec.needle);
	if (idx < 0) throw new Error(`needle not found: ${spec.needle}`);
	const ids = deriveIdentities(file, content, [
		{
			file,
			mutator: spec.mutator ?? "RelationalOperator",
			originalLexeme: spec.lexeme,
			replacement: spec.replacement,
			startOffset: idx,
		},
	]);
	if (!ids) throw new Error("typescript unavailable");
	return ids;
}

describe("script kind — every extension the parser must accept", () => {
	const TSX = "const f = (x: number) => x > 0;\n";
	const JS = "const f = (x) => x > 0;\n";

	it("parses a .tsx file", () => {
		expect(deriveFor("src/a.tsx", TSX, { needle: "> 0", lexeme: ">", replacement: ">=" })).toHaveLength(1);
	});

	it("parses a .jsx file", () => {
		expect(deriveFor("src/a.jsx", JS, { needle: "> 0", lexeme: ">", replacement: ">=" })).toHaveLength(1);
	});

	it("parses .js, .mjs and .cjs alike", () => {
		for (const f of ["src/a.js", "src/a.mjs", "src/a.cjs"]) {
			expect(deriveFor(f, JS, { needle: "> 0", lexeme: ">", replacement: ">=" })).toHaveLength(1);
		}
	});

	it("is case-insensitive about the extension", () => {
		expect(deriveFor("src/A.TSX", TSX, { needle: "> 0", lexeme: ">", replacement: ">=" })).toHaveLength(1);
	});

	it("falls back to TS for an unfamiliar extension", () => {
		expect(deriveFor("src/a.mts", TSX, { needle: "> 0", lexeme: ">", replacement: ">=" })).toHaveLength(1);
	});
});

describe("enclosing-function span — the boundary decides which symbol owns a mutant", () => {
	// `inner` occupies a known span; a mutant one byte outside it belongs to the
	// OUTER function, and attributing it wrongly moves a survivor between symbols
	// across runs for no reason the reader can see.
	const SRC = ["function outer() {", "\tconst a = 1;", "\tfunction inner() {", "\t\treturn 2;", "\t}", "\treturn a;", "}", ""].join("\n");

	it("attributes a mutant inside the inner function to the inner function", () => {
		const [id] = derive(SRC, [{ needle: "return 2", lexeme: "2", replacement: "3" }]);
		expect(id?.qualifiedName).toContain("inner");
	});

	it("attributes a mutant before the inner function to the outer one", () => {
		const [id] = derive(SRC, [{ needle: "const a = 1", lexeme: "1", replacement: "2" }]);
		expect(id?.qualifiedName).toContain("outer");
		expect(id?.qualifiedName).not.toContain("inner");
	});

	it("attributes a mutant AFTER the inner function's end to the outer one", () => {
		// The `offset >= node.getEnd()` half of the span test: an inclusive end
		// would swallow this one into `inner`.
		const [id] = derive(SRC, [{ needle: "return a", lexeme: "a", replacement: "1" }]);
		expect(id?.qualifiedName).toContain("outer");
		expect(id?.qualifiedName).not.toContain("inner");
	});

	it("gives a top-level mutant a stable identity with no enclosing function", () => {
		const top = "const q = 1 > 0;\n";
		const [id] = derive(top, [{ needle: "1 > 0", lexeme: ">", replacement: ">=" }]);
		expect(id?.symbolId).toBeTruthy();
	});
});

describe("identity keys are distinct where the inputs are", () => {
	const SRC = "function f(x: number) {\n\treturn x > 0 && x < 9;\n}\n";

	it("gives two different operators in one function different mutant ids", () => {
		const ids = derive(SRC, [
			{ needle: "> 0", lexeme: ">", replacement: ">=" },
			{ needle: "< 9", lexeme: "<", replacement: "<=" },
		]);
		expect(nth(ids, 0).mutantId).not.toBe(nth(ids, 1).mutantId);
	});

	it("gives the same site the same id across repeated derivations", () => {
		const a = derive(SRC, [{ needle: "> 0", lexeme: ">", replacement: ">=" }]);
		const b = derive(SRC, [{ needle: "> 0", lexeme: ">", replacement: ">=" }]);
		expect(nth(a, 0).mutantId).toBe(nth(b, 0).mutantId);
	});

	it("distinguishes mutants that differ only by replacement", () => {
		const ids = derive(SRC, [
			{ needle: "> 0", lexeme: ">", replacement: ">=" },
			{ needle: "> 0", lexeme: ">", replacement: "<" },
		]);
		expect(nth(ids, 0).mutantId).not.toBe(nth(ids, 1).mutantId);
	});

	it("distinguishes mutants that differ only by mutator", () => {
		const ids = derive(SRC, [
			{ needle: "> 0", lexeme: ">", replacement: ">=", mutator: "A" },
			{ needle: "> 0", lexeme: ">", replacement: ">=", mutator: "B" },
		]);
		expect(nth(ids, 0).mutantId).not.toBe(nth(ids, 1).mutantId);
	});
});

// ---------------------------------------------------------------------------
// Module scope is a symbol too (plan 16 §11.1). `resolveSite` has always
// anchored a top-level mutant to the pseudo-symbol "(module)", but
// `computeSymbolHashes` emitted no entry for it — and `applyMeasuredRun`
// rebuilds a file's record by iterating the hash map, so every module-scope
// mutant was silently discarded on persist (measured: codex-feature-flag.ts
// recorded 104 of the 117 mutants a live run reports).
// ---------------------------------------------------------------------------

describe("computeSymbolHashes — module scope is a first-class symbol", () => {
	const MODULE = "(module)";
	const WITH_TOP_LEVEL = `const LIMIT = 10;\n\nfunction over(x: number): boolean {\n\treturn x > LIMIT;\n}\n`;

	function hashes(content: string): Map<string, { qualifiedName: string; symbolHash: string }> {
		const map = computeSymbolHashes(FILE, content);
		if (!map) throw new Error("typescript unavailable");
		return map;
	}

	const moduleEntry = (content: string): { qualifiedName: string; symbolHash: string } | undefined =>
		[...hashes(content).values()].find((e) => e.qualifiedName === MODULE);

	const names = (content: string): string[] => [...hashes(content).values()].map((e) => e.qualifiedName).sort();

	it("P1: emits a (module) entry for a file with top-level statements", () => {
		expect(names(WITH_TOP_LEVEL)).toEqual([MODULE, "over"]);
	});

	it("P2: keys the (module) entry by the symbolId a top-level mutant anchors to", () => {
		// The crux: the hash map IS the symbol universe the manifest is rebuilt
		// from, so a key mismatch here drops the mutant rather than failing loudly.
		const [id] = derive(WITH_TOP_LEVEL, [{ needle: "10", lexeme: "10", replacement: "11", mutator: "Num" }]);
		expect(id?.qualifiedName).toBe(MODULE);
		expect(hashes(WITH_TOP_LEVEL).get(id?.symbolId ?? "")?.qualifiedName).toBe(MODULE);
	});

	it("P3: leaves the module hash alone when only a function BODY changes", () => {
		// Function bodies are hashed as their own symbols; counting them twice would
		// invalidate every module-scope survivor on an unrelated edit.
		expect(moduleEntry(WITH_TOP_LEVEL.replace("x > LIMIT", "x >= LIMIT"))?.symbolHash).toBe(
			moduleEntry(WITH_TOP_LEVEL)?.symbolHash,
		);
	});

	it("P4: changes the module hash when a top-level token changes", () => {
		expect(moduleEntry(WITH_TOP_LEVEL.replace("= 10", "= 11"))?.symbolHash).not.toBe(
			moduleEntry(WITH_TOP_LEVEL)?.symbolHash,
		);
	});

	it("P5: is stable under reformatting and comments outside the functions", () => {
		const reformatted = `// header\nconst   LIMIT  =  10 ;\n\n/** doc */\nfunction over( x : number ) : boolean {\n\treturn x > LIMIT;\n}\n`;
		expect(moduleEntry(reformatted)?.symbolHash).toBe(moduleEntry(WITH_TOP_LEVEL)?.symbolHash);
	});

	it("P6: covers a class-property initializer, which also anchors to (module)", () => {
		// `enclosingFunction` finds nothing for a property initializer, so its
		// mutants land on (module) exactly like a top-level const's do.
		const SRC = `class C {\n\treadonly n = 1 > 0;\n\tget flag(): boolean {\n\t\treturn this.n;\n\t}\n}\n`;
		const [id] = derive(SRC, [{ needle: "1 > 0", lexeme: ">", replacement: ">=" }]);
		expect(id?.qualifiedName).toBe(MODULE);
		expect(hashes(SRC).get(id?.symbolId ?? "")?.qualifiedName).toBe(MODULE);
	});

	it("N1: emits NO module entry when every top-level statement is a hashed function", () => {
		const only = `function a(): number {\n\treturn 1;\n}\n\nexport function b(): number {\n\treturn 2;\n}\n`;
		expect(names(only)).toEqual(["a", "b"]);
	});

	it("N2: emits nothing at all for an empty or comment-only file", () => {
		expect(hashes("").size).toBe(0);
		expect(hashes("// nothing here\n/* nor here */\n").size).toBe(0);
	});

	it("P7: covers a top-level statement SANDWICHED between two functions", () => {
		// The multi-segment splice: module scope is the file minus each hashed
		// function span, so a statement between two of them must still be seen.
		const between = (init: string): string =>
			`function a(): void {}\nconst mid = ${init};\nfunction b(): void {}\n`;
		expect(names(between("1"))).toEqual([MODULE, "a", "b"]);
		expect(moduleEntry(between("2"))?.symbolHash).not.toBe(moduleEntry(between("1"))?.symbolHash);
	});
});

describe("symbol hashes track the body, not the surroundings", () => {
	const A = "function f(x: number) {\n\treturn x > 0;\n}\n";
	const B = "function f(x: number) {\n\treturn x >= 0;\n}\n";

	const hashOf = (content: string): string | undefined => {
		const entries = computeSymbolHashes(FILE, content);
		if (!entries) return undefined;
		return [...entries.values()][0]?.symbolHash;
	};

	it("changes when the body changes", () => {
		expect(hashOf(A)).not.toBe(hashOf(B));
	});

	it("is stable across re-computation of identical content", () => {
		expect(hashOf(A)).toBe(hashOf(A));
	});

	it("is unaffected by a comment added outside the function", () => {
		expect(hashOf(`// unrelated\n${A}`)).toBe(hashOf(A));
	});
});
