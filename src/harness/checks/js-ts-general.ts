// JS/TS general checks (nested ternaries, catch-and-log, JSON parsing, etc).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";
import { findSkipMarkers } from "./test-skip-markers.js";

// ===========================================
// JS/TS General Checks
// ===========================================

/** Detect nested ternary operators — unreadable conditional logic. */
export function checkNestedTernaries(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const ternaryPattern = /(?<!\?)\?(?!\?)(?!\.)/g;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);
		// Skip TypeScript type annotation patterns that use ? but aren't ternaries
		if (/\bextends\s+.*\?/.test(line)) continue; // conditional types
		if (/\btype\s+\w+.*=.*\?/.test(line)) continue; // type aliases with conditionals
		// Skip lines that are purely property/parameter declarations with ?:
		// e.g. "name?: string" or "{ id?: number, label?: string }"
		if (/^\s*[\w$]+\?:\s/.test(line)) continue; // standalone optional property
		// Strip patterns that use ? but aren't ternary operators:
		// - Optional properties: name?: type
		// - Regex non-capturing groups: (?:...), lookaheads: (?=...), (?!...), (?<...)
		// - Regex lazy quantifiers: *?, +?, ??
		const cleaned = line
			.replace(/\w+\?\s*:/g, "X:") // optional properties
			.replace(/\(\?[!:=<]/g, "(X") // regex groups/lookaheads
			.replace(/[*+]\?/g, "X") // lazy quantifiers
			.replace(/\/[^/\n]+\//g, "X"); // regex literals (simplified)
		const ternaryMatches = cleaned.match(ternaryPattern);
		if (ternaryMatches && ternaryMatches.length >= 2) {
			matches.push({
				line: i + 1,
				text: nonNull(originalLines[i]).trim().slice(0, 150),
			});
		}
	}

	return matches;
}

/**
 * Route handlers / API endpoints: catch-log is the correct pattern since the
 * framework owns the error response, so those files are exempt entirely. Matches
 * either a `/routes|api|handlers|.../` path segment or a `.route|.handler|...`
 * filename suffix on the normalized (forward-slash, lowercased) path.
 */
function isCatchLogExemptPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/").toLowerCase();
	return (
		/\/(routes?|api|handlers?|endpoints?|middleware|webhooks?|actions?|pages?\/api)\//i.test(
			normalized,
		) || /\.(route|handler|controller|action|middleware)\.[jt]sx?$/i.test(normalized)
	);
}

/** Outcome of scanning a catch block's body for the console-only shape. */
type CatchBodyScan = {
	hasConsole: boolean;
	onlyConsole: boolean;
	foundClose: boolean;
	closeIdx: number;
};

/**
 * Scan up to 8 lines from the catch block's opening brace at `braceStart`,
 * tracking brace depth. Reports whether the body contains only `console.*`
 * calls (plus blank/closing lines) and the index of the closing brace.
 */
function scanCatchBody(strippedLines: string[], braceStart: number): CatchBodyScan {
	let onlyConsole = true;
	let hasConsole = false;
	let depth = 0;
	let foundClose = false;
	let closeIdx = -1;

	for (let j = braceStart; j < Math.min(braceStart + 8, strippedLines.length); j++) {
		const sLine = nonNull(strippedLines[j]);
		for (const ch of sLine) {
			if (ch === "{") depth++;
			if (ch === "}") depth--;
		}
		if (j > braceStart) {
			const trimmed = sLine.trim();
			if (trimmed === "}" || trimmed === "") {
				// empty line or closing brace — fine
			} else if (/^\s*console\.(log|error|warn|info|debug)\s*\(/.test(sLine)) {
				hasConsole = true;
			} else {
				onlyConsole = false;
				break;
			}
		}
		if (depth <= 0 && j > braceStart) {
			foundClose = true;
			closeIdx = j;
			break;
		}
	}

	return { hasConsole, onlyConsole, foundClose, closeIdx };
}

/**
 * After the catch block closes at `closeIdx`, does execution continue with any
 * meaningful code (state updates, cleanup, return) within the next few lines? If
 * so the error isn't silently swallowed and the catch-log shouldn't be flagged.
 */
function hasMeaningfulCodeAfterCatch(strippedLines: string[], closeIdx: number): boolean {
	for (let j = closeIdx + 1; j < Math.min(closeIdx + 5, strippedLines.length); j++) {
		const afterTrimmed = nonNull(strippedLines[j]).trim();
		if (afterTrimmed && afterTrimmed !== "}" && afterTrimmed !== ");") {
			return true;
		}
	}
	return false;
}

/** Detect catch blocks that only log — error is silently swallowed. */
/**
 * Inspect one line for a `} catch` opener and, if present, decide whether the
 * catch body is a silent console-only swallow worth flagging. Returns `null`
 * when the line isn't a catch opener, the opening brace can't be found, the
 * body isn't a pure console-log swallow, or execution continues afterward
 * with meaningful code.
 */
function findCatchLogMatchAt(
	strippedLines: string[],
	originalLines: string[],
	i: number,
): InlineMatch | null {
	if (!/\}\s*catch\s*/.test(nonNull(strippedLines[i]))) return null;

	let braceStart = -1;
	for (let k = i; k < Math.min(i + 3, strippedLines.length); k++) {
		if (nonNull(strippedLines[k]).includes("{")) {
			braceStart = k;
			break;
		}
	}
	if (braceStart === -1) return null;

	const { hasConsole, onlyConsole, foundClose, closeIdx } = scanCatchBody(
		strippedLines,
		braceStart,
	);
	if (!(hasConsole && onlyConsole && foundClose)) return null;

	// If execution continues after the catch with meaningful code, the
	// error isn't silently swallowed — don't flag it.
	if (hasMeaningfulCodeAfterCatch(strippedLines, closeIdx)) return null;

	return {
		line: i + 1,
		text: nonNull(originalLines[i]).trim().slice(0, 150),
	};
}

export function checkCatchAndLog(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	// Route handlers / API endpoints: catch-log is correct (framework owns the
	// error response), so skip those files entirely.
	if (isCatchLogExemptPath(filePath)) return [];

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const match = findCatchLogMatchAt(strippedLines, originalLines, i);
		if (match) matches.push(match);
	}

	return matches;
}

// try/catch openers and closers for the JSON.parse guard scan. Built from
// string sources (rather than inline literals) so the patterns are reused and
// named. `TRY_OPEN` matches K&R `try {` OR Allman bare `try` (brace next line).
// `CATCH_CLOSE` matches K&R `} catch` (brace-prefixed) OR Allman bare `catch`
// at line start; a dot-prefixed promise `.catch(` matches neither.
const TRY_OPEN = new RegExp("\\btry\\s*\\{|^\\s*try\\s*$");
const CATCH_CLOSE = new RegExp("(?:^\\s*|\\}\\s*)catch\\b");
const JSON_PARSE = new RegExp("\\bJSON\\.parse\\s*\\(");
const INLINE_TRY_PARSE_CATCH = new RegExp("\\btry\\s*\\{.*\\bJSON\\.parse\\b.*\\}\\s*catch\\b");

/** Detect JSON.parse without try-catch — throws on malformed input. */
export function checkJsonParseUnsafe(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	let tryDepth = 0;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);

		if (TRY_OPEN.test(line)) {
			tryDepth++;
		}

		if (JSON_PARSE.test(line)) {
			if (INLINE_TRY_PARSE_CATCH.test(line)) continue;
			if (tryDepth <= 0) {
				matches.push({
					line: i + 1,
					text: nonNull(originalLines[i]).trim().slice(0, 150),
				});
			}
		}

		if (CATCH_CLOSE.test(line)) {
			if (tryDepth > 0) tryDepth--;
		}
	}

	return matches;
}

/** Detect hardcoded timeout/interval values — extract to named constants. */
export function checkHardcodedTimeout(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const pattern = /\b(?:setTimeout|setInterval)\s*\([^,]+,\s*(\d+)\s*\)/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const m = nonNull(strippedLines[i]).match(pattern);
		if (m) {
			const ms = Number.parseInt(nonNull(m[1]), 10);
			if (ms >= 100) {
				matches.push({
					line: i + 1,
					text: nonNull(originalLines[i]).trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
}

/**
 * Detect disabled/skipped tests — remove .skip / #[ignore] / @pytest.mark.skip
 * or re-enable. Polyglot since 2026-07 (Bun test-oracle work): the marker table
 * lives in test-skip-markers.ts, shared with the skipped-tests water-line so
 * the check and the baseline can never disagree about what a "skip" is.
 * JS/TS behavior is unchanged (same pattern, same per-file cap).
 */
export function checkDisabledTests(content: string, filePath: string): InlineMatch[] {
	return findSkipMarkers(content, filePath);
}

/** Detect target="_blank" without rel="noopener noreferrer" — tabnabbing risk. */
export function checkTargetBlankNoRel(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx" && ext !== ".html") return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(originalLines[i]);
		if (!/target=["']_blank["']/.test(line)) continue;

		// Check surrounding JSX element context (±5 lines) for rel attribute.
		// In JSX, target and rel are often on different lines of the same element.
		let hasRel = false;
		for (let j = Math.max(0, i - 5); j < Math.min(originalLines.length, i + 6); j++) {
			const nearby = nonNull(originalLines[j]);
			if (/rel=["'][^"']*(noopener|noreferrer)/.test(nearby)) {
				hasRel = true;
				break;
			}
			// Stop scanning if we hit the element's closing > or a new element
			if (j > i && /^\s*[<>]/.test(nearby)) break;
		}

		if (!hasRel) {
			matches.push({
				line: i + 1,
				text: nonNull(originalLines[i]).trim().slice(0, 150),
			});
		}
	}

	return matches;
}
