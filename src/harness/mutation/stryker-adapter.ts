// ===========================================
// Per-edit mutation — Stryker report adapter (build step 5, input bridge)
// ===========================================
// Converts a Stryker / mutation-testing-elements JSON report into RawMutants the
// identity layer can re-anchor. The report carries each file's `source`, so we
// compute the char offset + original lexeme from the mutant's 1-based line:col
// span. Pure + defensive (malformed files/mutants are skipped, not thrown).

import { isJsonObject } from "../../lib/json-types.js";
import type { MutantStatus, RawMutant, TestRunResult } from "./types.js";
import { mutantRawEvidence, preserveStrykerEvidence, type StrykerMutantEvidence, type StrykerReportEvidence } from "./stryker-evidence.js";

export interface AdaptedMutant {
    evidence?: StrykerMutantEvidence;
	raw: RawMutant;
	status: MutantStatus;
}

/**
 * What a {@link MutationRunner} returns for one edited file: the per-mutant
 * results plus the overlay test-run signal (spec §7). `testRun` is optional at
 * the TYPE level for wire compatibility, but under the strict evidence rules
 * (2026-08-28) an absent `testRun` — like an absent/non-zero `engineExitCode`
 * — evaluates as NOT-MEASURED: a mutants-only runner can still block on red
 * evidence, but it can never certify clean or adopt a baseline.
 */
export interface MutationRunOutput {
    reportEvidence?: StrykerReportEvidence;
	mutants: AdaptedMutant[];
	testRun?: TestRunResult;
	/** How many tests actually executed for this mutation run. A green boolean
	 * without a positive count is not proof that a test oracle ran; absent,
	 * malformed, or zero therefore remains incomplete evidence. */
	executedTestCount?: number | null;
	/** Evidence that cannot be represented by the legacy per-mutant input. */
	evidenceGaps?: readonly string[];
	/** Planned shards that did NOT report (sharded runs only). Non-zero means
	 *  `mutants` is a PARTIAL view: the gate must treat the run as
	 *  not-measured and never refresh the manifest from it — a missing shard's
	 *  survivors are exactly the ones a forged clean pass would hide
	 *  (external review 2026-08-23, second pass, finding 1). */
	incompleteShards?: number;
	/** Report rows for the TARGET file that could not be parsed into a mutant.
	 *  Non-zero means the census is short by that many and the run cannot certify
	 *  clean — see `AdaptedFile.dropped`. */
	droppedMutants?: number;
	/** The mutation engine's own process exit status, as recovered by the runner.
	 *  Goal 28 §8 requires "engine exit 0" as evidence, and the distinction the
	 *  producer draws must survive the trip: `0` means the engine finished,
	 *  non-zero means it failed and any report it left behind is partial, and
	 *  `null` means the status could not be recovered AT ALL — which is not the
	 *  same as success and must never collapse to 0. Absent means the runner
	 *  reported nothing about the engine, which is likewise not evidence of
	 *  success. Only `0` certifies. */
	engineExitCode?: number | null;
}

export interface AdaptedFile {
    reportEvidence?: StrykerReportEvidence;
	file: string;
	content: string;
	mutants: AdaptedMutant[];
	/** Rows the report contained that could NOT be parsed into a mutant.
	 *
	 *  Dropping them silently was the second-cheapest false clean in the system
	 *  and needed no adversary: one truncated `location.end` on the SURVIVING
	 *  mutants makes them vanish while the killed ones remain, so the run reads
	 *  as measured-and-clean. Counting the loss lets the evaluator refuse a run
	 *  it cannot fully account for (goal 28 §8, census). Parsing stays
	 *  defensive — this reports the loss, it does not throw. */
	dropped: number;
}

function str(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
	return typeof v === "number" ? v : null;
}

/** Map a Stryker mutant status onto the mechanical vocabulary (spec §8). */
export function mapStrykerStatus(status: string): MutantStatus {
	switch (status) {
		case "Killed":
			return "killed";
		case "Survived":
			return "survived";
		case "Timeout":
			return "timeout";
		case "NoCoverage":
			return "uncovered";
		default:
			return "indeterminate";
	}
}

/** 1-based line + 1-based column → 0-based char offset; a line past EOF clamps to length.
 *
 *  Kept exported and CLAMPING for reporting callers that want a best-effort
 *  offset behind a human-facing line reference. The PARSER deliberately no
 *  longer uses it: clamping is exactly what turned a malformed row into a
 *  plausible-looking mutant instead of a counted loss (see `resolveOffset`). */
export function lineColToOffset(content: string, line: number, column: number): number {
	let offset = 0;
	let currentLine = 1;
	while (currentLine < line) {
		const nl = content.indexOf("\n", offset);
		if (nl === -1) return content.length;
		offset = nl + 1;
		currentLine++;
	}
	return offset + (column - 1);
}

interface Position {
	line: number;
	column: number;
}

/** Offsets bounding 1-based `line`: its first character, and the position just
 *  past its last one (the newline, or EOF). Null when the line does not exist —
 *  the case `lineColToOffset` silently clamps away. */
function lineBounds(content: string, line: number): { start: number; end: number } | null {
	let start = 0;
	let current = 1;
	while (current < line) {
		const nl = content.indexOf("\n", start);
		if (nl === -1) return null;
		start = nl + 1;
		current++;
	}
	const nl = content.indexOf("\n", start);
	return { start, end: nl === -1 ? content.length : nl };
}

/**
 * A report position → its char offset, or null when the position does not exist
 * in this source.
 *
 * The `null` return is the whole point. `lineColToOffset` clamps a past-EOF line
 * to `content.length` and happily adds an out-of-range column, so every
 * malformed span still produced an offset — and therefore a PARSED mutant with a
 * bogus lexeme — rather than incrementing `dropped`. That is the same false
 * clean the census guard exists to refuse, arriving through the one door the
 * census could not see: it only counts rows it RECOGNIZED as malformed.
 *
 * A column may point one past the line's last character (an exclusive end
 * landing on the newline) but no further: beyond that the offset walks onto a
 * later line and the slice describes text the engine never mutated.
 */
function resolveOffset(content: string, pos: Position): number | null {
	const bounds = lineBounds(content, pos.line);
	if (bounds === null) return null;
	const offset = bounds.start + (pos.column - 1);
	return offset <= bounds.end ? offset : null;
}

/** A 1-based report coordinate: an INTEGER >= 1, or null. Zero, negative, and
 *  fractional values are all arithmetically usable by the offset math, so
 *  without this test they became mutants at a wrong (or negative) offset. */
function coordinate(v: unknown): number | null {
	const n = num(v);
	if (n === null || !Number.isInteger(n) || n < 1) return null;
	return n;
}

function parsePosition(v: unknown): Position | null {
	if (!isJsonObject(v)) return null;
	const line = coordinate(v.line);
	const column = coordinate(v.column);
	return line !== null && column !== null ? { line, column } : null;
}

/** One report row → an adapted mutant, or null when the row cannot be trusted to
 *  describe a real span in `content`. Every null here is counted as `dropped`. */
function parseOneMutant(file: string, content: string, raw: unknown): AdaptedMutant | null {
	if (!isJsonObject(raw)) return null;
	const mutator = str(raw.mutatorName);
	const replacement = str(raw.replacement);
	const status = str(raw.status);
	if (mutator === null || replacement === null || status === null) return null;
	const location = isJsonObject(raw.location) ? raw.location : null;
	const start = location ? parsePosition(location.start) : null;
	const end = location ? parsePosition(location.end) : null;
	if (start === null || end === null) return null;
	const startOffset = resolveOffset(content, start);
	const endOffset = resolveOffset(content, end);
	if (startOffset === null || endOffset === null) return null;
	// Offsets are monotonic in (line, column) because a column is bounded by its
	// own line, so this ONE comparison covers both "end is before start" and "the
	// span has negative length" — they are the same defect measured two ways.
	if (endOffset < startOffset) return null;
	return {
		raw: { file, mutator, originalLexeme: content.slice(startOffset, endOffset), replacement, startOffset },
		status: mapStrykerStatus(status),
        evidence: mutantRawEvidence(raw),
	};
}

function parseMutants(
	file: string,
	content: string,
	raws: unknown[],
): { mutants: AdaptedMutant[]; dropped: number } {
	const out: AdaptedMutant[] = [];
	let dropped = 0;
	for (const raw of raws) {
		const mutant = parseOneMutant(file, content, raw);
		if (mutant === null) dropped++;
		else out.push(mutant);
	}
	return { mutants: out, dropped };
}

/** Parse a Stryker JSON report into per-file adapted mutants, or null if unrecognisable. */
export function strykerToAdapted(report: unknown): AdaptedFile[] | null {
	if (!isJsonObject(report) || !isJsonObject(report.files)) return null;
	const out: AdaptedFile[] = [];
    const reportEvidence = preserveStrykerEvidence(report);
	for (const [file, fileResult] of Object.entries(report.files)) {
		if (!isJsonObject(fileResult)) continue;
		const content = str(fileResult.source);
		if (content === null || !Array.isArray(fileResult.mutants)) continue;
		const parsed = parseMutants(file, content, fileResult.mutants);
		out.push({ file, content, mutants: parsed.mutants, dropped: parsed.dropped, reportEvidence });
	}
	return out;
}
