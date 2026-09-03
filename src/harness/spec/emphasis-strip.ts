// CommonMark-ish inline delimiter handling for the spec-facts substrate.
//
// stripEmphasis removes emphasis/code markers before id scanning so
// "**FG-INV-01** through **FG-INV-20**" still parses — but ONLY paired
// delimiter runs are removed (round-7 #5): CommonMark treats unpaired markers
// as literal text, and unconditionally deleting `*`/backticks fabricated ids
// ("- A*1" -> "A1"; "A*1 through A*9" -> a range). The pairing rule here is
// deliberately STRICTER than CommonMark flanking: a run opens only at a word
// edge (not preceded by a letter/digit/mark) and closes only at a word edge
// (not followed by one), so intraword delimiters never pair and are never
// deleted. Refusing to strip is the safe direction — the id/range regexes do
// not treat `*` or backticks as word characters, so an unstripped marker can
// only PREVENT a token from matching, never mint a new one.
//
// The code-point helpers are shared with extract-ids.ts' Unicode word-glue
// post-filter (round-7 #2) and mirror extract-refs.ts BOUNDARY_WORD_RE
// (round-6 #19): combining marks count as word-glue, and boundary predicates
// read whole code points, never lone surrogates.

/** A letter, digit, or COMBINING MARK in ANY Unicode plane — the word-glue
 *  class (mirrors extract-refs.ts BOUNDARY_WORD_RE). */
const UNICODE_WORD_RE = /[\p{L}\p{N}\p{M}]/u;

const WS_RE = /\s/u;

/** The whole code point (astral-safe) whose UTF-16 encoding STARTS at `pos`,
 *  or "" past end-of-string — `s[pos]` alone would yield just the high
 *  surrogate of an astral char. Shared with extract-refs.ts' own boundary
 *  predicates (round-6 #19 / round-5 #17) — one astral-safe implementation. */
export function codePointStartingAt(s: string, pos: number): string {
	const cp = s.codePointAt(pos);
	return cp === undefined ? "" : String.fromCodePoint(cp);
}

/** The whole code point (astral-safe) whose UTF-16 encoding ENDS just before
 *  `pos`, or "" at start-of-string. Back-step to pos-2 ONLY for a real
 *  surrogate PAIR — an unpaired low surrogate is read alone, not fused with
 *  the char before it. Shared with extract-refs.ts (same rationale as above). */
export function codePointEndingBefore(s: string, pos: number): string {
	if (pos <= 0) return "";
	const unit = s.charCodeAt(pos - 1);
	const prev = pos >= 2 ? s.charCodeAt(pos - 2) : 0;
	const isPair =
		unit >= 0xdc00 && unit <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff;
	return codePointStartingAt(s, isPair ? pos - 2 : pos - 1);
}

/** True when the span [start,end) is glued to a Unicode letter/digit/mark on
 *  either side. The id regexes' ASCII lookarounds cannot see "éREQ-1" /
 *  "REQ-1é" / combining-mark / astral-letter glue (round-7 #2). */
export function hasUnicodeWordGlue(
	line: string,
	start: number,
	end: number,
): boolean {
	return (
		UNICODE_WORD_RE.test(codePointEndingBefore(line, start)) ||
		UNICODE_WORD_RE.test(codePointStartingAt(line, end))
	);
}

/** One maximal run of a single delimiter character. */
interface DelimRun {
	start: number;
	len: number;
}

/** Maximal runs of `ch` in `line`, left to right (linear scan). */
function delimiterRuns(line: string, ch: string): DelimRun[] {
	const runs: DelimRun[] = [];
	let i = 0;
	while (i < line.length) {
		if (line.charAt(i) !== ch) {
			i++;
			continue;
		}
		const start = i;
		while (i < line.length && line.charAt(i) === ch) i++;
		runs.push({ start, len: i - start });
	}
	return runs;
}

/** Word-edge opener: not preceded by a letter/digit/mark, not followed by
 *  whitespace or end-of-line. Intraword runs ("A*1") can never open. */
function runCanOpen(line: string, r: DelimRun): boolean {
	const next = codePointStartingAt(line, r.start + r.len);
	if (next === "" || WS_RE.test(next)) return false;
	return !UNICODE_WORD_RE.test(codePointEndingBefore(line, r.start));
}

/** Word-edge closer: not followed by a letter/digit/mark, not preceded by
 *  whitespace or start-of-line. Intraword runs ("A*1") can never close. */
function runCanClose(line: string, r: DelimRun): boolean {
	const prev = codePointEndingBefore(line, r.start);
	if (prev === "" || WS_RE.test(prev)) return false;
	return !UNICODE_WORD_RE.test(codePointStartingAt(line, r.start + r.len));
}

/** Delete the given runs (sorted by start, non-overlapping) from `line`. */
function deleteRuns(line: string, doomed: DelimRun[]): string {
	if (doomed.length === 0) return line;
	let out = "";
	let pos = 0;
	for (const r of doomed) {
		out += line.slice(pos, r.start);
		pos = r.start + r.len;
	}
	return out + line.slice(pos);
}

/** A forward-only, per-length cursor over the run indices that CAN close.
 *  `next(len, i)` returns the first close-eligible run of `len` strictly after
 *  index `i`, or -1. Each length's cursor only advances, so the whole pairing
 *  pass is O(runs) — not the O(runs²) the old "rescan every opener" did, which
 *  went quadratic when every run opened but none closed (round-7 #1: the
 *  "unmatched openers have distinct lengths" claim was false). */
function makeCloserCursor(line: string, runs: DelimRun[]): (len: number, i: number) => number {
	const closers = new Map<number, number[]>();
	for (let k = 0; k < runs.length; k++) {
		const r = runs[k];
		if (r !== undefined && runCanClose(line, r)) {
			const list = closers.get(r.len);
			if (list) list.push(k);
			else closers.set(r.len, [k]);
		}
	}
	const cursor = new Map<number, number>();
	return (len, i) => {
		const list = closers.get(len);
		if (!list) return -1;
		let c = cursor.get(len) ?? 0;
		while (c < list.length && (list[c] ?? 0) <= i) c++;
		cursor.set(len, c);
		return c < list.length ? (list[c] ?? -1) : -1;
	};
}

/** Strip PAIRED backtick runs (CommonMark code spans: an opener pairs with the
 *  NEXT equal-length run; runs between them are code content and stay
 *  literal). Lone runs stay literal — "A`1" keeps its backtick, so deletion
 *  cannot fabricate "A1" (round-7 #5). Linear via the forward closer cursor. */
function stripPairedBackticks(line: string): string {
	if (!line.includes("`")) return line;
	const runs = delimiterRuns(line, "`");
	if (runs.length < 2) return line;
	const nextCloser = makeCloserCursor(line, runs);
	const doomed: DelimRun[] = [];
	let i = 0;
	while (i < runs.length) {
		const open = runs[i];
		const j = open !== undefined && runCanOpen(line, open) ? nextCloser(open.len, i) : -1;
		const close = j >= 0 ? runs[j] : undefined;
		if (open !== undefined && close !== undefined) {
			doomed.push(open, close);
			i = j + 1; // runs between opener and closer are code content
		} else {
			i++;
		}
	}
	return deleteRuns(line, doomed);
}

/** True when the char at `pos` is backslash-escaped (an ODD run of `\` precedes
 *  it) — an escaped delimiter ("\*", "\_") is literal text, not an emphasis
 *  marker (round-7 #4). */
function isBackslashEscaped(line: string, pos: number): boolean {
	let n = 0;
	for (let k = pos - 1; k >= 0 && line.charAt(k) === "\\"; k--) n++;
	return n % 2 === 1;
}

/** Strip PAIRED emphasis runs of `ch` ("*" or "_"): stack-matched, word-edge
 *  flanking, equal open/close run length. "**x** … *y*" strips; an intraword
 *  "A*1"/"B_1", a LONE "_A1 through A9", and a backslash-escaped "\_"/"\*" all
 *  pair nothing and stay literal (round-7 #5/#4) — so deletion can never expose
 *  a fabricated id or range. */
function stripPairedEmphasis(line: string, ch: string): string {
	if (!line.includes(ch)) return line;
	const runs = delimiterRuns(line, ch);
	const doomed: DelimRun[] = [];
	const stack: DelimRun[] = [];
	for (const r of runs) {
		if (isBackslashEscaped(line, r.start)) continue;
		const top = stack[stack.length - 1];
		if (top !== undefined && top.len === r.len && runCanClose(line, r)) {
			stack.pop();
			doomed.push(top, r);
		} else if (runCanOpen(line, r)) {
			stack.push(r);
		}
	}
	doomed.sort((a, b) => a.start - b.start);
	return deleteRuns(line, doomed);
}

/** Emphasis characters stripped before id/range scanning so "**FG-INV-01**
 *  through **FG-INV-20**" still parses. Only PAIRED `*` / `_` / backtick runs
 *  are removed (round-7 #5/#4) — lone, escaped, and INTRAWORD markers ("B_1")
 *  are literal per CommonMark and MUST survive, or the underscore id/range
 *  guards are nullified (a lone "_A1 through A9" must keep its underscore so the
 *  range endpoint stays glued and is rejected). */
export function stripEmphasis(line: string): string {
	return stripPairedEmphasis(stripPairedEmphasis(stripPairedBackticks(line), "*"), "_");
}
