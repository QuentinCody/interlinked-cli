import { wireArray, wireLiteral, wireNumber, wireString } from "../lib/value-validation.js";
import { wireAbsentOptional, parseWire, wireBoolean, wireObject, wireOptional } from "../lib/value-validation.js";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileIdentity } from "../lib/file-suffix-replacement.js";
import { sha256File } from "../lib/bounded-file-io.js";
import type { JsonObject } from "../lib/json-types.js";
import {
	removeTemporary,
	resumePendingActivityRotation,
	rotateActivityPrefix,
	storeClaimedActivitySegment,
} from "./compact-activity-write.js";
import type { ArchiveManifest } from "./compact-plain.js";
import {
	createRotationClaim,
	rotationClaimPath,
} from "./compact-rotation-claim.js";

const isCapturedArchiveManifest = wireObject({ "version": wireLiteral(1), "segments": wireArray(wireObject({ "seq": wireNumber, "file": wireString, "bytes": wireNumber, "gz_bytes": wireNumber, "records": wireNumber, "created_at": wireString, "recovered": wireAbsentOptional(wireLiteral(false, true)), "pending_live_drop": wireAbsentOptional(wireObject({ "cut_bytes": wireNumber, "source": wireObject({ "dev": wireString, "ino": wireString }), "replacement": wireObject({ "dev": wireString, "ino": wireString }), "synced_through_bytes": wireAbsentOptional(wireNumber) })) })) });

// `node:fs`'s `statSync` is partially mocked (delegates to the real
// implementation by default, same recipe as compact-plain-rotation.test.ts)
// so the finalize-time identity race — the live file's identity changing
// between recoverClaimedActivityRotation's outer check and the re-check
// inside the mutation lock — can be staged deterministically instead of
// relying on genuine concurrent processes.
const { statSyncSpy, actualStatSyncRef } = vi.hoisted(() => {
	const actualStatSyncRef: { statSync: typeof import("node:fs").statSync } = {
		statSync: () => { throw new Error("statSync has not been initialized"); },
	};
	return { statSyncSpy: vi.fn(), actualStatSyncRef };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	actualStatSyncRef.statSync = actual.statSync;
	statSyncSpy.mockImplementation(actual.statSync);
	return { ...actual, statSync: statSyncSpy };
});

describe("activity rotation — append safety and crash recovery", () => {
	let root: string;
	let dataDir: string;
	let archiveDir: string;
	let activityPath: string;
	let syncStatePath: string;
	let manifestPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "interlinked-activity-rotation-"));
		dataDir = join(root, ".interlinked");
		archiveDir = join(dataDir, "archive");
		activityPath = join(dataDir, "activity.jsonl");
		syncStatePath = join(dataDir, "sync-state.json");
		manifestPath = join(archiveDir, "manifest.json");
		mkdirSync(archiveDir, { recursive: true });
		statSyncSpy.mockImplementation(actualStatSyncRef.statSync);
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function loadManifest(): ArchiveManifest {
		if (!existsSync(manifestPath)) return { version: 1, segments: [] };
		return parseWire(JSON.parse(readFileSync(manifestPath, "utf8")), isCapturedArchiveManifest, "test JSON value");
	}

	it("preserves an append injected after the suffix copy and before pathname replacement", () => {
		const original = "first\nsecond\ntail\n";
		const late = "late\n";
		writeFileSync(activityPath, original);
		const syncState: JsonObject = { synced_through_bytes: Buffer.byteLength(original) };
		writeFileSync(syncStatePath, JSON.stringify(syncState));

		const result = rotateActivityPrefix({
			activityPath,
			syncStatePath,
			archiveDir,
			manifestPath,
			cutByte: Buffer.byteLength("first\nsecond\n"),
			records: 2,
			syncedBytes: Buffer.byteLength(original),
			source: fileIdentity(activityPath),
			syncState,
			loadManifest,
			nextSequence: () => 1,
			afterInitialCopy: () => appendFileSync(activityPath, late),
		});
		expect("segmentFile" in result).toBe(false);
		if ("segmentFile" in result) throw new Error(result.reason);

		const archived = gunzipSync(
			readFileSync(join(archiveDir, result.segment.file)),
		).toString("utf8");
		const live = readFileSync(activityPath, "utf8");
		expect(archived + live).toBe(original + late);
		expect(live).toBe(`tail\n${late}`);
		expect(loadManifest().segments[0]?.pending_live_drop).toBeUndefined();
	});

	it("preserves a private activity log mode on both the archive and live suffix", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		const original = `${prefix}${tail}`;
		writeFileSync(activityPath, original);
		chmodSync(activityPath, 0o600);
		const syncState: JsonObject = { synced_through_bytes: Buffer.byteLength(original) };
		writeFileSync(syncStatePath, JSON.stringify(syncState));

		const result = rotateActivityPrefix({
			activityPath,
			syncStatePath,
			archiveDir,
			manifestPath,
			cutByte: Buffer.byteLength(prefix),
			records: 2,
			syncedBytes: Buffer.byteLength(original),
			source: fileIdentity(activityPath),
			syncState,
			loadManifest,
			nextSequence: () => 1,
		});
		if ("segmentFile" in result) throw new Error(result.reason);

		expect(statSync(activityPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(archiveDir, result.segment.file)).mode & 0o777).toBe(0o600);
	});

	it("finishes an indexed-but-untruncated prefix without archiving it twice", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		writeFileSync(activityPath, `${prefix}${tail}`);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: prefix.length + tail.length }));
		writeFileSync(join(archiveDir, "activity-0001.jsonl.gz"), gzipSync(prefix));
		const segment = {
			seq: 1,
			file: "activity-0001.jsonl.gz",
			bytes: Buffer.byteLength(prefix),
			gz_bytes: gzipSync(prefix).length,
			records: 2,
			created_at: "2026-08-31T00:00:00.000Z",
			pending_live_drop: {
				cut_bytes: Buffer.byteLength(prefix),
				source: fileIdentity(activityPath),
				replacement: { dev: "0", ino: "0" },
				synced_through_bytes: Buffer.byteLength(tail),
			},
		};
		writeFileSync(manifestPath, JSON.stringify({ version: 1, segments: [segment] }));
		const syncState: JsonObject = { synced_through_bytes: prefix.length + tail.length };

		const result = resumePendingActivityRotation(
			{
				activityPath,
				archiveDir,
				syncStatePath,
				manifestPath,
				syncState,
				loadManifest,
			},
			false,
		);

		expect(result?.recovered).toBe(true);
		expect(result?.segment.file).toBe("activity-0001.jsonl.gz");
		expect(readFileSync(activityPath, "utf8")).toBe(tail);
		expect(loadManifest().segments).toHaveLength(1);
		expect(loadManifest().segments[0]?.pending_live_drop).toBeUndefined();
		expect(JSON.parse(readFileSync(syncStatePath, "utf8"))).toMatchObject({
			synced_through_bytes: Buffer.byteLength(tail),
		});
	});

	it("refuses a claim-less pending cursor beyond the retained suffix before any write", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		const original = `${prefix}${tail}`;
		writeFileSync(activityPath, original);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: original.length }));
		const segmentPath = join(archiveDir, "activity-0001.jsonl.gz");
		writeFileSync(segmentPath, gzipSync(prefix));
		const replacementProbe = join(dataDir, ".replacement-probe");
		writeFileSync(replacementProbe, tail);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: "activity-0001.jsonl.gz",
					bytes: Buffer.byteLength(prefix),
					gz_bytes: readFileSync(segmentPath).length,
					records: 2,
					created_at: "2026-08-31T00:00:00.000Z",
					pending_live_drop: {
						cut_bytes: Buffer.byteLength(prefix),
						source: fileIdentity(activityPath),
						replacement: fileIdentity(replacementProbe),
						synced_through_bytes: 999_999,
					},
				}],
			}),
		);
		const manifestBefore = readFileSync(manifestPath);
		const syncBefore = readFileSync(syncStatePath);

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState: { synced_through_bytes: original.length },
					loadManifest,
				},
				false,
			),
		).toThrow(/sync cursor 999999 exceeds 5 retained activity bytes/);
		expect(readFileSync(activityPath, "utf8")).toBe(original);
		expect(readFileSync(manifestPath).equals(manifestBefore)).toBe(true);
		expect(readFileSync(syncStatePath).equals(syncBefore)).toBe(true);
	});

	it("refuses a claimed source cursor beyond the retained suffix and preserves the claim", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		const original = `${prefix}${tail}`;
		writeFileSync(activityPath, original);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: original.length }));
		const segmentPath = join(archiveDir, "activity-0001.jsonl.gz");
		writeFileSync(segmentPath, gzipSync(prefix));
		const replacementProbe = join(dataDir, ".replacement-probe");
		writeFileSync(replacementProbe, tail);
		createRotationClaim(archiveDir, {
			version: 1,
			log: "activity",
			seq: 1,
			file: "activity-0001.jsonl.gz",
			cut_bytes: Buffer.byteLength(prefix),
			records: 2,
			gz_bytes: readFileSync(segmentPath).length,
			gzip_sha256: sha256File(segmentPath),
			created_at: "2026-08-31T00:00:00.000Z",
			source: fileIdentity(activityPath),
			replacement: fileIdentity(replacementProbe),
			synced_through_bytes: 999_999,
		});
		const claimPath = rotationClaimPath(archiveDir, "activity");
		const claimBefore = readFileSync(claimPath);
		const syncBefore = readFileSync(syncStatePath);

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState: { synced_through_bytes: original.length },
					loadManifest,
				},
				false,
			),
		).toThrow(/sync cursor 999999 exceeds 5 retained activity bytes/);
		expect(readFileSync(activityPath, "utf8")).toBe(original);
		expect(readFileSync(claimPath).equals(claimBefore)).toBe(true);
		expect(readFileSync(syncStatePath).equals(syncBefore)).toBe(true);
		expect(existsSync(manifestPath)).toBe(false);
	});

	it("refuses a pending segment whose gzip does not contain the live prefix", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		const original = `${prefix}${tail}`;
		writeFileSync(activityPath, original);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: original.length }));
		const badGzip = gzipSync("not-the-live-prefix\n");
		writeFileSync(join(archiveDir, "activity-0001.jsonl.gz"), badGzip);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: "activity-0001.jsonl.gz",
					bytes: Buffer.byteLength(prefix),
					gz_bytes: badGzip.length,
					records: 2,
					created_at: "2026-08-31T00:00:00.000Z",
					pending_live_drop: {
						cut_bytes: Buffer.byteLength(prefix),
						source: fileIdentity(activityPath),
						replacement: { dev: "0", ino: "0" },
						synced_through_bytes: Buffer.byteLength(tail),
					},
				}],
			}),
		);
		const syncState: JsonObject = { synced_through_bytes: original.length };

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState,
					loadManifest,
				},
				false,
			),
		).toThrow(/does not match the live prefix/);
		expect(readFileSync(activityPath, "utf8")).toBe(original);
		expect(loadManifest().segments[0]?.pending_live_drop).toBeDefined();
		expect(syncState.synced_through_bytes).toBe(original.length);
	});

	it("does not finalize a claim-less pending row after the live prefix is already gone", () => {
		const liveTail = "tail\n";
		writeFileSync(activityPath, liveTail);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: 0 }));
		const archived = gzipSync("first\nsecond\n");
		writeFileSync(join(archiveDir, "activity-0001.jsonl.gz"), archived);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: "activity-0001.jsonl.gz",
					bytes: 13,
					gz_bytes: archived.length,
					records: 2,
					created_at: "2026-08-31T00:00:00.000Z",
					pending_live_drop: {
						cut_bytes: 13,
						source: { dev: "0", ino: "0" },
						replacement: fileIdentity(activityPath),
						synced_through_bytes: 0,
					},
				}],
			}),
		);

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState: { synced_through_bytes: 0 },
					loadManifest,
				},
				false,
			),
		).toThrow(/has no durable claim/);
		expect(readFileSync(activityPath, "utf8")).toBe(liveTail);
		expect(loadManifest().segments[0]?.pending_live_drop).toBeDefined();
	});

	it("refuses a durable claim that disagrees with its pending manifest", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		const original = `${prefix}${tail}`;
		writeFileSync(activityPath, original);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: original.length }));
		const segmentPath = join(archiveDir, "activity-0001.jsonl.gz");
		writeFileSync(segmentPath, gzipSync(prefix));
		const replacementProbe = join(dataDir, ".replacement-probe");
		writeFileSync(replacementProbe, tail);
		const source = fileIdentity(activityPath);
		const replacement = fileIdentity(replacementProbe);
		const createdAt = "2026-08-31T00:00:00.000Z";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: "activity-0001.jsonl.gz",
					bytes: Buffer.byteLength(prefix),
					gz_bytes: readFileSync(segmentPath).length,
					records: 2,
					created_at: createdAt,
					pending_live_drop: {
						cut_bytes: Buffer.byteLength(prefix),
						source,
						replacement,
						synced_through_bytes: Buffer.byteLength(tail),
					},
				}],
			}),
		);
		createRotationClaim(archiveDir, {
			version: 1,
			log: "activity",
			seq: 1,
			file: "activity-0001.jsonl.gz",
			cut_bytes: Buffer.byteLength(prefix),
			records: 99,
			gz_bytes: readFileSync(segmentPath).length,
			gzip_sha256: sha256File(segmentPath),
			created_at: createdAt,
			source,
			replacement,
			synced_through_bytes: Buffer.byteLength(tail),
		});

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState: { synced_through_bytes: original.length },
					loadManifest,
				},
				false,
			),
		).toThrow(/does not match its pending manifest and durable claim/);
		expect(readFileSync(activityPath, "utf8")).toBe(original);
		expect(existsSync(rotationClaimPath(archiveDir, "activity"))).toBe(true);
		expect(loadManifest().segments[0]?.pending_live_drop).toBeDefined();
	});

	it("does not remove a claim when a complete manifest row contradicts it", () => {
		const prefix = "first\nsecond\n";
		const liveTail = "tail\n";
		writeFileSync(activityPath, liveTail);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: 0 }));
		const segmentPath = join(archiveDir, "activity-0001.jsonl.gz");
		writeFileSync(segmentPath, gzipSync(prefix));
		const createdAt = "2026-08-31T00:00:00.000Z";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: "activity-0001.jsonl.gz",
					bytes: Buffer.byteLength(prefix),
					gz_bytes: readFileSync(segmentPath).length,
					records: 999,
					created_at: createdAt,
				}],
			}),
		);
		createRotationClaim(archiveDir, {
			version: 1,
			log: "activity",
			seq: 1,
			file: "activity-0001.jsonl.gz",
			cut_bytes: Buffer.byteLength(prefix),
			records: 2,
			gz_bytes: readFileSync(segmentPath).length,
			gzip_sha256: sha256File(segmentPath),
			created_at: createdAt,
			source: { dev: "0", ino: "0" },
			replacement: fileIdentity(activityPath),
			synced_through_bytes: 0,
		});

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState: { synced_through_bytes: 0 },
					loadManifest,
				},
				false,
			),
		).toThrow(/does not match its durable rotation claim/);
		expect(readFileSync(activityPath, "utf8")).toBe(liveTail);
		expect(existsSync(rotationClaimPath(archiveDir, "activity"))).toBe(true);
		expect(loadManifest().segments[0]?.records).toBe(999);
	});

	it("removeTemporary silently absorbs an already-removed temporary file", () => {
		const missingPath = join(dataDir, "already-gone.tmp");
		expect(existsSync(missingPath)).toBe(false);

		expect(() => removeTemporary(missingPath)).not.toThrow();

		expect(existsSync(missingPath)).toBe(false);
	});

	it("removeTemporary rethrows a non-ENOENT unlink failure", () => {
		expect(() => removeTemporary(archiveDir)).toThrow(/EPERM|EISDIR/);
		expect(existsSync(archiveDir)).toBe(true);
	});

	it("storeClaimedActivitySegment refuses to overwrite an already-claimed, non-pending manifest entry", () => {
		const claim = {
			version: 1 as const,
			log: "activity" as const,
			seq: 1,
			file: "activity-0001.jsonl.gz",
			gz_bytes: 5,
			gzip_sha256: "deadbeef",
			cut_bytes: 10,
			records: 2,
			created_at: "2026-08-31T00:00:00.000Z",
			source: { dev: "0", ino: "0" },
			replacement: { dev: "1", ino: "1" },
			synced_through_bytes: 0,
		};
		const deps = {
			activityPath,
			archiveDir,
			syncStatePath,
			manifestPath,
			syncState: { synced_through_bytes: 0 },
			loadManifest: () => ({
				version: 1 as const,
				segments: [
					{
						seq: 1,
						file: "activity-0001.jsonl.gz",
						bytes: 10,
						gz_bytes: 5,
						records: 2,
						created_at: "2026-08-31T00:00:00.000Z",
					},
				],
			}),
		};

		expect(() => storeClaimedActivitySegment(deps, claim, { dev: "2", ino: "2" })).toThrow(
			"activity manifest already contains claimed segment activity-0001.jsonl.gz",
		);
	});

	it("storeClaimedActivitySegment replaces a pending entry that matches the claim", () => {
		const claim = {
			version: 1 as const,
			log: "activity" as const,
			seq: 1,
			file: "activity-0001.jsonl.gz",
			gz_bytes: 5,
			gzip_sha256: "deadbeef",
			cut_bytes: 10,
			records: 2,
			created_at: "2026-08-31T00:00:00.000Z",
			source: { dev: "0", ino: "0" },
			replacement: { dev: "1", ino: "1" },
			synced_through_bytes: 0,
		};
		const deps = {
			activityPath,
			archiveDir,
			syncStatePath,
			manifestPath,
			syncState: { synced_through_bytes: 0 },
			loadManifest: () => ({
				version: 1 as const,
				segments: [
					{
						seq: 1,
						file: "activity-0001.jsonl.gz",
						bytes: 10,
						gz_bytes: 5,
						records: 2,
						created_at: "2026-08-31T00:00:00.000Z",
						pending_live_drop: {
							cut_bytes: 10,
							source: { dev: "0", ino: "0" },
							replacement: { dev: "1", ino: "1" },
							synced_through_bytes: 0,
						},
					},
				],
			}),
		};

		const result = storeClaimedActivitySegment(deps, claim, { dev: "3", ino: "3" });

		expect(result).toEqual({
			seq: 1,
			file: "activity-0001.jsonl.gz",
			bytes: 10,
			gz_bytes: 5,
			records: 2,
			created_at: "2026-08-31T00:00:00.000Z",
			pending_live_drop: {
				cut_bytes: 10,
				source: { dev: "0", ino: "0" },
				replacement: { dev: "3", ino: "3" },
				synced_through_bytes: 0,
			},
		});
		expect(JSON.parse(readFileSync(manifestPath, "utf8")).segments[0]).toEqual(result);
	});

	it("returns a dry-run preview of a claim-less pending segment without recovering it", () => {
		const tail = "tail\n";
		writeFileSync(activityPath, tail);
		const segment = {
			seq: 1,
			file: "activity-0001.jsonl.gz",
			bytes: 12,
			gz_bytes: 4,
			records: 2,
			created_at: "2026-08-31T00:00:00.000Z",
			pending_live_drop: {
				cut_bytes: 12,
				source: { dev: "0", ino: "0" },
				replacement: fileIdentity(activityPath),
				synced_through_bytes: 7,
			},
		};
		writeFileSync(manifestPath, JSON.stringify({ version: 1, segments: [segment] }));

		const result = resumePendingActivityRotation(
			{
				activityPath,
				archiveDir,
				syncStatePath,
				manifestPath,
				syncState: { synced_through_bytes: 0 },
				loadManifest,
			},
			true,
		);

		expect(result).toEqual({
			segment,
			liveAfterBytes: Buffer.byteLength(tail),
			syncedThroughBytes: 7,
			recovered: false,
		});
		expect(readFileSync(activityPath, "utf8")).toBe(tail);
	});

	it("returns a dry-run preview from a durable claim when no pending manifest entry exists", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		const original = `${prefix}${tail}`;
		writeFileSync(activityPath, original);
		const segmentPath = join(archiveDir, "activity-0001.jsonl.gz");
		writeFileSync(segmentPath, gzipSync(prefix));
		createRotationClaim(archiveDir, {
			version: 1,
			log: "activity",
			seq: 1,
			file: "activity-0001.jsonl.gz",
			cut_bytes: Buffer.byteLength(prefix),
			records: 2,
			gz_bytes: readFileSync(segmentPath).length,
			gzip_sha256: sha256File(segmentPath),
			created_at: "2026-08-31T00:00:00.000Z",
			source: fileIdentity(activityPath),
			replacement: { dev: "0", ino: "0" },
			synced_through_bytes: 42,
		});

		const result = resumePendingActivityRotation(
			{
				activityPath,
				archiveDir,
				syncStatePath,
				manifestPath,
				syncState: { synced_through_bytes: original.length },
				loadManifest,
			},
			true,
		);

		expect(result).toEqual({
			segment: {
				seq: 1,
				file: "activity-0001.jsonl.gz",
				bytes: Buffer.byteLength(prefix),
				gz_bytes: readFileSync(segmentPath).length,
				records: 2,
				created_at: "2026-08-31T00:00:00.000Z",
			},
			liveAfterBytes: Buffer.byteLength(original),
			syncedThroughBytes: 42,
			recovered: false,
		});
		expect(readFileSync(activityPath, "utf8")).toBe(original);
		expect(existsSync(rotationClaimPath(archiveDir, "activity"))).toBe(true);
	});

	it("refuses a claim-less pending rotation whose source no longer matches the live file", () => {
		const tail = "tail\n";
		writeFileSync(activityPath, tail);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				segments: [
					{
						seq: 1,
						file: "activity-0001.jsonl.gz",
						bytes: 13,
						gz_bytes: 5,
						records: 2,
						created_at: "2026-08-31T00:00:00.000Z",
						pending_live_drop: {
							cut_bytes: 13,
							source: { dev: "0", ino: "0" },
							replacement: { dev: "1", ino: "1" },
							synced_through_bytes: 0,
						},
					},
				],
			}),
		);

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState: { synced_through_bytes: 0 },
					loadManifest,
				},
				false,
			),
		).toThrow(/pending activity rotation no longer matches the live file identity/);
		expect(readFileSync(activityPath, "utf8")).toBe(tail);
	});

	it("finalizes a claimed replacement into a fresh manifest entry when none exists yet", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		writeFileSync(activityPath, tail);
		const segmentPath = join(archiveDir, "activity-0001.jsonl.gz");
		writeFileSync(segmentPath, gzipSync(prefix));
		const claim = {
			version: 1 as const,
			log: "activity" as const,
			seq: 1,
			file: "activity-0001.jsonl.gz",
			cut_bytes: Buffer.byteLength(prefix),
			records: 2,
			gz_bytes: readFileSync(segmentPath).length,
			gzip_sha256: sha256File(segmentPath),
			created_at: "2026-08-31T00:00:00.000Z",
			source: { dev: "0", ino: "0" },
			replacement: fileIdentity(activityPath),
			synced_through_bytes: 3,
		};
		createRotationClaim(archiveDir, claim);

		const result = resumePendingActivityRotation(
			{
				activityPath,
				archiveDir,
				syncStatePath,
				manifestPath,
				syncState: { synced_through_bytes: 0 },
				loadManifest,
			},
			false,
		);

		expect(result).toEqual({
			segment: {
				seq: 1,
				file: "activity-0001.jsonl.gz",
				bytes: claim.cut_bytes,
				gz_bytes: claim.gz_bytes,
				records: 2,
				created_at: claim.created_at,
			},
			liveAfterBytes: Buffer.byteLength(tail),
			syncedThroughBytes: 3,
			recovered: true,
		});
		expect(loadManifest().segments).toEqual([
			{
				seq: 1,
				file: "activity-0001.jsonl.gz",
				bytes: claim.cut_bytes,
				gz_bytes: claim.gz_bytes,
				records: 2,
				created_at: claim.created_at,
			},
		]);
		expect(existsSync(rotationClaimPath(archiveDir, "activity"))).toBe(false);
		expect(JSON.parse(readFileSync(syncStatePath, "utf8")).synced_through_bytes).toBe(3);
	});

	it("replaces a fully-recovered manifest entry when finalizing a claimed replacement again", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		writeFileSync(activityPath, tail);
		const segmentPath = join(archiveDir, "activity-0001.jsonl.gz");
		writeFileSync(segmentPath, gzipSync(prefix));
		const claim = {
			version: 1 as const,
			log: "activity" as const,
			seq: 1,
			file: "activity-0001.jsonl.gz",
			cut_bytes: Buffer.byteLength(prefix),
			records: 2,
			gz_bytes: readFileSync(segmentPath).length,
			gzip_sha256: sha256File(segmentPath),
			created_at: "2026-08-31T00:00:00.000Z",
			source: { dev: "0", ino: "0" },
			replacement: fileIdentity(activityPath),
			synced_through_bytes: 4,
		};
		createRotationClaim(archiveDir, claim);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				segments: [
					{
						seq: 1,
						file: "activity-0001.jsonl.gz",
						bytes: claim.cut_bytes,
						gz_bytes: claim.gz_bytes,
						records: 2,
						created_at: claim.created_at,
						recovered: true,
					},
				],
			}),
		);

		const result = resumePendingActivityRotation(
			{
				activityPath,
				archiveDir,
				syncStatePath,
				manifestPath,
				syncState: { synced_through_bytes: 0 },
				loadManifest,
			},
			false,
		);

		expect(result?.recovered).toBe(true);
		expect(loadManifest().segments).toEqual([
			{
				seq: 1,
				file: "activity-0001.jsonl.gz",
				bytes: claim.cut_bytes,
				gz_bytes: claim.gz_bytes,
				records: 2,
				created_at: claim.created_at,
			},
		]);
		expect(existsSync(rotationClaimPath(archiveDir, "activity"))).toBe(false);
	});

	it("refuses a claim whose source and replacement both mismatch the live file", () => {
		const activityContent = "unrelated\n";
		writeFileSync(activityPath, activityContent);
		createRotationClaim(archiveDir, {
			version: 1,
			log: "activity",
			seq: 1,
			file: "activity-0001.jsonl.gz",
			cut_bytes: 5,
			records: 1,
			gz_bytes: 5,
			gzip_sha256: "0".repeat(64),
			created_at: "2026-08-31T00:00:00.000Z",
			source: { dev: "0", ino: "0" },
			replacement: { dev: "1", ino: "1" },
			synced_through_bytes: 0,
		});

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState: { synced_through_bytes: 0 },
					loadManifest,
				},
				false,
			),
		).toThrow(/claimed activity rotation no longer matches the live file identity/);
		expect(readFileSync(activityPath, "utf8")).toBe(activityContent);
	});

	it("surfaces a disappeared durable claim at finalization instead of losing the published segment silently", () => {
		const original = "first\nsecond\ntail\n";
		writeFileSync(activityPath, original);
		const syncState: JsonObject = { synced_through_bytes: Buffer.byteLength(original) };
		writeFileSync(syncStatePath, JSON.stringify(syncState));

		expect(() =>
			rotateActivityPrefix(
				{
					activityPath,
					syncStatePath,
					archiveDir,
					manifestPath,
					cutByte: Buffer.byteLength("first\nsecond\n"),
					records: 2,
					syncedBytes: Buffer.byteLength(original),
					source: fileIdentity(activityPath),
					syncState,
					loadManifest,
					nextSequence: () => 1,
				},
				() => null,
			),
		).toThrow(/activity rotation claim disappeared before finalization/);
	});
});

describe("activity rotation — finalize-time identity race", () => {
	let root: string;
	let dataDir: string;
	let archiveDir: string;
	let activityPath: string;
	let syncStatePath: string;
	let manifestPath: string;

	function loadManifest(): ArchiveManifest {
		if (!existsSync(manifestPath)) return { version: 1, segments: [] };
		return parseWire(JSON.parse(readFileSync(manifestPath, "utf8")), isCapturedArchiveManifest, "test JSON value");
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "interlinked-activity-race-"));
		dataDir = join(root, ".interlinked");
		archiveDir = join(dataDir, "archive");
		activityPath = join(dataDir, "activity.jsonl");
		syncStatePath = join(dataDir, "sync-state.json");
		manifestPath = join(archiveDir, "manifest.json");
		mkdirSync(archiveDir, { recursive: true });
		statSyncSpy.mockImplementation(actualStatSyncRef.statSync);
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("refuses to finalize when the live file changes identity after the outer check but before the lock", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		writeFileSync(activityPath, tail);
		const segmentPath = join(archiveDir, "activity-0001.jsonl.gz");
		writeFileSync(segmentPath, gzipSync(prefix));
		const claim = {
			version: 1 as const,
			log: "activity" as const,
			seq: 1,
			file: "activity-0001.jsonl.gz",
			cut_bytes: Buffer.byteLength(prefix),
			records: 2,
			gz_bytes: readFileSync(segmentPath).length,
			gzip_sha256: sha256File(segmentPath),
			created_at: "2026-08-31T00:00:00.000Z",
			source: { dev: "0", ino: "0" },
			replacement: fileIdentity(activityPath),
			synced_through_bytes: 3,
		};
		createRotationClaim(archiveDir, claim);

		// The outer `recoverClaimedActivityRotation` check sees the real
		// identity (matches claim.replacement, routing into the
		// already-renamed path). The SECOND bigint-identity read of the same
		// path — inside the mutation lock, right before finalizing — is
		// answered with a different identity, modeling another process
		// replacing the file in the gap between the two checks.
		let bigintReadsOfActivity = 0;
		statSyncSpy.mockImplementation((...args: Parameters<typeof actualStatSyncRef.statSync>) => {
			const [path, options] = args;
			const isBigintIdentityRead =
				path === activityPath &&
				typeof options === "object" &&
				options !== null &&
				(parseWire(options, wireObject({ "bigint": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value")).bigint === true;
			if (isBigintIdentityRead) {
				bigintReadsOfActivity += 1;
				if (bigintReadsOfActivity === 2) {
					return { dev: 999_999n, ino: 999_999n };
				}
			}
			return actualStatSyncRef.statSync(...args);
		});

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState: { synced_through_bytes: 0 },
					loadManifest,
				},
				false,
			),
		).toThrow("activity log changed while finalizing a claimed rotation");
		expect(bigintReadsOfActivity).toBeGreaterThanOrEqual(2);
		// The claim is preserved for a future retry, not silently discarded.
		expect(existsSync(rotationClaimPath(archiveDir, "activity"))).toBe(true);
	});
});
