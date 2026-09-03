import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RotationSegmentMismatchError, type RotationClaim } from "./compact-rotation-claim.js";
import { segmentFromClaim, verifyPreparedGzip } from "./compact-rotation-segment.js";

function makeClaim(overrides: Partial<RotationClaim> = {}): RotationClaim {
	return {
		version: 1,
		log: "activity",
		seq: 3,
		file: "activity-0003.jsonl.gz",
		cut_bytes: 120,
		records: 7,
		gz_bytes: 42,
		gzip_sha256: "0".repeat(64),
		created_at: "2026-01-01T00:00:00.000Z",
		source: { dev: "1", ino: "2" },
		replacement: { dev: "1", ino: "5" },
		...overrides,
	};
}

describe("segmentFromClaim", () => {
	it("projects every claim field onto the archive segment", () => {
		const claim = makeClaim();
		expect(segmentFromClaim(claim)).toEqual({
			seq: 3,
			file: "activity-0003.jsonl.gz",
			bytes: 120,
			gz_bytes: 42,
			records: 7,
			created_at: "2026-01-01T00:00:00.000Z",
		});
	});

	it("omits pending_live_drop when no pending record is supplied", () => {
		expect(Object.hasOwn(segmentFromClaim(makeClaim()), "pending_live_drop")).toBe(false);
	});

	it("attaches the supplied pending_live_drop verbatim", () => {
		const pending = {
			cut_bytes: 120,
			source: { dev: "1", ino: "2" },
			replacement: { dev: "1", ino: "5" },
			synced_through_bytes: 11,
		};
		expect(segmentFromClaim(makeClaim(), pending).pending_live_drop).toEqual(pending);
	});

	it("carries a plain log name through unchanged", () => {
		const claim = makeClaim({ log: "timeline", file: "timeline-0001.jsonl.gz", seq: 1 });
		expect(segmentFromClaim(claim)).toMatchObject({ seq: 1, file: "timeline-0001.jsonl.gz" });
	});
});

describe("verifyPreparedGzip", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "interlinked-rotation-segment-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function writeBlob(name: string, body: string): string {
		const path = join(root, name);
		writeFileSync(path, body);
		return path;
	}

	function sha(body: string): string {
		return createHash("sha256").update(body).digest("hex");
	}

	it("returns without throwing when size and digest both match", () => {
		const body = "prepared-gzip-bytes";
		const path = writeBlob("ok.gz", body);
		const claim = makeClaim({ gz_bytes: body.length, gzip_sha256: sha(body) });
		expect(() => verifyPreparedGzip(path, claim)).not.toThrow();
	});

	it("throws a mismatch error naming the claim file when the size differs", () => {
		const body = "prepared-gzip-bytes";
		const path = writeBlob("size.gz", body);
		const claim = makeClaim({ gz_bytes: body.length + 1, gzip_sha256: sha(body) });
		expect(() => verifyPreparedGzip(path, claim)).toThrow(RotationSegmentMismatchError);
		expect(() => verifyPreparedGzip(path, claim)).toThrow(
			/activity-0003\.jsonl\.gz cannot be reproduced from the recorded live-file prefix/,
		);
	});

	it("throws when the size matches but the digest does not", () => {
		const body = "prepared-gzip-bytes";
		const path = writeBlob("digest.gz", body);
		const claim = makeClaim({ gz_bytes: body.length, gzip_sha256: sha("other-bytes-entirely") });
		expect(() => verifyPreparedGzip(path, claim)).toThrow(RotationSegmentMismatchError);
	});

	it("names the claim file rather than the on-disk temporary path", () => {
		const body = "prepared-gzip-bytes";
		const path = writeBlob("temporary.gz.tmp", body);
		const claim = makeClaim({ gz_bytes: 0, gzip_sha256: sha(body) });
		expect(() => verifyPreparedGzip(path, claim)).toThrow(
			new RotationSegmentMismatchError(
				"activity-0003.jsonl.gz",
				"cannot be reproduced from the recorded live-file prefix",
			),
		);
	});
});
