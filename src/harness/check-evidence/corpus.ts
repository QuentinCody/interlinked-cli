// Check Evidence Contract — corpus dogfood records.
//
// Spec: docs/design/verification-density-program.md (Phase 2).
//
// Hand-authored fixtures only cover the false positives the detector's author
// already imagined; the FPs that hurt in production are the shapes nobody
// thought of. The corpus obligation closes that: a detector must be run across
// the real working tree, and every hit must be ADJUDICATED as either
//
//   true_positive  = a real bug. Fix it. (This is how `nan_coercion_guard`
//                    shipped: 2 real instances found in sponsor/types.ts.)
//   false_positive = a legitimate shape. It becomes a required negative case.
//
// An unadjudicated hit is the failure state: the detector fires on real code
// and nobody has decided whether that was correct.
//
// Note what a ZERO-hit corpus run does and does not prove. `introverted_test`
// reported 0/791 and that reads as clean, but it is indistinguishable from a
// detector that does not work at all. Zero hits satisfies this phase and hands
// the recall question to Phase 3 (detector mutation), the only thing that can
// answer it.

import { createHash } from "node:crypto";

/** One detector hit against real working-tree code. */
export interface CorpusHit {
	/** Repo-relative file path. */
	file: string;
	/** 1-based line number at scan time. */
	line: number;
	/** Trimmed source line text. */
	text: string;
}

/** How a human resolved one corpus hit. */
type Adjudication = "true_positive" | "false_positive";

/** A recorded verdict on one hit, keyed by the hit's stable signature. */
interface AdjudicationRecord {
	verdict: Adjudication;
	/** Why. Expected for `false_positive`, since it justifies a negative case. */
	note?: string;
}

/** One check's corpus run. */
export interface CorpusRecord {
	/** Files walked, so an empty scan is distinguishable from a clean one. */
	files_scanned: number;
	/** Stable signatures of every hit the run produced. */
	hits: string[];
	/** Signature to verdict. Every entry in `hits` must appear here. */
	adjudications: Record<string, AdjudicationRecord>;
}

/** The committed corpus store. */
export interface CorpusStore {
	version: 1;
	checks: Record<string, CorpusRecord>;
}

/** Repo-relative path of the committed corpus store. */
export const CHECK_CORPUS_PATH = ".interlinked/check-corpus.json";

/** An empty store, returned for a missing or malformed file. */
export const EMPTY_CORPUS: CorpusStore = { version: 1, checks: {} };

/**
 * Stable signature for a hit.
 *
 * Deliberately excludes the line number. An unrelated edit above the hit would
 * otherwise invalidate every adjudication in the file and demand a re-review of
 * work already done. File plus normalized line text is drift-resistant while
 * still distinguishing separate occurrences in the same file.
 */
export function hitSignature(hit: Pick<CorpusHit, "file" | "text">): string {
	const normalized = hit.text.trim().replace(/\s+/g, " ");
	return createHash("sha256").update(`${hit.file} ${normalized}`).digest("hex").slice(0, 16);
}

/** Hits in a record with no recorded verdict. This is the failure state. */
export function unadjudicatedHits(record: CorpusRecord): string[] {
	return record.hits.filter((sig) => !record.adjudications[sig]);
}

/** Signatures adjudicated as legitimate shapes. Each owes a negative test case. */
export function falsePositiveSignatures(record: CorpusRecord): string[] {
	return Object.entries(record.adjudications)
		.filter(([, a]) => a.verdict === "false_positive")
		.map(([sig]) => sig);
}

/** Adjudications naming a signature the run never produced. Stale, safe to drop. */
export function staleAdjudications(record: CorpusRecord): string[] {
	const live = new Set(record.hits);
	return Object.keys(record.adjudications).filter((sig) => !live.has(sig));
}

/** Whether a record satisfies the corpus obligation. */
export function corpusSatisfied(record: CorpusRecord | undefined): boolean {
	if (!record) return false;
	return unadjudicatedHits(record).length === 0;
}

/** Build a corpus record from a scan's raw hits, preserving existing verdicts. */
export function buildCorpusRecord(
	hits: readonly CorpusHit[],
	filesScanned: number,
	previous?: CorpusRecord,
): CorpusRecord {
	const signatures = [...new Set(hits.map(hitSignature))].sort();
	const adjudications: Record<string, AdjudicationRecord> = {};
	for (const sig of signatures) {
		const prior = previous?.adjudications[sig];
		if (prior) adjudications[sig] = prior;
	}
	return { files_scanned: filesScanned, hits: signatures, adjudications };
}

/** Narrow unknown JSON to a corpus record, discarding malformed parts. */
function parseRecord(raw: unknown): CorpusRecord | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const hits = Array.isArray(o.hits) ? o.hits.filter((h): h is string => typeof h === "string") : [];
	const filesScanned = typeof o.files_scanned === "number" ? o.files_scanned : 0;
	return {
		files_scanned: filesScanned,
		hits,
		adjudications: parseAdjudications(o.adjudications),
	};
}

/** Narrow the adjudication map, dropping entries with an unrecognized verdict. */
function parseAdjudications(raw: unknown): Record<string, AdjudicationRecord> {
	const out: Record<string, AdjudicationRecord> = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [sig, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const verdict = (value as { verdict?: unknown }).verdict;
		if (verdict !== "true_positive" && verdict !== "false_positive") continue;
		const note = (value as { note?: unknown }).note;
		out[sig] = { verdict, ...(typeof note === "string" ? { note } : {}) };
	}
	return out;
}

/** Narrow unknown JSON to the corpus store, failing closed to an empty store. */
export function parseCorpusStore(raw: unknown): CorpusStore {
	if (!raw || typeof raw !== "object") return EMPTY_CORPUS;
	const checks = (raw as { checks?: unknown }).checks;
	if (!checks || typeof checks !== "object") return EMPTY_CORPUS;
	const out: Record<string, CorpusRecord> = {};
	for (const [id, value] of Object.entries(checks as Record<string, unknown>)) {
		const record = parseRecord(value);
		if (record) out[id] = record;
	}
	return { version: 1, checks: out };
}
