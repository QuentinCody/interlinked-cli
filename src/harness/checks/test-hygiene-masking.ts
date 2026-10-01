// interlinked-tdd: exempt
// ===========================================
// Comment/string masking — pure char-level helpers extracted from
// test-hygiene-quality.ts to keep that module under the per-file line cap.
// ===========================================
// These blank out comments and string literals (preserving offsets + newlines)
// so the test-hygiene checks can tell executable code from text. Pure functions
// over a char array — no project imports, no state. Tested end-to-end through
// `checkHappyPathOnlyTest` in test-hygiene.test.ts (the public consumer).

import { nonNull } from "../../lib/non-null.js";
import { maskWithTypeScript } from "./test-hygiene-masking-ast.js";

type MaskMode = "code" | "line-comment" | "block-comment" | "single" | "double" | "template" | "regex" | "regex-class";

/**
 * Token context for the `/` decision: whether the last significant TOKEN was an operand (an identifier, a number,
 * a completed string / template / regex literal, a closing paren or bracket, a postfix `++` / `--`), after which a
 * `/` divides, and the last identifier word, because a keyword operand (`return`, `typeof`, `case`, …) takes an
 * expression, so a `/` after it opens a regex. The last remaining CHARACTER was not enough: `count++ / 2` read as
 * a regex opener and `return /"/` as division (review 2026-09-30).
 */
interface ScanContext {
	afterOperand: boolean;
	word: string;
	inWord: boolean;
	/** One entry per open paren: true when it opened a control header (`if (…)`, `while (…)`), whose `)` is no operand. */
	parens: boolean[];
}
/**
 * One UTF-16 unit of an ECMAScript IdentifierPart: ID_Continue (letters, digits, combining marks — `café`), `$`,
 * ZWNJ/ZWJ, and either half of a surrogate pair (an astral identifier such as `𝒳` scans as two units; a string
 * or comment containing an astral char is already masked before this test runs).
 */
const IDENTIFIER_CHAR = /[\p{ID_Continue}$‌‍\uD800-\uDFFF]/u;
/** Keywords that take an expression, so a `/` after them opens a regex (`of` is omitted: it is a legal identifier). */
const EXPRESSION_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "instanceof", "new", "delete", "void", "throw", "yield", "await"]);
const CONTROL_KEYWORDS = new Set(["if", "while", "for", "switch", "catch", "with"]);

/** Fold one plain code char (already known not to open a comment, string or regex) into the token context. */
function noteCodeChar(context: ScanContext, ch: string, previous: string | undefined): void {
	if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { context.inWord = false; return; }
	if (IDENTIFIER_CHAR.test(ch)) {
		context.word = context.inWord ? context.word + ch : ch;
		context.inWord = true;
		context.afterOperand = true;
		return;
	}
	if (ch === ".") return;
	// A postfix non-null assertion keeps its operand; a prefix `!` follows an operator, where the context is already false.
	if (ch === "!") { context.inWord = false; context.word = ""; return; }
	const operand = punctuationEndsOperand(context, ch, previous);
	context.inWord = false;
	context.word = "";
	context.afterOperand = operand;
}

/** Whether a punctuation char completes an operand: `]`, a postfix `++`/`--`, or a `)` that does not close a control header. */
function punctuationEndsOperand(context: ScanContext, ch: string, previous: string | undefined): boolean {
	if (ch === "(") {
		context.parens.push(CONTROL_KEYWORDS.has(context.word));
		return false;
	}
	if (ch === ")") return !(context.parens.pop() ?? false);
	return ch === "]" || ((ch === "+" || ch === "-") && previous === ch);
}

/** A `/` divides after an operand token; a keyword operand still takes an expression, so its `/` opens a regex. */
function slashOpensRegex(context: ScanContext): boolean {
	if (context.word) return EXPRESSION_KEYWORDS.has(context.word);
	return !context.afterOperand;
}

/** A completed string, template or regex literal is an operand token. */
function noteLiteralClosed(context: ScanContext): void {
	context.afterOperand = true;
	context.word = "";
	context.inWord = false;
}

/**
 * Inside a regex literal: blank the char, honour a backslash escape, keep `/` inside a character class from
 * closing the literal, close on the bare `/`. A quote inside a regex is NOT a string opener — before this mode
 * existed, `/"/` opened a string that swallowed the rest of the file, hiding a real import (review 2026-09-30).
 * A newline ends the literal defensively (a regex literal cannot span lines).
 */
function maskRegexChar(chars: string[], i: number, ch: string, next: string | undefined, mode: MaskMode): MaskStep {
	if (ch === "\n") return { mode: "code", advanced: false };
	chars[i] = " ";
	if (ch === "\\") {
		if (next === undefined || next === "\n") return { mode, advanced: false };
		chars[i + 1] = " ";
		return { mode, advanced: true };
	}
	if (mode === "regex-class") return { mode: ch === "]" ? "regex" : "regex-class", advanced: false };
	if (ch === "[") return { mode: "regex-class", advanced: false };
	return { mode: ch === "/" ? "code" : "regex", advanced: false };
}

/** One scan step's outcome: the mode for the next char, and whether a lookahead
 *  char was already consumed (so the caller advances its index by one more). */
interface MaskStep {
	mode: MaskMode;
	advanced: boolean;
}

/** Inside `// …`: blank everything until the newline, which ends the comment
 *  (the newline itself stays, preserving offsets and line counts). */
function maskLineCommentChar(chars: string[], i: number, ch: string): MaskStep {
	if (ch === "\n") return { mode: "code", advanced: false };
	chars[i] = " ";
	return { mode: "line-comment", advanced: false };
}

/** Inside a block comment: blank the char (keeping newlines); on the closing
 *  `*​/` blank both chars and return to code. `ch` is the original char at `i`. */
function maskBlockCommentChar(chars: string[], i: number, ch: string, next: string | undefined): MaskStep {
	chars[i] = ch === "\n" ? "\n" : " ";
	if (ch === "*" && next === "/") {
		chars[i + 1] = " ";
		return { mode: "code", advanced: true };
	}
	return { mode: "block-comment", advanced: false };
}

/** True when `ch` closes the currently-open string literal of `mode`. */
function closesStringMode(mode: MaskMode, ch: string): boolean {
	if (mode === "single") return ch === "'";
	if (mode === "double") return ch === '"';
	return mode === "template" && ch === "`";
}

/** Inside a string literal: blank the char, honour a backslash escape (blank the
 *  escaped char too), and close on the matching quote. `mode` is a string mode. */
function maskStringChar(
	chars: string[],
	i: number,
	ch: string,
	next: string | undefined,
	mode: MaskMode,
): MaskStep {
	chars[i] = ch === "\n" ? "\n" : " ";
	if (ch === "\\") {
		if (next === undefined) return { mode, advanced: false };
		chars[i + 1] = next === "\n" ? "\n" : " ";
		return { mode, advanced: true };
	}
	if (closesStringMode(mode, ch)) return { mode: "code", advanced: false };
	return { mode, advanced: false };
}

/** A `/` in code mode: division after an operand token (left untouched), otherwise the opener of a regex literal. */
function enterRegexFromCode(chars: string[], i: number, context: ScanContext): MaskStep {
	if (!slashOpensRegex(context)) {
		noteCodeChar(context, "/", undefined);
		return { mode: "code", advanced: false };
	}
	chars[i] = " ";
	return { mode: "regex", advanced: false };
}

/** In code mode: detect the start of a comment, string or regex literal, blanking its
 *  opener and returning the new mode. Plain code chars are left untouched. */
function enterModeFromCode(
	chars: string[],
	i: number,
	ch: string,
	next: string | undefined,
	context: ScanContext,
): MaskStep {
	if (ch === "/" && (next === "/" || next === "*")) {
		chars[i] = " ";
		chars[i + 1] = " ";
		// A comment separates tokens (`return/*c*/typeof`) without ending the operand context before it.
		context.inWord = false;
		return { mode: next === "/" ? "line-comment" : "block-comment", advanced: true };
	}
	if (ch === "'" || ch === '"' || ch === "`") {
		chars[i] = " ";
		const opened: MaskMode = ch === "'" ? "single" : ch === '"' ? "double" : "template";
		return { mode: opened, advanced: false };
	}
	if (ch === "/") return enterRegexFromCode(chars, i, context);
	noteCodeChar(context, ch, chars[i - 1]);
	return { mode: "code", advanced: false };
}

/** Dispatch one character to the handler for the current `mode`. */
function maskStep(
	chars: string[],
	i: number,
	ch: string,
	next: string | undefined,
	mode: MaskMode,
	context: ScanContext,
): MaskStep {
	if (mode === "line-comment") return maskLineCommentChar(chars, i, ch);
	if (mode === "block-comment") return maskBlockCommentChar(chars, i, ch, next);
	if (mode === "single" || mode === "double" || mode === "template") {
		return maskStringChar(chars, i, ch, next, mode);
	}
	if (mode === "regex" || mode === "regex-class") return maskRegexChar(chars, i, ch, next, mode);
	return enterModeFromCode(chars, i, ch, next, context);
}

/** A literal mode (string, template, regex) that just returned to code completed an operand token. */
function literalClosed(previous: MaskMode, next: MaskMode): boolean {
	return next === "code" && previous !== "code" && previous !== "line-comment" && previous !== "block-comment";
}

/** Blank every comment, string, template chunk, regex literal (and JSX text) in `content`, preserving length,
 *  newlines, and byte offsets so a match index can be tested against code. The TypeScript parser decides the
 *  tokens when it is installed (`filePath` picks the script kind — pass the real path for `.tsx` / `.jsx`);
 *  the char-level heuristic below is the fallback. */
export function maskCommentsAndStrings(content: string, filePath = "masked.ts"): string {
	return maskWithTypeScript(content, filePath) ?? maskCommentsAndStringsHeuristic(content);
}

/**
 * The parser-free fallback (an install without the optional `typescript`): a char-level state machine with a
 * token-context heuristic for `/`. It cannot see JSX, so a `.tsx` closing tag reads as a regex opener there.
 */
export function maskCommentsAndStringsHeuristic(content: string): string {
	const chars = content.split("");
	let mode: MaskMode = "code";
	const context: ScanContext = { afterOperand: false, word: "", inWord: false, parens: [] };
	for (let i = 0; i < chars.length; i++) {
		const step = maskStep(chars, i, nonNull(chars[i]), chars[i + 1], mode, context);
		if (literalClosed(mode, step.mode)) noteLiteralClosed(context);
		mode = step.mode;
		if (step.advanced) i++;
	}
	return chars.join("");
}

/** True when the char at `offset` in masked content is real code (non-blank). */
export function isCodeMatch(maskedContent: string, offset: number): boolean {
	return /\S/.test(maskedContent[offset] ?? "");
}

/** True when a `describe`/`it`/`test` call text is a `.skip`/`.todo` variant. */
export function isSkippedOrTodoCall(matchText: string): boolean {
	const head = matchText.slice(0, Math.max(0, matchText.indexOf("(")));
	return /\.(?:skip|todo)\b/.test(head);
}

/** Blank `chars[start..end)` in place, preserving newlines. */
export function blankRange(chars: string[], start: number, end: number): void {
	for (let i = start; i < Math.min(end, chars.length); i++) {
		chars[i] = chars[i] === "\n" ? "\n" : " ";
	}
}
