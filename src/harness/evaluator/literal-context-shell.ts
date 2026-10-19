// ===========================================
// Literal-context classifier — conservative shell segmenter
// ===========================================
// Splits a Bash command into simple-command segments of quote-aware words,
// keeping each word's ORIGINAL character offsets so a caller can map a
// region of the unquoted text back to the raw command. Used only by
// `literal-context.ts` to decide when guard-rule text is data, not code.
//
// The parser is deliberately incomplete: every construct it does not model
// (command substitution, backticks, subshell parentheses, ANSI-C quoting,
// two heredocs on one line, an unterminated quote or heredoc) returns `null`.
// `null` means "unsure", and the caller then keeps the block — the
// classifier may only ever REMOVE a block when it fully understands the
// command.

/** One shell word: its unquoted text plus the raw offset of every char. */
export interface ShellWord {
	start: number;
	end: number;
	text: string;
	offsets: number[];
	/** Any part of the word was single- or double-quoted. */
	quoted: boolean;
	/** A redirection operator (`>`, `2>`, `<<`, `&>` …) — not an argument. */
	op?: string;
}

/** A heredoc body attached to the segment whose line introduced it. */
export interface Heredoc {
	bodyStart: number;
	bodyEnd: number;
	/** The raw body text, `cmd.slice(bodyStart, bodyEnd)`. */
	body: string;
	/** The delimiter was quoted, so the shell expands nothing in the body. */
	quoted: boolean;
}

export interface ShellSegment {
	words: ShellWord[];
	/** The operator that ended the segment: `;`, `&&`, `||`, `|`, `|&`, `&`, `\n`, or "". */
	sepAfter: string;
	heredoc?: Heredoc;
}

interface PendingHeredoc {
	segment: ShellSegment;
	delimiter: string;
	quoted: boolean;
	stripTabs: boolean;
}

interface ParseState {
	cmd: string;
	i: number;
	segments: ShellSegment[];
	current: ShellSegment;
	word: ShellWord | null;
	pending: PendingHeredoc | null;
	/** The next completed word is a heredoc delimiter for this operator. */
	awaitingDelimiter: string | null;
}

class Unsure extends Error {}

const SEPARATORS = ["&&", "||", "|&", ";;", "|", ";", "&"];
const REDIRECT_OPS = ["<<<", "<<-", "<<", ">>", ">&", ">|", "<&", "<>", "&>>", "&>", ">", "<"];
const DOUBLE_QUOTE_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);

function newSegment(): ShellSegment {
	return { words: [], sepAfter: "" };
}

function ensureWord(s: ParseState): ShellWord {
	if (!s.word) s.word = { start: s.i, end: s.i, text: "", offsets: [], quoted: false };
	return s.word;
}

function pushChar(s: ParseState, ch: string, at: number): void {
	const w = ensureWord(s);
	w.text += ch;
	w.offsets.push(at);
}

function finishWord(s: ParseState): void {
	const w = s.word;
	if (!w) return;
	w.end = s.i;
	s.word = null;
	if (s.awaitingDelimiter !== null) {
		registerHeredoc(s, w);
		return;
	}
	s.current.words.push(w);
}

function registerHeredoc(s: ParseState, w: ShellWord): void {
	if (s.pending) throw new Unsure("two heredocs on one line");
	s.pending = {
		segment: s.current,
		delimiter: w.text,
		quoted: w.quoted,
		stripTabs: s.awaitingDelimiter === "<<-",
	};
	s.awaitingDelimiter = null;
}

function finishSegment(s: ParseState, sep: string): void {
	finishWord(s);
	s.current.sepAfter = sep;
	if (s.current.words.length > 0) s.segments.push(s.current);
	s.current = newSegment();
}

function readSingleQuoted(s: ParseState): void {
	const close = s.cmd.indexOf("'", s.i + 1);
	if (close < 0) throw new Unsure("unterminated single quote");
	const w = ensureWord(s);
	w.quoted = true;
	for (let k = s.i + 1; k < close; k++) pushChar(s, s.cmd.charAt(k), k);
	s.i = close + 1;
}

function readDoubleQuoted(s: ParseState): void {
	const w = ensureWord(s);
	w.quoted = true;
	let k = s.i + 1;
	while (k < s.cmd.length) {
		const ch = s.cmd.charAt(k);
		if (ch === '"') {
			s.i = k + 1;
			return;
		}
		if (ch === "`" || (ch === "$" && s.cmd.charAt(k + 1) === "(")) throw new Unsure("substitution");
		if (ch === "\\" && DOUBLE_QUOTE_ESCAPABLE.has(s.cmd.charAt(k + 1))) {
			if (s.cmd.charAt(k + 1) !== "\n") pushChar(s, s.cmd.charAt(k + 1), k + 1);
			k += 2;
			continue;
		}
		pushChar(s, ch, k);
		k++;
	}
	throw new Unsure("unterminated double quote");
}

/** Consume the heredoc body that starts after the newline at `s.i`. */
function consumeHeredocBody(s: ParseState, p: PendingHeredoc): void {
	const bodyStart = s.i + 1;
	let lineStart = bodyStart;
	while (lineStart <= s.cmd.length) {
		const nl = s.cmd.indexOf("\n", lineStart);
		const lineEnd = nl < 0 ? s.cmd.length : nl;
		const line = s.cmd.slice(lineStart, lineEnd);
		const candidate = p.stripTabs ? line.replace(/^\t+/, "") : line;
		if (candidate === p.delimiter) {
			p.segment.heredoc = { bodyStart, bodyEnd: lineStart, body: s.cmd.slice(bodyStart, lineStart), quoted: p.quoted };
			s.i = lineEnd;
			return;
		}
		if (nl < 0) break;
		lineStart = nl + 1;
	}
	throw new Unsure("unterminated heredoc");
}

function startsWithAny(s: ParseState, list: string[]): string | null {
	for (const tok of list) if (s.cmd.startsWith(tok, s.i)) return tok;
	return null;
}

function readOperator(s: ParseState, ch: string): boolean {
	const fdPrefixed = s.word !== null && /^\d+$/.test(s.word.text) && !s.word.quoted;
	if (ch === ">" || ch === "<" || (ch === "&" && s.cmd.charAt(s.i + 1) === ">")) {
		const op = startsWithAny(s, REDIRECT_OPS);
		if (op) {
			const prefix = fdPrefixed && s.word ? s.word.text : "";
			if (!fdPrefixed) finishWord(s);
			s.word = null;
			s.current.words.push({ start: s.i, end: s.i + op.length, text: prefix + op, offsets: [], quoted: false, op: prefix + op });
			s.i += op.length;
			if (op === "<<" || op === "<<-") s.awaitingDelimiter = op;
			return true;
		}
	}
	const sep = startsWithAny(s, SEPARATORS);
	if (!sep) return false;
	finishSegment(s, sep);
	s.i += sep.length;
	return true;
}

function handleNewline(s: ParseState): void {
	finishSegment(s, "\n");
	const pending = s.pending;
	s.pending = null;
	if (pending) consumeHeredocBody(s, pending);
	s.i++;
}

function skipComment(s: ParseState): void {
	const nl = s.cmd.indexOf("\n", s.i);
	s.i = nl < 0 ? s.cmd.length : nl;
}

/** Advance past one unquoted backslash, blank, or plain character. */
function stepPlain(s: ParseState, ch: string, next: string): void {
	if (ch === "\\") {
		if (next !== "\n") pushChar(s, next, s.i + 1);
		s.i += 2;
		return;
	}
	if (ch === " " || ch === "\t") finishWord(s);
	else pushChar(s, ch, s.i);
	s.i++;
}

/** Process one character outside any quote; throws `Unsure` at an unsupported construct. */
function step(s: ParseState): void {
	const ch = s.cmd.charAt(s.i);
	const next = s.cmd.charAt(s.i + 1);
	if (ch === "`" || ch === "(" || ch === ")" || (ch === "$" && (next === "(" || next === "'"))) {
		throw new Unsure("unsupported construct");
	}
	if (ch === "\n") handleNewline(s);
	else if (ch === "#" && s.word === null) skipComment(s);
	else if (ch === "'") readSingleQuoted(s);
	else if (ch === '"') readDoubleQuoted(s);
	else if (!readOperator(s, ch)) stepPlain(s, ch, next);
}

/** Public API — split `cmd` into segments, or `null` when any construct is
 *  outside the conservative subset this parser models. */
export function parseShellSegments(cmd: string): ShellSegment[] | null {
	const s: ParseState = {
		cmd,
		i: 0,
		segments: [],
		current: newSegment(),
		word: null,
		pending: null,
		awaitingDelimiter: null,
	};
	try {
		while (s.i < cmd.length) step(s);
		finishSegment(s, "");
		if (s.pending || s.awaitingDelimiter !== null) throw new Unsure("heredoc without body");
		return s.segments;
	} catch (err) {
		if (err instanceof Unsure) return null;
		throw err;
	}
}
