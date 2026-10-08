// ===========================================
// Comment & string stripping through the TypeScript parser
// ===========================================
// The line scanner behind `stripComments` / `stripCommentsAndStrings` decides
// what a character means without a parser, and the H2 audit (2026-10-02)
// confirmed three misreads that change every downstream check: a private
// field `#p` read as a Python comment (the rest of the line, braces included,
// vanished), `"/*"` inside a string opened a block comment (the rest of the
// FILE vanished), and `'it\'s'` closed early. About 85 inline checks consume
// that output. When `typescript` is resolvable and the content parses as
// TS (or TSX), this module produces the SAME contract from the parser's
// tokens; otherwise it returns null and the caller keeps the line scanner
// (Python, Rust, Go, fragments, and installs without the optional dep).
//
// Contract (pinned by shared-text-utils-ast.test.ts and the heuristic suite):
// - comments become spaces of the same length; newlines stay;
// - a string's interior is REMOVED, its delimiters kept (`"x{y}"` → `""`);
// - a template keeps its backticks, `${`, `}` and expressions, not its text;
// - regex literals and JSX text stay as written;
// - the line count never changes (interior newlines are kept).

import { createHash } from "node:crypto";
import type * as TS from "typescript";
import { hasParseErrors, parseTsSource, type TsModule } from "./cyclomatic-ast.js";

export interface StripOptions {
	/** Remove string and template text as well as comments. */
	strings: boolean;
}

/** One parsed input: the compiler module, its SourceFile, and the text it was parsed from. */
interface ParsedInput {
	ts: TsModule;
	sf: TS.SourceFile;
	content: string;
}

interface Replacement {
	start: number;
	end: number;
	text: string;
}

/** `INTERLINKED_STRIP_PARSER=0` sends every caller to the line scanner: a rollback and an A/B switch for fire-rate census. */
export const STRIP_PARSER_ENV = "INTERLINKED_STRIP_PARSER";

const STRIP_MEMO_MAX = 32;
/** Insertion-ordered = LRU. Keyed by content digest + mode; null records "use the fallback". */
const stripMemo = new Map<string, string | null>();

function newlinesIn(text: string): string {
	return text.replace(/[^\n]/g, "");
}

function blankKeepingNewlines(text: string): string {
	return text.replace(/[^\n]/g, " ");
}

/** The opening and closing delimiters each literal kind keeps; its text between them is removed. */
function delimitersFor(ts: TsModule, kind: TS.SyntaxKind, text: string): [string, string] | null {
	switch (kind) {
		case ts.SyntaxKind.StringLiteral:
		case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
			return [text.slice(0, 1), text.slice(-1)];
		case ts.SyntaxKind.TemplateHead:
			return ["`", "${"];
		case ts.SyntaxKind.TemplateMiddle:
			return ["}", "${"];
		case ts.SyntaxKind.TemplateTail:
			return ["}", "`"];
		default:
			return null;
	}
}

function literalReplacement(input: ParsedInput, node: TS.Node): Replacement | null {
	const { ts, sf, content } = input;
	const start = node.getStart(sf);
	const text = content.slice(start, node.end);
	const delimiters = delimitersFor(ts, node.kind, text);
	if (!delimiters) return null;
	const [open, close] = delimiters;
	const interior = text.slice(open.length, text.length - close.length);
	return { start, end: node.end, text: open + newlinesIn(interior) + close };
}

class Collector {
	private readonly comments = new Map<number, number>();
	private readonly literals: Replacement[] = [];

	constructor(
		private readonly input: ParsedInput,
		private readonly strings: boolean,
	) {}

	visit(node: TS.Node): void {
		if (node.kind === this.input.ts.SyntaxKind.JsxText) return;
		const literal = this.strings ? literalReplacement(this.input, node) : null;
		if (literal) {
			this.noteComments(node);
			this.literals.push(literal);
			return;
		}
		const children = node.getChildren(this.input.sf);
		if (children.length === 0) this.noteComments(node);
		for (const child of children) this.visit(child);
	}

	/** A comment is the trailing trivia of the token before it or the leading trivia of the token after it. */
	private noteComments(token: TS.Node): void {
		const record = (start: number, end: number): void => {
			this.comments.set(start, end);
		};
		const { ts, content } = this.input;
		ts.forEachLeadingCommentRange(content, token.pos, record);
		ts.forEachTrailingCommentRange(content, token.end, record);
	}

	replacements(): Replacement[] {
		const { content } = this.input;
		const all = [...this.literals];
		for (const [start, end] of this.comments) {
			all.push({ start, end, text: blankKeepingNewlines(content.slice(start, end)) });
		}
		const shebang = /^#![^\n]*/.exec(content);
		if (shebang) all.push({ start: 0, end: shebang[0].length, text: " ".repeat(shebang[0].length) });
		return all.sort((a, b) => a.start - b.start);
	}
}

function applyReplacements(content: string, replacements: Replacement[]): string {
	let out = "";
	let cursor = 0;
	for (const r of replacements) {
		if (r.start < cursor) continue;
		out += content.slice(cursor, r.start) + r.text;
		cursor = r.end;
	}
	return out + content.slice(cursor);
}

/** Parse as TS, then as TSX; null when neither parses cleanly or `typescript` is absent. */
function parseCleanly(content: string): { ts: TsModule; sf: TS.SourceFile } | null {
	for (const pseudoPath of ["strip.ts", "strip.tsx"]) {
		const parsed = parseTsSource(content, pseudoPath);
		if (!parsed) return null;
		if (!hasParseErrors(parsed.sf)) return parsed;
	}
	return null;
}

function stripParsed(content: string, options: StripOptions): string | null {
	const parsed = parseCleanly(content);
	if (!parsed) return null;
	const collector = new Collector({ ...parsed, content }, options.strings);
	collector.visit(parsed.sf);
	return applyReplacements(content, collector.replacements());
}

/**
 * The parser and the token walk both recurse per nesting level, so pathological nesting (thousands of
 * open `assert(` calls) exhausts the stack. That content goes to the line scanner, which is iterative.
 */
function stripUncached(content: string, options: StripOptions): string | null {
	try {
		return stripParsed(content, options);
	} catch (error) {
		if (error instanceof RangeError) return null;
		throw error;
	}
}

/**
 * Strip comments (and, with `strings`, string and template text) from JS/TS content as the parser reads it.
 * Returns null when the content does not parse as TS or TSX, or `typescript` is not installed: the caller
 * then uses the line scanner.
 */
export function stripWithTypeScript(content: string, options: StripOptions): string | null {
	if (process.env[STRIP_PARSER_ENV] === "0") return null;
	const key = `${options.strings ? "s" : "c"}|${createHash("sha256").update(content).digest("hex")}`;
	if (stripMemo.has(key)) {
		const hit = stripMemo.get(key) ?? null;
		stripMemo.delete(key);
		stripMemo.set(key, hit);
		return hit;
	}
	const result = stripUncached(content, options);
	stripMemo.set(key, result);
	if (stripMemo.size > STRIP_MEMO_MAX) {
		const oldest = stripMemo.keys().next();
		if (!oldest.done) stripMemo.delete(oldest.value);
	}
	return result;
}
