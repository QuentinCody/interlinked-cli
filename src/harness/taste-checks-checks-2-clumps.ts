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
// The same FULL suite path (`outer > inner`) is declared 2+ times in one file.
// Vitest/Jest report a failure by its parent-chain path, so two `describe("x")`
// under DIFFERENT parents are unambiguous (the standard BDD "same behavior under
// another context" layout — zustand/tests/devtools.test.tsx); only a repeated
// path is. Cross-repo FP calibration 2026-10-21 (zod, zustand): 10/10 hits
// were false positives of the two kinds this version closes.
// ===========================================

// One simple (ReDoS-free) alternative per quote style; the title is whichever of
// groups 1-3 matched. Each negated class lets the title contain the OTHER quote —
// e.g. `describe("mirror: 'skip' entries…")` — so two distinct titles aren't
// truncated at an inner `'` into a false duplicate.
// The lookbehind refuses a MEMBER call: `schema.describe("d")` / `z.string()
// .describe("a")` is zod's metadata setter, not a suite (`\b` alone matched
// after the `.`). Two suite declaration shapes count: a bare `describe(` and
// Playwright's `test.describe(` whose receiver is the bare identifier `test`
// (the same lookbehind refuses `schema.test.describe(` / `mytest.describe(`).
// The match then starts at `test`, which the oracle check below also covers.
const DESCRIBE_NAME =
	/(?<![\w$.])(?:test\s*\.\s*)?describe\s*\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g;

interface SuiteDecl {
	idx: number;
	name: string;
}

/** A suite whose callback body `{` has been entered; popped when that brace closes. */
interface SuiteFrame {
	name: string;
	bodyDepth: number;
}

/** A `describe(` whose argument list is open but whose body `{` is not yet seen. */
interface PendingSuite {
	name: string;
	parenDepth: number;
}

function collectSuiteDecls(content: string, oracle: string): SuiteDecl[] {
	const decls: SuiteDecl[] = [];
	for (const m of content.matchAll(DESCRIBE_NAME)) {
		const idx = m.index;
		// The `d` of `describe` survives in `oracle` only when it is real code;
		// inside a blanked literal/comment it becomes a space, so skip it.
		if (oracle[idx] !== content[idx]) continue;
		decls.push({ idx, name: nonNull(m[1] ?? m[2] ?? m[3]) });
	}
	return decls;
}

/** Tracks the describe call's own parens; `null` once the call closed without a body. */
function trackParen(pending: PendingSuite | null, ch: string): PendingSuite | null {
	if (pending === null) return null;
	if (ch === "(") pending.parenDepth++;
	else pending.parenDepth--;
	return pending.parenDepth <= 0 ? null : pending;
}

/**
 * Resolves every real `describe(` to its full parent-chain path by walking the
 * blanked oracle once, balancing braces. A suite's scope opens at the first `{`
 * inside its argument list (the callback body) and closes with that brace; a
 * one-liner `describe("x", () => it(...))` opens no scope.
 */
function resolveSuitePaths(content: string, oracle: string): Array<{ idx: number; path: string }> {
	const decls = collectSuiteDecls(content, oracle);
	const out: Array<{ idx: number; path: string }> = [];
	const stack: SuiteFrame[] = [];
	let pending: PendingSuite | null = null;
	let braceDepth = 0;
	let di = 0;
	for (let i = 0; i < oracle.length; i++) {
		const decl = decls[di];
		if (decl !== undefined && decl.idx === i) {
			di++;
			out.push({ idx: i, path: [...stack.map((f) => f.name), decl.name].join(" > ") });
			pending = { name: decl.name, parenDepth: 0 };
			continue;
		}
		const ch = nonNull(oracle[i]);
		if (ch === "(" || ch === ")") {
			pending = trackParen(pending, ch);
		} else if (ch === "{") {
			braceDepth++;
			if (pending !== null && pending.parenDepth > 0) {
				stack.push({ name: pending.name, bodyDepth: braceDepth });
				pending = null;
			}
		} else if (ch === "}") {
			braceDepth--;
			while (stack.length > 0 && nonNull(stack[stack.length - 1]).bodyDepth > braceDepth) stack.pop();
		}
	}
	return out;
}

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
	for (const { idx, path } of resolveSuitePaths(content, oracle)) {
		if (matches.length >= 5) break;
		if (seen.has(path)) {
			push(matches, lineIdxForOffset(content, idx), lines, 5);
		} else {
			seen.add(path);
		}
	}
	return matches;
}
