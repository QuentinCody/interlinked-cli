// ===========================================
// Regex → Trigram Decomposition (with alternation support)
// ===========================================
// Parses a regex pattern and extracts the literal substrings that MUST appear
// in any matching text. These literals are then broken into trigrams
// for querying the trigram index.
//
// Approach: Walk the regex character by character, accumulating literal
// runs. When we hit a non-literal construct (wildcard, quantifier,
// character class, etc.), flush the current literal run and extract
// trigrams from it. The result is a set of trigrams that ALL must
// appear in any file that matches the regex.
//
// Conservative: we only extract trigrams from portions of the regex we
// can prove are required literals. This means we may return fewer
// trigrams than optimal (more candidate files), but never miss a file
// that actually matches (no false negatives).

import { extractLiteralSegments } from "./regex-trigrams-flush-segment.js";
import { extractTrigrams, isControlChar, packTrigram } from "./trigram-index.js";

// ===========================================
// Types
// ===========================================

interface DecompositionResult {
	/** Trigrams that MUST all appear in any matching file */
	requiredTrigrams: number[];
	/** The literal segments extracted from the regex */
	literalSegments: string[];
	/** Whether the pattern has any extractable literals */
	hasLiterals: boolean;
	/** Whether the pattern was treated as a plain literal (no regex syntax) */
	isLiteral: boolean;
	/** Ordered trigram sequences from each literal segment (for adjacency checking) */
	trigramSequences: number[][];
}

// ===========================================
// Helpers
// ===========================================

/** Extract packed trigrams in order from a literal segment (for adjacency checking). */
function orderedTrigrams(segment: string): number[] {
	const lower = segment.toLowerCase();
	const result: number[] = [];
	for (let i = 0; i <= lower.length - 3; i++) {
		const c0 = lower.charCodeAt(i);
		const c1 = lower.charCodeAt(i + 1);
		const c2 = lower.charCodeAt(i + 2);
		if (c0 > 0x7f || c1 > 0x7f || c2 > 0x7f) continue;
		if (isControlChar(c0) || isControlChar(c1) || isControlChar(c2)) continue;
		result.push(packTrigram(c0, c1, c2));
	}
	return result;
}

// ===========================================
// Main Entry Point
// ===========================================

/**
 * Decompose a search pattern into required trigrams.
 *
 * @param pattern - The search pattern (literal string or regex)
 * @param isRegex - Whether to parse as regex (default: false = literal)
 * @param caseInsensitive - Whether the search is case-insensitive
 * @returns Trigrams that must appear in any matching file
 */
export function decomposePattern(
	pattern: string,
	isRegex = false,
	caseInsensitive = false,
): DecompositionResult {
	if (!pattern || pattern.length < 3) {
		return {
			requiredTrigrams: [],
			literalSegments: [],
			hasLiterals: false,
			isLiteral: !isRegex,
			trigramSequences: [],
		};
	}

	// For literal strings, extraction is straightforward
	if (!isRegex) {
		const effective = caseInsensitive ? pattern.toLowerCase() : pattern;
		const trigrams = extractTrigrams(effective);
		return {
			requiredTrigrams: [...trigrams],
			literalSegments: [effective],
			hasLiterals: trigrams.size > 0,
			isLiteral: true,
			trigramSequences: [orderedTrigrams(effective)],
		};
	}

	// Check for top-level alternation first — handle at the trigram level:
	// only trigrams common to ALL branches are required (see intersectBranchTrigrams).
	const topBranches = splitAlternation(pattern);
	if (topBranches.length > 1) {
		const { trigrams, segments } = intersectBranchTrigrams(topBranches, caseInsensitive);
		return {
			requiredTrigrams: [...trigrams],
			literalSegments: segments,
			hasLiterals: trigrams.size > 0,
			isLiteral: false,
			trigramSequences: [],
		};
	}

	// No top-level alternation — extract literal segments normally
	const segments = extractLiteralSegments(pattern);

	// Extract trigrams from each segment
	const allTrigrams = new Set<number>();
	const literalSegments: string[] = [];

	for (const seg of segments) {
		// Segments are always lowercased here regardless of `caseInsensitive`:
		// the trigram index is itself lowercase, so a case-sensitive search still
		// queries with lowercase trigrams (then verifies case against real files).
		const effective = seg.toLowerCase();
		if (effective.length >= 3) {
			literalSegments.push(effective);
			for (const tri of extractTrigrams(effective)) {
				allTrigrams.add(tri);
			}
		}
	}

	return {
		requiredTrigrams: [...allTrigrams],
		literalSegments,
		hasLiterals: allTrigrams.size > 0,
		isLiteral: false,
		trigramSequences: literalSegments
			.map((seg) => orderedTrigrams(seg))
			.filter((seq) => seq.length >= 2),
	};
}

/**
 * Split a regex string at top-level alternation operators (|).
 * Respects group nesting — | inside (...) is not a split point.
 */
function splitAlternation(pattern: string): string[] {
	const branches: string[] = [];
	let current = "";
	let depth = 0;
	let i = 0;

	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "\\") {
			current += ch + (pattern[i + 1] || "");
			i += 2;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === "|" && depth === 0) {
			branches.push(current);
			current = "";
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	branches.push(current);
	return branches;
}

/**
 * Intersect required trigrams across the top-level alternation branches of a
 * pattern: a trigram is required only if EVERY branch requires it. Extracted
 * from decomposePattern's alternation handling — nesting resets to 0 here,
 * where in the caller it was four levels deep. Short-circuits once the
 * running intersection is empty (nothing left that could be required); each
 * branch's literal segments are still collected regardless — they're
 * informational only, the trigram set is the actual requirement gate.
 */
function intersectBranchTrigrams(
	branches: string[],
	caseInsensitive: boolean,
): { trigrams: Set<number>; segments: string[] } {
	let commonTrigrams: Set<number> | null = null;
	const segments: string[] = [];

	for (const branch of branches) {
		const branchResult = decomposePattern(branch, true, caseInsensitive);
		const branchTris = new Set(branchResult.requiredTrigrams);

		if (commonTrigrams === null) {
			commonTrigrams = branchTris;
		} else {
			commonTrigrams = intersectTrigramSets(commonTrigrams, branchTris);
		}
		segments.push(...branchResult.literalSegments);

		if (commonTrigrams.size === 0) break; // no intersection possible
	}

	return { trigrams: commonTrigrams ?? new Set<number>(), segments };
}

/** Trigrams present in both sets — the nested-loop intersection that used to sit inside intersectBranchTrigrams's loop body. */
function intersectTrigramSets(a: Set<number>, b: Set<number>): Set<number> {
	const result = new Set<number>();
	for (const t of a) {
		if (b.has(t)) result.add(t);
	}
	return result;
}

// ===========================================
// Ripgrep Command Parsing
// ===========================================
// Moved to ./regex-trigrams-grep-parse.ts (leaf cluster: consumes nothing
// from the decomposition side). Re-exported here to preserve the public API.
export { parseGrepCommand } from "./regex-trigrams-grep-parse.js";
