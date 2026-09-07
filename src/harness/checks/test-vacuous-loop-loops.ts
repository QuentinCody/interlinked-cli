// Loop-span extraction for `test-vacuous-loop.ts`'s `vacuous_loop_assertion`
// check. Carved out of the main module to stay under the per-file line cap
// (`docs/../CLAUDE.md` "Per-file line cap"). See that module's header for
// the check's full CLASS / FIRES WHEN / DOES NOT FIRE / CALIBRATION
// contract — this file is pure loop-shape recognition, with no opinion on
// what counts as "proven non-empty" (that lives in test-vacuous-loop-pins.ts).
//
// Recognizes four loop shapes over a MASKED (stripAllLiterals) block body:
// `for...of` / `for...in`, a C-style index `for` bound by `.length`, and
// `.forEach`/`.map`/`.every` with a block-bodied callback. Each match
// produces a `RawLoopSpan`: the loop BODY's character-offset span into the
// block text, plus the raw collection expression text. No real parser —
// shape-based, deliberately narrow (see the main module's KNOWN GAPS).

import { nonNull } from "../../lib/non-null.js";

/** One loop construct found in a block's masked body text. */
export interface RawLoopSpan {
	/** Offset (into the block body string) of the loop body's first char. */
	start: number;
	/** Offset just past the loop body's last char (exclusive). */
	end: number;
	/** Raw (untrimmed-whitespace-collapsed) collection expression text. */
	targetRaw: string;
}

/** Index of the character matching the `(` at `openIdx`, or null if the
 *  parens never balance within `text`. */
function scanMatchingParen(text: string, openIdx: number): number | null {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		const c = text[i];
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return null;
}

/** Index of the character matching the `{` at `openIdx`, or null if the
 *  braces never balance within `text`. */
function scanMatchingBrace(text: string, openIdx: number): number | null {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		const c = text[i];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return null;
}

/** End offset of the single (brace-less) statement starting at `from` —
 *  the first top-level `;` or newline, whichever comes first. */
function statementEnd(text: string, from: number): number {
	const semi = text.indexOf(";", from);
	const nl = text.indexOf("\n", from);
	if (semi === -1 && nl === -1) return text.length;
	if (semi === -1) return nl;
	if (nl === -1) return semi + 1;
	return Math.min(semi + 1, nl);
}

/** The loop body span starting just after a loop header's closing paren:
 *  a brace-bodied loop resolves via balanced braces; a single-statement
 *  loop (no `{`) falls back to the next statement boundary. */
function loopBodySpanAfter(body: string, closeParenIdx: number): { start: number; end: number } | null {
	let i = closeParenIdx + 1;
	while (i < body.length && /\s/.test(body[i] ?? "")) i++;
	if (body[i] === "{") {
		const closeBrace = scanMatchingBrace(body, i);
		return closeBrace === null ? null : { start: i + 1, end: closeBrace };
	}
	return { start: i, end: statementEnd(body, i) };
}

// `for (const x of C)` / `for (const [k, v] of C)` / `for (const k in C)`.
const FOR_OF_IN_RE =
	/\bfor\s*\(\s*(?:const|let|var)\s+(?:\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)\s+(?:of|in)\s+/g;

/** Collect `for...of` / `for...in` loop spans from a masked block body. */
function collectForOfInLoops(body: string, spans: RawLoopSpan[]): void {
	FOR_OF_IN_RE.lastIndex = 0;
	let m: RegExpExecArray | null = FOR_OF_IN_RE.exec(body);
	while (m !== null) {
		const forOpenIdx = body.indexOf("(", m.index);
		const closeParenIdx = forOpenIdx === -1 ? null : scanMatchingParen(body, forOpenIdx);
		if (closeParenIdx !== null) {
			const targetRaw = body.slice(m.index + m[0].length, closeParenIdx).trim();
			const bodySpan = loopBodySpanAfter(body, closeParenIdx);
			if (bodySpan && targetRaw !== "") spans.push({ ...bodySpan, targetRaw });
		}
		FOR_OF_IN_RE.lastIndex = m.index + m[0].length;
		m = FOR_OF_IN_RE.exec(body);
	}
}

// `for (let i = 0; i < C.length; i++)` — captures the loop var name (group 1,
// back-referenced) and the `.length`-bound collection (group 2).
const FOR_LENGTH_RE =
	/\bfor\s*\(\s*(?:let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*0\s*;\s*\1\s*<\s*([A-Za-z_$][\w$]*(?:\([^()]*\))?(?:\.[A-Za-z_$][\w$]*(?:\([^()]*\))?)*)\.length\s*;/g;

/** Collect C-style index-bound `for` loop spans from a masked block body. */
function collectForLengthLoops(body: string, spans: RawLoopSpan[]): void {
	FOR_LENGTH_RE.lastIndex = 0;
	let m: RegExpExecArray | null = FOR_LENGTH_RE.exec(body);
	while (m !== null) {
		const forOpenIdx = body.indexOf("(", m.index);
		const closeParenIdx = forOpenIdx === -1 ? null : scanMatchingParen(body, forOpenIdx);
		if (closeParenIdx !== null) {
			const targetRaw = m[2] ?? "";
			const bodySpan = loopBodySpanAfter(body, closeParenIdx);
			if (bodySpan && targetRaw !== "") spans.push({ ...bodySpan, targetRaw });
		}
		FOR_LENGTH_RE.lastIndex = m.index + m[0].length;
		m = FOR_LENGTH_RE.exec(body);
	}
}

// `C.forEach(cb)` / `C.map(cb)` / `C.every(cb)`, arrow or `function` callback,
// block-bodied (`=> {`). `C` (group 1) allows one dotted/call-suffixed chain.
const METHOD_LOOP_RE =
	/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*\([^()]*\))?)\s*\.\s*(?:forEach|map|every)\s*\(\s*(?:async\s*)?(?:\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>|function\s*[A-Za-z_$]*\s*\([^()]*\))\s*\{/g;

/** Collect `.forEach`/`.map`/`.every` callback-loop spans from a masked
 *  block body. */
function collectMethodLoops(body: string, spans: RawLoopSpan[]): void {
	METHOD_LOOP_RE.lastIndex = 0;
	let m: RegExpExecArray | null = METHOD_LOOP_RE.exec(body);
	while (m !== null) {
		const braceIdx = m.index + m[0].length - 1;
		const closeBrace = scanMatchingBrace(body, braceIdx);
		const targetRaw = (m[1] ?? "").trim();
		if (closeBrace !== null && targetRaw !== "") {
			spans.push({ start: braceIdx + 1, end: closeBrace, targetRaw });
		}
		METHOD_LOOP_RE.lastIndex = m.index + m[0].length;
		m = METHOD_LOOP_RE.exec(body);
	}
}

/** Every recognized loop construct in a masked block body. */
export function findLoopSpans(body: string): RawLoopSpan[] {
	const spans: RawLoopSpan[] = [];
	collectForOfInLoops(body, spans);
	collectForLengthLoops(body, spans);
	collectMethodLoops(body, spans);
	return spans;
}

/** Index into `spans` of the INNERMOST (smallest) span containing `offset`,
 *  or -1 when no span contains it. */
export function innermostLoopIndex(offset: number, spans: RawLoopSpan[]): number {
	let best = -1;
	for (let i = 0; i < spans.length; i++) {
		const s = spans[i];
		if (!s || offset < s.start || offset > s.end) continue;
		if (best === -1 || s.end - s.start < nonNull(spans[best]).end - nonNull(spans[best]).start) best = i;
	}
	return best;
}
