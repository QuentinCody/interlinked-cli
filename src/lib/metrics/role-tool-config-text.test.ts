import { describe, expect, it } from "vitest";
import { blankNested, lineAt, maskComments, matchBracket, openBraces, scanStrings, topLevelKeys } from "./role-tool-config-text.js";

describe("MUST-FIRE: text helpers keep offsets", () => {
	it("P1: maskComments blanks a hash comment and a js comment but keeps length and newlines", () => {
		const hash = 'a = "x # not a comment" # real\nb = 1';
		const masked = maskComments(hash, "hash");
		expect(masked.length).toBe(hash.length);
		expect(masked).toContain("# not a comment");
		expect(masked).not.toContain("real");
		const js = "const a = '//x'; // c\n/* block\nmore */ const b = 1;";
		const jsMasked = maskComments(js, "js");
		expect(jsMasked.length).toBe(js.length);
		expect(jsMasked).toContain("//x");
		expect(jsMasked).not.toContain("block");
		expect(jsMasked.split("\n").length).toBe(3);
	});
	it("P2: matchBracket finds the close past strings and nested brackets", () => {
		const text = 'x = ["a]", ["b"], "c"] tail';
		expect(matchBracket(text, text.indexOf("["))).toBe(text.indexOf("] tail"));
	});
	it("P3: scanStrings returns values with their offsets and lineAt maps them to lines", () => {
		const text = "[\n  'a',\n  \"b\",\n]";
		const found = scanStrings(text, 0, text.length);
		expect(found.map((s) => s.value)).toEqual(["a", "b"]);
		expect(found.map((s) => lineAt(text, s.offset))).toEqual([2, 3]);
	});
	it("P4: topLevelKeys sees only the keys of the object itself", () => {
		const inner = "ignores: ['x'], name: 'n', nested: { files: ['y'] }, ...spread";
		expect(topLevelKeys(blankNested(inner))).toEqual(["ignores", "name", "nested", "..."]);
	});
});

describe("open braces", () => {
	it("P5: openBraces lists the braces still open at an index and skips braces in strings", () => {
		const text = "a = { b: '}', c: { d: 1 }, e: [ 1 ] }";
		expect(openBraces(text, text.indexOf("d:"))).toEqual([4, text.indexOf("{ d")]);
		expect(openBraces(text, text.indexOf("e:"))).toEqual([4]);
	});
});

describe("MUST-NOT-FIRE: text helpers", () => {
	it("N1: matchBracket returns -1 for an unbalanced list", () => {
		expect(matchBracket("[ 'a', ", 0)).toBe(-1);
	});
	it("N2: scanStrings skips a template literal that interpolates", () => {
		const text = "['a', `b${c}`, `d`]";
		expect(scanStrings(text, 0, text.length).map((s) => s.value)).toEqual(["a", "d"]);
	});
});
