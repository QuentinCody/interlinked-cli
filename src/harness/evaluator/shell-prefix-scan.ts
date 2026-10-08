// ===========================================
// Shell prefix scan: is a position at the top level of the shell?
// ===========================================
// The heredoc runtime mask (heredoc-runtime-mask.ts) may hide a body only
// when its heredoc operator sits at the top level. The span scanner in
// spans.ts pairs quotes without shell nesting (`"$(echo '"'\'; …` ends its
// double-quoted span at the inner `"`), so its view of "executed text" can
// hide an open `$(`. This scanner reads the RAW command text before the
// operator the way the shell does: single, double and ANSI-C quotes, `$(`,
// backticks, `${`, comments at a word start, case patterns, and earlier
// heredoc bodies (skipped to their closer line).
//
// It is not a full shell parser. Where it cannot be sure (an unterminated
// quote, a heredoc with no closer, a `TAG)` closer line, a heredoc header
// still waiting for its body) it reports "not top level", which keeps the
// body scannable: the failure goes toward recall.

type Frame = "(" | "{" | "`" | '"' | "case";

interface PendingHeredoc {
	tag: string;
	dashed: boolean;
}

interface ScanState {
	text: string;
	i: number;
	stack: Frame[];
	pending: PendingHeredoc[];
	bare: string;
	uncertain: boolean;
}

export interface ShellPrefixScan {
	/** No open quote, substitution, group, case or pending heredoc. */
	topLevel: boolean;
	/** Unquoted shell text outside comments and heredoc bodies. */
	bare: string;
}

const HEREDOC_HEADER_RE = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_][\w-]*))/;
const WORD_START_PREV_RE = /[\s;&|(){}`]/;
const CASE_WORD_RE = /^(case|esac)(?=[\s;&|()]|$)/;
const OPENER_FRAME: Readonly<Record<string, Frame>> = { "(": "(", "{": "{" };
const CLOSER_FRAME: Readonly<Record<string, Frame>> = { ")": "(", "}": "{" };

function atWordStart(st: ScanState): boolean {
	const prev = st.text[st.i - 1];
	return prev === undefined || WORD_START_PREV_RE.test(prev);
}

function top(st: ScanState): Frame | undefined {
	return st.stack[st.stack.length - 1];
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Index after the `'` that closes a single-quoted run (ANSI-C `$'…'`
 *  honors `\` escapes); -1 when no closer exists. */
function quoteEnd(text: string, from: number, escapes: boolean): number {
	for (let j = from; j < text.length; j++) {
		if (escapes && text[j] === "\\") j++;
		else if (text[j] === "'") return j + 1;
	}
	return -1;
}

/** One step inside `"…"`: only `\`, the closing `"`, `$(`, `${` and
 *  backticks mean anything there. */
function stepDoubleQuoted(st: ScanState): void {
	const ch = st.text[st.i];
	if (ch === "\\") st.i += 2;
	else if (ch === '"') {
		st.stack.pop();
		st.i++;
	} else if (st.text.startsWith("$(", st.i) || st.text.startsWith("${", st.i)) {
		st.stack.push(st.text[st.i + 1] === "(" ? "(" : "{");
		st.i += 2;
	} else {
		if (ch === "`") st.stack.push("`");
		st.i++;
	}
}

/** At the newline that ends a header line: skip the body of each pending
 *  heredoc, in order, to the end of its closer line. */
function skipHeredocBodies(st: ScanState): void {
	for (const doc of st.pending) {
		const indent = doc.dashed ? "\\t*" : "";
		const closer = new RegExp(`\\n${indent}${escapeRe(doc.tag)}(\\)?)(?=\\n|$)`);
		const m = st.text.slice(st.i).match(closer);
		if (!m || m.index === undefined || m[1] === ")") {
			st.uncertain = true;
			return;
		}
		st.i += m.index + m[0].length;
	}
	st.pending = [];
}

function stepNewline(st: ScanState): void {
	st.bare += "\n";
	if (st.pending.length > 0) skipHeredocBodies(st);
	else st.i++;
}

/** `<<<` here-string or a `<<TAG` heredoc header (the tag is remembered
 *  until the line ends). False when neither starts here. */
function stepHeredocHeader(st: ScanState): boolean {
	if (st.text.startsWith("<<<", st.i)) {
		st.bare += "<<<";
		st.i += 3;
		return true;
	}
	const m = st.text.slice(st.i).match(HEREDOC_HEADER_RE);
	if (!m) return false;
	st.pending.push({ tag: m[2] ?? m[3] ?? m[4] ?? "", dashed: m[1] === "-" });
	st.bare += "<<";
	st.i += m[0].length;
	return true;
}

/** Apply a grouping byte to the frame stack. Inside a case body the parens
 *  of a pattern are not grouping. False for any other byte. */
function applyGrouping(st: ScanState, ch: string): boolean {
	if (ch === "`") {
		if (top(st) === "`") st.stack.pop();
		else st.stack.push("`");
		return true;
	}
	const inCase = top(st) === "case";
	const opener = OPENER_FRAME[ch];
	if (opener !== undefined) {
		if (!inCase) st.stack.push(opener);
		return true;
	}
	const closes = CLOSER_FRAME[ch];
	if (closes === undefined) return false;
	if (!inCase && top(st) === closes) st.stack.pop();
	return true;
}

function stepGrouping(st: ScanState, ch: string): boolean {
	if (!applyGrouping(st, ch)) return false;
	st.bare += ch;
	st.i++;
	return true;
}

function stepCaseWord(st: ScanState): boolean {
	const word = st.text.slice(st.i, st.i + 5).match(CASE_WORD_RE)?.[1];
	if (word === undefined || !atWordStart(st)) return false;
	if (word === "case") st.stack.push("case");
	else if (top(st) === "case") st.stack.pop();
	st.bare += word;
	st.i += word.length;
	return true;
}

function stepSingleQuote(st: ScanState, ansiC: boolean): void {
	const end = quoteEnd(st.text, st.i + (ansiC ? 2 : 1), ansiC);
	if (end < 0) st.uncertain = true;
	else st.i = end;
}

function stepComment(st: ScanState): void {
	const nl = st.text.indexOf("\n", st.i);
	st.i = nl === -1 ? st.text.length : nl;
}

/** One step in unquoted shell code (top level, `$(`, `{`, backticks). */
function stepCode(st: ScanState): void {
	const ch = st.text[st.i] ?? "";
	if (ch === "\\") {
		st.bare += st.text.slice(st.i, st.i + 2);
		st.i += 2;
	} else if (ch === "'" || st.text.startsWith("$'", st.i)) stepSingleQuote(st, ch !== "'");
	else if (ch === '"') {
		st.stack.push('"');
		st.i++;
	} else if (ch === "#" && atWordStart(st)) stepComment(st);
	else if (ch === "\n") stepNewline(st);
	else if (!stepHeredocHeader(st) && !stepGrouping(st, ch) && !stepCaseWord(st)) {
		st.bare += ch;
		st.i++;
	}
}

/** Read `text` (the raw command before a position) as the shell does. */
export function scanShellPrefix(text: string): ShellPrefixScan {
	const st: ScanState = { text, i: 0, stack: [], pending: [], bare: "", uncertain: false };
	while (st.i < text.length && !st.uncertain) {
		if (top(st) === '"') stepDoubleQuoted(st);
		else stepCode(st);
	}
	const topLevel = !st.uncertain && st.stack.length === 0 && st.pending.length === 0;
	return { topLevel, bare: st.bare };
}
