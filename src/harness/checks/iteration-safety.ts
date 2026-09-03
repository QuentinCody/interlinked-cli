// Iteration-safety inline checks. Two detectors:
//   - checkIteratorInvalidation: mutating an array/Map/Set while iterating it.
//   - checkFreshCollectionKeyLookup: using a fresh-identity value (NaN,
//     object literal, fresh Symbol, spread literal, fresh `new` instance)
//     as a Map/Set key — the lookup is a guaranteed miss.
//
// JS analogs of Firefox bugs 2025977 (XSLT key() rehash freed backing store
// mid-iter) and 2022034 (raw NaN crossing tagged-pointer boundary). See
// docs/design/harness-firefox-bug-class-checks-plan.md.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Iterator Invalidation
// ===========================================

const ITERATOR_HEADER_RE =
	/\bfor\s*\(\s*(?:const|let|var)?\s+[\w[\]{},\s]+\s+(?:of|in)\s+([A-Za-z_$][\w$]*)\s*\)/g;

const FOREACH_HEADER_RE =
	/\b([A-Za-z_$][\w$]*)\s*\.\s*(?:forEach|map|filter|reduce|reduceRight|find|findIndex|findLast|findLastIndex|some|every|flatMap)\s*\(/g;

const MUTATING_METHODS = [
	// Array
	"push",
	"pop",
	"shift",
	"unshift",
	"splice",
	"sort",
	"reverse",
	"fill",
	"copyWithin",
	// Map / Set
	"set",
	"delete",
	"clear",
	"add",
];

/** Cap the brace-scan window per loop body — far larger than any realistic
 * loop body in source we care about; prevents a runaway scan on minified
 * or pathologically-deep nesting. */
const MAX_BRACE_SCAN_CHARS = 20000;
/** Cap how far past the loop header we'll look for `{`. Headers are short;
 * 200 chars is generous and rules out runaway scans on malformed input. */
const MAX_HEADER_TO_BODY_CHARS = 200;
/** Truncate the matching line in the report so the agent's context isn't
 * blown by a single long line. */
const REPORT_LINE_TRUNC = 150;

function findMatchingBrace(s: string, openIdx: number): number {
	let depth = 0;
	const end = Math.min(s.length, openIdx + MAX_BRACE_SCAN_CHARS);
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

/** Matching ")" for the "(" at `openIdx`, or -1. Used to bound a forEach-style
 * callback's body to within the call's own parens — see the call site. */
function findMatchingParen(s: string, openIdx: number): number {
	let depth = 0;
	const end = Math.min(s.length, openIdx + MAX_BRACE_SCAN_CHARS);
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

function findBodyOpen(s: string, headerEnd: number): number {
	const end = Math.min(s.length, headerEnd + MAX_HEADER_TO_BODY_CHARS);
	const slice = s.slice(headerEnd, end);
	const openBrace = slice.indexOf("{");
	if (openBrace < 0) return -1;
	const semicolon = slice.indexOf(";");
	if (semicolon >= 0 && semicolon < openBrace) return -1;
	return headerEnd + openBrace;
}

/**
 * Resolve the brace-delimited `{ ... }` body range for one iteration
 * candidate, or null if this candidate has no body to scan.
 *
 * forEach-style: the callback's brace body must sit INSIDE the call's own
 * parens. An expression-arrow callback (e.g. `arr.some((e) => e.x === y)`)
 * has no statement body; without this bound, `findBodyOpen` latches onto the
 * next unrelated `{` block (the enclosing if/for) and reports mutations that
 * aren't in the callback at all. Bounding to the call's `)` drops those FPs.
 */
function resolveLoopBodyRange(
	stripped: string,
	headerIdx: number,
	callParenIdx: number | undefined,
): { bodyOpen: number; bodyClose: number } | null {
	const bodyOpen = findBodyOpen(stripped, headerIdx);
	if (bodyOpen < 0) return null;
	if (callParenIdx !== undefined) {
		const callClose = findMatchingParen(stripped, callParenIdx);
		if (callClose < 0 || bodyOpen > callClose) return null;
	}
	const bodyClose = findMatchingBrace(stripped, bodyOpen);
	if (bodyClose < 0) return null;
	return { bodyOpen, bodyClose };
}

/**
 * Absolute offsets (into `stripped`) of mutating-method calls, index
 * assignments, and `delete` expressions targeting `collection` within the
 * body spanning `(bodyOpen, bodyClose)`.
 */
function findMutationOffsets(
	stripped: string,
	collection: string,
	bodyOpen: number,
	bodyClose: number,
): number[] {
	const body = stripped.slice(bodyOpen + 1, bodyClose);
	const escaped = collection.replace(/[$]/g, "\\$");
	const methodAlt = MUTATING_METHODS.join("|");
	const methodRe = new RegExp(`\\b${escaped}\\s*\\.\\s*(?:${methodAlt})\\s*\\(`, "g");
	// `<name>[expr] = <not-equality>`. Negative lookahead `=(?!=)` rules
	// out `===`/`==`; we also exclude `>=`/`<=`/`!=` by anchoring the
	// preceding bracket pair with no operator on the LHS.
	const indexAssignRe = new RegExp(`\\b${escaped}\\s*\\[[^\\]\\n]*\\]\\s*=(?!=)`, "g");
	const deleteRe = new RegExp(`\\bdelete\\s+${escaped}\\s*\\[`, "g");

	let hit: RegExpExecArray | null;
	const found: number[] = [];
	while ((hit = methodRe.exec(body))) found.push(bodyOpen + 1 + hit.index);
	while ((hit = indexAssignRe.exec(body))) found.push(bodyOpen + 1 + hit.index);
	while ((hit = deleteRe.exec(body))) found.push(bodyOpen + 1 + hit.index);
	return found;
}

/**
 * Detect mutating an array/Map/Set inside iteration over the same collection.
 *
 * Positive shapes:
 *   - `for (const x of items) { items.push(x); }`
 *   - `for (const k in obj) { delete obj[k]; }`
 *   - `items.forEach((x) => { items.splice(...); })`
 *   - `set.forEach(v => { set.delete(v); })`
 *
 * Up to 10 matches per file.
 */
export function checkIteratorInvalidation(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];

	// `callParenIdx` (foreach-style only) is the index of the method call's
	// opening "(", used to bound the callback-body search — see the loop below.
	const candidates: { collection: string; headerIdx: number; callParenIdx?: number }[] = [];

	let m: RegExpExecArray | null;
	const itHeader = new RegExp(ITERATOR_HEADER_RE.source, "g");
	while ((m = itHeader.exec(stripped))) {
		candidates.push({ collection: nonNull(m[1]), headerIdx: m.index + m[0].length });
	}
	const fnHeader = new RegExp(FOREACH_HEADER_RE.source, "g");
	while ((m = fnHeader.exec(stripped))) {
		// Capture the receiver name as the iterated collection so the body scan
		// finds mutations to it. `m[0]` ends with the call's "(", so its index
		// is `headerIdx - 1`.
		candidates.push({
			collection: nonNull(m[1]),
			headerIdx: m.index + m[0].length,
			callParenIdx: m.index + m[0].length - 1,
		});
	}

	const seen = new Set<number>();
	for (const { collection, headerIdx, callParenIdx } of candidates) {
		if (matches.length >= 10) break;
		collectIteratorInvalidationMatches(
			stripped,
			lines,
			collection,
			headerIdx,
			callParenIdx,
			seen,
			matches,
		);
	}

	return matches;
}

/**
 * Resolve one iteration candidate's loop body and append any mutation
 * matches it contains to `matches` (deduping via `seen`, capped at 10
 * total). Mutates `matches`/`seen` in place — the caller loop's shared
 * accumulators.
 */
function collectIteratorInvalidationMatches(
	stripped: string,
	lines: string[],
	collection: string,
	headerIdx: number,
	callParenIdx: number | undefined,
	seen: Set<number>,
	matches: InlineMatch[],
): void {
	const range = resolveLoopBodyRange(stripped, headerIdx, callParenIdx);
	if (!range) return;

	const found = findMutationOffsets(stripped, collection, range.bodyOpen, range.bodyClose);

	for (const offset of found) {
		if (matches.length >= 10) break;
		if (seen.has(offset)) continue;
		seen.add(offset);
		const lineNo = stripped.slice(0, offset).split("\n").length;
		matches.push({
			line: lineNo,
			text: (lines[lineNo - 1] || "").trim().slice(0, REPORT_LINE_TRUNC),
		});
	}
}

// ===========================================
// Fresh Collection Key Lookup
// ===========================================

const FRESH_KEY_PATTERNS: { name: string; re: RegExp }[] = [
	{ name: "empty object literal", re: /\.\s*(?:set|get|has|delete)\s*\(\s*\{\s*\}/g },
	{ name: "empty array literal", re: /\.\s*(?:set|get|has|delete)\s*\(\s*\[\s*\]/g },
	{
		name: "fresh object literal",
		re: /\.\s*(?:set|get|has|delete)\s*\(\s*\{(?:[^{}]*\.\.\.|[^{}]*:)/g,
	},
	{ name: "fresh array literal", re: /\.\s*(?:set|get|has|delete)\s*\(\s*\[\s*\.\.\./g },
	{ name: "fresh Symbol()", re: /\.\s*(?:set|get|has|delete|add)\s*\(\s*Symbol\s*\(/g },
	{ name: "NaN as key", re: /\.\s*(?:set|get|has|delete|add)\s*\(\s*NaN\b/g },
	{
		name: "fresh `new` instance",
		re: /\.\s*(?:set|get|has|delete|add)\s*\(\s*new\s+(?:Date|Object|Array|Map|Set|WeakMap|WeakSet|RegExp|Error)\b/g,
	},
];

/**
 * Detect fresh-identity values used as Map/Set keys.
 *
 * File-wide gate: only fires when the file actually constructs a Map/Set or
 * uses Map/Set type annotations. Drops FPs from receivers that happen to
 * expose `.set`/`.get`/`.has`/`.delete` but aren't keyed collections
 * (Mongoose models, form helpers, options builders, etc.).
 *
 * Up to 10 matches per file.
 */
export function checkFreshCollectionKeyLookup(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);

	// Allow TypeScript type parameters between the class name and `(`:
	//   `new Map<Date, number>()` should still match.
	const usesKeyedCollection =
		/\bnew\s+(?:Map|Set|WeakMap|WeakSet)\s*(?:<[^<>]*>)?\s*\(/.test(stripped) ||
		/(?:^|[^\w$]):\s*(?:Map|Set|WeakMap|WeakSet|ReadonlyMap|ReadonlySet)\s*</.test(stripped);
	if (!usesKeyedCollection) return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	for (const { re } of FRESH_KEY_PATTERNS) {
		const local = new RegExp(re.source, "g");
		let hit: RegExpExecArray | null;
		while ((hit = local.exec(stripped))) {
			if (matches.length >= 10) break;
			if (seen.has(hit.index)) continue;
			seen.add(hit.index);
			const lineNo = stripped.slice(0, hit.index).split("\n").length;
			matches.push({
				line: lineNo,
				text: (lines[lineNo - 1] || "").trim().slice(0, REPORT_LINE_TRUNC),
			});
		}
		if (matches.length >= 10) break;
	}

	return matches;
}
