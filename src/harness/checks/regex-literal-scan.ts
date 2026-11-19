// ===========================================
// Regex-literal blanking — bounded, linear-per-slash scanners
// ===========================================
// Two detectors (`js_loose_equality`, `nan_comparison`) blank single-line regex literals before they look for
// operators. They used one regex, `/(?:\\.|\[[^\]]*\]|[^/\\\n])+\//`. Its `[` branch overlaps its catch-all branch, so a
// failed match backtracks exponentially in the number of `[..]` groups, and on a minified bundle (one 350 KB line with
// thousands of division slashes) every slash also rescans the rest of the line. `verify --all-checks` stalled on such
// a file for 841 s. These scanners read each candidate once, give up after MAX_LITERAL_CHARS, and cap backtracking.

/** A regex literal longer than this is not blanked; real literals are far shorter. */
export const MAX_LITERAL_CHARS = 1000;
const MAX_STEPS = MAX_LITERAL_CHARS * 4;
const ANYWHERE_FLAGS = "dgimsuy";
const LEXER_FLAGS = "dgimsuyv";
const LEXER_START_PREFIX = /(^|[=(,:[!&|?{};<>+\-*%~^]|(?<![.\w$])(?:return|typeof|case|yield|void|delete|throw|else))(\s*)(?=\/)/gm;

interface Budget { steps: number }

function isLineBreak(c: string | undefined): boolean {
	return c === "\n" || c === "\r" || c === " " || c === " ";
}

function afterCharacterClass(text: string, start: number, open: number, budget: Budget): number {
	const close = text.indexOf("]", open + 1);
	if (close < 0 || close - start > MAX_LITERAL_CHARS) return -1;
	return scanBody(text, start, close + 1, budget);
}

function scanBody(text: string, start: number, from: number, budget: Budget): number {
	const end = Math.min(text.length, start + MAX_LITERAL_CHARS + 1);
	for (let pos = from; pos < end; pos++) {
		if (++budget.steps > MAX_STEPS) return -1;
		switch (text[pos]) {
			case "\\":
				if (++pos >= text.length || isLineBreak(text[pos])) return -1;
				break;
			case "/":
				return pos === start + 1 ? -1 : pos;
			case "\n":
				return -1;
			case "[": {
				const viaClass = afterCharacterClass(text, start, pos, budget);
				if (viaClass >= 0) return viaClass;
				break;
			}
		}
	}
	return -1;
}

/**
 * Index just after a single-line regex literal (closing slash plus flags) that starts at `start`, or -1.
 * `text[start]` must be `/`. The body has at least one character; a character class may hold `/`.
 */
export function findRegexLiteralEnd(text: string, start: number, flags: string): number {
	if (text[start] !== "/") return -1;
	const close = scanBody(text, start, start + 1, { steps: 0 });
	if (close < 0) return -1;
	let end = close + 1;
	while (end < text.length && flags.includes(text[end] as string)) end++;
	return end;
}

/** Blank every regex-literal-shaped span, wherever it starts, to same-length spaces. */
export function blankRegexLiteralsAnywhere(text: string): string {
	let out = "";
	let last = 0;
	let from = 0;
	for (;;) {
		const slash = text.indexOf("/", from);
		if (slash < 0) break;
		const end = findRegexLiteralEnd(text, slash, ANYWHERE_FLAGS);
		if (end < 0) {
			from = slash + 1;
			continue;
		}
		out += text.slice(last, slash) + " ".repeat(end - slash);
		last = end;
		from = end;
	}
	return last === 0 ? text : out + text.slice(last);
}

/** Blank regex literals that start where the lexer accepts one (after an operator, opener or expression keyword). */
export function blankRegexLiteralsAtLexerStart(text: string): string {
	const prefix = new RegExp(LEXER_START_PREFIX.source, LEXER_START_PREFIX.flags);
	let out = "";
	let last = 0;
	for (;;) {
		const m = prefix.exec(text);
		if (!m) break;
		const slash = m.index + m[0].length;
		const end = findRegexLiteralEnd(text, slash, LEXER_FLAGS);
		if (end < 0) {
			prefix.lastIndex = m.index + 1;
			continue;
		}
		out += text.slice(last, slash) + " ".repeat(end - slash);
		last = end;
		prefix.lastIndex = end;
	}
	return last === 0 ? text : out + text.slice(last);
}
