// Placeholder runtime constant — the comment confesses, nothing reads it.
//
// Bug class: a numeric constant is checked in as a temporary stand-in and the
// author SAYS SO in the comment ("stand-in until Phase B", "hardcoded for
// now", "interim until we profile") — then it ships anyway. Bun #31503 is the
// motivating example:
//
//     /// nonzero stand-in until Phase B
//     pub const BSS_OVERFLOW_BLOCK_SIZE: usize = 64;
//
// That stand-in lowered an interning ceiling from 8.4M to 270k and made a
// ptrs[4095] off-by-one reachable. The confession was right there in the doc
// comment; no tool read it.
//
// Fires only when BOTH hold:
//   1. A NUMERIC constant declaration — JS/TS `(export) const NAME = <num>`,
//      Rust `(pub) const|static NAME: T = <num>`, Python module-scope
//      ALL_CAPS `NAME = <num>`, Go `const Name = <num>`. Numeric covers ints,
//      floats, 0x…, 1_000, and negatives. String constants never fire — UI
//      placeholder text (`const PLACEHOLDER_TEXT = "Enter name"`) is fine.
//   2. The declaration line, or a comment in the 3 lines directly above it
//      (walking only through blank / comment-only / Rust-attribute lines),
//      carries a temporariness confession. A bare TODO/FIXME does NOT count:
//      "TODO: document this" confesses about docs, not the value.
//
// Declarations are detected on comment+string-stripped lines. Stripping is a
// single-pass linear scanner that carries block-comment and multi-line string
// state across lines (no backtracking regex — pathological inputs stay O(n)),
// so a commented-out declaration or one quoted inside a template literal
// never fires. The confession is matched against ORIGINAL comment text —
// including unstarred block-comment interior lines — and CRLF files are
// normalized per line so dollar-anchored patterns see the real line end.
//
// Check id: placeholder_runtime_constant

import {
	getExtension,
	type InlineMatch,
	isGeneratedFile,
	isTestFile,
	isVendoredOrFixturePath,
	JS_TS_ALL_EXTS,
} from "./shared.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;
/** How many lines directly above the declaration may carry the confession. */
const LOOKBACK_LINES = 3;

const MESSAGE =
	"placeholder_runtime_constant: comment confesses this numeric constant is a temporary stand-in — replace it with the real value (or wire it) before shipping";

// ─── Confession pattern ───────────────────────────────────────────────────────

/**
 * Temporariness confessions. Deliberately does NOT include bare todo/fixme —
 * "TODO: document this" above a constant confesses about docs, not the value.
 */
const CONFESSION_RE =
	/\b(?:stand[-\s]?in|provisional|interim|temporar(?:y|ily)|for\s+now|until\s+(?:we|the|phase\b|[A-Z])|to\s+be\s+(?:replaced|threaded|wired|computed)|hardcod(?:ed?|ing)\s+for\s+now|nonzero\s+(?:stub|stand))\b/i;

// ─── Declaration patterns ─────────────────────────────────────────────────────

/** Numeric literal: int / float / 0x… / 1_000 / negative / 1e6. Bounded windows. */
const NUM_SRC = String.raw`-?(?:0[xX][0-9a-fA-F][0-9a-fA-F_]{0,30}|\d[\d_]{0,30}(?:\.\d[\d_]{0,30})?(?:[eE][+-]?\d{1,4})?)`;

/** JS/TS: `(export) const NAME(: T)? = <num>;` — applied per stripped line. */
const JS_DECL_RE = new RegExp(
	String.raw`^\s{0,40}(?:export\s+)?const\s+[A-Za-z_$][\w$]{0,60}\s*(?::[^=\n]{0,60})?=\s*${NUM_SRC}\s*[;,]?\s*$`,
);

/** Rust: `(pub) const|static (mut) NAME: T = <num><suffix>?;` */
const RUST_DECL_RE = new RegExp(
	String.raw`^\s{0,40}(?:pub(?:\s*\([^)]{0,20}\))?\s+)?(?:const|static)\s+(?:mut\s+)?[A-Za-z_]\w{0,60}\s*:\s*[^=\n]{1,60}=\s*${NUM_SRC}(?:_?(?:[iu](?:8|16|32|64|128|size)|f32|f64))?\s*;?\s*$`,
);

/** Go: `const Name( Type)? = <num>` — single-declaration form only. */
const GO_DECL_RE = new RegExp(
	String.raw`^\s{0,40}const\s+[A-Za-z_]\w{0,60}(?:\s+[A-Za-z_][\w.]{0,30})?\s*=\s*${NUM_SRC}\s*;?\s*$`,
);

/** Python: module-scope (column 0) ALL_CAPS `NAME(: T)? = <num>` — raw line. */
const PY_DECL_RE = new RegExp(
	String.raw`^[A-Z][A-Z0-9_]{0,60}\s*(?::\s*[^=\n#]{1,40})?=\s*${NUM_SRC}\s*(?:#.*)?$`,
);

type Lang = "jslike" | "rust" | "python" | "go";

const DECL_RES: Record<Exclude<Lang, "python">, RegExp> = {
	jslike: JS_DECL_RE,
	rust: RUST_DECL_RE,
	go: GO_DECL_RE,
};

function resolveLanguage(ext: string): Lang | null {
	if (JS_TS_ALL_EXTS.includes(ext)) return "jslike";
	if (ext === ".rs") return "rust";
	if (ext === ".py") return "python";
	if (ext === ".go") return "go";
	return null;
}

// ─── C-family line scanner (jslike / rust / go) ───────────────────────────────
//
// One linear pass per file. Comments and string interiors are blanked out of
// the `code` view (delimiters kept) while every comment segment — a line
// comment's rest-of-line, a same-line block comment, and EVERY interior line
// of a multi-line block comment, starred or not — is captured as `comment`
// text for confession matching. Block-comment and multi-line-string state
// carries across lines, so an unstarred block-comment interior is a comment
// and a star-leading deref/continuation code line is NOT. Hand-rolled char
// walk, no backtracking regex: pathological inputs (an unterminated string of
// thousands of escaped quotes) stay linear.

type CLang = Exclude<Lang, "python">;

interface ScannedLine {
	/** Line with comments blanked and string interiors blanked (delimiters kept). */
	code: string;
	/** Comment text carried by this line (markers included), or null. */
	comment: string | null;
}

interface LineScanState {
	inBlockComment: boolean;
	/** Open multi-line string delimiter (backtick in JS/TS and Go), or null. */
	stringDelim: string | null;
}

/** Quote characters that open a string literal, per language. */
const LANG_QUOTES: Record<CLang, string> = {
	jslike: "\"'`",
	rust: '"', // `'` is handled as a char literal / lifetime, not a quote
	go: "\"'`",
};

/** Delimiters whose strings may span lines. */
const MULTILINE_QUOTES: Record<CLang, string> = { jslike: "`", rust: "", go: "`" };

/** Go raw strings (backtick) have no escapes; every other literal does. */
function stringAllowsEscapes(lang: CLang, delim: string): boolean {
	return !(lang === "go" && delim === "`");
}

function blankRange(code: string[], from: number, to: number): void {
	for (let k = from; k < to; k++) code[k] = " ";
}

/**
 * Consume a block comment from `start` (at the opener, or line start when the
 * state was carried in). Returns the index just past the closing marker, or
 * line end when the comment stays open (state.inBlockComment remains true).
 */
function consumeBlockComment(
	rawLine: string,
	code: string[],
	comments: string[],
	start: number,
	state: LineScanState,
): number {
	const searchFrom = state.inBlockComment ? start : start + 2;
	const end = rawLine.indexOf("*/", searchFrom);
	if (end === -1) {
		comments.push(rawLine.slice(start));
		blankRange(code, start, rawLine.length);
		state.inBlockComment = true;
		return rawLine.length;
	}
	comments.push(rawLine.slice(start, end + 2));
	blankRange(code, start, end + 2);
	state.inBlockComment = false;
	return end + 2;
}

/**
 * Consume a string literal from its opening quote at `start`. Interior chars
 * are blanked, delimiters kept. An unterminated multi-line-capable literal
 * (backtick) carries state to the next line; other quotes reset at EOL.
 */
function consumeStringLiteral(
	rawLine: string,
	code: string[],
	start: number,
	lang: CLang,
	state: LineScanState,
): number {
	const delim = rawLine.charAt(start);
	const escapes = stringAllowsEscapes(lang, delim);
	let j = start + 1;
	while (j < rawLine.length) {
		const ch = rawLine.charAt(j);
		if (escapes && ch === "\\") {
			j += 2;
			continue;
		}
		if (ch === delim) {
			blankRange(code, start + 1, j);
			return j + 1;
		}
		j++;
	}
	blankRange(code, start + 1, rawLine.length);
	if (MULTILINE_QUOTES[lang].includes(delim)) state.stringDelim = delim;
	return rawLine.length;
}

/** Line begins inside a multi-line string: blank up to its close (or EOL). */
function resumeMultilineString(
	rawLine: string,
	code: string[],
	lang: CLang,
	state: LineScanState,
): number {
	const delim = state.stringDelim ?? "";
	const escapes = stringAllowsEscapes(lang, delim);
	let j = 0;
	while (j < rawLine.length) {
		const ch = rawLine.charAt(j);
		if (escapes && ch === "\\") {
			j += 2;
			continue;
		}
		if (ch === delim) {
			blankRange(code, 0, j);
			state.stringDelim = null;
			return j + 1;
		}
		j++;
	}
	blankRange(code, 0, rawLine.length);
	return rawLine.length;
}

/** A Rust char literal closes within this many chars of its opening quote. */
const RUST_CHAR_LOOKAHEAD = 3;

/**
 * Rust `'` opens a char literal only when it closes within the lookahead
 * (`'a'`, escaped newline); a lifetime (`'static`) never does — leave it as
 * plain code so it neither opens a string nor swallows the rest of the line.
 */
function skipRustCharLiteral(rawLine: string, code: string[], start: number): number {
	const limit = Math.min(start + RUST_CHAR_LOOKAHEAD, rawLine.length - 1);
	for (let j = start + 2; j <= limit; j++) {
		if (rawLine.charAt(j) === "'") {
			blankRange(code, start + 1, j);
			return j + 1;
		}
	}
	return start + 1;
}

/**
 * Advance the scan past one character: dispatches to line-comment start,
 * block-comment start, string-literal start, or Rust char-literal start.
 * Returns the next scan index and whether a `//` comment ended the line.
 */
function advanceCodeScan(
	rawLine: string,
	code: string[],
	i: number,
	lang: CLang,
	state: LineScanState,
	comments: string[],
): { next: number; stop: boolean } {
	const ch = rawLine.charAt(i);
	if (ch === "/") {
		const next = rawLine.charAt(i + 1);
		if (next === "/") {
			comments.push(rawLine.slice(i));
			blankRange(code, i, rawLine.length);
			return { next: rawLine.length, stop: true };
		}
		if (next === "*") {
			return { next: consumeBlockComment(rawLine, code, comments, i, state), stop: false };
		}
		return { next: i + 1, stop: false };
	}
	if (LANG_QUOTES[lang].includes(ch)) {
		return { next: consumeStringLiteral(rawLine, code, i, lang, state), stop: false };
	}
	if (lang === "rust" && ch === "'") {
		return { next: skipRustCharLiteral(rawLine, code, i), stop: false };
	}
	return { next: i + 1, stop: false };
}

/** Scan one line: blank comments/strings from code, collect comment text. */
function scanCodeLine(rawLine: string, lang: CLang, state: LineScanState): ScannedLine {
	const code = rawLine.split("");
	const comments: string[] = [];
	let i = 0;
	if (state.stringDelim !== null) i = resumeMultilineString(rawLine, code, lang, state);
	if (state.inBlockComment) i = consumeBlockComment(rawLine, code, comments, i, state);
	while (i < rawLine.length && !state.inBlockComment && state.stringDelim === null) {
		const result = advanceCodeScan(rawLine, code, i, lang, state, comments);
		i = result.next;
		if (result.stop) break;
	}
	return { code: code.join(""), comment: comments.length > 0 ? comments.join(" ") : null };
}

// ─── Confession lookup (comment text on ORIGINAL lines) ──────────────────────

const PY_QUOTE_CHARS = "\"'";

/** Index where a `#` comment starts outside string quotes, or -1. */
function findCommentStartPython(line: string): number {
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line.charAt(i);
		if (quote !== null) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (PY_QUOTE_CHARS.includes(ch)) {
			quote = ch;
			continue;
		}
		if (ch === "#") return i;
	}
	return -1;
}

interface LineInfo {
	/** Comment text carried by the line (marker included), or null. */
	comment: string | null;
	/** True when the upward walk may continue through this line: blank,
	 *  comment-only, or a Rust attribute between doc comment and item. */
	transparent: boolean;
}

function pythonLineInfo(rawLine: string): LineInfo {
	if (rawLine.trim() === "") return { comment: null, transparent: true };
	const idx = findCommentStartPython(rawLine);
	if (idx === -1) return { comment: null, transparent: false };
	return { comment: rawLine.slice(idx), transparent: rawLine.slice(0, idx).trim() === "" };
}

function clikeLineInfo(scanned: ScannedLine, lang: CLang): LineInfo {
	const codeText = scanned.code.trim();
	// Rust attributes (`#[...]` / `#![...]`) sit between doc comments and the
	// item — transparent to the walk.
	if (lang === "rust" && codeText.startsWith("#")) {
		return { comment: scanned.comment, transparent: true };
	}
	return { comment: scanned.comment, transparent: codeText === "" };
}

function infoConfesses(info: LineInfo | undefined): boolean {
	return info !== undefined && info.comment !== null && CONFESSION_RE.test(info.comment);
}

/**
 * True when the declaration line itself, or a comment within LOOKBACK_LINES
 * directly above it, carries a confession. The upward walk continues through
 * blank and comment-only lines and STOPS at the first code line — a matching
 * comment attached to unrelated code above must not implicate this constant.
 */
function hasConfessionNearby(infos: LineInfo[], declIdx: number): boolean {
	if (infoConfesses(infos[declIdx])) return true;
	for (let k = 1; k <= LOOKBACK_LINES; k++) {
		const info = infos[declIdx - k];
		if (info === undefined) return false;
		if (infoConfesses(info)) return true;
		if (!info.transparent) return false;
	}
	return false;
}

// ─── Declaration scanning ─────────────────────────────────────────────────────

/** Delimiter (`"""` or `'''`) left open by this line, or null. */
function findTripleOpen(line: string): string | null {
	const hashIdx = findCommentStartPython(line);
	const code = hashIdx === -1 ? line : line.slice(0, hashIdx);
	for (const delim of ['"""', "'''"]) {
		let count = 0;
		let idx = code.indexOf(delim);
		while (idx !== -1) {
			count++;
			idx = code.indexOf(delim, idx + 3);
		}
		if (count % 2 === 1) return delim;
	}
	return null;
}

/**
 * Python declarations on raw lines (a `#`-commented line can't match the
 * column-0 ALL_CAPS anchor), skipping multi-line docstring interiors so a
 * docstring quoting `NAME = 64` never registers as a declaration.
 */
function findPythonDeclarationLines(rawLines: string[]): number[] {
	const out: number[] = [];
	let openDelim: string | null = null;
	for (let i = 0; i < rawLines.length; i++) {
		const line = rawLines[i] ?? "";
		if (openDelim !== null) {
			if (line.includes(openDelim)) openDelim = null;
			continue;
		}
		if (PY_DECL_RE.test(line)) out.push(i);
		else openDelim = findTripleOpen(line);
	}
	return out;
}

/** Split into lines, dropping one trailing CR per line so CRLF files behave
 *  exactly like LF files (dollar-anchored decl patterns must see the real
 *  line end). Line indices are unchanged. */
function splitLines(content: string): string[] {
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.endsWith("\r")) lines[i] = line.slice(0, -1);
	}
	return lines;
}

/**
 * Declaration line indices (0-based) + per-line comment info, in one pass.
 * C-family languages run the stateful line scanner (commented-out or quoted
 * declarations are blanked out of the `code` view); Python keeps its raw-line
 * path (column-0 anchor + docstring skipping).
 */
function analyzeLines(
	rawLines: string[],
	lang: Lang,
): { declLines: number[]; infos: LineInfo[] } {
	if (lang === "python") {
		return {
			declLines: findPythonDeclarationLines(rawLines),
			infos: rawLines.map(pythonLineInfo),
		};
	}
	const state: LineScanState = { inBlockComment: false, stringDelim: null };
	const re = DECL_RES[lang];
	const declLines: number[] = [];
	const infos: LineInfo[] = [];
	for (let i = 0; i < rawLines.length; i++) {
		const scanned = scanCodeLine(rawLines[i] ?? "", lang, state);
		if (re.test(scanned.code)) declLines.push(i);
		infos.push(clikeLineInfo(scanned, lang));
	}
	return { declLines, infos };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect numeric placeholder constants whose own comment confesses they are
 * temporary (stand-in / provisional / interim / "for now" / "until …" /
 * "to be replaced" …) — the Bun #31503 bug class.
 *
 * Check id: `placeholder_runtime_constant`
 *
 * Fires on JS/TS, Rust, Python, and Go sources; skips test files, vendored /
 * fixture trees, and generated files. Returns up to 10 `InlineMatch` findings
 * per file, each anchored to the declaration line.
 */
export function checkPlaceholderRuntimeConstant(
	content: string,
	filePath: string,
): InlineMatch[] {
	const lang = resolveLanguage(getExtension(filePath));
	if (lang === null) return [];
	if (isTestFile(filePath) || isVendoredOrFixturePath(filePath)) return [];
	if (isGeneratedFile(content)) return [];

	const rawLines = splitLines(content);
	const { declLines, infos } = analyzeLines(rawLines, lang);
	const matches: InlineMatch[] = [];
	for (const declIdx of declLines) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		if (!hasConfessionNearby(infos, declIdx)) continue;
		const rawText = (rawLines[declIdx] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
		matches.push({ line: declIdx + 1, text: `${MESSAGE} — ${rawText}` });
	}
	return matches;
}
