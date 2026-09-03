// Language-aware comment/string stripping for the reinterpret-alignment
// detectors.
//
// The shared `stripCommentsAndStrings` treats `#` as a comment marker on every
// file (blanking `this.#buf…` and `r#"…"#`) and reads Rust lifetimes as string
// openers — constructs these detectors need live. So this module carries its
// own char-scanner; every newline/char position is preserved (blanked with
// spaces), keeping `offsetToLine` and the per-line guard windows stable.

export type StripLang = "js" | "rust";

/** Blank `// …` to end of line; returns the index of the last blanked char. */
function consumeLineComment(chars: string[], start: number): number {
	let i = start;
	while (i < chars.length && chars[i] !== "\n") {
		chars[i] = " ";
		i++;
	}
	return i - 1;
}

/** Star-slash closer at i → -1; (nesting languages) slash-star opener → 1; else 0. */
function blockMarkerDelta(chars: string[], i: number, nested: boolean): number {
	if (chars[i] === "*" && chars[i + 1] === "/") return -1;
	if (nested && chars[i] === "/" && chars[i + 1] === "*") return 1;
	return 0;
}

/**
 * Blank a block comment (newlines kept); returns the closing-char index.
 * Rust block comments NEST (`nested`): an inner comment cannot end the outer.
 */
function consumeBlockComment(chars: string[], start: number, nested = false): number {
	chars[start] = " ";
	if (start + 1 < chars.length) chars[start + 1] = " ";
	let depth = 1;
	for (let i = start + 2; i < chars.length; i++) {
		const delta = blockMarkerDelta(chars, i, nested);
		if (delta !== 0) {
			chars[i] = " ";
			chars[i + 1] = " ";
			depth += delta;
			if (depth === 0) return i + 1;
			i++;
			continue;
		}
		if (chars[i] !== "\n") chars[i] = " ";
	}
	return chars.length - 1;
}

/**
 * Blank a quoted literal's interior from its opening delimiter; keeps the
 * delimiters and handles backslash escapes. `multiline: false` stops at an
 * unterminated end-of-line (JS single-line literals). Returns the index of
 * the last consumed char.
 */
function consumeQuoted(
	chars: string[],
	start: number,
	quote: string,
	multiline: boolean,
): number {
	for (let i = start + 1; i < chars.length; i++) {
		const ch = chars[i];
		if (ch === "\n") {
			if (!multiline) return i - 1;
			continue;
		}
		if (ch === "\\") {
			chars[i] = " ";
			if (i + 1 < chars.length && chars[i + 1] !== "\n") chars[i + 1] = " ";
			i++;
			continue;
		}
		if (ch === quote) return i;
		chars[i] = " ";
	}
	return chars.length - 1;
}

/**
 * Rust `'`: a char literal (`'x'`, `'\n'`) is consumed like a string; a
 * lifetime (`'a`, `'static`) is NOT a string opener — leave it live so the
 * rest of the line survives. Returns the index of the last consumed char.
 */
function consumeRustSingleQuote(chars: string[], start: number): number {
	const next = chars[start + 1];
	if (next === "\\") return consumeQuoted(chars, start, "'", false);
	if (next !== undefined && next !== "'" && chars[start + 2] === "'") {
		chars[start + 1] = " ";
		return start + 2;
	}
	return start;
}

const RAW_STRING_PRECEDER_RE = /[A-Za-z0-9_]/;

/** Count `#` chars immediately after `idx`. */
function countHashesAfter(chars: string[], idx: number): number {
	let n = 0;
	while (chars[idx + 1 + n] === "#") n++;
	return n;
}

/**
 * Rust raw string (`r"…"`, `r#"…"#`, `br##"…"##`): blank the body up to the
 * matching `"##…` closer. Returns the index of the last consumed char, or -1
 * when `start` is not actually a raw-string head (plain identifier, raw
 * identifier like `r#type`, …).
 */
function consumeRustRawString(chars: string[], start: number): number {
	if (start > 0 && RAW_STRING_PRECEDER_RE.test(chars[start - 1] ?? "")) return -1;
	let i = start;
	if (chars[i] === "b") i++;
	if (chars[i] !== "r") return -1;
	i++;
	let hashes = 0;
	while (chars[i] === "#") {
		hashes++;
		i++;
	}
	if (chars[i] !== '"') return -1;
	for (let j = i + 1; j < chars.length; j++) {
		if (chars[j] === '"' && countHashesAfter(chars, j) >= hashes) return j + hashes;
		if (chars[j] !== "\n") chars[j] = " ";
	}
	return chars.length - 1;
}

/** Punctuation that leaves a following `/` in expression (regex) position. */
const REGEX_PRECEDING_PUNCT = new Set("([{,;=:?!&|+-*%^~<>\n");
const REGEX_PRECEDING_KEYWORDS = new Set([
	"return", "typeof", "case", "delete", "void", "in", "of",
	"instanceof", "new", "do", "else", "yield", "await",
]);
const IDENT_CHAR_RE = /[A-Za-z0-9_$]/;

/**
 * A `/` starts a JS regex literal when the previous non-blank char is
 * expression-position punctuation or ends a keyword like `return`; after an
 * identifier / literal / `)` / `]` it reads as division.
 */
function isRegexLiteralStart(chars: string[], slashIdx: number): boolean {
	let j = slashIdx - 1;
	while (j >= 0 && (chars[j] === " " || chars[j] === "\t")) j--;
	if (j < 0) return true;
	if (REGEX_PRECEDING_PUNCT.has(chars[j] ?? "")) return true;
	if (!IDENT_CHAR_RE.test(chars[j] ?? "")) return false;
	let k = j;
	while (k >= 0 && IDENT_CHAR_RE.test(chars[k] ?? "")) k--;
	return REGEX_PRECEDING_KEYWORDS.has(chars.slice(k + 1, j + 1).join(""));
}

/**
 * Blank a JS regex literal's interior (a `"` inside `/^"/` must not open a
 * string; `/` is literal inside a `[…]` class). A regex literal never spans
 * lines — no closer before EOL means division: consume nothing, return -1.
 */
function consumeJsRegexLiteral(chars: string[], start: number): number {
	let inClass = false;
	for (let i = start + 1; i < chars.length; i++) {
		const ch = chars[i];
		if (ch === "\n") return -1;
		if (ch === "\\" && chars[i + 1] !== "\n") {
			i++;
			continue;
		}
		if (ch === "[") inClass = true;
		else if (ch === "]") inClass = false;
		else if (ch === "/" && !inClass) {
			for (let j = start + 1; j < i; j++) chars[j] = " ";
			return i;
		}
	}
	return -1;
}

/** Dispatch a `/` at i: comment or (JS) regex literal. -1 = plain division. */
function consumeSlashConstruct(chars: string[], i: number, lang: StripLang): number {
	if (chars[i + 1] === "/") return consumeLineComment(chars, i);
	if (chars[i + 1] === "*") return consumeBlockComment(chars, i, lang === "rust");
	if (lang === "js" && isRegexLiteralStart(chars, i)) return consumeJsRegexLiteral(chars, i);
	return -1;
}

/**
 * Blank the comment / string / regex construct opening at `i`, if any, and
 * return the index of its last consumed char. Returns `i` unchanged when the
 * char at `i` opens no construct in this language.
 */
function consumeConstructAt(chars: string[], i: number, lang: StripLang): number {
	const ch = chars[i];
	if (ch === "/") {
		const end = consumeSlashConstruct(chars, i, lang);
		return end === -1 ? i : end;
	}
	if (ch === '"') return consumeQuoted(chars, i, '"', lang === "rust");
	if (ch === "`" && lang === "js") return consumeQuoted(chars, i, "`", true);
	if (ch === "'") {
		return lang === "js" ? consumeQuoted(chars, i, "'", false) : consumeRustSingleQuote(chars, i);
	}
	if (lang === "rust" && (ch === "r" || ch === "b")) {
		const end = consumeRustRawString(chars, i);
		return end === -1 ? i : end;
	}
	return i;
}

/**
 * Strip comments and string interiors for the two languages the
 * reinterpret-alignment detectors scan, preserving every newline and char
 * position. Unlike the shared stripper: `#` is never a comment marker (JS
 * private fields and Rust attributes / raw strings stay live), Rust lifetimes
 * are not quote openers, Rust block comments nest, and JS regex literals are
 * consumed as literals.
 */
export function stripForLang(content: string, lang: StripLang): string {
	const chars = content.split("");
	for (let i = 0; i < chars.length; i++) {
		i = consumeConstructAt(chars, i, lang);
	}
	return chars.join("");
}
