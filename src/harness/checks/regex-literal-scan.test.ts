import { describe, expect, it } from "vitest";
import { blankRegexLiteralsAnywhere, blankRegexLiteralsAtLexerStart, findRegexLiteralEnd } from "./regex-literal-scan.js";

// The two historic regexes this module replaces. Kept here only as a differential oracle on SHORT input,
// where their exponential / quadratic backtracking cannot bite.
const OLD_ANYWHERE = /\/(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[dgimsuy]*/g;
const OLD_LEXER_START =
	/(^|[=(,:[!&|?{};<>+\-*%~^]|(?<![.\w$])(?:return|typeof|case|yield|void|delete|throw|else))(\s*)(\/(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[dgimsuyv]*)/gm;

const oldAnywhere = (s: string): string => s.replace(OLD_ANYWHERE, (m) => " ".repeat(m.length));
const oldLexer = (s: string): string => s.replace(OLD_LEXER_START, (_m, pre: string, ws: string, re: string) => pre + ws + " ".repeat(re.length));

describe("findRegexLiteralEnd — positive (finds the literal)", () => {
	it("P1: returns the index after the closing slash and the flags", () => {
		expect(findRegexLiteralEnd("a = /ab+c/gi;", 4, "dgimsuy")).toBe(12);
	});
	it("P2: a slash inside a character class does not close the literal", () => {
		expect(findRegexLiteralEnd("/[/]x/", 0, "dgimsuy")).toBe(6);
	});
	it("P3: an escaped slash does not close the literal", () => {
		expect(findRegexLiteralEnd("/a\\/b/", 0, "dgimsuy")).toBe(6);
	});
});

describe("findRegexLiteralEnd — negative (no literal)", () => {
	it("N1: an empty body (a line comment start) is not a literal", () => {
		expect(findRegexLiteralEnd("//x", 0, "dgimsuy")).toBe(-1);
	});
	it("N2: a missing closing slash on the line is not a literal", () => {
		expect(findRegexLiteralEnd("/abc\n/", 0, "dgimsuy")).toBe(-1);
	});
	it("N3: a literal longer than the cap is not scanned to the end", () => {
		expect(findRegexLiteralEnd(`/${"a".repeat(5000)}/`, 0, "dgimsuy")).toBe(-1);
	});
});

describe("blank helpers — differential against the historic regexes on short input", () => {
	const samples = [
		"x = /a+/.test(s)",
		"if (a / b > c / d) {}",
		"const r = /[/]+/g, q = 4 / 2 / 1;",
		"return /=== NaN/i;",
		"a[0] / b[1] / c",
		"/[^\\]]+/",
		"x /= 2; y /= 3",
		"case /a/.test(s): break",
		"foo(/\\//, bar / baz / qux)",
		"[1,2,3].map(x => x / 2 / 3)",
	];
	for (const [i, text] of samples.entries()) {
		it(`P${i + 1}: anywhere variant matches the old regex on sample ${i + 1}`, () => {
			expect(blankRegexLiteralsAnywhere(text)).toBe(oldAnywhere(text));
		});
		it(`P${i + 11}: lexer-start variant matches the old regex on sample ${i + 1}`, () => {
			expect(blankRegexLiteralsAtLexerStart(text)).toBe(oldLexer(text));
		});
	}
	it("P21: a seeded random corpus agrees with the old regexes", () => {
		let seed = 12345;
		const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
		const alphabet = ["/", "/", "a", "b", "[", "]", "\\", " ", "=", "(", ")", "\n", "g", "return "];
		for (let n = 0; n < 400; n++) {
			let text = "";
			for (let k = 0; k < 14; k++) text += alphabet[next() % alphabet.length];
			expect(blankRegexLiteralsAnywhere(text)).toBe(oldAnywhere(text));
			expect(blankRegexLiteralsAtLexerStart(text)).toBe(oldLexer(text));
		}
	});
});

describe("blank helpers — linear time on one long minified line (regression for the verify hang)", () => {
	// A 400 KB single line with thousands of division slashes, bracket groups and no closing slash: the old regex
	// backtracked exponentially on the bracket groups and quadratically on the slashes.
	const unit = "a[0]/b[1]/c[2](d)[3]/";
	const longLine = unit.repeat(Math.ceil(400_000 / unit.length));
	const bracketSoup = `x = /${"[ab]".repeat(40)}`;
	it("N4: the anywhere variant finishes a 400 KB line well inside the bound", () => {
		const started = performance.now();
		blankRegexLiteralsAnywhere(longLine);
		expect(performance.now() - started).toBeLessThan(2000);
	});
	it("N5: the lexer-start variant finishes a 400 KB line well inside the bound", () => {
		const started = performance.now();
		blankRegexLiteralsAtLexerStart(`x = ${longLine}`);
		expect(performance.now() - started).toBeLessThan(2000);
	});
	it("N6: an unterminated bracket-group literal does not blow up", () => {
		const started = performance.now();
		blankRegexLiteralsAnywhere(bracketSoup);
		expect(performance.now() - started).toBeLessThan(500);
	});
	it("N7: an adversarial slash-and-bracket line stays bounded", () => {
		const started = performance.now();
		blankRegexLiteralsAnywhere("/[".repeat(150_000));
		expect(performance.now() - started).toBeLessThan(3000);
	});
});
