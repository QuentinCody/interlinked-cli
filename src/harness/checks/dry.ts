// DRY -- Jaccard-similarity code-clone detector.
//
// Modeled on Uncle Bob's `dry4*` tooling: every function body is reduced to a
// set of token-shingles (overlapping n-grams of normalized tokens), and two
// functions are flagged as near-duplicates when their Jaccard similarity
//
//   J(A, B) = |A (intersect) B| / |A (union) B|
//
// meets or exceeds a threshold (default 0.82). Comments, strings and
// whitespace are stripped first (via `stripCommentsAndStrings`) so that the
// shingles describe code shape, not prose.
//
// This module is pure. The caller is responsible for I/O -- reading the edited
// file, gathering sibling-file content, and (for the harness PostToolUse path)
// snapshotting the pre-edit baseline. Keeping I/O out here means the same
// `findClones` fires at PostToolUse (diff-aware), and at `verify --all-checks`
// (whole-file hotspot list) without language coupling.
//
// Latency contract: this runs PostToolUse, per edit. `findClones` compares the
// edited file's functions against a *bounded* candidate set the caller passes
// in (other functions in the same file + functions in sibling files in the
// same directory). It is O(n*m) over that set -- never a whole-repo all-pairs
// scan. Functions shorter than `MIN_LOGICAL_LINES` logical lines are skipped
// outright: tiny functions collide on boilerplate shingles and are the
// dominant false-positive source.

import { nonNull } from "../../lib/non-null.js";
import type { FunctionComplexityEntry } from "./cyclomatic.js";
import { computeCyclomaticComplexity } from "./cyclomatic.js";
import { isTestFile, stripCommentsAndStrings } from "./shared.js";

// ==================================================================
// Tuning constants
// ==================================================================

/** Shingle width -- number of consecutive normalized tokens per n-gram. */
export const SHINGLE_N = 4;

/**
 * Jaccard similarity at/above which a pair of functions is reported.
 * 0.82 matches the `dry4*` default: high enough that near-identical bodies
 * fire while structurally-similar-but-distinct logic (different operators,
 * different call targets) stays below the line.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.82;

/**
 * Minimum logical (non-blank) body lines for a function to be eligible.
 * Functions below this are too small to form a meaningful clone -- a 2-line
 * getter or a one-line delegator collides with every other tiny function on
 * shared boilerplate shingles. Key false-positive guard.
 */
export const MIN_LOGICAL_LINES = 5;

/**
 * A function needs at least this many distinct shingles to be comparable.
 * Below this the Jaccard denominator is tiny and noise-dominated.
 */
const MIN_SHINGLES = 3;

// ==================================================================
// Public types
// ==================================================================

/** A function body reduced to its comparable shingle set. */
export interface FunctionShingles {
	/** Function name (from cyclomatic's extraction). */
	name: string;
	/** File the function lives in (absolute or repo-relative -- caller's choice). */
	file: string;
	/** 1-based declaration line. */
	line: number;
	/** Count of logical (non-blank) body lines. */
	logicalLines: number;
	/** Distinct token-shingle set. Empty when the function was too small. */
	shingles: Set<string>;
}

/** One near-duplicate pair surfaced by {@link findClones}. */
export interface CloneFinding {
	/** The edited-file function. */
	name: string;
	line: number;
	/** The matching function (same file or a sibling). */
	otherName: string;
	otherFile: string;
	otherLine: number;
	/** Jaccard similarity, 0..1, rounded to 2 decimals. */
	similarity: number;
}

/** Input bundle for {@link findClones}. */
export interface FindClonesInput {
	/** Functions extracted from the just-edited file. */
	edited: FunctionShingles[];
	/**
	 * Bounded candidate set: other functions to compare against. The caller
	 * assembles this from sibling files in the same directory. Functions from
	 * the edited file itself are compared internally and need NOT be repeated
	 * here (doing so is harmless -- self-pairs are skipped by identity).
	 */
	candidates: FunctionShingles[];
	/** Similarity cutoff; defaults to {@link DEFAULT_SIMILARITY_THRESHOLD}. */
	threshold?: number | undefined;
}

// ==================================================================
// Tokenization / shingling -- pure
// ==================================================================

// A token is an identifier/keyword/number run, or a single punctuation char.
// Splitting punctuation into individual tokens keeps operator shape in the
// shingle stream (so `a + b` and `a - b` differ) without exploding the
// vocabulary.
const TOKEN_RE = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s\w$]/g;

/**
 * Reduce a source fragment to a normalized token stream.
 * Public API -- exposed for tests and for callers that want to inspect the
 * intermediate representation.
 *
 * Comments and strings must already be stripped by the caller (use
 * `stripCommentsAndStrings`). Identifiers are kept verbatim -- renaming a
 * variable legitimately changes behavior-relevant shape, and normalizing all
 * identifiers to a placeholder would make every same-arity function look
 * identical (a large false-positive source).
 */
export function tokenize(fragment: string): string[] {
	return fragment.match(TOKEN_RE) ?? [];
}

/**
 * Build the set of n-gram shingles from a token stream.
 * Public API -- exposed for tests.
 *
 * Returns an empty set when there are fewer than `n` tokens.
 */
export function shingleSet(tokens: string[], n: number = SHINGLE_N): Set<string> {
	const set = new Set<string>();
	if (tokens.length < n) return set;
	for (let i = 0; i + n <= tokens.length; i++) {
		set.add(tokens.slice(i, i + n).join("\u0000"));
	}
	return set;
}

/**
 * Jaccard similarity between two shingle sets: |A (intersect) B| / |A (union) B|.
 * Public API -- exposed for tests. Returns 0 when either set is empty.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	// Iterate the smaller set for the intersection count.
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	let inter = 0;
	for (const s of small) {
		if (large.has(s)) inter++;
	}
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}

// ==================================================================
// Function extraction -- pure
// ==================================================================

/**
 * Extract per-function shingle sets from a file's content.
 * Public API -- consumed by the harness PostToolUse DRY block and by
 * `verify/file-checks.ts`.
 *
 * Reuses `computeCyclomaticComplexity` for function-boundary detection rather
 * than re-parsing -- it already handles JS/TS/Python/Go/Rust declaration shapes
 * and returns precise start/end lines. Functions shorter than
 * {@link MIN_LOGICAL_LINES} logical lines, or yielding fewer than
 * `MIN_SHINGLES` shingles, are returned with an empty `shingles` set so the
 * caller can filter them uniformly.
 *
 * Returns `[]` for unsupported extensions and test files (cyclomatic already
 * gates those).
 */
export function extractFunctionShingles(content: string, filePath: string): FunctionShingles[] {
	if (isTestFile(filePath)) return [];
	const fns = computeCyclomaticComplexity(content, filePath);
	if (fns.length === 0) return [];

	const strippedLines = stripCommentsAndStrings(content).split("\n");
	const out: FunctionShingles[] = [];
	for (const fn of fns) {
		out.push(buildEntry(fn, filePath, strippedLines));
	}
	return out;
}

function buildEntry(
	fn: FunctionComplexityEntry,
	filePath: string,
	strippedLines: string[],
): FunctionShingles {
	// fn.line / fn.endLine are 1-based and inclusive.
	const bodyLines = strippedLines.slice(fn.line - 1, fn.endLine);
	const logicalLines = bodyLines.filter((l) => l.trim() !== "").length;

	if (logicalLines < MIN_LOGICAL_LINES) {
		return emptyEntry(fn, filePath, logicalLines);
	}
	const shingles = shingleSet(tokenize(bodyLines.join("\n")));
	if (shingles.size < MIN_SHINGLES) {
		return emptyEntry(fn, filePath, logicalLines);
	}
	return { name: fn.name, file: filePath, line: fn.line, logicalLines, shingles };
}

function emptyEntry(
	fn: FunctionComplexityEntry,
	filePath: string,
	logicalLines: number,
): FunctionShingles {
	return {
		name: fn.name,
		file: filePath,
		line: fn.line,
		logicalLines,
		shingles: new Set<string>(),
	};
}

// ==================================================================
// Clone detection -- pure
// ==================================================================

/**
 * Find near-duplicate function pairs.
 * Public API -- consumed by `dry-baseline.ts` and the verify wiring.
 *
 * Compares (a) edited functions against each other, and (b) edited functions
 * against the bounded `candidates` set. O(n*(n+m)) over eligible functions
 * only -- functions with an empty shingle set (too small) are skipped before
 * any pairing, so the inner loop never touches them.
 *
 * Each edited function reports at most its single strongest match, so a
 * function duplicated three ways produces one finding, not three. Findings
 * are sorted by descending similarity.
 */
export function findClones(input: FindClonesInput): CloneFinding[] {
	const threshold = input.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
	const edited = input.edited.filter((e) => e.shingles.size > 0);
	const candidates = input.candidates.filter((c) => c.shingles.size > 0);

	const findings: CloneFinding[] = [];
	for (let i = 0; i < edited.length; i++) {
		const a = edited[i];
		let best: { other: FunctionShingles; sim: number } | null = null;

		// Returns the new best (or `current` unchanged) rather than mutating a
		// closed-over variable — a closure-side-effect assignment to `best`
		// isn't visible to the type checker's flow analysis at the `best !==
		// null` check below, which makes it think `best` is always `null`.
		const consider = (
			current: { other: FunctionShingles; sim: number } | null,
			b: FunctionShingles,
		): { other: FunctionShingles; sim: number } | null => {
			if (isSameFunction(nonNull(a), b)) return current;
			const sim = jaccard(nonNull(a).shingles, b.shingles);
			if (sim < threshold) return current;
			return !current || sim > current.sim ? { other: b, sim } : current;
		};

		// (a) other functions in the edited file -- only j>i so each unordered
		// pair is examined once.
		for (let j = i + 1; j < edited.length; j++) best = consider(best, nonNull(edited[j]));
		// (b) sibling-file candidates.
		for (const c of candidates) best = consider(best, c);

		if (best !== null) {
			const b: { other: FunctionShingles; sim: number } = best;
			findings.push({
				name: nonNull(a).name,
				line: nonNull(a).line,
				otherName: b.other.name,
				otherFile: b.other.file,
				otherLine: b.other.line,
				similarity: Math.round(b.sim * 100) / 100,
			});
		}
	}

	findings.sort((x, y) => y.similarity - x.similarity);
	return findings;
}

/** Identity check -- same file + same declaration line is the same function. */
function isSameFunction(a: FunctionShingles, b: FunctionShingles): boolean {
	return a.file === b.file && a.line === b.line;
}
