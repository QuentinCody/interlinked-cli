// ===========================================
// Edit Diagnostics — Near-miss span finder for failed Edit operations
// ===========================================
// When Edit fails because old_string was not found, the model has to guess
// or re-Read the whole file. This module finds the closest fuzzy-matching
// spans so the harness can return them as additionalContext, converting a
// dead round-trip into a fix.

import { nonNull } from "../lib/non-null.js";

interface NearMiss {
	/** 1-based line number of the matching span's first line */
	line: number;
	/** 1-based line number of the matching span's last line */
	endLine: number;
	/** First line of the matched span (trimmed, truncated to 120 chars) */
	snippet: string;
	/** The matched span verbatim — exact whitespace, one entry per line */
	lines: string[];
	/** Similarity score 0..1 (higher = closer match) */
	similarity: number;
}

/**
 * Find the top-N spans in `content` most similar to `target`.
 *
 * Algorithm: sliding window over file lines of the same line count as target,
 * scored by averaged Sørensen-Dice bigram similarity per line.
 *
 * Returns spans with similarity >= MIN_SIMILARITY, deduplicated so overlapping
 * windows collapse to the highest-scoring one.
 */
export function findClosestSpans(content: string, target: string, n = 3): NearMiss[] {
	if (!target || !content) return [];
	const targetLines = target.split("\n");
	const fileLines = content.split("\n");
	if (fileLines.length < targetLines.length) return [];

	// Heuristic: very short targets (single short line) get fuzzy matched
	// against single lines anywhere in the file rather than windowed.
	const targetIsShortSingleLine = targetLines.length === 1 && target.trim().length < 40;

	const candidates: NearMiss[] = [];
	const windowSize = targetLines.length;

	for (let i = 0; i + windowSize <= fileLines.length; i++) {
		const windowLines = fileLines.slice(i, i + windowSize);
		const sim = windowSimilarity(targetLines, windowLines);
		if (sim < MIN_SIMILARITY) continue;
		candidates.push({
			line: i + 1,
			endLine: i + windowSize,
			snippet: nonNull(windowLines[0]).trim().slice(0, 120),
			lines: windowLines,
			similarity: sim,
		});
	}

	// For very short single-line targets, also scan all lines (in case the
	// match is at a line whose trimmed length differs significantly).
	if (targetIsShortSingleLine && candidates.length < n) {
		for (const [i, fileLine] of fileLines.entries()) {
			const sim = lineSimilarity(target, fileLine);
			if (sim < MIN_SIMILARITY) continue;
			if (candidates.some((c) => c.line === i + 1)) continue;
			candidates.push({
				line: i + 1,
				endLine: i + 1,
				snippet: fileLine.trim().slice(0, 120),
				lines: [fileLine],
				similarity: sim,
			});
		}
	}

	candidates.sort((a, b) => b.similarity - a.similarity);

	// Dedupe: collapse overlapping windows to the highest-scoring one
	const dedup: NearMiss[] = [];
	for (const c of candidates) {
		const overlap = dedup.some((d) => Math.abs(d.line - c.line) < Math.max(windowSize, 2));
		if (overlap) continue;
		dedup.push(c);
		if (dedup.length >= n) break;
	}
	return dedup;
}

/**
 * Format near-miss results as a multi-line hint suitable for warning text.
 * Empty string if no misses (caller can branch on truthy).
 */
export function formatNearMisses(misses: NearMiss[]): string {
	if (misses.length === 0) return "";
	return misses
		.map((m) => `  L${m.line} (${Math.round(m.similarity * 100)}% match): ${m.snippet}`)
		.join("\n");
}

// ===========================================
// Internals
// ===========================================

const MIN_SIMILARITY = 0.4;

function windowSimilarity(target: string[], window: string[]): number {
	if (target.length !== window.length) return 0;
	let total = 0;
	for (const [i, targetLine] of target.entries()) {
		total += lineSimilarity(targetLine, nonNull(window[i]));
	}
	return total / target.length;
}

function lineSimilarity(a: string, b: string): number {
	const ta = a.trim();
	const tb = b.trim();
	if (ta === tb) return 1;
	if (!ta && !tb) return 1;
	if (!ta || !tb) return 0;
	const bigA = bigrams(ta);
	const bigB = bigrams(tb);
	if (bigA.size === 0 || bigB.size === 0) return ta === tb ? 1 : 0;
	let intersect = 0;
	for (const g of bigA) if (bigB.has(g)) intersect++;
	return (2 * intersect) / (bigA.size + bigB.size);
}

function bigrams(s: string): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i < s.length - 1; i++) {
		out.add(s.slice(i, i + 2));
	}
	return out;
}

// ===========================================
// One-round-trip rescue rendering (LG-1)
// ===========================================
// The near-miss hint used to name line ranges and force a re-read. These
// helpers render the best span's CURRENT content verbatim — exact whitespace,
// fenced, line numbers kept OUTSIDE the fence (models echo displayed prefixes
// into edit payloads) — so the retry can copy an exact old_string directly.

const MAX_RESCUE_LINES = 40;
const MAX_RESCUE_BYTES = 3000;
const RESCUE_EDGE_LINES = 15;

/** A fence the span cannot break out of: ``` unless the span contains one. */
function fenceFor(lines: string[]): string {
	return lines.some((l) => l.trimStart().startsWith("```")) ? "~~~~" : "```";
}

/** 1-based index (into `spanLines`) of the first line differing from `target`,
 *  or null when no line-wise divergence is visible (e.g. identical prefix). */
export function firstDivergenceLine(target: string, spanLines: string[]): number | null {
	const targetLines = target.split("\n");
	const max = Math.max(targetLines.length, spanLines.length);
	for (let i = 0; i < max; i++) {
		if (targetLines[i] !== spanLines[i]) return i + 1;
	}
	return null;
}

/** The span body, capped to MAX_RESCUE_LINES/MAX_RESCUE_BYTES with head+tail
 *  elision so a huge old_string cannot balloon the block reason. */
function cappedSpanLines(lines: string[]): string[] {
	const byteLength = lines.reduce((n, l) => n + l.length + 1, 0);
	if (lines.length <= MAX_RESCUE_LINES && byteLength <= MAX_RESCUE_BYTES) return lines;
	const head = lines.slice(0, RESCUE_EDGE_LINES);
	const tail = lines.slice(-RESCUE_EDGE_LINES);
	const elided = lines.length - head.length - tail.length;
	return [...head, `… (${elided} lines elided) …`, ...tail];
}

/**
 * Render the rescue block for a failed anchor: best span verbatim + runner-up
 * references. `target` (the old_string that missed) drives the divergence note.
 * Empty string when there are no misses (caller branches on truthy).
 */
export function formatRescue(misses: NearMiss[], target: string): string {
	const best = misses[0];
	if (!best) return "";
	const fence = fenceFor(best.lines);
	const out: string[] = [];
	const range = best.line === best.endLine ? `line ${best.line}` : `lines ${best.line}–${best.endLine}`;
	out.push(
		`Closest match — ${range} (${Math.round(best.similarity * 100)}% similar). ` +
			`Current file content for that range — copy it EXACTLY (including whitespace) as your old_string:`,
	);
	out.push(fence, ...cappedSpanLines(best.lines), fence);
	const divergence = firstDivergenceLine(target, best.lines);
	if (divergence !== null && best.lines.length > 1) {
		out.push(`First line differing from your old_string: line ${best.line + divergence - 1}.`);
	}
	const runnersUp = misses.slice(1);
	if (runnersUp.length > 0) {
		out.push(
			`Also similar: ${formatNearMisses(runnersUp)
				.split("\n")
				.map((s) => s.trim())
				.join("; ")}`,
		);
	}
	return out.join("\n");
}

/** The PostToolUse near-miss warning body — shared with the PreToolUse block
 *  reason so both failure paths teach with the same one-round-trip material. */
export function buildNearMissWarning(filePath: string, misses: NearMiss[], target: string): string {
	return (
		`[interlinked:edit-near-miss] old_string not found in ${filePath}. ` +
		`The file content differs from what this edit expected.\n${formatRescue(misses, target)}\n` +
		`Retry with the exact current text — no re-read needed.`
	);
}

/** Count non-overlapping exact occurrences of `target` in `content`. */
export function countOccurrences(content: string, target: string): number {
	if (!target) return 0;
	let count = 0;
	let at = content.indexOf(target);
	while (at !== -1) {
		count++;
		at = content.indexOf(target, at + target.length);
	}
	return count;
}

/** 1-based start line of each non-overlapping exact occurrence of `target`. */
export function findOccurrenceLines(content: string, target: string): number[] {
	if (!target) return [];
	const lines: number[] = [];
	let at = content.indexOf(target);
	while (at !== -1) {
		let line = 1;
		for (let i = 0; i < at; i++) if (content.charCodeAt(i) === 10) line++;
		lines.push(line);
		at = content.indexOf(target, at + target.length);
	}
	return lines;
}

const UNIQUE_ANCHOR_MAX_EXTRA_LINES = 3;

/** Extend `target` by following (then preceding) full lines from its first
 *  occurrence until the extended string is unique in `content`. Returns the
 *  unique anchor, or null when ≤1 occurrence exists or extension can't
 *  disambiguate within UNIQUE_ANCHOR_MAX_EXTRA_LINES. */
export function suggestUniqueAnchor(content: string, target: string): string | null {
	if (countOccurrences(content, target) <= 1) return null;
	const start = content.indexOf(target);
	const suffix = extendUntilUnique(content, target, start, "forward");
	if (suffix) return suffix;
	return extendUntilUnique(content, target, start, "backward");
}

function extendUntilUnique(
	content: string,
	target: string,
	start: number,
	direction: "forward" | "backward",
): string | null {
	let lo = start;
	let hi = start + target.length;
	for (let extra = 0; extra < UNIQUE_ANCHOR_MAX_EXTRA_LINES; extra++) {
		if (direction === "forward") {
			const nextNl = content.indexOf("\n", hi);
			if (nextNl === -1) return null;
			hi = nextNl + 1;
			const lineEnd = content.indexOf("\n", hi);
			hi = lineEnd === -1 ? content.length : lineEnd;
		} else {
			const prevNl = content.lastIndexOf("\n", lo - 2);
			if (lo <= 0 || prevNl === -1) return null;
			lo = prevNl + 1;
		}
		const candidate = content.slice(lo, hi);
		if (countOccurrences(content, candidate) === 1) return candidate;
	}
	return null;
}
