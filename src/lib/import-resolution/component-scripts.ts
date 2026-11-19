// ===========================================
// Single-file components: script text with the line numbers kept
// ===========================================
// A `.svelte`, `.vue` or `.astro` file imports modules from its `<script>`
// blocks (Astro: also from the frontmatter between two `---` lines). This
// module returns the file text with everything outside those script bodies
// replaced by spaces. Newlines stay, so the length and every line number match
// the original and a TypeScript or regex import parser can read the result.
// Static text only: no component compiler runs.
//
// KNOWN GAPS: `<script src="./x.ts">` (Vue) is not read as an import; a
// `{#await import(...)}` block in Svelte markup is not read; a script in a
// language other than JavaScript or TypeScript is skipped.

export type ComponentKind = "svelte" | "vue" | "astro";

const KIND_BY_EXTENSION: Readonly<Record<string, ComponentKind>> = { ".svelte": "svelte", ".vue": "vue", ".astro": "astro" };
const READABLE_SCRIPT_LANGS = new Set(["", "ts", "typescript", "js", "javascript", "tsx", "jsx"]);

/** The component kind for a path, or null for any other file (`x.svelte.ts` is code, not a component). */
export function componentKind(path: string): ComponentKind | null {
	const dot = path.lastIndexOf(".");
	return dot < 0 ? null : (KIND_BY_EXTENSION[path.slice(dot)] ?? null);
}

/** Index of the `>` that ends the tag opened at `start`, skipping quoted attribute values; -1 when none. */
function tagEnd(text: string, start: number): number {
	let quote = "";
	for (let i = start; i < text.length; i++) {
		const ch = text[i] as string;
		if (quote) {
			if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === ">") return i;
	}
	return -1;
}

function scriptLang(attributes: string): string {
	const match = /\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/.exec(attributes);
	return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").toLowerCase();
}

interface MaskState {
	text: string;
	/** Script body ranges to keep, in increasing order. */
	kept: [number, number][];
}

function keep(state: MaskState, from: number, to: number): void {
	if (to > from) state.kept.push([from, to]);
}

const NOT_LINE_BREAK = /[^\r\n]/g;

/** `text` with every character outside the kept ranges replaced by a space; line breaks stay. */
function blankOutside(text: string, kept: readonly [number, number][]): string {
	let out = "";
	let at = 0;
	for (const [from, to] of kept) {
		out += text.slice(at, from).replace(NOT_LINE_BREAK, " ") + text.slice(from, to);
		at = to;
	}
	return out + text.slice(at).replace(NOT_LINE_BREAK, " ");
}

/** Index of the first match of the sticky-free, global, case-insensitive `pattern` at or after `from`; the text length when none. */
function indexOfPattern(text: string, pattern: RegExp, from: number): number {
	pattern.lastIndex = from;
	const match = pattern.exec(text);
	return match ? match.index : text.length;
}

const SCRIPT_CLOSE = /<\/script/gi;
const STYLE_CLOSE = /<\/style/gi;
/** The only tags that matter in markup: a comment, a script, a style. Every other tag is skipped by the regex engine. */
const MARKUP_TOKEN = /<!--|<script(?=[\s>/])|<style(?=[\s>])/gi;

/** Handle one `<script ...>` tag at `at`; returns the index to resume scanning from. */
function readScript(state: MaskState, at: number): number {
	const end = tagEnd(state.text, at + 7);
	if (end < 0) return state.text.length;
	if (state.text[end - 1] === "/") return end + 1;
	const bodyEnd = indexOfPattern(state.text, SCRIPT_CLOSE, end);
	if (READABLE_SCRIPT_LANGS.has(scriptLang(state.text.slice(at + 7, end)))) keep(state, end + 1, bodyEnd);
	return bodyEnd;
}

/** Resume index after the token matched at `at`. */
function readToken(state: MaskState, token: string, at: number): number {
	if (token === "<!--") {
		const close = state.text.indexOf("-->", at + 4);
		return close < 0 ? state.text.length : close + 3;
	}
	return token.toLowerCase() === "<script" ? readScript(state, at) : indexOfPattern(state.text, STYLE_CLOSE, at);
}

function readMarkup(state: MaskState, from: number): void {
	const tokens = new RegExp(MARKUP_TOKEN.source, "gi");
	tokens.lastIndex = from;
	for (let match = tokens.exec(state.text); match; match = tokens.exec(state.text)) {
		tokens.lastIndex = readToken(state, match[0], match.index);
	}
}

/** End offset of an Astro frontmatter block that opens the file, with its body start; null when there is none. */
function astroFrontmatter(text: string): { start: number; end: number; resume: number } | null {
	const open = /^\s*---[ \t]*\r?\n/.exec(text);
	if (!open) return null;
	const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(open[0].length - 1));
	if (!close) return null;
	const start = open[0].length;
	const end = open[0].length - 1 + close.index;
	return { start, end, resume: end + close[0].length };
}

/** The file text with only script bodies left; same length, same line breaks. */
export function maskComponentScripts(text: string, kind: ComponentKind): string {
	const state: MaskState = { text, kept: [] };
	let from = 0;
	if (kind === "astro") {
		const front = astroFrontmatter(text);
		if (front) {
			keep(state, front.start, front.end);
			from = front.resume;
		}
	}
	readMarkup(state, from);
	return blankOutside(text, state.kept);
}
