// ===========================================
// Taste Checks — shared helpers
// ===========================================
// Private helpers used by both the taste-checks.ts detectors and the
// extracted family modules (e.g. taste-checks-test-assertions.ts). Kept in
// a dependency-leaf module so the family files and the barrel can share them
// without creating an import cycle. This module imports only from
// ./strip-helpers.js — never from taste-checks.ts. Also consumed by the
// checks/ package (test-structure.ts / test-portability.ts import
// findBlockEnd, isJsTs, and lineIdxForOffset).

import { nonNull } from "../lib/non-null.js";
import { stripAllLiterals } from "./strip-helpers.js";

export interface InlineMatch {
	line: number;
	text: string;
}

// ===========================================
// Local helpers
// ===========================================

export function getExt(p: string): string {
	const i = p.lastIndexOf(".");
	return i === -1 ? "" : p.slice(i).toLowerCase();
}

export function isTestFile(filePath: string): boolean {
	const n = filePath.replace(/\\/g, "/");
	if (n.includes("/__tests__/") || n.includes("/tests/") || n.includes("/src/test/")) return true;
	const f = n.split("/").pop() || "";
	if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) return true;
	if (f.startsWith("test_") && f.endsWith(".py")) return true;
	if (f.endsWith("_test.py") || f.endsWith("_test.go")) return true;
	if (/Tests?\.(java|swift)$/.test(f)) return true;
	return false;
}

export function isJsTs(filePath: string): boolean {
	return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(getExt(filePath));
}

/**
 * Derives stripCommentsAndStrings from the shared pipeline. Uses the full
 * template + regex + comment + string strip, because some source files
 * contain regex literals with backticks inside them (e.g. a regex that
 * matches template literals). Without regex stripping, those backticks
 * are mis-interpreted as template delimiters and corrupt comment-tracker
 * state for the rest of the file — causing false-positive matches on
 * content that should have been blanked.
 */
export function stripCommentsAndStrings(content: string): string {
	return stripAllLiterals(content);
}

/**
 * Find the closing brace that ends a test-function's callback body.
 *
 * Handles three `it`/`test` signatures:
 *   - `it("desc", () => { body })` — callback at arg 2
 *   - `it(\`tpl ${x}\`, () => { body })` — template title (interpolations
 *     are already blanked by stripTemplateLiterals)
 *   - `it("desc", { timeout: N }, async () => { body })` — options object
 *     at arg 2, callback at arg 3
 *
 * Strategy: skip over anything up to the FIRST `=>` or `function` keyword —
 * those mark the start of the callback. Then the next `{` is the callback
 * body, and we balance braces from there.
 */
export function findBlockEnd(strippedLines: string[], start: number): number {
	const joined = strippedLines.slice(start).join("\n");
	// Locate the callback marker: `=>` or `function(` (or `function<`/function<`).
	// Use a search that ignores `=>` inside strings/templates — but since
	// stripCommentsAndStrings already blanked those, matching here is safe.
	const arrowIdx = joined.indexOf("=>");
	const funcIdx = joined.search(/\bfunction\b/);
	let markerIdx = -1;
	if (arrowIdx >= 0 && funcIdx >= 0) markerIdx = Math.min(arrowIdx, funcIdx);
	else markerIdx = arrowIdx >= 0 ? arrowIdx : funcIdx;
	if (markerIdx < 0) {
		// No callback — use legacy brace-counting from the start.
		return legacyFindBlockEnd(strippedLines, start);
	}
	// Find the first `{` at or after the marker — that's the callback body.
	const bodyOpenIdx = joined.indexOf("{", markerIdx);
	if (bodyOpenIdx < 0) return strippedLines.length - 1;

	const matchLine = findMatchingBraceLine(joined, bodyOpenIdx, start);
	return matchLine !== null ? matchLine : strippedLines.length - 1;
}

/**
 * Walk `joined` from `bodyOpenIdx`, balancing braces, and return the line
 * index (relative to the original `strippedLines`, offset by `start`) where
 * the opening brace's match closes — or `null` if the braces never balance.
 */
function findMatchingBraceLine(joined: string, bodyOpenIdx: number, start: number): number | null {
	let depth = 0;
	let opened = false;
	for (let p = bodyOpenIdx; p < joined.length; p++) {
		const ch = joined[p];
		if (ch === "{") {
			depth++;
			opened = true;
		} else if (ch === "}") {
			depth--;
			if (opened && depth === 0) {
				// Convert absolute char index back to line index.
				const charsBefore = joined.slice(0, p);
				return start + (charsBefore.match(/\n/g) || []).length;
			}
		}
	}
	return null;
}

/** Fallback brace-counting for test starts that have no `=>`/`function` marker. */
function legacyFindBlockEnd(strippedLines: string[], start: number): number {
	let depth = 0;
	let opened = false;
	for (let i = start; i < strippedLines.length; i++) {
		for (const ch of nonNull(strippedLines[i])) {
			if (ch === "{") {
				depth++;
				opened = true;
			} else if (ch === "}") {
				depth--;
				if (opened && depth === 0) return i;
			}
		}
	}
	return strippedLines.length - 1;
}

export function push(
	matches: InlineMatch[],
	lineIdx: number,
	originalLines: string[],
	limit: number,
): void {
	if (matches.length >= limit) return;
	matches.push({ line: lineIdx + 1, text: nonNull(originalLines[lineIdx]).trim().slice(0, 150) });
}

export function lineIdxForOffset(stripped: string, offset: number): number {
	return (stripped.slice(0, offset).match(/\n/g) || []).length;
}

// ===========================================
// Countable test-start detection — shared by the assertion-free / conditional
// / roulette detectors.
// ===========================================

const TEST_BLOCK_START = /^\s*(it|test|should)(\.\w+)?\s*\(/;
const TEST_NO_ASSERT_SKIP = /^\s*(it|test)\s*\.\s*(todo|skip|only)/;

export function isCountableTestStart(line: string): boolean {
	if (!TEST_BLOCK_START.test(line)) return false;
	return !TEST_NO_ASSERT_SKIP.test(line);
}
