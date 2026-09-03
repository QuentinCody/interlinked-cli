// Performance anti-pattern checks (loop-body analysis, repeated work, etc).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// Loop-body anti-pattern detectors live in a sibling to keep this file under
// the per-file line cap; they import the loop-body extractors back from here.
export {
	checkAwaitInLoop,
	checkCloneInLoop,
	checkJsonInLoop,
	checkMallocInLoop,
	checkQueryInLoop,
	checkRegexInLoop,
	checkSortInLoop,
	checkSprintfInLoop,
	checkStringConcatInLoop,
} from "./performance-loop-checks.js";

// ===========================================
// Performance Anti-Pattern Checks
// ===========================================
// Deterministic regex/heuristic checks that detect performance bugs.
// Each returns InlineMatch[]. <5ms per check, no external dependencies.

// --- Loop Body Infrastructure ---

export interface LoopBody {
	/** 1-based line number of first body line */
	startLine: number;
	/** Joined stripped body (comments/strings removed) */
	body: string;
	/** Per-line stripped content */
	bodyLines: string[];
	/** Per-line original content (for display) */
	originalBodyLines: string[];
}

/** Net brace-nesting delta contributed by one (already comment/string-stripped) line. */
function braceDelta(line: string): number {
	let delta = 0;
	for (const ch of line) {
		if (ch === "{") delta++;
		if (ch === "}") delta--;
	}
	return delta;
}

/**
 * Does this stripped line start a for/while/loop head we track?
 * Also matches Go/Rust for without parens — for ... {, for ... in ... {
 * Excludes "for await" — that's an async iterator, not a sequential loop.
 */
function isBraceLoopHeadLine(line: string): boolean {
	if (!/^\s*(for\s*[\s(]|while\s*[\s(]|loop\s*\{)/.test(line)) return false;
	if (/\bfor\s+await\b/.test(line)) return false;
	return true;
}

/**
 * Find the line — within a 5-line lookahead from `from` — that opens the
 * loop's brace. It may be on the head line itself or wrap onto later lines.
 */
function findLoopBraceLine(strippedLines: string[], from: number): number {
	const end = Math.min(from + 5, strippedLines.length);
	for (let k = from; k < end; k++) {
		if (nonNull(strippedLines[k]).includes("{")) return k;
	}
	return -1;
}

/**
 * Capture the lines making up a loop body, starting from `bodyStart` at
 * `initialDepth` open braces, until brace depth returns to (or below) zero.
 */
function captureLoopBody(
	strippedLines: string[],
	originalLines: string[],
	bodyStart: number,
	initialDepth: number,
): { bodyStrippedLines: string[]; bodyOriginalLines: string[] } {
	let depth = initialDepth;
	const bodyStrippedLines: string[] = [];
	const bodyOriginalLines: string[] = [];
	for (let j = bodyStart; j < strippedLines.length; j++) {
		depth += braceDelta(nonNull(strippedLines[j]));
		if (depth <= 0) break; // Closing brace reached
		bodyStrippedLines.push(nonNull(strippedLines[j]));
		bodyOriginalLines.push(nonNull(originalLines[j]));
	}
	return { bodyStrippedLines, bodyOriginalLines };
}

/**
 * Extract loop bodies from brace-delimited languages (JS/TS/Rust/Go/C/C++).
 * Finds for/while/loop heads, tracks brace depth, captures body lines.
 */
export function extractBraceLoopBodies(content: string): LoopBody[] {
	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const originalLines = content.split("\n");
	const bodies: LoopBody[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (!isBraceLoopHeadLine(nonNull(strippedLines[i]))) continue;

		// Find the opening brace — may be on same line or next few lines
		const braceLineIdx = findLoopBraceLine(strippedLines, i);
		if (braceLineIdx === -1) continue;

		// Count all braces on the brace line to get initial depth
		const initialDepth = braceDelta(nonNull(strippedLines[braceLineIdx]));
		if (initialDepth <= 0) continue; // Single-line loop body or empty

		// Capture body lines
		const bodyStart = braceLineIdx + 1;
		const { bodyStrippedLines, bodyOriginalLines } = captureLoopBody(
			strippedLines,
			originalLines,
			bodyStart,
			initialDepth,
		);

		if (bodyStrippedLines.length > 0) {
			bodies.push({
				startLine: bodyStart + 1, // 1-based
				body: bodyStrippedLines.join("\n"),
				bodyLines: bodyStrippedLines,
				originalBodyLines: bodyOriginalLines,
			});
		}

		// Skip past the loop body to avoid nested loop double-counting
		// (we still want to detect patterns in nested loops — they're part of the body)
	}

	return bodies;
}

/**
 * Extract loop bodies from Python (indent-delimited).
 * Finds for/while heads, captures all lines at deeper indent.
 */
export function extractIndentLoopBodies(content: string): LoopBody[] {
	const stripped = stripComments(content);
	const strippedLines = stripped.split("\n");
	const originalLines = content.split("\n");
	const bodies: LoopBody[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		const trimmed = nonNull(strippedLines[i]).trim();
		if (!/^(for\s+.+|while\s+.+):\s*$/.test(trimmed)) continue;
		// Single-line body (e.g., "for x in y: pass") — skip
		if (/:\s*\S/.test(trimmed) && !trimmed.endsWith(":")) continue;

		const headIndent = nonNull(strippedLines[i]).search(/\S/);
		if (headIndent < 0) continue;

		const bodyStart = i + 1;
		const bodyStrippedLines: string[] = [];
		const bodyOriginalLines: string[] = [];

		for (let j = bodyStart; j < strippedLines.length; j++) {
			const line = nonNull(strippedLines[j]);
			if (line.trim() === "") {
				bodyStrippedLines.push(line);
				bodyOriginalLines.push(nonNull(originalLines[j]));
				continue; // Blank lines don't break indent
			}
			const indent = line.search(/\S/);
			if (indent <= headIndent) break; // Exited the loop body
			bodyStrippedLines.push(line);
			bodyOriginalLines.push(nonNull(originalLines[j]));
		}

		if (bodyStrippedLines.length > 0) {
			bodies.push({
				startLine: bodyStart + 1,
				body: bodyStrippedLines.join("\n"),
				bodyLines: bodyStrippedLines,
				originalBodyLines: bodyOriginalLines,
			});
		}
	}

	return bodies;
}

/** Get loop bodies for a file based on its language */
export function getLoopBodies(content: string, filePath: string): LoopBody[] {
	const ext = getExtension(filePath);
	if (ext === ".py") return extractIndentLoopBodies(content);
	if (
		[
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs",
			".rs",
			".go",
			".c",
			".cpp",
			".cc",
			".cxx",
			".h",
			".hpp",
			".java",
			".swift",
		].includes(ext)
	) {
		return extractBraceLoopBodies(content);
	}
	return [];
}

// --- Tier 1: High confidence, significant impact ---

/**
 * Detect strlen() in loop condition — O(n) per iteration makes loop O(n²).
 * The compiler cannot hoist this because the string might be modified in the body.
 */
export function checkStrlenInLoopCondition(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/\bfor\s*\([^;]*;[^;]*\bstrlen\s*\(/,
		10,
	);
}

/**
 * Detect .collect() immediately followed by .iter() — defeats Rust's
 * zero-cost iterator fusion. Materializes entire sequence into Vec just to re-iterate.
 */
export function checkCollectThenIterate(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".rs") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/\.collect\s*(?:::<[^>]*>\s*)?\(\s*\)\s*\.\s*(iter|into_iter|len)\s*\(/,
		10,
	);
}

/**
 * Scan the .reduce() callback body starting at line `i` (up to 20 lines) for
 * a `[...` spread that would allocate/copy the whole accumulator array. The
 * scan stops at the first spread found after `i`, or when paren depth closes
 * back to zero (end of the callback).
 */
function findSpreadInReduceCallback(
	strippedLines: string[],
	originalLines: string[],
	i: number,
): InlineMatch | null {
	let depth = 0;
	for (let j = i; j < Math.min(i + 20, strippedLines.length); j++) {
		for (const ch of nonNull(strippedLines[j])) {
			if (ch === "(") depth++;
			if (ch === ")") depth--;
		}
		if (/\[\s*\.\.\./.test(nonNull(strippedLines[j])) && j > i) {
			return {
				line: j + 1,
				text: nonNull(originalLines[j]).trim().slice(0, 150),
			};
		}
		if (depth <= 0 && j > i) break;
	}
	return null;
}

/**
 * Detect [...acc, item] inside .reduce() — O(n²) array copying.
 * Each iteration allocates and copies the entire accumulator array.
 */
export function checkSpreadInReduce(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!/\.reduce\s*\(/.test(nonNull(strippedLines[i]))) continue;

		// Scan the reduce callback body (up to 20 lines) for spread
		const match = findSpreadInReduceCallback(strippedLines, originalLines, i);
		if (match) matches.push(match);
	}

	return matches;
}

/**
 * Detect JSON.parse(JSON.stringify(x)) — two full traversals for deep clone.
 * Use structuredClone() instead (single traversal, handles more types).
 */
export function checkJsonClonePattern(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/JSON\.parse\s*\(\s*JSON\.stringify\s*\(/,
		10,
	);
}

/**
 * Detect .filter(...).length — allocates throwaway array just to count.
 * Use .reduce() with counter or a loop instead.
 */
export function checkFilterLength(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\.filter\s*\([^)]*\)\s*\.length\b/, 10);
}

/**
 * Detect Math.max(...arr) / Math.min(...arr) — stack overflow on large arrays.
 * V8 has a hard limit on function arguments (~65K-125K).
 */
export function checkMathSpread(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /Math\.(max|min)\s*\(\s*\.\.\./, 10);
}

// --- Tier 2: Good signal, slightly more heuristic ---

/**
 * Detect Array.from(x).map(fn) — double iteration.
 * Use Array.from(x, fn) which maps during construction (single pass).
 */
export function checkArrayFromMap(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/Array\.from\s*\([^)]*\)\s*\.map\s*\(/,
		10,
	);
}

/**
 * Detect `as unknown as T` double-cast in TypeScript — bypasses all type checking.
 * Indicates a type design problem that prevents compiler optimization.
 */
export function checkDoubleTypeCast(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".ts" && ext !== ".tsx") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\bas\s+unknown\s+as\b/, 10);
}

/**
 * Detect len(list(generator)) in Python — materializes entire sequence just to count.
 * Use sum(1 for ...) or collections.Counter instead.
 */
export function checkLenListGenerator(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".py") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\blen\s*\(\s*list\s*\(/, 10);
}
