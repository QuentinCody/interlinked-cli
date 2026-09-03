// Flow-safety inline checks (advisory).
//
// Three checks shipping together:
//   - checkAwaitStateToctou: same field deref'd before and after an `await`
//     without re-check (Firefox 2021894/2022733 — IPC race over async).
//   - checkCleanupReentrancy: dispose/destroy methods calling themselves,
//     or useEffect cleanups mutating state (Firefox 2024653/2027298 —
//     UAF via re-entry during teardown).
//   - checkBoundaryCopyNoRevalidation: Object.assign / spread copy of
//     external input into a typed slot without a validator on the source
//     (Firefox 2029813 — RLBox copy verification gap).

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

const REPORT_LINE_TRUNC = 150;
const MAX_MATCHES_PER_FILE = 10;
/** Max chars to scan inside an `if` body for the await-toctou pattern. */
const IF_BODY_SCAN_BUDGET = 5000;
/** Max chars to scan inside a method body for cleanup-reentrancy pattern. */
const METHOD_BODY_SCAN_BUDGET = 8000;

const EXTERNAL_INPUT_RE =
	/(?:\b(?:req|request)\.(?:body|query|params)\b|\bprocess\.argv\b|\bprocess\.env\.\w+|\bJSON\.parse\s*\()/;

// Validator detection. Negative lookbehind on `.parse(` rules out the
// `JSON.parse(...)` form — that's the parser that produced the raw
// untrusted value, NOT a validator that narrows it to a typed shape.
const VALIDATOR_RES: RegExp[] = [
	/(?<!JSON)\.parse\s*\(/,
	/\.safeParse\s*\(/,
	/\.validate\s*\(/,
];

function findMatchingBrace(s: string, openIdx: number, budget: number): number {
	let depth = 0;
	const end = Math.min(s.length, openIdx + budget);
	for (let i = openIdx; i < end; i++) {
		const c = s.charAt(i);
		if (c === "{") {
			depth++;
		} else if (c === "}" && --depth === 0) {
			return i;
		}
	}
	return -1;
}

function recordLine(
	stripped: string,
	rawLines: string[],
	offset: number,
	matches: InlineMatch[],
	seen: Set<number>,
): boolean {
	const lineNo = stripped.slice(0, offset).split("\n").length;
	if (seen.has(lineNo)) return false;
	seen.add(lineNo);
	matches.push({
		line: lineNo,
		text: (rawLines[lineNo - 1] || "").trim().slice(0, REPORT_LINE_TRUNC),
	});
	return matches.length >= MAX_MATCHES_PER_FILE;
}

// ===========================================
// checkAwaitStateToctou
// ===========================================

/**
 * Detect `if (X.Y) { ... await ...; X.Y.method() }` shapes — same dotted
 * field accessed before and after an await without re-check on the second
 * read. JS analog of Firefox 2021894 / 2022733 (IPC race over async).
 */
export function checkAwaitStateToctou(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	// Match `if (DOTTED.PATH)` where DOTTED.PATH has at least one `.`.
	const ifRe =
		/\bif\s*\(\s*((?:this|[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)+)\s*\)\s*\{/g;
	let ifHit: RegExpExecArray | null;
	while ((ifHit = ifRe.exec(stripped))) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return matches;
		const path = ifHit[1];
		const openBrace = ifHit.index + ifHit[0].length - 1;
		const closeBrace = findMatchingBrace(stripped, openBrace, IF_BODY_SCAN_BUDGET);
		if (closeBrace < 0) continue;

		const body = stripped.slice(openBrace + 1, closeBrace);
		const awaitIdx = body.indexOf("await");
		if (awaitIdx < 0) continue;
		const afterAwait = body.slice(awaitIdx);

		const escapedPath = nonNull(path).replace(/[.$]/g, (m) => `\\${m}`);
		// Use of same path after await: `<path>.<method>(`, `<path> =`, `<path>(`.
		const useRe = new RegExp(
			String.raw`\b${escapedPath}\s*(?:\.[A-Za-z_$][\w$]*\s*\(|\s*=(?!=)|\s*\()`,
		);
		const useMatch = afterAwait.match(useRe);
		if (!useMatch || useMatch.index === undefined) continue;

		// Suppress if there's a re-check between await and use.
		const recheckRe = new RegExp(
			String.raw`\bif\s*\(\s*${escapedPath}\b`,
		);
		const between = afterAwait.slice(0, useMatch.index);
		if (recheckRe.test(between)) continue;

		const useOffset = openBrace + 1 + awaitIdx + useMatch.index;
		if (recordLine(stripped, lines, useOffset, matches, seen)) return matches;
	}

	return matches;
}

// ===========================================
// checkCleanupReentrancy
// ===========================================

const CLEANUP_METHOD_NAMES = ["dispose", "destroy", "close", "teardown", "unmount", "cleanup"];

/**
 * Detect cleanup methods that recurse into themselves (UAF risk) or
 * useEffect cleanups that mutate React state (re-render storm + UAF).
 */
export function checkCleanupReentrancy(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	if (scanSelfRecursingCleanupMethod(stripped, lines, matches, seen)) return matches;
	scanEffectCleanupStateMutation(stripped, lines, matches, seen);

	return matches;
}

// Offset of the `this.<name>(` self-call inside the cleanup method whose
// header `methodHit` matched, or null when the method never recurses.
function findSelfRecursionOffset(stripped: string, methodHit: RegExpExecArray): number | null {
	const name = methodHit[1];
	const openBrace = methodHit.index + methodHit[0].length - 1;
	const closeBrace = findMatchingBrace(stripped, openBrace, METHOD_BODY_SCAN_BUDGET);
	if (closeBrace < 0) return null;

	const body = stripped.slice(openBrace + 1, closeBrace);
	const recurseRe = new RegExp(String.raw`\bthis\s*\.\s*${name}\s*\(`);
	const recurseHit = body.match(recurseRe);
	if (!recurseHit || recurseHit.index === undefined) return null;

	return openBrace + 1 + recurseHit.index;
}

// Class method recursing into self: `<name>() { ... this.<name>(...) ... }`.
// Returns true when the per-file match cap was hit (caller should stop).
function scanSelfRecursingCleanupMethod(
	stripped: string,
	lines: string[],
	matches: InlineMatch[],
	seen: Set<number>,
): boolean {
	const methodNameAlt = CLEANUP_METHOD_NAMES.join("|");
	const methodHeaderRe = new RegExp(
		String.raw`\b(${methodNameAlt})\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{`,
		"g",
	);
	let methodHit: RegExpExecArray | null;
	while ((methodHit = methodHeaderRe.exec(stripped))) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return true;
		const offset = findSelfRecursionOffset(stripped, methodHit);
		if (offset === null) continue;
		if (recordLine(stripped, lines, offset, matches, seen)) return true;
	}
	return false;
}

// Offset of the React state mutator inside the useEffect cleanup arrow whose
// shape `effectHit` matched, or null when the cleanup mutates no state.
function findCleanupStateMutatorOffset(effectHit: RegExpExecArray): number | null {
	const cleanupBody = effectHit[1];
	const stateMutator = nonNull(cleanupBody).match(/\b(?:set[A-Z]\w*|dispatch)\s*\(/);
	if (!stateMutator || stateMutator.index === undefined) return null;
	// Locate the offset of the mutator within the original stripped string.
	const cleanupStart =
		effectHit.index + effectHit[0].indexOf("{", effectHit[0].lastIndexOf("=>")) + 1;
	return cleanupStart + stateMutator.index;
}

// useEffect cleanup that contains state mutation. Heuristic: an arrow
// returned from useEffect's effect, whose body calls `set<Capital>(...)`
// or `dispatch(...)` (canonical React state mutators).
// Returns true when the per-file match cap was hit.
function scanEffectCleanupStateMutation(
	stripped: string,
	lines: string[],
	matches: InlineMatch[],
	seen: Set<number>,
): boolean {
	const effectCleanupRe =
		/\buseEffect\s*\(\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,4000}?return\s*\(\s*\)\s*=>\s*\{([\s\S]{0,2000}?)\}/g;
	let effectHit: RegExpExecArray | null;
	while ((effectHit = effectCleanupRe.exec(stripped))) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return true;
		const offset = findCleanupStateMutatorOffset(effectHit);
		if (offset === null) continue;
		if (recordLine(stripped, lines, offset, matches, seen)) return true;
	}
	return false;
}

// ===========================================
// checkBoundaryCopyNoRevalidation
// ===========================================

/**
 * Detect Object.assign / spread copy of external input into a typed slot
 * without a validator on the source. JS analog of Firefox 2029813
 * (RLBox verification gap on copy boundary).
 */
export function checkBoundaryCopyNoRevalidation(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	if (scanObjectAssignBoundary(stripped, lines, matches, seen)) return matches;
	scanSpreadBoundary(stripped, lines, matches, seen);

	return matches;
}

function isValidated(text: string): boolean {
	return VALIDATOR_RES.some((re) => re.test(text));
}

function findMatchingParen(s: string, openIdx: number, budget: number): number {
	let depth = 0;
	const end = Math.min(s.length, openIdx + budget);
	for (let i = openIdx; i < end; i++) {
		const c = s.charAt(i);
		if (c === "(") {
			depth++;
		} else if (c === ")" && --depth === 0) {
			return i;
		}
	}
	return -1;
}

// Object.assign(<typed>, <source>...) where any source contains external
// input and the source itself isn't a validator call. Returns true when the
// per-file match cap was hit (caller should stop scanning immediately).
function scanObjectAssignBoundary(
	stripped: string,
	lines: string[],
	matches: InlineMatch[],
	seen: Set<number>,
): boolean {
	const assignRe = /\bObject\.assign\s*\(/g;
	let assignHit: RegExpExecArray | null;
	while ((assignHit = assignRe.exec(stripped))) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return true;
		const openParen = assignHit.index + assignHit[0].length - 1;
		const close = findMatchingParen(stripped, openParen, 4000);
		if (close < 0) continue;
		const args = stripped.slice(openParen + 1, close);
		// Sources are everything past the first comma.
		const firstComma = args.indexOf(",");
		if (firstComma < 0) continue;
		const sources = args.slice(firstComma + 1);
		if (!EXTERNAL_INPUT_RE.test(sources)) continue;
		if (isValidated(sources)) continue;
		if (recordLine(stripped, lines, assignHit.index, matches, seen)) return true;
	}
	return false;
}

// Spread of external input inside an object literal: `{ ...req.body }` etc.
// Returns true when the per-file match cap was hit.
function scanSpreadBoundary(
	stripped: string,
	lines: string[],
	matches: InlineMatch[],
	seen: Set<number>,
): boolean {
	const spreadRe =
		/\{[^{}]*\.\.\.\s*((?:req|request)\.(?:body|query|params)\b[\w$.]*|process\.(?:argv|env)[\w$.]*)/g;
	let spreadHit: RegExpExecArray | null;
	while ((spreadHit = spreadRe.exec(stripped))) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return true;
		// Suppress if this object literal is the argument to a validator call.
		const before = stripped.slice(Math.max(0, spreadHit.index - 80), spreadHit.index);
		if (isValidated(before)) continue;
		if (recordLine(stripped, lines, spreadHit.index, matches, seen)) return true;
	}
	return false;
}
