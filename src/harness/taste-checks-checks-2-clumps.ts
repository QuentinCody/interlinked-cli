// interlinked-tdd: exempt
// ===========================================
// Taste Checks (cluster 2, part b) -- checks 18-21 (magic numbers, function
// argument count, data clump, duplicate describe) plus their arg-list helpers,
// extracted from taste-checks-checks-2.ts to keep that file under the per-file
// line cap. Pure inline checks; no module-private state shared with the parent.
// The parent re-exports these so existing importers keep importing from
// "./taste-checks.js" (and "./taste-checks-checks-2.js") unchanged.
// ===========================================

import { nonNull } from "../lib/non-null.js";
import {
	type InlineMatch,
	isJsTs,
	isTestFile,
	lineIdxForOffset,
	push,
	stripCommentsAndStrings,
} from "./taste-checks-shared.js";

// ===========================================
// 18. Magic Numbers
// Number literals (≥4 digits) inside function calls, outside const declarations.
// E.g., `setTimeout(fn, 5000)` — the `5000` should be a named constant.
// ===========================================

const DECLARATION_LINE = /^\s*(?:export\s+)?(?:const|let|var|readonly|static|enum)\b/;
const MAGIC_IN_CALL = /\b[A-Za-z_$][\w$]*\s*\([^()]*?\b\d{4,}\b[^()]*?\)/;

// JSDoc continuation lines (` * ...`) and plain `// ...` comments look like
// code after some stripper corruption. These patterns are a belt-and-braces
// check on the ORIGINAL line: if the raw text starts with a comment marker,
// the match is a false positive from a prior stripper state-tracking bug.
const COMMENT_LINE_PATTERN = /^\s*(?:\/\/|\*|\/\*)/;

export function checkMagicNumber(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath) || isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 10; i++) {
		const line = nonNull(sLines[i]);
		if (DECLARATION_LINE.test(line)) continue;
		if (COMMENT_LINE_PATTERN.test(nonNull(lines[i]))) continue;
		if (MAGIC_IN_CALL.test(line)) push(matches, i, lines, 10);
	}
	return matches;
}

// ===========================================
// Helpers for arg-list analysis
// ===========================================

const OPENS = "({[<";
const CLOSES = ")}]>";

function splitTopLevelCommas(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let buf = "";
	for (const ch of s) {
		if (OPENS.includes(ch)) depth++;
		else if (CLOSES.includes(ch)) depth--;
		if (ch === "," && depth === 0) {
			out.push(buf);
			buf = "";
		} else {
			buf += ch;
		}
	}
	if (buf.trim()) out.push(buf);
	return out;
}

function argCount(argsInner: string): number {
	return splitTopLevelCommas(argsInner).length;
}

// ===========================================
// 19. Function Argument Count
// Clean Code: keep argument count low (0–2 ideal, 3 max, 4+ warrants refactor).
// Single destructured object counts as 1.
// ===========================================

const FUNC_DECL = /\b(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;
const ARROW_DECL = /=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*[^=(){}]+)?\s*=>/g;
const METHOD_DECL =
	/^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*[^{;]+)?\s*\{/gm;

const ARG_COUNT_THRESHOLD = 3;

function flagOversizedArgList(
	stripped: string,
	pattern: RegExp,
	lines: string[],
	matches: InlineMatch[],
	limit: number,
): void {
	for (const m of stripped.matchAll(pattern)) {
		if (matches.length >= limit) return;
		if (argCount(nonNull(m[1])) > ARG_COUNT_THRESHOLD) {
			push(matches, lineIdxForOffset(stripped, m.index), lines, limit);
		}
	}
}

export function checkFunctionArgCount(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	flagOversizedArgList(stripped, FUNC_DECL, lines, matches, 10);
	flagOversizedArgList(stripped, ARROW_DECL, lines, matches, 10);
	flagOversizedArgList(stripped, METHOD_DECL, lines, matches, 10);
	return matches;
}

// ===========================================
// 20. Data Clump
// 3+ consecutive parameters of the same primitive type (string/number/boolean)
// signal a candidate for extraction into an object/struct.
// ===========================================

const PRIMITIVES = new Set(["string", "number", "boolean", "bigint"]);
const DATA_CLUMP_RUN = 3;

function paramType(part: string): string {
	const colon = part.indexOf(":");
	if (colon === -1) return "";
	const typePart = part.slice(colon + 1).trim();
	const firstToken = nonNull(typePart.split(/[\s|&=]/)[0]);
	return firstToken;
}

function hasDataClump(argsInner: string): boolean {
	const parts = splitTopLevelCommas(argsInner);
	let run = 0;
	let runType = "";
	for (const p of parts) {
		const t = paramType(p);
		if (!PRIMITIVES.has(t)) {
			run = 0;
			runType = "";
			continue;
		}
		if (t === runType) {
			run++;
			if (run >= DATA_CLUMP_RUN) return true;
		} else {
			run = 1;
			runType = t;
		}
	}
	return false;
}

function flagDataClump(
	stripped: string,
	pattern: RegExp,
	lines: string[],
	matches: InlineMatch[],
	limit: number,
): void {
	for (const m of stripped.matchAll(pattern)) {
		if (matches.length >= limit) return;
		if (hasDataClump(nonNull(m[1]))) {
			push(matches, lineIdxForOffset(stripped, m.index), lines, limit);
		}
	}
}

export function checkDataClump(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	flagDataClump(stripped, FUNC_DECL, lines, matches, 10);
	flagDataClump(stripped, ARROW_DECL, lines, matches, 10);
	flagDataClump(stripped, METHOD_DECL, lines, matches, 10);
	return matches;
}

// ===========================================
// 21. Duplicate Describe
// Same `describe("x", ...)` string appears 2+ times in one file.
// ===========================================

// One simple (ReDoS-free) alternative per quote style; the title is whichever of
// groups 1-3 matched. Each negated class lets the title contain the OTHER quote —
// e.g. `describe("mirror: 'skip' entries…")` — so two distinct titles aren't
// truncated at an inner `'` into a false duplicate.
const DESCRIBE_NAME = /\bdescribe\s*\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g;

export function checkDuplicateDescribe(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	// Length-preserving blank of comments AND string/template/regex literals,
	// used as a position oracle: a `describe(...)` token quoted inside a fixture
	// string — e.g. a detector's own test feeding `'describe("x", () => {'` as
	// sample code — must NOT be counted as a real suite. Titles are read from the
	// original `content` so real describe names survive.
	const oracle = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<string>();
	for (const m of content.matchAll(DESCRIBE_NAME)) {
		if (matches.length >= 5) break;
		const idx = m.index;
		// The `d` of `describe` survives in `oracle` only when it is real code;
		// inside a blanked literal/comment it becomes a space, so skip it.
		if (oracle[idx] !== content[idx]) continue;
		const name = nonNull(m[1] ?? m[2] ?? m[3]);
		if (seen.has(name)) {
			push(matches, lineIdxForOffset(content, idx), lines, 5);
		} else {
			seen.add(name);
		}
	}
	return matches;
}
