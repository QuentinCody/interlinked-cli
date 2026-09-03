// UBS language-specific detectors — Java and C/C++ checks. Extracted from
// ubs-language-specific.ts during the 1500-line decomposition. Each function
// returns InlineMatch[]. Ext-gated to .java / C-family extensions.

import { nonNull } from "../../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isVendoredOrFixturePath,
	stripCommentsAndStrings,
} from "../shared.js";
import { MATCH_LIMIT } from "./_shared.js";

/**
 * True when `name`'s `.get()` call on `line` (`strippedLines[i]`, matched by
 * `callRe`) is guarded — either by an `isPresent()`/`orElse(...)`-family call
 * earlier on the same line, or by one on any prior line in the file. Same-line
 * guard wins first (e.g. `name.orElse(x)` — fine); otherwise scans backward.
 */
function isOptionalGetGuarded(
	name: string,
	callRe: RegExp,
	line: string,
	strippedLines: string[],
	i: number,
): boolean {
	const guardRe = new RegExp(
		`\\b${name}\\.(?:isPresent|orElse|orElseGet|orElseThrow|ifPresent|ifPresentOrElse|map|flatMap|filter)\\s*\\(`,
	);
	if (guardRe.test(line.replace(callRe, ""))) return true;
	for (let j = 0; j < i; j++) {
		if (guardRe.test(nonNull(strippedLines[j]))) return true;
	}
	return false;
}

/**
 * Finds the first unguarded `<name>.get()` reference on one line, scanning
 * `optionalNames` in declaration order, and returns the match to surface —
 * or `null` when the line has no unguarded `.get()` call. One finding per
 * line is enough, so the first hit wins.
 */
function findUnguardedOptionalGetOnLine(
	line: string,
	originalLine: string,
	lineIndex: number,
	optionalNames: Set<string>,
	strippedLines: string[],
): InlineMatch | null {
	for (const name of optionalNames) {
		const callRe = new RegExp(`\\b${name}\\.get\\s*\\(\\s*\\)`);
		if (!callRe.test(line)) continue;

		// Accept if a guard for this name appears earlier in the file or on
		// the same line.
		if (isOptionalGetGuarded(name, callRe, line, strippedLines, lineIndex)) continue;

		return { line: lineIndex + 1, text: originalLine.trim().slice(0, 150) };
	}
	return null;
}

/**
 * Row 29: Java `Optional<T>....get()` without an `isPresent()` / `orElse()`
 * guard is a NullPointerException risk. Flagged on `.java` files only.
 *
 * Heuristic: when an `Optional<...>` declaration is followed (within the same
 * file) by a `.get()` call, and there is no `isPresent()` / `orElse(`
 * / `orElseGet(` / `orElseThrow(` / `ifPresent(` referencing the same name in
 * between, surface the `.get()` line. The match scope is per-declaration; a
 * single guard call elsewhere in the file does not exonerate other bare
 * `.get()`s, but a guard on the same name immediately preceding the `.get()`
 * does.
 */
export function checkJavaOptionalGet(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".java") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// Find every `Optional<...> name = ...;` declaration; remember the name.
	// Per Plan 04 §4.3 the regex sketch is `\bOptional<[^>]+>[\s\S]{0,200}?\.get\(\)`.
	// We extract the variable name so the guard-detection step can scope per-name.
	const declRegex = /\bOptional\s*<[^>]+>\s+([A-Za-z_$][\w$]*)\s*=/;
	const optionalNames = new Set<string>();
	for (const line of strippedLines) {
		const m = line.match(declRegex);
		if (m) optionalNames.add(nonNull(m[1]));
	}
	if (optionalNames.size === 0) return [];

	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);
		const match = findUnguardedOptionalGetOnLine(
			line,
			nonNull(originalLines[i]),
			i,
			optionalNames,
			strippedLines,
		);
		if (match) matches.push(match);
	}
	return matches;
}

/**
 * `ubs_unsafe_format_string` — C/C++ `printf` / `sprintf` / `fprintf` family
 * with a non-literal format string. A user-controlled format spec can leak
 * stack memory (`%x`) or write arbitrary memory (`%n`). pre_warn / error.
 */
export function checkUnsafeFormatString(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isC = ext === ".c" || ext === ".h";
	const isCpp =
		ext === ".cpp" ||
		ext === ".cc" ||
		ext === ".cxx" ||
		ext === ".hpp" ||
		ext === ".hxx" ||
		ext === ".hh";
	if (!isC && !isCpp) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// printf-family format-string position varies by function:
	//   printf(fmt)              — format in slot 1
	//   fprintf(stream, fmt)     — format in slot 2
	//   sprintf(buf, fmt)        — format in slot 2
	//   snprintf(buf, n, fmt)    — format in slot 3 (slot 2 is the size)
	// Common bug: `snprintf(buf, n, "%s", input)` is SAFE — `n` is the size,
	// `"%s"` is the literal format. The earlier two-arg regex misclassified
	// `snprintf` as having its format at slot 2 and flagged the size
	// argument (an identifier) as a tainted format. snprintf must be its
	// own pattern with the size slot skipped.
	const onePosRe = /\bprintf\s*\(\s*([A-Za-z_]\w*)\s*[,)]/;
	const twoPosRe = /\b(?:sprintf|fprintf)\s*\(\s*[^,]+?,\s*([A-Za-z_]\w*)\s*[,)]/;
	const threePosRe = /\bsnprintf\s*\(\s*[^,]+?,\s*[^,]+?,\s*([A-Za-z_]\w*)\s*[,)]/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const stripLine = nonNull(strippedLines[i]);
		if (
			!onePosRe.test(stripLine) &&
			!twoPosRe.test(stripLine) &&
			!threePosRe.test(stripLine)
		) {
			continue;
		}
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}
