// ===========================================
// Polyglot skipped/disabled-test markers
// ===========================================
// Single source of truth for three consumers: the `disabled_tests` inline
// check (js-ts-general.ts delegates here), the skipped-tests water-line
// counter (skipped-tests-policy.ts), and `interlinked adopt`'s seeding.
//
// Why: Bun's Rust-rewrite merge bar was "0 tests skipped or deleted"
// (docs/external-pulse/bun-in-rust.md §2.5) — and our skip detection was
// JS/TS + Swift only, so `@pytest.mark.skip`, Rust `#[ignore]`, and Go
// `t.Skip()` were invisible (docs/design/test-oracle-integrity.md §3.4).
//
// Deliberately conservative per language: only UNCONDITIONAL skips count.
// Conditional platform/dependency skips (`skipif`, `skipUnless`,
// `cfg_attr(…, ignore)`, `if testing.Short() { t.Skip() }`) are legitimate
// engineering, not oracle erosion, and are excluded by construction.
//
// 2026-10-21 adversarial review (pre_block, ~zero FP required) added four
// exemptions, each a shape a reviewer accepts: a marker whose ENCLOSING
// block is opened by a conditional (`if … {` + a comment or `t.Logf` before
// the `t.Skip`, `switch`/`case`, `} else {`); Playwright's conditional
// `test.skip(condition, description?)` inside a test body; a marker inside a
// Python triple-quoted string (pytester's `makepyfile("""…""")`, a module
// docstring); and a marker inside a Rust raw/plain string literal (a
// proc-macro crate's expected expansion).
//
// Round 2 of that review (same day) added three more: a block whose header
// WRAPS over several lines (`if a ||\n\tb ||\n\tc {` in Go, prettier's
// `if (\n  a &&\n  b\n) {` in JS) is read as one header; a Go `t.Skip` after
// an earlier `return` in the same function (`func requireDocker(t)` with
// `if found { return }` before the skip — the testenv-style require helper)
// is the else-branch of a guard; and a Python decorator under an `if` /
// `elif` / `else:` header at class or module scope (indentation blocks) is
// conditional. An unconditional skip helper with no early return still fires.
//
// Round 3 (resumed review, same day): a JS marker that is the body of a
// braceless `if (c) it.skip(…)` / `else` (same line or the line above) or a
// ternary/logical operand (`isCI ? it.skip(…) : it(…)`) is conditional, and a
// Python decorator under a parenthesized wrapped `if (\n  a\n):` header is
// read back to the `if`.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

/** Cap matches per file — mirrors checkDisabledTests' historical cap. */
const MAX_MARKERS_PER_FILE = 15;

/** Lines (including the marker line) a wrapped `.skip(` argument list may extend over. */
const CALL_WINDOW_LINES = 4;

interface SkipMarkerLanguage {
	/** Extensions this marker set applies to. */
	exts: readonly string[];
	/**
	 * Whether the file must look like a test file. Rust is `false`: `#[ignore]`
	 * only ever annotates `#[test]` fns, which live in ordinary `.rs` source
	 * files under `#[cfg(test)]` — there is no Rust test-file naming convention
	 * to predicate on (isStrictTestFile has no Rust rule; deliberate).
	 */
	requireTestFile: boolean;
	/** The unconditional-skip marker. Matched against comment/string-stripped lines. */
	marker: RegExp;
	/**
	 * When set and the marker line (or the line above) matches, the marker is
	 * treated as conditional and NOT counted (e.g. Go's `if testing.Short()`).
	 */
	guardExempt?: RegExp;
	/**
	 * When set and the line that OPENS the marker's enclosing `{ … }` block (or
	 * the line above it, for a wrapped condition) matches, the marker is inside
	 * a conditional block and NOT counted.
	 */
	blockGuard?: RegExp;
	/**
	 * Language-specific comment/string stripping. Default: the shared
	 * `stripCommentsAndStrings`. Rust needs its own: both shared strip helpers
	 * treat `#` as a comment starter (Python/shell style) and would blank
	 * `#[ignore]` entirely. Python needs triple-quoted strings blanked first.
	 */
	strip?: (content: string) => string;
	/** `.skip(<expression>, 'description'?)` is a conditional call (Playwright). */
	conditionalCall?: boolean;
	/** An earlier `return` in the same function makes the skip conditional (Go). */
	earlyReturnExempt?: boolean;
	/** An `if` / `elif` / `else:` indentation block makes the marker conditional (Python). */
	indentGuard?: boolean;
	/** A braceless `if`/`else` or a ternary/logical operator makes the marker conditional (JS). */
	inlineGuard?: boolean;
}

function blankKeepingNewlines(text: string): string {
	return text.replace(/[^\n]/g, " ");
}

/** Blank Python triple-quoted strings (docstrings, pytester sources) before the shared strip. */
function stripPython(content: string): string {
	return stripCommentsAndStrings(content.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, blankKeepingNewlines));
}

/** Blank Rust comments, raw strings and plain strings; `#` is NOT a comment. */
function stripRust(content: string): string {
	return content.replace(
		/\/\*[\s\S]*?\*\/|\/\/[^\n]*|\bb?r(#*)"[\s\S]*?"\1|"(?:[^"\\]|\\[\s\S])*"/g,
		blankKeepingNewlines,
	);
}

const SKIP_MARKER_LANGUAGES: readonly SkipMarkerLanguage[] = [
	{
		// Exact historical checkDisabledTests pattern — no JS/TS behavior change.
		exts: JS_TS_ALL_EXTS,
		requireTestFile: true,
		marker: /\b(?:it\.skip|describe\.skip|test\.skip|xit|xdescribe|xtest)\s*\(/,
		blockGuard: /\b(?:if|else)\b/,
		conditionalCall: true,
		inlineGuard: true,
	},
	{
		// Decorator forms only. `@pytest.mark.skipif` and `@unittest.skipIf` /
		// `skipUnless` are conditional; runtime `pytest.skip(...)` calls are
		// almost always platform guards — all excluded.
		exts: [".py"],
		requireTestFile: true,
		marker: /@pytest\.mark\.skip\b(?!if)|@unittest\.skip\b(?!If|Unless)/,
		strip: stripPython,
		indentGuard: true,
	},
	{
		exts: [".rs"],
		requireTestFile: false,
		marker: /^\s*#\[ignore\b/,
		// `#[cfg_attr(miri, ignore)]` and friends are conditional by definition.
		guardExempt: /cfg_attr/,
		strip: stripRust,
	},
	{
		exts: [".go"],
		requireTestFile: true,
		marker: /\bt\.Skip(?:Now|f)?\s*\(/,
		// The dominant legitimate idiom: `if testing.Short() { t.Skip(...) }`.
		guardExempt: /\bif\b/,
		blockGuard: /\b(?:if|else|switch|select)\b/,
		earlyReturnExempt: true,
	},
];

function languageFor(filePath: string): SkipMarkerLanguage | null {
	const ext = getExtension(filePath);
	for (const lang of SKIP_MARKER_LANGUAGES) {
		if (lang.exts.includes(ext)) return lang;
	}
	return null;
}

function lineIsExempt(lang: SkipMarkerLanguage, lines: string[], idx: number): boolean {
	if (!lang.guardExempt) return false;
	const line = lines[idx] ?? "";
	const prev = idx > 0 ? (lines[idx - 1] ?? "") : "";
	return lang.guardExempt.test(line) || lang.guardExempt.test(prev);
}

interface SourcePos {
	line: number;
	col: number;
}

/**
 * Position of the unmatched `{` that opens the block around column `col` of
 * line `idx` (strings and comments already blanked), or null at top level.
 */
function enclosingOpener(lines: string[], idx: number, col: number): SourcePos | null {
	let depth = 0;
	for (let j = idx; j >= 0; j--) {
		const line = lines[j] ?? "";
		for (let k = (j === idx ? col : line.length) - 1; k >= 0; k--) {
			const ch = line[k];
			if (ch === "}") depth++;
			else if (ch === "{" && depth === 0) return { line: j, col: k };
			else if (ch === "{") depth--;
		}
	}
	return null;
}

/** Most header lines a wrapped block header (`if a ||\n b {`) is read back over. */
const HEADER_MAX_LINES = 8;
/** A line ending in a binary operator, `,` or `(` continues onto the next line. */
const HEADER_CONTINUATION_RE = /(?:\|\||&&|[,(+\-*/%=<>!?:&|^])\s*$/;

function netCloseParens(line: string): number {
	let net = 0;
	for (const ch of line) {
		if (ch === ")") net++;
		else if (ch === "(") net--;
	}
	return net;
}

/**
 * First line of the block header ending on line `opener`: read back over an
 * unbalanced `)` (prettier's `if (\n  a &&\n  b\n) {`) and over lines that end
 * in a continuation operator (Go's `if a ||\n\tb {`).
 */
function headerStartIndex(lines: string[], opener: number): number {
	const floor = Math.max(0, opener - HEADER_MAX_LINES);
	let start = opener;
	let open = netCloseParens(lines[opener] ?? "");
	while (open > 0 && start > floor) {
		start--;
		open += netCloseParens(lines[start] ?? "");
	}
	while (start > floor && HEADER_CONTINUATION_RE.test(lines[start - 1] ?? "")) start--;
	return start;
}

/** The marker sits in a block whose header (or the line above it) is a conditional. */
function blockIsGuarded(lang: SkipMarkerLanguage, lines: string[], idx: number, col: number): boolean {
	if (!lang.blockGuard) return false;
	const opener = enclosingOpener(lines, idx, col);
	if (!opener) return false;
	const start = headerStartIndex(lines, opener.line);
	return lines.slice(Math.max(0, start - 1), opener.line + 1).some((line) => lang.blockGuard?.test(line));
}

const FUNC_RE = /\bfunc\b/;
const RETURN_RE = /\breturn\b/g;

/** Opener of the innermost `func` (declaration or literal) around a position, or null. */
function enclosingFunc(lines: string[], pos: SourcePos): SourcePos | null {
	let at: SourcePos | null = enclosingOpener(lines, pos.line, pos.col);
	while (at && !FUNC_RE.test(lines[at.line] ?? "")) at = enclosingOpener(lines, at.line, at.col);
	return at;
}

/**
 * Go: the function holding the skip `return`s earlier (`if found { return }`
 * then `t.Skip(...)`, the testenv-style require helper). That skip is the
 * else-branch of a guard, so it is conditional. A `return` inside a nested
 * func literal does not count.
 */
function hasEarlyReturn(lines: string[], idx: number, col: number): boolean {
	const fn = enclosingFunc(lines, { line: idx, col });
	if (!fn) return false;
	for (let j = fn.line; j <= idx; j++) {
		const line = lines[j] ?? "";
		for (const m of line.matchAll(RETURN_RE)) {
			if (j === fn.line && m.index <= fn.col) continue;
			if (j === idx && m.index >= col) break;
			const owner = enclosingFunc(lines, { line: j, col: m.index });
			if (owner && owner.line === fn.line && owner.col === fn.col) return true;
		}
	}
	return false;
}

const PY_CONDITIONAL_HEADER_RE = /^\s*(?:if|elif|else)\b/;

function indentOf(line: string): number {
	return (/^\s*/.exec(line)?.[0] ?? "").length;
}

/**
 * Python: the decorator's enclosing indentation block (the nearest earlier
 * non-blank line with a smaller indent) is an `if` / `elif` / `else:` header —
 * a platform switch at class or module scope.
 */
function indentBlockIsConditional(lines: string[], idx: number): boolean {
	const indent = indentOf(lines[idx] ?? "");
	if (indent === 0) return false;
	for (let j = idx - 1; j >= 0; j--) {
		const line = lines[j] ?? "";
		if (line.trim() === "") continue;
		if (indentOf(line) < indent) return PY_CONDITIONAL_HEADER_RE.test(lines[parenHeaderStart(lines, j)] ?? "");
	}
	return false;
}

/** For a line closing a wrapped `if (\n  a\n  and b\n):` header, the line that opens it. */
function parenHeaderStart(lines: string[], idx: number): number {
	let start = idx;
	let open = netCloseParens(lines[idx] ?? "");
	while (open > 0 && start > 0) {
		start--;
		open += netCloseParens(lines[start] ?? "");
	}
	return start;
}

/** Text right before a JS marker that makes it conditional: `if (c) `, `else `, `c ? `, `: `, `&& `, `|| `. */
const JS_INLINE_GUARD_RE = /(?:\bif\s*\(.*\)|\belse|\?|:|&&|\|\|)\s*$/;
/** A braceless `if (c)` / `else` / `} else if (c)` header alone on the line above the marker. */
const JS_BRACELESS_HEADER_RE = /^\s*(?:\}\s*)?(?:else\s+)?(?:if\s*\(.*\)|else)\s*$/;

/** JS: the marker is the body of a braceless `if`/`else`, or a ternary/logical operand. */
function inlineGuarded(lines: string[], idx: number, col: number): boolean {
	if (JS_INLINE_GUARD_RE.test((lines[idx] ?? "").slice(0, col))) return true;
	for (let j = idx - 1; j >= 0; j--) {
		const line = lines[j] ?? "";
		if (line.trim() !== "") return JS_BRACELESS_HEADER_RE.test(line);
	}
	return false;
}

/** Index just past the first argument starting at `start` (its `,` or the call's `)`), or -1. */
function firstArgumentEnd(text: string, start: number): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") {
			if (depth === 0) return i;
			depth--;
		} else if (ch === "," && depth === 0) return i;
	}
	return -1;
}

const LITERAL_START_RE = /^['"`]/;
const WHITESPACE_RE = /^\s*/;

/**
 * Playwright's conditional form: `test.skip(condition, description?)` — the
 * first argument is an expression (not a title literal, not `true`, not
 * empty) and the second, when present, is a string. Jest/vitest's
 * `it.skip(title, fn)` and Playwright's bare `test.skip()` stay unconditional.
 * `text` is the stripped marker line plus a few following lines; `argsStart`
 * is the index just past the marker's `(`.
 */
function isConditionalSkipCall(text: string, argsStart: number): boolean {
	const first = argsStart + (WHITESPACE_RE.exec(text.slice(argsStart))?.[0].length ?? 0);
	const rest = text.slice(first);
	if (rest.startsWith(")") || LITERAL_START_RE.test(rest)) return false;
	const end = firstArgumentEnd(text, first);
	if (end === -1 || text.slice(first, end).trim() === "true") return false;
	if (text[end] === ")") return true;
	return LITERAL_START_RE.test(text.slice(end + 1).trimStart());
}

/** The `.skip(` call at `match` on line `idx` is a conditional (Playwright) form. */
function callIsConditional(lang: SkipMarkerLanguage, lines: string[], idx: number, match: RegExpExecArray): boolean {
	if (!lang.conditionalCall || !match[0].includes(".skip")) return false;
	const window = lines.slice(idx, idx + CALL_WINDOW_LINES).join("\n");
	return isConditionalSkipCall(window, match.index + match[0].length);
}

/** Any of the language's exemptions reads the marker at `match` on line `idx` as conditional. */
function markerIsConditional(lang: SkipMarkerLanguage, lines: string[], idx: number, match: RegExpExecArray): boolean {
	return (
		lineIsExempt(lang, lines, idx) ||
		blockIsGuarded(lang, lines, idx, match.index) ||
		callIsConditional(lang, lines, idx, match) ||
		(lang.earlyReturnExempt === true && hasEarlyReturn(lines, idx, match.index)) ||
		(lang.indentGuard === true && indentBlockIsConditional(lines, idx)) ||
		(lang.inlineGuard === true && inlineGuarded(lines, idx, match.index))
	);
}

/**
 * Public API — every unconditional skip marker in the file, as InlineMatch[].
 * Consumed by `checkDisabledTests` (the `disabled_tests` inline check).
 */
export function findSkipMarkers(content: string, filePath: string): InlineMatch[] {
	const lang = languageFor(filePath);
	if (!lang) return [];
	if (lang.requireTestFile && !isTestFile(filePath)) return [];

	const originalLines = content.split("\n");
	const scanLines = (lang.strip ?? stripCommentsAndStrings)(content).split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < scanLines.length; i++) {
		if (matches.length >= MAX_MARKERS_PER_FILE) break;
		const match = lang.marker.exec(scanLines[i] ?? "");
		if (!match || markerIsConditional(lang, scanLines, i, match)) continue;
		matches.push({
			line: i + 1,
			text: (originalLines[i] ?? "").trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * Public API — how many unconditional skip markers the file carries. The
 * skipped-tests water-line (skipped-tests-policy.ts) and `interlinked adopt`
 * count with exactly the same rules the check fires with, so the baseline and
 * the detector can never disagree about what a "skip" is.
 */
export function countSkippedTests(content: string, filePath: string): number {
	return findSkipMarkers(content, filePath).length;
}
