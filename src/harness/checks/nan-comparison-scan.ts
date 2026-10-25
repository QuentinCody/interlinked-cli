// ===========================================
// nan_comparison — literal-shape exemptions
// ===========================================
// Sibling of agent-safety-js-correctness.ts (that file sits near the per-file
// line cap). `stripCommentsAndStrings` leaves regex literals and JSX text as
// written by contract, and both carry the text `x === NaN` in legitimate code:
// a lint rule's own pattern literal, and a docs component that explains the
// semantics in prose. The 2026-10-21 adversarial review also found that a
// MEMBER named NaN (`TokenKind.NaN === kind`, `stats?.NaN !== undefined`) is
// not the global — only `Number.NaN` is the global under another name.

import type * as TS from "typescript";
import { hasParseErrors, parseTsSource } from "./cyclomatic-ast.js";
import { getExtension } from "./shared.js";

/**
 * `x === NaN` / `x == NaN` / `NaN !== x` and friends. A `NaN` on the RIGHT of
 * the operator is always the global (nothing else can follow `===` there). A
 * `NaN` on the LEFT is the global only when it is not a member access: a `.`
 * or `?.` before it names a property of a user object (an enum member, a
 * histogram bucket). `Number.NaN` is the one member spelling that IS the global.
 */
export const NAN_COMPARISON = /[!=]==?\s*NaN\b|(?:(?<![.\w$])NaN|\bNumber\s*\.\s*NaN)\s*[!=]==?/;

/**
 * A single-line regex literal at a position where the JS lexer accepts one:
 * after an operator or opener (`=`, `=>`, `(`, `,`, `:`, `[`, `!`, `&`, `|`,
 * `?`, `{`, `}`, `;`, `<`, `>`, `+`, `-`, `*`, `%`, `~`, `^`), after a keyword
 * that takes an expression (`return`, `typeof`, `case` — the `switch (true)
 * { case /re/.test(s): }` idiom —, `yield`, `void`, `delete`, `throw`, `else`;
 * not a member named so), or at line start. A `/` after an identifier, number
 * or `)` is division and is left alone, so `total / count === NaN / 2` still fires.
 */
const REGEX_LITERAL_AT_LEXER_START =
	/(^|[=(,:[!&|?{};<>+\-*%~^]|(?<![.\w$])(?:return|typeof|case|yield|void|delete|throw|else))(\s*)(\/(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[dgimsuyv]*)/gm;

/** Blank regex literals to same-length spaces so a pattern that DETECTS `=== NaN` is not reported as using it. */
export function blankRegexLiterals(stripped: string): string {
	return stripped.replace(
		REGEX_LITERAL_AT_LEXER_START,
		(_m, pre: string, ws: string, re: string) => pre + ws + " ".repeat(re.length),
	);
}

/**
 * Blank JSX text (the prose between tags) in a JSX-capable file to
 * same-length spaces, keeping newlines. Runs on the ORIGINAL content so the
 * parser's offsets apply; the caller strips comments and strings afterwards.
 * Content that does not parse, or a missing `typescript`, is returned as-is:
 * the exemption then simply does not apply. `.js` / `.mjs` / `.cjs` are
 * JSX-capable too (CRA and Next.js pages carry JSX in `.js`; the parser reads
 * those script kinds with the JSX variant), while `.ts` / `.mts` / `.cts`
 * are not: there `<T>x` is a type assertion (2026-10-21 adversarial review).
 */
const JSX_CAPABLE_EXTS = new Set([".tsx", ".jsx", ".js", ".mjs", ".cjs"]);

export function blankJsxText(content: string, filePath: string): string {
	if (!JSX_CAPABLE_EXTS.has(getExtension(filePath))) return content;
	const parsed = parseTsSource(content, filePath);
	if (!parsed || hasParseErrors(parsed.sf)) return content;
	const ranges: Array<[number, number]> = [];
	const visit = (node: TS.Node): void => {
		// JsxText is raw: `pos` is the character after the previous `>` or `}`.
		if (node.kind === parsed.ts.SyntaxKind.JsxText) ranges.push([node.pos, node.end]);
		else node.forEachChild(visit);
	};
	visit(parsed.sf);
	if (ranges.length === 0) return content;
	let out = "";
	let cursor = 0;
	for (const [start, end] of ranges) {
		out += content.slice(cursor, start) + content.slice(start, end).replace(/[^\n]/g, " ");
		cursor = end;
	}
	return out + content.slice(cursor);
}
