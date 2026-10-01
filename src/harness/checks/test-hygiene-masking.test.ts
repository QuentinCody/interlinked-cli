// Direct unit coverage for test-hygiene-masking.ts's pure char-level helpers,
// targeting paths the end-to-end consumer (checkHappyPathOnlyTest, exercised in
// test-hygiene.test.ts) does not happen to reach: block comments, string
// backslash-escape edge cases, and the blankRange/isCodeMatch boundary clamps.
import { describe, expect, it } from "vitest";
import { blankRange, isCodeMatch, isSkippedOrTodoCall, maskCommentsAndStrings, maskCommentsAndStringsHeuristic } from "./test-hygiene-masking.js";

describe("maskCommentsAndStrings — parser route and heuristic fallback agree on the review-6 constructs", () => {
	// test-contract: invariant — both routes keep division after a non-null assertion, a unicode identifier and the identifier `of`, and both blank a regex after a control-statement paren or a comment-separated keyword (review 2026-09-30, round 6); JSX is parser-only
	const division = "const half = count! / 2; const r = π / 2; const s = of / 2; expect(half).toBeTruthy();";
	const control = 'if (ready) /"/.test(text);\nimport { x } from "./private/parser";';
	const separated = 'function f() { return/*comment*/typeof /"/; }\nimport { x } from "./private/parser";';
	it.each([["parser", maskCommentsAndStrings], ["heuristic", maskCommentsAndStringsHeuristic]])("%s route", (_name, mask) => {
		expect(mask(division)).toBe(division);
		expect(mask(control)).toBe('if (ready)    .test(text);\nimport { x } from                   ;');
		expect(mask(separated)).toBe('function f() { return           typeof    ; }\nimport { x } from                   ;');
	});
	// test-contract: invariant — the fallback treats the COMPLETE identifier character set as operand continuation: a combining mark (`café`) and an astral character scanned as two UTF-16 units (`𝒳`) never end the operand, so the division and the assertion after it stay visible (review 2026-09-30, round 7)
	it("the heuristic keeps division after identifiers with combining marks and astral characters", () => {
		const source = "const a = café / 2; const b = 𝒳 / 2; expect(x).toBeTruthy();";
		expect(maskCommentsAndStringsHeuristic(source)).toBe(source);
		expect(maskCommentsAndStrings(source)).toBe(source);
	});
	it("the parser route keeps code after a JSX closing tag visible", () => {
		const view = "const view = <div>{value}</div>; expect(view).toBeTruthy();";
		expect(maskCommentsAndStrings(view, "view.test.tsx")).toBe(view);
	});
});

describe("maskCommentsAndStrings — regex literals", () => {
	// test-contract: invariant — a quote inside a regex literal is not a string opener: the code after `/"/` stays visible; a `/` after an operand is division and never opens a literal; a `/` inside a character class or escaped does not close one
	it("blanks a regex literal so a quote inside it cannot hide the following import", () => {
		const src = 'const quote = /"/;\nimport { x } from "./private/parser";';
		const masked = maskCommentsAndStrings(src);
		expect(masked).toBe('const quote =    ;\nimport { x } from                   ;');
	});
	// test-contract: invariant — the slash decision is by TOKEN context: a postfix `++`/`--`, a completed literal, `)`/`]`, an identifier or a number precede division; a keyword operand (`return`, `typeof`, `case`, …) or an operator precedes a regex (review 2026-09-30, round 5)
	it("keeps division after a postfix operator or a completed literal, and opens a regex after a keyword", () => {
		const postfix = "let count = 4; const half = count++ / 2; expect(half).toBeTruthy();";
		expect(maskCommentsAndStrings(postfix)).toBe(postfix);
		const literal = 'const n = "ab".length / 2; const m = `x` / 2; const k = /a/.source / 1;';
		expect(maskCommentsAndStrings(literal)).toBe('const n =     .length / 2; const m =     / 2; const k =    .source / 1;');
		const keyword = 'function pattern() { return /"/; }\nimport { x } from "./private/parser";';
		expect(maskCommentsAndStrings(keyword)).toBe('function pattern() { return    ; }\nimport { x } from                   ;');
		expect(maskCommentsAndStrings("const t = typeof /x/; case /y/: break;")).toBe("const t = typeof    ; case    : break;");
	});
	it("treats a slash after an operand as division, and keeps class and escaped slashes inside the literal", () => {
		expect(maskCommentsAndStrings("const half = total / 2; const y = a[0] / (b) / 3;")).toBe("const half = total / 2; const y = a[0] / (b) / 3;");
		const src = 'const re = /[/"]\\/x/g; const s = "after";';
		// The heuristic blanks the body and leaves the flag; the parser's regex token carries the flag, so it blanks that too.
		expect(maskCommentsAndStringsHeuristic(src)).toBe(`const re = ${" ".repeat('/[/"]\\/x/'.length)}g; const s = ${" ".repeat('"after"'.length)};`);
		expect(maskCommentsAndStrings(src)).toBe(`const re = ${" ".repeat('/[/"]\\/x/g'.length)}; const s = ${" ".repeat('"after"'.length)};`);
	});
});

describe("maskCommentsAndStrings — block comments", () => {
	it("blanks a single-line block comment, preserving surrounding code", () => {
		const src = "const a = 1; /* hi */ const b = 2;";
		expect(maskCommentsAndStrings(src)).toBe("const a = 1;          const b = 2;");
	});

	it("blanks a multi-line block comment, keeping newlines and non-comment lines intact", () => {
		const src = "const a = 1;\n/*\n  multi\n  line\n*/\nconst b = 2;";
		expect(maskCommentsAndStrings(src)).toBe(
			"const a = 1;\n  \n       \n      \n  \nconst b = 2;",
		);
	});
});

describe("maskCommentsAndStrings — string backslash-escape edge cases", () => {
	it("a backslash as the very last character of the file is blanked with no char to escape", () => {
		const src = 'const s = "abc\\';
		expect(maskCommentsAndStrings(src)).toBe("const s =      ");
	});

	it("a backslash escaping a real newline inside a string keeps the newline and continues the string", () => {
		const src = 'const s = "a\\\nb"; code();';
		const out = maskCommentsAndStrings(src);
		// The escaped newline is preserved as a real newline (offsets stay
		// stable); the rest of the string content is blanked.
		expect(out).toBe("const s =    \n  ; code();");
	});

	it("a backslash escaping an ordinary character (not a newline) blanks both chars", () => {
		const src = 'const s = "a\\"b"; code();';
		const out = maskCommentsAndStrings(src);
		expect(out).toBe("const s =       ; code();");
	});
});

describe("maskCommentsAndStrings — line comments and quote-type dispatch", () => {
	it("blanks a line comment to (not including) the newline", () => {
		const src = "const a = 1; // trailing\nconst b = 2;";
		expect(maskCommentsAndStrings(src)).toBe("const a = 1;            \nconst b = 2;");
	});

	it("division is not mistaken for a comment opener", () => {
		const src = "const a = 4 / 2;";
		expect(maskCommentsAndStrings(src)).toBe(src);
	});

	it("blanks single, double, and template string literals alike", () => {
		const src = "const a = 'x'; const b = \"y\"; const c = `z`;";
		expect(maskCommentsAndStrings(src)).toBe("const a =    ; const b =    ; const c =    ;");
	});
});

describe("isCodeMatch", () => {
	it("is true for a non-blank char at offset", () => {
		expect(isCodeMatch("ab c", 0)).toBe(true);
	});

	it("is false for a blank (masked) char at offset", () => {
		expect(isCodeMatch("a  c", 1)).toBe(false);
	});

	it("is false when offset is past the end of the content (undefined char)", () => {
		expect(isCodeMatch("ab", 10)).toBe(false);
	});
});

describe("isSkippedOrTodoCall", () => {
	it("recognizes a .skip call", () => {
		expect(isSkippedOrTodoCall("it.skip(")).toBe(true);
	});

	it("recognizes a .todo call", () => {
		expect(isSkippedOrTodoCall("describe.todo(")).toBe(true);
	});

	it("is false for a plain call with no .skip/.todo", () => {
		expect(isSkippedOrTodoCall("it(")).toBe(false);
	});
});

describe("blankRange", () => {
	it("blanks the given range in place, preserving newlines", () => {
		const chars = "abc\nefg".split("");
		blankRange(chars, 1, 6);
		expect(chars.join("")).toBe("a  \n  g");
	});

	it("clamps end to chars.length so an out-of-bounds end does not throw", () => {
		const chars = "abc".split("");
		blankRange(chars, 1, 100);
		expect(chars.join("")).toBe("a  ");
	});
});
