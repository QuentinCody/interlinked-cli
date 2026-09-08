import { nonNull } from "../lib/non-null.js";
import { existsSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findLineBoundaryAtOrBefore, readFileRange } from "../lib/bounded-file-io.js";
import { getDataDir } from "../lib/config.js";
import type { FileIdentity } from "../lib/file-suffix-replacement.js";
import { isJsonObject } from "../lib/json-types.js";

export const BYTES_PER_MB = 1024 * 1024;
export const MAX_ARCHIVE_MANIFEST_BYTES = 16 * 1024 * 1024;
const ARCHIVE_SEGMENT_FILE_RE = /^(activity|collection|timeline)-(\d{4,})\.jsonl\.gz$/;
type ArchiveLogName = "activity" | "collection" | "timeline";

export function readArchiveManifestJson(path: string): unknown {
	const bytes = statSync(path).size;
	if (bytes > MAX_ARCHIVE_MANIFEST_BYTES) {
		throw new Error(
			`archive manifest ${path} is ${bytes} bytes (limit ${MAX_ARCHIVE_MANIFEST_BYTES})`,
		);
	}
	return JSON.parse(
		readFileRange(path, 0, bytes, MAX_ARCHIVE_MANIFEST_BYTES).toString("utf8"),
	);
}

export interface ArchiveSegment {
	seq: number;
	file: string;
	bytes: number;
	gz_bytes: number;
	records: number;
	created_at: string;
	/** True when this row was reconstructed from the filename after the index
	 * was lost. Its byte/record/time metadata is unknown rather than measured. */
	recovered?: boolean;
	pending_live_drop?: PendingLiveDrop;
}

export interface PendingLiveDrop {
	cut_bytes: number;
	source: FileIdentity;
	replacement: FileIdentity;
	synced_through_bytes?: number;
}

export interface ArchiveManifest {
	version: 1;
	segments: ArchiveSegment[];
}

function validArchiveCounts(
	seq: number,
	bytes: number,
	gzBytes: number,
	records: number,
): boolean {
	return (
		Number.isSafeInteger(seq) &&
		seq > 0 &&
		Number.isSafeInteger(bytes) &&
		bytes >= 0 &&
		Number.isSafeInteger(gzBytes) &&
		gzBytes >= 0 &&
		Number.isSafeInteger(records) &&
		records >= 0
	);
}

function matchesArchiveFile(file: string, seq: number, expectedLog?: ArchiveLogName): boolean {
	const match = ARCHIVE_SEGMENT_FILE_RE.exec(file);
	if (!match) return false;
	if (expectedLog !== undefined && match[1] !== expectedLog) return false;
	return Number.parseInt(nonNull(match[2]), 10) === seq;
}

function parseFileIdentity(value: unknown): FileIdentity | null {
	if (!isJsonObject(value)) return null;
	if (typeof value.dev !== "string" || typeof value.ino !== "string") return null;
	if (value.dev.length === 0 || value.ino.length === 0) return null;
	return { dev: value.dev, ino: value.ino };
}

function parseOptionalCursor(value: unknown): number | null | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
	return value;
}

function parsePendingLiveDrop(value: unknown): PendingLiveDrop | null {
	if (!isJsonObject(value) || typeof value.cut_bytes !== "number") return null;
	if (!Number.isSafeInteger(value.cut_bytes) || value.cut_bytes <= 0) return null;
	const source = parseFileIdentity(value.source);
	const replacement = parseFileIdentity(value.replacement);
	if (!source || !replacement) return null;
	const cursor = parseOptionalCursor(value.synced_through_bytes);
	if (cursor === null) return null;
	return {
		cut_bytes: value.cut_bytes,
		source,
		replacement,
		...(cursor === undefined ? {} : { synced_through_bytes: cursor }),
	};
}

function attachPendingLiveDrop(segment: ArchiveSegment, raw: unknown): ArchiveSegment | null {
	if (raw === undefined) return segment;
	const pending = parsePendingLiveDrop(raw);
	return pending ? { ...segment, pending_live_drop: pending } : null;
}

/** The one manifest-segment parser shared by activity and plain-log manifests. */
export function parseArchiveSegment(
	value: unknown,
	expectedLog?: ArchiveLogName,
): ArchiveSegment | null {
	if (!isJsonObject(value)) return null;
	const { seq, file, bytes, gz_bytes, records, created_at } = value;
	if (typeof seq !== "number" || typeof file !== "string") return null;
	if (typeof bytes !== "number" || typeof gz_bytes !== "number") return null;
	if (typeof records !== "number" || typeof created_at !== "string") return null;
	if (!validArchiveCounts(seq, bytes, gz_bytes, records)) return null;
	if (!matchesArchiveFile(file, seq, expectedLog)) return null;
	const recovered = value.recovered === true ? { recovered: true as const } : {};
	return attachPendingLiveDrop(
		{ seq, file, bytes, gz_bytes, records, created_at, ...recovered },
		value.pending_live_drop,
	);
}

export const PLAIN_COMPACTABLE_LOGS = ["collection", "timeline"] as const;
export type PlainLogName = (typeof PLAIN_COMPACTABLE_LOGS)[number];

export interface PlainCompactResult {
	log: PlainLogName;
	compacted: boolean;
	reason?: string;
	segment?: string;
	archived_bytes: number;
	archived_records: number;
	gz_bytes: number;
	live_after_bytes: number;
}

function plainManifestPath(log: PlainLogName, cwd: string): string {
	return join(getDataDir(cwd), "archive", `manifest-${log}.json`);
}

export function loadPlainManifest(
	log: PlainLogName,
	cwd: string = process.cwd(),
): ArchiveManifest {
	const path = plainManifestPath(log, cwd);
	if (!existsSync(path)) return { version: 1, segments: [] };
	try {
		const parsed = readArchiveManifestJson(path);
		if (!isJsonObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.segments)) {
			return { version: 1, segments: [] };
		}
		const segments: ArchiveSegment[] = [];
		for (const entry of parsed.segments) {
			const segment = parseArchiveSegment(entry, log);
			if (!segment) return { version: 1, segments: [] };
			segments.push(segment);
		}
		return { version: 1, segments };
	} catch {
		return { version: 1, segments: [] };
	}
}

function rebuildPlainManifestFromDisk(log: PlainLogName, cwd: string): ArchiveManifest {
	const archiveDir = join(getDataDir(cwd), "archive");
	const segments: ArchiveSegment[] = [];
	try {
		const pattern = new RegExp(`^${log}-(\\d{4,})\\.jsonl\\.gz$`);
		for (const name of readdirSync(archiveDir)) {
			const match = pattern.exec(name);
			if (!match) continue;
			// SAFETY: the capture group is digits, so it is present and numeric.
			const seq = Number.parseInt(nonNull(match[1]), 10);
			if (!Number.isFinite(seq)) continue;
			let gzBytes = 0;
			try {
				gzBytes = statSync(join(archiveDir, name)).size;
			} catch {
				/* unreadable stat: retain the self-describing segment row */
			}
			segments.push({
				seq,
				file: name,
				bytes: 0,
				gz_bytes: gzBytes,
				records: 0,
				created_at: "",
				recovered: true,
			});
		}
	} catch {
		/* no archive directory yet */
	}
	segments.sort((a, b) => a.seq - b.seq);
	return { version: 1, segments };
}

/** Rebuild a present-but-unreadable index from self-describing segment names. */
export function loadOrRebuildPlainManifest(
	log: PlainLogName,
	cwd: string,
): ArchiveManifest {
	if (!existsSync(plainManifestPath(log, cwd))) return { version: 1, segments: [] };
	const loaded = loadPlainManifest(log, cwd);
	if (loaded.segments.length > 0) return loaded;
	return rebuildPlainManifestFromDisk(log, cwd);
}

export function nextPlainSegmentSeq(
	log: PlainLogName,
	cwd: string,
	manifest: ArchiveManifest,
): number {
	let max = 0;
	for (const segment of manifest.segments) {
		if (segment.seq > max) max = segment.seq;
	}
	const archiveDir = join(getDataDir(cwd), "archive");
	try {
		const onDisk = new RegExp(`^${log}-(\\d{4,})\\.jsonl\\.gz$`);
		for (const name of readdirSync(archiveDir)) {
			const match = onDisk.exec(name);
			if (!match) continue;
			const seq = Number.parseInt(nonNull(match[1]), 10);
			if (Number.isFinite(seq) && seq > max) max = seq;
		}
	} catch {
		/* no archive directory yet; the manifest maximum stands */
	}
	return max + 1;
}

export interface PlainCut {
	cutByte: number;
	records: number;
}

export function planPlainCut(
	path: string,
	fileSize: number,
	keepRecentBytes: number,
): PlainCut {
	const limit = fileSize - keepRecentBytes;
	if (limit <= 0) return { cutByte: 0, records: 0 };
	const boundary = findLineBoundaryAtOrBefore(path, limit, true);
	return { cutByte: boundary.offset, records: boundary.records };
}

export function skippedPlainResult(
	log: PlainLogName,
	liveBytes: number,
	reason: string,
): PlainCompactResult {
	return {
		log,
		compacted: false,
		reason,
		archived_bytes: 0,
		archived_records: 0,
		gz_bytes: 0,
		live_after_bytes: liveBytes,
	};
}

export function writePlainManifest(
	log: PlainLogName,
	cwd: string,
	manifest: ArchiveManifest,
): void {
	const path = plainManifestPath(log, cwd);
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, JSON.stringify(manifest, null, 2));
	renameSync(temporary, path);
}

export function completePendingPlainEntry(
	log: PlainLogName,
	cwd: string,
	manifest: ArchiveManifest,
	segment: ArchiveSegment,
): void {
	delete segment.pending_live_drop;
	writePlainManifest(log, cwd, manifest);
}

export function pendingPlainResult(
	log: PlainLogName,
	segment: ArchiveSegment,
	liveBytes: number,
): PlainCompactResult {
	return {
		log,
		compacted: true,
		segment: segment.file,
		archived_bytes: segment.bytes,
		archived_records: segment.records,
		gz_bytes: segment.gz_bytes,
		live_after_bytes: liveBytes,
	};
}
