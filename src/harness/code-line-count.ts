// ===========================================
// Code-line counter — comment/string-aware line classification
// ===========================================
// The comment-aware sibling of `large-file-policy.ts::countLines`, extracted
// verbatim from that module (2026-07-17, when it hit its own line cap and
// decomposed). `large-file-policy.ts` re-exports `countCodeLines` so existing
// consumers (pre-checks, line-count-projection) keep their import path.

/** Scanner state for `countCodeLines` — threaded through the per-character
 *  helpers so comment/string context survives newlines. */
interface CodeLineScanState {
	/** Inside a block comment (spans lines). */
	inBlockComment: boolean;
	/** Inside a `//` line comment (resets at each newline). */
	inLineComment: boolean;
	/** Open string delimiter (', ", or backtick), or null. Only the backtick
	 *  (template literal) spans lines. */
	stringDelim: string | null;
	/** Current line carries at least one code character. */
	lineHasCode: boolean;
	/** Completed lines that carried code. */
	codeLines: number;
}

/** Finalize the current line for `countCodeLines`: count it when it carried
 *  code, reset per-line state. Single/double-quoted strings do not span lines
 *  (an unterminated one is a syntax error anyway) — only template literals and
 *  block comments carry state over. */
function endCodeLine(s: CodeLineScanState): void {
	if (s.lineHasCode) s.codeLines++;
	s.lineHasCode = false;
	s.inLineComment = false;
	if (s.stringDelim === "'" || s.stringDelim === '"') s.stringDelim = null;
}

/** Consume one non-newline character for `countCodeLines`. Returns the number
 *  of EXTRA characters consumed (0 or 1 — two-char comment tokens, escapes). */
function scanCodeLineChar(content: string, i: number, s: CodeLineScanState): number {
	const ch = content.charAt(i);
	const next = content.charAt(i + 1);
	if (s.inLineComment) return 0;
	if (s.inBlockComment) return scanBlockCommentChar(ch, next, s);
	if (s.stringDelim !== null) return scanStringChar(ch, next, s);
	return scanNormalChar(ch, next, s);
}

/** Handle one character while inside a block comment. Closes the comment on
 *  the `*​/` token; otherwise the character is comment text, not code. */
function scanBlockCommentChar(ch: string, next: string, s: CodeLineScanState): number {
	if (ch === "*" && next === "/") {
		s.inBlockComment = false;
		return 1;
	}
	return 0;
}

/** Handle one character while inside a string/template literal. String
 *  content is always code (data), and a backslash escapes the next char. */
function scanStringChar(ch: string, next: string, s: CodeLineScanState): number {
	s.lineHasCode = true; // string/template content is code (data), never comment
	if (ch === "\\" && next !== "\n") return 1; // escape consumes the next char
	if (ch === s.stringDelim) s.stringDelim = null;
	return 0;
}

/** Handle one character outside any comment/string: detect comment openers,
 *  string/template openers, and otherwise mark non-whitespace as code. */
function scanNormalChar(ch: string, next: string, s: CodeLineScanState): number {
	if (ch === "/" && next === "/") {
		s.inLineComment = true;
		return 1;
	}
	if (ch === "/" && next === "*") {
		s.inBlockComment = true;
		return 1;
	}
	if (ch === "'" || ch === '"' || ch === "`") {
		s.stringDelim = ch;
		s.lineHasCode = true;
		return 0;
	}
	if (!/\s/.test(ch)) s.lineHasCode = true;
	return 0;
}

/**
 * Comment-aware sibling of `countLines` (the ONE canonical raw counter): the
 * number of lines carrying any CODE — i.e. not blank, not a `//` line
 * comment, and not (part of) a block comment. String-aware: comment markers
 * inside string/template literals do not open comments, and string/template
 * content lines count as code (an embedded data table IS the module's bulk).
 * Regex literals are not tracked (a literal like `/[/+]/` can misread as a
 * comment opener) — the same accepted limitation as the checks/ strippers.
 *
 * Consumed by the PreToolUse line-cap gate (`checkLargeFileLineCountWrite`)
 * for its comment-only-growth exemption: an edit that grows a file's RAW
 * line count but not its CODE line count is documentation, not code growth,
 * and is allowed even on an over-cap/grandfathered file. Deliberate
 * grandfather interaction: the recorded ceilings in
 * `large-files-baseline.json` keep tracking RAW lines and are NEVER raised
 * by that allowance (ceilings may only shrink — the baseline-integrity gate
 * enforces it), so sustained comment growth on a grandfathered file can push
 * its raw count past the recorded ceiling and surface in verify's
 * `large_files` check; the remedy there is decomposition, never a ceiling
 * raise.
 */
export function countCodeLines(content: string): number {
	const s: CodeLineScanState = {
		inBlockComment: false,
		inLineComment: false,
		stringDelim: null,
		lineHasCode: false,
		codeLines: 0,
	};
	for (let i = 0; i < content.length; i++) {
		if (content.charAt(i) === "\n") {
			endCodeLine(s);
			continue;
		}
		i += scanCodeLineChar(content, i, s);
	}
	endCodeLine(s);
	return s.codeLines;
}
