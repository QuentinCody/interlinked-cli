// Durable plain-log rotation and crash recovery. Manifest parsing and cut
// planning live in compact-plain-state.ts so this file only owns publication.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gzipFileRange, sha256File } from "../lib/bounded-file-io.js";
import { getDataDir } from "../lib/config.js";
import {
	fileIdentity,
	type FileIdentity,
	replaceFileWithSuffix,
	sameFileIdentity,
} from "../lib/file-suffix-replacement.js";
import { withFileMutationLock } from "../lib/file-mutation-lock.js";
import {
	BYTES_PER_MB,
	type ArchiveManifest,
	type ArchiveSegment,
	completePendingPlainEntry,
	loadOrRebuildPlainManifest,
	nextPlainSegmentSeq,
	pendingPlainResult,
	planPlainCut,
	type PlainCompactResult,
	type PlainCut,
	type PlainLogName,
	skippedPlainResult,
	writePlainManifest,
} from "./compact-plain-state.js";
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

function recoverPendingPlainRotation(
	log: PlainLogName,
	cwd: string,
	logPath: string,
	manifest: ArchiveManifest,
): PlainCompactResult | null {
	const segment = manifest.segments.find((entry) => entry.pending_live_drop !== undefined);
	const pending = segment?.pending_live_drop;
	if (!segment || !pending) return null;

	const current = fileIdentity(logPath);
	if (sameFileIdentity(current, pending.replacement)) {
		throw new Error(
			`pending ${log}.jsonl rotation has no durable claim; archive consistency cannot be proven`,
		);
	}
	if (!sameFileIdentity(current, pending.source)) {
		return skippedPlainResult(
			log,
			statSync(logPath).size,
			"pending rotation no longer matches the live file identity",
		);
	}
	assertSegmentMatchesLivePrefix({
		livePath: logPath,
		cutBytes: pending.cut_bytes,
		archiveDir: join(getDataDir(cwd), "archive"),
		segmentFile: segment.file,
	});

	let completed = segment;
	const prepared = replaceFileWithSuffix(logPath, pending.cut_bytes, {
		expectedSource: pending.source,
		beforeReplace: (next) => {
			segment.pending_live_drop = {
				cut_bytes: pending.cut_bytes,
				source: next.source,
				replacement: next.replacement,
			};
			writePlainManifest(log, cwd, manifest);
		},
		afterReplace: () => {
			completePendingPlainEntry(log, cwd, manifest, segment);
			completed = segment;
		},
	});
	return pendingPlainResult(log, completed, prepared.retainedBytes);
}

function unlinkTemporary(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (
			typeof error !== "object" ||
			error === null ||
			!("code" in error) ||
			error.code !== "ENOENT"
		) {
			throw error;
		}
	}
}

function plainSegmentFromClaim(
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

function plainSegmentMatchesClaim(
	log: PlainLogName,
	segment: ArchiveSegment,
	claim: RotationClaim,
): boolean {
	return (
		claim.log === log &&
		segment.seq === claim.seq &&
		segment.file === claim.file &&
		segment.bytes === claim.cut_bytes &&
		segment.gz_bytes === claim.gz_bytes &&
		segment.records === claim.records &&
		segment.created_at === claim.created_at
	);
}

function assertPlainSegmentMatchesClaim(
	log: PlainLogName,
	segment: ArchiveSegment,
	claim: RotationClaim,
): void {
	if (!plainSegmentMatchesClaim(log, segment, claim)) {
		throw new RotationSegmentMismatchError(
			segment.file,
			"does not match its durable rotation claim",
		);
	}
}

function assertPlainPendingMatchesClaim(
	log: PlainLogName,
	segment: ArchiveSegment,
	claim: RotationClaim,
): void {
	const pending = segment.pending_live_drop;
	const matches =
		pending !== undefined &&
		plainSegmentMatchesClaim(log, segment, claim) &&
		pending.cut_bytes === claim.cut_bytes &&
		sameFileIdentity(pending.source, claim.source) &&
		sameFileIdentity(pending.replacement, claim.replacement) &&
		claim.synced_through_bytes === undefined;
	if (!matches) {
		throw new RotationSegmentMismatchError(
			segment.file,
			"does not match its pending manifest and durable claim",
		);
	}
}

function verifyPreparedPlainGzip(path: string, claim: RotationClaim): void {
	if (statSync(path).size !== claim.gz_bytes || sha256File(path) !== claim.gzip_sha256) {
		throw new RotationSegmentMismatchError(
			claim.file,
			"cannot be reproduced from the recorded live-file prefix",
		);
	}
}

function storeClaimedPlainSegment(
	log: PlainLogName,
	cwd: string,
	claim: RotationClaim,
	replacement: FileIdentity,
): ArchiveSegment {
	const manifest = loadOrRebuildPlainManifest(log, cwd);
	const claimed = plainSegmentFromClaim(claim, {
		cut_bytes: claim.cut_bytes,
		source: claim.source,
		replacement,
	});
	const index = manifest.segments.findIndex((entry) => entry.file === claim.file);
	if (index >= 0) {
		const stored = manifest.segments[index];
		if (stored?.pending_live_drop) {
			assertPlainSegmentMatchesClaim(log, stored, claim);
			manifest.segments[index] = claimed;
		} else if (!stored?.recovered) {
			throw new Error(`${log} manifest already contains claimed segment ${claim.file}`);
		} else {
			manifest.segments[index] = claimed;
		}
	} else {
		manifest.segments.push(claimed);
	}
	writePlainManifest(log, cwd, manifest);
	return claimed;
}

function finalizeClaimedPlainReplacement(
	log: PlainLogName,
	cwd: string,
	archiveDir: string,
	claim: RotationClaim,
): ArchiveSegment {
	const manifest = loadOrRebuildPlainManifest(log, cwd);
	const stored = manifest.segments.find((entry) => entry.file === claim.file);
	if (!stored) throw new Error(`${log} manifest lost claimed segment ${claim.file}`);
	completePendingPlainEntry(log, cwd, manifest, stored);
	removeRotationClaim(archiveDir, log);
	return stored;
}

function finishPreviouslyReplacedPlainLog(
	log: PlainLogName,
	cwd: string,
	logPath: string,
	archiveDir: string,
	claim: RotationClaim,
): PlainCompactResult {
	const finalPath = join(archiveDir, claim.file);
	const verifiedFinal = verifyClaimedSegment(finalPath, claim);
	let completed = plainSegmentFromClaim(claim);
	withFileMutationLock(logPath, () => {
		if (!sameFileIdentity(fileIdentity(logPath), claim.replacement)) {
			throw new Error(`${log}.jsonl changed while finalizing a claimed rotation`);
		}
		publishOrVerifyClaimedSegment({
			temporary: "",
			finalPath,
			claim,
			verifiedExisting: verifiedFinal,
		});
		const manifest = loadOrRebuildPlainManifest(log, cwd);
		const stored = manifest.segments.find((entry) => entry.file === claim.file);
		if (!stored || stored.recovered) {
			completed = plainSegmentFromClaim(claim);
			if (stored) manifest.segments[manifest.segments.indexOf(stored)] = completed;
			else manifest.segments.push(completed);
			writePlainManifest(log, cwd, manifest);
		} else if (stored.pending_live_drop) {
			assertPlainSegmentMatchesClaim(log, stored, claim);
			completePendingPlainEntry(log, cwd, manifest, stored);
			completed = stored;
		} else {
			assertPlainSegmentMatchesClaim(log, stored, claim);
			completed = stored;
		}
		removeRotationClaim(archiveDir, log);
	});
	return pendingPlainResult(log, completed, statSync(logPath).size);
}

function recoverClaimedPlainRotation(
	log: PlainLogName,
	cwd: string,
	logPath: string,
	archiveDir: string,
	claim: RotationClaim,
): PlainCompactResult {
	const current = fileIdentity(logPath);
	if (sameFileIdentity(current, claim.replacement)) {
		return finishPreviouslyReplacedPlainLog(log, cwd, logPath, archiveDir, claim);
	}
	if (!sameFileIdentity(current, claim.source)) {
		return skippedPlainResult(
			log,
			statSync(logPath).size,
			"claimed rotation no longer matches the live file identity",
		);
	}

	const finalPath = join(archiveDir, claim.file);
	const gzipTemporary = join(
		archiveDir,
		`.${log}-recovery-${process.pid}-${randomUUID()}.jsonl.gz.tmp`,
	);
	gzipFileRange(logPath, 0, claim.cut_bytes, gzipTemporary);
	let completed = plainSegmentFromClaim(claim);
	try {
		verifyPreparedPlainGzip(gzipTemporary, claim);
		const verifiedExisting = existsSync(finalPath)
			? verifyClaimedSegment(finalPath, claim)
			: undefined;
		const prepared = replaceFileWithSuffix(logPath, claim.cut_bytes, {
			expectedSource: claim.source,
			beforeReplace: (replacement) => {
				const refreshed = { ...claim, replacement: replacement.replacement };
				replaceRotationClaim(archiveDir, refreshed);
				publishOrVerifyClaimedSegment({
					temporary: gzipTemporary,
					finalPath,
					claim: refreshed,
					...(verifiedExisting ? { verifiedExisting } : {}),
				});
				completed = storeClaimedPlainSegment(log, cwd, refreshed, replacement.replacement);
			},
			afterReplace: () => {
				completed = finalizeClaimedPlainReplacement(log, cwd, archiveDir, claim);
			},
		});
		return pendingPlainResult(log, completed, prepared.retainedBytes);
	} finally {
		unlinkTemporary(gzipTemporary);
	}
}

interface ResumePlainRotationInput {
	log: PlainLogName;
	cwd: string;
	logPath: string;
	archiveDir: string;
	dryRun: boolean;
}

function resumePlainRotationIfNeeded(
	input: ResumePlainRotationInput,
): PlainCompactResult | null {
	const { log, cwd, logPath, archiveDir, dryRun } = input;
	const manifest = loadOrRebuildPlainManifest(log, cwd);
	const pending = manifest.segments.find((entry) => entry.pending_live_drop !== undefined);
	const claim = loadRotationClaim(archiveDir, log);
	if (pending && dryRun) {
		return skippedPlainResult(
			log,
			statSync(logPath).size,
			`pending rotation ${pending.file} needs recovery`,
		);
	}
	if (pending) {
		if (claim) {
			assertPlainPendingMatchesClaim(log, pending, claim);
			return recoverClaimedPlainRotation(log, cwd, logPath, archiveDir, claim);
		}
		const recovered = recoverPendingPlainRotation(log, cwd, logPath, manifest);
		if (!recovered) throw new Error(`pending ${log}.jsonl rotation disappeared during recovery`);
		return recovered;
	}
	if (!claim) return null;
	if (dryRun) {
		return skippedPlainResult(
			log,
			statSync(logPath).size,
			`pending rotation ${claim.file} needs recovery`,
		);
	}
	return recoverClaimedPlainRotation(log, cwd, logPath, archiveDir, claim);
}

interface PublishPlainRotationInput {
	log: PlainLogName;
	cwd: string;
	logPath: string;
	archiveDir: string;
	source: FileIdentity;
	plan: PlainCut;
	fileSize: number;
	afterInitialCopy?: (() => void) | undefined;
}

function publishPlainRotation(input: PublishPlainRotationInput): PlainCompactResult {
	const { log, cwd, logPath, archiveDir, source, plan, fileSize, afterInitialCopy } = input;
	mkdirSync(archiveDir, { recursive: true });
	const gzipTemporary = join(archiveDir, `.${log}-${process.pid}-${randomUUID()}.jsonl.gz.tmp`);
	const gzipResult = gzipFileRange(logPath, 0, plan.cutByte, gzipTemporary);
	const gzipSha256 = sha256File(gzipTemporary);
	let segment: ArchiveSegment | undefined;
	let publishedClaim: RotationClaim | undefined;
	try {
		const prepared = replaceFileWithSuffix(logPath, plan.cutByte, {
			expectedSource: source,
			afterInitialCopy,
			beforeReplace: (replacement) => {
				const current = loadOrRebuildPlainManifest(log, cwd);
				const seq = nextPlainSegmentSeq(log, cwd, current);
				const file = `${log}-${String(seq).padStart(4, "0")}.jsonl.gz`;
				const claim: RotationClaim = {
					version: 1,
					log,
					seq,
					file,
					cut_bytes: plan.cutByte,
					records: plan.records,
					gz_bytes: gzipResult.gzipBytes,
					gzip_sha256: gzipSha256,
					created_at: new Date().toISOString(),
					source: replacement.source,
					replacement: replacement.replacement,
				};
				publishedClaim = claim;
				createRotationClaim(archiveDir, claim);
				publishOrVerifyClaimedSegment({
					temporary: gzipTemporary,
					finalPath: join(archiveDir, file),
					claim,
				});
				segment = storeClaimedPlainSegment(log, cwd, claim, replacement.replacement);
			},
			afterReplace: () => {
				const claim = loadRotationClaim(archiveDir, log);
				if (!claim) throw new Error("plain rotation claim disappeared before finalization");
				segment = finalizeClaimedPlainReplacement(log, cwd, archiveDir, claim);
			},
		});
		if (!segment) throw new Error("plain rotation did not publish a segment");
		return pendingPlainResult(log, segment, prepared.retainedBytes);
	} catch (error) {
		const conflict = publicationConflict(
			error,
			publishedClaim ? join(archiveDir, publishedClaim.file) : undefined,
			publishedClaim,
		);
		if (!conflict) throw error;
		if (conflict.abandonClaim && publishedClaim !== undefined) removeRotationClaim(archiveDir, log);
		return skippedPlainResult(log, fileSize, conflict.reason);
	} finally {
		unlinkTemporary(gzipTemporary);
	}
}

/** Archive a line-aligned prefix of one append-only plain daemon log. */
export function compactPlainLog(
	log: PlainLogName,
	options: {
		cwd?: string;
		keepRecentBytes: number;
		dryRun?: boolean;
		/** Test seam for the exact copy-to-rename race. */
		afterInitialCopy?: () => void;
	},
): PlainCompactResult {
	const cwd = options.cwd ?? process.cwd();
	const logPath = join(getDataDir(cwd), `${log}.jsonl`);
	if (!existsSync(logPath)) return skippedPlainResult(log, 0, `no ${log}.jsonl`);
	const archiveDir = join(getDataDir(cwd), "archive");
	const resumed = resumePlainRotationIfNeeded({
		log,
		cwd,
		logPath,
		archiveDir,
		dryRun: options.dryRun === true,
	});
	if (resumed) return resumed;

	const source = fileIdentity(logPath);
	const fileSize = statSync(logPath).size;
	const plan = planPlainCut(logPath, fileSize, options.keepRecentBytes);
	if (plan.cutByte <= 0) {
		const keptMb = (options.keepRecentBytes / BYTES_PER_MB).toFixed(1);
		return skippedPlainResult(
			log,
			fileSize,
			`log is within the ${keptMb}MB recent-tail kept live`,
		);
	}

	const manifest = loadOrRebuildPlainManifest(log, cwd);
	const seq = nextPlainSegmentSeq(log, cwd, manifest);
	const segmentFile = `${log}-${String(seq).padStart(4, "0")}.jsonl.gz`;
	if (options.dryRun) {
		const gzipBytes = gzipFileRange(logPath, 0, plan.cutByte).gzipBytes;
		return {
			log,
			compacted: false,
			segment: segmentFile,
			archived_bytes: plan.cutByte,
			archived_records: plan.records,
			gz_bytes: gzipBytes,
			live_after_bytes: fileSize - plan.cutByte,
		};
	}
	return publishPlainRotation({
		log,
		cwd,
		logPath,
		archiveDir,
		source,
		plan,
		fileSize,
		afterInitialCopy: options.afterInitialCopy,
	});
}
