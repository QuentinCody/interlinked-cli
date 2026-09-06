// Coverage companion for compact-plain-rotation.ts. compact-plain.test.ts
// already proves the common publish/dry-run/idempotent-rerun paths through
// the facade; this file targets the crash-recovery edge cases that only show
// up when a manifest's pending-drop row, a durable rotation claim, or an
// unrelated file at the target archive path disagree with each other or with
// the live log's on-disk identity — the seams recoverPendingPlainRotation,
// recoverClaimedPlainRotation, finishPreviouslyReplacedPlainLog,
// assertPlainPendingMatchesClaim, storeClaimedPlainSegment, and
// publishPlainRotation's conflict resolution exist to guard. `node:fs`'s
// `unlinkSync` and `readdirSync` are partially mocked (delegate to the real
// implementation by default) so a non-ENOENT cleanup failure and a
// directory-scan race can be staged without relying on real permission bits
// or genuine concurrent processes.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256File } from "../lib/bounded-file-io.js";
import { gzipFileRange } from "../lib/bounded-file-transfer.js";
import { fileIdentity, type FileIdentity } from "../lib/file-suffix-replacement.js";
import { compactPlainLog } from "./compact-plain-rotation.js";
import {
	createRotationClaim,
	rotationClaimPath,
	type RotationClaim,
} from "./compact-rotation-claim.js";

const { unlinkSyncSpy, readdirSyncSpy, statSyncSpy, actualFsRef } = vi.hoisted(() => ({
	unlinkSyncSpy: vi.fn(),
	readdirSyncSpy: vi.fn(),
	statSyncSpy: vi.fn(),
	// SAFETY: only ever holds node:fs's real implementations, assigned once
	// below before any test runs; the placeholder shape matches their call
	// signatures.
	actualFsRef: {
		// SAFETY: only ever assigned node:fs's real unlinkSync/readdirSync/
		// statSync below, before any test runs; the null/unknown placeholders
		// exist purely so the object's shape is declared ahead of that
		// assignment.
		unlinkSync: null as unknown as (...args: unknown[]) => unknown,
		readdirSync: null as unknown as (...args: unknown[]) => unknown,
		statSync: null as unknown as (...args: unknown[]) => unknown,
	},
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	// SAFETY: all three hold the real node:fs functions from `actual`; only
	// their call-signature shape is used (mockImplementation / direct
	// invocation), never a function-specific property.
	actualFsRef.unlinkSync = actual.unlinkSync as unknown as (...args: unknown[]) => unknown;
	actualFsRef.readdirSync = actual.readdirSync as unknown as (...args: unknown[]) => unknown;
	actualFsRef.statSync = actual.statSync as unknown as (...args: unknown[]) => unknown;
	unlinkSyncSpy.mockImplementation(actual.unlinkSync);
	readdirSyncSpy.mockImplementation(actual.readdirSync);
	statSyncSpy.mockImplementation(actual.statSync);
	return { ...actual, unlinkSync: unlinkSyncSpy, readdirSync: readdirSyncSpy, statSync: statSyncSpy };
});

let cwd: string;
let dataDir: string;
let archiveDir: string;

function writeLog(name: string, lines: string[]): string {
	const path = join(dataDir, `${name}.jsonl`);
	writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
	return path;
}

function jsonLine(i: number): string {
	return JSON.stringify({ seq: i, kind: "tool_event", payload: "x".repeat(64) });
}

/** A structurally valid claim with every field overridable, so each test
 * only states what makes it distinctive. */
function makeClaim(overrides: Partial<RotationClaim> = {}): RotationClaim {
	return {
		version: 1,
		log: "collection",
		seq: 1,
		file: "collection-0001.jsonl.gz",
		cut_bytes: 10,
		records: 1,
		gz_bytes: 8,
		gzip_sha256: "a".repeat(64),
		created_at: "2026-08-31T00:00:00.000Z",
		source: { dev: "111", ino: "111" },
		replacement: { dev: "222", ino: "222" },
		...overrides,
	};
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "compact-plain-rotation-"));
	dataDir = join(cwd, ".interlinked");
	archiveDir = join(dataDir, "archive");
	mkdirSync(dataDir, { recursive: true });
	unlinkSyncSpy.mockImplementation(actualFsRef.unlinkSync);
	readdirSyncSpy.mockImplementation(actualFsRef.readdirSync);
	statSyncSpy.mockImplementation(actualFsRef.statSync);
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("compactPlainLog — pending-drop recovery without a durable claim", () => {
	it("skips recovery when the pending row's source no longer matches the live file identity", () => {
		const logPath = writeLog("collection", [jsonLine(1)]);
		const liveBytes = readFileSync(logPath);
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(
			join(archiveDir, "manifest-collection.json"),
			JSON.stringify({
				version: 1,
				segments: [
					{
						seq: 1,
						file: "collection-0001.jsonl.gz",
						bytes: 10,
						gz_bytes: 8,
						records: 1,
						created_at: "2026-08-31T00:00:00.000Z",
						pending_live_drop: {
							cut_bytes: 10,
							source: { dev: "999", ino: "999" },
							replacement: { dev: "998", ino: "998" },
						},
					},
				],
			}),
		);

		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 1024 });

		expect(res.compacted).toBe(false);
		expect(res.reason).toBe("pending rotation no longer matches the live file identity");
		expect(readFileSync(logPath).equals(liveBytes)).toBe(true);
	});

	it("dry run reports a pending manifest recovery is needed, without touching disk", () => {
		const logPath = writeLog("collection", [jsonLine(1), jsonLine(2)]);
		const before = readFileSync(logPath);
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(
			join(archiveDir, "manifest-collection.json"),
			JSON.stringify({
				version: 1,
				segments: [
					{
						seq: 1,
						file: "collection-0001.jsonl.gz",
						bytes: 10,
						gz_bytes: 8,
						records: 1,
						created_at: "2026-08-31T00:00:00.000Z",
						pending_live_drop: {
							cut_bytes: 10,
							source: { dev: "1", ino: "1" },
							replacement: { dev: "1", ino: "2" },
						},
					},
				],
			}),
		);

		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 1024, dryRun: true });

		expect(res.compacted).toBe(false);
		expect(res.reason).toBe("pending rotation collection-0001.jsonl.gz needs recovery");
		expect(readFileSync(logPath).equals(before)).toBe(true);
	});
});

describe("compactPlainLog — pending manifest row reconciled against a durable claim", () => {
	it("refuses to recover when a pending row and its claim disagree", () => {
		const logPath = writeLog("collection", [jsonLine(1)]);
		mkdirSync(archiveDir, { recursive: true });
		const source: FileIdentity = { dev: "10", ino: "20" };
		const replacement: FileIdentity = { dev: "10", ino: "30" };
		const claim = makeClaim({ source, replacement, records: 4 });
		createRotationClaim(archiveDir, claim);
		writeFileSync(
			join(archiveDir, "manifest-collection.json"),
			JSON.stringify({
				version: 1,
				segments: [
					{
						seq: 1,
						file: claim.file,
						bytes: claim.cut_bytes,
						gz_bytes: claim.gz_bytes,
						// mismatched vs claim.records (4) — the reconciliation must fail
						records: 999,
						created_at: claim.created_at,
						pending_live_drop: { cut_bytes: claim.cut_bytes, source, replacement },
					},
				],
			}),
		);

		expect(() => compactPlainLog("collection", { cwd, keepRecentBytes: 1024 })).toThrow(
			/does not match its pending manifest and durable claim/,
		);
		expect(readFileSync(logPath, "utf-8")).toContain(jsonLine(1));
	});

	it("recovers a claim whose pending row survived a crash before the rename completed", () => {
		const lines = Array.from({ length: 60 }, (_, i) => jsonLine(i));
		const logPath = writeLog("collection", lines);
		const original = readFileSync(logPath);
		const cutBytes = Buffer.byteLength(`${lines.slice(0, 40).join("\n")}\n`);
		mkdirSync(archiveDir, { recursive: true });
		const segmentFile = "collection-0001.jsonl.gz";
		const finalPath = join(archiveDir, segmentFile);
		const { gzipBytes } = gzipFileRange(logPath, 0, cutBytes, finalPath);
		const gzipSha256 = sha256File(finalPath);
		const source = fileIdentity(logPath);
		const probePath = join(dataDir, ".replacement-probe");
		writeFileSync(probePath, "probe");
		const replacement = fileIdentity(probePath);
		const claim = makeClaim({
			cut_bytes: cutBytes,
			records: 40,
			gz_bytes: gzipBytes,
			gzip_sha256: gzipSha256,
			source,
			replacement,
		});
		createRotationClaim(archiveDir, claim);
		writeFileSync(
			join(archiveDir, "manifest-collection.json"),
			JSON.stringify({
				version: 1,
				segments: [
					{
						seq: 1,
						file: segmentFile,
						bytes: cutBytes,
						gz_bytes: gzipBytes,
						records: 40,
						created_at: claim.created_at,
						pending_live_drop: { cut_bytes: cutBytes, source, replacement },
					},
				],
			}),
		);

		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 1024 * 1024 });

		expect(res.compacted).toBe(true);
		expect(res.segment).toBe(segmentFile);
		const manifest = JSON.parse(
			readFileSync(join(archiveDir, "manifest-collection.json"), "utf-8"),
		);
		expect(manifest.segments).toHaveLength(1);
		expect(manifest.segments[0].pending_live_drop).toBeUndefined();
		expect(existsSync(rotationClaimPath(archiveDir, "collection"))).toBe(false);
		const reassembled = Buffer.concat([gunzipSync(readFileSync(finalPath)), readFileSync(logPath)]);
		expect(reassembled.equals(original)).toBe(true);
	});
});

describe("compactPlainLog — claim-only recovery (manifest has no pending row)", () => {
	it("dry run reports a claimed rotation needs recovery", () => {
		const logPath = writeLog("collection", [jsonLine(1)]);
		const before = readFileSync(logPath);
		mkdirSync(archiveDir, { recursive: true });
		createRotationClaim(archiveDir, makeClaim());

		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 1024, dryRun: true });

		expect(res.compacted).toBe(false);
		expect(res.reason).toBe("pending rotation collection-0001.jsonl.gz needs recovery");
		expect(readFileSync(logPath).equals(before)).toBe(true);
	});

	it("skips a claimed rotation whose source no longer matches the live file identity", () => {
		const logPath = writeLog("collection", [jsonLine(1)]);
		const before = readFileSync(logPath);
		mkdirSync(archiveDir, { recursive: true });
		createRotationClaim(archiveDir, makeClaim());

		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 1024 });

		expect(res.compacted).toBe(false);
		expect(res.reason).toBe("claimed rotation no longer matches the live file identity");
		expect(readFileSync(logPath).equals(before)).toBe(true);
	});

	it("finalizes a claim whose live file was already renamed but never recorded", () => {
		const prefix = "archived-prefix\n";
		const gz = gzipSync(Buffer.from(prefix));
		mkdirSync(archiveDir, { recursive: true });
		const segmentFile = "collection-0001.jsonl.gz";
		const finalPath = join(archiveDir, segmentFile);
		writeFileSync(finalPath, gz);
		// The live file already IS the post-rotation tail: its identity is the
		// claim's `replacement`, matching a crash that landed the rename but
		// died before the manifest/claim bookkeeping caught up.
		const tailPath = writeLog("collection", [jsonLine(1)]);
		const tailBefore = readFileSync(tailPath);
		const sourceProbe = join(dataDir, ".source-probe");
		writeFileSync(sourceProbe, "source");
		const claim = makeClaim({
			cut_bytes: Buffer.byteLength(prefix),
			records: 1,
			gz_bytes: gz.length,
			gzip_sha256: sha256File(finalPath),
			source: fileIdentity(sourceProbe),
			replacement: fileIdentity(tailPath),
		});
		createRotationClaim(archiveDir, claim);

		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 1024 * 1024 });

		expect(res.compacted).toBe(true);
		expect(res.segment).toBe(segmentFile);
		const manifest = JSON.parse(
			readFileSync(join(archiveDir, "manifest-collection.json"), "utf-8"),
		);
		expect(manifest.segments).toHaveLength(1);
		expect(manifest.segments[0].file).toBe(segmentFile);
		expect(manifest.segments[0].pending_live_drop).toBeUndefined();
		expect(existsSync(rotationClaimPath(archiveDir, "collection"))).toBe(false);
		expect(readFileSync(tailPath).equals(tailBefore)).toBe(true);
	});

	it("refuses to store a claim over a manifest entry that already fully owns its filename", () => {
		const lines = Array.from({ length: 10 }, (_, i) => jsonLine(i));
		const logPath = writeLog("collection", lines);
		const original = readFileSync(logPath);
		mkdirSync(archiveDir, { recursive: true });
		const cutBytes = Buffer.byteLength(`${lines.slice(0, 3).join("\n")}\n`);
		const scratchGz = join(dataDir, ".claim-gz-scratch");
		const { gzipBytes } = gzipFileRange(logPath, 0, cutBytes, scratchGz);
		const gzipSha256 = sha256File(scratchGz);
		const probePath = join(dataDir, ".replacement-probe-178");
		writeFileSync(probePath, "probe");
		const claim = makeClaim({
			cut_bytes: cutBytes,
			records: 3,
			gz_bytes: gzipBytes,
			gzip_sha256: gzipSha256,
			source: fileIdentity(logPath),
			replacement: fileIdentity(probePath),
		});
		createRotationClaim(archiveDir, claim);
		// A COMPLETE (no pending_live_drop, not `recovered`) entry already owns
		// this exact filename — the conflict storeClaimedPlainSegment refuses to
		// silently overwrite.
		writeFileSync(
			join(archiveDir, "manifest-collection.json"),
			JSON.stringify({
				version: 1,
				segments: [
					{
						seq: 1,
						file: claim.file,
						bytes: claim.cut_bytes,
						gz_bytes: claim.gz_bytes,
						records: claim.records,
						created_at: claim.created_at,
					},
				],
			}),
		);
		const manifestBefore = readFileSync(join(archiveDir, "manifest-collection.json"), "utf-8");

		expect(() => compactPlainLog("collection", { cwd, keepRecentBytes: 1024 * 1024 })).toThrow(
			"collection manifest already contains claimed segment collection-0001.jsonl.gz",
		);
		expect(readFileSync(logPath).equals(original)).toBe(true);
		expect(readFileSync(join(archiveDir, "manifest-collection.json"), "utf-8")).toBe(
			manifestBefore,
		);
	});
});

describe("compactPlainLog — finalize-time identity race", () => {
	it("refuses to finalize when the live file changes identity after the outer check but before the lock", () => {
		const tailPath = writeLog("collection", [jsonLine(1)]);
		mkdirSync(archiveDir, { recursive: true });
		const prefix = "archived-prefix\n";
		const gz = gzipSync(Buffer.from(prefix));
		const segmentFile = "collection-0001.jsonl.gz";
		const finalPath = join(archiveDir, segmentFile);
		writeFileSync(finalPath, gz);
		const sourceProbe = join(dataDir, ".source-probe-215");
		writeFileSync(sourceProbe, "source");
		const claim = makeClaim({
			cut_bytes: Buffer.byteLength(prefix),
			records: 1,
			gz_bytes: gz.length,
			gzip_sha256: sha256File(finalPath),
			source: fileIdentity(sourceProbe),
			replacement: fileIdentity(tailPath),
		});
		createRotationClaim(archiveDir, claim);

		// The outer `recoverClaimedPlainRotation` check sees the real identity
		// (matches claim.replacement, routing into the already-renamed path).
		// The SECOND read of the same path — inside the lock, right before
		// finalizing — is answered with a different identity, modeling another
		// process replacing the file in the gap between the two checks.
		let bigintReadsOfTail = 0;
		statSyncSpy.mockImplementation((path: unknown, options?: unknown) => {
			const isBigintIdentityRead =
				path === tailPath &&
				typeof options === "object" &&
				options !== null &&
				(options as { bigint?: boolean }).bigint === true;
			if (isBigintIdentityRead) {
				bigintReadsOfTail += 1;
				if (bigintReadsOfTail === 2) {
					return { dev: 999_999n, ino: 999_999n };
				}
			}
			return (actualFsRef.statSync as (...a: unknown[]) => unknown)(path, options);
		});

		expect(() => compactPlainLog("collection", { cwd, keepRecentBytes: 1024 * 1024 })).toThrow(
			"collection.jsonl changed while finalizing a claimed rotation",
		);
		expect(bigintReadsOfTail).toBeGreaterThanOrEqual(2);
		expect(existsSync(rotationClaimPath(archiveDir, "collection"))).toBe(true);
	});
});

describe("compactPlainLog — already-renamed finalize with a matching pending row", () => {
	it("completes a pending manifest row left by a crash right after the rename", () => {
		const tailPath = writeLog("collection", [jsonLine(1)]);
		mkdirSync(archiveDir, { recursive: true });
		const prefix = "archived-prefix\n";
		const gz = gzipSync(Buffer.from(prefix));
		const segmentFile = "collection-0001.jsonl.gz";
		const finalPath = join(archiveDir, segmentFile);
		writeFileSync(finalPath, gz);
		const sourceProbe = join(dataDir, ".source-probe-231");
		writeFileSync(sourceProbe, "source");
		const claim = makeClaim({
			cut_bytes: Buffer.byteLength(prefix),
			records: 1,
			gz_bytes: gz.length,
			gzip_sha256: sha256File(finalPath),
			source: fileIdentity(sourceProbe),
			replacement: fileIdentity(tailPath),
		});
		createRotationClaim(archiveDir, claim);
		writeFileSync(
			join(archiveDir, "manifest-collection.json"),
			JSON.stringify({
				version: 1,
				segments: [
					{
						seq: 1,
						file: claim.file,
						bytes: claim.cut_bytes,
						gz_bytes: claim.gz_bytes,
						records: claim.records,
						created_at: claim.created_at,
						pending_live_drop: {
							cut_bytes: claim.cut_bytes,
							source: claim.source,
							replacement: claim.replacement,
						},
					},
				],
			}),
		);

		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 1024 * 1024 });

		expect(res.compacted).toBe(true);
		expect(res.segment).toBe(segmentFile);
		const manifest = JSON.parse(
			readFileSync(join(archiveDir, "manifest-collection.json"), "utf-8"),
		);
		expect(manifest.segments).toHaveLength(1);
		expect(manifest.segments[0].pending_live_drop).toBeUndefined();
		expect(existsSync(rotationClaimPath(archiveDir, "collection"))).toBe(false);
	});
});

describe("compactPlainLog — fresh-publish conflict resolution", () => {
	it("abandons the claim and reports the conflict when the target archive path already holds unrelated bytes", () => {
		const lines = Array.from({ length: 60 }, (_, i) => jsonLine(i));
		const logPath = writeLog("collection", lines);
		const original = readFileSync(logPath);
		mkdirSync(archiveDir, { recursive: true });
		const wrongPath = join(archiveDir, "collection-0001.jsonl.gz");
		const wrongBytes = Buffer.from("not-our-segment");
		writeFileSync(wrongPath, wrongBytes);
		// Simulate the TOCTOU window the recovery path exists for: the file is
		// physically present (another writer raced past us) but was still
		// invisible to our own directory scan when we picked the next sequence.
		readdirSyncSpy.mockImplementation((path: unknown, ...rest: unknown[]) => {
			if (path === archiveDir) return [];
			return (actualFsRef.readdirSync as (...a: unknown[]) => unknown)(path, ...rest);
		});

		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 128 });

		expect(res.compacted).toBe(false);
		expect(res.reason).toBe(
			"archive segment collection-0001.jsonl.gz does not match its durable rotation claim; preserved without indexing",
		);
		expect(readFileSync(wrongPath).equals(wrongBytes)).toBe(true);
		expect(readFileSync(logPath).equals(original)).toBe(true);
		expect(existsSync(rotationClaimPath(archiveDir, "collection"))).toBe(false);
	});

	it("propagates a non-ENOENT failure while cleaning up the gzip temp file", () => {
		writeLog("collection", Array.from({ length: 60 }, (_, i) => jsonLine(i)));
		unlinkSyncSpy.mockImplementation((path: unknown, ...rest: unknown[]) => {
			if (typeof path === "string" && path.endsWith(".jsonl.gz.tmp")) {
				// SAFETY: NodeJS.ErrnoException only adds an optional `code` field
				// on top of Error; setting it below satisfies the interface.
				const error = new Error("permission denied") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			}
			return (actualFsRef.unlinkSync as (...a: unknown[]) => unknown)(path, ...rest);
		});

		expect(() => compactPlainLog("collection", { cwd, keepRecentBytes: 128 })).toThrow(
			"permission denied",
		);
	});
});
