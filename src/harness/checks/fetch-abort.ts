// fetch-abort — detects a `fetch(...)` call with no AbortSignal wired in.
//
// Bug class: a fetch with no `signal` option cannot be cancelled and inherits
// no timeout from the platform — the request can hang for the socket's
// lifetime. In browsers this leaks past component unmount and tab teardown;
// in Node it holds the event loop and mismatches serverless deadlines.
//
// Effect-TS lessons port (docs/design/effect-ts-harness-additions.md §10):
// Effect's HttpClient threads an interruption-bound AbortSignal into every
// underlying fetch (packages/effect/src/unstable/http/HttpClient.ts) — the
// vanilla-JS discipline this check approximates.
//
// What fires:
//   * bare single-argument `fetch(url)`
//   * `fetch(url, { ...options object with no `signal` key and no spread })`
// What never fires:
//   * an options object carrying `signal` (incl. `AbortSignal.timeout(...)`)
//   * an options object with a spread (`...opts` may carry a signal)
//   * a non-literal options argument (identifier/call — contents not visible)
//   * wrapper methods (`client.fetch(...)`) other than globalThis/window/self
//   * test files, non-JS/TS files, files that define their own `fetch`
//
// check id: `fetch_without_abort_signal`. Advisory: fire-and-forget fetches
// with process-lifetime scope (CLI one-shots) are legitimate.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

const MAX_MATCHES = 5;
const CALL_WINDOW_BUDGET = 1200;

/** A global fetch call site: bare `fetch(` not preceded by `.`/word char,
 *  or explicitly `globalThis.fetch(` / `window.fetch(` / `self.fetch(`. */
const FETCH_CALL_RE = /\b(?:globalThis|window|self)\s*\.\s*fetch\s*\(|(?<![.\w$])fetch\s*\(/g;

/** The file defines its own `fetch` — every call site is the wrapper, not the
 *  platform API, so its option shape is unknowable here. */
const LOCAL_FETCH_DECL_RE =
	/\b(?:function\s+fetch\b|(?:const|let|var)\s+fetch\s*=|fetch\s*[:=]\s*(?:async\b|\(|function\b))/;

/** Slice the call's full argument text: from the char after `(` to its
 *  matching `)`, bracket-balanced, budget-bounded. Returns null when the
 *  close paren is outside the budget (give up rather than guess). */
function argumentWindow(text: string, afterOpen: number): string | null {
	let depth = 1;
	const end = Math.min(text.length, afterOpen + CALL_WINDOW_BUDGET);
	for (let i = afterOpen; i < end; i++) {
		const ch = text.charAt(i);
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			if (depth === 0) return text.slice(afterOpen, i);
		}
	}
	return null;
}

/** Split the argument window at top-level commas (depth 0 within the window). */
function topLevelArgs(window: string): string[] {
	const args: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < window.length; i++) {
		const ch = window.charAt(i);
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) {
			args.push(window.slice(start, i));
			start = i + 1;
		}
	}
	args.push(window.slice(start));
	return args.map((a) => a.trim()).filter((a) => a.length > 0);
}

/** Verdict for one fetch call's arguments. Returns the finding text when the
 *  call should be flagged, null when it is fine or unknowable. */
function verdictFor(args: string[]): string | null {
	if (args.length === 0) return null; // `fetch()` — a type error, not this class
	if (args.length === 1) {
		return "fetch() with no options — the request cannot be cancelled and never times out; pass { signal: AbortSignal.timeout(ms) } or a controller's signal";
	}
	const options = args[1] ?? "";
	// Non-literal options (identifier, call, member) — contents not visible.
	if (!options.startsWith("{")) return null;
	// A spread may carry a signal from elsewhere.
	if (options.includes("...")) return null;
	if (/\bsignal\b/.test(options)) return null;
	return "fetch() options carry no `signal` — add { signal: AbortSignal.timeout(ms) } (or an AbortController signal tied to the caller's lifetime)";
}

/**
 * Detect `fetch(...)` calls that wire in no AbortSignal.
 *
 * check id: `fetch_without_abort_signal`
 */
export function checkFetchWithoutAbortSignal(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	// Strings/comments stripped so `fetch(` inside prose or a template never
	// matches, and so bracket-balance in the argument window is trustworthy.
	const stripped = stripCommentsAndStrings(content);
	if (LOCAL_FETCH_DECL_RE.test(stripped)) return [];

	const matches: InlineMatch[] = [];
	const seen = new Set<number>();
	FETCH_CALL_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FETCH_CALL_RE.exec(stripped)) !== null) {
		const afterOpen = m.index + m[0].length;
		const window = argumentWindow(stripped, afterOpen);
		if (window === null) continue;

		const finding = verdictFor(topLevelArgs(window));
		if (finding === null) continue;

		const lineNo = stripped.slice(0, m.index).split("\n").length;
		if (seen.has(lineNo)) continue;
		seen.add(lineNo);
		matches.push({ line: lineNo, text: finding });
		if (matches.length >= MAX_MATCHES) break;
	}
	return matches;
}
