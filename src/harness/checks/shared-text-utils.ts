// Text utility helpers extracted from shared.ts — comment & string stripping.
// Imported by shared.ts and re-exported; do not import this directly from
// outside the checks/ package — consume via shared.ts instead.

import type { InlineMatch } from "./shared.js";

// The brace-balanced scanner for scope/complexity analysis lives in a sibling
// module; re-exported here so existing consumers (cyclomatic.ts, complexity.ts,
// shared.ts barrel, strip-brace-balance.test.ts) keep importing it from here.
import { stripForBraceScan } from "./shared-text-utils-brace-scan.js";

export { stripForBraceScan };

// ===========================================
// Comment & String Stripping Helpers
// ===========================================

/**
 * Strip comments from content, preserving line count and positions.
 * Replaces comment content with spaces so that line numbers remain stable.
 *
 * Handles:
 * - Single-line comments: `// ...` (JS/TS/Rust/Go/C/Java) and `# ...` (Python)
 * - Multi-line comments: `/* ... *​/` (JS/TS/Rust/Go/C/Java)
 * - Python docstrings on a single line: `""" ... """` and `''' ... '''`
 */

/**
 * Index of the first `//` or `#` line-comment marker on `line` that is NOT
 * inside a string literal, or -1 if there is none. `stripComments` runs
 * before strings are stripped, so it must track string state itself —
 * otherwise the `//` in a `"https://..."` URL literal reads as a comment and
 * everything after it (including the string's own closing quote) is blanked,
 * which then prevents `stripStrings` from recognising the literal at all.
 * Regex literals are not tracked — a pre-existing limitation of this stripper.
 *
 * The string-literal skipping itself lives in {@link closingQuoteIndex}.
 */
/**
 * Index of the quote closing the string literal that opens at `start`, honouring
 * backslash escapes. Returns `line.length` when the literal is never closed on
 * this line — the caller's scan then runs off the end, as it did when the state
 * machine was inline.
 */
function closingQuoteIndex(line: string, start: number, quote: string): number {
	for (let i = start + 1; i < line.length; i++) {
		if (line[i] === "\\" && i + 1 < line.length) {
			i++; // skip the escaped character
			continue;
		}
		if (line[i] === quote) return i;
	}
	return line.length;
}

function firstUnquotedCommentIndex(line: string): number {
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			i = closingQuoteIndex(line, i, ch);
			continue;
		}
		if (ch === "/" && line[i + 1] === "/") {
			return i;
		}
		if (ch === "#") {
			return i;
		}
	}
	return -1;
}

/**
 * Blank a line that starts inside an already-open block comment, up to and
 * including the closing marker. `stillOpen` says whether the block comment
 * continues past this line.
 */
function blankUntilBlockCommentEnd(line: string): { line: string; stillOpen: boolean } {
	const endIdx = line.indexOf("*/");
	if (endIdx === -1) {
		// Entire line is inside a block comment — blank it
		return { line: " ".repeat(line.length), stillOpen: true };
	}
	return { line: " ".repeat(endIdx + 2) + line.slice(endIdx + 2), stillOpen: false };
}

/** Blank Python single-line docstrings on `line`: `""" ... """` or `''' ... '''`. */
function blankSingleLineDocstrings(line: string): string {
	return line
		.replace(/"""[^"]*"""/g, (m) => " ".repeat(m.length))
		.replace(/'''[^']*'''/g, (m) => " ".repeat(m.length));
}

/**
 * Blank every block comment that opens on `line` (possibly several). When the
 * last one has no closing marker on this line, everything from its opener is
 * blanked and `opensBlockComment` reports that the comment runs on.
 */
function blankSameLineBlockComments(line: string): { line: string; opensBlockComment: boolean } {
	let searchFrom = 0;
	while (searchFrom < line.length) {
		const openIdx = line.indexOf("/*", searchFrom);
		if (openIdx === -1) break;
		const closeIdx = line.indexOf("*/", openIdx + 2);
		if (closeIdx === -1) {
			// Block comment opens and continues to next line(s)
			return { line: line.slice(0, openIdx) + " ".repeat(line.length - openIdx), opensBlockComment: true };
		}
		// Same-line block comment
		const before = line.slice(0, openIdx);
		const blanked = " ".repeat(closeIdx + 2 - openIdx);
		const after = line.slice(closeIdx + 2);
		line = before + blanked + after;
		searchFrom = openIdx + blanked.length;
	}
	return { line, opensBlockComment: false };
}

/**
 * Blank a trailing `//` (JS/TS/Rust/Go/C/Java) or `#` (Python) line comment.
 * String-aware so the // inside a "https://..." URL literal — or a # inside any
 * string — is not mistaken for a comment.
 */
function blankLineComment(line: string): string {
	const commentStart = firstUnquotedCommentIndex(line);
	if (commentStart === -1) return line;
	return line.slice(0, commentStart) + " ".repeat(line.length - commentStart);
}

export function stripComments(content: string): string {
	const lines = content.split("\n");
	let inBlockComment = false;

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		if (line === undefined) continue;

		if (inBlockComment) {
			const resumed = blankUntilBlockCommentEnd(line);
			lines[i] = resumed.line;
			if (resumed.stillOpen) continue;
			line = resumed.line;
			inBlockComment = false;
		}

		line = blankSingleLineDocstrings(line);

		const scanned = blankSameLineBlockComments(line);
		line = scanned.line;
		inBlockComment = scanned.opensBlockComment;

		lines[i] = blankLineComment(line);
	}

	return lines.join("\n");
}

/**
 * Consume one line of a multi-line template literal that is still open
 * (`templateDepth > 0` on entry). Blanks the whole line and tracks backticks
 * to detect the literal's close, returning the (possibly still nonzero)
 * depth for the next line.
 */
function consumeTemplateLiteralLine(line: string, templateDepth: number): { line: string; templateDepth: number } {
	for (let j = 0; j < line.length; j++) {
		if (line[j] === "\\" && j + 1 < line.length) {
			j++; // skip escaped char
		} else if (line[j] === "`") {
			templateDepth--;
			if (templateDepth === 0) break;
		}
	}
	return { line: "", templateDepth };
}

/**
 * Strip single-line string literal content from `line` (double/single/backtick
 * quoted), then detect whether a multi-line template literal opens on it
 * (an odd count of unescaped backticks left after stripping). Only called
 * when no template literal is already open on entry.
 */
function stripSingleLineStrings(line: string): { line: string; templateDepth: number } {
	// Replace content inside double-quoted strings
	line = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
	// Replace content inside single-quoted strings
	line = line.replace(/'(?:[^'\\]|\\.)*'/g, "''");
	// Replace content inside backtick template strings (single-line only)
	line = line.replace(/`(?:[^`\\]|\\.)*`/g, "``");

	// Check for unclosed backticks (multi-line template literal opening).
	// Count unescaped backticks remaining — odd count means one is unclosed.
	const remaining = (line.match(/(?<!\\)`/g) || []).length;
	const templateDepth = remaining % 2 === 1 ? 1 : 0;

	return { line, templateDepth };
}

/**
 * Strip string literal content from content, preserving line count.
 * Replaces the interior of string literals with empty content so that
 * patterns inside strings do not trigger false positive matches.
 *
 * Handles: `"..."`, `'...'`, and `` `...` `` (single-line only).
 */
export function stripStrings(content: string): string {
	const lines = content.split("\n");
	let templateDepth = 0; // Track nested template literal depth
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;

		// Inside a multi-line template literal: blank the line, track backticks
		const result =
			templateDepth > 0 ? consumeTemplateLiteralLine(line, templateDepth) : stripSingleLineStrings(line);

		lines[i] = result.line;
		templateDepth = result.templateDepth;
	}
	return lines.join("\n");
}

/**
 * Strip both comments and strings from content. Comments are stripped first (so
 * string-like content in comments is removed), then strings. Preserves line
 * count. General-purpose: consumed by ~50 inline checks via the `shared.ts`
 * barrel, which rely on string delimiters being KEPT and regex left intact.
 * For brace/scope-sensitive analysis use {@link stripForBraceScan} instead.
 */
export function stripCommentsAndStrings(content: string): string {
	return stripStrings(stripComments(content));
}

// ===========================================
// Offset → line helpers
// ===========================================

/**
 * Normalize a char offset the way `String.prototype.slice(0, offset)` does,
 * so both helpers below stay byte-for-byte equivalent to the
 * `text.slice(0, offset).split("\n").length` idiom they replace — including
 * its (never-exercised, but pinned) negative-offset behaviour, where a
 * negative offset counts back from the END of the string.
 */
function sliceEnd(length: number, offset: number): number {
	if (offset < 0) return Math.max(0, length + offset);
	return Math.min(offset, length);
}

/**
 * 1-based line number containing `offset`. One-shot form: O(offset), no
 * allocation. Use this when a scan resolves at most a handful of offsets
 * against a given string; use {@link buildLineIndex} when the same string is
 * queried repeatedly (that form is O(log n) per lookup).
 *
 * Semantics are those of the seven per-file copies this replaced: 1-indexed,
 * a `\n` belongs to the line it terminates, and an offset past the end
 * resolves to the last line.
 */
export function offsetToLine(text: string, offset: number): number {
	const end = sliceEnd(text.length, offset);
	let line = 1;
	for (let i = 0; i < end; i++) {
		if (text.charCodeAt(i) === 10) line++;
	}
	return line;
}

/** Char offsets at which each line starts (index k = start of line k+1). */
export function buildLineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

/** Precomputed line table for one content string. */
export interface LineIndex {
	/** Char offsets at which each line starts (index k = start of line k+1). */
	readonly lineStarts: readonly number[];
	/** 1-based line containing `offset` — binary search, O(log n). */
	lineAt(offset: number): number;
}

/**
 * Build a reusable line table for `text`. Pick this over {@link offsetToLine}
 * when one scan resolves many offsets against the same string: a per-call
 * linear scan makes an adversarial many-candidate file quadratic.
 */
export function buildLineIndex(text: string): LineIndex {
	const lineStarts = buildLineStarts(text);
	const length = text.length;
	return {
		lineStarts,
		lineAt(offset: number): number {
			const target = sliceEnd(length, offset);
			let lo = 0;
			let hi = lineStarts.length - 1;
			while (lo < hi) {
				const mid = (lo + hi + 1) >> 1;
				if ((lineStarts[mid] ?? 0) <= target) lo = mid;
				else hi = mid - 1;
			}
			return lo + 1;
		},
	};
}

/**
 * Scan original lines but match against pre-stripped lines.
 * Returns matches from the original content for display, but only
 * where the stripped content matches the pattern.
 */
export function scanLinesStripped(
	originalLines: string[],
	strippedLines: string[],
	pattern: RegExp,
	maxMatches: number,
): InlineMatch[] {
	const matches: InlineMatch[] = [];
	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= maxMatches) break;
		const strippedLine = strippedLines[i];
		const originalLine = originalLines[i];
		if (strippedLine === undefined || originalLine === undefined) continue;
		if (pattern.test(strippedLine)) {
			matches.push({
				line: i + 1,
				text: originalLine.trim().slice(0, 150),
			});
		}
	}
	return matches;
}
