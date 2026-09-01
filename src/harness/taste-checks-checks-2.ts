// interlinked-tdd: exempt
// ===========================================
// Taste Checks (cluster 2) -- checks 12-21, extracted from taste-checks.ts to
// keep the barrel under the per-file line cap. Pure inline checks; no
// cross-file analysis, no module-private state shared with the barrel. The
// barrel re-exports these so existing importers keep importing from
// "./taste-checks.js" unchanged.
// ===========================================

import { nonNull } from "../lib/non-null.js";
import { stripAllLiterals, stripComments } from "./strip-helpers.js";
import {
	findBlockEnd,
	getExt,
	type InlineMatch,
	isCountableTestStart,
	isJsTs,
	isTestFile,
	push,
	stripCommentsAndStrings,
} from "./taste-checks-shared.js";

// ===========================================
// 12. Commented-Out Code
// Clean Code (Ch. 4)
// ===========================================

// Strong code-like signals only — raw punctuation (()=,) false-positives on
// prose comments that describe parameters or list items. Require:
//   - assignment `=` (not comparison `==`)
//   - arrow `=>`
//   - line ending with `{`, `}`, or `;`
//   - keyword-with-shape: `return X`, `if (`, `for (`, `while (`, `const X =`,
//     `let X =`, `var X =`, `function X(`, or a call-with-args like `foo(a,`
// Call-with-args is the loosest signal, so it requires NO space before `(`:
// real code writes `foo(a, b)`, while English prose writes `fields (a, b)`
// or `Protocol (one per line, both)`. Requiring the tight `ident(` form keeps
// the heuristic catching commented-out calls without flagging parenthetical prose.
const CODE_SHAPED =
	/(?:=(?!=)|=>|[{};]\s*$|\breturn\s+\S|\b(?:if|for|while)\s*\(|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|\bfunction\s+[A-Za-z_$][\w$]*\s*\(|[A-Za-z_$][\w$]*\([^)]*,)/;
const COMMENT_LINE = /^\s*(?:\/\/|#)\s*(.+)$/;
/** Signals that a comment is prose describing behavior rather than
 *  commented-out code. Must be either:
 *    - a JSDoc/prose keyword followed by colon (`Match:`, `Returns:`, `E.g.`)
 *    - an em-dash or double-hyphen separator
 *    - English connectives like " or ", " and ", " but ", " when "
 *  These are never-legitimate-as-code signals. Plain keywords like `return`
 *  or `Throws` without punctuation are NOT here — they're valid code
 *  tokens. */
const PROSE_MARKER =
	/\b(?:Match|Skip|Note|Example|E\.g|e\.g|i\.e|TODO|FIXME|NOTE|XXX|WARNING|See|Args?|Params?|Returns|Throws):|\sE\.g\.,|\si\.e\.,|\s—\s|\s--\s|\s(?:or|and|but|when|whether)\s|\sif it\b|\bthat (?:[a-z])| with \b| without \b| which \b| where \b/i;
const COMMENTED_CODE_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rs",
	".go",
	".java",
]);

function looksLikeBannerLine(body: string): boolean {
	const trimmed = body.trim();
	if (trimmed.length < 3) return false;
	const firstChar = trimmed[0];
	if (firstChar === undefined || !"=-*#_~".includes(firstChar)) return false;
	let same = 0;
	for (const c of trimmed) if (c === firstChar) same++;
	return same / trimmed.length >= 0.8;
}

function looksLikeCommentedCode(line: string): boolean {
	const m = COMMENT_LINE.exec(line);
	if (!m) return false;
	const body = m[1] ?? "";
	if (/^\s*[A-Z]{2,}:/.test(body)) return false;
	if (/^\s*\*/.test(body)) return false;
	if (looksLikeBannerLine(body)) return false;
	// Prose markers (em-dash, "or"/"and"/"when"/etc., "Match:", "E.g.") →
	// this is explanatory comment, not commented-out code. Skip.
	if (PROSE_MARKER.test(body)) return false;
	// Markdown bullet-list items (`- foo`, `+ foo`, `• foo`) are prose, not code.
	if (/^[-+•]\s/.test(body)) return false;
	// Inline-code spans (`x`) mark documentation that *references* code — e.g.
	// "`verify` (no `=`) so the gate matches" — not commented-out code.
	if (/`[^`]+`/.test(body)) return false;
	// Angle-bracket placeholder phrases (`<tool name>`, `<number, warn only>`) are
	// a doc convention. Require the `<` to follow `=`, whitespace, `(`, or start —
	// so a generic like `Map<string, number>`, whose `<` follows an identifier, is
	// NOT treated as prose — and to contain an internal space (a phrase, not a
	// single token), which the `key=<value>` schema-doc lines satisfy.
	if (/(?:^|[=\s(])<[A-Za-z][^<>]*\s[^<>]*>/.test(body)) return false;
	return CODE_SHAPED.test(body);
}

export function checkCommentedOutCode(content: string, filePath: string): InlineMatch[] {
	if (!COMMENTED_CODE_EXTS.has(getExt(filePath))) return [];
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	let runStart = -1;
	let runLen = 0;
	for (let i = 0; i < lines.length; i++) {
		if (looksLikeCommentedCode(lines[i] ?? "")) {
			if (runStart === -1) runStart = i;
			runLen++;
			continue;
		}
		if (runLen >= 3 && runStart !== -1) push(matches, runStart, lines, 5);
		runStart = -1;
		runLen = 0;
	}
	if (runLen >= 3 && runStart !== -1) push(matches, runStart, lines, 5);
	return matches;
}

// ===========================================
// 13. Conditional Logic in Test Bodies
// Tests should have straight-line logic. if/switch/try in a test body usually
// means the test is trying to cover two cases at once.
// ===========================================

const CONTROL_FLOW_IN_TEST = /\b(if|switch|try)\s*[({]/;

/**
 * Look for branching control flow at the TOP LEVEL of a test body only.
 *
 * Depth tracking: the `it(...)` start line opens `(...)` + `{`. We want to
 * match `if`/`switch`/`try` that appears directly in the test body (one
 * `{` level deep — the function body), not inside for-loops, nested
 * functions, mock callbacks, or helper closures which are legitimate.
 *
 * A "collect-and-assert" test — `for (x of xs) if (pred(x)) push(x); expect(pushed)...` —
 * is a valid parametric-assertion pattern and must not be flagged. The
 * `if` is inside a `for` body (depth 2+), so depth filtering handles it.
 */
function findControlFlowInBody(sLines: string[], start: number, end: number): number | null {
	// Depth counter starts from 0 (before the test opens its block). Scan
	// from the first body line onward, tracking `{`/`}` to know whether we
	// are at the test's direct body level.
	let depth = 0;
	let seenOpen = false;
	for (let j = start; j <= end; j++) {
		const line = nonNull(sLines[j]);
		// Check for a top-level conditional BEFORE counting braces on this
		// line — the conditional typically precedes its opening `{`.
		if (seenOpen && depth === 1 && j > start && CONTROL_FLOW_IN_TEST.test(line)) {
			return j;
		}
		for (const ch of line) {
			if (ch === "{") {
				depth++;
				seenOpen = true;
			} else if (ch === "}") {
				depth--;
			}
		}
	}
	return null;
}

export function checkConditionalInTest(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	let i = 0;
	while (i < sLines.length && matches.length < 10) {
		if (!isCountableTestStart(nonNull(sLines[i]))) {
			i++;
			continue;
		}
		const end = findBlockEnd(sLines, i);
		const hit = findControlFlowInBody(sLines, i, end);
		if (hit !== null) push(matches, hit, lines, 10);
		i = end + 1;
	}
	return matches;
}

// ===========================================
// 14. Non-Deterministic Values in Tests
// Date.now(), new Date(), Math.random() inside a test without fake timers → flaky.
// ===========================================

const NON_DETERMINISTIC = /\b(Date\.now|Math\.random|performance\.now)\s*\(|\bnew\s+Date\s*\(\s*\)/;
const FAKE_TIMER_SETUP = /\b(useFakeTimers|setSystemTime|installMockDate|mockDate)\b/;
/** Marker in a file to opt out: `// @perf` or `// @allow-non-deterministic`
 *  on any line of the file exempts it from this check. Lets benchmark and
 *  timing-characterization tests legitimately use `Date.now()`/`performance.now()`
 *  without fake timers. */
const PERF_MARKER = /@(?:perf|allow-non-deterministic)\b/i;

export function checkNonDeterministicTest(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	// File-level opt-out via `@perf` / `@allow-non-deterministic` marker
	// comment — inspects the raw (pre-strip) content since the marker lives
	// inside a comment which gets blanked by stripComments.
	if (PERF_MARKER.test(content)) return [];
	const stripped = stripCommentsAndStrings(content);
	if (FAKE_TIMER_SETUP.test(stripped)) return [];
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 10; i++) {
		if (NON_DETERMINISTIC.test(nonNull(sLines[i]))) push(matches, i, lines, 10);
	}
	return matches;
}

// ===========================================
// 15. Empty Catch Blocks
// An empty-body catch (no statements) swallows errors silently.
// Always handle or rethrow.
// ===========================================

// Matches catch-with-body where body contains no nested braces.
// Matching runs on content with string/template/regex literals blanked so
// the check doesn't fire on catch-shaped text inside a string (e.g. the
// hook-script template in hooks.ts) or inside a regex literal (e.g. this
// check's own source).
const EMPTY_CATCH_CANDIDATE = /catch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/g;
// Rationale markers that excuse an empty catch. Kept deliberately narrow —
// generic keywords like "skip", "ignore", "fallback", "expected" are too
// common to force the author to explain *why* the error is safe to drop.
// Only accept phrases that assert deliberation or harmlessness: "intentional",
// "best-effort", "cleanup is/only", "non-critical", "non-fatal".
const INTENTIONAL_MARKER =
	/\b(?:intentional|best[-\s]?effort|cleanup\s+(?:is|only)|non[-\s]?(?:critical|fatal))\b/i;

export function checkEmptyCatch(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const lines = content.split("\n");
	// scan: strings/templates/regex/comments blanked so catch-shaped text inside
	// any of those doesn't fire. stripAllLiterals runs the four strippers in
	// the order that tolerates backticks inside regex literals elsewhere in
	// the file (regex-first → templates won't be confused; comments run on
	// content with strings/regex/templates already blanked).
	const scan = stripAllLiterals(content);
	const matches: InlineMatch[] = [];
	for (const m of scan.matchAll(EMPTY_CATCH_CANDIDATE)) {
		if (matches.length >= 10) break;
		// The candidate regex matches any body without nested braces. Only
		// flag when the scan-side body is whitespace-only (comments/strings/
		// regex all stripped above). Real statements leave non-whitespace
		// tokens in the scan content.
		if (nonNull(m[1]).trim().length > 0) continue;
		// Then check the ORIGINAL body text for an intentional-marker comment
		// and skip if the developer explicitly documented the empty catch.
		const offset = m.index;
		const origSlice = content.slice(offset, offset + m[0].length);
		const origBody = origSlice.match(/\{([\s\S]*)\}/)?.[1] ?? "";
		if (INTENTIONAL_MARKER.test(origBody)) continue;
		const lineIdx = (content.slice(0, offset).match(/\n/g) || []).length;
		push(matches, lineIdx, lines, 10);
	}
	return matches;
}

// ===========================================
// 16. Test Without Description
// `it("", ...)` or `it(() => ...)` — either empty or missing first-arg description.
// ===========================================

const TEST_EMPTY_DESC = /\b(it|test)\s*\(\s*(?:["']\s*["']|`\s*`)\s*,/;
const TEST_FN_FIRST = /\b(it|test)\s*\(\s*(?:async\s+)?(?:function\b|\()/;

export function checkTestWithoutDescription(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const stripped = stripComments(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 10; i++) {
		const line = nonNull(sLines[i]);
		if (TEST_EMPTY_DESC.test(line) || TEST_FN_FIRST.test(line)) {
			push(matches, i, lines, 10);
		}
	}
	return matches;
}

// ===========================================
// 17. Assertion Roulette
// A single `it()` with 8+ expect() calls — when one fails, which?
// ===========================================

const ASSERTION_ROULETTE_THRESHOLD = 8;

export function checkAssertionRoulette(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	let i = 0;
	while (i < sLines.length && matches.length < 5) {
		if (!isCountableTestStart(nonNull(sLines[i]))) {
			i++;
			continue;
		}
		const end = findBlockEnd(sLines, i);
		const body = sLines.slice(i, end + 1).join("\n");
		const expectCount = (body.match(/\bexpect\s*\(/g) || []).length;
		if (expectCount >= ASSERTION_ROULETTE_THRESHOLD) push(matches, i, lines, 5);
		i = end + 1;
	}
	return matches;
}

// ===========================================
// Checks 18-21 (magic numbers, function argument count, data clump, duplicate
// describe) plus their arg-list helpers were extracted to taste-checks-checks-2-
// clumps.ts to keep this file under the per-file line cap. Re-exported here so
// existing importers keep importing from this module (and the barrel) unchanged.
// ===========================================
export {
	checkDataClump,
	checkDuplicateDescribe,
	checkFunctionArgCount,
	checkMagicNumber,
} from "./taste-checks-checks-2-clumps.js";
