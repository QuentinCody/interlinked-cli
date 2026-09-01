// ===========================================
// Strong Typing Detection (inline, for strong_typing check)
// ===========================================
// Extracted from quality-checks.ts. Scans file content for explicit `any`
// and `as unknown` usage so the strong_typing check can report line-level
// offenders without spinning up tsc.

import { nonNull } from "../../lib/non-null.js";
import { stripRegexLiterals } from "../strip-helpers.js";

/**
 * Patterns that match explicit `any` usage in TypeScript.
 * Each match captures the full line for reporting.
 * Ignores comments, string literals (best-effort), and common false positives.
 */
const ANY_TYPE_PATTERNS = [
	// Type annotations:  : any,  : any;  : any)  : any>  : any =  : any[
	/:\s*any\s*[;,)>=[\]|&\n\r]/,
	// Generic parameters:  <any>  <any,  <any>
	/<\s*any\s*[>,]/,
	// `as any`
	/\bas\s+any\b/,
	// Function return type: ): any
	/\)\s*:\s*any\b/,
];

/**
 * Patterns that match `unknown` type escape hatches in TypeScript.
 * Only flags `as unknown` casts (the escape hatch pattern), NOT
 * `: unknown` type annotations which are legitimate TypeScript usage.
 */
const UNKNOWN_TYPE_PATTERNS = [
	// `as unknown` — cast escape hatch (often `as unknown as X` double-cast)
	/\bas\s+unknown\b/,
];

interface AnyTypeMatch {
	line: number;
	text: string;
	kind: "any" | "unknown";
}

/**
 * Public API — consumed by quality-checks.runQualityChecks and verify.ts.
 *
 * Scan file content for explicit `any` and `unknown` type usage.
 * Returns line numbers and trimmed line text for each occurrence.
 */
export function findAnyTypes(content: string): AnyTypeMatch[] {
	// Strip regex-literal bodies first. Without this, a file that defines
	// a regex like `/\\bRecord\\s*<\\s*[\\w.|&\\s]+,\\s*(?:any|unknown)\\s*>/`
	// self-flags because the substring `:any|` matches the `:any[|]`
	// type-annotation pattern. The check (which is supposed to find REAL
	// `any` type usage) was firing on the detector regex that hunts for
	// `any` usage — a classic self-reference false positive.
	const regexStripped = stripRegexLiterals(content);
	const lines = regexStripped.split("\n");
	const matches: AnyTypeMatch[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = nonNull(lines[i]);
		const trimmed = line.trim();

		// Skip comment-only lines
		if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"))
			continue;

		// Skip lines that are entirely inside a string (best-effort: starts with quote)
		if (/^\s*['"`]/.test(line) && /['"`]\s*[;,]?\s*$/.test(line)) continue;

		// Strip string literal content before checking patterns to avoid
		// matching `any` inside strings (e.g., "Do NOT use `as any`")
		const stripped = stripStringLiterals(line);

		// Check for any-type patterns on the stripped line
		let matched = false;
		for (const pattern of ANY_TYPE_PATTERNS) {
			if (pattern.test(stripped)) {
				matches.push({ line: i + 1, text: trimmed.slice(0, 120), kind: "any" });
				matched = true;
				break;
			}
		}

		// Check for unknown-type patterns (only if no any match on this line)
		if (!matched) {
			for (const pattern of UNKNOWN_TYPE_PATTERNS) {
				if (pattern.test(stripped)) {
					matches.push({ line: i + 1, text: trimmed.slice(0, 120), kind: "unknown" });
					break;
				}
			}
		}
	}

	return matches;
}

/**
 * Public API — consumed by findAnyTypes and verify.ts.
 *
 * Replace string literal content with empty strings to avoid false positive matches.
 */
export function stripStringLiterals(line: string): string {
	// Replace content inside double-quoted strings
	let result = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
	// Replace content inside single-quoted strings
	result = result.replace(/'(?:[^'\\]|\\.)*'/g, "''");
	// Replace content inside backtick template strings (single-line only)
	result = result.replace(/`(?:[^`\\]|\\.)*`/g, "``");
	return result;
}
