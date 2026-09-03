// Argument- and parameter-scanning helpers for the taste checks.
// Extracted from taste.ts to keep that module under the per-file line cap.

import { nonNull } from "../../lib/non-null.js";
import { collectFunctionSignature, countTopLevelCommas } from "./shared.js";

/**
 * Count boolean literals among the top-level arguments of one call whose
 * argument list starts at `start` (just after the opening paren). Stops at the
 * matching close, or at the end of the line when the call is unterminated.
 */
export function countBooleanArgsFrom(line: string, start: number): number {
	let depth = 0;
	let boolCount = 0;
	let argStart = start;

	for (let j = start; j < line.length; j++) {
		const ch = line[j];
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
		} else if (ch === ")" || ch === "]" || ch === "}") {
			if (depth === 0) {
				if (isBooleanLiteralArg(line.slice(argStart, j))) boolCount++;
				break;
			}
			depth--;
		} else if (ch === "," && depth === 0) {
			if (isBooleanLiteralArg(line.slice(argStart, j))) boolCount++;
			argStart = j + 1;
		}
	}

	return boolCount;
}

/** True if a raw argument slice is exactly a boolean literal. */
function isBooleanLiteralArg(raw: string): boolean {
	const arg = raw.trim();
	return arg === "true" || arg === "false";
}

/** Name captured by the first of `patterns` that matches `trimmed`, else null. */
export function matchFunctionName(trimmed: string, patterns: RegExp[]): string | null {
	for (const pat of patterns) {
		const m = trimmed.match(pat);
		if (m) return nonNull(m[1]);
	}
	return null;
}

/**
 * Top-level parameter count for the signature starting at `lines[i]`, or null
 * when the line carries no countable parameter list: no parenthesised
 * signature, an empty list, or a single destructured object parameter.
 */
export function signatureParamCount(lines: string[], i: number): number | null {
	const paramSig = collectFunctionSignature(lines, i);
	const paramMatch = paramSig.match(/\(([^)]*)\)/);
	if (!paramMatch) return null;

	const paramStr = nonNull(paramMatch[1]).trim();
	if (paramStr.length === 0) return null;

	// Skip destructured single-param: function f({ a, b, c, d, e })
	if (/^\s*\{/.test(paramStr) && countTopLevelCommas(paramStr) === 1) return null;
	// Also skip if only param is an object pattern (no top-level commas outside braces)
	if (/^\s*\{[^}]*\}\s*$/.test(paramStr)) return null;

	return countTopLevelCommas(paramStr);
}
