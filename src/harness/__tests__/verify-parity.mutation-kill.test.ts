import { nonNull } from "../../lib/non-null.js";
// Mutation-hardening tests for src/harness/verify-parity.ts.
//
// verify-parity.test.ts pins the "obvious" shape of each exported function.
// This file closes the gap surfaced by a mutation-testing sweep (61
// survivors, fresh 2026-08-14 provenance; inventory + shadow-verify receipts
// at scratch/fleet-r3/receipts/src_harness_verify-parity.ts.jsonl): the
// module-scope regex constants' exact boundary behavior (SWITCH_DISC's
// whitespace/dotted-segment handling, DISC_TAIL's `$` anchor, IFACE_DECL and
// IMPL_EXTENDS's whitespace and comma-list parsing), the JS_TS_EXTS
// extension allowlist, isTest exclusion on both scan loops, lineOfOffset's
// offset-vs-full-content and newline-split behavior, self-referencing
// interface exclusion, the __tests__/-directory candidate paths (including
// the "directory itself exists" false-positive trap), and computeProjectLocRatio's
// exact boundary (`>` vs `>=`) at ratio === PROD_TEST_LOC_RATIO_LIMIT.
//
// Every fixture below was run against the REAL module (values pinned from
// that run) and confirmed to diverge against a shadow-mutated copy of its
// target survivor via scratch/fleet-r3/verify-parity-shadow-verify.mts
// (60/61) and a dedicated 500-trial differential fuzz for the one remaining
// equivalence candidate (scratch/fleet-r3/verify-parity-interfaces-length-fuzz.mts).
//
// Three mutants are genuinely equivalent (see the receipts file for the
// full argument + fuzz evidence for each): the `interfaces` array's empty
// initializer (ArrayDeclaration `[] -> ["Stryker was here"]`) and its
// early-return guard (`interfaces.length === 0` -> `false`) in
// scanProjectSingleImplInterfaces, and computeProjectLocRatio's SECOND
// `testLoc === 0` occurrence (the ternary at line 207 — disambiguated from
// its sibling site via the manifest's siteId/ordinalWithinSymbol against
// which of the two textually-identical occurrences the pre-existing suite
// already kills the `true`-replacement of). Documented, not tested, at the
// bottom of this file.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	computeProjectLocRatio,
	runVerifyParityChecks,
	scanFilesWithoutTest,
	scanProjectSingleImplInterfaces,
	scanProjectSwitchDiscriminants,
} from "../verify-parity.js";

// Matches the module-private FileContent shape structurally (not exported).
interface FC {
	file: string;
	content: string;
	lineCount: number;
	isTest: boolean;
}
function fc(file: string, content: string, isTest = false): FC {
	return { file, content, lineCount: content.split("\n").length, isTest };
}

describe("verify-parity mutation-kill: scanProjectSwitchDiscriminants — SWITCH_DISC regex boundaries", () => {
	it("matches switch(x.kind) with zero spaces after `switch` (kills switch\\s exact-one-space mutant)", () => {
		const r = scanProjectSwitchDiscriminants([fc("/a.ts", "switch(x.kind){}"), fc("/b.ts", "switch(x.kind){}")]);
		expect(r).toEqual([
			{
				check: "cross_file_switch_discriminant",
				severity: "warning",
				file: "/a.ts",
				message: "switches on `x.kind` (line 1) — also seen in 1 other file(s). Consider polymorphic dispatch.",
				affectedFiles: ["/b.ts"],
			},
			{
				check: "cross_file_switch_discriminant",
				severity: "warning",
				file: "/b.ts",
				message: "switches on `x.kind` (line 1) — also seen in 1 other file(s). Consider polymorphic dispatch.",
				affectedFiles: ["/a.ts"],
			},
		]);
	});

	it("matches switch( x.kind) with a space right after the paren (kills \\(\\S* mutant)", () => {
		const r = scanProjectSwitchDiscriminants([fc("/a.ts", "switch( x.kind){}"), fc("/b.ts", "switch( x.kind){}")]);
		expect(r.length).toBe(2);
		expect(r.map((x) => x.file).sort()).toEqual(["/a.ts", "/b.ts"]);
	});

	it("matches switch(x.kind ) with a space right before the close paren (kills trailing \\S* mutant)", () => {
		const r = scanProjectSwitchDiscriminants([fc("/a.ts", "switch(x.kind ){}"), fc("/b.ts", "switch(x.kind ){}")]);
		expect(r.length).toBe(2);
	});

	it("matches a two-segment dotted discriminant switch(x.y.kind) (kills the removed `+` quantifier mutant)", () => {
		const r = scanProjectSwitchDiscriminants([fc("/a.ts", "switch(x.y.kind){}"), fc("/b.ts", "switch(x.y.kind){}")]);
		expect(r.length).toBe(2);
	});

	it("does NOT flag a discriminant that merely CONTAINS `.kind` mid-word (kills DISC_TAIL's removed $ anchor)", () => {
		const r = scanProjectSwitchDiscriminants([
			fc("/a.ts", "switch(obj.kindly){}"),
			fc("/b.ts", "switch(obj.kindly){}"),
		]);
		expect(r).toEqual([]);
	});

	it("skips a switch declared only in a test file (kills isTest->false in the switch scan loop)", () => {
		const r = scanProjectSwitchDiscriminants([
			fc("/t.test.ts", "switch(x.kind){}", true),
			fc("/b.ts", "switch(x.kind){}", false),
		]);
		expect(r).toEqual([]);
	});

	it("reports the LINE the switch actually appears on, not line 1 (kills m.index??0 -> m.index&&0 and all three lineOfOffset body mutants)", () => {
		const r = scanProjectSwitchDiscriminants([
			fc("/a.ts", "// h1\n// h2\nswitch(x.kind){}\n// t1\n// t2\n"),
			fc("/b.ts", "switch(x.kind){}"),
		]);
		const forA = r.find((x) => x.file === "/a.ts");
		expect(forA).toEqual({
			check: "cross_file_switch_discriminant",
			severity: "warning",
			file: "/a.ts",
			message: "switches on `x.kind` (line 3) — also seen in 1 other file(s). Consider polymorphic dispatch.",
			affectedFiles: ["/b.ts"],
		});
	});
});

describe("verify-parity mutation-kill: scanProjectSingleImplInterfaces — IFACE_DECL / IMPL_EXTENDS regex boundaries", () => {
	it("matches `export  interface Shape` with two spaces before the keyword (kills export\\sinterface mutant)", () => {
		const r = scanProjectSingleImplInterfaces([
			fc("/shape.ts", "export  interface Shape { area(): number; }"),
			fc("/square.ts", "class Square implements Shape { area(){return 4;} }"),
		]);
		expect(r.length).toBe(1);
	});

	it("matches `export interface  Shape` with two spaces before the name (kills interface\\s mutant)", () => {
		const r = scanProjectSingleImplInterfaces([
			fc("/shape.ts", "export interface  Shape { area(): number; }"),
			fc("/square.ts", "class Square implements Shape { area(){return 4;} }"),
		]);
		expect(r.length).toBe(1);
	});

	it("matches `implements  Shape` with two spaces after the keyword (kills implements\\s mutant)", () => {
		const r = scanProjectSingleImplInterfaces([
			fc("/shape.ts", "export interface Shape { area(): number; }"),
			fc("/square.ts", "class Square implements  Shape { area(){return 4;} }"),
		]);
		expect(r.length).toBe(1);
	});

	it("splits a zero-space comma list `A,B` and registers both names (kills the 0-before/0-after comma-group mutants)", () => {
		const r = scanProjectSingleImplInterfaces([
			fc("/a.ts", "export interface A {} export interface B {}"),
			fc("/x.ts", "class X implements A,B {}"),
		]);
		expect(r.map((x) => x.message).sort()).toEqual([
			"Interface `A` (line 1) has exactly one implementor: x.ts. Premature abstraction?",
			"Interface `B` (line 1) has exactly one implementor: x.ts. Premature abstraction?",
		]);
	});

	it("splits `A, B` (space only after comma) and registers both names (kills the 0-before/1-after comma-group mutants)", () => {
		const r = scanProjectSingleImplInterfaces([
			fc("/a.ts", "export interface A {} export interface B {}"),
			fc("/x.ts", "class X implements A, B {}"),
		]);
		expect(r.length).toBe(2);
		expect(r.map((x) => x.file)).toEqual(["/a.ts", "/a.ts"]);
	});

	it("splits `A , B` (space before AND after comma) and registers both names (kills the \\S*-before-comma mutant)", () => {
		const r = scanProjectSingleImplInterfaces([
			fc("/a.ts", "export interface A {} export interface B {}"),
			fc("/x.ts", "class X implements A , B {}"),
		]);
		expect(r.length).toBe(2);
	});

	it("registers the FULL second name `Bar`, not a truncated/corrupted key (kills the repeated-group char-class mutants: negated first-char, negated/single/inverted rest-chars)", () => {
		const r = scanProjectSingleImplInterfaces([
			fc("/a.ts", "export interface A {} export interface Bar {}"),
			fc("/x.ts", "class X implements A, Bar {}"),
		]);
		expect(r).toEqual([
			{
				check: "single_implementation_interface",
				severity: "info",
				file: "/a.ts",
				message: "Interface `A` (line 1) has exactly one implementor: x.ts. Premature abstraction?",
				affectedFiles: ["/x.ts"],
			},
			{
				check: "single_implementation_interface",
				severity: "info",
				file: "/a.ts",
				message: "Interface `Bar` (line 1) has exactly one implementor: x.ts. Premature abstraction?",
				affectedFiles: ["/x.ts"],
			},
		]);
	});
});

describe("verify-parity mutation-kill: scanProjectSingleImplInterfaces — body logic", () => {
	it("ignores an interface declared only inside a test file (kills the first isTest->false, the IFACE_DECL scan loop)", () => {
		const r = scanProjectSingleImplInterfaces([
			fc("/t.test.ts", "export interface OnlyInTest {}", true),
			fc("/b.ts", "class X implements OnlyInTest { }", false),
		]);
		expect(r).toEqual([]);
	});

	it("ignores an implements clause declared only inside a test file (kills the second isTest->false, the IMPL_EXTENDS scan loop)", () => {
		const r = scanProjectSingleImplInterfaces([
			fc("/s.ts", "export interface OnlyReal {}", false),
			fc("/a.ts", "class A implements OnlyReal {}", false),
			fc("/t.test.ts", "class BInTest implements OnlyReal {}", true),
		]);
		expect(r).toEqual([
			{
				check: "single_implementation_interface",
				severity: "info",
				file: "/s.ts",
				message: "Interface `OnlyReal` (line 1) has exactly one implementor: a.ts. Premature abstraction?",
				affectedFiles: ["/a.ts"],
			},
		]);
	});

	it("reports the LINE the interface actually appears on, not line 1 (kills m.index??0 -> m.index&&0)", () => {
		const r = scanProjectSingleImplInterfaces([
			fc("/a.ts", "// h1\n// h2\nexport interface Shape { area(): number; }\n"),
			fc("/b.ts", "class Square implements Shape { area(){return 4;} }"),
		]);
		expect(r).toEqual([
			{
				check: "single_implementation_interface",
				severity: "info",
				file: "/a.ts",
				message: "Interface `Shape` (line 3) has exactly one implementor: b.ts. Premature abstraction?",
				affectedFiles: ["/b.ts"],
			},
		]);
	});

	it("does not throw and reports nothing for an interface with zero implementors (kills !impls -> false, which would crash on [...undefined])", () => {
		expect(() => scanProjectSingleImplInterfaces([fc("/f.ts", "export interface Lonely { x(): void; }")])).not.toThrow();
		expect(scanProjectSingleImplInterfaces([fc("/f.ts", "export interface Lonely { x(): void; }")])).toEqual([]);
	});

	it("excludes the interface's OWN declaring file from its implementor count (kills the self-exclusion filter removal AND the anonymous predicate-forced-true mutant)", () => {
		const r = scanProjectSingleImplInterfaces([
			fc(
				"/f.ts",
				"export interface Shape { area(): number; } class Self implements Shape { area(){return 1;} }",
			),
		]);
		// Self is the ONLY "implementor" and it lives in the SAME file as the
		// interface declaration, so after excluding the declaring file there
		// are zero OTHER implementors -> not single-implementation, no finding.
		expect(r).toEqual([]);
	});

	it("trims whitespace off each comma-split implementor name (kills the removed .trim() mutant)", () => {
		// "A, B" (no trim) would register the second name as " B" (leading
		// space) instead of "B", so interface B would show zero implementors.
		const r = scanProjectSingleImplInterfaces([
			fc("/a.ts", "export interface A {} export interface B {}"),
			fc("/x.ts", "class X implements A, B {}"),
		]);
		expect(r.some((x) => x.message.startsWith("Interface `B`"))).toBe(true);
	});

	it("emits the exact check id and severity fields (kills their StringLiteral->\"\" mutants)", () => {
		const r = scanProjectSingleImplInterfaces([
			fc("/shape.ts", "export interface Shape { area(): number; }"),
			fc("/square.ts", "class Square implements Shape { area(){return 4;} }"),
		]);
		expect(r).toEqual([
			{
				check: "single_implementation_interface",
				severity: "info",
				file: "/shape.ts",
				message: "Interface `Shape` (line 1) has exactly one implementor: square.ts. Premature abstraction?",
				affectedFiles: ["/square.ts"],
			},
		]);
	});
});

describe("verify-parity mutation-kill: computeProjectLocRatio", () => {
	it("returns null when there are zero prod AND zero test lines (regression pin for the null-return contract)", () => {
		expect(computeProjectLocRatio([])).toBe(null);
	});

	it("does NOT early-return null when only a test file exists (prodLoc=0, testLoc>0) — takes the real 0/testLoc branch (kills testLoc===0 -> true, which would force an unconditional null here)", () => {
		const r = computeProjectLocRatio([fc("/p.test.ts", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj", true)]);
		expect(r).toEqual({ prodLoc: 0, testLoc: 10, ratio: 0, exceeded: false, limit: 5 });
	});

	it("returns a finite ratio (not Infinity) when both prod and test lines are nonzero (kills testLoc===0 -> true forcing the Infinity branch unconditionally)", () => {
		const r = computeProjectLocRatio([
			fc("/p.ts", Array(50).fill("a").join("\n")),
			fc("/p.test.ts", Array(10).fill("a").join("\n"), true),
		]);
		expect(r).toEqual({ prodLoc: 50, testLoc: 10, ratio: 5, exceeded: false, limit: 5 });
	});

	it("does NOT flag exceeded at the exact boundary ratio === limit (kills the `>` -> `>=` boundary mutant)", () => {
		const r = computeProjectLocRatio([
			fc("/p.ts", Array(50).fill("a").join("\n")),
			fc("/p.test.ts", Array(10).fill("a").join("\n"), true),
		]);
		expect(r?.ratio).toBe(5);
		expect(r?.exceeded).toBe(false);
	});
});

describe("verify-parity mutation-kill: scanFilesWithoutTest — candidate path construction", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "verify-parity-fwt-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("finds a companion test under __tests__/<name>.test.ext (kills one of the two `__tests__` StringLiteral mutants)", () => {
		const prod = join(dir, "foo.ts");
		mkdirSync(join(dir, "__tests__"), { recursive: true });
		writeFileSync(join(dir, "__tests__", "foo.test.ts"), "it('x', () => {});");
		const r = scanFilesWithoutTest([fc(prod, "export const x = 1;")]);
		expect(r).toEqual([]);
	});

	it("finds a companion test under __tests__/<name>.spec.ext (kills the other `__tests__` StringLiteral mutant)", () => {
		const prod = join(dir, "foo.ts");
		mkdirSync(join(dir, "__tests__"), { recursive: true });
		writeFileSync(join(dir, "__tests__", "foo.spec.ts"), "it('x', () => {});");
		const r = scanFilesWithoutTest([fc(prod, "export const x = 1;")]);
		expect(r).toEqual([]);
	});

	it("finds a sibling <name>.spec.ext test (kills the `${base}.spec${ext}` -> `` mutant)", () => {
		const prod = join(dir, "foo.ts");
		writeFileSync(join(dir, "foo.spec.ts"), "it('x', () => {});");
		const r = scanFilesWithoutTest([fc(prod, "export const x = 1;")]);
		expect(r).toEqual([]);
	});

	it("finds a sibling <name>.test.ext test AND reports the exact expectedTest path when flagged elsewhere (kills the `${base}.test${ext}` -> `` mutant at both its textual occurrences: the candidate check and the returned expectedTest field)", () => {
		const withSibling = join(dir, "foo.ts");
		writeFileSync(join(dir, "foo.test.ts"), "it('x', () => {});");
		expect(scanFilesWithoutTest([fc(withSibling, "export const x = 1;")])).toEqual([]);

		const noTest = join(dir, "bar.ts");
		const flagged = scanFilesWithoutTest([fc(noTest, "export const x = 1;")]);
		expect(flagged).toEqual([{ file: noTest, expectedTest: join(dir, "bar.test.ts") }]);
	});

	it("does NOT treat an unrelated __tests__/ directory's mere existence as a match (kills both `${baseName}.test${ext}`/`${baseName}.spec${ext}` -> `` mutants, which collapse to the bare directory path)", () => {
		const prod = join(dir, "foo.ts");
		mkdirSync(join(dir, "__tests__"), { recursive: true });
		writeFileSync(join(dir, "__tests__", "bar.test.ts"), "it('unrelated', () => {});");
		const r = scanFilesWithoutTest([fc(prod, "export const x = 1;")]);
		expect(r).toEqual([{ file: prod, expectedTest: join(dir, "foo.test.ts") }]);
	});

	it("excludes a generated file even with zero test coverage (kills isGeneratedFile(content) -> false)", () => {
		const gen = join(dir, "gen.ts");
		const r = scanFilesWithoutTest([fc(gen, "// @generated\nexport const x = 1;\n")]);
		expect(r).toEqual([]);
	});
});

describe("verify-parity mutation-kill: safeReadAll — extension allowlist and line counting (via runVerifyParityChecks)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "verify-parity-ext-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("scans every extra JS/TS extension (.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts), not just .ts (kills all seven extension-emptying StringLiteral mutants)", () => {
		const files: Record<string, string> = {
			"a.tsx": "export const x=1;",
			"b.js": "export const x=1;",
			"c.jsx": "export const x=1;",
			"d.mjs": "export const x=1;",
			"e.cjs": "export const x=1;",
			"f.mts": "export const x=1;",
			"g.cts": "export const x=1;",
		};
		const paths = Object.keys(files).map((name) => {
			const p = join(dir, name);
			writeFileSync(p, nonNull(files[name]));
			return p;
		});
		const r = runVerifyParityChecks(paths);
		expect(r.filesWithoutTest.map((f) => f.file).sort()).toEqual([...paths].sort());
	});

	it("ignores a file whose extension is not JS/TS-like (kills !JS_TS_EXTS.has(ext) -> false)", () => {
		const p = join(dir, "notes.txt");
		writeFileSync(p, "hello world");
		const r = runVerifyParityChecks([p]);
		expect(r.projectLocRatio).toBe(null);
	});

	it("counts LINES, not characters, for a scanned file (kills the \"\\n\" -> \"\" split mutant)", () => {
		const p = join(dir, "multi.ts");
		writeFileSync(p, "a\nb\nc");
		const r = runVerifyParityChecks([p]);
		expect(r.projectLocRatio?.prodLoc).toBe(3);
	});
});

// ==========================================================================
// Equivalent mutant (documented, not tested)
// ==========================================================================
//
// `interfaces.length === 0` -> `false` (scanProjectSingleImplInterfaces's
// early-return guard, `if (interfaces.length === 0) return [];`) is a
// genuinely equivalent mutant: skipping the early return only skips building
// implsByName (a local Map with no side effects — no I/O, no throw for any
// string input) before an empty `for (const iface of interfaces)` loop that
// runs zero iterations either way. The return value is provably identical
// for every input. Confirmed empirically over 500 randomized FileContent[]
// fixtures with zero divergence
// (scratch/fleet-r3/verify-parity-interfaces-length-fuzz.mts).
//
// `const interfaces: IfaceInfo[] = [];` -> `... = ["Stryker was here"];`
// (the SAME function's ArrayDeclaration mutant) is equivalent for a related
// reason: the bogus prepended entry is a string, not an IfaceInfo, so its
// `.name` is `undefined`; implsByName never has an `undefined` key (its
// capture group is non-optional), so `if (!impls) continue;` always skips
// the bogus entry. Confirmed over a dedicated 500-trial fuzz using an
// unambiguous statement-level anchor — the bare "[]" token also matches
// `return []` (L124) and `results: ...[] = []` (L140), both already killed
// by the pre-existing suite and NOT part of this file's 61 survivors
// (scratch/fleet-r3/verify-parity-array-decl-fuzz.mts).
//
// computeProjectLocRatio's SECOND `testLoc === 0` occurrence (line 207's
// ternary: `testLoc === 0 ? Number.POSITIVE_INFINITY : prodLoc / testLoc`)
// forced to `false` is equivalent: JS division of a positive number by zero
// is `+Infinity` (IEEE754, spec-guaranteed), identical to
// `Number.POSITIVE_INFINITY`, for every prodLoc > 0; and for prodLoc === 0
// the FIRST `testLoc === 0` occurrence (line 206's `if (prodLoc === 0 &&
// testLoc === 0) return null;`, unaffected by this mutant) already
// intercepts the call before line 207 ever runs. Disambiguated from its
// sibling survivor (90109f44, the FIRST occurrence, real and killed by the
// "test-only" case above) via the manifest's siteId/ordinalWithinSymbol
// cross-referenced against which occurrence's `true`-replacement sibling
// the pre-existing suite already kills (scratch/fleet-r3/verify-parity-locratio-occ-check.mts).
//
// See scratch/fleet-r3/receipts/src_harness_verify-parity.ts.jsonl for the
// full classification record of all 61 survivors.
