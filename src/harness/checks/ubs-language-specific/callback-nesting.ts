// Callback-nesting scan for `ubs_deeply_nested_callback`.
// Extracted from quality-smell-checks.ts (line-cap decomposition); the scan is
// a brace-depth walk that tracks how many function bodies are open at once.

import { nonNull } from "../../../lib/non-null.js";

/** Number of simultaneously-open function bodies that counts as callback hell. */
const NESTING_LIMIT = 4;

/**
 * Record the brace depth at which each of `count` function openers on one line
 * was entered. Internal; mutates `funcOpenStack`.
 */
function pushFunctionOpenDepths(funcOpenStack: number[], braceDepth: number, count: number): void {
	for (let k = 0; k < count; k++) {
		funcOpenStack.push(braceDepth);
	}
}

/**
 * Drop every function opener whose entry brace depth is no longer below the
 * current `braceDepth` — its body has closed. Internal; mutates the stack.
 */
function popClosedFunctionOpens(funcOpenStack: number[], braceDepth: number): void {
	while (
		funcOpenStack.length > 0 &&
		nonNull(funcOpenStack[funcOpenStack.length - 1]) >= braceDepth
	) {
		funcOpenStack.pop();
	}
}

/**
 * Line indices (0-based, ascending) of comment/string-stripped lines that sit
 * inside `NESTING_LIMIT` or more simultaneously-open function bodies. Stops
 * once `limit` indices are collected.
 *
 * Heuristic: `function` and `=>` are the function-opener candidates, and brace
 * counting decides when each opened body closes again.
 */
export function findDeeplyNestedCallbackLines(strippedLines: string[], limit: number): number[] {
	const nestedLines: number[] = [];
	let braceDepth = 0;
	const funcOpenStack: number[] = [];

	for (const [i, line] of strippedLines.entries()) {
		if (nestedLines.length >= limit) break;

		const funcOpens = (line.match(/\bfunction\b|=>/g) || []).length;
		const opens = (line.match(/\{/g) || []).length;
		const closes = (line.match(/\}/g) || []).length;

		// A line both introducing a function and opening a brace enters a body.
		pushFunctionOpenDepths(funcOpenStack, braceDepth, Math.min(funcOpens, opens));
		braceDepth += opens - closes;
		popClosedFunctionOpens(funcOpenStack, braceDepth);

		if (funcOpenStack.length >= NESTING_LIMIT) {
			nestedLines.push(i);
		}
	}
	return nestedLines;
}
