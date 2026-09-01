// ===========================================
// Durable compaction publication claims
// ===========================================
// A claim is published before a final-named gzip becomes visible. If a process
// dies between the hard link and the manifest write, retry uses the recorded
// source identity, cut, and gzip digest instead of allocating a new sequence.

import { randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipFileRange, readFileRange, sha256File } from "../lib/bounded-file-io.js";
import type { FileIdentity } from "../lib/file-suffix-replacement.js";
import { isJsonObject } from "../lib/json-types.js";

const MAX_ROTATION_CLAIM_BYTES = 16 * 1024;

export interface RotationClaim {
	version: 1;
	log: "activity" | "collection" | "timeline";
	seq: number;
	file: string;
	cut_bytes: number;
	records: number;
	gz_bytes: number;
	gzip_sha256: string;
	created_at: string;
	source: FileIdentity;
	replacement: FileIdentity;
	synced_through_bytes?: number;
}

export class RotationSegmentMismatchError extends Error {
	constructor(readonly segmentFile: string, detail: string, options?: ErrorOptions) {
		super(`archive segment ${segmentFile} ${detail}; preserved without indexing`, options);
		this.name = "RotationSegmentMismatchError";
	}
}

class RotationSegmentVerificationRequiredError extends Error {
	constructor(readonly segmentFile: string) {
		super(`archive segment ${segmentFile} appeared during publication; retry to verify it`);
		this.name = "RotationSegmentVerificationRequiredError";
	}
}

interface VerifiedSegmentFingerprint {
	dev: string;
	ino: string;
	size: string;
	mtimeNs: string;
	ctimeNs: string;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function parseIdentity(value: unknown): FileIdentity | null {
	if (!isJsonObject(value)) return null;
	if (typeof value.dev !== "string" || value.dev.length === 0) return null;
	if (typeof value.ino !== "string" || value.ino.length === 0) return null;
	return { dev: value.dev, ino: value.ino };
}

function validSafeInteger(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function expectedSegmentFile(log: RotationClaim["log"], seq: number): string {
	return `${log}-${String(seq).padStart(4, "0")}.jsonl.gz`;
}

function parseRotationClaim(value: unknown, log: RotationClaim["log"]): RotationClaim | null {
	if (!isJsonObject(value) || value.version !== 1 || value.log !== log) return null;
	if (!validSafeInteger(value.seq, 1) || !validSafeInteger(value.cut_bytes, 1)) return null;
	if (!validSafeInteger(value.records, 0) || !validSafeInteger(value.gz_bytes, 1)) return null;
	const file = typeof value.file === "string" ? value.file : null;
	if (file !== expectedSegmentFile(log, value.seq)) return null;
	const digest = typeof value.gzip_sha256 === "string" ? value.gzip_sha256 : null;
	if (!digest || !/^[a-f0-9]{64}$/.test(digest)) return null;
	if (typeof value.created_at !== "string" || value.created_at.length === 0) return null;
	const source = parseIdentity(value.source);
	const replacement = parseIdentity(value.replacement);
	if (!source || !replacement) return null;
	const cursor = value.synced_through_bytes;
	if (cursor !== undefined && !validSafeInteger(cursor, 0)) return null;
	return {
		version: 1,
		log,
		seq: value.seq,
		file,
		cut_bytes: value.cut_bytes,
		records: value.records,
		gz_bytes: value.gz_bytes,
		gzip_sha256: digest,
		created_at: value.created_at,
		source,
		replacement,
		...(cursor === undefined ? {} : { synced_through_bytes: cursor }),
	};
}

export function rotationClaimPath(
	archiveDir: string,
	log: RotationClaim["log"],
): string {
	return join(archiveDir, `.pending-${log}-rotation.json`);
}

export function loadRotationClaim(
	archiveDir: string,
	log: RotationClaim["log"],
): RotationClaim | null {
	const path = rotationClaimPath(archiveDir, log);
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(requireClaimBytes(path)));
	} catch (error) {
		throw new Error(`corrupt ${log} rotation claim at ${path}`, { cause: error });
	}
	const claim = parseRotationClaim(parsed, log);
	if (!claim) throw new Error(`corrupt ${log} rotation claim at ${path}`);
	return claim;
}

function requireClaimBytes(path: string): Buffer {
	// Claims are tiny and schema-bounded by their parser. `readFileSync` is kept
	// local so the normal compaction data path remains chunked and bounded.
	const size = statSync(path).size;
	if (size > MAX_ROTATION_CLAIM_BYTES) {
		throw new Error(`rotation claim exceeds ${MAX_ROTATION_CLAIM_BYTES} bytes: ${path}`);
	}
	return readFileRange(path, 0, size, MAX_ROTATION_CLAIM_BYTES);
}

function writeClaimAtomic(path: string, claim: RotationClaim): void {
	const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(claim, null, 2), { flag: "wx" });
		renameSync(temporary, path);
	} finally {
		try {
			unlinkSync(temporary);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}
}

/** Publish the first durable claim while the live-log mutation lock is held. */
export function createRotationClaim(archiveDir: string, claim: RotationClaim): void {
	const path = rotationClaimPath(archiveDir, claim.log);
	if (existsSync(path)) {
		throw new Error(`pending ${claim.log} rotation claim already exists at ${path}`);
	}
	writeClaimAtomic(path, claim);
}

/** Refresh the prepared replacement identity during a claimed retry. */
export function replaceRotationClaim(archiveDir: string, claim: RotationClaim): void {
	const path = rotationClaimPath(archiveDir, claim.log);
	if (!existsSync(path)) throw new Error(`pending ${claim.log} rotation claim disappeared`);
	writeClaimAtomic(path, claim);
}

export function removeRotationClaim(archiveDir: string, log: RotationClaim["log"]): void {
	try {
		unlinkSync(rotationClaimPath(archiveDir, log));
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

function segmentFingerprint(path: string): VerifiedSegmentFingerprint {
	const stat = statSync(path, { bigint: true });
	return {
		dev: stat.dev.toString(),
		ino: stat.ino.toString(),
		size: stat.size.toString(),
		mtimeNs: stat.mtimeNs.toString(),
		ctimeNs: stat.ctimeNs.toString(),
	};
}

function sameSegmentFingerprint(
	left: VerifiedSegmentFingerprint,
	right: VerifiedSegmentFingerprint,
): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

/** Hash a claimed archive outside the live-log mutation lock, then bind that
 * verdict to inode/size/timestamps for the short locked finalization. */
export function verifyClaimedSegment(
	path: string,
	claim: RotationClaim,
): VerifiedSegmentFingerprint {
	const before = segmentFingerprint(path);
	const matchesSize = before.size === String(claim.gz_bytes);
	const matchesDigest = matchesSize && sha256File(path) === claim.gzip_sha256;
	const after = segmentFingerprint(path);
	if (!matchesDigest || !sameSegmentFingerprint(before, after)) {
		throw new RotationSegmentMismatchError(
			claim.file,
			"does not match its durable rotation claim",
		);
	}
	return after;
}

interface PublicationConflict {
	segmentFile: string;
	reason: string;
	abandonClaim: boolean;
}

/** Resolve a publication error after the live-file lock has unwound. */
export function publicationConflict(
	error: unknown,
	finalPath: string | undefined,
	claim: RotationClaim | undefined,
): PublicationConflict | null {
	if (error instanceof RotationSegmentVerificationRequiredError && finalPath && claim) {
		try {
			verifyClaimedSegment(finalPath, claim);
			return { segmentFile: claim.file, reason: error.message, abandonClaim: false };
		} catch (verificationError) {
			if (verificationError instanceof RotationSegmentMismatchError) {
				return {
					segmentFile: verificationError.segmentFile,
					reason: verificationError.message,
					abandonClaim: true,
				};
			}
			throw verificationError;
		}
	}
	if (error instanceof RotationSegmentMismatchError) {
		return { segmentFile: error.segmentFile, reason: error.message, abandonClaim: true };
	}
	return null;
}

function assertSegmentStillVerified(
	path: string,
	claim: RotationClaim,
	verified: VerifiedSegmentFingerprint,
): void {
	if (sameSegmentFingerprint(segmentFingerprint(path), verified)) return;
	throw new RotationSegmentMismatchError(claim.file, "changed after verification");
}

function linkClaimedSegment(
	temporary: string,
	finalPath: string,
	claim: RotationClaim,
): "linked" | "existing" {
	if (existsSync(finalPath)) return "existing";
	if (!temporary) {
		throw new RotationSegmentMismatchError(claim.file, "is missing during recovery");
	}
	try {
		linkSync(temporary, finalPath);
		return "linked";
	} catch (error) {
		if (errorCode(error) === "EEXIST") return "existing";
		throw error;
	}
}

function assertLinkedSegmentIdentity(
	temporary: string,
	finalPath: string,
	claim: RotationClaim,
): void {
	const source = segmentFingerprint(temporary);
	const published = segmentFingerprint(finalPath);
	const sameInode = source.dev === published.dev && source.ino === published.ino;
	if (sameInode && published.size === String(claim.gz_bytes)) return;
	throw new RotationSegmentMismatchError(
		claim.file,
		"did not retain the complete temporary segment identity",
	);
}

/** Link a complete temporary gzip to its final name, or adopt an existing
 * final only when its size and SHA-256 exactly match the durable claim. */
export function publishOrVerifyClaimedSegment(
	options: {
		temporary: string;
		finalPath: string;
		claim: RotationClaim;
		verifiedExisting?: VerifiedSegmentFingerprint;
	},
): void {
	const { temporary, finalPath, claim, verifiedExisting } = options;
	if (linkClaimedSegment(temporary, finalPath, claim) === "linked") {
		assertLinkedSegmentIdentity(temporary, finalPath, claim);
		return;
	}
	if (!verifiedExisting) throw new RotationSegmentVerificationRequiredError(claim.file);
	assertSegmentStillVerified(finalPath, claim, verifiedExisting);
}

/** Prove that an older, claim-less pending segment contains exactly the live
 * prefix it proposes to remove. Re-compression uses fixed-size chunks; only
 * file metadata and SHA-256 digests are materialized. */
export function assertSegmentMatchesLivePrefix(options: {
	livePath: string;
	cutBytes: number;
	archiveDir: string;
	segmentFile: string;
}): void {
	const temporary = join(
		options.archiveDir,
		`.verify-${process.pid}-${randomUUID()}.jsonl.gz.tmp`,
	);
	const finalPath = join(options.archiveDir, options.segmentFile);
	try {
		gzipFileRange(options.livePath, 0, options.cutBytes, temporary);
		const sameSize =
			existsSync(finalPath) && statSync(finalPath).size === statSync(temporary).size;
		const sameDigest = sameSize && sha256File(finalPath) === sha256File(temporary);
		if (!sameDigest) {
			throw new RotationSegmentMismatchError(
				options.segmentFile,
				"does not match the live prefix",
			);
		}
	} finally {
		try {
			unlinkSync(temporary);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}
}
