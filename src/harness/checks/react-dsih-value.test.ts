// Companion tests for the `__html` value classifier behind the
// `dangerously_set_inner_html` pre_block check (2026-10-21 adversarial review).

import { describe, expect, it } from "vitest";
import {
	DSIH_USAGE_RE,
	DSIH_WINDOW_LINES,
	isSanitizedConstant,
	isStaticDsihValue,
	isStaticStringConstant,
	uninterpolatedTemplateEnd,
} from "./react-dsih-value.js";

function classify(code: string): boolean {
	return isStaticDsihValue(code, 0, code.length);
}

describe("DSIH_USAGE_RE — usage shapes", () => {
	it("P1: matches the JSX attribute form", () => {
		expect(DSIH_USAGE_RE.test("<div dangerouslySetInnerHTML={{ __html: x }} />")).toBe(true);
	});

	it("P2: matches a props-object member with an expression value", () => {
		expect(DSIH_USAGE_RE.test("createElement('div', { dangerouslySetInnerHTML: { __html: x } })")).toBe(true);
	});

	it("N1: does not match an optional interface member", () => {
		expect(DSIH_USAGE_RE.test("dangerouslySetInnerHTML?: { __html: string };")).toBe(false);
	});

	it("N2: does not match a required interface member typed `string`", () => {
		expect(DSIH_USAGE_RE.test("dangerouslySetInnerHTML: { __html: string | TrustedHTML };")).toBe(false);
	});

	it("N3: does not match a destructuring alias or bare JSX text", () => {
		expect(DSIH_USAGE_RE.test("const { dangerouslySetInnerHTML: _omit, ...rest } = props;")).toBe(false);
		expect(DSIH_USAGE_RE.test("<code>dangerouslySetInnerHTML</code>")).toBe(false);
	});

	it("window covers a prettier-wrapped attribute", () => {
		expect(DSIH_WINDOW_LINES).toBeGreaterThanOrEqual(3);
	});
});

describe("uninterpolatedTemplateEnd", () => {
	it("P1: returns the closing backtick index of a static template", () => {
		const code = "const t = `abc{$def`;";
		expect(uninterpolatedTemplateEnd(code, code.indexOf("`") + 1)).toBe(code.lastIndexOf("`"));
	});

	it("N1: returns -1 for an interpolated or unterminated template", () => {
		expect(uninterpolatedTemplateEnd("`a${b}c`", 1)).toBe(-1);
		expect(uninterpolatedTemplateEnd("`never closes", 1)).toBe(-1);
	});
});

describe("isStaticStringConstant / isSanitizedConstant", () => {
	it("P1: const with a type annotation and a string literal is static", () => {
		expect(isStaticStringConstant("const CSS: string = `.a {}`;", "CSS")).toBe(true);
		expect(isStaticStringConstant('export const X = "<p/>";', "X")).toBe(true);
	});

	it("N1: let / interpolated / undeclared are not static", () => {
		expect(isStaticStringConstant("let html = '<p/>';", "html")).toBe(false);
		expect(isStaticStringConstant("const html = `<p>${u}</p>`;", "html")).toBe(false);
		expect(isStaticStringConstant("", "mystery")).toBe(false);
	});

	it("P2: const bound to a sanitizer call, directly or through useMemo, is sanitized", () => {
		expect(isSanitizedConstant("const clean = DOMPurify.sanitize(raw);", "clean")).toBe(true);
		expect(isSanitizedConstant("const clean = useMemo(() => sanitizeHtml(raw), [raw]);", "clean")).toBe(true);
	});

	it("N2: a const whose initializer only CONTAINS a sanitizer call is not sanitized", () => {
		expect(isSanitizedConstant("const clean = raw + DOMPurify.sanitize(x);", "clean")).toBe(false);
	});
	it("does not exempt a sanitizer result followed by unsanitized data", () => {
		expect(isSanitizedConstant("const clean = DOMPurify.sanitize(x) + raw;", "clean")).toBe(false);
		expect(isSanitizedConstant("const clean = useMemo(() => sanitizeHtml(x) + raw, [x]);", "clean")).toBe(false);
		expect(isSanitizedConstant("const clean = useMemo(() => sanitizeHtml(x), [x]) + raw;", "clean")).toBe(false);
	});
	it("accepts a complete sanitizer call with multiline options", () => {
		expect(isSanitizedConstant("const clean = DOMPurify.sanitize(x, {\n ALLOWED_TAGS: ['b']\n});", "clean")).toBe(true);
	});
});

describe("isStaticDsihValue", () => {
	it("P1: a direct string literal that is the whole value", () => {
		expect(classify("<span dangerouslySetInnerHTML={{ __html: '&nbsp;' }} />")).toBe(true);
	});

	it("P2: a sanitizer call that is the whole value, with brackets inside its arguments", () => {
		expect(classify("<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(x, { ALLOWED_TAGS: [')'] }) }} />")).toBe(
			true,
		);
	});

	it("P3: a wrapped attribute whose identifier resolves to a static const", () => {
		const code = "const css = `b {}`;\n<style\n  dangerouslySetInnerHTML={{\n    __html: css,\n  }}\n/>";
		// The window starts at the attribute's own line, as the check passes it.
		const attributeLine = code.indexOf("\n  dangerouslySetInnerHTML") + 1;
		expect(isStaticDsihValue(code, attributeLine, code.length)).toBe(true);
		expect(classify(code)).toBe(false);
	});

	it("N1: a literal concatenated with an expression is not static", () => {
		expect(classify("<div dangerouslySetInnerHTML={{ __html: '<b>' + user }} />")).toBe(false);
	});

	it("N2: a sanitizer call followed by more expression is not static", () => {
		expect(classify("<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(a) + b }} />")).toBe(false);
	});

	it("N3: member access, other calls, and an unresolvable identifier are not static", () => {
		expect(classify("<div dangerouslySetInnerHTML={{ __html: state.value }} />")).toBe(false);
		expect(classify("<div dangerouslySetInnerHTML={{ __html: getHtml() }} />")).toBe(false);
		expect(classify("<div dangerouslySetInnerHTML={{ __html: mystery }} />")).toBe(false);
	});

	it("N4: a usage with no `__html` object in the window is not static", () => {
		expect(classify("<div dangerouslySetInnerHTML={props.dangerouslySetInnerHTML} />")).toBe(false);
	});
});
