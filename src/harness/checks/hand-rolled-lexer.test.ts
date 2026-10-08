import { describe, expect, it } from "vitest";
import { detectHandRolledLexer } from "./hand-rolled-lexer.js";

/** Build fixture source from lines so quote characters need no escaping gymnastics. */
function src(...lines: string[]): string {
	return lines.join("\n");
}

const QUOTE_AND_COMMENT_LEXER = src(
	"export function stripAll(text: string): string {",
	"  let out = '';",
	"  for (let i = 0; i < text.length; i++) {",
	"    const ch = text[i];",
	"    if (ch === '\"' || ch === \"'\" || ch === '`') { out += ch; continue; }",
	"    if (text.startsWith('//', i)) { break; }",
	"    out += ch;",
	"  }",
	"  return out;",
	"}",
);

const STATE_VARIABLE_LEXER = src(
	"export function scan(text: string): string {",
	"  let inBlockComment = false;",
	"  let out = '';",
	"  for (let i = 0; i < text.length; i++) {",
	"    if (text[i] === 'x') inBlockComment = !inBlockComment;",
	"    if (!inBlockComment) out += text[i];",
	"  }",
	"  return out;",
	"}",
);

describe("detectHandRolledLexer — positive (must fire)", () => {
	it("P1: fires on a character loop that tests the three quote chars and a comment opener", () => {
		const out = detectHandRolledLexer(QUOTE_AND_COMMENT_LEXER, "src/lib/strip.ts");
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(1);
		expect(out[0]?.text).toContain("stripAll");
		expect(out[0]?.text).toContain("lexes JS by hand");
		expect(out[0]?.text).toContain("stripWithTypeScript");
		expect(out[0]?.text).toContain("parseTsSource");
		expect(out[0]?.text).toContain("lexer-fallback:");
	});

	it("P2: fires on a character loop that keeps an inBlockComment state variable", () => {
		const out = detectHandRolledLexer(STATE_VARIABLE_LEXER, "src/lib/scan.ts");
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("scan");
	});

	it("P3: fires on an arrow function bound to a const, with the arrow's own name", () => {
		const code = src(
			"export const blank = (text: string): string => {",
			"  let inTemplate = false;",
			"  let out = '';",
			"  for (const ch of text) { if (ch === '*') inTemplate = !inTemplate; out += ch; }",
			"  return out;",
			"};",
		);
		const out = detectHandRolledLexer(code, "src/lib/blank.ts");
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("blank");
	});

	it("P4: fires on a slash-plus-star comment test with a backtick and a quote in a while loop", () => {
		const code = src(
			"function walk(s: string) {",
			"  let i = 0;",
			"  while (i < s.length) {",
			"    const c = s.charAt(i);",
			"    if (c === '\"' || c === '`') { i++; continue; }",
			"    if (c === '/' && s.charAt(i + 1) === '*') { i += 2; continue; }",
			"    i++;",
			"  }",
			"}",
		);
		expect(detectHandRolledLexer(code, "src/lib/walk.ts")).toHaveLength(1);
	});

	it("P5: reports a lexer nested in another function once, on the inner function", () => {
		const outer = src(
			"export function outer(text: string) {",
			"  function inner(s: string) {",
			"    let inRegex = false;",
			"    for (let i = 0; i < s.length; i++) { if (s[i] === 'q') inRegex = !inRegex; }",
			"    return inRegex;",
			"  }",
			"  return inner(text);",
			"}",
		);
		const out = detectHandRolledLexer(outer, "src/lib/outer.ts");
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("inner");
		expect(out[0]?.line).toBe(2);
	});

	it("P6: fires on a quote-only state variable when a comment opener corroborates it", () => {
		const code = src(
			"export function strip(text: string): string {",
			"  let inString = false;",
			"  for (let i = 0; i < text.length; i++) {",
			"    if (text[i] === 'q') inString = !inString;",
			"    if (!inString && text.startsWith('/*', i)) return text.slice(0, i);",
			"  }",
			"  return text;",
			"}",
		);
		expect(detectHandRolledLexer(code, "src/lib/strip.ts")).toHaveLength(1);
	});
});

describe("detectHandRolledLexer — negative (must not fire)", () => {
	it("N1: a lexer-fallback marker with a reason in the comment above exempts the function", () => {
		const code = `// lexer-fallback: the line scanner behind the parser route\n${QUOTE_AND_COMMENT_LEXER}`;
		expect(detectHandRolledLexer(code, "src/lib/strip.ts")).toEqual([]);
	});

	it("N2: a lexer-fallback marker inside the body exempts the function", () => {
		const code = STATE_VARIABLE_LEXER.replace(
			"  let out = '';",
			"  // lexer-fallback: used only when typescript is absent\n  let out = '';",
		);
		expect(detectHandRolledLexer(code, "src/lib/scan.ts")).toEqual([]);
	});

	it("N3: a marker without a reason does not exempt", () => {
		const code = `// lexer-fallback:\n${QUOTE_AND_COMMENT_LEXER}`;
		expect(detectHandRolledLexer(code, "src/lib/strip.ts")).toHaveLength(1);
	});

	it("N4: a test file is exempt", () => {
		expect(detectHandRolledLexer(STATE_VARIABLE_LEXER, "src/lib/scan.test.ts")).toEqual([]);
	});

	it("N5: a plain character loop with no quote or comment state is not a lexer", () => {
		const code = src(
			"export function count(text: string): number {",
			"  let n = 0;",
			"  for (let i = 0; i < text.length; i++) { if (text[i] === 'a') n++; }",
			"  return n;",
			"}",
		);
		expect(detectHandRolledLexer(code, "src/lib/count.ts")).toEqual([]);
	});

	it("N6: a function that calls parseTsSource is the parser route", () => {
		const code = src(
			"export function route(text: string, file: string) {",
			"  const parsed = parseTsSource(text, file);",
			"  let inBlockComment = false;",
			"  for (let i = 0; i < text.length; i++) { if (text[i] === 'x') inBlockComment = !inBlockComment; }",
			"  return parsed;",
			"}",
		);
		expect(detectHandRolledLexer(code, "src/lib/route.ts")).toEqual([]);
	});

	it("N7: quote characters without a comment opener are not enough", () => {
		const code = src(
			"export function quoted(text: string): number {",
			"  let n = 0;",
			"  for (let i = 0; i < text.length; i++) {",
			"    if (text[i] === '\"' || text[i] === \"'\" || text[i] === '`') n++;",
			"    if (text[i] === ',') n++;",
			"  }",
			"  return n;",
			"}",
		);
		expect(detectHandRolledLexer(code, "src/lib/quoted.ts")).toEqual([]);
	});

	it("N8: lexical-state evidence without a loop is not a lexer", () => {
		const code = src(
			"export function flag(text: string): boolean {",
			"  const inBlockComment = text.startsWith('/*');",
			"  return text[0] === 'x' && inBlockComment;",
			"}",
		);
		expect(detectHandRolledLexer(code, "src/lib/flag.ts")).toEqual([]);
	});

	it("N9: a non-JS/TS file is not inspected", () => {
		expect(detectHandRolledLexer(STATE_VARIABLE_LEXER, "tools/scan.py")).toEqual([]);
	});

	it("N10: a shell-style splitter with inSingle/inDouble and no JS evidence is not JS lexing", () => {
		const code = src(
			"export function shellSplit(input: string): string[] {",
			"  let inSingle = false;",
			"  let inDouble = false;",
			"  const out: string[] = [];",
			"  for (let i = 0; i < input.length; i++) {",
			"    const c = input[i];",
			"    if (c === \"'\" && !inDouble) inSingle = !inSingle;",
			"    else if (c === '\"' && !inSingle) inDouble = !inDouble;",
			"    else out.push(c ?? '');",
			"  }",
			"  return out;",
			"}",
		);
		expect(detectHandRolledLexer(code, "src/lib/shell.ts")).toEqual([]);
	});

	it("N11: a quote-only inQuote splitter with no comment opener or backtick is not JS lexing", () => {
		const code = src(
			"export function splitList(text: string): string[] {",
			"  let inQuote: string | null = null;",
			"  const parts: string[] = [];",
			"  for (let i = 0; i < text.length; i++) {",
			"    const ch = text[i];",
			"    if (ch === '\"' || ch === \"'\") inQuote = inQuote === ch ? null : ch;",
			"    else if (ch === ',' && !inQuote) parts.push('');",
			"  }",
			"  return parts;",
			"}",
		);
		expect(detectHandRolledLexer(code, "src/lib/list.ts")).toEqual([]);
	});

	it("N12: a Rust-style lexer with two quote kinds and comment openers but no template backtick is not JS lexing", () => {
		const code = src(
			"export function stripRust(text: string): string {",
			"  let out = '';",
			"  for (let i = 0; i < text.length; i++) {",
			"    const ch = text[i];",
			"    if (text.startsWith('//', i) || text.startsWith('/*', i)) break;",
			"    if (ch === '\"' || ch === \"'\") continue;",
			"    out += ch;",
			"  }",
			"  return out;",
			"}",
		);
		expect(detectHandRolledLexer(code, "src/lib/rust.ts")).toEqual([]);
	});

	it("N13: an isComment predicate is not a state variable", () => {
		const code = src(
			"export function commentLines(lines: string[]): number {",
			"  let n = 0;",
			"  for (let i = 0; i < lines.length; i++) {",
			"    const isComment = lines[i]?.startsWith('//') ?? false;",
			"    if (isComment) n++;",
			"  }",
			"  return n;",
			"}",
		);
		expect(detectHandRolledLexer(code, "src/lib/comments.ts")).toEqual([]);
	});
});
