// Claim-to-segment projection shared by every durable log rotation (the
// activity rotation and the plain daemon-log rotation). A rotation claim and an
// archive-manifest segment describe the same published bytes, so the mapping
// between them and the check that a prepared gzip reproduces the claimed
// prefix are log-agnostic and must not drift per log.

import { statSync } from "node:fs";
import { sha256File } from "../lib/bounded-file-io.js";
import type { ArchiveSegment } from "./compact-plain-state.js";
import { RotationSegmentMismatchError, type RotationClaim } from "./compact-rotation-claim.js";

/** Build the archive-manifest segment a rotation claim describes. */
export function segmentFromClaim(
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

/** Prove a freshly prepared gzip reproduces the bytes the claim recorded. */
export function verifyPreparedGzip(path: string, claim: RotationClaim): void {
	if (statSync(path).size !== claim.gz_bytes || sha256File(path) !== claim.gzip_sha256) {
		throw new RotationSegmentMismatchError(
			claim.file,
			"cannot be reproduced from the recorded live-file prefix",
		);
	}
}
