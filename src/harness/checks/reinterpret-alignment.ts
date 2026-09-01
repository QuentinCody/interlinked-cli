// Byte buffer reinterpreted as a wider element type without proving
// length/alignment first.
//
// Bug class (Bun #31188): `Blob.text()` on UTF-16 BOM + odd byte count
// panicked — Rust's `bytemuck::cast_slice` panics when
// `len % size_of::<T>() != 0` (or the pointer is misaligned); the fix masked
// the length first (`&buf[..buf.len() & !1]`). Same class in JS/TS:
// `new Uint16Array(buffer)` throws when `byteLength % BYTES_PER_ELEMENT != 0`.
//
// Two detectors (each exported function's JSDoc carries the full contract):
// `ubs_rust_unchecked_cast_slice` (.rs) and `unaligned_reinterpret` (JS/TS).

import {
	getExtension,
	type InlineMatch,
	isGeneratedFile,
	isTestFile,
	isVendoredOrFixturePath,
	JS_TS_ALL_EXTS,
} from "./shared.js";
// Shared offset→line helper (1-based; the comment/string stripper preserves
// line count, so it is valid over stripped text). Direct in-package import —
// shared.ts sits at its line cap and cannot carry another re-export line.
import { offsetToLine } from "./shared-text-utils.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;
/** Guard lookback for the Rust detector: same line + 5 lines above. */
const RUST_GUARD_LOOKBACK_LINES = 5;
/** Guard lookback for the JS/TS detector: same line + 40 lines above. */
const JS_GUARD_LOOKBACK_LINES = 40;

// ─── Language-aware comment/string stripping ──────────────────────────────────
//
// The shared `stripCommentsAndStrings` treats `#` as a comment marker on every
// file (blanking `this.#buf…` and `r#"…"#`) and reads Rust lifetimes as string
// openers — constructs these detectors need live. So this module carries its
// own char-scanner; every newline/char position is preserved (blanked with
// spaces), keeping `offsetToLine` and the per-line guard windows stable.

type StripLang = "js" | "rust";

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
 * Strip comments and string interiors for the two languages this module
 * scans, preserving every newline and char position. Unlike the shared
 * stripper: `#` is never a comment marker (JS private fields and Rust
 * attributes / raw strings stay live), Rust lifetimes are not quote openers,
 * Rust block comments nest, and JS regex literals are consumed as literals.
 */
function stripForLang(content: string, lang: StripLang): string {
	const chars = content.split("");
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		if (ch === "/") {
			const end = consumeSlashConstruct(chars, i, lang);
			if (end !== -1) i = end;
		} else if (ch === '"') {
			i = consumeQuoted(chars, i, '"', lang === "rust");
		} else if (ch === "`" && lang === "js") {
			i = consumeQuoted(chars, i, "`", true);
		} else if (ch === "'") {
			i = lang === "js" ? consumeQuoted(chars, i, "'", false) : consumeRustSingleQuote(chars, i);
		} else if (lang === "rust" && (ch === "r" || ch === "b")) {
			const end = consumeRustRawString(chars, i);
			if (end !== -1) i = end;
		}
	}
	return chars.join("");
}

// ─── Shared scaffolding ───────────────────────────────────────────────────────

interface ScanCtx {
	stripped: string;
	strippedLines: string[];
	rawLines: string[];
	matches: InlineMatch[];
	seen: Set<number>;
}

function buildCtx(content: string, lang: StripLang): ScanCtx {
	const stripped = stripForLang(content, lang);
	return {
		stripped,
		strippedLines: stripped.split("\n"),
		rawLines: content.split("\n"),
		matches: [],
		seen: new Set<number>(),
	};
}

/** Test files, vendored/fixture trees, and generator output never fire. */
function isExemptFile(filePath: string, content: string): boolean {
	return (
		isTestFile(filePath) || isVendoredOrFixturePath(filePath) || isGeneratedFile(content)
	);
}

/**
 * True when a guard pattern appears on the flagged line or within
 * `lookback` lines above it (window scanned in the stripped source).
 */
function hasGuardWithin(
	strippedLines: string[],
	lineNo: number,
	lookback: number,
	guardRe: RegExp,
): boolean {
	const start = Math.max(0, lineNo - 1 - lookback);
	return guardRe.test(strippedLines.slice(start, lineNo).join("\n"));
}

/** Record one finding, deduped per line, text = "<id>: <msg> — <raw line>". */
function record(ctx: ScanCtx, lineNo: number, message: string): void {
	if (ctx.seen.has(lineNo)) return;
	ctx.seen.add(lineNo);
	const rawText = (ctx.rawLines[lineNo - 1] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
	ctx.matches.push({ line: lineNo, text: `${message} — ${rawText}` });
}

// ─── Rust: ubs_rust_unchecked_cast_slice ──────────────────────────────────────

const RUST_MESSAGE =
	"ubs_rust_unchecked_cast_slice: byte slice reinterpreted as wider elements without a length/alignment proof (cast_slice panics on odd lengths; mask with `buf.len() & !1` or iterate chunks_exact + from_le_bytes)";

/** `bytemuck::cast_slice(...)` / `cast_slice::<A, B>(...)` — turbofish captured. */
const RUST_CAST_SLICE_RE = /\bcast_slice(?:::<([^>]*)>)?\s*\(/g;

/**
 * `from_raw_parts(<ptr> as *const <wide-numeric>, …)`. The pointer expression
 * admits one paren level (`buf.as_ptr()` — the idiomatic form) and is
 * unbounded per spec (negated char classes are linear — no ReDoS surface).
 */
const RUST_WIDE_RAW_PARTS_RE =
	/\bfrom_raw_parts\s*\((?:[^)(]|\([^)]*\))*\bas\s+\*const\s+(?:u16|u32|u64|i16|i32|i64|f32|f64)\b/g;

/** `transmute::<&[u8], …>` — reinterpreting a byte slice via transmute. */
const RUST_TRANSMUTE_BYTES_RE = /\btransmute::<\s*&\[u8\]/g;

/** Length/alignment proofs that make a nearby reinterpret legitimate. */
const RUST_GUARD_RE =
	/%\s*size_of|%\s*2|&\s*!1|&\s*!\(|chunks_exact|array_chunks|try_from|from_le_bytes|from_be_bytes|len\(\)\s*%/;

/**
 * `cast_slice::<A, B>` where the TARGET element is 1 byte wide (`u8` / `i8`)
 * can never hit the length/alignment panic — skip it.
 */
function reinterpretsToSingleByte(turbofish: string | undefined): boolean {
	if (turbofish === undefined) return false;
	const parts = turbofish.split(",");
	const target = (parts[parts.length - 1] ?? "").trim();
	return /^[ui]8$/.test(target);
}

interface RustPattern {
	re: RegExp;
	skipMatch?: (m: RegExpMatchArray) => boolean;
}

const RUST_PATTERNS: readonly RustPattern[] = [
	{ re: RUST_CAST_SLICE_RE, skipMatch: (m) => reinterpretsToSingleByte(m[1]) },
	{ re: RUST_WIDE_RAW_PARTS_RE },
	{ re: RUST_TRANSMUTE_BYTES_RE },
];

function scanRustReinterprets(ctx: ScanCtx): void {
	for (const pattern of RUST_PATTERNS) {
		const re = new RegExp(pattern.re.source, "g");
		for (const m of ctx.stripped.matchAll(re)) {
			if (ctx.matches.length >= MAX_MATCHES_PER_FILE) return;
			if (pattern.skipMatch?.(m) === true) continue;
			const lineNo = offsetToLine(ctx.stripped, m.index);
			if (hasGuardWithin(ctx.strippedLines, lineNo, RUST_GUARD_LOOKBACK_LINES, RUST_GUARD_RE)) {
				continue;
			}
			record(ctx, lineNo, RUST_MESSAGE);
		}
	}
}

/**
 * Detect Rust byte-buffer reinterpretation with no length/alignment proof.
 *
 * Check id: `ubs_rust_unchecked_cast_slice`
 *
 * Fires on `bytemuck::cast_slice` (incl. turbofish forms), `from_raw_parts`
 * with a widening `as *const <numeric>` cast, and `transmute::<&[u8], …>` —
 * unless a proof (`% size_of`, `% 2`, `& !1`, `chunks_exact`, `array_chunks`,
 * `try_from`, `from_le_bytes` / `from_be_bytes`, `len() %`) appears on the
 * same line or within the 5 lines above. Only fires on `.rs` source files;
 * test / vendored / generated files are exempt. Up to 10 findings per file.
 */
export function checkRustUncheckedCastSlice(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (getExtension(filePath) !== ".rs") return [];
	if (isExemptFile(filePath, content)) return [];
	const ctx = buildCtx(content, "rust");
	scanRustReinterprets(ctx);
	return ctx.matches;
}

// ─── JS/TS: unaligned_reinterpret ─────────────────────────────────────────────

const JS_MESSAGE =
	"unaligned_reinterpret: byte buffer reinterpreted as a wider typed view without a byteLength/alignment guard (throws RangeError when byteLength % BYTES_PER_ELEMENT != 0); check the length or copy via `.set`";

/** Wider-than-byte typed-array views + DataView; match ends at the open paren. */
const WIDE_VIEW_CTOR_RE =
	/\bnew\s+(?:Uint16Array|Int16Array|Uint32Array|Int32Array|Float32Array|Float64Array|BigInt64Array|BigUint64Array|DataView)\s*\(/g;

// Guards; a fresh `new (Shared)ArrayBuffer(<lit>)` counts (literal byteLength known).
const JS_ALIGNMENT_GUARD_RE =
	/\.byteLength\s*%|\.length\s*%|&\s*~|BYTES_PER_ELEMENT|new\s+(?:Shared)?ArrayBuffer\s*\(\s*\d/;

/** Whole-argument identifiers that read as "this is a byte buffer". */
const BYTE_BUFFER_IDENT_RE = /^(?:buf|buffer|bytes|raw|data|chunk)s?$/i;

/** Calls that produce arbitrary-length byte runs inside the argument. */
const BYTE_SOURCE_CALL_RE = /\.slice\s*\(|\.subarray\s*\(|\breadFileSync\s*\(/;

/**
 * Track `<…>` type-argument depth so a comma inside `foo<A, B>(x)` is not
 * read as an argument separator. A `<` counts only when it hugs an
 * identifier tail, so a spaced comparison stays at depth 0 and a ternary
 * first argument still ends at its comma — over-extension is NOT harmless
 * (it flips end-anchored signals to misses). Operator forms are ignored; an
 * unspaced comparison can still over-extend, an accepted residual risk.
 */
function nextAngleDepth(angleDepth: number, s: string, i: number): number {
	const ch = s.charAt(i);
	if (ch === "<" && s.charAt(i + 1) !== "=" && IDENT_CHAR_RE.test(s.charAt(i - 1))) {
		return angleDepth + 1;
	}
	if (ch === ">" && s.charAt(i + 1) !== "=" && s.charAt(i - 1) !== "=") {
		return Math.max(0, angleDepth - 1);
	}
	return angleDepth;
}

/** Anti-quadratic bound on the per-constructor first-argument scan (chars). */
const MAX_FIRST_ARG_SCAN = 2000;

/**
 * Extract the constructor's first top-level argument starting after the open
 * paren. The scan is bounded at MAX_FIRST_ARG_SCAN chars — far above any
 * realistic argument (comment padding and long index expressions still
 * extract) while keeping a flood of never-closing constructors linear
 * instead of quadratic. Returns null when the argument never closes within
 * the bound (conservative: caller does not fire).
 */
function extractFirstArg(stripped: string, openParenIdx: number): string | null {
	let depth = 1;
	let angleDepth = 0;
	const stop = Math.min(stripped.length, openParenIdx + 1 + MAX_FIRST_ARG_SCAN);
	for (let i = openParenIdx + 1; i < stop; i++) {
		const ch = stripped.charAt(i);
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		if (ch === ")" || ch === "]" || ch === "}") depth--;
		if (depth === 0) return stripped.slice(openParenIdx + 1, i);
		angleDepth = nextAngleDepth(angleDepth, stripped, i);
		if (ch === "," && depth === 1 && angleDepth === 0) {
			return stripped.slice(openParenIdx + 1, i);
		}
	}
	return null;
}

/**
 * True when the argument looks like a raw byte buffer: ends in `.buffer`,
 * is a bare buffer-ish identifier, or contains a byte-run-producing call.
 */
function hasByteBufferSignal(arg: string): boolean {
	const a = arg.trim();
	if (a.length === 0) return false;
	if (/\.buffer$/.test(a)) return true;
	if (BYTE_BUFFER_IDENT_RE.test(a)) return true;
	return BYTE_SOURCE_CALL_RE.test(a);
}

function scanWideViews(ctx: ScanCtx): void {
	const re = new RegExp(WIDE_VIEW_CTOR_RE.source, "g");
	for (const m of ctx.stripped.matchAll(re)) {
		if (ctx.matches.length >= MAX_MATCHES_PER_FILE) return;
		const idx = m.index;
		const firstArg = extractFirstArg(ctx.stripped, idx + m[0].length - 1);
		if (firstArg === null || !hasByteBufferSignal(firstArg)) continue;
		const lineNo = offsetToLine(ctx.stripped, idx);
		if (hasGuardWithin(ctx.strippedLines, lineNo, JS_GUARD_LOOKBACK_LINES, JS_ALIGNMENT_GUARD_RE)) {
			continue;
		}
		record(ctx, lineNo, JS_MESSAGE);
	}
}

/**
 * Detect JS/TS typed-array / DataView construction over a byte buffer with
 * no alignment/length guard.
 *
 * Check id: `unaligned_reinterpret`
 *
 * Fires on `new <WideTypedArray>(expr)` / `new DataView(expr)` where the
 * first argument shows a byte-buffer signal (ends in `.buffer`, is a
 * buffer-ish identifier, or contains `.slice(` / `.subarray(` /
 * `readFileSync(`) — unless `.byteLength %` / `.length %` / `& ~` /
 * `BYTES_PER_ELEMENT` appears on the same line or within the 40 lines above.
 * Numeric allocations and element copies carry no signal; Uint8Array views
 * (element size 1) never match. JS/TS source only; test / vendored /
 * generated exempt. Up to 10 findings per file.
 */
export function checkUnalignedReinterpret(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!JS_TS_ALL_EXTS.includes(getExtension(filePath))) return [];
	if (isExemptFile(filePath, content)) return [];
	const ctx = buildCtx(content, "js");
	scanWideViews(ctx);
	return ctx.matches;
}
