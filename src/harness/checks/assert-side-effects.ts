// Assert-argument side effects — C / Python / Java siblings of
// `ubs_rust_debug_assert_side_effect` (ubs-language-specific/rust-go-checks.ts).
//
// Bug class (Bun v1.4 regression #30678): `insert_stale` was called inside
// `debug_assert!`; release builds erase the macro AND its argument, so the
// insert never ran and HMR broke only in release. The same erase-the-argument
// trap exists in three more toolchains:
//
//   - C / C++  — `assert(...)` from <assert.h> compiles to nothing under
//                `-DNDEBUG` (the standard release configuration).
//   - Python   — `assert` statements are stripped under `python -O` / `-OO`.
//   - Java     — JVM assertions are DISABLED by default: without `-ea` the
//                condition (and the `: message` operand) never evaluates.
//
// "Side effect" (shared core, `detectAssertSideEffect`):
//   (a) assignment / compound assignment that is not part of ==, !=, <=, >=,
//       => or a C++ lambda default capture `[=]` (mirrors `hasRustAssignment`
//       in rust-go-checks.ts). Snake (C) / camel only: in Python an assert
//       operand is an EXPRESSION, where `=` can only be keyword-argument
//       syntax (`rel_tol=1e-9`) — assignments are statements and only the
//       walrus `:=` binds, so lang "python" skips (a);
//   (b) ++ / -- ;
//   (c) Python walrus `:=` ;
//   (d) a mutating-verb call, matched with whole-segment discipline:
//       - verb-FIRST names — bare verb (`push(`) or `_lower` continuation
//         (`insert_stale(` fires; Java allows only UpperCamel: `setValue(`).
//         A bare `[A-Za-z0-9_]*` suffix would prefix-match `starts_with` /
//         `settings` / `taken` / `writer` / `opened` / `created_at` /
//         `popped` — whole-name discipline keeps every one of those negative.
//         A verb-first name whose NEXT segment is a query word is a read-only
//         accessor, not a mutator (`set_size(` / `set_contains(` /
//         `free_space(` stay negative; `set_value(` / `set_flag(` fire);
//       - noun_verb names — a mutating verb as the FINAL snake segment
//         (`queue_push(` / `list_append(` / `hashmap_insert(` / `q_pop(`),
//         the dominant C method-style convention, guarded against homograph
//         finals (`to_set(` / `is_open(` / `lock_free(`) and predicate firsts
//         (`should_close(` / `can_write(`).
//       Python (lang "python") additionally exempts bare `set(` — the pure
//       builtin constructor — while keeping `.set(` / `set_flag(`.
//
// Check ids: `ubs_c_assert_side_effect`, `ubs_python_assert_side_effect`,
// `ubs_java_assert_side_effect`. All heuristic warnings.

import {
	getExtension,
	type InlineMatch,
	isGeneratedFile,
	isTestFile,
	isVendoredOrFixturePath,
	stripCommentsAndStrings,
} from "./shared.js";
// Shared offset→line helper (1-based; the comment/string stripper preserves
// line count, so it is valid over stripped text). Direct in-package import —
// shared.ts sits at its line cap and cannot carry another re-export line.
import { offsetToLine } from "./shared-text-utils.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;

const MUTATING_VERBS =
	"insert|push|pop|remove|delete|set|put|add|write|send|close|open|spawn|create|update|clear|append|extend|retain|sort|reserve|truncate|drain|take|swap|store|alloc|free|register|unregister|detach|resize|reset|start|stop|commit|rollback|flush|emit|notify|mark|invalidate|unlink|fclose|fflush";

const MUTATING_VERB_SET = new Set(MUTATING_VERBS.split("|"));

/**
 * Continuation segments that turn a verb-FIRST snake name into a read-only
 * query instead of a mutation: `set_size(` / `set_contains(` / `free_space(`
 * are accessors on a set/ring type. Objects of the verb are NOT here, so
 * `set_value(` / `set_flag(` / `insert_stale(` keep firing.
 */
const QUERY_CONTINUATION_SEGMENTS = new Set([
	"contains",
	"size",
	"len",
	"length",
	"count",
	"empty",
	"capacity",
	"space",
	"exists",
	"is",
	"has",
	"was",
	"can",
	"should",
]);

/**
 * Verbs excluded from the noun_verb (FINAL-segment) rule because in that
 * position they are common noun/adjective homographs: `to_set(` / `is_open(` /
 * `lock_free(` / `backing_store(` / `all_clear(` are not mutations.
 */
const NOUN_VERB_FINAL_EXEMPT = new Set(["set", "open", "free", "store", "clear"]);

/** Predicate/converter first segments: `should_close(` / `can_write(` / `to_send(` are reads. */
const PREDICATE_FIRST_SEGMENTS = new Set([
	"is",
	"has",
	"was",
	"can",
	"should",
	"needs",
	"must",
	"may",
	"will",
	"to",
	"as",
]);

/** Every lower-snake call name in a body: `insert_stale(`, `q.pop(`, `set(`. */
const SNAKE_CALL_NAME_RE = /\b([a-z][a-z0-9_]*)\s*\(/g;

/**
 * Snake-name mutating-call decision for ONE call name (see header rule (d)):
 * verb-first names fire unless the continuation is a query word (or, for
 * Python, the name is the bare pure-builtin `set(` — dotted `.set(` still
 * fires); noun_verb names fire on a mutating FINAL segment (`queue_push(`)
 * unless homograph/predicate guarded.
 */
function isSnakeMutatingName(name: string, python: boolean, dotted: boolean): boolean {
	const segs = name.split("_");
	if (segs.some((s) => s.length === 0)) return false; // `set_(` / `a__b(` — malformed
	const first = segs[0] ?? "";
	const last = segs[segs.length - 1] ?? "";
	if (MUTATING_VERB_SET.has(first)) {
		if (segs.length === 1) return !(python && first === "set" && !dotted);
		if (!QUERY_CONTINUATION_SEGMENTS.has(segs[1] ?? "")) return true;
	}
	return (
		segs.length >= 2 &&
		MUTATING_VERB_SET.has(last) &&
		!NOUN_VERB_FINAL_EXEMPT.has(last) &&
		!PREDICATE_FIRST_SEGMENTS.has(first)
	);
}

/** Any mutating snake call in the body? (`python` enables the bare-`set(` exemption.) */
function hasSnakeMutatingCall(body: string, python: boolean): boolean {
	for (const m of body.matchAll(SNAKE_CALL_NAME_RE)) {
		const idx = m.index;
		const dotted = idx > 0 && body.charAt(idx - 1) === ".";
		if (isSnakeMutatingName(m[1] ?? "", python, dotted)) return true;
	}
	return false;
}

/**
 * Camel mode (Java): the verb must be the WHOLE name or continue with an
 * UpperCamel segment straight into the call paren. `setValue(` / `addAll(`
 * fire; `settings(` / `address(` / `additional(` do not.
 */
const CAMEL_MUTATING_CALL_RE = new RegExp(
	String.raw`\b(?:${MUTATING_VERBS})(?:[A-Z]\w*)?\s*\(`,
);

/**
 * Assignment / compound assignment that is not part of a comparison
 * (`==` `!=` `<=` `>=`), an arrow (`=>`), or a C++ lambda default capture
 * (`[=]` — `[` is in the preceding-char exclusion set). Mirror of
 * `hasRustAssignment` in ubs-language-specific/rust-go-checks.ts.
 */
const ASSIGNMENT_RE = /(?:^|[^=!<>\[])(?:<<=|>>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|=(?!=|>))/;

const INCREMENT_DECREMENT_RE = /\+\+|--/;

// ─── Shared core ──────────────────────────────────────────────────────────────

/**
 * Decide whether an (already comment/string-stripped) assert-argument string
 * contains a side effect that would be erased with the assertion.
 *
 * `lang` selects the naming discipline AND which rules apply: `"snake"` (C)
 * and `"python"` use snake-name call matching, `"camel"` (Java) allows only
 * UpperCamel continuations. `"python"` skips rule (a) — an assert operand is
 * an expression, where `=` can only be keyword-argument syntax — and exempts
 * the bare pure-builtin `set(`.
 */
export function detectAssertSideEffect(
	body: string,
	lang: "snake" | "camel" | "python",
): boolean {
	if (lang !== "python" && ASSIGNMENT_RE.test(body)) return true;
	if (INCREMENT_DECREMENT_RE.test(body)) return true;
	if (body.includes(":=")) return true;
	if (lang === "camel") return CAMEL_MUTATING_CALL_RE.test(body);
	return hasSnakeMutatingCall(body, lang === "python");
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Common non-scannable gate shared by all three detectors. */
function isExemptFile(content: string, filePath: string): boolean {
	return (
		isTestFile(filePath) || isVendoredOrFixturePath(filePath) || isGeneratedFile(content)
	);
}

/**
 * One O(n) pass mapping every `(` offset to its matching `)` offset. Replaces
 * a per-match scan-to-EOF that went quadratic on `assert(`-dense adversarial
 * content (98KB of unbalanced asserts took ~1.4s on the hook path). Runs on
 * stripped content, so parens inside strings/comments cannot skew balance;
 * an unbalanced `(` is simply absent from the map.
 */
function buildParenMap(text: string): Map<number, number> {
	const map = new Map<number, number>();
	const stack: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text.charAt(i);
		if (ch === "(") {
			stack.push(i);
		} else if (ch === ")") {
			const open = stack.pop();
			if (open !== undefined) map.set(open, i);
		}
	}
	return map;
}

const PY_TRIPLE_QUOTES = ['"""', "'''"];
const JAVA_TRIPLE_QUOTES = ['"""'];

/**
 * Blank multi-line triple-quoted blocks — Python docstrings spanning lines
 * and Java text blocks — that survive the shared stripper (which only handles
 * the single-line docstring form). Runs on ALREADY-stripped content, where
 * ordinary string literals are gone, so a remaining `"""` is a real
 * delimiter. 1:1 char replacement preserves every offset and newline.
 */
function blankTripleQuotedBlocks(stripped: string, delimiters: readonly string[]): string {
	let open: string | null = null;
	let out = "";
	let i = 0;
	while (i < stripped.length) {
		const ch = stripped.charAt(i);
		if (ch === "\n") {
			out += ch;
			i++;
			continue;
		}
		const delim: string | undefined =
			open === null ? delimiters.find((q) => stripped.startsWith(q, i)) : open;
		if (delim !== undefined && stripped.startsWith(delim, i)) {
			open = open === null ? delim : null;
			out += " ".repeat(delim.length);
			i += delim.length;
			continue;
		}
		out += open === null ? ch : " ";
		i++;
	}
	return out;
}

const PY_GROUP_OPENERS = "([{";
const PY_GROUP_CLOSERS = ")]}";

/** First comma at bracket depth 0, or -1. Used to drop `, message` operands. */
function topLevelCommaIndex(s: string): number {
	let depth = 0;
	for (let i = 0; i < s.length; i++) {
		const ch = s.charAt(i);
		if (PY_GROUP_OPENERS.includes(ch)) depth++;
		else if (PY_GROUP_CLOSERS.includes(ch)) depth--;
		else if (ch === "," && depth <= 0) return i;
	}
	return -1;
}

/** `assert <cond>, <message>` → keep only `<cond>`. */
function stripTrailingAssertMessage(arg: string): string {
	const idx = topLevelCommaIndex(arg);
	return idx === -1 ? arg : arg.slice(0, idx);
}

function recordMatch(
	matches: InlineMatch[],
	rawLines: string[],
	lineNo: number,
	message: string,
): void {
	if (matches.length >= MAX_MATCHES_PER_FILE) return;
	const rawText = (rawLines[lineNo - 1] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
	matches.push({ line: lineNo, text: `${message} — ${rawText}` });
}

// ─── C / C++ — `ubs_c_assert_side_effect` ─────────────────────────────────────

const C_FAMILY_EXTS = [".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hh"];

/**
 * Project-local always-on assert macro. When the file redefines `assert`
 * itself, NDEBUG erasure no longer applies — bail for the whole file.
 * Checked against the RAW content: the shared stripper treats `#` as a
 * to-end-of-line comment marker, so preprocessor lines are blanked in
 * stripped text and would hide the redefinition. Anchored to a directive at
 * line START so a comment or string that merely MENTIONS `#define assert`
 * mid-line cannot suppress the file's real findings.
 */
const C_DEFINE_ASSERT_RE = /^[ \t]*#\s*define\s+assert\b/m;

const C_ASSERT_CALL_SRC = String.raw`\bassert\s*\(`;

const C_MESSAGE =
	"ubs_c_assert_side_effect: side effect inside assert() — compiling with NDEBUG (standard release) erases the argument, so it never runs; hoist the call out of the assert";

/**
 * Detect side effects inside C/C++ `assert(...)` arguments.
 * `static_assert` / `_Static_assert` never match (`\bassert` cannot start
 * inside those identifiers); uppercase `ASSERT(` custom macros are ignored.
 */
export function checkCAssertSideEffects(content: string, filePath: string): InlineMatch[] {
	if (!C_FAMILY_EXTS.includes(getExtension(filePath))) return [];
	if (isExemptFile(content, filePath)) return [];
	if (C_DEFINE_ASSERT_RE.test(content)) return [];

	const stripped = stripCommentsAndStrings(content);
	const rawLines = content.split("\n");
	const parens = buildParenMap(stripped);
	const matches: InlineMatch[] = [];
	const re = new RegExp(C_ASSERT_CALL_SRC, "g");
	// A nested assert's body is a substring of the enclosing body already
	// scanned, so any hit inside it was reported (or ruled out) on the parent
	// — skipping keeps assert-in-assert content linear instead of quadratic.
	let scannedUntil = -1;

	for (const m of stripped.matchAll(re)) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		const start = m.index;
		if (start < scannedUntil) continue;
		const openIndex = start + m[0].lastIndexOf("(");
		const closeIndex = parens.get(openIndex) ?? -1;
		if (closeIndex === -1) continue;
		scannedUntil = closeIndex;
		const body = stripped.slice(openIndex + 1, closeIndex);
		if (!detectAssertSideEffect(body, "snake")) continue;
		recordMatch(matches, rawLines, offsetToLine(stripped, start), C_MESSAGE);
	}
	return matches;
}

// ─── Python — `ubs_python_assert_side_effect` ─────────────────────────────────

// `\r?` before the anchor tolerates a CRLF-terminated line: `content.split("\n")`
// leaves a trailing "\r" on every non-final line of a CRLF file, and `.`
// never matches a line terminator (which includes "\r"), so a bare `(.+)$`
// could never match such a line at all — a real bug that silently made this
// detector blind to CRLF-encoded Python files (found via mutation testing,
// 2026-08-12).
const PY_ASSERT_LINE_RE = /^\s*assert\s+(.+)\r?$/;

const PY_MESSAGE =
	"ubs_python_assert_side_effect: side effect inside an assert statement — `python -O` strips asserts, so the call never runs in optimized deployments; hoist it out of the assert";

/**
 * Detect side effects inside Python `assert` statements (per stripped line —
 * multi-line docstring interiors are blanked first; the trailing `, message`
 * operand is dropped before the core runs). Lang "python" skips rule (a):
 * a `=` in an assert operand can only be keyword-argument syntax.
 */
export function checkPythonAssertSideEffects(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (getExtension(filePath) !== ".py") return [];
	if (isExemptFile(content, filePath)) return [];

	const stripped = blankTripleQuotedBlocks(stripCommentsAndStrings(content), PY_TRIPLE_QUOTES);
	const strippedLines = stripped.split("\n");
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		const m = PY_ASSERT_LINE_RE.exec(strippedLines[i] ?? "");
		if (m?.[1] === undefined) continue;
		const body = stripTrailingAssertMessage(m[1]);
		if (!detectAssertSideEffect(body, "python")) continue;
		recordMatch(matches, rawLines, i + 1, PY_MESSAGE);
	}
	return matches;
}

// ─── Python — `ubs_python_assert_tautology` ──────────────────────────────────

/** `assert (cond, "msg")` — the parens make a 2-tuple, which is always truthy,
 *  so the assertion NEVER fails (the classic pytest footgun; the author meant
 *  `assert cond, "msg"`). `[^()]+` on both sides keeps it to FLAT asserts, so
 *  `assert isinstance(x, int)` / `assert func(a, b)` (calls) and
 *  `assert (a, b) == c` (tuple comparison) are NOT matched — zero-FP. Matched on
 *  the strings-blanked view so a mention in a docstring/string never fires. */
const PY_ASSERT_TAUTOLOGY_RE = /^\s*assert\s*\(\s*[^()]+,\s*[^()]+\)\s*$/;

const PY_TAUTOLOGY_MESSAGE =
	'ubs_python_assert_tautology: `assert (cond, "msg")` asserts a non-empty TUPLE — always truthy, so this assertion can never fail. Drop the parentheses: `assert cond, "msg"`.';

/** Detect the always-true parenthesized-tuple `assert (cond, msg)`. Test files
 *  are IN scope — this pytest footgun lives in test code. */
export function checkPythonAssertTautology(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".py") return [];
	// NOT isExemptFile: test files are IN scope (this pytest footgun lives there);
	// only vendored/generated code is exempt.
	if (isVendoredOrFixturePath(filePath) || isGeneratedFile(content)) return [];

	const stripped = blankTripleQuotedBlocks(stripCommentsAndStrings(content), PY_TRIPLE_QUOTES);
	const strippedLines = stripped.split("\n");
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length && matches.length < MAX_MATCHES_PER_FILE; i++) {
		if (PY_ASSERT_TAUTOLOGY_RE.test(strippedLines[i] ?? "")) {
			recordMatch(matches, rawLines, i + 1, PY_TAUTOLOGY_MESSAGE);
		}
	}
	return matches;
}

// ─── Java — `ubs_java_assert_side_effect` ─────────────────────────────────────

/**
 * `assert <cond>;` or `assert <cond> : <message>;`. Both operands are erased
 * without `-ea`, so the core runs over the concatenation. The windows are
 * UNBOUNDED per the pinned spec regex — `[^;:]` / `[^;]` are plain negated
 * classes with no catastrophic-backtracking risk, and a bounded window
 * silently skipped long generated/builder-chain conditions.
 */
const JAVA_ASSERT_STMT_SRC = String.raw`\bassert\s+([^;:]+)(:[^;]*)?;`;

const JAVA_MESSAGE =
	"ubs_java_assert_side_effect: side effect inside an assert — JVM assertions are DISABLED by default (no -ea), so the argument never runs in production; hoist the call out of the assert";

/** Detect side effects inside Java `assert` statements. */
export function checkJavaAssertSideEffects(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (getExtension(filePath) !== ".java") return [];
	if (isExemptFile(content, filePath)) return [];

	const stripped = blankTripleQuotedBlocks(
		stripCommentsAndStrings(content),
		JAVA_TRIPLE_QUOTES,
	);
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const re = new RegExp(JAVA_ASSERT_STMT_SRC, "g");

	for (const m of stripped.matchAll(re)) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		const body = (m[1] ?? "") + (m[2] ?? "");
		if (!detectAssertSideEffect(body, "camel")) continue;
		recordMatch(matches, rawLines, offsetToLine(stripped, m.index), JAVA_MESSAGE);
	}
	return matches;
}
