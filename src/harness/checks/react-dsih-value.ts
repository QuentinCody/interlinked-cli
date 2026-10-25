// Value classification for the `dangerously_set_inner_html` pre_block check.
//
// The check used to fire on every line carrying the token, which blocked
// legitimate code: a `dangerouslySetInnerHTML?: {...}` props-interface member,
// `const { dangerouslySetInnerHTML: _omit, ...rest } = props` (a wrapper
// stripping the prop BEFORE spreading), `<code>dangerouslySetInnerHTML</code>`
// in a docs table, `__html: DOMPurify.sanitize(x)` (the fix_instruction's own
// remedy), a prettier-wrapped `__html:` on the line below the attribute, and a
// `const X: string = "..."` static constant (2026-10-21 adversarial review).
//
// Round 2 of that review (same day) found six more shapes a reviewer accepts:
// a whole static object constant (`dangerouslySetInnerHTML={MARKUP}` with
// `const MARKUP = { __html: '<svg/>' }`, also with a type annotation or a
// sanitized member), a direct static template literal longer than the
// attribute window (the Next.js theme-flash `<script>`), a sanitizer call
// whose options object wraps past the window (sanitize-html), a trailing
// comment after the identifier (`__html: css, // inlined`), and an es6-string-
// html tag comment before the literal (`const SVG = /* html */ `...``). The
// window now only LOCATES the value; the value itself is read to wherever it
// structurally closes.
//
// Round 3 (resumed review, same day): a memoized markup object (`const m =
// useMemo(() => ({ __html: DOMPurify.sanitize(raw) }), [raw])` passed whole),
// a type-only cast after the value (`__html: CSS as string`), and a quoted
// `"__html"` key are classified by the same rules. An env interpolation in a
// template (`${process.env.NEXT_PUBLIC_GA_ID}`) and a static-map member
// (`icons[name]`) stay opaque and fire.
//
// This module answers two questions on the comment/string-stripped text and
// the original text respectively: "is this token a USAGE?" and "is the
// `__html` value static or sanitized?". Anything unclear is NOT static — the
// check fires.

import type * as TS from "typescript";
import { hasParseErrors, parseTsSource, type TsModule } from "./cyclomatic-ast.js";

/**
 * A usage of the prop ON THE FIRST LINE of the tested text: a JSX attribute
 * (`dangerouslySetInnerHTML=`), or a props-object member whose `__html` value
 * is an expression rather than a type (`dangerouslySetInnerHTML: { __html:
 * string }` is an interface member; the value may continue on later lines).
 * `dangerouslySetInnerHTML?:` and destructuring aliases (`: _omit`) do not
 * match. Tested against comment/string-stripped text.
 */
export const DSIH_USAGE_RE =
	/^[^\n]*?\bdangerouslySetInnerHTML\s*(?:=(?!=)|:\s*\{\s*__html\s*:\s*(?=\S)(?!(?:string|TrustedHTML|unknown|any|never)\b))/;

/** Lines (including the attribute line) a wrapped `{{ __html: ... }}` may extend over. */
export const DSIH_WINDOW_LINES = 4;

/** Both usage shapes on the first line, up to the start of the `__html` value. Original text. */
const DSIH_VALUE_OPEN_RE = /^[^\n]*?\bdangerouslySetInnerHTML\s*(?:=\s*\{\s*\{|:\s*\{)\s*["']?__html["']?\s*:\s*/;

/** The attribute form whose whole value is one identifier: `dangerouslySetInnerHTML={MARKUP}`. */
const DSIH_WHOLE_IDENTIFIER_RE = /^[^\n]*?\bdangerouslySetInnerHTML\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/;

/** Sanitizer calls the check accepts as the `__html` value. */
const SANITIZER_CALL_RE =
	/^(?:(?:DOMPurify|dompurify|purify)\.sanitize|sanitize(?:Html|HTML)?|filterXSS|xss)\s*\(/;

/** An optional `/* html *\/`-style tag comment between `=` and a literal (es6-string-html idiom). */
const TAG_COMMENT = String.raw`(?:\/\*[\s\S]*?\*\/\s*)?`;

/** A line or block comment that may sit between the value and the closing `}`. */
const TRAILING_COMMENT = String.raw`(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)`;

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*/;
// A trailing comma (`__html: css,` on its own line) and a trailing comment
// (`__html: css, // inlined`) are prettier output.
// A type-only cast (`CSS as string`, `MARKUP satisfies X`) leaves the runtime
// value unchanged (round 3 of the review).
const TYPE_CAST = String.raw`(?:\s+(?:as|satisfies)\s+[A-Za-z_$][\w$.]*(?:\[\])?)?`;
const CLOSES_HTML_OBJECT_RE = new RegExp(String.raw`^${TYPE_CAST}\s*,?(?:\s*${TRAILING_COMMENT})*\s*\}`);

/** Longest value head the anchored prefix regexes need to see. */
const HEAD_CHARS = 256;
/** Longest run of whitespace, comma and comments the closing-brace test reads. */
const CLOSE_CHARS = 4096;

function escapeRegExp(name: string): string {
	return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Index of the closing backtick of a template literal whose body starts at
 * `start` (just after the opening backtick), or -1 when the body carries a
 * `${...}` interpolation or never closes.
 */
export function uninterpolatedTemplateEnd(content: string, start: number): number {
	let i = start;
	let depth = 0; // ${...} brace depth
	while (i < content.length) {
		const c = content[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (depth === 0 && c === "`") {
			return content.slice(start, i).includes("${") ? -1 : i;
		}
		if (c === "$" && content[i + 1] === "{") {
			depth++;
			i += 2;
			continue;
		}
		if (depth > 0 && c === "{") depth++;
		if (depth > 0 && c === "}") depth--;
		i++;
	}
	return -1;
}

/** Index of the quote closing the string literal opening at `start`, or -1. */
function closingQuoteIndex(content: string, start: number): number {
	const quote = content[start];
	for (let i = start + 1; i < content.length; i++) {
		if (content[i] === "\\") {
			i++;
			continue;
		}
		if (content[i] === quote) return i;
		if (content[i] === "\n") return -1;
	}
	return -1;
}

/** Index where the literal opening at `at` closes, or -1 (template: static only). */
function literalEnd(content: string, at: number): number {
	return content[at] === "`" ? uninterpolatedTemplateEnd(content, at + 1) : closingQuoteIndex(content, at);
}

/**
 * Index of the bracket closing the one opening at `open`, skipping string and
 * template literals (their contents may hold brackets), or -1.
 */
function balancedCloseIndex(content: string, open: number): number {
	let depth = 0;
	for (let i = open; i < content.length; i++) {
		const c = content[i];
		if (c === '"' || c === "'" || c === "`") {
			const close = literalEnd(content, i);
			if (close === -1) return -1;
			i = close;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		if (c === ")" || c === "]" || c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * True when `name` is declared in `content` as a `const` bound to a string or
 * template literal with NO `${...}` interpolation. Conservative — any unclear
 * case returns false (the check fires). Only `const` is considered (not
 * `let` / `var`) because those can be reassigned. A type annotation
 * (`const CSS: string = ...`) and a tag comment (`= /* html *\/ `...``) are
 * allowed.
 *
 * 139-repo audit: Expo Router boilerplate — `const responsiveBackground
 * = `body { background-color: #fff; ... }`;` is the canonical static CSS
 * template-literal pattern.
 */
export function isStaticStringConstant(content: string, name: string): boolean {
	const escaped = escapeRegExp(name);
	const stringRe = new RegExp(
		String.raw`\bconst\s+${escaped}\s*(?::[^=\n]*)?=\s*${TAG_COMMENT}(['"])((?:\\.|(?!\1).)*)\1`,
	);
	if (stringRe.test(content)) return true;
	const tplOpen = new RegExp(String.raw`\bconst\s+${escaped}\s*(?::[^=\n]*)?=\s*${TAG_COMMENT}\``);
	const m = tplOpen.exec(content);
	if (!m) return false;
	return uninterpolatedTemplateEnd(content, m.index + m[0].length) >= 0;
}

/** True when `name` is a `const` whose initializer is a recognized sanitizer call. */
export function isSanitizedConstant(content: string, name: string): boolean {
	const parsed = parseTsSource(content, "markup.tsx");
	if (!parsed || hasParseErrors(parsed.sf)) return false;
	const declarations: TS.VariableDeclaration[] = [];
	const visit = (node: TS.Node): void => {
		if (parsed.ts.isVariableDeclaration(node) && parsed.ts.isIdentifier(node.name) && node.name.text === name) declarations.push(node);
		parsed.ts.forEachChild(node, visit);
	};
	visit(parsed.sf);
	const declaration = declarations.length === 1 ? declarations[0] : undefined;
	if (!declaration?.initializer || !parsed.ts.isVariableDeclarationList(declaration.parent)) return false;
	if ((declaration.parent.flags & parsed.ts.NodeFlags.Const) === 0) return false;
	return isCompleteSanitizerExpression(parsed.ts, declaration.initializer);
}

/** The whole initializer (or memo callback result) must be the sanitizer call. */
function isCompleteSanitizerExpression(ts: TsModule, expression: TS.Expression): boolean {
	if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
		return isCompleteSanitizerExpression(ts, expression.expression);
	}
	if (!ts.isCallExpression(expression)) return false;
	if (SANITIZER_CALL_RE.test(`${expression.expression.getText()}(`)) return true;
	if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "useMemo") return false;
	const callback = expression.arguments[0];
	return callback !== undefined && ts.isArrowFunction(callback) && !ts.isBlock(callback.body) && isCompleteSanitizerExpression(ts, callback.body);
}

/** An optional `useMemo(() => (` wrapper around an object initializer (round 3 of the review). */
const MEMO_OBJECT_OPEN = String.raw`(?:useMemo\s*\(\s*\(\s*\)\s*=>\s*\(\s*)?`;

/** Index just past `__html:` in `const <name>(: T)? = (useMemo(() => ()?{ __html: ...`, or -1. */
function objectConstantValueStart(content: string, name: string): number {
	const decl = new RegExp(
		String.raw`\bconst\s+${escapeRegExp(name)}\s*(?::[^=\n]*)?=\s*${MEMO_OBJECT_OPEN}\{\s*["']?__html["']?\s*:\s*`,
	);
	const m = decl.exec(content);
	return m ? m.index + m[0].length : -1;
}

/** True when the `{ __html: ... }` object closes right after index `at` (comma / comment allowed). */
function closesHtmlObjectAt(content: string, at: number): boolean {
	return CLOSES_HTML_OBJECT_RE.test(content.slice(at, at + CLOSE_CHARS));
}

/** True when `[valueStart, close]` is the WHOLE value. */
function isWholeValue(content: string, close: number): boolean {
	return close !== -1 && closesHtmlObjectAt(content, close + 1);
}

/** True when the value is a recognized sanitizer call that is the WHOLE value. */
function isWholeSanitizerCall(content: string, valueStart: number): boolean {
	const m = SANITIZER_CALL_RE.exec(content.slice(valueStart, valueStart + HEAD_CHARS));
	if (!m) return false;
	return isWholeValue(content, balancedCloseIndex(content, valueStart + m[0].length - 1));
}

/**
 * Classify the value starting at `valueStart` (just past `__html:`): a
 * string/template literal with no interpolation, a same-file static or
 * sanitized `const`, or a recognized sanitizer call — each only when it is the
 * whole value.
 */
function isStaticValueAt(content: string, valueStart: number): boolean {
	const first = content[valueStart];
	if (first === '"' || first === "'" || first === "`") {
		return isWholeValue(content, literalEnd(content, valueStart));
	}
	const ident = IDENTIFIER_RE.exec(content.slice(valueStart, valueStart + HEAD_CHARS))?.[0];
	if (ident && closesHtmlObjectAt(content, valueStart + ident.length)) {
		return isStaticStringConstant(content, ident) || isSanitizedConstant(content, ident);
	}
	return isWholeSanitizerCall(content, valueStart);
}

/**
 * Decide whether the `__html` value of the usage that starts in
 * `content[windowStart, windowEnd)` is static (a string/template literal with
 * no interpolation, a same-file static `const`) or sanitized (a recognized
 * sanitizer call, directly or through a same-file `const`). The window only
 * locates the value; the value is read to where it structurally closes. A
 * whole-value identifier (`={MARKUP}`) resolves through a same-file
 * `const MARKUP = { __html: ... }` by the same rules. False when the value
 * cannot be classified — the check then fires.
 */
export function isStaticDsihValue(content: string, windowStart: number, windowEnd: number): boolean {
	const head = content.slice(windowStart, windowEnd);
	const open = DSIH_VALUE_OPEN_RE.exec(head);
	if (open) return isStaticValueAt(content, windowStart + open.index + open[0].length);
	const whole = DSIH_WHOLE_IDENTIFIER_RE.exec(head)?.[1];
	if (!whole) return false;
	const valueStart = objectConstantValueStart(content, whole);
	return valueStart !== -1 && isStaticValueAt(content, valueStart);
}
