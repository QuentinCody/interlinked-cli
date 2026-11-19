// ===========================================
// Project Graph — Comment Masking
// ===========================================
// Removes `//` and `/* */` comment text so the import parser never reads
// `import('./x')` inside JSDoc as a real edge. Newlines inside a block comment
// stay, so line structure is unchanged. Single-quote and double-quote strings
// are tracked per line (a stray apostrophe in JSX text or a regex cannot spoil
// later lines). Template literals are not tracked.

type QuoteChar = "'" | '"';

function isQuote(ch: string | undefined): ch is QuoteChar {
	return ch === "'" || ch === '"';
}

/** Index just after the closing quote of the string opened at `start` (or the line end). */
export function skipString(text: string, start: number): number {
	const quote = text[start];
	let i = start + 1;
	while (i < text.length && text[i] !== "\n") {
		if (text[i] === "\\") i += 2;
		else if (text[i] === quote) return i + 1;
		else i++;
	}
	return i;
}

/** Index of the `\n` ending the line comment that starts at `start` (or the text end). */
export function endOfLineComment(text: string, start: number): number {
	const nl = text.indexOf("\n", start);
	return nl === -1 ? text.length : nl;
}

/** The newlines inside the block comment at `start`, and the index after its closing marker. */
export function skipBlockComment(text: string, start: number): { next: number; newlines: string } {
	const close = text.indexOf("*/", start + 2);
	const end = close === -1 ? text.length : close + 2;
	return { next: end, newlines: text.slice(start, end).replace(/[^\n]/g, "") };
}

/**
 * Return `text` with comment bodies removed. Strings are left untouched.
 */
export function maskComments(text: string): string {
	if (!text.includes("/*") && !text.includes("//")) return text;
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const pair = text.slice(i, i + 2);
		if (isQuote(ch)) {
			const end = skipString(text, i);
			out += text.slice(i, end);
			i = end;
		} else if (pair === "//") {
			i = endOfLineComment(text, i);
		} else if (pair === "/*") {
			const block = skipBlockComment(text, i);
			out += block.newlines;
			i = block.next;
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}
