// Placeholder test detection (stub/pending/TODO-body test cases).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	isVendoredOrFixturePath,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Placeholder Tests — stub / pending / TODO-body test cases
// ===========================================
// Complements existing checks:
//   - checkAssertionFreeTests: tests with no expect()/assert() at all
//   - checkTrivialAssertions: expect(true).toBe(true) tautologies
//   - checkDisabledTests: .skip / xit / xdescribe
//   - checkFocusedTests: .only / fdescribe
// This check catches the gaps: .todo, pending single-arg tests, empty bodies,
// and TODO/FIXME comments inside test bodies.

const PLACEHOLDER_BODY_MARKER_RE = /\b(TODO|FIXME|XXX|HACK|STUB)\b/;

/** Identifier that introduces a test block we want to scan. */
const TEST_INTRO_RE = /^(?:it|test|describe)\s*\(/;

/**
 * Detect placeholder / stub test bodies that contribute zero coverage.
 *
 * Fires on:
 *   1. `.todo` blocks: `it.todo("name")`, `test.todo(...)`
 *   2. Pending single-arg form: `it("name")` with no callback
 *   3. Empty-body form: `it("name", () => {})`, `it("name", async () => {})`
 *   4. TODO/FIXME/XXX/HACK/STUB markers as the sole statement in a body
 */
export function checkPlaceholderTests(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	// A test file under a fixture tree (`__fixtures__/`, `testdata/`, …) is a
	// payload for some other tool's test, often a deliberately empty one.
	if (isVendoredOrFixturePath(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const matches: InlineMatch[] = [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const MAX_MATCHES = 15;

	// (1) .todo markers — fast single-line regex pass on stripped content.
	const TODO_RE = /\b(?:it|test|describe)\.todo\s*\(/;
	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= MAX_MATCHES) break;
		if (TODO_RE.test(line)) {
			matches.push({
				line: i + 1,
				text: `.todo placeholder — write the test or delete the line: ${nonNull(originalLines[i]).trim().slice(0, 120)}`,
			});
		}
	}

	// (2) Pending single-arg form: `it("name")` without a callback argument.
	// Match `it(` or `test(` where the invocation closes after a single string literal.
	const PENDING_RE = /^\s*(?:it|test)\s*\(\s*["'`][^"'`]*["'`]\s*\)\s*[;,]?\s*$/;
	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= MAX_MATCHES) break;
		if (PENDING_RE.test(line)) {
			matches.push({
				line: i + 1,
				text: `Pending test (no body): ${nonNull(originalLines[i]).trim().slice(0, 120)}`,
			});
		}
	}

	// (3 + 4) Scan bodies for empty / TODO-marker-only contents.
	scanTestBodies(strippedLines, originalLines, matches, MAX_MATCHES);

	return matches;
}

/**
 * Find each `it(...)` / `test(...)` / `describe(...)` intro line, extract
 * the body between its opening `{` and matching close, and flag bodies that
 * contain zero real code. Two failure modes surface:
 *   - empty body (nothing between the braces once whitespace/punctuation strips)
 *   - marker-only body (original body contains a TODO/FIXME/XXX/HACK/STUB token)
 * Bodies with any real statement — including nested `it()` calls — are skipped.
 */
function scanTestBodies(
	strippedLines: string[],
	originalLines: string[],
	matches: InlineMatch[],
	maxMatches: number,
): void {
	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= maxMatches) break;
		const trimmed = line.trim();
		if (!TEST_INTRO_RE.test(trimmed)) continue;
		// Skip .only / .skip / .todo / .each — other checks own those.
		if (/\b(?:it|test|describe)\.(?:only|skip|todo|each)\b/.test(line)) continue;

		const body = extractTestBody(strippedLines, i);
		if (!body) continue;
		// Body is "empty" once braces, parens, semicolons, commas, whitespace strip away.
		const residue = body.strippedText.replace(/[{}()\s,;]/g, "");
		if (residue.length > 0) continue;

		const reason = hasPlaceholderMarker(originalLines, i, body.endLine)
			? "Test body contains only TODO/FIXME markers"
			: "Empty test body";
		matches.push({
			line: i + 1,
			text: `${reason}: ${nonNull(originalLines[i]).trim().slice(0, 110)}`,
		});
	}
}

/**
 * True when any ORIGINAL source line from `startLine` to `endLine` inclusive
 * carries a TODO/FIXME/XXX/HACK/STUB marker. The original lines are read (not
 * the stripped ones) because stripping blanks comments, where these markers live.
 */
function hasPlaceholderMarker(
	originalLines: string[],
	startLine: number,
	endLine: number,
): boolean {
	for (let j = startLine; j <= endLine; j++) {
		if (PLACEHOLDER_BODY_MARKER_RE.test(nonNull(originalLines[j]))) return true;
	}
	return false;
}

/**
 * Walk one line's characters from `startCol`, tracking brace depth from
 * `depth`. Returns the updated depth after the line, and the column where
 * depth reached zero (the matching close brace) — or `null` if the line
 * closed no bracket back to zero.
 */
function scanLineForMatchingClose(
	line: string,
	startCol: number,
	depth: number,
): { depth: number; closeCol: number | null } {
	for (let j = startCol; j < line.length; j++) {
		const ch = nonNull(line[j]);
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return { depth, closeCol: j };
		}
	}
	return { depth, closeCol: null };
}

/** A (line, column) position inside the stripped-line array. */
interface Pos {
	line: number;
	col: number;
}

/**
 * First non-whitespace character at or after `from`, crossing line breaks.
 * Returns null when the file ends first.
 */
function nextNonSpace(lines: string[], from: Pos): { pos: Pos; ch: string } | null {
	return nextNonSpaceSkipping(lines, from, /\s/);
}

/**
 * From the `(` that opens the parameter list of a `function` expression,
 * return the position just past its matching `)`. Destructured parameters
 * (`function ({ expect }) {`) nest braces, so brace-skipping is not enough —
 * paren depth is what closes the list.
 */
function skipParameterList(lines: string[], open: Pos): Pos | null {
	let depth = 0;
	for (let line = open.line; line < lines.length; line++) {
		const text = nonNull(lines[line]);
		for (let col = line === open.line ? open.col : 0; col < text.length; col++) {
			const ch = text[col];
			if (ch === "(") depth++;
			else if (ch === ")") {
				depth--;
				if (depth === 0) return { line, col: col + 1 };
			}
		}
	}
	return null;
}

/**
 * Locate the `{` that opens the test CALLBACK's body — not the first `{` in
 * the file after the intro line. Walks the `it(...)` call tracking paren
 * depth and stops at the first `=>` or `function` keyword inside it:
 *   - `=> {`        → the brace is the body (possibly on a later line)
 *   - `=> expr`     → expression-bodied arrow; it has no block to be empty
 *   - `function (…) {` → the brace after the parameter list is the body
 *   - call closes with no callback literal (`it("x", sharedCases)`) → none
 * Returning null for the last two cases is what keeps an expression-bodied
 * test or a by-reference callback from being charged with the NEXT `{` in
 * the file (an unrelated `{}` argument or object literal).
 *
 * `depth` counts every bracket kind, and only an arrow / `function` at
 * depth 1 (a direct argument of the test call) is the callback. A noop
 * arrow nested anywhere else — a default parameter (`(done = () => {}) =>`),
 * an options value (`{ onRetry: () => {} }`), or a wrapper's argument
 * (`withConsole(() => {}, (spy) => {…})`) — is not the test body.
 */
function findCallbackBodyOpen(lines: string[], startLine: number): Pos | null {
	let depth = 0;
	for (let line = startLine; line < lines.length; line++) {
		const text = nonNull(lines[line]);
		for (let col = 0; col < text.length; col++) {
			const ch = nonNull(text[col]);
			if (OPEN_BRACKETS.has(ch)) depth++;
			else if (CLOSE_BRACKETS.has(ch)) {
				depth--;
				if (depth === 0) return null;
			} else if (depth !== 1) continue;
			else if (ch === "=" && text[col + 1] === ">") {
				return braceAt(lines, { line, col: col + 2 });
			} else if (isFunctionKeywordAt(text, col)) {
				return bodyAfterFunctionKeyword(lines, { line, col: col + "function".length });
			}
		}
	}
	return null;
}

const OPEN_BRACKETS = new Set(["(", "[", "{"]);
const CLOSE_BRACKETS = new Set([")", "]", "}"]);

/** True when `function` starts at `col` as a whole word. */
function isFunctionKeywordAt(text: string, col: number): boolean {
	return text.startsWith("function", col) && !/\w/.test(text[col - 1] ?? "");
}

/** Position of a `{` that is the next non-space character, else null. */
function braceAt(lines: string[], from: Pos): Pos | null {
	const next = nextNonSpace(lines, from);
	return next?.ch === "{" ? next.pos : null;
}

/**
 * From just past a `function` keyword, step over the optional name /
 * generator star and the parameter list; the body brace must follow.
 */
function bodyAfterFunctionKeyword(lines: string[], from: Pos): Pos | null {
	const paren = nextNonSpaceSkipping(lines, from, /[\w*\s]/);
	if (!paren || paren.ch !== "(") return null;
	const afterParams = skipParameterList(lines, paren.pos);
	if (!afterParams) return null;
	return braceAt(lines, afterParams);
}

/**
 * Like {@link nextNonSpace} but skips every character matching `skip` —
 * used to step over a function expression's optional name / generator star.
 */
function nextNonSpaceSkipping(
	lines: string[],
	from: Pos,
	skip: RegExp,
): { pos: Pos; ch: string } | null {
	let { line, col } = from;
	while (line < lines.length) {
		const text = nonNull(lines[line]);
		while (col < text.length) {
			const ch = nonNull(text[col]);
			if (!skip.test(ch)) return { pos: { line, col }, ch };
			col++;
		}
		line++;
		col = 0;
	}
	return null;
}

/**
 * From a test-intro line, find the callback body's opening `{` and walk
 * brace depth to its matching close. Returns the stripped-content text
 * strictly between the opening and closing braces, plus the closing line
 * index. Null when the test has no block body (expression-bodied arrow or a
 * callback passed by reference).
 *
 * Only stripped positions are used for slicing because stripStrings() does
 * not preserve column positions. Callers that need original content should
 * key off full lines, not offsets into stripped text.
 */
function extractTestBody(
	strippedLines: string[],
	startLine: number,
): { strippedText: string; endLine: number } | null {
	const open = findCallbackBodyOpen(strippedLines, startLine);
	if (!open) return null;
	const openLine = open.line;
	const openCol = open.col;

	let depth = 1;
	let endLine = -1;
	let endCol = -1;
	for (let i = openLine; i < strippedLines.length; i++) {
		const line = nonNull(strippedLines[i]);
		const startCol = i === openLine ? openCol + 1 : 0;
		const scan = scanLineForMatchingClose(line, startCol, depth);
		depth = scan.depth;
		if (scan.closeCol !== null) {
			endLine = i;
			endCol = scan.closeCol;
			break;
		}
	}
	if (endLine === -1) return null;

	const parts: string[] = [];
	for (let i = openLine; i <= endLine; i++) {
		const sl = nonNull(strippedLines[i]);
		const lo = i === openLine ? openCol + 1 : 0;
		const hi = i === endLine ? endCol : sl.length;
		parts.push(sl.slice(lo, hi));
	}
	return { strippedText: parts.join("\n"), endLine };
}
