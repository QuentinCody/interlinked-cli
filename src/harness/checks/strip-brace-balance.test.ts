// Invariant: stripForBraceScan must preserve STRUCTURAL brace balance.
//
// The cyclomatic-complexity walker (cyclomatic.ts) counts `{`/`}` on the
// *stripped* source to find each function's body. If stripping removes a brace
// from inside a string/template/regex/comment without removing its partner, the
// structural count goes unbalanced → walkBraceBody never closes → complexity is
// over-counted to EOF and CRAP (which squares complexity) explodes. This file
// pins the property so a stripper regression is caught at CI, not in a metric.
//
// Root-cause history: a multi-line template literal's continuation lines were
// blanked wholesale, deleting the `}` of `${…}` interpolation code without its
// `{` partner (e.g. clean.ts → 0% span, cyclomatic 41). See cyclomatic.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripForBraceScan } from "./shared-text-utils.js";

/** Net `{` minus `}` over a string. 0 ⇒ balanced. */
function braceDelta(s: string): number {
	let d = 0;
	for (const c of s) {
		if (c === "{") d++;
		else if (c === "}") d--;
	}
	return d;
}

describe("stripForBraceScan — preserves structural brace balance (targeted)", () => {
	it("multi-line template literal with an object-literal interpolation", () => {
		const src = [
			"const x = `",
			"  ${ render({ a: 1, b: 2 }) }",
			"`;",
			"function after() { return 1; }",
		].join("\n");
		const out = stripForBraceScan(src);
		expect(braceDelta(out)).toBe(0);
		expect(out).toContain("function after()"); // structural code survives
	});

	it("nested template literals", () => {
		const src = [
			"const y = `a ${ inner(`b ${ deep({ k: 1 }) } c`) } d`;",
			"function z() { return 2; }",
		].join("\n");
		const out = stripForBraceScan(src);
		expect(braceDelta(out)).toBe(0);
		expect(out).toContain("function z() { return 2; }");
	});

	it("braces inside ordinary strings are removed on both sides", () => {
		const src = `const s = "a { b } c"; const t = '} {'; function w() { if (s) { return t; } }`;
		const out = stripForBraceScan(src);
		expect(braceDelta(out)).toBe(0);
		expect(out).toContain("function w() { if (s) { return t; } }");
		expect(out).not.toContain("a { b } c");
	});

	it("regex literals containing braces do not unbalance", () => {
		const src = "const re = /[{}]/g; const re2 = /\\{/; function f() { return re.test('x'); }";
		const out = stripForBraceScan(src);
		expect(braceDelta(out)).toBe(0);
		expect(out).toContain("function f() { return re.test(");
		expect(out).not.toContain("[{}]");
	});

	it("block comment containing braces does not unbalance", () => {
		const src = "/* } { } unbalanced-in-comment } */ function g() { return 1; }";
		expect(braceDelta(stripForBraceScan(src))).toBe(0);
	});

	it("reproduces the original cleanCommand shape (multi-line template arg)", () => {
		const src = [
			"function cmd() {",
			"  output(mode, {",
			"    normal: () => `",
			"      ${ rows.map((r) => {",
			"        return `${r.name}`;",
			"      }).join('') }",
			"    `,",
			"  });",
			"}",
		].join("\n");
		const out = stripForBraceScan(src);
		expect(braceDelta(out)).toBe(0);
		expect(out).toContain("function cmd() {");
		expect(out).toContain("output(mode, {");
	});
});

// The strong guard: EVERY hand-written source file must strip to balanced
// braces. Valid TS has balanced structural braces, so any imbalance in the
// stripped output is a stripper defect. Pure string ops over ~600 files — fast.
describe("stripForBraceScan — corpus invariant", () => {
	// Defensive skip for transient test fixtures. The overlay / multi-edit
	// integration tests write their fixtures into a UNIQUE per-process
	// `mkdtempSync` dir under src/lib/ whose name starts with `_` and contains
	// `fixture(s)` (e.g. `src/lib/_diff_overlay_fixtures-AbC123/`), plus the
	// biome overlay drops `*.overlay-<pid>-<ts>.ts` temp files there. Those
	// dirs/files are created and torn down mid-run; under `--file-parallelism`
	// this corpus walk can observe one while it's half-written. Skipping any
	// `_*fixture*` entry (file OR dir) and any `*.overlay-*` temp file keeps the
	// walk from flaking on a partial (possibly brace-unbalanced) snapshot.
	// Hand-written modules never combine a leading `_` with `fixture`, so
	// legitimate source (`config.ts`, `_internal.ts`, …) is untouched.
	function isTransientFixtureName(entry: string): boolean {
		return (entry.startsWith("_") && entry.includes("fixture")) || entry.includes(".overlay-");
	}

	function collectTsFiles(dir: string, out: string[]): void {
		for (const entry of readdirSync(dir)) {
			const p = join(dir, entry);
			const st = statSync(p);
			if (st.isDirectory()) {
				if (
					entry === "__tests__" ||
					entry === "__fixtures__" ||
					entry === "node_modules" ||
					isTransientFixtureName(entry)
				) {
					continue;
				}
				collectTsFiles(p, out);
			} else if (
				entry.endsWith(".ts") &&
				!entry.endsWith(".d.ts") &&
				!entry.endsWith(".test.ts") &&
				!isTransientFixtureName(entry)
			) {
				out.push(p);
			}
		}
	}

	it("every hand-written src/**/*.ts strips to balanced braces", () => {
		const files: string[] = [];
		collectTsFiles(join(process.cwd(), "src"), files);
		expect(files).toContain(join(process.cwd(), "src/harness/checks/shared-text-utils.ts"));
		const offenders: string[] = [];
		for (const f of files) {
			const delta = braceDelta(stripForBraceScan(readFileSync(f, "utf-8")));
			if (delta !== 0) offenders.push(`${f.replace(`${process.cwd()}/`, "")} (Δ=${delta})`);
		}
		expect(offenders, `stripper left braces unbalanced in:\n${offenders.join("\n")}`).toEqual([]);
	});
});
