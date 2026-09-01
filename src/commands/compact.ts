// ===========================================
// interlinked compact — lossless gzip + rotation of activity.jsonl
// ===========================================
// The activity log is an append-only, full-fidelity capture (raw — redaction
// is egress-only). It grows without bound. `compact` reclaims disk losslessly:
// it gzips a SAFE PREFIX of activity.jsonl into a numbered archive segment,
// truncates the live file to the remainder, and adjusts the sync cursor. Every
// byte is preserved (recoverable by gunzipping the segments in manifest order).
//
// "Safe prefix" satisfies three invariants so nothing downstream breaks:
//   1. Cursor-safe — never archive past `synced_through_bytes`; the unsynced
//      tail stays live and the cursor is decremented by the archived bytes, so
//      batchSync keeps sending exactly the un-sent events.
//   2. Audit-safe — never archive past the START of the last hash-chained
//      record (guard_*/session_end). That record stays live, so the hook's
//      write-time `readPreviousGuardHash` (tail read) still finds the latest
//      hash and the chain continues unbroken across the boundary.
//   3. Line-aligned — the cut is always on a record boundary.
//
// `interlinked audit verify` reads archive segments (manifest order) before the
// live file, so the hash chain verifies end-to-end across compaction.
//
// WRITE ORDER: durable metadata precedes visibility and destruction. A complete
// temporary gzip is described by a durable rotation claim, then hard-linked to
// its final name, then indexed with a lowered sync cursor, and only THEN is the
// live prefix dropped under the shared append lock. Retry verifies the recorded
// source/prefix and gzip digest, so either pre-manifest or post-manifest crashes
// complete the same sequence instead of archiving its prefix twice.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command, OptionValues } from "commander";
import {
	findLineBoundaryAtOrBefore,
	gzipFileRange,
	MAX_CAPTURED_JSONL_LINE_BYTES,
	readFileRange,
	scanFileLines,
} from "../lib/bounded-file-io.js";
import { getDataDir } from "../lib/config.js";
import { fileIdentity } from "../lib/file-suffix-replacement.js";
import { c } from "../lib/formatter.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";

/** Record types that participate in the audit hash chain (mirror audit-chain.ts). */
const CHAINED_TYPES = new Set(["guard_block", "guard_warn", "guard_allow", "session_end"]);

/** Default: keep at least this many recent bytes live (recent reads + audit headroom). */
const DEFAULT_KEEP_RECENT_BYTES = 2 * 1024 * 1024;

import {
	compactPlainLog,
	PLAIN_COMPACTABLE_LOGS,
	type PlainCompactResult,
} from "./compact-plain.js";
import { MAX_SYNC_STATE_BYTES } from "../lib/local-activity-sync.js";
import {
	type ActivityRecoveryDeps,
	type ActivityRotationConflict,
	type ActivityRotationResult,
	resumePendingActivityRotation,
	rotateActivityPrefix,
} from "./compact-activity-write.js";
import {
	activityArchiveDir,
	activityManifestPath,
	loadOrRebuildArchiveManifest,
	nextActivitySegmentSeq,
} from "./compact-activity-manifest.js";
export type { ArchiveManifest, ArchiveSegment } from "./compact-plain.js";
export { loadArchiveManifest, loadOrRebuildArchiveManifest } from "./compact-activity-manifest.js";

interface PlanResult {
	cutByte: number; // bytes archived (prefix length)
	records: number; // records in the prefix
	liveAfter: number; // live file size after compaction
	reason?: string; // why nothing is archivable (when cutByte === 0)
}

interface ActivitySyncState {
	syncState: JsonObject;
	syncedBytes: number;
}

type ActivityEmitter = (data: JsonObject, human: string) => void;

function readActivitySyncState(path: string): ActivitySyncState {
	if (!existsSync(path)) return { syncState: {}, syncedBytes: 0 };
	try {
		const bytes = statSync(path).size;
		if (bytes > MAX_SYNC_STATE_BYTES) return { syncState: {}, syncedBytes: 0 };
		const syncState = JSON.parse(
			readFileRange(path, 0, bytes, MAX_SYNC_STATE_BYTES).toString("utf8"),
		);
		if (!isJsonObject(syncState)) return { syncState: {}, syncedBytes: 0 };
		const syncedBytes =
			typeof syncState.synced_through_bytes === "number"
				? syncState.synced_through_bytes
				: 0;
		return { syncState, syncedBytes };
	} catch {
		return { syncState: {}, syncedBytes: 0 };
	}
}

function invalidSyncCursorReason(syncedBytes: number, fileSize: number): string | undefined {
	if (!Number.isSafeInteger(syncedBytes) || syncedBytes < 0 || syncedBytes > fileSize) {
		return `sync cursor ${syncedBytes} is outside the live activity log (0..${fileSize}); cursor invalidated`;
	}
	return undefined;
}

function resumePendingActivity(
	deps: ActivityRecoveryDeps,
	dryRun: boolean,
	emit: ActivityEmitter,
): boolean {
	const pending = resumePendingActivityRotation(deps, dryRun);
	if (!pending) return false;
	emit(
		{
			compacted: pending.recovered,
			recovered: pending.recovered,
			segment: pending.segment.file,
			archived_bytes: pending.segment.bytes,
			live_after_bytes: pending.liveAfterBytes,
		},
		pending.recovered
			? `${c.green("✓ Recovered")} pending archive/${pending.segment.file} without creating a duplicate segment`
			: `${c.bold("Dry run")} — pending archive/${pending.segment.file} must be recovered before another compaction`,
	);
	return true;
}

function emitActivityRotation(
	rotation: ActivityRotationResult | ActivityRotationConflict,
	fileSize: number,
	emit: ActivityEmitter,
): void {
	if ("segmentFile" in rotation) {
		emit(
			{ compacted: false, segment: rotation.segmentFile, reason: rotation.reason },
			`${c.dim("Nothing compacted")} — ${rotation.reason}.`,
		);
		return;
	}
	const archived = rotation.segment;
	const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
	emit(
		{
			compacted: true,
			segment: archived.file,
			archived_bytes: archived.bytes,
			archived_records: archived.records,
			gz_bytes: archived.gz_bytes,
			live_after_bytes: rotation.liveAfterBytes,
			synced_through_bytes: rotation.syncedThroughBytes,
		},
		`${c.green("✓ Compacted")} ${mb(archived.bytes)}MB (${archived.records} records) → archive/${archived.file}\n` +
			`  gzipped to ${mb(archived.gz_bytes)}MB (${Math.round((1 - archived.gz_bytes / archived.bytes) * 100)}% smaller, lossless)\n` +
			`  live activity.jsonl: ${mb(fileSize)}MB → ${mb(rotation.liveAfterBytes)}MB\n` +
			`  ${c.dim(`recover: gunzip -c .interlinked/archive/${archived.file}  ·  audit verify reads archives automatically`)}`,
	);
}

function emitActivityDryRun(
	activityPath: string,
	plan: PlanResult,
	segmentFile: string,
	emit: ActivityEmitter,
): void {
	const gzBytes = gzipFileRange(activityPath, 0, plan.cutByte).gzipBytes;
	const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
	emit(
		{
			compacted: false,
			dry_run: true,
			would_archive_bytes: plan.cutByte,
			would_archive_records: plan.records,
			gz_bytes: gzBytes,
			live_after_bytes: plan.liveAfter,
			segment: segmentFile,
		},
		`${c.bold("Dry run")} — would archive ${mb(plan.cutByte)}MB (${plan.records} records) → ${segmentFile}\n` +
			`  gzipped: ${mb(gzBytes)}MB (${Math.round((1 - gzBytes / plan.cutByte) * 100)}% smaller)\n` +
			`  live activity.jsonl after: ${mb(plan.liveAfter)}MB`,
	);
}

/**
 * Find the safe cut point: the largest record-boundary offset that is
 * <= min(syncedBytes, fileSize - keepRecentBytes) AND <= the start of the last
 * hash-chained record.
 */
function planCut(
	path: string,
	fileSize: number,
	syncedBytes: number,
	keepRecentBytes: number,
	ignoreSync = false,
): PlanResult {
	let lastChainedStart = -1;
	scanFileLines(
		path,
		(line) => {
			if (!line.complete || !line.nonEmpty) return;
			// An over-cap row cannot be safely parsed. Treat it as a possible chain
			// link so boundedness can only reduce compaction, never archive past the
			// audit head the live writer needs.
			if (line.oversized || line.text === undefined) {
				lastChainedStart = line.start;
				return;
			}
			try {
				const rec = JSON.parse(line.text.trim());
				if (
					isJsonObject(rec) &&
					typeof rec.type === "string" &&
					CHAINED_TYPES.has(rec.type) &&
					typeof rec.hash === "string"
				) {
					lastChainedStart = line.start;
				}
			} catch {
				/* intentional: skip malformed line, keep scanning offsets */
			}
		},
		{
			endExclusive: fileSize,
			maxCapturedLineBytes: MAX_CAPTURED_JSONL_LINE_BYTES,
			includeFinalLine: false,
		},
	);

	const syncBound = ignoreSync ? fileSize : syncedBytes;
	let limit = Math.min(syncBound, fileSize - keepRecentBytes);
	if (lastChainedStart >= 0) limit = Math.min(limit, lastChainedStart);
	if (limit <= 0) {
		const reason =
			!ignoreSync && syncedBytes <= 0
				? "no synced data yet — pass --all to compact a local-only log"
				: fileSize - keepRecentBytes <= 0
					? `log is within the ${(keepRecentBytes / 1024 / 1024).toFixed(1)}MB recent-tail kept live`
					: "the pre-audit-tail region is empty";
		return { cutByte: 0, records: 0, liveAfter: fileSize, reason };
	}

	const boundary = findLineBoundaryAtOrBefore(path, limit, false);
	const cutByte = boundary.offset;
	if (cutByte <= 0) {
		return { cutByte: 0, records: 0, liveAfter: fileSize, reason: "first record exceeds the archivable region" };
	}
	return { cutByte, records: boundary.records, liveAfter: fileSize - cutByte };
}

/** The activity.jsonl compaction (sync-cursor + audit-chain constrained). */
async function compactActivityLog(opts: OptionValues): Promise<void> {
	const cwd = typeof opts.cwd === "string" ? opts.cwd : process.cwd();
	const isJson = Boolean(opts.json);
	const dryRun = Boolean(opts.dryRun);
	const keepRecentBytes =
		typeof opts.keepRecentBytes === "number" ? opts.keepRecentBytes : DEFAULT_KEEP_RECENT_BYTES;

	const dataDir = getDataDir(cwd);
	const activityPath = join(dataDir, "activity.jsonl");
	const syncStatePath = join(dataDir, "sync-state.json");
	const archiveDir = activityArchiveDir(cwd);
	const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

	const emit = (data: JsonObject, human: string) => {
		if (isJson) console.log(JSON.stringify(data, null, 2));
		else console.log(human);
	};

	if (!existsSync(activityPath)) {
		emit({ compacted: false, reason: "no activity.jsonl" }, c.dim("Nothing to compact — no activity.jsonl."));
		return;
	}

	const source = fileIdentity(activityPath);
	const fileSize = statSync(activityPath).size;

	const { syncState, syncedBytes } = readActivitySyncState(syncStatePath);
	if (
		resumePendingActivity(
			{
				activityPath,
				archiveDir,
				syncStatePath,
				manifestPath: activityManifestPath(cwd),
				syncState,
				loadManifest: () => loadOrRebuildArchiveManifest(cwd),
			},
			dryRun,
			emit,
		)
	) return;

	const ignoreSync = Boolean(opts.all);
	const invalidCursor = ignoreSync ? undefined : invalidSyncCursorReason(syncedBytes, fileSize);
	if (invalidCursor) {
		emit(
			{ compacted: false, file_bytes: fileSize, synced_bytes: syncedBytes, reason: invalidCursor },
			`${c.dim("Nothing safely compactable")} — ${invalidCursor}.`,
		);
		return;
	}
	const plan = planCut(activityPath, fileSize, syncedBytes, keepRecentBytes, ignoreSync);

	if (plan.cutByte <= 0) {
		emit(
			{ compacted: false, file_bytes: fileSize, synced_bytes: syncedBytes, reason: plan.reason },
			`${c.dim("Nothing safely compactable")} — ${plan.reason}.\n  ${c.dim(`log ${mb(fileSize)}MB, synced ${mb(syncedBytes)}MB`)}`,
		);
		return;
	}

	const manifest = loadOrRebuildArchiveManifest(cwd);
	const seq = nextActivitySegmentSeq(cwd, manifest);
	const segmentFile = `activity-${String(seq).padStart(4, "0")}.jsonl.gz`;

	if (dryRun) {
		emitActivityDryRun(activityPath, plan, segmentFile, emit);
		return;
	}

	const rotation = rotateActivityPrefix({
		activityPath,
		syncStatePath,
		archiveDir,
		manifestPath: activityManifestPath(cwd),
		cutByte: plan.cutByte,
		records: plan.records,
		syncedBytes,
		source,
		syncState,
		loadManifest: () => loadOrRebuildArchiveManifest(cwd),
		nextSequence: (current) => nextActivitySegmentSeq(cwd, current),
	});
	emitActivityRotation(rotation, fileSize, emit);
}

/** Emit one plain-log result. Absent logs stay silent — most repos have no
 *  collection/timeline yet, and noise there would drown the activity report. */
function emitPlainResult(r: PlainCompactResult, isJson: boolean): void {
	if (r.reason?.startsWith("no ")) return;
	const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
	if (isJson) {
		console.log(JSON.stringify(r, null, 2));
		return;
	}
	if (!r.compacted && r.archived_bytes <= 0) {
		console.log(c.dim(`${r.log}.jsonl: nothing compactable — ${r.reason ?? "within recent tail"}`));
		return;
	}
	const verb = r.compacted ? `${c.green("✓ Compacted")} ${r.log}.jsonl:` : `${c.bold("Dry run")} — ${r.log}.jsonl: would archive`;
	console.log(
		`${verb} ${mb(r.archived_bytes)}MB (${r.archived_records} records) → archive/${r.segment}\n` +
			`  gzipped to ${mb(r.gz_bytes)}MB, live after: ${mb(r.live_after_bytes)}MB`,
	);
}

/** `interlinked compact` — activity.jsonl first (cursor/audit-safe), then the
 *  plain daemon logs (collection.jsonl, timeline.jsonl) via compact-plain.ts. */
export async function compactCommand(opts: OptionValues): Promise<void> {
	await compactActivityLog(opts);
	const cwd = typeof opts.cwd === "string" ? opts.cwd : process.cwd();
	const keepRecentBytes =
		typeof opts.keepRecentBytes === "number" ? opts.keepRecentBytes : DEFAULT_KEEP_RECENT_BYTES;
	for (const log of PLAIN_COMPACTABLE_LOGS) {
		const result = compactPlainLog(log, { cwd, keepRecentBytes, dryRun: Boolean(opts.dryRun) });
		emitPlainResult(result, Boolean(opts.json));
	}
}

/** Register the `compact` subcommand on the root program (keeps index.ts under its line cap). */
export function registerCompactCommand(program: Command): void {
	program
		.command("compact")
		.description(
			"Gzip + archive the synced prefix of activity.jsonl plus the collection/timeline logs (lossless), reclaiming disk",
		)
		.option("--dry-run", "Show what would be archived without changing anything")
		.option("--keep-recent-mb <mb>", "Keep at least this many MB of recent log live", "2")
		.option("--all", "Archive past the recent tail even when un-synced (local-only / disk recovery; archived events won't be sent to the server)")
		.option("--json", "Machine-readable output")
		.action((opts: OptionValues) =>
			compactCommand({
				...opts,
				keepRecentBytes: Math.round(
					Number.parseFloat(String(opts.keepRecentMb ?? "2")) * 1024 * 1024,
				),
			}),
		);
}
