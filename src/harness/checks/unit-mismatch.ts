// Timeout unit mismatch: seconds-named value passed where milliseconds expected.
//
// `setTimeout` / `setInterval` take a MILLISECOND delay. Passing an identifier
// whose name says "seconds" (`delaySeconds`, `timeoutSec`, `retry_s`) directly
// as the delay argument is almost always a 1000× bug — the timer fires ~1000×
// too early. The inverse also fires: an identifier already named in
// milliseconds (`delayMs`, `intervalMillis`) multiplied by 1000 inline at the
// same call site double-converts and fires ~1000× too late.
//
// Zero-FP bias: only the DIRECT argument position is examined — a bare
// identifier (dotted paths like `opts.timeoutSec` allowed) with no arithmetic,
// EXCEPT the `x * 1000` inverse case. `delaySeconds * 1000` (the correct
// conversion) never fires; numeric literals never fire; a seconds-named var
// used anywhere else never fires.
//
// Check id: timeout_unit_mismatch

import {
	getExtension,
	type InlineMatch,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";
// Shared offset→line helper (1-based; the comment/string stripper preserves
// line count, so it is valid over stripped text). Direct in-package import —
// shared.ts sits at its line cap and cannot carry another re-export line.
import { offsetToLine } from "./shared-text-utils.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;
/** Max chars to scan forward from `setTimeout(` for the delay argument. */
const ARG_SCAN_WINDOW = 1500;

// ─── Patterns ─────────────────────────────────────────────────────────────────

/** setTimeout( / setInterval( call sites (also matches window.setTimeout). */
const TIMER_CALL_RE = /\bset(?:Timeout|Interval)\s*\(/g;

/** Bare identifier, optionally dotted (`opts.timeoutSec`, `this.delay_s`). */
const DOTTED_IDENT_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * Seconds-named identifier (last dotted segment). Camel-case requires the
 * capital-S boundary (`delaySeconds`, `timeoutSec`) so `nanoseconds` /
 * `Microseconds` tails don't match; snake requires the underscore
 * (`retry_s`, `wait_secs`); whole-word `sec`/`secs`/`seconds` also count.
 */
function isSecondsName(name: string): boolean {
	if (/milli|msec/i.test(name)) return false;
	return (
		/^sec(?:ond)?s?$/i.test(name) ||
		/_s$/.test(name) ||
		/_sec(?:ond)?s?$/i.test(name) ||
		/(?:Sec|Second)s?$/.test(name)
	);
}

/**
 * Milliseconds-named identifier (last dotted segment): `ms`, `delay_ms`,
 * `delayMs`, `intervalMillis`, `timeoutMilliseconds`. Camel `Ms` is
 * case-sensitive so `params` doesn't match.
 */
function isMsName(name: string): boolean {
	return (
		/^ms$/i.test(name) ||
		/_ms$/i.test(name) ||
		/Ms$/.test(name) ||
		/milli(?:s|seconds)$/i.test(name)
	);
}

// ─── Argument extraction ──────────────────────────────────────────────────────

/** Opens a nesting level inside a call argument list. */
function isOpenBracket(ch: string): boolean {
	return ch === "(" || ch === "[" || ch === "{";
}

/** Closes a nesting level inside a call argument list. */
function isCloseBracket(ch: string): boolean {
	return ch === ")" || ch === "]" || ch === "}";
}

/**
 * Walk a timer call's argument list from the char right AFTER the opening
 * paren, balancing parens/brackets/braces so a multi-line callback first
 * argument is skipped correctly. Reports the offsets of the first two
 * top-level commas and of the closing paren (`-1` when the scan window ends
 * before the call closes).
 */
function scanCallBoundaries(
	stripped: string,
	afterParen: number,
	end: number,
): { commas: number[]; closeParen: number } {
	let depth = 1;
	const commas: number[] = [];
	for (let i = afterParen; i < end; i++) {
		const ch = stripped.charAt(i);
		if (isOpenBracket(ch)) {
			depth++;
			continue;
		}
		if (isCloseBracket(ch)) {
			depth--;
			if (depth === 0) return { commas, closeParen: i };
			continue;
		}
		if (ch === "," && depth === 1 && commas.length < 2) commas.push(i);
	}
	return { commas, closeParen: -1 };
}

/**
 * Extract the delay argument (position 2) of a timer call, given the offset
 * of the char right AFTER the opening paren. Returns the argument text and
 * its absolute start offset, or null when there is no second argument in the
 * scan window.
 */
function extractDelayArg(
	stripped: string,
	afterParen: number,
): { text: string; offset: number } | null {
	const end = Math.min(stripped.length, afterParen + ARG_SCAN_WINDOW);
	const { commas, closeParen } = scanCallBoundaries(stripped, afterParen, end);
	const firstComma = commas[0];
	if (firstComma === undefined) return null;
	const argStart = firstComma + 1;
	// A second top-level comma ends the delay arg (extra callback params);
	// otherwise the closing paren does.
	const argEnd = commas[1] ?? closeParen;
	if (argEnd < 0) return null;
	return { text: stripped.slice(argStart, argEnd).trim(), offset: argStart };
}

// ─── Classification ───────────────────────────────────────────────────────────

/** Last dotted segment of an identifier path (`opts.timeoutSec` → `timeoutSec`). */
function lastSegment(path: string): string {
	return path.split(".").pop() ?? path;
}

/**
 * Classify a delay-argument expression; returns the finding message or null.
 * Fires only on (a) a direct seconds-named identifier, or (b) an
 * ms-named identifier multiplied by 1000 inline.
 */
function classifyDelayArg(arg: string): string | null {
	if (DOTTED_IDENT_RE.test(arg)) {
		if (isSecondsName(lastSegment(arg))) {
			return `seconds-named value "${arg}" passed directly as the delay — setTimeout/setInterval expect milliseconds (multiply by 1000)`;
		}
		return null;
	}
	// Inverse: ms-named identifier * 1000 (either operand order).
	const mul =
		/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\*\s*1000$/.exec(arg) ??
		/^1000\s*\*\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/.exec(arg);
	const ident = mul?.[1];
	if (ident !== undefined && isMsName(lastSegment(ident))) {
		return `milliseconds-named value "${ident}" multiplied by 1000 at the call site — the delay is already in ms (drop the * 1000)`;
	}
	return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect second/millisecond unit mismatches at setTimeout/setInterval call
 * sites.
 *
 * Check id: `timeout_unit_mismatch`
 *
 * Returns up to 10 `InlineMatch` findings per file. Only fires on JS/TS
 * source files.
 */
export function detectTimeoutUnitMismatch(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	const re = new RegExp(TIMER_CALL_RE.source, "g");
	let hit: RegExpExecArray | null;
	while ((hit = re.exec(stripped)) !== null) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		const arg = extractDelayArg(stripped, hit.index + hit[0].length);
		if (arg === null) continue;
		const message = classifyDelayArg(arg.text);
		if (message === null) continue;
		const lineNo = offsetToLine(stripped, arg.offset);
		if (seen.has(lineNo)) continue;
		seen.add(lineNo);
		const rawText = (rawLines[lineNo - 1] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
		matches.push({ line: lineNo, text: `timeout_unit_mismatch: ${message} — ${rawText}` });
	}

	return matches;
}
