// ===========================================
// Comment/string/regex/JSX-text masking through the TypeScript parser
// ===========================================
// The char-level state machine in `test-hygiene-masking.ts` cannot decide what a
// `/` is without a parser: five review rounds (2026-09-30) each found a valid
// construct it misread — `count++ / 2`, `return /"/`, `count! / 2`, `π / 2`,
// `if (ready) /"/.test(x)`, `return/*c*/typeof /"/`, `</div>` — and every
// misread hid or invented a finding. The parser already used by the cyclomatic
// gate knows the answer, so when `typescript` is resolvable this module masks
// from its tokens; the state machine remains the fallback for an install
// without the optional dependency.

import type * as TS from "typescript";
import { parseTsSource, type TsModule } from "./cyclomatic-ast.js";

function literalKinds(ts: TsModule): Set<TS.SyntaxKind> {
	return new Set([
		ts.SyntaxKind.StringLiteral,
		ts.SyntaxKind.NoSubstitutionTemplateLiteral,
		ts.SyntaxKind.TemplateHead,
		ts.SyntaxKind.TemplateMiddle,
		ts.SyntaxKind.TemplateTail,
		ts.SyntaxKind.RegularExpressionLiteral,
		ts.SyntaxKind.JsxText,
	]);
}

/**
 * Blank every comment, string, template chunk, regex literal and JSX text in `content`, preserving length,
 * newlines and offsets, as the parser tokenizes them. `filePath` selects the script kind (a `.tsx` / `.jsx`
 * file parses JSX; anything else parses `<T>` as a type assertion). Returns null when `typescript` is absent.
 */
export function maskWithTypeScript(content: string, filePath: string): string | null {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return null;
	const { ts, sf } = parsed;
	const chars = content.split("");
	const literals = literalKinds(ts);
	const blank = (start: number, end: number): void => {
		for (let i = start; i < Math.min(end, chars.length); i++) if (chars[i] !== "\n") chars[i] = " ";
	};
	// A comment on the line of the previous token is that token's TRAILING trivia; one after a line break (or at
	// the file start) is LEADING trivia of the next token. Both scans per token cover every comment once.
	const blankComments = (token: TS.Node): void => {
		ts.forEachLeadingCommentRange(content, token.pos, (start, end) => blank(start, end));
		ts.forEachTrailingCommentRange(content, token.end, (start, end) => blank(start, end));
	};
	const visit = (node: TS.Node): void => {
		if (literals.has(node.kind)) {
			blankComments(node);
			blank(node.kind === ts.SyntaxKind.JsxText ? node.pos : node.getStart(sf), node.end);
			return;
		}
		const children = node.getChildren(sf);
		if (children.length === 0) {
			blankComments(node);
			return;
		}
		for (const child of children) visit(child);
	};
	visit(sf);
	return chars.join("");
}
