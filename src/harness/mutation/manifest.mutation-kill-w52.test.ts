// Mutation-kill suite for wave pass1_w52 survivors in ./manifest.ts.
// Each test below is written to FAIL if the paired orig->repl mutation from
// the brief were applied to the source. See scratch/fleet-r3/w52-briefs/
// src_harness_mutation_manifest.ts.json for the mutant list this targets.

import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		statSync: vi.fn(actual.statSync),
		readFileSync: vi.fn(actual.readFileSync),
	};
});

vi.mock("./instability.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./instability.js")>();
	return { ...actual, updateInstability: vi.fn(actual.updateInstability) };
});

import type { MutationManifest, MutationReceipt } from "./types.js";
import { freshInstability, updateInstability } from "./instability.js";
import {
	applyMeasuredRun,
	appendReceipt,
	changedSymbols,
	clearManifestCache,
	emptyManifest,
	hasFileBaseline,
	loadManifest,
	MutationManifestTestTargetError,
	mutationManifestPath,
	saveManifest,
} from "./manifest.js";

const mockedStatSync = vi.mocked(statSync);
const mockedReadFileSync = vi.mocked(readFileSync);

let dirs: string[] = [];

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "manifest-w52-"));
	dirs.push(dir);
	return dir;
}

beforeEach(() => {
	clearManifestCache();
});

afterEach(() => {
	clearManifestCache();
	for (const d of dirs) {
		rmSync(d, { recursive: true, force: true });
	}
	dirs = [];
});

const META = {
	engine: "stryker",
	engineVersion: "1.0.0",
	dependencyGraphVersion: "1",
	environmentHash: "h",
	authoritativeAt: "2020-01-01T00:00:00Z",
};

describe("MutationManifestTestTargetError", () => {
	it("carries the exact name and an informative message", () => {
		const err = new MutationManifestTestTargetError("src/foo.test.ts");
		expect(err.name).toBe("MutationManifestTestTargetError");
		expect(err.message).toContain('refusing to record a baseline for test file "src/foo.test.ts"');
		expect(err.message).toContain("the test is the oracle");
	});
});

describe("loadManifest cache key (path/mtime/size)", () => {
	it("does not serve a different path's cached manifest even with matching mtime+size", () => {
		const dirA = makeDir();
		const dirB = makeDir();
		const pathA = mutationManifestPath(dirA);
		const pathB = mutationManifestPath(dirB);
		const contentA = '{"version":1,"generation":1,"files":{}}';
		const contentB = '{"version":1,"generation":2,"files":{}}';
		expect(contentA.length).toBe(contentB.length);
		writeFileSync(pathA, contentA, "utf-8");
		writeFileSync(pathB, contentB, "utf-8");
		const fixed = new Date(2021, 0, 1);
		utimesSync(pathA, fixed, fixed);
		utimesSync(pathB, fixed, fixed);

		const a = loadManifest(dirA);
		const b = loadManifest(dirB);
		expect(a?.generation).toBe(1);
		expect(b?.generation).toBe(2);
	});

	it("re-parses when the file's mtime changed even though the path repeats", () => {
		const dir = makeDir();
		const path = mutationManifestPath(dir);
		const t1 = new Date(2021, 0, 1);
		const t2 = new Date(2021, 0, 2);
		writeFileSync(path, '{"version":1,"generation":1,"files":{}}', "utf-8");
		utimesSync(path, t1, t1);
		const first = loadManifest(dir);
		expect(first?.generation).toBe(1);

		writeFileSync(path, '{"version":1,"generation":2,"files":{}}', "utf-8");
		utimesSync(path, t2, t2);
		const second = loadManifest(dir);
		expect(second?.generation).toBe(2);
	});

	it("re-parses when the file's size changed even though mtime was pinned identical", () => {
		const dir = makeDir();
		const path = mutationManifestPath(dir);
		const fixed = new Date(2021, 0, 1);
		writeFileSync(path, '{"version":1,"generation":1,"files":{}}', "utf-8");
		utimesSync(path, fixed, fixed);
		const first = loadManifest(dir);
		expect(first?.generation).toBe(1);

		writeFileSync(path, '{"version":1,"generation":2,"files":{},"padding":"xxxxxxxxxxxxxx"}', "utf-8");
		utimesSync(path, fixed, fixed);
		const second = loadManifest(dir);
		expect(second?.generation).toBe(2);
	});

	it("reuses the cached parse on a genuinely unchanged file (single read)", () => {
		const dir = makeDir();
		const path = mutationManifestPath(dir);
		writeFileSync(path, '{"version":1,"generation":1,"files":{}}', "utf-8");
		mockedReadFileSync.mockClear();
		const first = loadManifest(dir);
		const second = loadManifest(dir);
		expect(first?.generation).toBe(1);
		expect(second?.generation).toBe(1);
		expect(mockedReadFileSync).toHaveBeenCalledTimes(1);
	});
});

describe("loadManifest missing-file short-circuit", () => {
	it("returns null for a missing manifest without ever calling statSync", () => {
		const dir = makeDir();
		mockedStatSync.mockClear();
		const result = loadManifest(dir);
		expect(result).toBeNull();
		expect(mockedStatSync).not.toHaveBeenCalled();
	});
});

describe("parseManifestShell defaults (via loadManifest)", () => {
	function writeAndLoad(dir: string, extra: Record<string, unknown>) {
		const path = mutationManifestPath(dir);
		writeFileSync(path, JSON.stringify({ version: 1, files: {}, ...extra }), "utf-8");
		return loadManifest(dir);
	}

	it("defaults engineVersion to empty string when the field is not a string", () => {
		const dir = makeDir();
		const manifest = writeAndLoad(dir, { engineVersion: 123 });
		expect(manifest?.engineVersion).toBe("");
	});

	it("defaults dependencyGraphVersion to empty string when the field is not a string", () => {
		const dir = makeDir();
		const manifest = writeAndLoad(dir, { dependencyGraphVersion: 456 });
		expect(manifest?.dependencyGraphVersion).toBe("");
	});

	it("defaults environmentHash to empty string when the field is not a string", () => {
		const dir = makeDir();
		const manifest = writeAndLoad(dir, { environmentHash: 789 });
		expect(manifest?.environmentHash).toBe("");
	});

	it("carries a string sourceRevision through as its own key", () => {
		const dir = makeDir();
		const manifest = writeAndLoad(dir, { sourceRevision: "abc123" });
		expect(manifest && Object.prototype.hasOwnProperty.call(manifest, "sourceRevision")).toBe(true);
		expect(manifest?.sourceRevision).toBe("abc123");
	});

	it("omits the sourceRevision key entirely when the field is absent", () => {
		const dir = makeDir();
		const manifest = writeAndLoad(dir, {});
		expect(manifest && Object.prototype.hasOwnProperty.call(manifest, "sourceRevision")).toBe(false);
	});
});

describe("saveManifest / appendReceipt encoding", () => {
	it("saveManifest writes a UTF-8 file that round-trips through JSON.parse", () => {
		const dir = makeDir();
		const manifest = emptyManifest({ ...META, authoritativeAt: "2022-05-05T00:00:00Z" });
		saveManifest(dir, manifest);
		const raw = readFileSync(mutationManifestPath(dir), "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.version).toBe(1);
		expect(parsed.authoritativeAt).toBe("2022-05-05T00:00:00Z");
	});

	it("appendReceipt writes a UTF-8 JSONL line that round-trips through JSON.parse", () => {
		const dir = makeDir();
		const receipt: MutationReceipt = { overlayHash: "overlay", generation: 1, sites: [], engine: "stryker", engineVersion: "1", measuredAt: "2022-05-05T00:00:00Z", outcome: "measured_clean" };
		appendReceipt(dir, receipt);
		const raw = readFileSync(join(dir, "mutation-receipts.jsonl"), "utf-8");
		const line = raw.trim().split("\n")[0]!;
		const parsed = JSON.parse(line);
		expect(parsed.measuredAt).toBe("2022-05-05T00:00:00Z");
	});
});

describe("hasFileBaseline / changedSymbols on per-file records", () => {
	it("hasFileBaseline reads an existing file's symbol records without throwing", () => {
		const manifest: MutationManifest = {
			...emptyManifest(META),
			files: {
				"src/foo.ts": {
					sym1: { symbolId: "sym1", qualifiedName: "foo", symbolHash: "H1", mutants: {}, instability: freshInstability() },
				},
			},
		};
		expect(hasFileBaseline(manifest, "src/foo.ts")).toBe(true);
		expect(hasFileBaseline(manifest, "src/missing.ts")).toBe(false);
	});

	it("changedSymbols flags a brand-new symbol without throwing on the missing prior record", () => {
		const manifest = emptyManifest(META);
		const overlay = new Map([["sym1", { symbolId: "sym1", qualifiedName: "foo", symbolHash: "H1" }]]);
		const changed = changedSymbols(manifest, "src/foo.ts", overlay);
		expect(changed.has("sym1")).toBe(true);
		expect(changed.size).toBe(1);
	});

	it("changedSymbols does not flag an existing symbol whose hash is unchanged", () => {
		const manifest: MutationManifest = {
			...emptyManifest(META),
			files: {
				"src/foo.ts": {
					sym1: { symbolId: "sym1", qualifiedName: "foo", symbolHash: "H1", mutants: {}, instability: freshInstability() },
				},
			},
		};
		const overlay = new Map([["sym1", { symbolId: "sym1", qualifiedName: "foo", symbolHash: "H1" }]]);
		const changed = changedSymbols(manifest, "src/foo.ts", overlay);
		expect(changed.size).toBe(0);
	});
});

describe("applyMeasuredRun", () => {
	it("replaces a symbol's snapshot when its hash changed, even with zero fresh measurements", () => {
		const base: MutationManifest = {
			...emptyManifest(META),
			files: {
				"src/bar.ts": {
					sym1: {
						symbolId: "sym1",
						qualifiedName: "bar",
						symbolHash: "OLD",
						mutants: { m1: { mutantId: "m1", siteId: "s1", mutator: "X", originalLexeme: "a", replacement: "b", ordinalWithinSymbol: 0, status: "survived", firstSeen: "2020-01-01" } },
						instability: freshInstability(),
					},
				},
			},
		};
		const overlay = new Map([["sym1", { symbolId: "sym1", qualifiedName: "bar", symbolHash: "NEW" }]]);
		const result = applyMeasuredRun({
			base,
			file: "src/bar.ts",
			overlayHashes: overlay,
			measured: [],
			at: "2020-01-02T00:00:00Z",
		});
		const rec = result.files["src/bar.ts"]?.sym1;
		if (!rec) throw new Error("measured symbol must remain in the manifest");
		expect(rec.symbolHash).toBe("NEW");
		expect(Object.keys(rec.mutants)).toHaveLength(0);
	});

	it("forwards an explicit stabilityThreshold instead of silently defaulting", () => {
		const base = emptyManifest(META);
		const overlay = new Map([["sym1", { symbolId: "sym1", qualifiedName: "baz", symbolHash: "H1" }]]);
		vi.mocked(updateInstability).mockClear();
		applyMeasuredRun({
			base,
			file: "src/baz.ts",
			overlayHashes: overlay,
			measured: [],
			at: "2020-01-01T00:00:00Z",
			stabilityThreshold: 1,
		});
		const calls = vi.mocked(updateInstability).mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		const lastArgs = calls.at(-1)!;
		expect(lastArgs[1].threshold).toBe(1);
	});
});
