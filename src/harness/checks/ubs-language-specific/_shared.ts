// Shared internal helpers for the UBS language-specific detector modules.
// Extracted from ubs-language-specific.ts during the 1500-line decomposition.
// Not part of the public API — only the sibling check modules import this.

import { nonNull } from "../../../lib/non-null.js";
import { lineHasNoqaSuppression } from "../shared.js";

// ===========================================
// Extension predicates
// ===========================================

export const PY_EXTS = [".py", ".pyi"] as const;
export const JS_TS_EXT_LIST = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
] as const;

export function isPyFile(ext: string): boolean {
	return (PY_EXTS as readonly string[]).includes(ext);
}

export function isJsTsFile(ext: string): boolean {
	return (JS_TS_EXT_LIST as readonly string[]).includes(ext);
}

/** Per-detector finding cap shared across the UBS backlog detectors. */
export const MATCH_LIMIT = 10;

// ===========================================
// Comment/string stripping (preserving string contents)
// ===========================================

type QuoteChar = "'" | "\"" | "`";

/**
 * Strip one already-open block comment forward from index `i` in `line`,
 * looking for its closing `* /` sequence. Returns the still-in-block state
 * and how many extra characters were consumed (0 or 1, for the closer).
 */
function consumeBlockCommentChar(
	ch: string | undefined,
	next: string | undefined,
): { closed: boolean; extraAdvance: number } {
	if (ch === "*" && next === "/") return { closed: true, extraAdvance: 1 };
	return { closed: false, extraAdvance: 0 };
}

/**
 * Advance the in-string-literal state machine by one character. `stripped`
 * always keeps the character (string contents are preserved verbatim);
 * only `quote`/`escaped` change.
 */
function consumeQuotedChar(
	ch: string,
	quote: QuoteChar,
	escaped: boolean,
): { quote: QuoteChar | null; escaped: boolean } {
	if (escaped) return { quote, escaped: false };
	if (ch === "\\") return { quote, escaped: true };
	if (ch === quote) return { quote: null, escaped: false };
	return { quote, escaped };
}

/** What to do with one character that is outside a block comment and a string literal. */
type PlainCharAction =
	| { kind: "quoteStart"; quote: QuoteChar }
	| { kind: "blockStart" }
	| { kind: "lineCommentBreak" }
	| { kind: "append" };

/**
 * Classify a character that is neither inside a block comment nor inside a
 * string literal: does it open a string, open a block comment, start a line
 * comment (ending the line), or just get appended verbatim?
 */
function classifyPlainChar(ch: string, next: string | undefined): PlainCharAction {
	if (ch === "'" || ch === "\"" || ch === "`") return { kind: "quoteStart", quote: ch };
	if (ch === "/" && next === "*") return { kind: "blockStart" };
	if (ch === "/" && next === "/") return { kind: "lineCommentBreak" };
	if (ch === "#") return { kind: "lineCommentBreak" };
	return { kind: "append" };
}

/**
 * Strip comments from a single line, given whether the line starts already
 * inside a multi-line block comment. String-literal state (`quote`) never
 * carries across lines — only `inBlock` does.
 */
function stripLineComments(line: string, inBlock: boolean): { stripped: string; inBlock: boolean } {
	let stripped = "";
	let quote: QuoteChar | null = null;
	let escaped = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		const next = line[i + 1];
		if (inBlock) {
			const closer = consumeBlockCommentChar(ch, next);
			inBlock = !closer.closed;
			i += closer.extraAdvance;
			continue;
		}
		if (quote) {
			stripped += ch;
			({ quote, escaped } = consumeQuotedChar(nonNull(ch), quote, escaped));
			continue;
		}
		const action = classifyPlainChar(nonNull(ch), next);
		if (action.kind === "quoteStart") {
			quote = action.quote;
			stripped += ch;
			continue;
		}
		if (action.kind === "blockStart") {
			inBlock = true;
			i++;
			continue;
		}
		if (action.kind === "lineCommentBreak") break;
		stripped += ch;
	}
	return { stripped, inBlock };
}

/**
 * Strip `//` line comments, `#` line comments, and block comments while
 * leaving the contents of string literals intact. Distinct from
 * `stripCommentsAndStrings` in `../shared.js`, which also blanks strings.
 */
export function stripCommentsPreservingStrings(content: string): string {
	const lines = content.split("\n");
	const out: string[] = [];
	let inBlock = false;
	for (const line of lines) {
		const result = stripLineComments(line, inBlock);
		out.push(result.stripped);
		inBlock = result.inBlock;
	}
	return out.join("\n");
}

// ===========================================
// noqa suppression range scan (Python checks)
// ===========================================

/**
 * Scan a 1-based line range of the original (unstripped) content for a
 * Bandit/flake8-style `# noqa[: <code>]` suppression that maps to the given
 * check id. Used by Python-language checks where the suppression often
 * appears on the opening line of a multi-line call but the match anchors on
 * a deeper keyword (`shell=True`, etc.).
 *
 * Both `startLine` and `endLine` are 1-based and inclusive. Returns true if
 * ANY line in that range carries a suppressing noqa for the given check.
 */
export function isNoqaSuppressedInRange(
	originalLines: string[],
	startLine: number,
	endLine: number,
	checkId: string,
): boolean {
	const lo = Math.max(1, Math.min(startLine, endLine));
	const hi = Math.min(originalLines.length, Math.max(startLine, endLine));
	for (let i = lo - 1; i < hi; i++) {
		if (lineHasNoqaSuppression(nonNull(originalLines[i]), checkId)) return true;
	}
	return false;
}
