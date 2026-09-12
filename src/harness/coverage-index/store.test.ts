import { nonNull } from "../../lib/non-null.js";
// Tests for the coverage-index persistent store — pins the section 8.2 layout
// (per-runner subtree, contribution blobs + checksums, manifest generations)
// and the section 12 atomicity requirements (CAS promotion, torn data reads as
// absent, accepted state never corrupted).
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { staleShards } from "./invalidation.js";
import {
	contributionFromJson,
	contributionToJson,
	promoteManifest,
	readAcceptedManifest,
	readContributionBlob,
	storeDirFor,
	writeContributionBlob,
} from "./store.js";
import type {
	CanonicalCoverageElementSet,
	CoverageIndexManifest,
	ShardCoverageContribution,
} from "./types.js";

let root: string;
let storeDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cov-index-store-"));
	storeDir = storeDirFor(root, "vitest");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function sampleSet(): CanonicalCoverageElementSet {
	return {
		lines: new Map([
			[1, 2],
			[2, 0],
		]),
		branches: new Map([["1:0:0", 1]]),
		functions: new Map([["f@1", 3]]),
		statements: new Map([["0:0", 1]]),
	};
}

function sampleContribution(shardId = "tests/a.test.ts"): ShardCoverageContribution {
	return {
		shardId,
		files: new Map([
			["src/m.ts", sampleSet()],
			["src/other.ts", { lines: new Map([[7, 1]]), branches: new Map(), functions: new Map() }],
		]),
	};
}

function sampleManifest(generation: number): CoverageIndexManifest {
	return {
		version: 1,
		generation,
		authoritativeAt: "2026-06-11T00:00:00.000Z",
		runnerId: "vitest",
		runnerVersion: "4.1.8",
		coverageEngine: "v8",
		coverageConfigHash: "cfg-hash",
		testDiscoveryHash: "disc-hash",
		dependencyGraphVersion: "g1",
		environmentHash: "env-hash",
		shardBoundary: "file",
		shards: {},
	};
}

describe("storeDirFor", () => {
	it("returns no evidence when an accepted shard blob has disappeared", () => {
		const entry = nonNull(writeContributionBlob(storeDir, sampleContribution()));
		rmSync(join(storeDir, entry.contributionPath));
		expect(readContributionBlob(storeDir, entry)).toBeNull();
	});

	it("refuses promotion when the store path cannot become a directory", () => {
		const blocked = join(root, "blocked-store");
		writeFileSync(blocked, "preserve this file");
		expect(promoteManifest(blocked, sampleManifest(1), null)).toBe(false);
		expect(readFileSync(blocked, "utf8")).toBe("preserve this file");
	});

	it("nests one subtree per runner under .interlinked/coverage-index", () => {
		expect(storeDirFor("/repo", "vitest")).toBe("/repo/.interlinked/coverage-index/vitest");
		expect(storeDirFor("/repo", "coverage-py")).toBe(
			"/repo/.interlinked/coverage-index/coverage-py",
		);
	});
});

describe("contribution JSON round-trip", () => {
	it("serializes and revives Maps losslessly, including optional statements", () => {
		const original = sampleContribution();
		const revived = contributionFromJson(contributionToJson(original));
		expect(revived).not.toBeNull();
		expect(revived?.shardId).toBe(original.shardId);
		expect(revived?.files.get("src/m.ts")?.lines).toEqual(original.files.get("src/m.ts")?.lines);
		expect(revived?.files.get("src/m.ts")?.statements).toEqual(
			original.files.get("src/m.ts")?.statements,
		);
		// A file without statements stays without them (exact optional semantics).
		expect(revived?.files.get("src/other.ts")?.statements).toBeUndefined();
	});

	it("rejects malformed payloads instead of throwing", () => {
		expect(contributionFromJson(null)).toBeNull();
		expect(contributionFromJson({ version: 99 })).toBeNull();
		expect(contributionFromJson({ version: 1, shardId: 5, files: [] })).toBeNull();
		expect(contributionFromJson({ version: 1, shardId: "s", files: "nope" })).toBeNull();
	});
});

describe("contribution blobs", () => {
	it("writes a compressed blob and reads it back through its checksum", () => {
		const contribution = sampleContribution();
		const entry = writeContributionBlob(storeDir, contribution);
		expect(entry).not.toBeNull();
		expect(entry?.contributionPath.startsWith("shards/")).toBe(true);
		const revived = readContributionBlob(storeDir, nonNull(entry));
		expect(revived?.shardId).toBe(contribution.shardId);
		expect(revived?.files.get("src/m.ts")?.lines.get(1)).toBe(2);
	});

	it("distinct shard ids get distinct blob paths", () => {
		const a = writeContributionBlob(storeDir, sampleContribution("tests/a.test.ts"));
		const b = writeContributionBlob(storeDir, sampleContribution("tests/b.test.ts"));
		expect(a?.contributionPath).not.toBe(b?.contributionPath);
	});

	it("a corrupted blob reads as null (checksum mismatch), never throws", () => {
		const entry = writeContributionBlob(storeDir, sampleContribution());
		if (!entry) throw new Error("write failed");
		writeFileSync(join(storeDir, entry.contributionPath), "garbage-not-gzip", "utf-8");
		expect(readContributionBlob(storeDir, entry)).toBeNull();
	});

	it("a checksum-tampered entry reads as null even when the blob is intact", () => {
		const entry = writeContributionBlob(storeDir, sampleContribution());
		if (!entry) throw new Error("write failed");
		expect(
			readContributionBlob(storeDir, { ...entry, contributionChecksum: "0".repeat(64) }),
		).toBeNull();
	});

	it("a missing blob reads as null", () => {
		expect(
			readContributionBlob(storeDir, {
				contributionPath: "shards/missing.json.gz",
				contributionChecksum: "0".repeat(64),
			}),
		).toBeNull();
	});

	it("leaves no temp files behind after writing", () => {
		writeContributionBlob(storeDir, sampleContribution());
		const leftovers = readdirSync(join(storeDir, "shards")).filter((f) => f.includes(".tmp"));
		expect(leftovers).toEqual([]);
	});
});

describe("manifest read + CAS promotion (section 12)", () => {
	it("reads null when no manifest exists yet", () => {
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	it("first promotion expects generation null and lands generation 1", () => {
		const ok = promoteManifest(storeDir, sampleManifest(1), null);
		expect(ok).toBe(true);
		expect(readAcceptedManifest(storeDir)?.generation).toBe(1);
	});

	it("a stale expected generation is rejected and the accepted manifest is untouched", () => {
		promoteManifest(storeDir, sampleManifest(1), null);
		promoteManifest(storeDir, sampleManifest(2), 1);
		// A racer still holding generation 1 as its parent must lose.
		const stale = promoteManifest(storeDir, { ...sampleManifest(2), runnerVersion: "9.9.9" }, 1);
		expect(stale).toBe(false);
		expect(readAcceptedManifest(storeDir)?.generation).toBe(2);
		expect(readAcceptedManifest(storeDir)?.runnerVersion).toBe("4.1.8");
	});

	it("a promotion whose generation is not expected+1 is rejected", () => {
		promoteManifest(storeDir, sampleManifest(1), null);
		expect(promoteManifest(storeDir, sampleManifest(5), 1)).toBe(false);
	});

	it("a malformed manifest on disk reads as null (fail-open) and can be re-initialized", () => {
		promoteManifest(storeDir, sampleManifest(1), null);
		writeFileSync(join(storeDir, "manifest.json"), "{ torn", "utf-8");
		expect(readAcceptedManifest(storeDir)).toBeNull();
		// Re-initialization treats the torn store as empty.
		expect(promoteManifest(storeDir, sampleManifest(1), null)).toBe(true);
		expect(readAcceptedManifest(storeDir)?.generation).toBe(1);
	});

	it("manifest writes are atomic — no temp files left behind", () => {
		promoteManifest(storeDir, sampleManifest(1), null);
		const leftovers = readdirSync(storeDir).filter((f) => f.includes(".tmp"));
		expect(leftovers).toEqual([]);
	});

	it("manifest round-trips its shard entries", () => {
		const manifest = sampleManifest(1);
		manifest.shards["tests/a.test.ts"] = {
			shardId: "tests/a.test.ts",
			testPaths: ["tests/a.test.ts"],
			testContentHashes: { "tests/a.test.ts": "abc" },
			dependencyHashes: { "src/m.ts": "def" },
			lastDurationMs: 412,
			contributionPath: "shards/xyz.json.gz",
			contributionChecksum: "0".repeat(64),
			passed: true,
			instability: { events: [], consecutiveStableRuns: 3, quarantined: false },
		};
		promoteManifest(storeDir, manifest, null);
		const read = readAcceptedManifest(storeDir);
		expect(read?.shards["tests/a.test.ts"]?.lastDurationMs).toBe(412);
		expect(read?.shards["tests/a.test.ts"]?.instability.quarantined).toBe(false);
	});

	// Round 7 (finding 2026-06): a top-level-only object check let a manifest
	// with a corrupt shard entry through, and the first consumer to iterate it
	// threw instead of degrading to the full-run fallback. Each entry is now
	// validated at the read boundary.
	const okEntry = {
		shardId: "s",
		testPaths: [],
		testContentHashes: {},
		dependencyHashes: {},
		lastDurationMs: 0,
		contributionPath: "p",
		contributionChecksum: "c",
		passed: null,
		instability: {},
	};
	const MALFORMED_MANIFESTS: Array<[string, Record<string, unknown>]> = [
		["a null shard entry ({shards:{bad:null}})", { bad: null }],
		["a non-object shard entry", { bad: 42 }],
		["an entry missing testContentHashes", { s: { ...okEntry, testContentHashes: undefined } }],
		["an entry whose testPaths is not a string array", { s: { ...okEntry, testPaths: [7] } }],
		["an entry whose hash map has a non-string value", { s: { ...okEntry, testContentHashes: { a: 1 } } }],
	];

	it.each(MALFORMED_MANIFESTS)(
		"rejects %s → null (full-run fallback, never an exception)",
		(_label, shards) => {
			promoteManifest(storeDir, sampleManifest(1), null); // creates the store dir
			const manifest = { ...sampleManifest(1), shards };
			writeFileSync(join(storeDir, "manifest.json"), JSON.stringify(manifest), "utf-8");
			expect(readAcceptedManifest(storeDir)).toBeNull();
		},
	);

	it("still accepts a well-formed entry (the guard does not over-reject)", () => {
		promoteManifest(storeDir, sampleManifest(1), null);
		const manifest = { ...sampleManifest(1), shards: { s: { ...okEntry, testPaths: ["t"] } } };
		writeFileSync(join(storeDir, "manifest.json"), JSON.stringify(manifest), "utf-8");
		expect(readAcceptedManifest(storeDir)?.shards.s?.shardId).toBe("s");
	});

	it("a corrupt shard entry degrades staleShards to no-op instead of throwing (the reported crash)", () => {
		promoteManifest(storeDir, sampleManifest(1), null);
		writeFileSync(
			join(storeDir, "manifest.json"),
			JSON.stringify({ ...sampleManifest(1), shards: { bad: null } }),
			"utf-8",
		);
		const manifest = readAcceptedManifest(storeDir);
		expect(manifest).toBeNull();
		// The consumer is only ever handed a validated manifest; with null it is
		// not called — no Object.entries(null) TypeError reaches the gate.
		expect(() => (manifest ? staleShards(manifest, storeDir) : [])).not.toThrow();
	});
});

describe("blob + manifest integration", () => {
	it("a full write→manifest→read cycle revives the exact contribution", () => {
		const contribution = sampleContribution();
		const entry = writeContributionBlob(storeDir, contribution);
		if (!entry) throw new Error("write failed");
		const manifest = sampleManifest(1);
		manifest.shards[contribution.shardId] = {
			shardId: contribution.shardId,
			testPaths: [contribution.shardId],
			testContentHashes: {},
			dependencyHashes: {},
			lastDurationMs: 100,
			...entry,
			passed: true,
			instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
		};
		promoteManifest(storeDir, manifest, null);

		const read = readAcceptedManifest(storeDir);
		const shardEntry = read?.shards[contribution.shardId];
		expect(shardEntry).toBeDefined();
		const revived = readContributionBlob(storeDir, nonNull(shardEntry));
		expect(revived?.files.get("src/m.ts")?.branches.get("1:0:0")).toBe(1);
	});

	it("store files stay inside the per-runner subtree", () => {
		writeContributionBlob(storeDir, sampleContribution());
		promoteManifest(storeDir, sampleManifest(1), null);
		expect(existsSync(join(root, ".interlinked/coverage-index/vitest/manifest.json"))).toBe(true);
		expect(readFileSync(join(storeDir, "manifest.json"), "utf-8")).toContain('"runnerId": "vitest"');
	});
});

describe("contributionFromJson — element-set field validation", () => {
	// Reach numberKeyMap / stringKeyMap / elementSetFromJson via the only
	// public entry point that calls them: contributionFromJson's per-file
	// element-set revival.
	function withFiles(files: unknown): unknown {
		return { version: 1, shardId: "s", files };
	}

	it("rejects a non-array `lines` field", () => {
		expect(
			contributionFromJson(withFiles([["f.ts", { lines: "nope", branches: [], functions: [] }]])),
		).toBeNull();
	});

	it("rejects a `lines` pair that is not an array", () => {
		expect(
			contributionFromJson(
				withFiles([["f.ts", { lines: [[1, 2], "bad"], branches: [], functions: [] }]]),
			),
		).toBeNull();
	});

	it("rejects a `lines` pair whose key is not a number", () => {
		expect(
			contributionFromJson(
				withFiles([["f.ts", { lines: [["x", 2]], branches: [], functions: [] }]]),
			),
		).toBeNull();
	});

	it("rejects a `lines` pair whose hit-count is not a number", () => {
		expect(
			contributionFromJson(
				withFiles([["f.ts", { lines: [[1, "y"]], branches: [], functions: [] }]]),
			),
		).toBeNull();
	});

	it("rejects a non-array `branches` field", () => {
		expect(
			contributionFromJson(withFiles([["f.ts", { lines: [], branches: "nope", functions: [] }]])),
		).toBeNull();
	});

	it("rejects a `branches` pair that is not an array", () => {
		expect(
			contributionFromJson(
				withFiles([["f.ts", { lines: [], branches: [["b", 1], "bad"], functions: [] }]]),
			),
		).toBeNull();
	});

	it("rejects a `branches` pair whose key is not a string", () => {
		expect(
			contributionFromJson(
				withFiles([["f.ts", { lines: [], branches: [[5, 1]], functions: [] }]]),
			),
		).toBeNull();
	});

	it("rejects a `branches` pair whose hit-count is not a number", () => {
		expect(
			contributionFromJson(
				withFiles([["f.ts", { lines: [], branches: [["b", "y"]], functions: [] }]]),
			),
		).toBeNull();
	});

	it("accepts a well-formed element set with all dimensions present", () => {
		const revived = contributionFromJson(
			withFiles([
				["f.ts", { lines: [[1, 2]], branches: [["b", 1]], functions: [["fn", 3]] }],
			]),
		);
		expect(revived?.files.get("f.ts")?.lines.get(1)).toBe(2);
	});

	it("rejects a raw element-set value that is not an object (null pair[1])", () => {
		expect(contributionFromJson(withFiles([["f.ts", null]]))).toBeNull();
	});

	it("rejects an element-set whose `statements` field is malformed", () => {
		expect(
			contributionFromJson(
				withFiles([
					[
						"f.ts",
						{ lines: [], branches: [], functions: [], statements: [["x", "not-a-number"]] },
					],
				]),
			),
		).toBeNull();
	});

	it("accepts an element-set whose `statements` field is well-formed", () => {
		const revived = contributionFromJson(
			withFiles([
				["f.ts", { lines: [], branches: [], functions: [], statements: [["0:0", 4]] }],
			]),
		);
		expect(revived?.files.get("f.ts")?.statements?.get("0:0")).toBe(4);
	});

	it("rejects a top-level `files` pair that is not an array", () => {
		expect(contributionFromJson(withFiles(["not-a-pair"]))).toBeNull();
	});

	it("rejects a top-level `files` pair whose key is not a string", () => {
		expect(
			contributionFromJson(withFiles([[42, { lines: [], branches: [], functions: [] }]])),
		).toBeNull();
	});
});

describe("readAcceptedManifest — parser-construction branches (boundary-parser conversion)", () => {
	function writeManifestRaw(value: unknown): void {
		mkdirSync(storeDir, { recursive: true });
		writeFileSync(join(storeDir, "manifest.json"), JSON.stringify(value), "utf-8");
	}

	it("rejects a shardBoundary outside the declared literal union", () => {
		writeManifestRaw({ ...sampleManifest(1), shardBoundary: "process" });
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	it("round-trips the optional sourceRevision when present", () => {
		writeManifestRaw({ ...sampleManifest(1), sourceRevision: "abc123" });
		expect(readAcceptedManifest(storeDir)?.sourceRevision).toBe("abc123");
	});

	it("rejects a non-string sourceRevision", () => {
		writeManifestRaw({ ...sampleManifest(1), sourceRevision: 42 });
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	it("omits sourceRevision entirely when absent (never a stray undefined key)", () => {
		writeManifestRaw(sampleManifest(1));
		const read = readAcceptedManifest(storeDir);
		expect(read && "sourceRevision" in read).toBe(false);
	});

	it("a shard's instability event array with a malformed event rejects the whole manifest", () => {
		const manifest = {
			...sampleManifest(1),
			shards: {
				s: {
					shardId: "s",
					testPaths: ["t"],
					testContentHashes: {},
					dependencyHashes: {},
					lastDurationMs: 0,
					contributionPath: "p",
					contributionChecksum: "c",
					passed: null,
					instability: { events: [{ at: "2026-01-01", kind: "not-a-real-kind" }] },
				},
			},
		};
		writeManifestRaw(manifest);
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	it("revives a well-formed instability event array", () => {
		const manifest = {
			...sampleManifest(1),
			shards: {
				s: {
					shardId: "s",
					testPaths: ["t"],
					testContentHashes: {},
					dependencyHashes: {},
					lastDurationMs: 0,
					contributionPath: "p",
					contributionChecksum: "c",
					passed: null,
					instability: {
						events: [{ at: "2026-01-01T00:00:00.000Z", kind: "pass_fail_flip" }],
						consecutiveStableRuns: 0,
						quarantined: false,
					},
				},
			},
		};
		writeManifestRaw(manifest);
		const read = readAcceptedManifest(storeDir);
		expect(read?.shards.s?.instability.events).toEqual([
			{ at: "2026-01-01T00:00:00.000Z", kind: "pass_fail_flip" },
		]);
	});

	it("a shard's instability field that is not an array of events (a string) rejects the manifest", () => {
		const manifest = {
			...sampleManifest(1),
			shards: {
				s: {
					shardId: "s",
					testPaths: ["t"],
					testContentHashes: {},
					dependencyHashes: {},
					lastDurationMs: 0,
					contributionPath: "p",
					contributionChecksum: "c",
					passed: null,
					instability: "not-an-object",
				},
			},
		};
		writeManifestRaw(manifest);
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});
});

describe("readAcceptedManifest — top-level field validation", () => {
	function writeManifestRaw(value: unknown): void {
		mkdirSync(storeDir, { recursive: true });
		writeFileSync(join(storeDir, "manifest.json"), JSON.stringify(value), "utf-8");
	}

	it("rejects a top-level array (not a plain object)", () => {
		writeManifestRaw([1, 2, 3]);
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	it("rejects a top-level null", () => {
		writeManifestRaw(null);
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	it("rejects a version other than 1", () => {
		writeManifestRaw({ ...sampleManifest(1), version: 2 });
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	it("rejects a non-integer generation", () => {
		writeManifestRaw({ ...sampleManifest(1), generation: "one" });
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	it("rejects a non-string runnerId", () => {
		writeManifestRaw({ ...sampleManifest(1), runnerId: 42 });
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	it("rejects a `shards` field that is not a plain object", () => {
		writeManifestRaw({ ...sampleManifest(1), shards: [] });
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	it("accepts a well-formed manifest with all top-level fields valid", () => {
		writeManifestRaw(sampleManifest(1));
		expect(readAcceptedManifest(storeDir)?.generation).toBe(1);
	});
});

describe("atomic-write failure paths (rename collision forces the catch branch)", () => {
	it("writeContributionBlob returns null when the blob's rename target is an existing directory", () => {
		const contribution = sampleContribution();
		// Pre-create the exact blob path AS A DIRECTORY so atomicWrite's
		// renameSync(tmp, absPath) fails with EISDIR after writeFileSync(tmp)
		// already succeeded — forces atomicWrite's own catch (rmSync + rethrow)
		// and writeContributionBlob's outer catch.
		const initial = nonNull(writeContributionBlob(storeDir, contribution));
		const relPath = initial.contributionPath;
		rmSync(join(storeDir, relPath));
		mkdirSync(join(storeDir, relPath), { recursive: true });
		expect(writeContributionBlob(storeDir, contribution)).toBeNull();
	});

	it("promoteManifest returns false when the manifest rename target is an existing directory", () => {
		// Pre-create manifest.json AS A DIRECTORY so the CAS write's rename
		// fails after the temp file was already written.
		mkdirSync(join(storeDir, "manifest.json"), { recursive: true });
		expect(promoteManifest(storeDir, sampleManifest(1), null)).toBe(false);
	});
});

describe("readContributionBlob — decompression failure", () => {
	it("reads as null when the checksum matches but the bytes are not valid gzip", () => {
		const contribution = sampleContribution();
		const entry = writeContributionBlob(storeDir, contribution);
		if (!entry) throw new Error("write failed");
		// Overwrite with bytes whose sha256 matches the recomputed checksum
		// (recompute against the NEW bytes) but that fail to gunzip — forces
		// the JSON.parse(gunzipSync(...)) catch, not the checksum-mismatch path.
		const badBytes = Buffer.from([0x1f, 0x8b, 0x00, 0x00, 0xff, 0xff, 0xff]); // gzip magic, garbage body
		writeFileSync(join(storeDir, entry.contributionPath), badBytes);
		const badChecksum = createHash("sha256").update(badBytes).digest("hex");
		expect(readContributionBlob(storeDir, { ...entry, contributionChecksum: badChecksum })).toBeNull();
	});
});
