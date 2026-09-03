// ===========================================
// Per-edit mutation — content fingerprints for survivor reconciliation
// ===========================================
// The pure AST half of survivor-moves.ts (extracted 2026-09-02 for the
// 500-line cap): index a source by node span, find every AST occurrence of a
// mutated expression, and hash "the same mutant content" — the normalized
// token stream of the mutated expression plus the normalized skeleton of its
// innermost enclosing statement with nested block interiors blanked. No
// identity, no manifest: the caller decides what a matching fingerprint means.

import { createHash } from "node:crypto";
import type * as TS from "typescript";
import { type ParsedTsSource, parseTsSource, type TsModule } from "../checks/cyclomatic-ast.js";

interface Span {
	start: number;
	end: number;
}

/** One parsed source plus its node spans — built once per side. */
export interface SourceIndex {
	parsed: ParsedTsSource;
	spans: Span[];
	/** `${start}:${end}` → the DEEPEST node with that exact span. */
	bySpan: Map<string, TS.Node>;
}

function spanKey(start: number, end: number): string {
	return `${start}:${end}`;
}

/** One side's source: the identity-anchoring path plus the text to parse. */
export interface SourceText {
	/** The SAME string `deriveIdentities` was given — symbolIds hash it verbatim. */
	file: string;
	content: string;
}

/** Parse `content` and index every AST node by its exact span. Null when the
 *  optional `typescript` dependency is absent (no reconciliation, status quo). */
export function indexSource(source: SourceText): SourceIndex | null {
	const parsed = parseTsSource(source.content, source.file);
	if (parsed === null) return null;
	const { ts, sf } = parsed;
	const spans: Span[] = [];
	const bySpan = new Map<string, TS.Node>();
	const walk = (node: TS.Node): void => {
		const start = node.getStart(sf);
		const end = node.getEnd();
		spans.push({ start, end });
		// Preorder: a child overwrites its parent's entry, so an identical span
		// resolves to the deepest node — the expression, not a wrapper around it.
		bySpan.set(spanKey(start, end), node);
		ts.forEachChild(node, walk);
	};
	ts.forEachChild(sf, walk);
	return { parsed, spans, bySpan };
}

/** Distinct start offsets of AST nodes whose exact text is `lexeme`, ascending.
 *  AST nodes only: the `>` closing a type argument is not a node, so it does
 *  not inflate the ordinal of a later `a > b` the engine actually mutated. */
export function offsetsOfLexeme(index: SourceIndex, lexeme: string): number[] {
	const text = index.parsed.sf.text;
	const out = new Set<number>();
	for (const span of index.spans) {
		if (span.end - span.start !== lexeme.length) continue;
		if (text.slice(span.start, span.end) === lexeme) out.add(span.start);
	}
	return [...out].sort((a, b) => a - b);
}

/** Token-stream canonicalisation: spacing- and comment-insensitive. Mirrors
 *  identity.ts's private helper of the same name on purpose — that module is a
 *  digest-pinned contract, so it cannot grow an export for this layer to share. */
function normalizeTokens(ts: TsModule, text: string): string {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ true, ts.LanguageVariant.Standard, text);
	const out: string[] = [];
	let tok = scanner.scan();
	while (tok !== ts.SyntaxKind.EndOfFileToken) {
		out.push(scanner.getTokenText());
		tok = scanner.scan();
	}
	return out.join(" ");
}

/** Nearest statement ancestor, or null at module level with none. A function
 *  body block is not a statement (TS's own `isStatement`), so a mutant in a
 *  body anchors to the statement it sits in, never to the whole body. */
function enclosingStatement(ts: TsModule, node: TS.Node): TS.Node | null {
	// SAFETY: `typescript`'s own .d.ts types `Node.parent` as non-optional
	// `Node`, but at runtime it is `undefined` for the SourceFile root and any
	// node visited before binding — the compiler API's well-known type lie.
	// Cast to the true runtime shape so the loop's null check stays live
	// instead of reading as an impossible branch.
	let cur = node.parent as TS.Node | undefined;
	while (cur !== undefined && !ts.isSourceFile(cur)) {
		if (ts.isStatement(cur)) return cur;
		// SAFETY: same `Node.parent` type-lie as above.
		cur = cur.parent as TS.Node | undefined;
	}
	return null;
}

/** Spans of the OUTERMOST blocks nested under `stmt` (never `stmt` itself). */
function nestedBlockSpans(ts: TsModule, sf: TS.SourceFile, stmt: TS.Node): Span[] {
	const spans: Span[] = [];
	const walk = (node: TS.Node): void => {
		if (ts.isBlock(node)) {
			spans.push({ start: node.getStart(sf), end: node.getEnd() });
			return;
		}
		ts.forEachChild(node, walk);
	};
	ts.forEachChild(stmt, walk);
	return spans;
}

/** The statement's text with every nested block interior replaced by `{}` —
 *  its SHAPE. The body of an `if` is its own set of statements; a change
 *  there is not a change to the condition's statement. */
function statementSkeleton(ts: TsModule, sf: TS.SourceFile, stmt: TS.Node): string {
	const text = sf.text;
	const parts: string[] = [];
	let cursor = stmt.getStart(sf);
	for (const block of nestedBlockSpans(ts, sf, stmt)) {
		parts.push(text.slice(cursor, block.start), "{}");
		cursor = block.end;
	}
	parts.push(text.slice(cursor, stmt.getEnd()));
	return parts.join("");
}

/**
 * Content fingerprint of the mutant whose expression text `lexeme` starts at
 * `offset`: sha256 over the normalized expression and the normalized skeleton
 * of its enclosing statement. Null when no AST node spans exactly that text
 * (the engine and this parser disagree about the site) or no statement
 * encloses it — both read as "cannot match", never as a match.
 */
export function fingerprintAt(index: SourceIndex, offset: number, lexeme: string): string | null {
	const node = index.bySpan.get(spanKey(offset, offset + lexeme.length));
	if (node === undefined) return null;
	const { ts, sf } = index.parsed;
	const stmt = enclosingStatement(ts, node);
	if (stmt === null) return null;
	const expression = normalizeTokens(ts, lexeme);
	const statement = normalizeTokens(ts, statementSkeleton(ts, sf, stmt));
	return createHash("sha256").update(JSON.stringify([expression, statement]), "utf8").digest("hex");
}
