/**
 * Offset-preserving text helpers for reading a linter configuration file without running it. Nothing here imports or evaluates the
 * file: it reads quoted strings from known keys. Every helper keeps character offsets stable so that a rule can name its line.
 */
export type CommentStyle = "hash" | "js";

const OPENERS = "([{";
const CLOSERS = ")]}";

/** The index just past a quoted string that starts at `start` (a quote character), or the text length when it never closes. */
function stringEnd(text: string, start: number): number {
	const quote = text[start];
	for (let i = start + 1; i < text.length; i += 1) {
		if (text[i] === "\\" && quote !== "'") { i += 1; continue; }
		if (text[i] === quote) return i + 1;
	}
	return text.length;
}

const isQuote = (c: string | undefined, style: CommentStyle): boolean => c === '"' || c === "'" || (style === "js" && c === "`");

function blank(text: string, from: number, to: number): string {
	return text.slice(from, to).replace(/[^\n]/g, " ");
}

/** The text with comments replaced by spaces (newlines kept), so offsets and line numbers still hold. Strings are respected. */
export function maskComments(text: string, style: CommentStyle): string {
	let out = "", i = 0;
	while (i < text.length) {
		const quoted = isQuote(text[i], style);
		const end = quoted ? stringEnd(text, i) : commentEnd(text, i, style);
		if (end === -1) { out += text[i]; i += 1; continue; }
		out += quoted ? text.slice(i, end) : blank(text, i, end);
		i = end;
	}
	return out;
}

/** The index where a comment that starts at `i` ends, or -1 when no comment starts there. */
function commentEnd(text: string, i: number, style: CommentStyle): number {
	const pair = text.slice(i, i + 2);
	if (style === "hash" ? pair[0] === "#" : pair === "//") {
		const end = text.indexOf("\n", i);
		return end === -1 ? text.length : end;
	}
	if (style === "js" && pair === "/*") {
		const close = text.indexOf("*/", i + 2);
		return close === -1 ? text.length : close + 2;
	}
	return -1;
}

/** The index of the bracket that closes the one at `open`, or -1. Strings are skipped. */
export function matchBracket(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i += 1) {
		const c = text[i] ?? "";
		if (isQuote(c, "js")) { i = stringEnd(text, i) - 1; continue; }
		if (OPENERS.includes(c)) depth += 1;
		else if (CLOSERS.includes(c) && (depth -= 1) === 0) return i;
	}
	return -1;
}

export interface FoundString { value: string; offset: number; end: number; }

/** Offsets of the `{` characters that are still open at `index`, outermost first. Strings are skipped; pass comment-masked text. */
export function openBraces(text: string, index: number): number[] {
	const stack: number[] = [];
	for (let i = 0; i < index && i < text.length; i += 1) {
		const c = text[i];
		if (isQuote(c, "js")) i = stringEnd(text, i) - 1;
		else if (c === "{") stack.push(i);
		else if (c === "}") stack.pop();
	}
	return stack;
}

/** The plain quoted strings in `[from, to)`. A template literal with an interpolation is not a plain string and is skipped. */
export function scanStrings(text: string, from: number, to: number): FoundString[] {
	const found: FoundString[] = [];
	for (let i = from; i < to; i += 1) {
		if (!isQuote(text[i], "js")) continue;
		const end = stringEnd(text, i);
		const raw = text.slice(i + 1, Math.max(i + 1, end - 1));
		if (!(text[i] === "`" && raw.includes("${"))) found.push({ value: raw.replace(/\\(.)/g, "$1"), offset: i, end });
		i = end - 1;
	}
	return found;
}

/** 1-based line number of `offset`. */
export function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let at = text.indexOf("\n"); at !== -1 && at < offset; at = text.indexOf("\n", at + 1)) line += 1;
	return line;
}

/** The text with the inside of every nested bracket pair (and of strings that sit inside one) replaced by spaces; depth-0 text is kept. */
export function blankNested(text: string): string {
	let out = "", depth = 0, i = 0;
	while (i < text.length) {
		const c = text[i] ?? "";
		const end = isQuote(c, "js") ? stringEnd(text, i) : i + 1;
		const piece = text.slice(i, end);
		const opens = OPENERS.includes(c), closes = CLOSERS.includes(c);
		if (closes) depth = Math.max(0, depth - 1);
		out += depth === 0 || opens || closes ? piece : blank(piece, 0, piece.length);
		if (opens) depth += 1;
		i = end;
	}
	return out;
}

const KEY = /(?:^|[,{\s])(?:([A-Za-z_$][\w$]*)|"([^"\n]+)"|'([^'\n]+)')\s*:|\.\.\./g;

/** The property names at depth 0 of an object body that `blankNested` has flattened; `...` stands for a spread. */
export function topLevelKeys(flat: string): string[] {
	return [...flat.matchAll(KEY)].map((match) => match[1] ?? match[2] ?? match[3] ?? "...");
}

/** The index of the value bracket of `key` at depth 0 inside `[from, to)` of `text`, or -1. Keys may be quoted or bare. */
export function keyValueOpen(text: string, from: number, to: number, key: string): number {
	const flat = blankNested(text.slice(from, to));
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const found = new RegExp(`(?:["']${escaped}["']|(?<![\\w$])${escaped})\\s*:\\s*([\\[{])`).exec(flat);
	return found === null ? -1 : from + found.index + found[0].length - 1;
}
