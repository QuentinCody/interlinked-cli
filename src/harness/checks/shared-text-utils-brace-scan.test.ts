// Targeted branch/line coverage for stripForBraceScan's edge paths: unterminated
// string/regex literals (real newline mid-literal), backslash-escape handling at
// EOF, block-comment EOF, and regex-vs-division disambiguation via precedingWord.
// See strip-brace-balance.test.ts for the invariant-level (brace-balance) tests.
import { describe, expect, it } from "vitest";
import { stripForBraceScan } from "./shared-text-utils.js";
import { rawBraceDelta } from "./shared-text-utils-brace-scan.js";

it("counts raw text as supplied and allows negative and positive net depths", () => {
	expect(rawBraceDelta("}}{")).toBe(-1);
	expect(rawBraceDelta('"{": /* { */')).toBe(2);
	expect(rawBraceDelta("no braces")).toBe(0);
});

describe("stripForBraceScan — unterminated string literal (real newline bails)", () => {
	it("a double-quoted string containing a raw newline is abandoned at the newline", () => {
		// Real newline chars, not escaped \n, so the string frame is unterminated.
		const src = 'const s = "abc\ndef";\nfunction f() { return 1; }';
		const out = stripForBraceScan(src);
		// Everything up to (not including) the newline is blanked; the newline
		// itself and "def" (now parsed as top-level code) survive. The `"` that
		// follows opens a SECOND (also unterminated) string that swallows `;`
		// and bails again at the next newline — a chained consequence of
		// treating the file as two unterminated strings, not one.
		expect(out).toBe('const s =     \ndef  \nfunction f() { return 1; }');
	});
});

describe("stripForBraceScan — unterminated regex literal (real newline bails)", () => {
	it("a regex literal containing a raw newline is abandoned at the newline", () => {
		const src = "const re = /abc\ndef/; function g() { return 1; }";
		const out = stripForBraceScan(src);
		expect(out).toBe("const re =     \ndef/; function g() { return 1; }");
	});
});

describe("stripForBraceScan — string backslash-escape edge cases", () => {
	it("backslash as the very last character of the file (no char to escape)", () => {
		const src = 'const s = "abc\\';
		// The backslash blanks itself; there is no i+1 to also blank (EOF).
		expect(stripForBraceScan(src)).toBe("const s =      ");
	});

	it("backslash escaping a normal character mid-string keeps scanning", () => {
		const src = 'const s = "a\\"b"; function h() { return 1; }';
		const out = stripForBraceScan(src);
		expect(out).toBe("const s =       ; function h() { return 1; }");
	});
});

describe("stripForBraceScan — block comment unterminated at EOF", () => {
	it("an unterminated block comment blanks to end of file without throwing", () => {
		const src = "function f() { return 1; } /* never closed";
		const out = stripForBraceScan(src);
		expect(out).toBe("function f() { return 1; }                ");
	});
});

describe("stripForBraceScan — regex literal backslash-escape edge cases", () => {
	it("backslash as the very last character inside a regex (no char to escape)", () => {
		const src = "const re = /abc\\";
		expect(stripForBraceScan(src)).toBe("const re =      ");
	});

	it("backslash escaping a slash inside a regex keeps it from closing the literal", () => {
		const src = "const re = /a\\/b/; function i() { return 1; }";
		const out = stripForBraceScan(src);
		expect(out).toBe("const re =       ; function i() { return 1; }");
	});
});

describe("stripForBraceScan — template literal backslash-escape edge cases", () => {
	it("backslash as the very last character inside a template literal (no char to escape)", () => {
		const src = "const t = `abc\\";
		expect(stripForBraceScan(src)).toBe("const t =      ");
	});

	it("backslash escaping a backtick inside a template literal keeps it open", () => {
		const src = "const t = `a\\`b`; function j() { return 1; }";
		const out = stripForBraceScan(src);
		expect(out).toBe("const t =       ; function j() { return 1; }");
	});
});

describe("stripForBraceScan — regex vs. division disambiguation (precedingWord)", () => {
	it("a keyword immediately (no whitespace) before `/` is still recognized as a regex preceder", () => {
		const src = "if(typeof/x/.test(y)){ z(); }";
		const out = stripForBraceScan(src);
		// The regex body `x` is blanked; structural code survives.
		expect(out).toBe("if(typeof   .test(y)){ z(); }");
	});

	it("a keyword with whitespace before `/` is recognized as a regex preceder", () => {
		const src = "function k() { return /x/.test(y); }";
		const out = stripForBraceScan(src);
		expect(out).toBe("function k() { return    .test(y); }");
	});

	it("division after an identifier that is not a regex-preceder word stays division (not a regex)", () => {
		const src = "function m() { return a/b; }";
		const out = stripForBraceScan(src);
		// `/` here is division: not a frame opener, so nothing is blanked at all.
		expect(out).toBe(src);
	});
});

// These branch-focused cases live in the filename-convention companion so
// mutation runners that use the fallback `<source>.test.ts` scope discover
// them. (The reverse import graph for this barrel intentionally exceeds the
// mutation scope cap.) Exact outputs were cross-checked against the pristine
// scanner and shadow builds of the corresponding mutants.
describe("stripForBraceScan — regex preceder character membership", () => {
	const chars = [
		"", "(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "^", "~", "<", ">",
	];
	it.each(chars)("blanks a regex body after %j", (preceder) => {
		expect(stripForBraceScan(`${preceder}/{}/`)).toBe(`${preceder}    `);
	});
});

describe("stripForBraceScan — regex preceder keyword membership", () => {
	const words = ["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "do", "else", "yield", "await", "case"];
	it.each(words)("blanks a regex body after keyword %j", (word) => {
		expect(stripForBraceScan(`${word} /{}/`)).toBe(`${word}     `);
	});
});

describe("stripForBraceScan — stepStr branch behavior", () => {
	it("blanks both a string escape and its escaped character", () => {
		expect(stripForBraceScan('"\\Q"')).toBe("    ");
	});
	it("continues after closing a string", () => {
		expect(stripForBraceScan('"a"//c')).toBe("      ");
	});
	it("treats slash after a closed string as division", () => {
		expect(stripForBraceScan('"a"/b/')).toBe("   /b/");
	});
	it("advances past an unterminated string newline", () => {
		expect(stripForBraceScan('"a`\ndef')).toBe("   \ndef");
	});
});

describe("stripForBraceScan — stepBlock branch behavior", () => {
	it("closes only at an adjacent star-slash", () => {
		expect(stripForBraceScan("/* abc */ def")).toBe("          def");
	});
	it("does not close after a bare star", () => {
		expect(stripForBraceScan("/*a*b*/c")).toBe("       c");
	});
	it("does not close after a bare slash", () => {
		expect(stripForBraceScan("/*a/b*/c")).toBe("       c");
	});
});

describe("stripForBraceScan — stepCodeBrace interpolation tracking", () => {
	it("keeps nested braces inside an interpolation balanced", () => {
		expect(stripForBraceScan("`${{}}`")).toBe("   {}  ");
	});
	it("preserves a top-level close and treats following slash as division", () => {
		expect(stripForBraceScan("{}/x/")).toBe("{}/x/");
	});
	it("preserves an interpolation expression's code while blanking its close", () => {
		expect(stripForBraceScan("`${value}`")).toBe("   value  ");
	});
});

describe("stripForBraceScan — stepCodeOpener frame selection", () => {
	it("opens single-quoted strings", () => {
		expect(stripForBraceScan("'a'")).toBe("   ");
	});
	it("does not open a frame at a regex preceder that is not a slash", () => {
		expect(stripForBraceScan("(x")).toBe("(x");
	});
	it("does not treat a star followed by a non-slash as a block opener", () => {
		expect(stripForBraceScan("x*y")).toBe("x*y");
	});
	it("opens line comments and preserves their newline", () => {
		expect(stripForBraceScan("// {comment}\n{}")).toBe("            \n{}");
	});
});

describe("stripForBraceScan — stepRegex character classes and close", () => {
	it("does not close on slash inside a character class", () => {
		expect(stripForBraceScan("/[/]/ x")).toBe("      x");
	});
	it("closes after leaving a character class", () => {
		expect(stripForBraceScan("/[a/]/ x")).toBe("       x");
	});
	it("continues after a regex close", () => {
		expect(stripForBraceScan('/x/"y"')).toBe("      ");
	});
	it("treats slash after a regex close as division", () => {
		expect(stripForBraceScan("/x//y/")).toBe("   /y/");
	});
	it("advances past an unterminated regex newline", () => {
		expect(stripForBraceScan('/x\n"y"')).toBe("  \n   ");
	});
	it("does not move backward after an unterminated regex", () => {
		expect(stripForBraceScan("/a`\ndef")).toBe("   \ndef");
	});
});

describe("stripForBraceScan — stepTmpl interpolation and closure", () => {
	it("keeps interpolation code visible", () => {
		expect(stripForBraceScan("`${x}`")).toBe("   x  ");
	});
	it("does not open interpolation for a lone dollar", () => {
		expect(stripForBraceScan("`a$b{c}`")).toBe("        ");
	});
	it("continues after a template close", () => {
		expect(stripForBraceScan('`x`"y"')).toBe("      ");
	});
	it("treats slash after a template close as division", () => {
		expect(stripForBraceScan("`x`/y/")).toBe("   /y/");
	});
	it("blanks an escaped template character without closing", () => {
		expect(stripForBraceScan("`a\\`b`{}")).toBe("      {}");
	});
});

describe("stripForBraceScan — precedingWord boundaries", () => {
	it("recognizes a keyword beginning at index zero", () => {
		expect(stripForBraceScan("instanceof /x/")).toBe("instanceof    ");
	});
	it("recognizes a keyword after whitespace", () => {
		expect(stripForBraceScan("return   /x/")).toBe("return      ");
	});
	it("does not recognize a non-keyword identifier", () => {
		const src = "identifier /x/";
		expect(stripForBraceScan(src)).toBe(src);
	});
	it("recognizes a keyword after multiple spaces from the slash", () => {
		expect(stripForBraceScan("return     /x/")).toBe("return        ");
	});
	it("keeps a slash after punctuation in an expression as division", () => {
		const src = "}/x/";
		expect(stripForBraceScan(src)).toBe(src);
	});
});

describe("stripForBraceScan — remaining frame-boundary contracts", () => {
	it("keeps the synthetic value marker after an interpolation close", () => {
		// With prevChar="v", this slash is division. If the close returns an
		// empty marker, the empty marker is treated as a regex preceder instead.
		expect(stripForBraceScan("`${x}`/y/")).toBe("   x  /y/");
	});
	it("keeps a top-level closing brace on the initialized code frame", () => {
		expect(stripForBraceScan("}")).toBe("}");
	});
	it("preserves LF and CR while blanking template text", () => {
		expect(stripForBraceScan("`a\n b`")).toBe("  \n   ");
		expect(stripForBraceScan("`a\r b`")).toBe("  \r   ");
	});
	it("blanks every character in a line comment before its newline", () => {
		expect(stripForBraceScan("//abc\n{}")).toBe("     \n{}");
	});
	it("advances beyond a block-comment close and resumes code", () => {
		expect(stripForBraceScan("/*abc*/{}")).toBe("       {}");
	});
});
