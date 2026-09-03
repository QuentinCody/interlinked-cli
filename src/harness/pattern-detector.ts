// ===========================================
// Pattern Detector — Statistical pattern analysis over error history
// ===========================================
// Four complementary detection systems, all deterministic/stats-based (no ML):
//
//   1. File-region hotspots — "lines 50-80 in this file have had 4 errors"
//   2. Cross-file edit pairs — "editing types.ts usually requires updating index.ts"
//   3. Temporal patterns  — "errors spike after bursts of rapid edits"
//   4. Tool-call sequences — "Read→Edit→Edit→Edit without tests → errors"
//
// All detectors operate over ErrorRecord[] and SessionTrajectory data.
// All output is info-severity warnings injected on PreToolUse.

// NOTE: All detectors are pure functions over arrays — no side effects, no I/O.
import { nonNull } from "../lib/non-null.js";
import { tallySequence } from "./pattern-detector-sequence-tally.js";
import { harnessNow } from "./replay/harness-clock.js";
import type { ErrorRecord, SessionTrajectory } from "./types.js";

// ===========================================
// 1. File-Region Hotspot Detection
// ===========================================
// Tracks line ranges of errors within files. If errors cluster in a specific
// region (e.g., lines 50-80), warn the agent when editing near that region.
//
// Uses a simple bucket approach: divide the file into 30-line windows,
// count errors per window, flag windows with 2+ errors.

interface RegionHotspot {
	file: string;
	lineStart: number;
	lineEnd: number;
	errorCount: number;
	checks: string[];
}

const REGION_WINDOW = 30;

/**
 * Find hot regions in a file's error history.
 * Returns regions with 2+ errors, sorted by error count descending.
 */
function findHotRegions(records: ErrorRecord[], file: string): RegionHotspot[] {
	const fileRecords = records.filter((r) => r.file === file && r.line_start !== undefined);
	if (fileRecords.length < 2) return [];

	// Bucket errors into 30-line windows
	const buckets = new Map<number, { count: number; checks: Set<string> }>();
	for (const r of fileRecords) {
		const bucket = Math.floor((r.line_start ?? 0) / REGION_WINDOW);
		const existing = buckets.get(bucket) || { count: 0, checks: new Set() };
		existing.count++;
		existing.checks.add(r.check_name);
		buckets.set(bucket, existing);
	}

	const hotspots: RegionHotspot[] = [];
	for (const [bucket, data] of buckets) {
		if (data.count >= 2) {
			hotspots.push({
				file,
				lineStart: bucket * REGION_WINDOW + 1,
				lineEnd: (bucket + 1) * REGION_WINDOW,
				errorCount: data.count,
				checks: [...data.checks],
			});
		}
	}

	return hotspots.sort((a, b) => b.errorCount - a.errorCount);
}

/**
 * Generate a warning if the edit target is near a hot region.
 * `editLine` is the approximate line being edited (from old_string position).
 */
function getHotRegionWarning(
	records: ErrorRecord[],
	file: string,
	editLine?: number,
): string | null {
	const hotspots = findHotRegions(records, file);
	if (hotspots.length === 0) return null;

	// If we know the edit line, only warn if it's in/near a hot region
	if (editLine !== undefined) {
		const nearHotspot = hotspots.find(
			(h) => editLine >= h.lineStart - 10 && editLine <= h.lineEnd + 10,
		);
		if (!nearHotspot) return null;
		return `[interlinked:hot-region] Lines ${nearHotspot.lineStart}-${nearHotspot.lineEnd} in this file have had ${nearHotspot.errorCount} check failures (${nearHotspot.checks.join(", ")}). This region is error-prone.`;
	}

	// No line info — warn about the hottest region
	const hottest = nonNull(hotspots[0]);
	return `[interlinked:hot-region] Lines ${hottest.lineStart}-${hottest.lineEnd} in this file have had ${hottest.errorCount} check failures (${hottest.checks.join(", ")}). Take extra care in this region.`;
}

// ===========================================
// 2. Cross-File Edit Pair Detection
// ===========================================
// Tracks which files are frequently edited together when errors occur.
// "Every time someone edits types.ts and forgets to update index.ts, errors happen."
//
// Builds a co-edit frequency table from error records' co_edited_files field.
// When an agent edits file A, checks if there's a strongly correlated file B
// that usually needs updating too.

interface EditPair {
	file: string;
	pairedFile: string;
	coOccurrences: number;
	totalErrors: number;
	ratio: number; // coOccurrences / totalErrors
}

/**
 * Find files that are frequently co-edited when errors occur on the given file.
 * Returns pairs where the co-edit ratio is >= 0.5 (the paired file appears
 * in 50%+ of error sessions for this file).
 */
function findEditPairs(records: ErrorRecord[], file: string): EditPair[] {
	const fileRecords = records.filter(
		(r) => r.file === file && r.co_edited_files && r.co_edited_files.length > 0,
	);
	if (fileRecords.length < 2) return [];

	// Count how often each co-edited file appears
	const coEditCounts = new Map<string, number>();
	for (const r of fileRecords) {
		// Filter above guarantees co_edited_files is present and non-empty.
		const coEdited = r.co_edited_files ?? [];
		for (const coFile of coEdited) {
			if (coFile === file) continue;
			coEditCounts.set(coFile, (coEditCounts.get(coFile) || 0) + 1);
		}
	}

	const pairs: EditPair[] = [];
	for (const [pairedFile, count] of coEditCounts) {
		const ratio = count / fileRecords.length;
		if (ratio >= 0.5 && count >= 2) {
			pairs.push({
				file,
				pairedFile,
				coOccurrences: count,
				totalErrors: fileRecords.length,
				ratio,
			});
		}
	}

	return pairs.sort((a, b) => b.ratio - a.ratio);
}

/**
 * Generate a warning if editing this file usually requires editing paired files.
 * `sessionWrittenFiles` is the set of files already edited in the current session.
 */
function getEditPairWarning(
	records: ErrorRecord[],
	file: string,
	sessionWrittenFiles: Set<string>,
): string | null {
	const pairs = findEditPairs(records, file);
	if (pairs.length === 0) return null;

	// Filter to pairs the agent hasn't visited yet
	const unvisited = pairs.filter((p) => !sessionWrittenFiles.has(p.pairedFile));
	if (unvisited.length === 0) return null;

	const top = unvisited.slice(0, 3);
	const fileList = top
		.map((p) => `${p.pairedFile} (${Math.round(p.ratio * 100)}% of the time)`)
		.join(", ");

	return `[interlinked:edit-pair] When this file has errors, these files usually need updating too: ${fileList}. Consider checking them.`;
}

// ===========================================
// 3. Temporal Pattern Detection
// ===========================================
// Detects time-based patterns in errors:
//   - Burst detection: many errors in a short time (agent may be thrashing)
//   - Recency weighting: recent errors matter more than old ones

interface TemporalStats {
	/** Errors in the last hour */
	lastHour: number;
	/** Errors in the last 4 hours */
	last4Hours: number;
	/** Errors in the last 24 hours */
	last24Hours: number;
	/** Errors total (within max_age) */
	total: number;
	/** Whether errors are accelerating (last hour > average hourly rate * 3) */
	isBurst: boolean;
	/** Average time between errors in seconds (0 if < 2 errors) */
	avgIntervalS: number;
}

/**
 * Compute temporal statistics for a file's error history.
 */
function getTemporalStats(records: ErrorRecord[], file: string): TemporalStats {
	const fileRecords = records
		.filter((r) => r.file === file)
		.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

	const now = harnessNow();
	const hourAgo = now - 60 * 60 * 1000;
	const fourHoursAgo = now - 4 * 60 * 60 * 1000;
	const dayAgo = now - 24 * 60 * 60 * 1000;

	const lastHour = fileRecords.filter((r) => new Date(r.timestamp).getTime() > hourAgo).length;
	const last4Hours = fileRecords.filter(
		(r) => new Date(r.timestamp).getTime() > fourHoursAgo,
	).length;
	const last24Hours = fileRecords.filter((r) => new Date(r.timestamp).getTime() > dayAgo).length;
	const total = fileRecords.length;

	// Calculate average interval between errors
	let avgIntervalS = 0;
	if (fileRecords.length >= 2) {
		const firstTime = new Date(nonNull(fileRecords[0]).timestamp).getTime();
		const lastTime = new Date(nonNull(fileRecords[fileRecords.length - 1]).timestamp).getTime();
		avgIntervalS = Math.round((lastTime - firstTime) / (fileRecords.length - 1) / 1000);
	}

	// Burst detection: last hour has 3x+ the average hourly rate
	const totalSpanHours =
		total > 0
			? Math.max(1, (now - new Date(nonNull(fileRecords[0]).timestamp).getTime()) / (60 * 60 * 1000))
			: 1;
	const avgHourlyRate = total / totalSpanHours;
	const isBurst = lastHour >= 3 && lastHour > avgHourlyRate * 3;

	return { lastHour, last4Hours, last24Hours, total, isBurst, avgIntervalS };
}

/**
 * Generate a temporal warning for a file.
 */
function getTemporalWarning(records: ErrorRecord[], file: string): string | null {
	const stats = getTemporalStats(records, file);
	if (stats.total < 2) return null;

	if (stats.isBurst) {
		return `[interlinked:error-burst] ${stats.lastHour} errors on this file in the last hour (${stats.total} total). Errors are accelerating — consider stepping back and re-reading the file from scratch.`;
	}

	if (stats.lastHour >= 2) {
		return `[interlinked:temporal] ${stats.lastHour} errors on this file in the last hour. Average interval: ${stats.avgIntervalS}s between errors.`;
	}

	return null;
}

// ===========================================
// 4. Tool-Call Sequence Pattern Detection
// ===========================================
// Tracks tool call sequences that historically lead to errors.
// Compares the agent's current sequence against pre-error patterns.
//
// Common anti-patterns:
//   - Multiple edits to same file without reading it first
//   - Many edits without running tests (Bash:npm test / Bash:npx vitest)
//   - Read → Edit → Edit → Edit without any Bash commands (no validation)

interface SequencePattern {
	/** Human-readable description of the anti-pattern */
	description: string;
	/** How often this pattern preceded an error */
	occurrences: number;
	/** Check types that followed this pattern */
	resultingChecks: string[];
}

/**
 * Analyze pre-error sequences to find recurring anti-patterns.
 * Returns patterns that appear 2+ times in the error history.
 */
function findSequencePatterns(records: ErrorRecord[]): SequencePattern[] {
	const withSequences = records.filter(
		(r) => r.pre_error_sequence && r.pre_error_sequence.length >= 3,
	);
	if (withSequences.length < 2) return [];

	// Extract features from each sequence
	const patternCounts = new Map<string, { count: number; checks: Set<string> }>();

	for (const r of withSequences) {
		const seq = r.pre_error_sequence!;
		const features = extractSequenceFeatures(seq);

		for (const feature of features) {
			const existing = patternCounts.get(feature) || { count: 0, checks: new Set() };
			existing.count++;
			existing.checks.add(r.check_name);
			patternCounts.set(feature, existing);
		}
	}

	const patterns: SequencePattern[] = [];
	for (const [description, data] of patternCounts) {
		if (data.count >= 2) {
			patterns.push({
				description,
				occurrences: data.count,
				resultingChecks: [...data.checks],
			});
		}
	}

	return patterns.sort((a, b) => b.occurrences - a.occurrences);
}

/**
 * Check the current tool sequence against known anti-patterns.
 * Returns a warning if the current sequence matches a pattern that
 * historically led to errors.
 */
function getSequenceWarning(records: ErrorRecord[], currentSequence: string[]): string | null {
	if (currentSequence.length < 3) return null;

	const currentFeatures = new Set(extractSequenceFeatures(currentSequence));
	if (currentFeatures.size === 0) return null;

	const patterns = findSequencePatterns(records);
	if (patterns.length === 0) return null;

	// Match current features against known anti-patterns
	for (const pattern of patterns) {
		if (currentFeatures.has(pattern.description)) {
			return `[interlinked:sequence-pattern] Your recent tool sequence matches a pattern that led to ${pattern.occurrences} previous error(s) (${pattern.resultingChecks.join(", ")}): ${pattern.description}`;
		}
	}

	return null;
}

/**
 * Extract high-level features from a tool call sequence.
 * These are the "patterns" we match against.
 */
function extractSequenceFeatures(sequence: string[]): string[] {
	const features: string[] = [];
	const { editCount, readCount, bashCount, maxConsecutiveEdits, editsSinceLastTest } =
		tallySequence(sequence);

	// Pattern: Multiple edits to same file without re-reading
	if (maxConsecutiveEdits >= 3) {
		features.push(
			`${maxConsecutiveEdits} consecutive edits to the same file without re-reading`,
		);
	}

	// Pattern: Many edits without running tests
	if (editsSinceLastTest >= 5) {
		features.push(`${editsSinceLastTest} edits without running tests`);
	}

	// Pattern: All edits, no reads (blind editing)
	if (editCount >= 3 && readCount === 0) {
		features.push(`${editCount} edits without any reads (blind editing)`);
	}

	// Pattern: No bash validation at all
	if (editCount >= 4 && bashCount === 0) {
		features.push(
			`${editCount} edits without any shell commands (no type-check, no lint, no tests)`,
		);
	}

	return features;
}

// ===========================================
// Unified Pattern Warning Generator
// ===========================================

/**
 * Run all four pattern detectors and return combined warnings.
 * Called from the evaluator on PreToolUse.
 */
export function getPatternWarnings(
	records: ErrorRecord[],
	file: string,
	session: SessionTrajectory,
	editLine?: number,
): string[] {
	const warnings: string[] = [];

	// 1. File-region hotspots
	const regionWarning = getHotRegionWarning(records, file, editLine);
	if (regionWarning) warnings.push(regionWarning);

	// 2. Cross-file edit pairs
	const pairWarning = getEditPairWarning(records, file, session.files_written);
	if (pairWarning) warnings.push(pairWarning);

	// 3. Temporal patterns
	const temporalWarning = getTemporalWarning(records, file);
	if (temporalWarning) warnings.push(temporalWarning);

	// 4. Tool-call sequence patterns
	const sequenceWarning = getSequenceWarning(records, session.tool_sequence);
	if (sequenceWarning) warnings.push(sequenceWarning);

	return warnings;
}
