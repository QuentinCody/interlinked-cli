// Missing effect cleanup detection (React).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch, isTestFile } from "./shared.js";

// ===========================================
// Missing Effect Cleanup Detection (React)
// ===========================================

/**
 * Scan one useEffect block (lines[start..end)) for a subscription call
 * with no cleanup return. Returns the flagged match, or null if the
 * block is clean.
 */
function findEffectCleanupMatch(
	lines: string[],
	start: number,
	end: number,
	subscriptionPattern: RegExp,
): InlineMatch | null {
	let hasSubscription = false;
	let hasReturn = false;

	for (let i = start; i < end; i++) {
		const lineAtI = nonNull(lines[i]);
		const trimmed = lineAtI.trim();
		if (subscriptionPattern.test(trimmed)) {
			hasSubscription = true;
		}
		// Look for cleanup return — `return () =>` or `return function`
		if (/\breturn\s+(function\b|\(\s*\)\s*=>|[\w]+\s*;)/.test(trimmed)) {
			hasReturn = true;
		}
		// Also catch bare `return () =>` or `return cleanup;`
		if (/^\s*return\s/.test(lineAtI)) {
			hasReturn = true;
		}
	}

	if (!hasSubscription || hasReturn) return null;

	return {
		line: start + 1,
		text: `[useEffect with subscription but no cleanup — potential memory leak] ${nonNull(lines[start]).trim().slice(0, 100)}`,
	};
}

/**
 * Detect useEffect hooks that set up subscriptions (addEventListener,
 * setInterval, setTimeout, subscribe, .on() ) but lack a cleanup return.
 *
 * Heuristic: scan line-by-line from each `useEffect(` to the next
 * `useEffect(` or end of file. If we see a subscription call but no
 * `return` statement in that block, flag it.
 *
 * Only fires on .tsx/.jsx files. Skips test files.
 */
export function checkMissingEffectCleanup(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];

	const subscriptionPattern =
		/\b(addEventListener|setInterval|setTimeout|subscribe)\s*\(|\.on\s*\(/;

	// Find all useEffect start lines
	const effectStarts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (/\buseEffect\s*\(/.test(nonNull(lines[i]).trim())) {
			effectStarts.push(i);
		}
	}

	for (let e = 0; e < effectStarts.length; e++) {
		const start = nonNull(effectStarts[e]);
		const end = e + 1 < effectStarts.length ? nonNull(effectStarts[e + 1]) : lines.length;

		const match = findEffectCleanupMatch(lines, start, end, subscriptionPattern);
		if (match) {
			matches.push(match);
		}
	}

	return matches;
}
