// Line scanners shared by the taste-smell detectors. Extracted from
// taste-smell.ts to keep that module under the per-file line cap.

import { nonNull } from "../../lib/non-null.js";

/** Where the if-block's own brace closes on one scanned line, and the depth left after it. */
interface BlockCloseScan {
	/** Index of the `}` that returns the depth to 0, or -1 when the line does not close it. */
	closeIndex: number;
	/** Brace depth after the whole line was scanned (or up to the closing brace). */
	depth: number;
}

/**
 * Walk one line's characters tracking brace depth and report where (if anywhere)
 * the depth returns to 0. `skipFirstChar` mirrors the original scanner's guard
 * against the very first character examined (parity, not reachable in practice).
 */
function scanLineForBlockClose(
	scanLine: string,
	startDepth: number,
	skipFirstChar: boolean,
): BlockCloseScan {
	let depth = startDepth;
	for (let k = 0; k < scanLine.length; k++) {
		const ch = scanLine[k];
		if (ch === "{") depth++;
		if (ch !== "}") continue;
		depth--;
		if (depth !== 0 || (skipFirstChar && k === 0)) continue;
		return { closeIndex: k, depth };
	}
	return { closeIndex: -1, depth };
}

/**
 * Scan forward from the line at index `i` (already known to open an
 * `if (!x) {` block) tracking brace depth; the moment the if-block's own
 * opening brace closes, check whether an `else` immediately follows —
 * either later on the same line or at the start of the next line. Bounded
 * to a 50-line window; returns false if no closing point is found within it.
 *
 * Extracted from `checkNegatedConditionWithElse` — this is the "does the
 * if-block that starts here have a matching else" question in isolation.
 */
export function ifBlockHasMatchingElse(strippedLines: string[], i: number): boolean {
	let braceDepth = 0;
	for (let j = i; j < Math.min(i + 50, strippedLines.length); j++) {
		const scanLine = nonNull(strippedLines[j]);
		const scan = scanLineForBlockClose(scanLine, braceDepth, j === i);
		braceDepth = scan.depth;
		if (scan.closeIndex === -1) continue;
		if (/\belse\b/.test(scanLine.slice(scan.closeIndex + 1))) return true;
		return j + 1 < strippedLines.length && /^\s*else\b/.test(nonNull(strippedLines[j + 1]));
	}
	return false;
}

/**
 * Replace every character inside a generic type-argument span (and the `<` `>`
 * that delimit it) with a space, so none of them can be mistaken for a ternary
 * operator. Blanking preserves character offsets, which the `?.` / `??`
 * lookahead depends on.
 */
function blankGenericSpans(line: string): string {
	const chars = line.split("");
	let depth = 0;
	for (let j = 0; j < chars.length; j++) {
		const ch = chars[j];
		if (ch === "<") depth++;
		if (ch === ">") depth = Math.max(0, depth - 1);
		if (depth > 0 || ch === "<" || ch === ">") chars[j] = " ";
	}
	return chars.join("");
}

/** What the `?` at index `j` actually is: a ternary opener, `?.`, or `??`. */
function questionMarkKind(line: string, j: number): "ternary" | "optional-chain" | "nullish" {
	const next = line[j + 1];
	if (next === ".") return "optional-chain";
	if (next === "?") return "nullish";
	return "ternary";
}

/**
 * Walk one (already comment/string-stripped) line and answer: what is the
 * deepest ternary-operator nesting reached on it? Optional chaining (`?.`),
 * nullish coalescing (`??`), and generic type params (`<T>`) are skipped so
 * none of them are mistaken for a ternary `?`.
 */
export function maxTernaryNestingDepth(line: string): number {
	const scannable = blankGenericSpans(line);
	let ternaryDepth = 0;
	let maxTernaryDepth = 0;

	for (let j = 0; j < scannable.length; j++) {
		const ch = scannable[j];
		if (ch === ":") {
			if (ternaryDepth > 0) ternaryDepth--;
			continue;
		}
		if (ch !== "?") continue;
		const kind = questionMarkKind(scannable, j);
		if (kind === "nullish") {
			j++; // skip next ?
			continue;
		}
		if (kind === "optional-chain") continue;
		ternaryDepth++;
		maxTernaryDepth = Math.max(maxTernaryDepth, ternaryDepth);
	}

	return maxTernaryDepth;
}
