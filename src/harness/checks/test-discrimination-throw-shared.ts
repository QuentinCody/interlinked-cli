// Shared string-scanning primitives for the duplicate-throw-message-assertion
// check, split out so both the assertion-side parser (test-discrimination-throw.ts)
// and the call-scoping resolver (test-discrimination-throw-scope.ts) can use
// them without importing from each other (avoids a circular import between
// the two).

import { stripComments } from "./shared.js";

/** A throw site's message, reduced to the literal (or template-prefix) text. */
export interface ThrowSite {
	message: string;
}

/** Unescape the common `\x` sequences inside a literal's interior text. */
function unescapeLiteralInterior(inner: string): string {
	return inner.replace(/\\(.)/g, "$1");
}

/**
 * Parse a leading quoted/template literal at the start of `text` (which may
 * have trailing content after it — callers decide whether that matters).
 * Returns the literal's prefix text (template content before the first
 * `${`, or the whole interior for `"`/`'`) plus how many characters were
 * consumed, or null if `text` doesn't open with a quote/backtick, or the
 * literal is unterminated.
 */
export function parseLeadingLiteral(text: string): { prefix: string; end: number } | null {
	const quote = text[0];
	if (quote !== '"' && quote !== "'" && quote !== "`") return null;
	let i = 1;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === quote) break;
		i++;
	}
	if (text[i] !== quote) return null; // unterminated
	const inner = text.slice(1, i);
	if (quote === "`") {
		const idx = inner.indexOf("${");
		const raw = idx === -1 ? inner : inner.slice(0, idx);
		return { prefix: unescapeLiteralInterior(raw), end: i + 1 };
	}
	return { prefix: unescapeLiteralInterior(inner), end: i + 1 };
}

interface ParenScanState {
	depth: number;
	inStr: string | null;
}

/** Advance the paren/string scanner by one step from index `i`, mutating
 *  `state`. Returns the index to resume from (2 past `i` when consuming a
 *  backslash-escape inside a string, else 1 past `i`). */
function stepParenScan(text: string, i: number, state: ParenScanState): number {
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

/** Extract the balanced-paren argument text following `(` at `openIdx`, string-aware. */
export function extractBalancedArgs(text: string, openIdx: number): string | null {
	const state: ParenScanState = { depth: 0, inStr: null };
	let i = openIdx;
	while (i < text.length) {
		const wasOpen = state.depth > 0;
		const next = stepParenScan(text, i, state);
		if (wasOpen && state.depth === 0 && !state.inStr) return text.slice(openIdx + 1, i);
		i = next;
	}
	return null;
}

const THROW_SITE_RE = /\bthrow\s+new\s+[\w$.]+\s*\(/g;

/** Collect every exact-literal throw message in `sutContent` (comments masked). */
export function collectThrowSites(sutContent: string): ThrowSite[] {
	const stripped = stripComments(sutContent);
	const sites: ThrowSite[] = [];
	let m: RegExpExecArray | null = THROW_SITE_RE.exec(stripped);
	while (m !== null) {
		const openIdx = m.index + m[0].length - 1;
		const args = extractBalancedArgs(stripped, openIdx);
		if (args !== null) {
			const literal = parseLeadingLiteral(args.trimStart());
			if (literal !== null && literal.prefix.trim() !== "") {
				sites.push({ message: literal.prefix });
			}
		}
		m = THROW_SITE_RE.exec(stripped);
	}
	return sites;
}
