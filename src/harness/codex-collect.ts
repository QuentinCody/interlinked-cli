// ===========================================
// Codex session collector — sync ~/.codex/sessions/ rollouts into the unified
// .interlinked/timeline.jsonl store (parity with the Claude live/backfill path).
// ===========================================
// Codex keeps its transcripts in a global, prunable dir; this folds them into
// the repo's normalized `timeline.v1` store so every model's input+output lives
// in ONE place (project ask 2026-07-18). Idempotent: dedup key `${uuid}#${seq}`
// means re-running only appends genuinely new records, so it is safe to call on
// a timer or after every `codex exec` review.

import { readdirSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileRange } from "../lib/bounded-file-io.js";
import { parseCodexRolloutText } from "./codex-rollout.js";
import {
	appendTimelineRecordsAtBasis,
	MAX_EXISTING_TIMELINE_KEYS,
	recordKey,
	removeExistingTimelineCandidates,
	serializeRecord,
	sortTimeline,
	TimelineScanError,
	type TimelineScanReceipt,
} from "./timeline-writer.js";
import type { TimelineRecord } from "./transcript-record.js";

/** A collection run is intentionally finite: the existing history is streamed,
 * while only this bounded set of new candidates is retained. */
const MAX_CODEX_COLLECTION_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_ROLLOUT_BYTES = 64 * 1024 * 1024;

/** Default Codex session root (`~/.codex/sessions`). */
export function codexSessionsDir(): string {
	return join(homedir(), ".codex", "sessions");
}

/** Directory entries, or null when the subtree is missing or unreadable. */
function readEntriesOrNull(dir: string): string[] | null {
	try {
		return readdirSync(dir);
	} catch {
		return null;
	}
}

/** `statSync` result, or null when the entry vanished or is unreadable. */
function statOrNull(path: string): Stats | null {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

/** A `rollout-*.jsonl` file, and (when `sinceMs` is set) modified at/after it. */
function isWantedRollout(
	name: string,
	st: Stats,
	sinceMs: number | undefined,
): boolean {
	if (!/^rollout-.*\.jsonl$/.test(name)) return false;
	return sinceMs === undefined || st.mtimeMs >= sinceMs;
}

/** All `rollout-*.jsonl` files under `dir` (recursive), optionally only those
 *  modified at/after `sinceMs`. Bounded, depth-first, never throws on a missing
 *  or unreadable subtree. */
export function findCodexRollouts(dir: string, sinceMs?: number): string[] {
	const out: string[] = [];
	const walk = (d: string, depth: number): void => {
		if (depth > 6) return; // .../YYYY/MM/DD/file — 4 is enough; 6 is slack
		const entries = readEntriesOrNull(d);
		if (entries === null) return;
		for (const name of entries) {
			const full = join(d, name);
			const st = statOrNull(full);
			if (st === null) continue;
			if (st.isDirectory()) walk(full, depth + 1);
			else if (isWantedRollout(name, st, sinceMs)) out.push(full);
		}
	};
	walk(dir, 0);
	return out;
}

interface CollectResult {
	/** Rollout files scanned. */
	files: number;
	/** Records parsed across all files (before dedup). */
	parsed: number;
	/** Genuinely-new records appended to the timeline. */
	added: number;
	/** Distinct Codex sessions represented in the appended records. */
	sessions: number;
}

interface CandidateBatch {
	records: Map<string, TimelineRecord>;
	bytes: number;
	parsed: number;
}

function readCodexRollout(path: string): TimelineRecord[] | null {
	try {
		const size = statSync(path).size;
		if (size > MAX_CODEX_ROLLOUT_BYTES) return null;
		return parseCodexRolloutText(
			readFileRange(path, 0, size, MAX_CODEX_ROLLOUT_BYTES).toString("utf8"),
		);
	} catch {
		return null;
	}
}

function addCandidateRecords(batch: CandidateBatch, records: TimelineRecord[]): void {
	batch.parsed += records.length;
	for (const record of records) {
		const key = recordKey(record);
		if (batch.records.has(key)) continue;
		const bytes = Buffer.byteLength(serializeRecord(record)) + 1;
		const overRecordLimit = batch.records.size >= MAX_EXISTING_TIMELINE_KEYS;
		const overByteLimit = batch.bytes + bytes > MAX_CODEX_COLLECTION_BYTES;
		if (overRecordLimit || overByteLimit) {
			throw new TimelineScanError(
				`Codex collection exceeds the bounded candidate limit (${MAX_EXISTING_TIMELINE_KEYS} records or ${MAX_CODEX_COLLECTION_BYTES} bytes)`,
			);
		}
		batch.records.set(key, record);
		batch.bytes += bytes;
	}
}

function finishCollection(
	options: {
		records: TimelineRecord[];
		cwd: string;
		basis: TimelineScanReceipt;
		dryRun: boolean;
	},
): void {
	const { records, cwd, basis, dryRun } = options;
	if (!appendTimelineRecordsAtBasis({ records: sortTimeline(records), cwd, basis, dryRun })) {
		throw new TimelineScanError(
			"timeline changed after collection scanned it; no Codex records were appended",
		);
	}
}

/**
 * Sync Codex rollouts into `<cwd>/.interlinked/timeline.jsonl`. Only records
 * whose `${uuid}#${seq}` key is not already present are appended (dedup against
 * both the existing file and within this batch). Historical keys are streamed
 * against the bounded candidate map rather than retained. `dryRun` reports
 * counts without writing. Bad rollout files are skipped; an unreadable or
 * corrupt destination timeline throws so history can never be duplicated.
 */
export function collectCodexSessions(opts: {
	cwd: string;
	dir?: string;
	sinceMs?: number;
	dryRun?: boolean;
}): CollectResult {
	const dir = opts.dir ?? codexSessionsDir();
	const files = findCodexRollouts(dir, opts.sinceMs);
	const batch: CandidateBatch = { records: new Map(), bytes: 0, parsed: 0 };
	for (const f of files) {
		const records = readCodexRollout(f);
		if (records !== null) addCandidateRecords(batch, records);
	}
	const basis = removeExistingTimelineCandidates(opts.cwd, batch.records);
	const toAppend = [...batch.records.values()];
	const sessions = new Set(toAppend.map((record) => record.session));
	finishCollection({
		records: toAppend,
		cwd: opts.cwd,
		basis,
		dryRun: opts.dryRun === true,
	});
	return {
		files: files.length,
		parsed: batch.parsed,
		added: toAppend.length,
		sessions: sessions.size,
	};
}
