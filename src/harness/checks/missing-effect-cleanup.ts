// Missing effect cleanup detection (React).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch, isTestFile } from "./shared.js";
import { effectCleanupFindingsAst } from "./missing-effect-cleanup-ast.js";
import { maskCommentsAndStrings } from "./test-hygiene-masking.js";

// ===========================================
// Missing Effect Cleanup Detection (React)
// ===========================================

/**
 * Whether the text after a `return` token is a METHOD SHORTHAND's parameter list and body — `return() { … }`,
 * `return(): void { … }`, `return(value = read()) { … }` — i.e. a balanced parameter list (nesting allowed), an
 * optional return-type annotation, then `{`. A return statement's parenthesized expression is followed by `=>`,
 * `;`, `.`, an operator or a line break, never directly by `{` (review 2026-10-01).
 */
function isMethodShorthand(rest: string): boolean {
	const open = rest.search(/\S/);
	if (open < 0 || rest[open] !== "(") return false;
	let depth = 0;
	for (let i = open; i < rest.length; i++) {
		if (rest[i] === "(") depth++;
		else if (rest[i] === ")" && --depth === 0) return /^(?:\s*:\s*[^{;\n=]+?)?\s*\{/.test(rest.slice(i + 1));
	}
	return false;
}

/** Index just past the bracket group that opens at `start` (`(`…`)` or `<`…`>`), or -1 when unbalanced. */
function closingIndex(text: string, start: number, open: string, close: string): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === open) depth++;
		else if (text[i] === close && --depth === 0) return i + 1;
	}
	return -1;
}

/**
 * Whether the text after a `return` token begins an ARROW FUNCTION: an optional generic list (`<T,>`), then a
 * parenthesized parameter list — destructuring and defaults included, `({ force = false } = {})` — or a single
 * identifier, an optional return type, then `=>`. Checked BEFORE the value-shaped filter: the stripped parameter
 * list exposes `{` and the generic list exposes `<`, which otherwise read as an object literal or JSX
 * (review 2026-10-01).
 */
function isArrowFunction(rest: string): boolean {
	let at = rest.search(/\S/);
	if (at < 0) return false;
	if (rest[at] === "<") {
		at = closingIndex(rest, at, "<", ">");
		if (at < 0) return false;
		at += rest.slice(at).search(/\S/);
	}
	if (rest[at] === "(") at = closingIndex(rest, at, "(", ")");
	else at += /^[\w$]+/.exec(rest.slice(at))?.[0].length ?? -1 - at;
	return at > 0 && /^\s*(?::[^=;{]*?)?\s*=>/.test(rest.slice(at));
}

/** What a `return` must NOT start with to count as a cleanup: JSX, a string / template / number literal, an object or array literal, or a value keyword. */
const RENDER_OR_VALUE_RETURN = /^(?:[<"'`\d{[]|(?:null|undefined|true|false)\b)/;

/**
 * Whether the block returns a CLEANUP anywhere. The decision is by STATEMENT, not by line: every `return` in
 * statement position (block start, or after `;` `{` `}` `)` — `if (x) return cleanup;` and
 * `{ …; return cleanup; }` on one line both count) is classified by what its expression STARTS with, after
 * leading parens, so `return cleanup`, `return (cleanup)`, `return store.subscribe(\n listener\n)`,
 * `return (): void => …` and `return (\n () => …\n)` all count whatever the line breaks. A `return` of JSX, a
 * literal or a value keyword is a component render or a plain value, never a cleanup; a bare `return;` is none.
 * Comments are masked first (`// TODO return later` is prose). The 2026-09-30 survivor fix had removed the
 * broad per-line `return` check; this keeps every valid cleanup form it took with it.
 */
function blockReturnsCleanup(maskedBlockLines: readonly string[]): boolean {
	// The lines arrive MASKED (comments, strings, templates and JSX text blanked by the lexical masker, offsets
	// kept): a `//` inside a URL string is not a comment, and a returned string literal is blank, hence no cleanup.
	const code = maskedBlockLines.join("\n");
	// Statement position: a line start (automatic semicolon insertion ends the statement before), `;` `{` `}` `)`,
	// or `else`. The prefix is a LOOKBEHIND, so one `;` ends `if (!cleanup) return;` and opens `return cleanup;`.
	// A switch label (`case "active":` / `default:`) is a statement position too, so its `:` is admitted.
	for (const match of code.matchAll(/(?<=^|[\n;{}):]|\belse)\s*return\b/g)) {
		const rest = code.slice(match.index + match[0].length);
		// ASI: a line break, a `;` or a closing `}` right after `return` ends the statement — `if (!enabled) return`
		// never returns the declaration on the next line and `{ return }` returns nothing. An expression that
		// OPENS on the return's line may continue over lines.
		if (/^[ \t]*(?:\n|;|\}|$)/.test(rest)) continue;
		// An object MEMBER named `return` — the key `return: () => …` or the method shorthand `return() { … }` —
		// is not a return statement (review 2026-10-01). A statement's parenthesized expression continues with
		// `=>`, `;`, `.` or a line break, never with `{`.
		if (/^[ \t]*:/.test(rest) || isMethodShorthand(rest)) continue;
		if (isArrowFunction(rest)) return true;
		const expression = rest.replace(/^[\s(]+/, "");
		if (expression !== "" && !RENDER_OR_VALUE_RETURN.test(expression)) return true;
	}
	return false;
}

/**
 * Scan one useEffect block (lines[start..end)) for a subscription call
 * with no cleanup return. Returns the flagged match, or null if the
 * block is clean.
 */
function findEffectCleanupMatch(
	sourceLines: string[],
	lines: string[],
	start: number,
	end: number,
	subscriptionPattern: RegExp,
): InlineMatch | null {
	// `sourceLines` are the file's lines (only the reported text); `lines` are the MASKED lines — comments,
	// strings, templates and JSX text blanked, offsets kept — that BOTH decisions read: a commented-out
	// `setInterval` is no subscription, just as a commented-out `return` is no cleanup (review 2026-10-01).
	let hasSubscription = false;

	for (let i = start; i < end; i++) {
		if (subscriptionPattern.test(nonNull(lines[i]).trim())) hasSubscription = true;
	}

	if (!hasSubscription || blockReturnsCleanup(lines.slice(start, end))) return null;

	return {
		line: start + 1,
		text: `[useEffect with subscription but no cleanup — potential memory leak] ${nonNull(sourceLines[start]).trim().slice(0, 100)}`,
	};
}

/**
 * Detect useEffect hooks that set up subscriptions (addEventListener,
 * setInterval, setTimeout, subscribe, .on() ) but lack a cleanup return.
 *
 * Heuristic: scan line-by-line from each `useEffect(` to the next
 * `useEffect(` or end of file. If we see a subscription call but no
 * cleanup return (arrow function, function, or identifier), flag it.
 *
 * Only fires on .tsx/.jsx files. Skips test files.
 */
export function checkMissingEffectCleanup(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	// The parser decides when it is installed: the effect callback's own return statements, their parsed values.
	const parsed = effectCleanupFindingsAst(content, filePath);
	if (parsed !== null) return parsed;

	const lines = content.split("\n");
	// Same line count and offsets as `lines`; only the cleanup decision reads it.
	const maskedLines = maskCommentsAndStrings(content, filePath).split("\n");
	const matches: InlineMatch[] = [];

	const subscriptionPattern =
		/\b(addEventListener|setInterval|setTimeout|subscribe)\s*\(|\.on\s*\(/;

	// Find all useEffect start lines
	const effectStarts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (/\buseEffect\s*\(/.test(nonNull(lines[i]).trim())) {
			effectStarts.push(i);
		}
	}

	for (let e = 0; e < effectStarts.length; e++) {
		const start = nonNull(effectStarts[e]);
		const end = e + 1 < effectStarts.length ? nonNull(effectStarts[e + 1]) : lines.length;

		const match = findEffectCleanupMatch(lines, maskedLines, start, end, subscriptionPattern);
		// (source lines first, masked lines second — the masked copy only decides the cleanup return)
		if (match) {
			matches.push(match);
		}
	}

	return matches;
}
