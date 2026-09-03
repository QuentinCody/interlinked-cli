// Unawaited `expect(...).rejects` / `expect(...).resolves` chain in a test file.
//
// Vitest/Jest async matchers return a promise: `expect(p).rejects.toThrow()`
// only asserts when that promise is awaited (or returned so the runner awaits
// it). A statement-position chain with no leading `await` / `return` / `void`
// floats — the test body finishes first and the test SILENTLY PASSES no
// matter what the matcher would have found. `checkFloatingPromises`
// deliberately skips test files, so this is the test-side companion.
//
// Zero-FP by construction: we only fire when the `expect(` sits in statement
// position — the line starts with `expect(` AND the previous significant line
// does not end in a continuation token (`,`, `(`, `[`, `=`, `=>`, operators,
// `await` / `return` / `void` / `yield` / `typeof`). That exempts every
// legitimate shape:
//   - `await expect(p).rejects.toThrow()`      (same-line prefix — no match)
//   - `return expect(p).rejects.toThrow()`     (same-line prefix — no match)
//   - `void expect(p).rejects.toThrow()`       (same-line prefix — no match)
//   - `const a = expect(p).rejects.toThrow()`  (assigned, awaited later)
//   - array elements inside `Promise.all([...])` (prev line ends `[` or `,`)
//   - multi-line `await expect(\n  p,\n).rejects…` (prev line ends `(` / `,`)
//
// Only fires on JS/TS test files.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const REPORT_LINE_TRUNC = 150;
const MAX_MATCHES_PER_FILE = 10;

// ─── Patterns ─────────────────────────────────────────────────────────────────

/** `expect(` as the first token of a line (statement-position candidate). */
const LINE_STARTS_WITH_EXPECT_RE = /^(\s*)expect\s*\(/;

/**
 * The previous significant line ends mid-expression, so a following
 * line-initial `expect(` is a continuation, not a statement. Covers argument
 * lists (`,` `(` `[`), assignment (`=`), arrow bodies (`=>`), member/binary
 * operators, ternaries, and expression keywords.
 */
const CONTINUATION_SUFFIX_RE =
	/(?:[,([.=?:]|=>|&&|\|\||[+\-*/%]|\breturn|\bawait|\bvoid|\byield|\btypeof|\bcase)\s*$/;

/** `.rejects` / `.resolves` immediately after the expect(...) close paren. */
const ASYNC_MATCHER_HEAD_RE = /^\s*\.\s*(?:rejects|resolves)\b/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Previous non-blank line in `lines` strictly before index `i`, or null. */
function previousSignificantLine(lines: string[], i: number): string | null {
	for (let j = i - 1; j >= 0; j--) {
		const line = lines[j] ?? "";
		if (line.trim().length > 0) return line;
	}
	return null;
}

/**
 * Given the offset of an opening `(` in `text`, return the offset just past
 * its balancing `)`, or -1 when unbalanced. Runs on stripped content so
 * parens inside strings/comments never miscount.
 */
function skipBalancedParens(text: string, openOffset: number): number {
	let depth = 0;
	for (let k = openOffset; k < text.length; k++) {
		const ch = text.charAt(k);
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return k + 1;
		}
	}
	return -1;
}

/** True when the chain after `expect(...)` starts with `.rejects`/`.resolves`. */
function chainIsAsyncMatcher(stripped: string, afterCloseOffset: number): boolean {
	return ASYNC_MATCHER_HEAD_RE.test(stripped.slice(afterCloseOffset, afterCloseOffset + 40));
}

/**
 * Statement-position gate: line-initial `expect(` whose previous significant
 * line does not end mid-expression.
 */
function isStatementPositionExpect(strippedLines: string[], i: number): boolean {
	const prev = previousSignificantLine(strippedLines, i);
	return prev === null || !CONTINUATION_SUFFIX_RE.test(prev);
}

/**
 * Check whether stripped line `i` is a statement-position `expect(...)`
 * whose chain is an unawaited `.rejects`/`.resolves` matcher, and if so
 * build the finding for it. Returns null when line `i` is not a match.
 */
function matchUnawaitedAsyncAssertion(
	strippedLines: string[],
	rawLines: string[],
	stripped: string,
	lineStartOffset: number,
	i: number,
): InlineMatch | null {
	const line = strippedLines[i] ?? "";
	const startMatch = LINE_STARTS_WITH_EXPECT_RE.exec(line);
	if (!startMatch || !isStatementPositionExpect(strippedLines, i)) return null;

	const openOffset = lineStartOffset + line.indexOf("(", startMatch[1]?.length ?? 0);
	const afterClose = skipBalancedParens(stripped, openOffset);
	if (afterClose === -1 || !chainIsAsyncMatcher(stripped, afterClose)) return null;

	const rawText = (rawLines[i] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
	return {
		line: i + 1,
		text: `unawaited_async_assertion: expect(...).rejects/.resolves chain is not awaited/returned — the matcher promise floats and this test passes no matter what. Prefix with \`await\` (or \`return\` the chain) — ${rawText}`,
	};
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect statement-position `expect(...).rejects` / `.resolves` chains with
 * no leading `await` / `return` / `void` — silently-passing async assertions.
 *
 * Check id: `unawaited_async_assertion`
 *
 * Returns up to 10 `InlineMatch` findings per file (fields: `line`, `text`);
 * the `text` field is prefixed with the check id, matching neighbouring
 * checks. Only fires on JS/TS test files.
 */
export function detectUnawaitedAsyncAssertions(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];
	if (!isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// Offset where each stripped line starts, so a line-based match can be
	// converted back to a char offset for the paren-balance scan.
	let lineStartOffset = 0;
	for (let i = 0; i < strippedLines.length; i++) {
		const line = strippedLines[i] ?? "";
		const match = matchUnawaitedAsyncAssertion(strippedLines, rawLines, stripped, lineStartOffset, i);
		if (match) {
			matches.push(match);
			if (matches.length >= MAX_MATCHES_PER_FILE) return matches;
		}
		lineStartOffset += line.length + 1;
	}

	return matches;
}
