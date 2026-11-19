// Instruction packets — which `*` / `_` in a Markdown instruction file are PRESENTATION (seventh review, audit D1).
//
// The release locator folds presentation away so a quote written as plain prose still finds
// `**Prefer `rg`** over …`. Dropping every `*`/`_` outside a backtick span (the old rule) also dropped content —
// `__init__.py`, `_private`, `*.ts`, `docs/**/*.md`, `/_next/`, and anything inside a ```` or ~~~ fence — so a
// quote could locate a DIFFERENT instruction that differs only in those characters. Here a marker is droppable
// only when it is one run of a MATCHED pair, conservatively:
//   - outside code: fenced blocks (``` / ~~~, any length ≥ 3, closed by the same char at ≥ that length) and
//     inline code spans (a backtick run closes at the next run of the same length);
//   - not escaped (`\*`);
//   - an opener follows start, whitespace or an opening bracket/quote and precedes a non-space;
//   - a closer follows a non-space and precedes end, whitespace, or sentence punctuation that itself precedes
//     end or whitespace (`**push**.` closes; `__init__.py` does not);
//   - same character and same run length; never across a blank line (a paragraph break);
//   - an underscore pair must enclose more than one word (`__init__` is an identifier far more often than bold).
// Anything else is content and stays significant, which makes the locator fail closed instead of guessing.

export interface EmphasisPair {
	/** Offset of the opening run. */
	open: number;
	/** Offset of the closing run. */
	close: number;
	length: number;
}

const OPEN_PUNCT = new Set(["(", "[", "{", '"', "'", "“", "‘"]);
const CLOSE_PUNCT = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", '"', "'", "”", "’"]);
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
/** A fence line, after any container prefix: blockquote markers and indentation of any depth (break R5 #3: a fence
 *  inside `> ` or under a nested list item). Reading too much as a fence only masks more, which fails closed. */
const FENCE = /^[ \t>]*(`{3,}|~{3,})/;
const LIST_ITEM = /^([ \t]*(?:[-*+]|\d{1,9}[.)]))([ \t]+)\S/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/** Leading indentation in columns (a tab advances to the next multiple of 4). */
function indentWidth(line: string): number {
	let w = 0;
	for (const ch of line) {
		if (ch === " ") w++;
		else if (ch === "\t") w += 4 - (w % 4);
		else break;
	}
	return w;
}

/** CommonMark indented code blocks (R6 A4): a line indented 4 columns past the enclosing list item's content
 *  (or 4 columns outside a list) that cannot continue a paragraph — it follows a blank line, a heading, the start,
 *  or another code line. Blank lines inside the block keep it open. */
class IndentedCode {
	private canStart = true;
	private inBlock = false;
	private listContent = 0;

	/** True when `line` is indented code. A fence line (or a line inside a fence) is never indented code, and code
	 *  may start after it. */
	isCode(line: string, fenced: boolean, blank: boolean): boolean {
		if (fenced || blank) {
			if (fenced) this.inBlock = false;
			this.canStart = true;
			return false;
		}
		const width = indentWidth(line);
		if ((this.canStart || this.inBlock) && width >= this.listContent + 4) {
			this.inBlock = true;
			return true;
		}
		const item = LIST_ITEM.exec(line);
		if (item) this.listContent = indentWidth(item[1] as string) + (item[1] as string).trim().length + indentWidth(item[2] as string);
		else if (width === 0 && this.canStart) this.listContent = 0; // a new top-level block ends the list
		this.inBlock = false;
		this.canStart = HEADING.test(line);
		return false;
	}
}

/** True when the fence-shaped line `m` closes the open fence: same character, at least as long, nothing after. */
function closesFence(m: RegExpExecArray | null, line: string, fence: { ch: string; len: number }): boolean {
	const run = m?.[1];
	return run !== undefined && run[0] === fence.ch && run.length >= fence.len && line.slice((m as RegExpExecArray)[0].length).trim() === "";
}

/** Mask of characters inside fenced blocks, indented code blocks, or inline code spans. */
export function codeMask(text: string): Uint8Array {
	const mask = new Uint8Array(text.length);
	let offset = 0;
	let fence: { ch: string; len: number } | null = null;
	const indented = new IndentedCode();
	// Inline code spans are matched per PARAGRAPH (consecutive non-blank lines outside fences): a span may wrap a
	// line (break R5 #2).
	const paragraphs: [number, number][] = [];
	let open: [number, number] | null = null;
	for (const line of text.split("\n")) {
		const m = FENCE.exec(line);
		const end = offset + line.length;
		const fenced = fence !== null || m !== null;
		const blank = line.trim() === "";
		const code = indented.isCode(line, fenced, blank);
		if (code) mask.fill(1, offset, end);
		if (!fenced && !code && !blank) open = open ? [open[0], end] : [offset, end];
		else if (open) {
			paragraphs.push(open);
			open = null;
		}
		if (fence) {
			mask.fill(1, offset, end);
			if (closesFence(m, line, fence)) fence = null;
		} else if (m) {
			fence = { ch: (m[1] as string)[0] as string, len: (m[1] as string).length };
			mask.fill(1, offset, end);
		}
		offset = end + 1;
	}
	if (open) paragraphs.push(open);
	for (const [from, to] of paragraphs) markCodeSpans(text, from, to, mask);
	return mask;
}

/** Inline code spans inside [from, to): a backtick run of length n closes at the next run of exactly n. */
function markCodeSpans(text: string, from: number, to: number, mask: Uint8Array): void {
	let i = from;
	while (i < to) {
		if (text[i] !== "`") {
			i++;
			continue;
		}
		let n = 0;
		while (text[i + n] === "`") n++;
		const close = findRun(text, i + n, to, n);
		if (close < 0) {
			i += n; // an unclosed run is literal backticks
			continue;
		}
		mask.fill(1, i, close + n);
		i = close + n;
	}
}

function findRun(text: string, from: number, to: number, n: number): number {
	let j = from;
	while (j < to) {
		if (text[j] !== "`") {
			j++;
			continue;
		}
		let m = 0;
		while (text[j + m] === "`") m++;
		if (m === n) return j;
		j += m;
	}
	return -1;
}

function escaped(text: string, i: number): boolean {
	let slashes = 0;
	for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) slashes++;
	return slashes % 2 === 1;
}

interface Run {
	at: number;
	ch: string;
	len: number;
	/** The run's length before any partial match consumed it (the rule of 3 reads this). */
	orig: number;
	canOpen: boolean;
	canClose: boolean;
}

function runsOf(text: string, code: Uint8Array): Run[] {
	const runs: Run[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i] as string;
		if ((ch !== "*" && ch !== "_") || code[i] === 1 || escaped(text, i)) {
			i++;
			continue;
		}
		let len = 0;
		while (text[i + len] === ch && code[i + len] !== 1) len++;
		const prev = text[i - 1];
		const next = text[i + len];
		const afterNext = text[i + len + 1];
		const canOpen = (prev === undefined || isSpace(prev) || OPEN_PUNCT.has(prev)) && !isSpace(next);
		const closesAtPunct = next !== undefined && CLOSE_PUNCT.has(next) && (isSpace(afterNext) || CLOSE_PUNCT.has(afterNext as string));
		const canClose = !isSpace(prev) && (isSpace(next) || closesAtPunct);
		runs.push({ at: i, ch, len, orig: len, canOpen, canClose });
		i += len;
	}
	return runs;
}

/** CommonMark's rule of 3: a run that can both open and close does not pair with one whose summed original length
 *  is a multiple of 3, unless both lengths are. */
function ruleOfThree(opener: Run, closer: Run): boolean {
	const both = opener.canClose || closer.canOpen;
	return both && (opener.orig + closer.orig) % 3 === 0 && !(opener.orig % 3 === 0 && closer.orig % 3 === 0);
}

/** Index of the open run this closer matches, or -1: the innermost one of the same character and the same remaining
 *  length, else the innermost one of the same character (a partial match, R6 A6). An exact match is preferred over
 *  CommonMark's nearest-opener rule so `**a *b**` pairs the outer `**` and leaves the lone `*` literal. */
function findOpener(stack: readonly Run[], closer: Run): number {
	let partial = -1;
	for (let k = stack.length - 1; k >= 0; k--) {
		const o = stack[k] as Run;
		if (o.ch !== closer.ch || ruleOfThree(o, closer)) continue;
		if (o.len === closer.len) return k;
		if (partial < 0) partial = k;
	}
	return partial;
}

function matchClosingRun(run: Run, stack: Run[], text: string, pairs: EmphasisPair[]): void {
	// A closer consumes min(opener, closer) characters: the opener's INNER end and the closer's start. What is
	// left of the closer looks for another opener (`***a** b*`), and what is left of an opener stays open.
	let k = run.canClose ? findOpener(stack, run) : -1;
	while (k >= 0) {
		const opener = stack[k] as Run;
		const n = Math.min(opener.len, run.len);
		const open = opener.at + opener.len - n;
		stack.length = k + 1;
		opener.len -= n;
		if (opener.len === 0) stack.pop();
		// `__init__ ` IS bold in CommonMark, but a one-word underscore pair is far likelier an identifier
		// (`__init__`, `__dirname__`) than emphasis: it stays content, so a quote without it fails closed.
		if (run.ch !== "_" || /\s/.test(text.slice(open + n, run.at))) pairs.push({ open, close: run.at, length: n });
		run.at += n;
		run.len -= n;
		k = run.len > 0 ? findOpener(stack, run) : -1;
	}
}

/** Matched emphasis pairs, ordered by opener. */
export function emphasisPairs(text: string): EmphasisPair[] {
	const runs = runsOf(text, codeMask(text));
	// Emphasis never crosses a paragraph break or the start of a new list item (break R5 #8).
	const breaks = [...text.matchAll(/\n[ \t]*\n|\n[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/g)].map((m) => m.index ?? 0);
	const pairs: EmphasisPair[] = [];
	let stack: Run[] = [];
	let nextBreak = 0;
	for (const run of runs) {
		while (nextBreak < breaks.length && (breaks[nextBreak] as number) < run.at) {
			stack = []; // emphasis never crosses a paragraph break
			nextBreak++;
		}
		matchClosingRun(run, stack, text, pairs);
		if (run.len > 0 && run.canOpen) stack.push(run);
	}
	return pairs.sort((a, b) => a.open - b.open);
}

/** 1 at every character of a matched emphasis run — the only `*`/`_` a fold may drop. */
export function droppableMarkers(text: string): Uint8Array {
	const mask = new Uint8Array(text.length);
	for (const p of emphasisPairs(text)) {
		mask.fill(1, p.open, p.open + p.length);
		mask.fill(1, p.close, p.close + p.length);
	}
	return mask;
}
