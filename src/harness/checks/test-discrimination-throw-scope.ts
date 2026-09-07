// Call-scoping resolver for checkDuplicateThrowMessageAssertion — split out
// to keep the parent module under the per-file line cap. See that module's
// doc comment for the "why call-scoped" rationale: a throw-message match is
// only real risk when the SUT function the test actually calls can reach
// both matching guards, so this resolves that function/method textually and
// bounds throw-site collection to its own body (plus one same-file helper
// hop).

import { collectThrowSites, extractBalancedArgs, type ThrowSite } from "./test-discrimination-throw-shared.js";

const CALL_IDENTIFIER_RE = /([A-Za-z_$][\w$]*)\s*\(/g;
const IDENT_CHAR_RE = /[\w$]/;

/** The identifier immediately preceding the `(` at `openIdx` (skipping
 *  whitespace), or null if there is none (an arrow's own `(params)`, a
 *  bare grouping paren, etc). */
function identifierBeforeParen(text: string, openIdx: number): string | null {
	let end = openIdx;
	while (end > 0 && /\s/.test(text[end - 1] ?? "")) end--;
	let start = end;
	while (start > 0 && IDENT_CHAR_RE.test(text[start - 1] ?? "")) start--;
	return start === end ? null : text.slice(start, end);
}

interface DepthScanState {
	depth: number;
	inStr: string | null;
}

/** Advance a depth/string scanner by one step, mutating `state`. Returns the
 *  index to resume from. */
function stepDepthScan(text: string, i: number, state: DepthScanState): number {
	const ch = text[i];
	if (state.inStr) {
		if (ch === "\\") return i + 2;
		if (ch === state.inStr) state.inStr = null;
		return i + 1;
	}
	if (ch === '"' || ch === "'" || ch === "`") state.inStr = ch;
	else if (ch === "(") state.depth++;
	else if (ch === ")") state.depth--;
	return i + 1;
}

/** The identifier before `(` at `i`, but only when `state.depth` is 0 (a
 *  top-level call, not one nested inside another call's arguments). */
function topLevelCallIdentifierAt(wrapped: string, i: number, state: DepthScanState): string | null {
	if (wrapped[i] !== "(" || state.depth !== 0) return null;
	return identifierBeforeParen(wrapped, i);
}

/**
 * The TOP-LEVEL (paren-depth-0) call identifier furthest right in `wrapped`
 * — `a(x).b(y)` → "b" (a chain: each call closes back to depth 0 before the
 * next opens), `obj.method(x)` → "method". Deliberately depth-aware: a naive
 * "last identifier-then-paren in the text" reading breaks the moment an
 * argument itself contains a call, e.g. `fn(Float32Array.from([1]))` — the
 * textually-last match is "from", but the function actually under test is
 * "fn". Found via calibration (a real false negative on
 * `aggregateFunctionVectors([Float32Array.from(...)], ...)`).
 */
function rightmostCallIdentifier(wrapped: string): string | null {
	const state: DepthScanState = { depth: 0, inStr: null };
	let last: string | null = null;
	let i = 0;
	while (i < wrapped.length) {
		last = topLevelCallIdentifierAt(wrapped, i, state) ?? last;
		i = stepDepthScan(wrapped, i, state);
	}
	return last;
}

/**
 * Resolve the SUT function/method name actually invoked by the nearest
 * preceding `expect(...)` wrapper, or null if none is found. Covers
 * `expect(() => X(...))`, `expect(X(...))`, `await expect(X(...)).rejects`
 * (the assertion sits after `.rejects`, but the nearest `expect(` is still
 * the right one to look at), and `expect(obj.method(...))` (rightmost
 * identifier is the method name).
 */
export function calleeNameNearOffset(strippedTest: string, assertionOffset: number): string | null {
	const expectIdx = strippedTest.lastIndexOf("expect(", assertionOffset);
	if (expectIdx === -1) return null;
	const wrapped = extractBalancedArgs(strippedTest, expectIdx + "expect".length);
	if (wrapped === null) return null;
	return rightmostCallIdentifier(wrapped);
}

interface BraceScanState {
	depth: number;
	inStr: string | null;
}

/** Advance the brace/string scanner by one step from index `i`, mutating
 *  `state`. Returns the index to resume from (mirrors the paren scanner in
 *  the shared module). */
function stepBraceScan(text: string, i: number, state: BraceScanState): number {
	const ch = text[i];
	if (state.inStr) {
		if (ch === "\\") return i + 2;
		if (ch === state.inStr) state.inStr = null;
		return i + 1;
	}
	if (ch === '"' || ch === "'" || ch === "`") state.inStr = ch;
	else if (ch === "{") state.depth++;
	else if (ch === "}") state.depth--;
	return i + 1;
}

/** Extract the balanced-brace block starting at `{` (index `openIdx`), string-aware. */
function extractBalancedBraceBlock(text: string, openIdx: number): string | null {
	const state: BraceScanState = { depth: 0, inStr: null };
	let i = openIdx;
	while (i < text.length) {
		const wasOpen = state.depth > 0;
		const next = stepBraceScan(text, i, state);
		if (wasOpen && state.depth === 0 && !state.inStr) return text.slice(openIdx, i + 1);
		i = next;
	}
	return null;
}

// Anchored against the text right after a candidate's TRUE balanced-paren
// close (see braceAfterParams) — never against `[^)]*`, which stops at the
// FIRST `)`. Calibration found a real bug from that shortcut: for a plain
// call whose argument itself has parens, e.g. `specs.map((spec): T => {`,
// `[^)]*` matched only up through `(spec`, then happily read the arrow's own
// `{` as if it were a declared function `map`'s body — silently duplicating
// the caller's own throw sites via a bogus "helper hop".
const METHOD_BRACE_RE = /^\s*(?::\s*[^{;=]+)?\{/;
const ARROW_BRACE_RE = /^\s*(?::\s*[^=;{]+)?=>\s*\{/;

function matchMethodBrace(rest: string): number | null {
	const m = METHOD_BRACE_RE.exec(rest);
	return m ? m[0].length : null;
}

function matchArrowBrace(rest: string): number | null {
	const m = ARROW_BRACE_RE.exec(rest);
	return m ? m[0].length : null;
}

/**
 * Given the index of `(` opening a candidate parameter list, verify it is
 * balanced (string-aware) and that what immediately follows its TRUE closing
 * paren matches `matcher` (a body-opening `{`, or `=>` then `{`). Returns
 * the body's opening-brace absolute index, or null when this candidate
 * isn't a real declaration — most commonly because it's an ordinary call
 * whose closing paren is followed by `;`, `)`, `.`, etc., not `{`.
 */
function braceAfterParams(stripped: string, openParenIdx: number, matcher: (rest: string) => number | null): number | null {
	const params = extractBalancedArgs(stripped, openParenIdx);
	if (params === null) return null;
	const afterParen = openParenIdx + 2 + params.length;
	const matchLen = matcher(stripped.slice(afterParen));
	return matchLen === null ? null : afterParen + matchLen - 1;
}

/** Locate the `{` opening a `function NAME(...)` declaration's body, or null.
 *  Tries every textual occurrence of the name (not just the first) since an
 *  unrelated call earlier in the file can share a substring match. */
function functionDeclBraceIndex(stripped: string, escapedName: string): number | null {
	const re = new RegExp(String.raw`(?:async\s+)?function\s+${escapedName}\s*\(`, "g");
	let m: RegExpExecArray | null = re.exec(stripped);
	while (m !== null) {
		const braceIdx = braceAfterParams(stripped, m.index + m[0].length - 1, matchMethodBrace);
		if (braceIdx !== null) return braceIdx;
		m = re.exec(stripped);
	}
	return null;
}

/** Locate the `{` opening a method-shorthand (`NAME(...) {`, covers class
 *  methods too) or arrow-assigned (`NAME = (...) => {`) body, or null. */
function nameCallBraceIndex(stripped: string, escapedName: string): number | null {
	const re = new RegExp(String.raw`\b${escapedName}\s*(=\s*(?:async\s*)?)?\(`, "g");
	let m: RegExpExecArray | null = re.exec(stripped);
	while (m !== null) {
		const matcher = m[1] !== undefined ? matchArrowBrace : matchMethodBrace;
		const braceIdx = braceAfterParams(stripped, m.index + m[0].length - 1, matcher);
		if (braceIdx !== null) return braceIdx;
		m = re.exec(stripped);
	}
	return null;
}

/** The source text of the named function/method's body in `stripped` SUT
 *  content, or null when no declaration shape matches. */
function findFunctionScopeText(stripped: string, name: string): string | null {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const braceIdx = functionDeclBraceIndex(stripped, escaped) ?? nameCallBraceIndex(stripped, escaped);
	if (braceIdx === null) return null;
	return extractBalancedBraceBlock(stripped, braceIdx);
}

// Excluded from "called helper" detection — these read as `<keyword>(` under
// the identifier-call regex but are control-flow syntax, not a function call.
const CONTROL_KEYWORDS = new Set([
	"if", "for", "while", "switch", "catch", "function", "return", "typeof",
	"new", "super", "await", "async", "do", "void", "delete", "yield", "throw",
]);

/** Distinct `<name>(` call identifiers referenced in `body`, minus control
 *  keywords and `exclude` (the function's own name — no self-recursion hop). */
export function collectCalledIdentifiers(body: string, exclude: string): string[] {
	const re = new RegExp(CALL_IDENTIFIER_RE.source, "g");
	const names = new Set<string>();
	let m: RegExpExecArray | null = re.exec(body);
	while (m !== null) {
		const name = m[1];
		if (name !== undefined && name !== exclude && !CONTROL_KEYWORDS.has(name)) names.add(name);
		m = re.exec(body);
	}
	return [...names];
}

const MAX_HELPER_HOPS = 6;

/**
 * Throw sites reachable from calling `name` in the SUT: everything literally
 * inside its own body, plus (one hop only, no recursion) the bodies of
 * same-file helpers that body calls and that also resolve to a declaration.
 * Returns null when `name` doesn't resolve to any body in the SUT at all —
 * callers treat that as "do not fire".
 */
export function throwSitesReachableFrom(strippedSut: string, name: string): ThrowSite[] | null {
	const body = findFunctionScopeText(strippedSut, name);
	if (body === null) return null;
	const sites = collectThrowSites(body);
	for (const helperName of collectCalledIdentifiers(body, name).slice(0, MAX_HELPER_HOPS)) {
		const helperBody = findFunctionScopeText(strippedSut, helperName);
		if (helperBody !== null) sites.push(...collectThrowSites(helperBody));
	}
	return sites;
}
