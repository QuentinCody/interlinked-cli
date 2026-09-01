// Tests for project-graph/parser-exports.ts.
//
// This is the exact-stem companion the per-edit mutation runner scopes to
// (project-graph.test.ts also exercises parseExports via ProjectGraph.getExports,
// but is invisible to that runner — see docs/plans/16-monotonic-quality-enforcement.md
// item 18). Every branch of parseExports/commentSkipVerdict/matchReExportOrStar/
// matchExportDeclaration/processExportStatement is exercised directly here, with
// exact-value assertions (not just "returns an array") so mutations that swap a
// kind string, flip an isTypeOnly flag, or drop a name are caught.

import { describe, expect, it } from "vitest";
import { parseExports } from "./parser-exports.js";

describe("parseExports — basic dispatch", () => {
	it("exports a function", () => {
		expect(typeof parseExports).toBe("function");
	});

	it("returns an empty array for empty input", () => {
		expect(parseExports("")).toEqual([]);
	});

	it("extracts a named function export with line number and kind", () => {
		const code = ["// header", "export function foo() {}", ""].join("\n");
		const out = parseExports(code);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ name: "foo", kind: "function", line: 2, isTypeOnly: false });
	});

	it("marks interface/type exports as type-only", () => {
		const out = parseExports(
			["export interface User { id: string }", "export type Id = string"].join("\n"),
		);
		const names = out.map((e) => ({ name: e.name, isTypeOnly: e.isTypeOnly }));
		expect(names).toEqual([
			{ name: "User", isTypeOnly: true },
			{ name: "Id", isTypeOnly: true },
		]);
	});

	it("ignores a line that does not start with export, without false-matching later exports", () => {
		const out = parseExports(["const notExported = 1;", "export const yes = 2;"].join("\n"));
		expect(out).toEqual([{ name: "yes", kind: "const", isTypeOnly: false, line: 2 }]);
	});

	it("assigns 1-based line numbers across multiple exports", () => {
		const out = parseExports(
			["", "export function a() {}", "export function b() {}"].join("\n"),
		);
		expect(out.map((e) => [e.name, e.line])).toEqual([
			["a", 2],
			["b", 3],
		]);
	});

	it("trims leading/trailing whitespace before matching", () => {
		const out = parseExports("   export const indented = 1   ");
		expect(out).toEqual([{ name: "indented", kind: "const", isTypeOnly: false, line: 1 }]);
	});

	it("ignores an export-prefixed line that matches no known form (no crash, no export)", () => {
		expect(parseExports("export somethingUnrecognized();")).toEqual([]);
	});

	it("does not fall back to a declaration match once a re-export form has matched", () => {
		// A regression here (reExport treated as falsy) would make matchExportDeclaration
		// run on "{ foo }" instead, which matches nothing — output would drop to [].
		expect(parseExports("export { foo }")).toEqual([
			{ name: "foo", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});
});

describe("parseExports — comment skipping", () => {
	it("hides an export-looking line inside a block comment", () => {
		const code = [
			"/* comment starts here",
			"export const hidden = 1",
			"*/",
			"export const visible = 2",
		].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "visible", kind: "const", isTypeOnly: false, line: 4 },
		]);
	});

	it("closes a block comment that opens and closes on the same line", () => {
		const code = ["/* short */", "export const after = 1"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "after", kind: "const", isTypeOnly: false, line: 2 },
		]);
	});

	it("skips a line comment without hiding or altering the next export", () => {
		const code = ["// this is a comment", "export const real = 2"].join("\n");
		expect(parseExports(code)).toEqual([{ name: "real", kind: "const", isTypeOnly: false, line: 2 }]);
	});

	it("drops a line-comment inside a multiline export buffer instead of splicing it in", () => {
		// A line comment mid-accumulation must be skipped by the comment check BEFORE
		// the exportBuffer append runs, or its text would get folded into a name.
		const code = ["export {", "  foo,", "  // trailing note", "  bar", "}"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "foo", kind: "const", isTypeOnly: false, line: 1 },
			{ name: "bar", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("does not extend a block-comment early when an inner line lacks a closing */", () => {
		// The in-block branch's nextInBlock must track whether the line closes the
		// comment (found "*/"), not the other way around. Two lines are needed inside
		// the comment: the first proves skip still fires either way, the second only
		// stays hidden if the "still in block" state carried forward correctly.
		const code = [
			"/* start",
			"export const stillHidden = 1",
			"export const alsoHidden = 2",
			"*/",
			"export const visible = 3",
		].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "visible", kind: "const", isTypeOnly: false, line: 5 },
		]);
	});

	it("drops a block comment (opened and closed inline) inside a multiline export buffer", () => {
		// Mirrors the line-comment case above, but for a "/* ... */" that opens and
		// closes on one line mid-accumulation — it must be dropped by the comment
		// check before the exportBuffer append, not spliced into a name.
		const code = ["export {", "  foo,", "  /* note */", "  bar", "}"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "foo", kind: "const", isTypeOnly: false, line: 1 },
			{ name: "bar", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("resets the multiline buffer after closing, so the next line is not swallowed", () => {
		// If exportBuffer were left non-empty after a completed multiline block, the
		// following independent export line would be misread as a buffer continuation
		// (appended, never re-dispatched) and silently disappear from the output.
		const code = ["export {", "  foo", "}", "export const after = 1;"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "foo", kind: "const", isTypeOnly: false, line: 1 },
			{ name: "after", kind: "const", isTypeOnly: false, line: 4 },
		]);
	});
});

describe("parseExports — single-line declaration forms", () => {
	it("export default class <Name>", () => {
		expect(parseExports("export default class Foo {}")).toEqual([
			{ name: "default", kind: "default", isTypeOnly: false, line: 1 },
			{ name: "Foo", kind: "class", isTypeOnly: false, line: 1 },
		]);
	});

	it("export default class (unnamed) — no second entry", () => {
		expect(parseExports("export default class {}")).toEqual([
			{ name: "default", kind: "default", isTypeOnly: false, line: 1 },
		]);
	});

	it("export default function <name>", () => {
		expect(parseExports("export default function foo() {}")).toEqual([
			{ name: "default", kind: "default", isTypeOnly: false, line: 1 },
			{ name: "foo", kind: "function", isTypeOnly: false, line: 1 },
		]);
	});

	it("export default function (unnamed) — no second entry", () => {
		expect(parseExports("export default function () {}")).toEqual([
			{ name: "default", kind: "default", isTypeOnly: false, line: 1 },
		]);
	});

	it("export default <expression>", () => {
		expect(parseExports("export default 42;")).toEqual([
			{ name: "default", kind: "default", isTypeOnly: false, line: 1 },
		]);
	});

	it("export async function", () => {
		expect(parseExports("export async function fetchData() {}")).toEqual([
			{ name: "fetchData", kind: "function", isTypeOnly: false, line: 1 },
		]);
	});

	it("export const / let / var", () => {
		expect(parseExports("export const x = 1;")).toEqual([
			{ name: "x", kind: "const", isTypeOnly: false, line: 1 },
		]);
		expect(parseExports("export let counter = 0;")).toEqual([
			{ name: "counter", kind: "let", isTypeOnly: false, line: 1 },
		]);
		expect(parseExports("export var legacy = 0;")).toEqual([
			{ name: "legacy", kind: "var", isTypeOnly: false, line: 1 },
		]);
	});

	it("export class", () => {
		expect(parseExports("export class Widget {}")).toEqual([
			{ name: "Widget", kind: "class", isTypeOnly: false, line: 1 },
		]);
	});

	it("export interface", () => {
		expect(parseExports("export interface User { id: string }")).toEqual([
			{ name: "User", kind: "interface", isTypeOnly: true, line: 1 },
		]);
	});

	it("export type alias with = and with <T>", () => {
		expect(parseExports("export type Id = string")).toEqual([
			{ name: "Id", kind: "type", isTypeOnly: true, line: 1 },
		]);
		expect(parseExports("export type Box<T> = { value: T };")).toEqual([
			{ name: "Box", kind: "type", isTypeOnly: true, line: 1 },
		]);
	});

	it("export enum", () => {
		expect(parseExports("export enum Color { Red, Green }")).toEqual([
			{ name: "Color", kind: "enum", isTypeOnly: false, line: 1 },
		]);
	});

	it("export abstract class", () => {
		expect(parseExports("export abstract class Base {}")).toEqual([
			{ name: "Base", kind: "class", isTypeOnly: false, line: 1 },
		]);
	});
});

describe("parseExports — single-line re-export / star forms", () => {
	it("export type { A, B as C }", () => {
		expect(parseExports("export type { Foo, Bar as Baz }")).toEqual([
			{ name: "Foo", kind: "type", isTypeOnly: true, line: 1 },
			{ name: "Baz", kind: "type", isTypeOnly: true, line: 1 },
		]);
	});

	it("export { a, b as c } (local, no from -> const)", () => {
		expect(parseExports("export { foo, bar as baz }")).toEqual([
			{ name: "foo", kind: "const", isTypeOnly: false, line: 1 },
			{ name: "baz", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("export { a, b as c } from '...' (re-export)", () => {
		expect(parseExports("export { foo, bar as baz } from './mod'")).toEqual([
			{ name: "foo", kind: "re-export", isTypeOnly: false, line: 1 },
			{ name: "baz", kind: "re-export", isTypeOnly: false, line: 1 },
		]);
	});

	it("export * from '...' — plain star defaults name to '*'", () => {
		expect(parseExports("export * from './mod'")).toEqual([
			{ name: "*", kind: "namespace", isTypeOnly: false, line: 1 },
		]);
	});

	it("export * as ns from '...' — captures the alias", () => {
		expect(parseExports("export * as ns from './mod'")).toEqual([
			{ name: "ns", kind: "namespace", isTypeOnly: false, line: 1 },
		]);
	});

	it("filters an empty specifier produced by a trailing comma", () => {
		expect(parseExports("export { foo, }")).toEqual([
			{ name: "foo", kind: "const", isTypeOnly: false, line: 1 },
		]);
		expect(parseExports("export type { Foo, }")).toEqual([
			{ name: "Foo", kind: "type", isTypeOnly: true, line: 1 },
		]);
	});

	it("only strips a leading 'type ' keyword, not an embedded 'type' substring", () => {
		// The specifier text is "abc type Foo" — "type" is not at the start, so the
		// anchored /^type\s+/ strip must NOT fire. Proves the anchor is load-bearing.
		expect(parseExports("export { abc type Foo }")).toEqual([
			{ name: "abc type Foo", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("does not trim a specifier before splitting on 'as' — a leading space can itself combine with 'as'", () => {
		// The second specifier here is literally " as Bar" (the space after the comma).
		// If the per-item `.trim()` before `.split(/\s+as\s+/)` were dropped, that
		// leading space would combine with "as" to form a false delimiter match,
		// splitting it into just "Bar" instead of leaving "as Bar" intact.
		expect(parseExports("export type { Foo, as Bar }")).toEqual([
			{ name: "Foo", kind: "type", isTypeOnly: true, line: 1 },
			{ name: "as Bar", kind: "type", isTypeOnly: true, line: 1 },
		]);
	});

	it("a partial 'type ' prefix strip leaves a residual leading space that itself forms a false 'as' delimiter", () => {
		// The specifier text is "type  as Bar" (two spaces between "type" and "as").
		// If the per-specifier `.replace(/^type\s+/, "")` strip only consumed ONE
		// of the two spaces (e.g. a regex weakened to `\s` instead of `\s+`), the
		// residual leading space left in front of "as" would itself satisfy
		// `\s+as\s+` and wrongly split the name down to just "Bar" instead of the
		// correct "as Bar" (the strip must remove the WHOLE run of whitespace so
		// no leading space is left for the alias-split regex to latch onto).
		expect(parseExports("export { type  as Bar }")).toEqual([
			{ name: "as Bar", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});
});

describe("parseExports — multiline export { ... } accumulation", () => {
	it("accumulates a local named export across lines", () => {
		const code = ["export {", "  foo,", "  bar as baz", "}"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "foo", kind: "const", isTypeOnly: false, line: 1 },
			{ name: "baz", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("accumulates a re-export across lines when 'from' lands on the closing line", () => {
		const code = ["export {", "  foo,", "  bar", "} from './mod'"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "foo", kind: "re-export", isTypeOnly: false, line: 1 },
			{ name: "bar", kind: "re-export", isTypeOnly: false, line: 1 },
		]);
	});

	it("accumulates a type export across lines, stripping a per-specifier 'type ' prefix", () => {
		const code = ["export type {", "  type Foo as Bar,", "  baz", "}"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "Bar", kind: "type", isTypeOnly: true, line: 1 },
			{ name: "baz", kind: "type", isTypeOnly: true, line: 1 },
		]);
	});

	it("filters an empty specifier produced by a trailing comma across lines", () => {
		const code = ["export {", "  foo,", "}"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "foo", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("does not enter multiline mode for a plain export {} with no keyword — brace present, no 'type'", () => {
		// A plain "export {" opener (no "type") must still be recognised — the
		// "type" group in the open-detector is OPTIONAL, not mandatory.
		const code = ["export {", "content }"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "content", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("does not trim a specifier before splitting on 'as', across the multiline path too", () => {
		expect(parseExports(["export {", "  Foo,", "  as Bar", "}"].join("\n"))).toEqual([
			{ name: "Foo", kind: "const", isTypeOnly: false, line: 1 },
			{ name: "as Bar", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("only strips a leading 'type ' keyword on the accumulated buffer too (doubled whitespace, no alias)", () => {
		// Doubled whitespace after "type" distinguishes /^type\S+/ (which requires a
		// non-whitespace char right after "type" and so would fail to match at all
		// here) from the correct /^type\s+/.
		expect(parseExports(["export {", "  type  Foo", "}"].join("\n"))).toEqual([
			{ name: "Foo", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("doubled whitespace before the 'from' clause on the closing line still marks a re-export", () => {
		expect(parseExports(["export {", "  foo", "}  from  './mod'"].join("\n"))).toEqual([
			{ name: "foo", kind: "re-export", isTypeOnly: false, line: 1 },
		]);
	});

	it("a partial 'type ' prefix strip on the accumulated buffer leaves a residual space that forms a false 'as' delimiter", () => {
		// Mirrors the single-line case above, but through processExportStatement's
		// own copy of the same per-specifier `.replace(/^type\s+/, "")` strip. If
		// that strip left one of the two spaces between "type" and "as" behind, the
		// leftover leading space would itself satisfy `\s+as\s+` and wrongly split
		// the name down to "Bar" instead of the correct "as Bar".
		expect(parseExports(["export {", "  type  as Bar", "}"].join("\n"))).toEqual([
			{ name: "as Bar", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});
});

describe("parseExports — regex boundary precision (double-space inputs)", () => {
	// Real source rarely has double internal whitespace, but the parser's regexes
	// use `\s+` (one-or-more) throughout; these inputs distinguish `\s+` from a
	// narrower `\s` or `\S+` boundary, which single-space fixtures cannot.
	it("multiline export type { ... } open + content with doubled whitespace", () => {
		const code = ["export  type  {", "  Foo,", "  Bar", "}"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "Foo", kind: "type", isTypeOnly: true, line: 1 },
			{ name: "Bar", kind: "type", isTypeOnly: true, line: 1 },
		]);
	});

	it("single-line export type { ... } with doubled whitespace (own single-line matcher, not the multiline path)", () => {
		expect(parseExports("export  type  {  Foo  }")).toEqual([
			{ name: "Foo", kind: "type", isTypeOnly: true, line: 1 },
		]);
	});

	it("single-line export { ... } with doubled whitespace", () => {
		expect(parseExports("export  {  foo  }")).toEqual([
			{ name: "foo", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("export * with doubled whitespace", () => {
		expect(parseExports("export  *  from './m'")).toEqual([
			{ name: "*", kind: "namespace", isTypeOnly: false, line: 1 },
		]);
	});

	it("export * as ns with doubled whitespace", () => {
		expect(parseExports("export  *  as  nsname  from './m'")).toEqual([
			{ name: "nsname", kind: "namespace", isTypeOnly: false, line: 1 },
		]);
	});

	it("re-export 'from' clause with doubled whitespace", () => {
		expect(parseExports("export { foo }  from  './m'")).toEqual([
			{ name: "foo", kind: "re-export", isTypeOnly: false, line: 1 },
		]);
	});

	it("'as' alias with doubled whitespace", () => {
		expect(parseExports("export { foo  as  bazname }")).toEqual([
			{ name: "bazname", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("per-specifier 'type' prefix with doubled whitespace is a TYPE-ONLY export", () => {
		// `export { type Foo }` is TypeScript's inline type-only specifier —
		// classifying it as a value export made downstream dead-export analysis
		// misread type surfaces (fixed 2026-09-01).
		expect(parseExports("export { type  Foo }")).toEqual([
			{ name: "Foo", kind: "type", isTypeOnly: true, line: 1 },
		]);
	});

	it("enum with doubled whitespace", () => {
		expect(parseExports("export  enum  Foobar {}")).toEqual([
			{ name: "Foobar", kind: "enum", isTypeOnly: false, line: 1 },
		]);
	});

	it("abstract class with doubled whitespace", () => {
		expect(parseExports("export  abstract  class  Foobar {}")).toEqual([
			{ name: "Foobar", kind: "class", isTypeOnly: false, line: 1 },
		]);
	});

	it("default class with doubled whitespace", () => {
		expect(parseExports("export  default  class  Foobar {}")).toEqual([
			{ name: "default", kind: "default", isTypeOnly: false, line: 1 },
			{ name: "Foobar", kind: "class", isTypeOnly: false, line: 1 },
		]);
	});

	it("default expression with doubled whitespace", () => {
		expect(parseExports("export  default  1")).toEqual([
			{ name: "default", kind: "default", isTypeOnly: false, line: 1 },
		]);
	});

	it("async function with doubled whitespace", () => {
		expect(parseExports("export  async  function  foobar() {}")).toEqual([
			{ name: "foobar", kind: "function", isTypeOnly: false, line: 1 },
		]);
	});

	it("function with doubled whitespace", () => {
		expect(parseExports("export  function  foobar() {}")).toEqual([
			{ name: "foobar", kind: "function", isTypeOnly: false, line: 1 },
		]);
	});

	it("const with doubled whitespace", () => {
		expect(parseExports("export  const  foobar = 1")).toEqual([
			{ name: "foobar", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("class with doubled whitespace", () => {
		expect(parseExports("export  class  Foobar {}")).toEqual([
			{ name: "Foobar", kind: "class", isTypeOnly: false, line: 1 },
		]);
	});

	it("interface with doubled whitespace", () => {
		expect(parseExports("export  interface  Foobar {}")).toEqual([
			{ name: "Foobar", kind: "interface", isTypeOnly: true, line: 1 },
		]);
	});

	it("type alias with doubled whitespace", () => {
		expect(parseExports("export  type  Foobar  = string")).toEqual([
			{ name: "Foobar", kind: "type", isTypeOnly: true, line: 1 },
		]);
	});
});

describe("parseExports — anchor precision (a later 'export ...' substring must not match)", () => {
	// Each line below starts with "export" (passing the outer guard) but is shaped so
	// the target form fails to match at position 0; if the target regex's leading `^`
	// were ever lost, it would instead match the "export <keyword> ..." text embedded
	// later in the same line. Every one of these must parse to nothing.
	const decoys: Array<[string, string]> = [
		["default class/function", "export zz export default class Foo"],
		["default expression", "export zz export default 1"],
		["async function", "export zz export async function foo"],
		["function", "export zz export function foo"],
		["const/let/var", "export zz export const foo"],
		["class", "export zz export class Foo"],
		["interface", "export zz export interface Foo"],
		["type alias", "export zz export type Foo = string"],
		["enum", "export zz export enum Foo"],
		["abstract class", "export zz export abstract class Foo"],
		["type re-export brace", "export zz export type { Foo }"],
		["named re-export brace", "export zz export { foo }"],
		["star re-export", 'export zz export * from "./m"'],
	];

	for (const [label, line] of decoys) {
		it(`does not match ${label} embedded later in the line`, () => {
			expect(parseExports(line)).toEqual([]);
		});
	}

	it("does not open multiline mode on a decoy 'export type {' embedded later in the line", () => {
		// Needs two lines: a single-line decoy produces [] either way (a wrongly-opened
		// buffer with no closing "}" anywhere just dangles and is dropped at EOF). Only
		// a closing line downstream exposes whether the buffer was wrongly opened.
		const code = ["export zz export type {", "content }"].join("\n");
		expect(parseExports(code)).toEqual([]);
	});

	it("does not match a decoy 'export * as <name>' embedded later in the line", () => {
		// The outer star-detect (`/^export\s+\*\s/`) must itself match at position 0
		// for nsMatch to even run, so the decoy repeats "export * " before the inner
		// "export * as ns" so the outer guard passes and nsMatch is actually reached.
		const line = 'export * zz export * as ns from "./m"';
		expect(parseExports(line)).toEqual([
			{ name: "*", kind: "namespace", isTypeOnly: false, line: 1 },
		]);
	});

	it("processExportStatement's own type-check stays anchored to the buffer start", () => {
		// Buffer becomes "export { zz export type { content }" — a plain (non-type)
		// local export whose captured blob happens to CONTAIN the substring
		// "export type {" further in. Anchored isTypeExport must stay false.
		const code = ["export {", "zz export type { content }"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "zz export type { content", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});
});

describe("parseExports — a second 'as' inside one specifier exposes the split regex's greedy trailing boundary", () => {
	// Real export specifiers never legitimately contain two "as" tokens (TS syntax
	// allows exactly one alias per specifier), but the parser is regex-based and
	// processes whatever text it is handed — these decoys probe the same greedy
	// `\s+as\s+` split the doubled-whitespace tests above exercise, from the side
	// those tests cannot reach: whether the TRAILING `\s+` is truly greedy.
	//
	// Trace for "A as  as B" (note the double space before the second "as"): the
	// first "as" match's leading side consumes the single space before it either
	// way. If the trailing side is the correct greedy `\s+`, it consumes BOTH
	// spaces before the second "as", leaving that second "as" with no whitespace
	// in front of it — so it fails to split and survives as literal text, giving
	// the popped name "as B". If the trailing side degrades to a single `\s`, the
	// first match consumes only one of the two spaces, leaving exactly one
	// whitespace character in front of the second "as" — enough for IT to also
	// split, discarding the leading "as" and popping just "B". A doubled leading
	// gap (the mirror case) can never surface through `.pop()` this way: any
	// leading-side under-consumption only ever attaches to the piece BEFORE a
	// match, which `.pop()` always discards — so only the trailing side is
	// observable here, and that is exactly what these three cases assert.
	it("typeReExport: doubled-whitespace gap before the second 'as' changes whether it splits", () => {
		expect(parseExports("export type { A as  as B }")).toEqual([
			{ name: "as B", kind: "type", isTypeOnly: true, line: 1 },
		]);
	});

	it("namedReExport: same greedy-boundary probe, non-type branch", () => {
		expect(parseExports("export { A as  as B }")).toEqual([
			{ name: "as B", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("processExportStatement: same greedy-boundary probe, across a multiline buffer", () => {
		const code = ["export {", "A as  as B", "}"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "as B", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});
});

describe("parseExports — alias-split final trim, heavy whitespace beyond the doubled-space cases above", () => {
	// The three alias-then-pop chains (typeReExport, namedReExport,
	// processExportStatement) all end `.split(/\s+as\s+/).pop()!.trim()`. These
	// go past double whitespace to a mix of tabs/triple-spaces on BOTH sides of
	// "as" at once, in case a boundary survives at 2 spaces but not 3+ or tabs.
	it("typeReExport: triple space and a tab around 'as' still isolates the alias", () => {
		expect(parseExports("export type { Foo   as\tBar }")).toEqual([
			{ name: "Bar", kind: "type", isTypeOnly: true, line: 1 },
		]);
	});

	it("namedReExport: triple space and a tab around 'as' still isolates the alias", () => {
		expect(parseExports("export { Foo   as\tBar }")).toEqual([
			{ name: "Bar", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	it("processExportStatement (multiline): triple space and a tab around 'as' still isolates the alias", () => {
		const code = ["export {", "Foo   as\tBar", "}"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "Bar", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});
});

describe("parseExports — lines that start with 'export' but match no known form never fall through to a later one", () => {
	// Regression net around the skip-guard at the top of the per-line dispatch
	// (`if (!trimmed.startsWith("export")) continue;`): every one of these is
	// shaped so it could only ever produce output by accidentally satisfying a
	// LATER matcher once the leading guard stops filtering non-export content.
	it("a bare brace line with no 'export' anywhere produces nothing", () => {
		expect(parseExports("{ foo }")).toEqual([]);
	});

	it("blank and whitespace-only lines around a real export produce nothing extra", () => {
		const code = ["", "   ", "export const only = 1;", "\t"].join("\n");
		expect(parseExports(code)).toEqual([
			{ name: "only", kind: "const", isTypeOnly: false, line: 3 },
		]);
	});

	it("a line that merely CONTAINS the word export, not at the start, produces nothing", () => {
		expect(parseExports("const reexportLike = 1;")).toEqual([]);
	});
});
