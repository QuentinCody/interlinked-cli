// Dead literal store: a local initial value that the very next statement overwrites.
//
// CLASS: redundancy. The score metric `redundancy.dead_stores` measures this
// (src/lib/metrics/adapter-dead-stores.ts); this check is its judgment, with the
// same definition (the adapter calls `scanDeadLiteralStoresTs` below).
//
// FIRES WHEN: in a TS/JS block, `let|var x = <literal>;` is directly followed by
// the statement `x = <expression that does not mention x>;` and nothing runs
// between the two. In Python, `x = <literal>` is followed (blank and comment
// lines aside, same indent) by `x = <expression that does not mention x>`.
//
// DOES NOT FIRE: on a non-literal initializer, an overwrite that reads x, a
// statement between the two, an annotated or augmented or chained assignment, a
// different indent, a line inside a triple-quoted string, or a file that does not parse.
//
// Only adjacent statements can establish an overwrite without an intervening read.
//
// KNOWN GAPS: only adjacent pairs. Initial values overwritten on every path after
// a branch, loop, or call are not found. Python is a line rule; the score uses the
// Python AST, so a pair split by an unusual continuation may differ.

import type * as TS from "typescript";
import { hasParseErrors, parseTsSource, type ParsedTsSource } from "./cyclomatic-ast.js";
import type { InlineMatch } from "./shared.js";

const TS_RE = /\.[mc]?[jt]sx?$/;
const PY_RE = /\.pyi?$/;

function literal(node: TS.Expression, { ts }: ParsedTsSource): boolean {
	return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword
		|| node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword;
}

function referencesName(node: TS.Node, name: string, parsed: ParsedTsSource): boolean {
	if (parsed.ts.isIdentifier(node) && node.text === name) return true;
	let found = false;
	parsed.ts.forEachChild(node, child => { if (referencesName(child, name, parsed)) found = true; });
	return found;
}

function overwrittenPair(first: TS.Statement, next: TS.Statement, parsed: ParsedTsSource): TS.VariableDeclaration | null {
	const { ts } = parsed;
	if (!ts.isVariableStatement(first) || first.declarationList.declarations.length !== 1 || !ts.isExpressionStatement(next)) return null;
	const declaration = first.declarationList.declarations[0];
	if (!declaration || !ts.isIdentifier(declaration.name) || !declaration.initializer || !literal(declaration.initializer, parsed)) return null;
	const expression = next.expression;
	if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
	if (!ts.isIdentifier(expression.left) || expression.left.text !== declaration.name.text) return null;
	if (referencesName(expression.right, declaration.name.text, parsed)) return null;
	return declaration;
}

/** The one TS/JS definition: 1-based lines of dead literal stores, and the number of initializers (the metric's denominator). */
export function scanDeadLiteralStoresTs(parsed: ParsedTsSource): { initializers: number; lines: number[] } {
	const result: { initializers: number; lines: number[] } = { initializers: 0, lines: [] };
	const { ts, sf } = parsed;
	function visit(node: TS.Node): void {
		if (ts.isVariableDeclaration(node) && node.initializer) result.initializers++;
		if (ts.isBlock(node)) {
			for (let index = 0; index + 1 < node.statements.length; index++) {
				const first = node.statements[index], next = node.statements[index + 1];
				const declaration = first && next ? overwrittenPair(first, next, parsed) : null;
				if (declaration) result.lines.push(sf.getLineAndCharacterOfPosition(declaration.getStart(sf)).line + 1);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sf);
	return result;
}

const PY_LITERAL = String.raw`(?:[+-]?\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|None|True|False|'[^'\\]*'|"[^"\\]*")`;
const PY_FIRST = new RegExp(String.raw`^(\s*)([A-Za-z_]\w*)\s*=\s*${PY_LITERAL}\s*(?:#.*)?$`);
const PY_SECOND = /^(\s*)([A-Za-z_]\w*)\s*=(?!=)\s*(\S.*)$/;

function balanced(text: string): boolean {
	const count = (chars: string): number => [...text].filter(char => chars.includes(char)).length;
	return count("([{") === count(")]}") && !text.trimEnd().endsWith("\\");
}

function secondOverwrites(line: string, indent: string, name: string): boolean {
	const match = PY_SECOND.exec(line);
	if (!match || match[1] !== indent || match[2] !== name) return false;
	const value = match[3] ?? "";
	if (new RegExp(String.raw`\b${name}\b`).test(value) || !balanced(value)) return false;
	return !/(?<![=!<>:])=(?!=)/.test(value.replace(/(["']).*?\1/g, '""'));
}

function inTripleQuote(lines: readonly string[]): boolean[] {
	const flags: boolean[] = [];
	let open = false;
	for (const line of lines) {
		flags.push(open);
		const marks = (line.match(/"""|'''/g) ?? []).length;
		if (marks % 2 === 1) open = !open;
		if (marks > 0 && open) flags[flags.length - 1] = true;
	}
	return flags;
}

function findPython(content: string): InlineMatch[] {
	const lines = content.split("\n");
	const quoted = inTripleQuote(lines);
	const out: InlineMatch[] = [];
	for (let index = 0; index < lines.length; index++) {
		const first = quoted[index] ? null : PY_FIRST.exec(lines[index] ?? "");
		if (!first) continue;
		let next = index + 1;
		while (next < lines.length && (/^\s*(?:#.*)?$/.test(lines[next] ?? "")) && !quoted[next]) next++;
		if (next >= lines.length || quoted[next]) continue;
		if (secondOverwrites(lines[next] ?? "", first[1] ?? "", first[2] ?? "")) out.push({ line: index + 1, text: (lines[index] ?? "").trim().slice(0, 150) });
	}
	return out;
}

/** Find dead literal stores in a TS/JS or Python source. */
export function findDeadLiteralStores(content: string, filePath: string): InlineMatch[] {
	if (PY_RE.test(filePath)) return findPython(content);
	if (!TS_RE.test(filePath)) return [];
	const parsed = parseTsSource(content, filePath);
	if (!parsed || hasParseErrors(parsed.sf)) return [];
	const rawLines = content.split("\n");
	return scanDeadLiteralStoresTs(parsed).lines.map(line => ({ line, text: (rawLines[line - 1] ?? "").trim().slice(0, 150) }));
}
