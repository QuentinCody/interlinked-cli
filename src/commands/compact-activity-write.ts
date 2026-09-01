import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipFileRange, sha256File } from "../lib/bounded-file-io.js";
import {
	fileIdentity,
	type FileIdentity,
	replaceFileWithSuffix,
	sameFileIdentity,
} from "../lib/file-suffix-replacement.js";
import { withFileMutationLock } from "../lib/file-mutation-lock.js";
import type { ArchiveSegment } from "./compact-plain.js";
import type {
	ActivityRecoveryDeps,
	ActivityRotationConflict,
	ActivityRotationDeps,
	ActivityRotationResult,
	PendingActivityRotationResult,
} from "./compact-activity-types.js";
import {
	assertSegmentMatchesLivePrefix,
	createRotationClaim,
	loadRotationClaim,
	publicationConflict,
	publishOrVerifyClaimedSegment,
	removeRotationClaim,
	replaceRotationClaim,
	RotationSegmentMismatchError,
	type RotationClaim,
	verifyClaimedSegment,
} from "./compact-rotation-claim.js";
export type {
	ActivityRecoveryDeps,
	ActivityRotationConflict,
	ActivityRotationDeps,
	ActivityRotationResult,
	PendingActivityRotationResult,
} from "./compact-activity-types.js";

function writeJsonAtomic(path: string, value: unknown): void {
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, JSON.stringify(value, null, 2));
	renameSync(temporary, path);
}

function writeCursor(deps: ActivityRecoveryDeps, cursor: number): void {
	deps.syncState.synced_through_bytes = cursor;
	writeJsonAtomic(deps.syncStatePath, deps.syncState);
}

function assertRecoveryCursorWithinRetainedBytes(
	cursor: number,
	retainedBytes: number,
	context: string,
): void {
	if (Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= retainedBytes) return;
	throw new Error(
		`${context} sync cursor ${cursor} exceeds ${retainedBytes} retained activity bytes`,
	);
}

function completeSegment(deps: ActivityRecoveryDeps, segmentFile: string): ArchiveSegment {
	const manifest = deps.loadManifest();
	const segment = manifest.segments.find((entry) => entry.file === segmentFile);
	if (!segment) throw new Error(`activity manifest lost pending segment ${segmentFile}`);
	delete segment.pending_live_drop;
	writeJsonAtomic(deps.manifestPath, manifest);
	return segment;
}

function removeTemporary(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		const missing =
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT";
		if (!missing) throw error;
	}
}

/** Complete an already-indexed activity prefix before planning another one. */
function recoverPendingActivityRotation(
	deps: ActivityRecoveryDeps,
): ActivityRotationResult | null {
	const manifest = deps.loadManifest();
	const segment = manifest.segments.find((entry) => entry.pending_live_drop !== undefined);
	const pending = segment?.pending_live_drop;
	if (!segment || !pending) return null;
	const cursor = pending.synced_through_bytes ?? 0;
	const current = fileIdentity(deps.activityPath);

	if (sameFileIdentity(current, pending.replacement)) {
		throw new Error(
			"pending activity rotation has no durable claim; archive consistency cannot be proven",
		);
	}
	if (!sameFileIdentity(current, pending.source)) {
		throw new Error("pending activity rotation no longer matches the live file identity");
	}
	assertRecoveryCursorWithinRetainedBytes(
		cursor,
		statSync(deps.activityPath).size - pending.cut_bytes,
		"pending activity rotation",
	);
	assertSegmentMatchesLivePrefix({
		livePath: deps.activityPath,
		cutBytes: pending.cut_bytes,
		archiveDir: deps.archiveDir,
		segmentFile: segment.file,
	});

	let completed = segment;
	const prepared = replaceFileWithSuffix(deps.activityPath, pending.cut_bytes, {
		expectedSource: pending.source,
		beforeReplace: (next) => {
			assertRecoveryCursorWithinRetainedBytes(
				cursor,
				next.retainedBytes,
				"pending activity rotation",
			);
			const currentManifest = deps.loadManifest();
			const stored = currentManifest.segments.find((entry) => entry.file === segment.file);
			if (!stored) throw new Error("activity recovery lost its indexed segment");
			stored.pending_live_drop = {
				cut_bytes: pending.cut_bytes,
				source: next.source,
				replacement: next.replacement,
				synced_through_bytes: cursor,
			};
			writeJsonAtomic(deps.manifestPath, currentManifest);
			writeCursor(deps, cursor);
		},
		afterReplace: () => {
			completed = completeSegment(deps, segment.file);
		},
	});
	return { segment: completed, liveAfterBytes: prepared.retainedBytes, syncedThroughBytes: cursor };
}

/** Inspect and, unless this is a dry run, finish one pending rotation before a
 * caller plans a new prefix. The same indexed segment is completed; retry
 * never creates a second archive entry for the already-published bytes. */
export function resumePendingActivityRotation(
	deps: ActivityRecoveryDeps,
	dryRun: boolean,
): PendingActivityRotationResult | null {
	const segment = deps.loadManifest().segments.find((entry) => entry.pending_live_drop !== undefined);
	const claim = loadRotationClaim(deps.archiveDir, "activity");
	if (segment && dryRun) {
		return {
			segment,
			liveAfterBytes: statSync(deps.activityPath).size,
			syncedThroughBytes: segment.pending_live_drop?.synced_through_bytes ?? 0,
			recovered: false,
		};
	}
	if (segment) {
		if (claim) {
			assertActivityPendingMatchesClaim(segment, claim);
			return { ...recoverClaimedActivityRotation(deps, claim), recovered: true };
		}
		const result = recoverPendingActivityRotation(deps);
		if (!result) throw new Error("pending activity rotation disappeared during recovery");
		return { ...result, recovered: true };
	}
	if (!claim) return null;
	if (dryRun) {
		return {
			segment: segmentFromClaim(claim),
			liveAfterBytes: statSync(deps.activityPath).size,
			syncedThroughBytes: claim.synced_through_bytes ?? 0,
			recovered: false,
		};
	}
	return { ...recoverClaimedActivityRotation(deps, claim), recovered: true };
}

function segmentFromClaim(
	claim: RotationClaim,
	pending?: ArchiveSegment["pending_live_drop"],
): ArchiveSegment {
	return {
		seq: claim.seq,
		file: claim.file,
		bytes: claim.cut_bytes,
		gz_bytes: claim.gz_bytes,
		records: claim.records,
		created_at: claim.created_at,
		...(pending ? { pending_live_drop: pending } : {}),
	};
}

function activitySegmentMatchesClaim(
	segment: ArchiveSegment,
	claim: RotationClaim,
): boolean {
	return (
		claim.log === "activity" &&
		segment.seq === claim.seq &&
		segment.file === claim.file &&
		segment.bytes === claim.cut_bytes &&
		segment.gz_bytes === claim.gz_bytes &&
		segment.records === claim.records &&
		segment.created_at === claim.created_at
	);
}

function assertActivitySegmentMatchesClaim(
	segment: ArchiveSegment,
	claim: RotationClaim,
): void {
	if (!activitySegmentMatchesClaim(segment, claim)) {
		throw new RotationSegmentMismatchError(
			segment.file,
			"does not match its durable rotation claim",
		);
	}
}

function assertActivityPendingMatchesClaim(
	segment: ArchiveSegment,
	claim: RotationClaim,
): void {
	const pending = segment.pending_live_drop;
	const matches =
		pending !== undefined &&
		activitySegmentMatchesClaim(segment, claim) &&
		pending.cut_bytes === claim.cut_bytes &&
		sameFileIdentity(pending.source, claim.source) &&
		sameFileIdentity(pending.replacement, claim.replacement) &&
		(pending.synced_through_bytes ?? 0) === (claim.synced_through_bytes ?? 0);
	if (!matches) {
		throw new RotationSegmentMismatchError(
			segment.file,
			"does not match its pending manifest and durable claim",
		);
	}
}

function verifyPreparedGzip(path: string, claim: RotationClaim): void {
	if (statSync(path).size !== claim.gz_bytes || sha256File(path) !== claim.gzip_sha256) {
		throw new RotationSegmentMismatchError(
			claim.file,
			"cannot be reproduced from the recorded live-file prefix",
		);
	}
}

function storeClaimedActivitySegment(
	deps: ActivityRecoveryDeps,
	claim: RotationClaim,
	replacement: FileIdentity,
): ArchiveSegment {
	const manifest = deps.loadManifest();
	const pending = {
		cut_bytes: claim.cut_bytes,
		source: claim.source,
		replacement,
		synced_through_bytes: claim.synced_through_bytes ?? 0,
	};
	const claimed = segmentFromClaim(claim, pending);
	const index = manifest.segments.findIndex((entry) => entry.file === claim.file);
	if (index >= 0) {
		const stored = manifest.segments[index];
		if (stored?.pending_live_drop) {
			assertActivitySegmentMatchesClaim(stored, claim);
			manifest.segments[index] = claimed;
		} else if (!stored?.recovered) {
			throw new Error(`activity manifest already contains claimed segment ${claim.file}`);
		} else {
			manifest.segments[index] = claimed;
		}
	} else {
		manifest.segments.push(claimed);
	}
	writeJsonAtomic(deps.manifestPath, manifest);
	writeCursor(deps, claim.synced_through_bytes ?? 0);
	return claimed;
}

function finalizeClaimedActivityReplacement(
	deps: ActivityRecoveryDeps,
	claim: RotationClaim,
): ArchiveSegment {
	const completed = completeSegment(deps, claim.file);
	removeRotationClaim(deps.archiveDir, "activity");
	return completed;
}

function recoverClaimedActivityRotation(
	deps: ActivityRecoveryDeps,
	claim: RotationClaim,
): ActivityRotationResult {
	const current = fileIdentity(deps.activityPath);
	const finalPath = join(deps.archiveDir, claim.file);
	const cursor = claim.synced_through_bytes ?? 0;
	if (sameFileIdentity(current, claim.replacement)) {
		assertRecoveryCursorWithinRetainedBytes(
			cursor,
			statSync(deps.activityPath).size,
			"claimed activity replacement",
		);
		const verifiedFinal = verifyClaimedSegment(finalPath, claim);
		let completed = segmentFromClaim(claim);
		withFileMutationLock(deps.activityPath, () => {
			if (!sameFileIdentity(fileIdentity(deps.activityPath), claim.replacement)) {
				throw new Error("activity log changed while finalizing a claimed rotation");
			}
			assertRecoveryCursorWithinRetainedBytes(
				cursor,
				statSync(deps.activityPath).size,
				"claimed activity replacement",
			);
			publishOrVerifyClaimedSegment({
				temporary: "",
				finalPath,
				claim,
				verifiedExisting: verifiedFinal,
			});
			const manifest = deps.loadManifest();
			const stored = manifest.segments.find((entry) => entry.file === claim.file);
			if (!stored || stored.recovered) {
				completed = segmentFromClaim(claim);
				if (stored) {
					manifest.segments[manifest.segments.indexOf(stored)] = completed;
				} else {
					manifest.segments.push(completed);
				}
				writeJsonAtomic(deps.manifestPath, manifest);
			} else {
				assertActivitySegmentMatchesClaim(stored, claim);
				completed = stored.pending_live_drop ? completeSegment(deps, claim.file) : stored;
			}
			writeCursor(deps, cursor);
			removeRotationClaim(deps.archiveDir, "activity");
		});
		return {
			segment: completed,
			liveAfterBytes: statSync(deps.activityPath).size,
			syncedThroughBytes: cursor,
		};
	}
	if (!sameFileIdentity(current, claim.source)) {
		throw new Error("claimed activity rotation no longer matches the live file identity");
	}
	assertRecoveryCursorWithinRetainedBytes(
		cursor,
		statSync(deps.activityPath).size - claim.cut_bytes,
		"claimed activity source",
	);

	const gzipTemporary = join(
		deps.archiveDir,
		`.activity-recovery-${process.pid}-${randomUUID()}.jsonl.gz.tmp`,
	);
	gzipFileRange(deps.activityPath, 0, claim.cut_bytes, gzipTemporary);
	let completed = segmentFromClaim(claim);
	try {
		verifyPreparedGzip(gzipTemporary, claim);
		const verifiedExisting = existsSync(finalPath)
			? verifyClaimedSegment(finalPath, claim)
			: undefined;
		const prepared = replaceFileWithSuffix(deps.activityPath, claim.cut_bytes, {
			expectedSource: claim.source,
			beforeReplace: (replacement) => {
				assertRecoveryCursorWithinRetainedBytes(
					cursor,
					replacement.retainedBytes,
					"claimed activity source",
				);
				const refreshed = { ...claim, replacement: replacement.replacement };
				replaceRotationClaim(deps.archiveDir, refreshed);
				publishOrVerifyClaimedSegment({
					temporary: gzipTemporary,
					finalPath,
					claim: refreshed,
					...(verifiedExisting ? { verifiedExisting } : {}),
				});
				completed = storeClaimedActivitySegment(deps, refreshed, replacement.replacement);
			},
			afterReplace: () => {
				completed = finalizeClaimedActivityReplacement(deps, claim);
			},
		});
		return {
			segment: completed,
			liveAfterBytes: prepared.retainedBytes,
			syncedThroughBytes: cursor,
		};
	} finally {
		removeTemporary(gzipTemporary);
	}
}

/** Publish a durable rotation claim, its complete gzip, a recoverable manifest
 * entry, the cursor, and the live suffix in that order. Final-named gzip files
 * are created only by a hard link from a fully written unique temporary. */
export function rotateActivityPrefix(
	deps: ActivityRotationDeps,
): ActivityRotationResult | ActivityRotationConflict {
	mkdirSync(deps.archiveDir, { recursive: true });
	const gzipTemporary = join(
		deps.archiveDir,
		`.activity-${process.pid}-${randomUUID()}.jsonl.gz.tmp`,
	);
	const gzip = gzipFileRange(deps.activityPath, 0, deps.cutByte, gzipTemporary);
	let publishedFile: string | undefined;
	let publishedClaim: RotationClaim | undefined;
	let publishedSegment: ArchiveSegment | undefined;
	let createdClaim = false;
	const cursor = Math.max(0, deps.syncedBytes - deps.cutByte);
	const gzipSha256 = sha256File(gzipTemporary);
	try {
		const prepared = replaceFileWithSuffix(deps.activityPath, deps.cutByte, {
			expectedSource: deps.source,
			afterInitialCopy: deps.afterInitialCopy,
			beforeReplace: (replacement) => {
				assertRecoveryCursorWithinRetainedBytes(
					cursor,
					replacement.retainedBytes,
					"activity rotation",
				);
				const manifest = deps.loadManifest();
				const seq = deps.nextSequence(manifest);
				publishedFile = `activity-${String(seq).padStart(4, "0")}.jsonl.gz`;
				const claim: RotationClaim = {
					version: 1,
					log: "activity",
					seq,
					file: publishedFile,
					gz_bytes: gzip.gzipBytes,
					gzip_sha256: gzipSha256,
					cut_bytes: deps.cutByte,
					records: deps.records,
					created_at: new Date().toISOString(),
					source: replacement.source,
					replacement: replacement.replacement,
					synced_through_bytes: cursor,
				};
				publishedClaim = claim;
				createRotationClaim(deps.archiveDir, claim);
				createdClaim = true;
				publishOrVerifyClaimedSegment({
					temporary: gzipTemporary,
					finalPath: join(deps.archiveDir, publishedFile),
					claim,
				});
				publishedSegment = storeClaimedActivitySegment(
					deps,
					claim,
					replacement.replacement,
				);
			},
			afterReplace: () => {
				if (!publishedFile) throw new Error("activity segment was not published");
				publishedSegment = finalizeClaimedActivityReplacement(
					deps,
					loadRotationClaim(deps.archiveDir, "activity") ?? (() => {
						throw new Error("activity rotation claim disappeared before finalization");
					})(),
				);
			},
		});
		if (!publishedSegment) throw new Error("activity rotation did not publish a segment");
		return {
			segment: publishedSegment,
			liveAfterBytes: prepared.retainedBytes,
			syncedThroughBytes: cursor,
		};
	} catch (error) {
		const conflict = publicationConflict(
			error,
			publishedClaim ? join(deps.archiveDir, publishedClaim.file) : undefined,
			publishedClaim,
		);
		if (!conflict) throw error;
		if (conflict.abandonClaim && createdClaim) {
			removeRotationClaim(deps.archiveDir, "activity");
		}
		return { segmentFile: conflict.segmentFile, reason: conflict.reason };
	} finally {
		removeTemporary(gzipTemporary);
	}
}
