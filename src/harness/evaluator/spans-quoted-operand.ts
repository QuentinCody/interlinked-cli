// Quoted-operand projection for `executed_only` rule matching (2026-10-09).
// A quote around ONE shell word is an operand, not a mention: `rm -rf "/etc"`
// and `truncate -s 0 "src/app.ts"` must read like their unquoted twins (every
// `executed_only` rule missed a quoted target before). Split out of spans.ts
// for the line cap; spans.ts decides WHICH spans are quoted, this decides how
// a quoted span renders.

const QUOTE_SINGLE = "'";
const ANSI_C_QUOTE = "$'";

/** A quoted body that is ONE shell word: no whitespace, operator, substitution,
 *  backslash or nested quote. */
const SIMPLE_WORD_RE = /^[^\s;|&<>()`'"\\]+$/;

/** Render a quoted span's text (delimiters included) with a single-word body
 *  visible and the delimiters space-filled, so the output keeps the span's
 *  length and indices hold. Returns null when the body is wider than one word
 *  (`git commit -m 'rm -rf /'`), empty, or unterminated with no body — those
 *  stay masked by the caller. */
export function quotedOperandText(text: string): string | null {
	const openLen = text.startsWith(ANSI_C_QUOTE) ? 2 : 1;
	const closer = openLen === 2 ? QUOTE_SINGLE : text.charAt(0);
	const closed = text.length > openLen && text.endsWith(closer);
	const body = text.slice(openLen, closed ? -1 : undefined);
	if (!SIMPLE_WORD_RE.test(body)) return null;
	return " ".repeat(openLen) + body + (closed ? " " : "");
}
