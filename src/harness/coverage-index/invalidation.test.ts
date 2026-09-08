import { nonNull } from "../../lib/non-null.js";
// Tests for coverage-index invalidation — pins the section 11 validity rules:
// whole-index invalidation on any coverage-affecting input change, per-shard
// staleness from content hashes (timestamps are never validity proofs), and
// the scoped edited-path → shard selection.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	hashEnvironment,
	hashFileSha256,
	hashPathSet,
	type IndexValidityInputs,
	manifestValidity,
	shardsTouchedByPaths,
	staleShards,
} from "./invalidation.js";
import type { CoverageIndexManifest, ShardManifestEntry } from "./types.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cov-index-inval-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
	const abs = join(root, relPath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

function inputs(overrides: Partial<IndexValidityInputs> = {}): IndexValidityInputs {
	return {
		runnerId: "vitest",
		runnerVersion: "4.1.8",
		coverageEngine: "v8",
		coverageConfigHash: "cfg",
		testDiscoveryHash: "disc",
		dependencyGraphVersion: "g1",
		environmentHash: "env",
		shardBoundary: "file",
		...overrides,
	};
}

function manifestWith(
	shards: Record<string, ShardManifestEntry>,
	overrides: Partial<CoverageIndexManifest> = {},
): CoverageIndexManifest {
	return {
		version: 1,
		generation: 1,
		authoritativeAt: "2026-06-11T00:00:00.000Z",
		...inputs(),
		shards,
		...overrides,
	};
}

function shardEntry(
	shardId: string,
	testContentHashes: Record<string, string>,
	dependencyHashes: Record<string, string>,
): ShardManifestEntry {
	return {
		shardId,
		testPaths: Object.keys(testContentHashes),
		testContentHashes,
		dependencyHashes,
		lastDurationMs: 100,
		contributionPath: "shards/x.json.gz",
		contributionChecksum: "0".repeat(64),
		passed: true,
		instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
	};
}

describe("manifestValidity — whole-index invalidation (section 11)", () => {
	it("identical inputs are valid with no reasons", () => {
		const verdict = manifestValidity(manifestWith({}), inputs());
		expect(verdict.valid).toBe(true);
		expect(verdict.reasons).toEqual([]);
	});

	it.each([
		["runnerVersion", { runnerVersion: "5.0.0" }],
		["coverageEngine", { coverageEngine: "istanbul" }],
		["coverageConfigHash", { coverageConfigHash: "cfg2" }],
		["testDiscoveryHash", { testDiscoveryHash: "disc2" }],
		["dependencyGraphVersion", { dependencyGraphVersion: "g2" }],
		["environmentHash", { environmentHash: "env2" }],
		["shardBoundary", { shardBoundary: "run" as const }],
		["runnerId", { runnerId: "coverage-py" }],
	])("a changed %s invalidates the whole index and names itself", (field, override) => {
		const verdict = manifestValidity(manifestWith({}), inputs(override));
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons.join(" ")).toContain(field);
	});

	it("collects every changed field, not just the first", () => {
		const verdict = manifestValidity(
			manifestWith({}),
			inputs({ runnerVersion: "5.0.0", environmentHash: "env2" }),
		);
		expect(verdict.reasons).toHaveLength(2);
	});
});

describe("hashFileSha256 / hashPathSet — content hashes, never timestamps", () => {
	it("hashes file content and returns null for a missing file", () => {
		write("a.txt", "hello");
		const h = hashFileSha256(join(root, "a.txt"));
		expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(hashFileSha256(join(root, "missing.txt"))).toBeNull();
	});

	it("hashPathSet is order-insensitive and content-sensitive", () => {
		write("cfg/a.json", "A");
		write("cfg/b.json", "B");
		const one = hashPathSet(root, ["cfg/a.json", "cfg/b.json"]);
		const two = hashPathSet(root, ["cfg/b.json", "cfg/a.json"]);
		expect(one).toBe(two);
		write("cfg/b.json", "B-changed");
		expect(hashPathSet(root, ["cfg/a.json", "cfg/b.json"])).not.toBe(one);
	});

	it("a config file appearing or disappearing changes the set hash", () => {
		write("cfg/a.json", "A");
		const withMissing = hashPathSet(root, ["cfg/a.json", "cfg/optional.json"]);
		write("cfg/optional.json", "now exists");
		const withPresent = hashPathSet(root, ["cfg/a.json", "cfg/optional.json"]);
		expect(withPresent).not.toBe(withMissing);
		// Missing stays deterministic run-to-run.
		rmSync(join(root, "cfg/optional.json"));
		expect(hashPathSet(root, ["cfg/a.json", "cfg/optional.json"])).toBe(withMissing);
	});
});

describe("hashEnvironment — declared coverage-relevant vars only", () => {
	it("is order-insensitive over the declared names", () => {
		const env = { NODE_ENV: "test", TZ: "UTC" };
		expect(hashEnvironment(["NODE_ENV", "TZ"], env)).toBe(hashEnvironment(["TZ", "NODE_ENV"], env));
	});

	it("distinguishes a changed value, an unset var, and an empty string", () => {
		const base = hashEnvironment(["TZ"], { TZ: "UTC" });
		expect(hashEnvironment(["TZ"], { TZ: "America/New_York" })).not.toBe(base);
		expect(hashEnvironment(["TZ"], {})).not.toBe(base);
		expect(hashEnvironment(["TZ"], { TZ: "" })).not.toBe(hashEnvironment(["TZ"], {}));
	});

	it("ignores undeclared vars entirely", () => {
		expect(hashEnvironment(["TZ"], { TZ: "UTC", OTHER: "x" })).toBe(
			hashEnvironment(["TZ"], { TZ: "UTC", OTHER: "y" }),
		);
	});
});

describe("staleShards — per-shard validity from content hashes (section 7 cond. 3)", () => {
	it("returns no stale shards when every hash still matches", () => {
		write("tests/a.test.ts", "test-a");
		write("src/m.ts", "module-m");
		const manifest = manifestWith({
			"tests/a.test.ts": shardEntry(
				"tests/a.test.ts",
				{ "tests/a.test.ts": nonNull(hashFileSha256(join(root, "tests/a.test.ts"))) },
				{ "src/m.ts": nonNull(hashFileSha256(join(root, "src/m.ts"))) },
			),
		});
		expect(staleShards(manifest, root)).toEqual([]);
	});

	it("flags a shard whose test content changed, naming the path", () => {
		write("tests/a.test.ts", "test-a");
		const fresh = nonNull(hashFileSha256(join(root, "tests/a.test.ts")));
		write("tests/a.test.ts", "test-a CHANGED");
		const manifest = manifestWith({
			"tests/a.test.ts": shardEntry("tests/a.test.ts", { "tests/a.test.ts": fresh }, {}),
		});
		const stale = staleShards(manifest, root);
		expect(stale).toHaveLength(1);
		expect(stale[0]?.shardId).toBe("tests/a.test.ts");
		expect(stale[0]?.reason).toContain("tests/a.test.ts");
	});

	it("flags a shard whose dependency was deleted, and leaves untouched shards alone", () => {
		write("tests/a.test.ts", "test-a");
		write("tests/b.test.ts", "test-b");
		write("src/dep.ts", "dep");
		const depHash = nonNull(hashFileSha256(join(root, "src/dep.ts")));
		const aHash = nonNull(hashFileSha256(join(root, "tests/a.test.ts")));
		const bHash = nonNull(hashFileSha256(join(root, "tests/b.test.ts")));
		rmSync(join(root, "src/dep.ts"));
		const manifest = manifestWith({
			"tests/a.test.ts": shardEntry(
				"tests/a.test.ts",
				{ "tests/a.test.ts": aHash },
				{ "src/dep.ts": depHash },
			),
			"tests/b.test.ts": shardEntry("tests/b.test.ts", { "tests/b.test.ts": bHash }, {}),
		});
		const stale = staleShards(manifest, root);
		expect(stale.map((s) => s.shardId)).toEqual(["tests/a.test.ts"]);
		expect(stale[0]?.reason).toMatch(/src\/dep\.ts.*missing|missing.*src\/dep\.ts/);
	});
});

describe("shardsTouchedByPaths — scoped invalidation for an edit (section 11)", () => {
	const manifest = manifestWith({
		"tests/a.test.ts": shardEntry(
			"tests/a.test.ts",
			{ "tests/a.test.ts": "h1" },
			{ "src/m.ts": "h2", "src/util.ts": "h3" },
		),
		"tests/b.test.ts": shardEntry("tests/b.test.ts", { "tests/b.test.ts": "h4" }, { "src/util.ts": "h5" }),
		"tests/c.test.ts": shardEntry("tests/c.test.ts", { "tests/c.test.ts": "h6" }, {}),
	});

	it("an edited source selects every shard that depends on it", () => {
		expect(shardsTouchedByPaths(manifest, ["src/util.ts"])).toEqual(
			new Set(["tests/a.test.ts", "tests/b.test.ts"]),
		);
	});

	it("an edited test selects exactly its own shard", () => {
		expect(shardsTouchedByPaths(manifest, ["tests/c.test.ts"])).toEqual(
			new Set(["tests/c.test.ts"]),
		);
	});

	it("an unknown path selects nothing (the caller routes it to full fallback)", () => {
		expect(shardsTouchedByPaths(manifest, ["src/brand-new.ts"])).toEqual(new Set());
	});
});
