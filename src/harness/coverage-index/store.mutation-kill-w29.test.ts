// Mutation-kill pass (wave 29) targeting manifest survivors in store.ts.
// Each case is labeled with its mutantId + mutator so the receipt file can be
// cross-checked against .interlinked/mutation-manifest.json.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	contributionFromJson,
	contributionToJson,
	promoteManifest,
	readAcceptedManifest,
	storeDirFor,
} from "./store.js";
import type { CoverageIndexManifest, ShardCoverageContribution } from "./types.js";

let root: string;
let storeDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cov-index-store-w29-"));
	storeDir = storeDirFor(root, "vitest");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeManifestRaw(value: unknown): void {
	mkdirSync(storeDir, { recursive: true });
	writeFileSync(join(storeDir, "manifest.json"), JSON.stringify(value), "utf-8");
}

function baseManifest(): CoverageIndexManifest;
function baseManifest(overrides: Record<string, unknown>): Record<string, unknown>;
function baseManifest(overrides: Record<string, unknown> = {}): CoverageIndexManifest | Record<string, unknown> {
	const base: CoverageIndexManifest = {
		version: 1,
		generation: 1,
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
	return { ...base, ...overrides };
}

const okShardEntry: Record<string, unknown> = {
	shardId: "s",
	testPaths: ["t"],
	testContentHashes: {},
	dependencyHashes: {},
	lastDurationMs: 0,
	contributionPath: "p",
	contributionChecksum: "c",
	passed: null,
	instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
};

function manifestWithShard(entry: Record<string, unknown>): Record<string, unknown> {
	return baseManifest({ shards: { s: entry } });
}

describe("contributionToJson — functions array", () => {
	// test-contract: public-api — [41ef910980711258] '[...set.functions]' ->
	// '[]' must preserve the actual entries, not silently drop them.
	it("carries the source functions entries into the serialized array", () => {
		const contribution: ShardCoverageContribution = {
			shardId: "s",
			files: new Map([
				["src/a.ts", { lines: new Map(), branches: new Map(), functions: new Map([["f@1", 3]]) }],
			]),
		};
		const json = contributionToJson(contribution);
		expect(json.files[0]?.[1].functions).toEqual([["f@1", 3]]);
	});
});

describe("numberKeyMap / stringKeyMap — non-array guard (throw-vs-null distinction)", () => {
	function withFiles(files: unknown): unknown {
		return { version: 1, shardId: "s", files };
	}

	// test-contract: public-api — [e16cd70ebc9a3f51] '!Array.isArray(raw)' ->
	// 'false' on numberKeyMap. A plain object `lines` value is not iterable;
	// if the early-return guard is disabled the code falls into `for...of` on
	// a non-iterable object and THROWS instead of returning null.
	it("rejects a non-array `lines` field that is a plain object without throwing", () => {
		expect(() =>
			contributionFromJson(withFiles([["f.ts", { lines: {}, branches: [], functions: [] }]])),
		).not.toThrow();
		expect(
			contributionFromJson(withFiles([["f.ts", { lines: {}, branches: [], functions: [] }]])),
		).toBeNull();
	});

	// test-contract: public-api — [d06c25f26c2868dc] '!Array.isArray(raw)' ->
	// 'false' on stringKeyMap, same throw-vs-null distinction via `branches`.
	it("rejects a non-array `branches` field that is a plain object without throwing", () => {
		expect(() =>
			contributionFromJson(withFiles([["f.ts", { lines: [], branches: {}, functions: [] }]])),
		).not.toThrow();
		expect(
			contributionFromJson(withFiles([["f.ts", { lines: [], branches: {}, functions: [] }]])),
		).toBeNull();
	});
});

describe("contributionFromJson — top-level guards independent of shape fallthrough", () => {
	// test-contract: public-api — [90344f4d5343b269] 'raw.version !== 1' ->
	// 'false'. shardId + files are otherwise valid, so only the version check
	// can reject this input; if disabled the mutant would accept it.
	it("rejects a wrong version even when shardId/files are otherwise well-formed", () => {
		expect(contributionFromJson({ version: 99, shardId: "s", files: [] })).toBeNull();
	});

	// test-contract: public-api — [01e46030d43b5ad1] '!Array.isArray(raw.files)'
	// -> 'false'. `files` as a plain object is non-iterable; disabling the
	// guard throws instead of returning null.
	it("rejects a non-array `files` field (a plain object) without throwing", () => {
		expect(() => contributionFromJson({ version: 1, shardId: "s", files: {} })).not.toThrow();
		expect(contributionFromJson({ version: 1, shardId: "s", files: {} })).toBeNull();
	});
});

describe("isStringArray — every vs some", () => {
	// test-contract: public-api — [0b063651e89d867b] '.every' -> '.some'. An
	// array with one string and one non-string element: every() is false
	// (reject), some() is true (wrongly accept).
	it("rejects testPaths mixing a string and a non-string entry", () => {
		writeManifestRaw(manifestWithShard({ ...okShardEntry, testPaths: ["a", 5] }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});
});

describe("isShardBoundary — literal + comparison mutants", () => {
	// test-contract: public-api — [af7d4808f8da5a5a]/[845e5b5e0670377b] disable
	// acceptance of the valid "group" literal.
	it("treats the group-level shard boundary as a valid enum member", () => {
		writeManifestRaw(baseManifest({ shardBoundary: "group" }));
		expect(readAcceptedManifest(storeDir)?.shardBoundary).toBe("group");
	});

	// test-contract: public-api — [4afa4a2d81794071]/[86beac16cfd32014] disable
	// acceptance of the valid "run" literal.
	it("treats the whole-run shard boundary as a valid enum member", () => {
		writeManifestRaw(baseManifest({ shardBoundary: "run" }));
		expect(readAcceptedManifest(storeDir)?.shardBoundary).toBe("run");
	});
});

describe("parseInstabilityEvent", () => {
	// test-contract: public-api — [364c5f23761a2095] '!isPlainObject(v)' ->
	// 'false'. A `null` event: original rejects safely via the object guard
	// before ever touching `v.at`; disabling the guard makes `str(v.at)`
	// dereference a null value and THROW instead of failing closed.
	it("rejects a null event in the instability array without throwing", () => {
		writeManifestRaw(
			manifestWithShard({
				...okShardEntry,
				instability: { events: [null], consecutiveStableRuns: 0, quarantined: false },
			}),
		);
		expect(() => readAcceptedManifest(storeDir)).not.toThrow();
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	// test-contract: public-api — [9e20b13a9984b8f9] 'at === null' -> 'false'.
	// An event missing `at` entirely: original rejects; disabling the guard
	// lets a malformed (at=null) event through.
	it("rejects an event missing its `at` field", () => {
		writeManifestRaw(
			manifestWithShard({
				...okShardEntry,
				instability: {
					events: [{ kind: "contribution_churn" }],
					consecutiveStableRuns: 0,
					quarantined: false,
				},
			}),
		);
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	// test-contract: public-api — [5b6ef54462cb8818]/[e94f38fa4fcd3a82] wrongly
	// reject a valid "contribution_churn" event (companion suite only covers "pass_fail_flip").
	it("accepts a well-formed \"contribution_churn\" event", () => {
		writeManifestRaw(
			manifestWithShard({
				...okShardEntry,
				instability: {
					events: [{ at: "2026-01-01T00:00:00.000Z", kind: "contribution_churn" }],
					consecutiveStableRuns: 0,
					quarantined: false,
				},
			}),
		);
		expect(readAcceptedManifest(storeDir)?.shards.s?.instability.events).toEqual([
			{ at: "2026-01-01T00:00:00.000Z", kind: "contribution_churn" },
		]);
	});
});

describe("parseInstability — consecutiveStableRuns / quarantined field revival", () => {
	// test-contract: public-api — [8bcc26ba7acd9209] '=== "number"' ->
	// 'false' and [b7b2c39219bc8658] '"number"' -> '""'. A genuinely valid
	// number must be PRESERVED, not defaulted to 0.
	it("preserves a valid numeric consecutiveStableRuns", () => {
		writeManifestRaw(
			manifestWithShard({
				...okShardEntry,
				instability: { events: [], consecutiveStableRuns: 7, quarantined: false },
			}),
		);
		expect(readAcceptedManifest(storeDir)?.shards.s?.instability.consecutiveStableRuns).toBe(7);
	});

	// test-contract: public-api — [00e36c3b7afed823] '=== "number"' -> 'true'
	// and [f65e18a6d1f1b806] '===' -> '!=='. An invalid (non-number)
	// consecutiveStableRuns must default to 0, not pass the raw value through.
	it("defaults a non-numeric consecutiveStableRuns to 0", () => {
		writeManifestRaw(
			manifestWithShard({
				...okShardEntry,
				instability: { events: [], consecutiveStableRuns: "bad", quarantined: false },
			}),
		);
		expect(readAcceptedManifest(storeDir)?.shards.s?.instability.consecutiveStableRuns).toBe(0);
	});

	// test-contract: public-api — [955e72c8236f0cfd] 'v.quarantined === true'
	// -> 'false'.
	it("preserves a quarantined: true shard", () => {
		writeManifestRaw(
			manifestWithShard({
				...okShardEntry,
				instability: { events: [], consecutiveStableRuns: 0, quarantined: true },
			}),
		);
		expect(readAcceptedManifest(storeDir)?.shards.s?.instability.quarantined).toBe(true);
	});
});

describe("parseShardEntry — field guards", () => {
	// test-contract: public-api — [7a795f4e6344e4ba] 'shardId === null' ->
	// 'false'.
	it("rejects a shard entry whose shardId is not a string", () => {
		writeManifestRaw(manifestWithShard({ ...okShardEntry, shardId: 42 }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	// test-contract: public-api — [6be9fe58df5eaafa] '!dependencyHashes' ->
	// 'false'.
	it("rejects a shard entry whose dependencyHashes has a non-string value", () => {
		writeManifestRaw(manifestWithShard({ ...okShardEntry, dependencyHashes: { a: 1 } }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	// test-contract: public-api — [ea116681010ab59b] 'typeof … !== "number"'
	// -> 'false'.
	it("rejects a shard entry whose lastDurationMs is not a number", () => {
		writeManifestRaw(manifestWithShard({ ...okShardEntry, lastDurationMs: "100" }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	// test-contract: public-api — [870549ec62db344a] whole OR condition ->
	// 'false', [5be9c5aac0b2fd11] '||' -> '&&', [aa9517a119624f68]
	// 'contributionChecksum === null' -> 'false'. contributionPath valid,
	// contributionChecksum invalid: the OR must still reject (AND would not).
	it("rejects a shard entry with a valid contributionPath but invalid contributionChecksum", () => {
		const { contributionChecksum: _drop, ...rest } = okShardEntry;
		writeManifestRaw(manifestWithShard({ ...rest, contributionPath: "p" }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	// test-contract: public-api — [6b27939673309b38] 'contributionPath ===
	// null' -> 'false' (paired with the OR mutants above via the opposite
	// combination).
	it("rejects a shard entry with a valid contributionChecksum but invalid contributionPath", () => {
		const { contributionPath: _drop, ...rest } = okShardEntry;
		writeManifestRaw(manifestWithShard({ ...rest, contributionChecksum: "c" }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	// test-contract: public-api — [c5176eac371208eb] 'v.passed !== null &&
	// typeof … !== "boolean"' -> 'false'.
	it("rejects a shard entry whose passed field is neither null nor boolean", () => {
		writeManifestRaw(manifestWithShard({ ...okShardEntry, passed: "yes" }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});
});

describe("parseRequiredManifestStrings — each required field independently guarded", () => {
	// test-contract: public-api — [2d4cc488fc5377c2] 'authoritativeAt ===
	// null' -> 'false'.
	it("rejects a manifest whose authoritativeAt is not a string", () => {
		writeManifestRaw(baseManifest({ authoritativeAt: 42 }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	// test-contract: public-api — [d07ddade44b7f3a6] 'runnerVersion === null'
	// -> 'false'.
	it("rejects a manifest whose runnerVersion is not a string", () => {
		writeManifestRaw(baseManifest({ runnerVersion: 42 }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	// test-contract: public-api — [8ae9a6c22647f18c] 'coverageEngine ===
	// null' -> 'false'.
	it("rejects a manifest whose coverageEngine is not a string", () => {
		writeManifestRaw(baseManifest({ coverageEngine: 42 }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	// test-contract: public-api — [ef7950ecdc6c534d] 'coverageConfigHash ===
	// null' -> 'false'.
	it("rejects a manifest whose coverageConfigHash is not a string", () => {
		writeManifestRaw(baseManifest({ coverageConfigHash: 42 }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	// test-contract: public-api — [892b4a7c13705aaf] 'testDiscoveryHash ===
	// null' -> 'false'.
	it("rejects a manifest whose testDiscoveryHash is not a string", () => {
		writeManifestRaw(baseManifest({ testDiscoveryHash: 42 }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	// test-contract: public-api — [14164ce7a6ebba27] 'dependencyGraphVersion
	// === null' -> 'false'.
	it("rejects a manifest whose dependencyGraphVersion is not a string", () => {
		writeManifestRaw(baseManifest({ dependencyGraphVersion: 42 }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	// test-contract: public-api — [e20ca98653b34490] 'environmentHash ===
	// null' -> 'false'.
	it("rejects a manifest whose environmentHash is not a string", () => {
		writeManifestRaw(baseManifest({ environmentHash: 42 }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});
});

describe("parseManifest — generation validation", () => {
	// test-contract: public-api — [d38ab060712b7c11] '||' -> '&&' on the
	// generation guard. A non-integer NUMBER (1.5) fails only the isInteger
	// clause; original OR still rejects, mutant AND would not.
	it("rejects a non-integer numeric generation", () => {
		writeManifestRaw(baseManifest({ generation: 1.5 }));
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});
});

describe("fixture sanity", () => {
	// test-contract: public-api — guards this file's own fixtures: a fully
	// well-formed manifest built from the same `baseManifest` helper the
	// negative cases above mutate must still promote and read back cleanly,
	// so a typo here can't masquerade as a detector gap.
	it("promotes and reads back a fully well-formed manifest built from baseManifest()", () => {

		const ok = promoteManifest(storeDir, baseManifest(), null);
		expect(ok).toBe(true);
		expect(readAcceptedManifest(storeDir)?.generation).toBe(1);
	});
});
