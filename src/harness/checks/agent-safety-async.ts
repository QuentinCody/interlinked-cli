// Agent Safety Checks — Async / Promise safety.
// Deterministic regex/heuristic checks targeting common AI agent mistakes.
// Extracted from agent-safety.ts to stay under the per-file line ceiling.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

// --- 1. Async/Promise Safety ---

/**
 * Detect no-misused-promises: passing an async function where a synchronous
 * callback is expected (e.g., Array.forEach, Array.map with async but no await on result).
 */
export function checkMisusedPromises(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = nonNull(strippedLines[i]).trim();
		// .forEach(async, .map(async without assignment, .filter(async, .some(async, .every(async
		if (/\.(forEach|reduce)\s*\(\s*async\b/.test(trimmed)) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

// Always-async built-ins commonly forgotten at statement position.
const BUILTIN_ASYNC_IDS = new Set(["fetch"]);

// Keywords that, when they lead a statement, consume or redirect the value so
// the promise cannot be floating.
const STATEMENT_PREFIX_KEYWORDS =
	/^(?:await|return|yield|void|throw|if|else|for|while|switch|case|default|try|catch|finally|do|break|continue|class|function|const|let|var|export|import|type|interface|enum|new|typeof|delete|async)\b/;

/**
 * Pass 1 of {@link checkFloatingPromises}: collect identifiers declared `async`
 * in this file — top-level/generator functions, arrow/expression assignments,
 * class methods (with access modifiers), and object-shorthand properties.
 */
function collectFloatingAsyncIds(strippedLines: string[]): Set<string> {
	const asyncIds = new Set<string>();
	for (const line of strippedLines) {
		// `async function foo(` / `async function *foo(`
		let m = line.match(/\basync\s+function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/);
		if (m) asyncIds.add(nonNull(m[1]));
		// `const foo = async (`, `let foo: Type = async <T>(`, etc.
		m = line.match(
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?\s*=\s*async\s*[(<]/,
		);
		if (m) asyncIds.add(nonNull(m[1]));
		// Class method: `  async foo(` with optional access modifiers / static.
		m = line.match(
			/^\s+(?:(?:public|private|protected|static|readonly|override|abstract)\s+)*async\s+([A-Za-z_$][\w$]*)\s*[(<]/,
		);
		if (m && m[1] !== "function") asyncIds.add(nonNull(m[1]));
		// Object shorthand property: `foo: async (`.
		m = line.match(/\b([A-Za-z_$][\w$]*)\s*:\s*async\s*[(<]/);
		if (m) asyncIds.add(nonNull(m[1]));
	}
	return asyncIds;
}

/**
 * Per-line skip predicate for {@link checkFloatingPromises} pass 2. Returns true
 * when `trimmed` (the stripped, trimmed line at index `i`) is NOT a candidate
 * floating-promise statement on syntactic grounds alone — independent of whether
 * the call target is known-async. Under-detects rather than risk a false
 * positive. Each branch's rationale matches the original inline comments.
 */
function shouldSkipFloatingLine(strippedLines: string[], i: number, trimmed: string): boolean {
	// Must start with an identifier; rules out `})`, `.then(...)` chain
	// continuation, `}` block closes, etc.
	if (!/^[A-Za-z_$]/.test(trimmed)) return true;
	if (STATEMENT_PREFIX_KEYWORDS.test(trimmed)) return true;

	// Skip if previous non-blank line indicates we're inside an argument list or
	// array literal — then our "statement-position" assumption is wrong. We
	// deliberately DO NOT include `{` here: a trailing `{` is much more often a
	// block opener (function/class/if/etc.) than a multi-line object literal, and
	// treating blocks as arg lists would swallow every statement after a brace.
	let prev = i - 1;
	while (prev >= 0 && nonNull(strippedLines[prev]).trim() === "") prev--;
	if (prev >= 0 && /[([,]\s*$/.test(nonNull(strippedLines[prev]))) return true;

	// Skip arrow-function concise-body return values. When the previous non-blank
	// line ends with `=>`, this line is the single-expression body of an arrow
	// function — its value is *returned*, not dropped. Example false-positive:
	// `discovered.map((d) =>\n    probeHealth(d))`
	if (prev >= 0 && /=>\s*$/.test(nonNull(strippedLines[prev]))) return true;

	// Skip TypeScript interface / type method signatures. A line like
	// `drain(timeoutMs?: number): Promise<void>;` inside an `interface` body
	// syntactically looks like a call but is a DECLARATION — it doesn't execute
	// at runtime. Giveaway: trailing `: Promise<…>;` / `: AsyncIterable<…>;`.
	if (
		/\)\s*:\s*(?:Promise|AsyncIterable|AsyncGenerator|AsyncIterator)\s*<[^>]*>\s*;\s*$/.test(
			trimmed,
		)
	)
		return true;

	// Skip multi-line chain bodies: if next non-blank line starts with `.`, the
	// chain's handler (if any) lives on a later line and we can't tell with
	// regex. Under-detect by skipping.
	let next = i + 1;
	while (next < strippedLines.length && nonNull(strippedLines[next]).trim() === "") next++;
	if (next < strippedLines.length && nonNull(strippedLines[next]).trim().startsWith(".")) return true;

	return false;
}

/**
 * Extract the leaf identifier of a statement-position call for
 * {@link checkFloatingPromises}. Captures the leading call path (identifier,
 * dotted, optional-chain, or bracketed) up to the opening paren, then reduces it
 * to the final identifier for async-id lookup. Returns null when the line has no
 * leading call or the leaf can't be isolated.
 */
function extractCallLeafId(trimmed: string): string | null {
	const callMatch = trimmed.match(/^([\w$?.[\]]+)\s*\(/);
	if (!callMatch) return null;
	const callPath = callMatch[1];
	const leafId = nonNull(callPath)
		.replace(/\?\./g, ".")
		.split(".")
		.pop()
		?.replace(/\[.*\]/g, "");
	return leafId ?? null;
}

/**
 * Per-line body of {@link checkFloatingPromises} pass 2: decide whether the
 * stripped line at index `i` is an unhandled call to a known-async identifier,
 * and if so build the {@link InlineMatch} for it. Returns null for every
 * non-match reason (empty line, syntactic skip, unknown callee, already
 * `.catch`/`.finally`-handled).
 */
function matchFloatingPromiseAt(
	strippedLines: string[],
	originalLines: string[],
	i: number,
	asyncIds: Set<string>,
): InlineMatch | null {
	const trimmed = nonNull(strippedLines[i]).trim();
	if (!trimmed) return null;
	if (shouldSkipFloatingLine(strippedLines, i, trimmed)) return null;

	const leafId = extractCallLeafId(trimmed);
	if (!leafId) return null;
	if (!asyncIds.has(leafId) && !BUILTIN_ASYNC_IDS.has(leafId)) return null;

	// Already-handled chain: `.catch(` or `.finally(` anywhere on this line.
	if (/\.catch\s*\(/.test(trimmed)) return null;
	if (/\.finally\s*\(/.test(trimmed)) return null;

	return { line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) };
}

/**
 * Detect floating promises: calls to async-declared functions (or known promise-
 * returning globals like fetch) at statement position without await, return,
 * void, yield, throw, assignment, or a trailing .catch()/.finally() handler.
 *
 * Unhandled rejections from floating promises produce silent failures and
 * `unhandledRejection` warnings in Node. For cold agents reading the code, a
 * bare `foo()` statement gives no signal that `foo` is async — missing the
 * await is an extremely common mistake.
 *
 * Strategy (regex, no type info):
 *   1. Collect identifiers declared `async` in this file — functions, arrow
 *      assignments, class methods, object shorthand.
 *   2. Scan statement-position lines for bare calls to those identifiers (or
 *      to the built-in `fetch`) that lack a handling prefix and don't end with
 *      `.catch(…)`/`.finally(…)` on the same line.
 *   3. Skip lines that are inside an argument list / array literal (previous
 *      non-blank line ends with `(`, `[`, `{`, or `,`) and lines that belong to
 *      a multi-line chain (next non-blank line starts with `.`). Under-detect
 *      rather than FP.
 *
 * Only flags calls we KNOW return a promise (async-declared in-file + small
 * built-in allowlist). Unknown third-party calls are skipped — that's a
 * type-info problem, not a regex problem.
 */
export function checkFloatingPromises(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// Pass 1: collect async identifiers declared in this file.
	const asyncIds = collectFloatingAsyncIds(strippedLines);

	// Pass 2: scan statement-position lines for bare calls to known-async ids.
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const match = matchFloatingPromiseAt(strippedLines, originalLines, i, asyncIds);
		if (match) matches.push(match);
	}

	return matches;
}

/**
 * Detect no-async-promise-executor: new Promise(async (resolve, reject) => { ... })
 * This is always a bug — the executor should not be async.
 */
export function checkAsyncPromiseExecutor(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /new\s+Promise\s*\(\s*async\b/, 10);
}

/**
 * Detect `.catch(...)` handlers whose body is empty or returns a literal nothing
 * — the async cousin of `checkSilentCatch`. Swallowed rejections silently
 * mask bugs and break optimistic-grant rollback patterns (see the recent
 * ServerBridge.reserveFile fix).
 *
 * Patterns flagged (single-line):
 *   .catch arrow or .catch(function) with an EMPTY body. A handler that
 *   returns an explicit value (`() => null` / `() => undefined` / a fallback)
 *   is deliberate graceful degradation — the rejection becomes a sentinel the
 *   caller handles — not a silent swallow, so it is exempt. Inline body
 *   comments mark intent and exempt the line too, matching checkSilentCatch.
 */
export function checkSilentPromiseSwallow(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// Empty-body only. A handler returning an explicit value (null / undefined /
	// void 0 / any fallback) is deliberate graceful degradation, not a silent
	// swallow — see the docstring. Empty `{}` discards everything (the
	// optimistic-grant-rollback bug class this check guards).
	const arrowPattern =
		/\.catch\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*\}\s*\)/;
	const functionPattern =
		/\.catch\s*\(\s*function\s*[A-Za-z_$\w]*\s*\([^)]*\)\s*\{\s*\}\s*\)/;
	const intentCommentRe = /\.catch\s*\(.*(?:\/\/|\/\*)/;

	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);
		if (!arrowPattern.test(line) && !functionPattern.test(line)) continue;
		if (intentCommentRe.test(originalLines[i] ?? "")) continue;
		matches.push({ line: i + 1, text: (originalLines[i] ?? "").trim().slice(0, 150) });
	}
	return matches;
}
