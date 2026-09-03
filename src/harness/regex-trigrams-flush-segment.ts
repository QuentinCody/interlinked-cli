// ===========================================
// Regex Literal Extraction
// ===========================================
// Walks a regex pattern character-by-character and extracts the literal
// substrings that must appear in any matching text. Split out of
// regex-trigrams.ts (line-cap ratchet): this cluster is the low-level scan —
// per-construct handlers (escape, quantifier, repeat, group) plus the
// character tables and helpers they use.

import { nonNull } from "../lib/non-null.js";

/**
 * Cursor state threaded through the per-construct handlers below: the literal
 * run accumulated so far (`current`) and the next index to read (`i`).
 * Handlers mutate `segments` in place and return the advanced state.
 */
interface ScanState {
	current: string;
	i: number;
}

/**
 * Handle a `\`-escape at `i`. A literal escape (`\.`, `\n`, …) extends the
 * current run; a non-literal escape (`\d`, `\w`, …) flushes it. A trailing lone
 * `\` is kept as a literal backslash. Advances past the escape.
 */
function handleEscape(pattern: string, i: number, current: string, segments: string[]): ScanState {
	const len = pattern.length;
	if (i + 1 >= len) {
		return { current: current + "\\", i: i + 1 };
	}
	const literal = resolveEscape(nonNull(pattern[i + 1]));
	if (literal !== null) {
		return { current: current + literal, i: i + 2 };
	}
	// Non-literal escape (\d, \w, \s, \b, etc.) — flush.
	flushSegment(current, segments);
	return { current: "", i: i + 2 };
}

/**
 * Handle a `*` / `+` / `?` quantifier at `i`: the preceding character is now
 * variable, so drop it and flush the run before it. Skips a trailing lazy /
 * possessive modifier (`*?`, `+?`, `??`, `*+`).
 */
function handleQuantifier(pattern: string, i: number, current: string, segments: string[]): ScanState {
	if (current.length > 0) {
		flushSegment(current.slice(0, -1), segments);
	}
	let next = i + 1;
	if (next < pattern.length && (pattern[next] === "?" || pattern[next] === "+")) next++;
	return { current: "", i: next };
}

/**
 * Handle a `{…}` repetition at `i`: the preceding element is variable, so drop
 * it and flush the run before it. Skips to past `}` and any trailing lazy `?`.
 */
function handleRepeat(pattern: string, i: number, current: string, segments: string[]): ScanState {
	const len = pattern.length;
	if (current.length > 0) {
		flushSegment(current.slice(0, -1), segments);
	}
	let next = i;
	while (next < len && pattern[next] !== "}") next++;
	if (next < len) next++; // skip '}'
	if (next < len && pattern[next] === "?") next++; // lazy modifier
	return { current: "", i: next };
}

/**
 * Handle a `(` group at `i`. An alternation group is skipped wholesale (the
 * trigram-level intersection for top-level alternation is done by
 * decomposePattern). A non-alternation group either contributes its inner
 * literal segments (capturing / `?:`) or is skipped (lookaround / unknown
 * modifier). Returns the index just past the group.
 */
function handleGroup(pattern: string, i: number, segments: string[]): number {
	const groupEnd = findGroupEnd(pattern, i);
	const groupContent = pattern.slice(i + 1, groupEnd);

	if (groupContent.includes("|")) {
		// Alternation inside a group — cannot extract required literals here.
		return groupEnd + 1;
	}

	const parsed = classifyGroupPrefix(groupContent);
	if (parsed.kind === "skip") {
		return groupEnd + 1;
	}
	segments.push(...extractLiteralSegments(parsed.inner));
	return groupEnd + 1;
}

/**
 * Walk a regex pattern and extract literal segments that must appear
 * in any match. Returns an array of literal strings.
 */
export function extractLiteralSegments(pattern: string): string[] {
	const segments: string[] = [];
	let current = "";
	let i = 0;
	const len = pattern.length;

	while (i < len) {
		const ch = pattern[i];

		switch (ch) {
			// Escape sequences — next char is literal (mostly)
			case "\\": {
				const st = handleEscape(pattern, i, current, segments);
				current = st.current;
				i = st.i;
				break;
			}

			// Wildcards — flush current literal
			case ".":
				flushSegment(current, segments);
				current = "";
				i++;
				break;

			// Character classes — not a fixed literal, flush
			case "[":
				flushSegment(current, segments);
				current = "";
				i = skipCharClass(pattern, i); // skip to past closing bracket
				break;

			// Quantifiers — the preceding char/group is variable
			case "*":
			case "+":
			case "?": {
				const st = handleQuantifier(pattern, i, current, segments);
				current = st.current;
				i = st.i;
				break;
			}

			// Repetition — preceding element is variable
			case "{": {
				const st = handleRepeat(pattern, i, current, segments);
				current = st.current;
				i = st.i;
				break;
			}

			// Groups — recurse into capturing / non-capturing bodies; skip
			// alternation groups and lookarounds (see handleGroup).
			case "(":
				flushSegment(current, segments);
				current = "";
				i = handleGroup(pattern, i, segments);
				break;

			// Alternation at top level — handled by decomposePattern, just stop here
			case "|":
				flushSegment(current, segments);
				current = "";
				i = len; // stop parsing (decomposePattern handles branch intersection)
				break;

			// Anchors — don't consume characters, ignore
			case "^":
			case "$":
				i++;
				break;

			// Regular literal character
			default:
				current += ch;
				i++;
				break;
		}
	}

	flushSegment(current, segments);
	return segments;
}

/**
 * Escaped special regex characters whose literal value is the character itself
 * (`\.` → `.`, `\\` → `\`, etc.). Membership-only; the value is `ch`.
 */
const SELF_LITERAL_ESCAPES = new Set([
	".",
	"*",
	"+",
	"?",
	"[",
	"]",
	"(",
	")",
	"{",
	"}",
	"|",
	"^",
	"$",
	"\\",
	"/",
	"-",
]);

/** Named escape sequences that map to a concrete control character. */
const NAMED_LITERAL_ESCAPES = new Map<string, string>([
	["n", "\n"],
	["t", "\t"],
	["r", "\r"],
	["f", "\f"],
	["v", "\v"],
	["0", "\0"],
]);

/**
 * Non-literal escapes (character classes / assertions: `\d`, `\w`, `\s`, `\b`,
 * `\A`, `\Z`, `\z`, and their uppercase negations). These do not contribute a
 * fixed literal, so `resolveEscape` returns null for them.
 */
const NON_LITERAL_ESCAPES = new Set(["d", "D", "w", "W", "s", "S", "b", "B", "A", "Z", "z"]);

/**
 * Resolve a regex escape character to its literal value.
 * Returns null for non-literal escapes (\d, \w, \s, \b, etc.).
 */
function resolveEscape(ch: string): string | null {
	if (SELF_LITERAL_ESCAPES.has(ch)) return ch;
	const named = NAMED_LITERAL_ESCAPES.get(ch);
	if (named !== undefined) return named;
	if (NON_LITERAL_ESCAPES.has(ch)) return null;
	// Unknown escape — treat as literal (rg/pcre behavior)
	return ch;
}

/** Skip past a character class [...], handling nested escapes */
function skipCharClass(pattern: string, start: number): number {
	let i = start + 1; // skip opening '['
	if (i < pattern.length && pattern[i] === "^") i++; // negated class
	if (i < pattern.length && pattern[i] === "]") i++; // literal ] at start

	while (i < pattern.length) {
		if (pattern[i] === "\\") {
			i += 2; // skip escape
		} else if (pattern[i] === "]") {
			return i + 1; // past closing ']'
		} else {
			i++;
		}
	}
	return i; // unterminated class, consume everything
}

/**
 * Classify the prefix of a regex group body:
 *   - `?:` → non-capturing, return the body stripped of `?:`
 *   - `?=`, `?!`, `?<=`, `?<!` → lookaround; contents don't consume input, skip
 *   - any other `?...` → unknown modifier, skip to be safe
 *   - otherwise → normal capturing group, return the body unchanged
 */
function classifyGroupPrefix(body: string): { kind: "inner"; inner: string } | { kind: "skip" } {
	if (body.startsWith("?:")) return { kind: "inner", inner: body.slice(2) };
	if (body.startsWith("?")) return { kind: "skip" };
	return { kind: "inner", inner: body };
}

/** Find the matching closing parenthesis for a group */
function findGroupEnd(pattern: string, start: number): number {
	let depth = 1;
	let i = start + 1;
	while (i < pattern.length && depth > 0) {
		if (pattern[i] === "\\") {
			i += 2;
			continue;
		}
		if (pattern[i] === "(") depth++;
		else if (pattern[i] === ")") depth--;
		if (depth > 0) i++;
	}
	return i;
}

/** Flush a literal segment if it's long enough to contain trigrams */
function flushSegment(segment: string, segments: string[]): void {
	if (segment.length >= 3) {
		segments.push(segment);
	}
}
