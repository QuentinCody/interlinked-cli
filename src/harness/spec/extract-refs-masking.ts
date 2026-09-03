// Inline/line masking for the ref/link extractors (spec-facts substrate) —
// split out of extract-refs.ts for the per-file line cap.
//
// Two families, deliberately different layers (round-5 #18/#20; shaped by the
// adversarial-verify failure of the naive design):
//  • CHAR-level masks (column-preserving spaces, per line): code spans and
//    fully-contained `<!-- … -->` comments. Consumed ONLY by the section-ref
//    and anchor-link scanners — never by block-structure decisions. Masking a
//    trailing comment to spaces BEFORE underline detection turns
//    "Para\n--- <!-- c -->" into a phantom Setext heading and silently drops
//    live refs; keeping block decisions on RAW lines makes that impossible.
//  • LINE-level hidden set: whole-line HTML comment BLOCKS (the CommonMark
//    HTML block type 2 shape — a line starting `<!--` through the line
//    containing `-->`). Hidden rendered content: headings, refs, and links
//    inside must not exist. Comments OPENING mid-line and closing on a LATER
//    line are a residual (needs inline-aware block parsing); their open line
//    stays live, matching the pre-masking behavior.

/** Maximal backtick runs on one line as [start, length] pairs. */
export function backtickRuns(line: string): Array<[number, number]> {
	const runs: Array<[number, number]> = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] === "`") {
			let j = i + 1;
			while (j < line.length && line[j] === "`") j++;
			runs.push([i, j - i]);
			i = j;
		} else {
			i++;
		}
	}
	return runs;
}

/** Run indices grouped by run length, in line order. */
function runIndexByLength(runs: Array<[number, number]>): Map<number, number[]> {
	const byLen = new Map<number, number[]>();
	for (let idx = 0; idx < runs.length; idx++) {
		const len = runs[idx]?.[1] ?? 0;
		const list = byLen.get(len);
		if (list) list.push(idx);
		else byLen.set(len, [idx]);
	}
	return byLen;
}

/** Mask code spans with spaces per CommonMark pairing: an opener run closes at
 *  the NEXT run of EXACTLY equal length; unequal runs in between are span
 *  content; an opener with no equal closer is literal text (round-5 #18 —
 *  "`§9``" contains NO code span, so its §9 stays live; the old regex paired
 *  unequal runs). Column-preserving. Linear: runs are collected once, closers
 *  found via per-length forward cursors (each cursor only advances), and
 *  masking is interval-collect plus one char pass — no per-span splicing.
 *  Multiline code spans remain a residual (per-line scanner). */
export function maskCodeSpans(line: string): string {
	const spans = codeSpanIntervals(line);
	if (spans.length === 0) return line;
	const chars = line.split("");
	for (const [s, e] of spans) {
		for (let k = s; k < e; k++) chars[k] = " ";
	}
	return chars.join("");
}

/** Code-span intervals as `[spanStart, spanEnd, contentStart, contentEnd]` via
 *  the same CommonMark equal-run pairing maskCodeSpans masks by. githubSlug
 *  swaps each span's CONTENT for a placeholder so markdown/HTML inside a code
 *  span renders as literal text, not parsed (round-7 #14: "`<em>`" slugs "em",
 *  not ""). Single source of the pairing so the two consumers cannot drift. */
export function codeSpanIntervals(
	line: string,
): Array<[number, number, number, number]> {
	if (!line.includes("`")) return [];
	const runs = backtickRuns(line);
	if (runs.length < 2) return [];
	const byLen = runIndexByLength(runs);
	const cursors = new Map<number, number>();
	const out: Array<[number, number, number, number]> = [];
	let r = 0;
	while (r < runs.length) {
		const [start, len] = runs[r] ?? [0, 0];
		const list = byLen.get(len) ?? [];
		let c = cursors.get(len) ?? 0;
		while (c < list.length && (list[c] ?? 0) <= r) c++;
		cursors.set(len, c);
		const closer = list[c];
		if (closer === undefined) {
			r++; // no equal-length closer anywhere ahead — opener is literal
			continue;
		}
		const [cStart, cLen] = runs[closer] ?? [0, 0];
		out.push([start, cStart + cLen, start + len, cStart]);
		r = closer + 1;
	}
	return out;
}

/** Mask fully-contained `<!-- … -->` comments with spaces (column-preserving).
 *  An inline comment renders as nothing, so a literal example inside one must
 *  not produce refs/links (round-5 #20). Per-line form only — a comment whose
 *  `-->` sits on a later line is left untouched here (block-level handling and
 *  residuals live with htmlCommentBlockLines). */
export function maskInlineComments(line: string): string {
	if (!line.includes("<!--")) return line;
	let out = "";
	let i = 0;
	while (i < line.length) {
		const open = line.indexOf("<!--", i);
		if (open < 0) break;
		const close = line.indexOf("-->", open + 4);
		if (close < 0) break;
		out += line.slice(i, open) + " ".repeat(close + 3 - open);
		i = close + 3;
	}
	return out + line.slice(i);
}

/** The standard per-line mask for ref/link scanning: ONE left-to-right scan
 *  over code spans and `<!-- … -->` comments with CommonMark precedence — code
 *  spans and raw HTML share a precedence level, so the construct that STARTS
 *  earlier wins and the loser's delimiters inside it are plain content (spec
 *  §6.1/§6.3). The old code-first composition let a span opener INSIDE a
 *  comment pair across the comment's close: in "Text <!-- ` --> §9 `" the
 *  comment opens first, its backtick is comment content, the trailing lone
 *  backtick pairs with nothing, and §9 must stay LIVE (round-7 #24). NEVER
 *  feed this to block-structure decisions. */
export function maskInlineIgnorable(line: string): string {
	return maskWithPrecedence(line, true);
}

/** The census view of the same precedence scan (round-7 #10): comments blank,
 *  code spans stay VISIBLE — inline code renders as text, so id/count facts
 *  inside it still count, while a span-protected comment ("`<!-- B1 -->`") is
 *  literal text and correctly stays visible too. */
export function maskCommentsKeepCode(line: string): string {
	return maskWithPrecedence(line, false);
}

/** Dispatcher: cheap single-construct fast paths, else the fused scan. */
function maskWithPrecedence(line: string, blankCode: boolean): string {
	if (!line.includes("<!--")) return blankCode ? maskCodeSpans(line) : line;
	if (!line.includes("`")) return maskInlineComments(line);
	const intervals = precedenceIntervals(line, blankCode);
	if (intervals.length === 0) return line;
	const chars = line.split("");
	for (const [s, e] of intervals) {
		for (let k = s; k < e; k++) chars[k] = " ";
	}
	return chars.join("");
}

/** Mutable cursors for the left-to-right precedence scan. Every cursor only
 *  advances — the linearity guarantee (no position is ever re-scanned). */
interface LtrState {
	runs: Array<[number, number]>;
	byLen: Map<number, number[]>;
	cursors: Map<number, number>;
	r: number;
}

/** First PAIRABLE code span whose opener is at/after run cursor `state.r`,
 *  CommonMark pairing: an opener closes at the next run of EXACTLY equal
 *  length. An opener with no equal closer is literal and is skipped
 *  PERMANENTLY — closers are only ever consumed, never added, so an
 *  unpairable run can never become pairable later. */
function nextPairableSpan(
	state: LtrState,
): { start: number; end: number; nextRun: number } | null {
	while (state.r < state.runs.length) {
		const [start, len] = state.runs[state.r] ?? [0, 0];
		const list = state.byLen.get(len) ?? [];
		let c = state.cursors.get(len) ?? 0;
		while (c < list.length && (list[c] ?? 0) <= state.r) c++;
		state.cursors.set(len, c);
		const closer = list[c];
		if (closer === undefined) {
			state.r++;
			continue;
		}
		const [cStart, cLen] = state.runs[closer] ?? [0, 0];
		return { start, end: cStart + cLen, nextRun: closer + 1 };
	}
	return null;
}

/** One step of the fused precedence scan: advances past the earlier of the
 *  next pairable span opener and the next `<!--`, consuming through its own
 *  closer (the loser's chars inside are content). `interval` is the span to
 *  blank (null when nothing should be blanked this step — a span step with
 *  `blankCode` false, or an unclosed-comment retry); `stop` mirrors the
 *  original loop's `break` sites. Mutates `state.r`/cursors like the scan it
 *  was extracted from; `from`/`commentAt` come back explicitly since the
 *  caller owns those two loop variables. */
function advancePrecedenceScan(
	line: string,
	state: LtrState,
	from: number,
	commentAt: number,
	blankCode: boolean,
): { stop: boolean; from: number; commentAt: number; interval: [number, number] | null } {
	while (state.r < state.runs.length && (state.runs[state.r]?.[0] ?? 0) < from) state.r++;
	if (commentAt >= 0 && commentAt < from) commentAt = line.indexOf("<!--", from);
	const span = nextPairableSpan(state);
	if (span && (commentAt < 0 || span.start < commentAt)) {
		state.r = span.nextRun;
		return {
			stop: false,
			from: span.end,
			commentAt,
			interval: blankCode ? [span.start, span.end] : null,
		};
	}
	if (commentAt < 0) return { stop: true, from, commentAt, interval: null };
	const close = line.indexOf("-->", commentAt + 4);
	if (close < 0) {
		if (!span) return { stop: true, from, commentAt, interval: null };
		return { stop: false, from, commentAt: -1, interval: null }; // unclosed → literal; only spans remain ahead
	}
	return { stop: false, from: close + 3, commentAt, interval: [commentAt, close + 3] };
}

/** Blank-intervals from the fused precedence scan: at each position take the
 *  next pairable span opener and the next `<!--`; the EARLIER one wins and
 *  consumes through its own closer, so the loser's chars inside are content.
 *  Comments always blank; spans blank only in the ref/link view. An UNCLOSED
 *  comment is literal on this line (the multiline residual — block layer's
 *  beat) and spans after it still process; no `-->` can follow a later `<!--`
 *  either, so comments are disabled outright. Linear: `from`, the run cursor,
 *  and the cached comment position only move forward, and each `indexOf`
 *  resumes where the previous search ended. */
function precedenceIntervals(
	line: string,
	blankCode: boolean,
): Array<[number, number]> {
	const runs = backtickRuns(line);
	const state: LtrState = { runs, byLen: runIndexByLength(runs), cursors: new Map(), r: 0 };
	const out: Array<[number, number]> = [];
	let from = 0;
	let commentAt = line.indexOf("<!--");
	while (from < line.length) {
		const step = advancePrecedenceScan(line, state, from, commentAt, blankCode);
		if (step.interval) out.push(step.interval);
		if (step.stop) break;
		from = step.from;
		commentAt = step.commentAt;
	}
	return out;
}

/** Count of leading blockquote markers (each: ≤3 spaces, `>`, one optional
 *  space) and the offset just past them. Index walk, no slicing — linear even
 *  on a 320k-char `>` run (round-7 #25). */
function blockquoteDepth(line: string): { depth: number; pos: number } {
	let pos = 0;
	let depth = 0;
	for (;;) {
		let i = pos;
		let spaces = 0;
		while (i < line.length && line[i] === " " && spaces < 3) {
			i++;
			spaces++;
		}
		if (line[i] !== ">") return { depth, pos };
		i++;
		if (line[i] === " ") i++;
		pos = i;
		depth++;
	}
}

/** Offset just past a `<!--` whose first nonspace (≤3-space indent) sits at or
 *  after `pos`, or -1 when the text there is not a comment opener. */
function commentOpenAt(line: string, pos: number): number {
	let i = pos;
	let spaces = 0;
	while (i < line.length && line[i] === " " && spaces < 3) {
		i++;
		spaces++;
	}
	return line.startsWith("<!--", i) ? i + 4 : -1;
}

/** Lines (1-based) inside MULTILINE whole-line HTML comment blocks: an
 *  unfenced line whose first nonspace (≤3-space indent) is `<!--`, through the
 *  first line containing `-->`. The CommonMark HTML block type 2 shape —
 *  rendered invisible, so "<!--\n# Fake\n-->" must produce no heading, ref, or
 *  link (round-5 #20). The opener may sit inside blockquote markers ("> <!--"),
 *  and continuation lines are tested after stripping the same container — a
 *  line with FEWER markers ends the blockquote, truncating the HTML block, so
 *  it stays LIVE (round-7 #25; list-item containers "- " / "1. " remain a
 *  residual). A comment that CLOSES on its own opening line is NOT hidden
 *  here: its tail after `-->` is visible rendered text ("<!-- x --> and §3"
 *  shows "and §3") — the char mask and sameLineCommentBlockLines handle it.
 *  Tail text after `-->` on a multiline CLOSING line is a residual (whole
 *  line hidden). Linear. */
export function htmlCommentBlockLines(
	lines: string[],
	fencedLines: Set<number>,
): Set<number> {
	const hidden = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		if (fencedLines.has(i + 1)) continue;
		const line = lines[i] ?? "";
		const { depth, pos } = blockquoteDepth(line);
		const after = commentOpenAt(line, pos);
		if (after < 0) continue;
		if (line.indexOf("-->", after) >= 0) continue; // same-line close: char-mask's beat
		hidden.add(i + 1);
		i = hideCommentContinuation(lines, i, depth, hidden);
	}
	return hidden;
}

/** Hide the continuation lines of a comment block opened at 0-based index `i`
 *  inside `depth` blockquote markers, through the first line containing `-->`
 *  past the same container prefix. A line with fewer markers ends the block
 *  (blockquote truncation) and stays live. Returns the last consumed index. */
function hideCommentContinuation(
	lines: string[],
	i: number,
	depth: number,
	hidden: Set<number>,
): number {
	let j = i + 1;
	while (j < lines.length) {
		const line = lines[j] ?? "";
		const d = blockquoteDepth(line);
		if (d.depth < depth) return j - 1;
		hidden.add(j + 1);
		if (line.indexOf("-->", d.pos) >= 0) return j;
		j++;
	}
	return j - 1;
}

/** Lines (1-based) that are ONE-LINE HTML comment blocks: first nonspace
 *  (after any blockquote markers) is `<!--` AND the same line contains `-->`.
 *  Per CommonMark the ENTIRE line is a type-2 HTML block, so the tail after
 *  `-->` renders as LITERAL text — a markdown link there must not extract,
 *  while visible text (a §ref) still counts via the char mask (round-7 #26).
 *  Deliberately SEPARATE from the hidden set: these lines still carry live
 *  rendered text. */
export function sameLineCommentBlockLines(
	lines: string[],
	fencedLines: Set<number>,
): Set<number> {
	const out = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (!line.includes("<!--") || fencedLines.has(i + 1)) continue;
		const after = commentOpenAt(line, blockquoteDepth(line).pos);
		if (after >= 0 && line.indexOf("-->", after) >= 0) out.add(i + 1);
	}
	return out;
}

/** `fencedLines` ∪ comment-block lines — the skip set the extractors consult.
 *  Returns `fencedLines` itself when there are no comment blocks (the common
 *  case) so no per-file allocation is paid. */
export function withCommentBlockLines(
	lines: string[],
	fencedLines: Set<number>,
): Set<number> {
	const hidden = htmlCommentBlockLines(lines, fencedLines);
	if (hidden.size === 0) return fencedLines;
	for (const l of fencedLines) hidden.add(l);
	return hidden;
}
