// Coverage companion for compact-rotation-claim.ts. Exercises the corrupt-
// claim / oversize-claim / already-pending / non-ENOENT-cleanup error paths
// that the happy-path segment tests (compact-rotation-segment.test.ts) don't
// reach, plus the publication-conflict resolution branches and every failure
// mode of the link/verify pipeline behind publishOrVerifyClaimedSegment.
// `node:fs`'s `unlinkSync` is partially mocked (delegates to the real
// implementation by default) so the two cleanup-failure branches can be
// exercised without relying on real permission bits.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipFileRange } from "../lib/bounded-file-io.js";
import {
	assertSegmentMatchesLivePrefix,
	createRotationClaim,
	loadRotationClaim,
	publicationConflict,
	publishOrVerifyClaimedSegment,
	removeRotationClaim,
	RotationSegmentMismatchError,
	rotationClaimPath,
	type RotationClaim,
} from "./compact-rotation-claim.js";

const { unlinkSyncSpy, actualUnlinkSyncRef } = vi.hoisted(() => ({
	unlinkSyncSpy: vi.fn(),
	// SAFETY: the ref only ever holds node:fs's real unlinkSync, assigned once
	// below before any test runs; the placeholder shape matches its call signature.
	actualUnlinkSyncRef: { fn: null as unknown as (...args: unknown[]) => unknown },
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	// SAFETY: same signature as the placeholder above; only the call-signature
	// shape is used (mockImplementation), never a property access.
	actualUnlinkSyncRef.fn = actual.unlinkSync as unknown as (...args: unknown[]) => unknown;
	unlinkSyncSpy.mockImplementation(actual.unlinkSync);
	return { ...actual, unlinkSync: unlinkSyncSpy };
});

/** Run `fn`, returning the error it throws (or undefined if it doesn't). Used
 * to carry a real thrown instance from one call into a following assertion
 * without branching inside an `it()` body. */
function catchError(fn: () => void): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

function makeClaim(overrides: Partial<RotationClaim> = {}): RotationClaim {
	return {
		version: 1,
		log: "activity",
		seq: 1,
		file: "activity-0001.jsonl.gz",
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

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-rotation-claim-"));
	unlinkSyncSpy.mockImplementation(actualUnlinkSyncRef.fn);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	unlinkSyncSpy.mockImplementation(actualUnlinkSyncRef.fn);
});

describe("loadRotationClaim", () => {
	it("wraps a JSON parse failure as a corrupt-claim error", () => {
		const path = rotationClaimPath(root, "activity");
		writeFileSync(path, "{not json");
		expect(() => loadRotationClaim(root, "activity")).toThrow(
			expect.objectContaining({
				message: `corrupt activity rotation claim at ${path}`,
				cause: expect.any(SyntaxError),
			}),
		);
	});

	it("refuses to load a claim file larger than the byte ceiling", () => {
		const path = rotationClaimPath(root, "activity");
		writeFileSync(path, "x".repeat(16 * 1024 + 1));
		// requireClaimBytes's own throw is caught by loadRotationClaim's wrapper
		// try/catch, so it surfaces as the wrapped error's `cause`.
		expect(() => loadRotationClaim(root, "activity")).toThrow(
			expect.objectContaining({
				message: `corrupt activity rotation claim at ${path}`,
				cause: expect.objectContaining({
					message: `rotation claim exceeds ${16 * 1024} bytes: ${path}`,
				}),
			}),
		);
	});
});

describe("createRotationClaim", () => {
	it("refuses to create a rotation claim when one is already pending", () => {
		const claim = makeClaim();
		createRotationClaim(root, claim);
		const path = rotationClaimPath(root, "activity");
		expect(() => createRotationClaim(root, claim)).toThrow(
			`pending activity rotation claim already exists at ${path}`,
		);
	});
});

describe("removeRotationClaim", () => {
	it("rethrows a non-ENOENT failure while removing a pending claim", () => {
		const path = rotationClaimPath(root, "activity");
		writeFileSync(path, "{}");
		const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
		unlinkSyncSpy.mockImplementationOnce(() => {
			throw failure;
		});
		expect(() => removeRotationClaim(root, "activity")).toThrow(
			expect.objectContaining({ code: "EACCES", message: "permission denied" }),
		);
	});

	it("does not throw when the claim file is already gone", () => {
		expect(() => removeRotationClaim(root, "activity")).not.toThrow();
	});
});

describe("publicationConflict", () => {
	it("rethrows a filesystem error surfaced while re-verifying a claimed segment", () => {
		const claim = makeClaim();
		const finalPath = join(root, claim.file);
		writeFileSync(finalPath, "placeholder");

		const requiredError = catchError(() =>
			publishOrVerifyClaimedSegment({ temporary: join(root, "unused.tmp"), finalPath, claim }),
		);
		expect(requiredError).toBeInstanceOf(Error);

		rmSync(finalPath);

		expect(() => publicationConflict(requiredError, finalPath, claim)).toThrow(
			expect.objectContaining({ code: "ENOENT" }),
		);
	});

	it("reports an already-mismatched segment as abandon-worthy", () => {
		const claim = makeClaim();
		const error = new RotationSegmentMismatchError(claim.file, "does not match its durable rotation claim");
		expect(publicationConflict(error, undefined, undefined)).toEqual({
			segmentFile: claim.file,
			reason: error.message,
			abandonClaim: true,
		});
	});

	it("returns null for an error that is neither a mismatch nor a verification requirement", () => {
		expect(publicationConflict(new Error("unrelated failure"), undefined, undefined)).toBeNull();
	});
});

describe("publishOrVerifyClaimedSegment", () => {
	it("reports a missing temporary segment during recovery", () => {
		const claim = makeClaim();
		const finalPath = join(root, claim.file);
		expect(() =>
			publishOrVerifyClaimedSegment({ temporary: "", finalPath, claim }),
		).toThrow(`archive segment ${claim.file} is missing during recovery; preserved without indexing`);
	});

	it("rethrows a link failure other than EEXIST", () => {
		const claim = makeClaim();
		const finalPath = join(root, claim.file);
		const temporary = join(root, "missing-temp-source");
		expect(() => publishOrVerifyClaimedSegment({ temporary, finalPath, claim })).toThrow(
			expect.objectContaining({ code: "ENOENT" }),
		);
	});

	it("flags an identity mismatch when the linked segment size disagrees with the claim", () => {
		const body = "prepared-gzip-bytes";
		const temporary = join(root, "prepared.tmp");
		writeFileSync(temporary, body);
		const claim = makeClaim({ gz_bytes: body.length + 1 });
		const finalPath = join(root, claim.file);
		expect(() => publishOrVerifyClaimedSegment({ temporary, finalPath, claim })).toThrow(
			`archive segment ${claim.file} did not retain the complete temporary segment identity; preserved without indexing`,
		);
	});

	it("detects that an already-verified segment changed before finalization", () => {
		const claim = makeClaim();
		const finalPath = join(root, claim.file);
		writeFileSync(finalPath, "original-bytes");
		const staleFingerprint = { dev: "0", ino: "0", size: "0", mtimeNs: "0", ctimeNs: "0" };
		expect(() =>
			publishOrVerifyClaimedSegment({
				temporary: join(root, "unused.tmp"),
				finalPath,
				claim,
				verifiedExisting: staleFingerprint,
			}),
		).toThrow(`archive segment ${claim.file} changed after verification; preserved without indexing`);
	});
});

describe("assertSegmentMatchesLivePrefix", () => {
	it("surfaces a cleanup failure that happens after the prefix comparison succeeds", () => {
		const livePath = join(root, "activity.jsonl");
		const body = "same-bytes";
		writeFileSync(livePath, body);
		const segmentFile = "activity-0001.jsonl.gz";
		const finalPath = join(root, segmentFile);
		gzipFileRange(livePath, 0, body.length, finalPath);

		const cleanupFailure = Object.assign(new Error("device busy"), { code: "EBUSY" });
		unlinkSyncSpy.mockImplementationOnce(() => {
			throw cleanupFailure;
		});

		expect(() =>
			assertSegmentMatchesLivePrefix({
				livePath,
				cutBytes: body.length,
				archiveDir: root,
				segmentFile,
			}),
		).toThrow(expect.objectContaining({ code: "EBUSY", message: "device busy" }));
	});
});
