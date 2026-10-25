// Agent Safety Checks — Async / Promise safety.
// Deterministic regex/heuristic checks targeting common AI agent mistakes.
// Extracted from agent-safety.ts to stay under the per-file line ceiling.

import { nonNull } from "../../lib/non-null.js";
import { arrayForEachOffsets } from "./array-for-each.js";
import { memberChainStart } from "./member-chain-scan.js";
import { blankJsxText } from "./nan-comparison-scan.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	isTestSourcePath,
	JS_TS_EXTS,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";
import { offsetToLine } from "./shared-text-utils.js";

// --- 1. Async/Promise Safety ---

// `.forEach(async` / `.reduce(async` — the second capture is the call paren.
const MISUSED_PROMISE_CALL_RE = /\.(forEach|reduce)\s*\(\s*async\b/g;

// Bound on the balanced-paren scan of a `.reduce(` argument list.
const REDUCE_ARGS_MAX_SCAN = 4000;

/**
 * Substring between the `(` at `openIdx` and its balanced `)`, or null when
 * the call does not close within `maxLen` characters.
 */
function balancedArgs(src: string, openIdx: number, maxLen = REDUCE_ARGS_MAX_SCAN): string | null {
	if (src[openIdx] !== "(") return null;
	let depth = 1;
	let j = openIdx + 1;
	const end = Math.min(src.length, openIdx + maxLen);
	while (j < end && depth > 0) {
		const c = src[j];
		if (c === "(") depth++;
		else if (c === ")") depth--;
		j++;
	}
	return depth === 0 ? src.slice(openIdx + 1, j - 1) : null;
}

/**
 * `await stream.forEach(async …)` — the receiver's forEach is being awaited,
 * so it may be a promise-returning API (Node streams, RxJS Observable, …).
 * Await alone proves no such contract: known arrays are checked separately.
 * Only a direct member chain between `await` and `.forEach` counts.
 */
function isAwaitedForEachReceiver(stripped: string, matchIdx: number): boolean {
	return /\bawait\s+$/.test(stripped.slice(0, memberChainStart(stripped, matchIdx)));
}

/**
 * The sequential promise-chain reduce idiom: `xs.reduce(async (prev, x) => {
 * await prev; … }, Promise.resolve())`. The accumulator IS a promise by
 * design, so an async reducer is the intended shape (typescript-eslint's
 * `no-misused-promises` does not flag it either). Recognized by any of: the
 * accumulator parameter is awaited, it is chained with `.then(`, or the seed
 * argument is a `Promise.*(…)` call.
 */
function isPromiseChainReduce(stripped: string, openIdx: number): boolean {
	const args = balancedArgs(stripped, openIdx);
	if (args === null) return false;
	const param = args.match(/^\s*async\s*(?:\(\s*([\w$]+)|([\w$]+)\s*=>)/);
	const acc = (param?.[1] ?? param?.[2])?.replace(/\$/g, "\\$");
	if (acc) {
		if (new RegExp(`\\bawait\\s+${acc}\\b`).test(args)) return true;
		if (new RegExp(`(?:^|[^\\w$.])${acc}\\s*\\.then\\s*\\(`).test(args)) return true;
	}
	return /,\s*Promise\s*\.\s*(?:resolve|reject|all|allSettled|race|any)\s*\([^()]*\)\s*$/.test(args);
}

/**
 * Detect no-misused-promises: passing an async function where a synchronous
 * callback is expected (e.g., Array.forEach, Array.map with async but no await on result).
 *
 * Two idioms are exempt because the callee consumes the promise by contract:
 * an awaited promise-returning `forEach` (see {@link isAwaitedForEachReceiver})
 * and the promise-chain `reduce` (see {@link isPromiseChainReduce}).
 */
export function checkMisusedPromises(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	// JSX text is prose (a docs page naming the anti-pattern), not a call.
	const stripped = stripCommentsAndStrings(blankJsxText(content, filePath));
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seenLines = new Set<number>();
	const arrayCalls = stripped.includes("forEach") ? arrayForEachOffsets(stripped, filePath) : new Set<number>();
	for (const m of stripped.matchAll(MISUSED_PROMISE_CALL_RE)) {
		if (matches.length >= 10) break;
		const idx = m.index;
		const line = offsetToLine(stripped, idx);
		if (m[1] === "forEach" && !arrayCalls.has(idx) && isAwaitedForEachReceiver(stripped, idx)) continue;
		if (m[1] === "reduce" && isPromiseChainReduce(stripped, idx + m[0].indexOf("("))) continue;
		if (seenLines.has(line)) continue;
		seenLines.add(line);
		matches.push({ line, text: nonNull(originalLines[line - 1]).trim().slice(0, 150) });
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

// Return types that mark a signature as promise-returning.
const PROMISE_TYPE_RE = /^(?:Promise|AsyncIterable|AsyncGenerator|AsyncIterator)\b/;

/**
 * True when the `function name(` declaration matched by `m` on line `i` is
 * synchronous: its parameter list is followed by a body or a `;`-terminated
 * row whose declared return type is not promise-shaped. An overload or
 * `declare` row `function load(x): Promise<T>;` is not sync, so it never
 * shadows the async implementation. Parameters that do not close within the
 * statement span are undecidable and read as sync (the ambiguity default).
 */
function isSyncFunctionDeclaration(
	strippedLines: string[],
	i: number,
	m: RegExpMatchArray,
): boolean {
	const from = nonNull(m.index) + m[0].length - 1;
	const text = statementSpan(strippedLines, i).slice(from).replace(/^<[^()]*>\s*/, "");
	const args = balancedArgs(text, 0, text.length);
	if (args === null) return true;
	const tail = text.slice(args.length + 2);
	if (/^\s*[{;]/.test(tail)) return true;
	const typed = tail.match(/^\s*:\s*([^{;]*)[{;]/);
	return typed !== null && !PROMISE_TYPE_RE.test(nonNull(typed[1]).trim());
}

/**
 * Pass 1b of {@link checkFloatingPromises}: identifiers declared WITHOUT
 * `async` — a sync `function foo(` (see {@link isSyncFunctionDeclaration})
 * and `const foo = (` / `= <T>(` / `= function`. The detector has no scope
 * resolution, so an id in BOTH sets — a sync local sharing its name with an
 * async local in another function — is ambiguous and is dropped from the
 * async set rather than guessed. A sync shorthand METHOD definition does not
 * count: its own line is excluded as a definition in pass 2, and letting it
 * shadow would hide `a.start()` for an unrelated class `async start()`.
 */
function collectFloatingSyncIds(strippedLines: string[]): Set<string> {
	const syncIds = new Set<string>();
	for (let i = 0; i < strippedLines.length; i++) {
		const line = nonNull(strippedLines[i]);
		let m = line.match(/(?:^|[^\w$])function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/);
		if (m && !/\basync\s+function\b/.test(line) && isSyncFunctionDeclaration(strippedLines, i, m))
			syncIds.add(nonNull(m[1]));
		m = line.match(
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?\s*=\s*(?:function\b|[(<])/,
		);
		if (m) syncIds.add(nonNull(m[1]));
	}
	return syncIds;
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
	const leafId = nonNull(nonNull(callPath)
		.replace(/\?\./g, ".")
		.split(".")
		.pop()).replace(/\[.*\]/g, "");
	return leafId;
}

// Bound on how many lines one statement-span scan may consume.
const STATEMENT_SPAN_MAX_LINES = 60;

/**
 * Lines `i`.. joined with "\n", up to and including the first line at whose
 * end every bracket opened since line `i` has closed (bounded by
 * {@link STATEMENT_SPAN_MAX_LINES}). A line balanced on its own is returned
 * alone. Operates on stripped text, so string/comment brackets are gone.
 */
function statementSpan(strippedLines: string[], i: number): string {
	const end = Math.min(strippedLines.length, i + STATEMENT_SPAN_MAX_LINES);
	const parts: string[] = [];
	let depth = 0;
	for (let j = i; j < end; j++) {
		const line = nonNull(strippedLines[j]);
		parts.push(line);
		for (const c of line) {
			if ("([{".includes(c)) depth++;
			else if (")]}".includes(c)) depth--;
		}
		if (depth <= 0) break;
	}
	return parts.join("\n");
}

/**
 * `text` with every bracketed region blanked: only depth-0 characters and the
 * brackets that open/close depth 0 survive. Lets a regex test a statement's
 * own chain without seeing callback bodies or argument lists.
 */
function depthZeroText(text: string): string {
	let depth = 0;
	let out = "";
	for (const c of text) {
		if ("([{".includes(c)) {
			if (depth === 0) out += c;
			depth++;
		} else if (")]}".includes(c)) {
			depth--;
			if (depth === 0) out += c;
		} else if (depth === 0) out += c;
	}
	return out;
}

/**
 * Text after the leading call's balanced argument list in `text` (which must
 * start with the call path), or null when `text` does not start with a call or
 * its parens never close within it.
 */
function leadingCallTail(text: string): string | null {
	const m = nonNull(text.match(/^[\w$?.[\]]+\s*\(/));
	const open = m[0].length - 1;
	const args = balancedArgs(text, open, text.length);
	return args === null ? null : text.slice(open + args.length + 2);
}

/**
 * Per-line body of {@link checkFloatingPromises} pass 2: decide whether the
 * stripped line at index `i` is an unhandled call to a known-async identifier,
 * and if so build the {@link InlineMatch} for it. Returns null for every
 * non-match reason (empty line, syntactic skip, unknown callee, method
 * definition or signature shape, or already `.catch`/`.finally`-handled on
 * the statement's own chain).
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
	if (!asyncIds.has(leafId)) return null;

	// The whole statement (a multi-line `.then(cb => {\n…\n}).catch(x);` chain,
	// a multi-line argument list or signature), not just this line. An argument
	// list that does not close within the span bound (`save(1, () => {` with a
	// long callback) is a call, not a signature: judge it as a bare call with
	// no visible tail, so it still fires.
	const tail = leadingCallTail(statementSpan(strippedLines, i).trimStart()) ?? "";

	// A balanced argument list followed by a body brace, or by a return-type
	// annotation that ends the statement (`;`) or opens a body (`{`), is a
	// method DEFINITION or SIGNATURE (`value() {`, `safeParseAsync(\n…\n):
	// Promise<…>;`), never a call.
	if (/^\s*(?:\{|:\s*[^;{]*(?:;\s*$|\{))/.test(tail)) return null;

	// Already-handled: `.catch(` / `.finally(` on the statement's OWN chain
	// (depth 0 after the leading call). A handler nested inside a callback
	// body does not count.
	if (/\.(?:catch|finally)\s*\(/.test(depthZeroText(tail))) return null;

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
 *      non-blank line ends with `(`, `[`, or `,`), lines that belong to a
 *      multi-line chain (next non-blank line starts with `.`), and method
 *      definitions / signatures (`name(args) {`, `name(\n…\n): Promise<…>;`).
 *      Under-detect rather than FP.
 *   4. An identifier declared BOTH async and sync in the file (two same-named
 *      locals or functions in different scopes) is ambiguous without scope
 *      resolution and is dropped from the async set. Overload rows, sync
 *      shorthand methods and the built-in allowlist do not take part.
 *
 * Only flags calls we KNOW return a promise (async-declared in-file + small
 * built-in allowlist). Unknown third-party calls are skipped — that's a
 * type-info problem, not a regex problem. Test sources (including a top-level
 * `test/` directory) are skipped: fire-and-forget calls there are fixtures.
 */
export function checkFloatingPromises(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath) || isTestSourcePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// Pass 1: collect async identifiers declared in this file, minus every id
	// that is also declared sync, then the built-in allowlist. The ambiguity
	// drop applies only to in-file async declarations: a sync local named
	// `fetch` in one function does not hide the global `fetch` everywhere.
	const asyncIds = collectFloatingAsyncIds(strippedLines);
	for (const id of collectFloatingSyncIds(strippedLines)) asyncIds.delete(id);
	for (const id of BUILTIN_ASYNC_IDS) asyncIds.add(id);

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
		if (intentCommentRe.test(nonNull(originalLines[i]))) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}
