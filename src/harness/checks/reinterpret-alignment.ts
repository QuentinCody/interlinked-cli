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
import { type StripLang, stripForLang } from "./reinterpret-alignment-strip.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;
/** Guard lookback for the Rust detector: same line + 5 lines above. */
const RUST_GUARD_LOOKBACK_LINES = 5;
/** Guard lookback for the JS/TS detector: same line + 40 lines above. */
const JS_GUARD_LOOKBACK_LINES = 40;

// ─── Language-aware comment/string stripping ──────────────────────────────────
//
// See `./reinterpret-alignment-strip.js` — the scanner lives in its own module
// because this file sits at the per-file line cap.

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
const IDENT_CHAR_RE = /[A-Za-z0-9_$]/;

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
