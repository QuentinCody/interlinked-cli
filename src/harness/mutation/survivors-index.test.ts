import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, describe, expect, it } from "vitest";
import {
	deriveSurvivorsIndex,
	loadSurvivorsIndex,
	makeManifestPersisterWithIndex,
	parseSurvivorsIndex,
	SURVIVORS_INDEX_VERSION,
	survivorsForFile,
	survivorsIndexMatchesGeneration,
	survivorsIndexPath,
	writeSurvivorsIndex,
} from "./survivors-index.js";
import type { SurvivorsIndex } from "./survivors-index.js";
import type { MutantRecord, MutantStatus, MutationManifest, SymbolRecord } from "./types.js";

const AT = "2026-08-16T12:00:00.000Z";

const dirs: string[] = [];
/** A UNIQUE temp dir per test — `loadSurvivorsIndex` caches on (path, mtime,
 *  size), and same-path rewrites inside one millisecond would otherwise serve a
 *  stale parse and hide real regressions. */
function freshDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "survivors-index-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length > 0) {
		const dir = dirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function mutant(mutantId: string, status: MutantStatus): MutantRecord {
	return {
		mutantId,
		siteId: `site-${mutantId}`,
		mutator: "ConditionalExpression",
		originalLexeme: "a",
		replacement: "b",
		ordinalWithinSymbol: 0,
		status,
		firstSeen: AT,
	};
}

function symbol(symbolId: string, mutants: MutantRecord[]): SymbolRecord {
	return {
		symbolId,
		qualifiedName: `fn:${symbolId}`,
		symbolHash: `hash-${symbolId}`,
		mutants: Object.fromEntries(mutants.map((m) => [m.mutantId, m])),
		instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
	};
}

function manifestOf(
	files: Record<string, SymbolRecord[]>,
	overrides: Partial<MutationManifest> = {},
): MutationManifest {
	return {
		version: 1,
		generation: 7,
		authoritativeAt: AT,
		engine: "stryker",
		engineVersion: "1",
		dependencyGraphVersion: "1",
		environmentHash: "test",
		files: Object.fromEntries(
			Object.entries(files).map(([key, symbols]) => [
				key,
				Object.fromEntries(symbols.map((s) => [s.symbolId, s])),
			]),
		),
		...overrides,
	};
}

// ─── deriveSurvivorsIndex: positive (must fire) ────────────────────────────

describe("deriveSurvivorsIndex — positive (must fire)", () => {
	it("P1: collects survivor mutant ids per file with counts", () => {
		const index = deriveSurvivorsIndex(
			manifestOf({
				"src/a.ts": [symbol("s1", [mutant("m1", "survived"), mutant("m2", "killed")])],
			}),
			AT,
		);
		expect(index.files["src/a.ts"]).toEqual({
			survivors: ["m1"],
			mutantCount: 2,
			killed: 1,
		});
	});

	it("P2: folds several symbols in one file into one entry", () => {
		const index = deriveSurvivorsIndex(
			manifestOf({
				"src/a.ts": [
					symbol("s1", [mutant("m1", "survived")]),
					symbol("s2", [mutant("m2", "survived"), mutant("m3", "killed")]),
				],
			}),
			AT,
		);
		expect(index.files["src/a.ts"]?.survivors).toEqual(["m1", "m2"]);
		expect(index.files["src/a.ts"]?.mutantCount).toBe(3);
	});

	it("P3: carries generation and authoritativeAt from the manifest", () => {
		const index = deriveSurvivorsIndex(manifestOf({}, { generation: 42 }), AT);
		expect(index.generation).toBe(42);
		expect(index.authoritativeAt).toBe(AT);
		expect(index.version).toBe(SURVIVORS_INDEX_VERSION);
	});

	it("P4: keeps a measured file with zero survivors as an empty list, not absent", () => {
		const index = deriveSurvivorsIndex(
			manifestOf({ "src/clean.ts": [symbol("s1", [mutant("m1", "killed")])] }),
			AT,
		);
		expect(index.files["src/clean.ts"]).toEqual({ survivors: [], mutantCount: 1, killed: 1 });
		expect(survivorsForFile(index, "src/clean.ts")).toEqual([]);
	});
});

// ─── deriveSurvivorsIndex: negative (must not fire) ────────────────────────

describe("deriveSurvivorsIndex — negative (must not fire)", () => {
	it("N1: non-survived statuses never enter the survivors list", () => {
		const index = deriveSurvivorsIndex(
			manifestOf({
				"src/a.ts": [
					symbol("s1", [
						mutant("m1", "killed"),
						mutant("m2", "timeout"),
						mutant("m3", "uncovered"),
						mutant("m4", "equivalent"),
						mutant("m5", "indeterminate"),
					]),
				],
			}),
			AT,
		);
		expect(index.files["src/a.ts"]?.survivors).toEqual([]);
		expect(index.files["src/a.ts"]?.killed).toBe(1);
		expect(index.files["src/a.ts"]?.mutantCount).toBe(5);
	});

	it("N2: never carries a full mutant record into the sidecar", () => {
		const index = deriveSurvivorsIndex(
			manifestOf({ "src/a.ts": [symbol("s1", [mutant("m1", "survived")])] }),
			AT,
		);
		const serialized = JSON.stringify(index);
		expect(serialized).not.toContain("ConditionalExpression");
		expect(serialized).not.toContain("originalLexeme");
	});

	it("N3: a malformed symbol yields a smaller entry, never a throw", () => {
		const broken = manifestOf({ "src/a.ts": [symbol("s1", [mutant("m1", "survived")])] });
		// A manifest built in memory never passes through `loadManifest`'s healer.
		const file = broken.files["src/a.ts"];
		assert.exists(file);
		Object.assign(file, { s2: { symbolId: "s2" } });
		const index = deriveSurvivorsIndex(broken, AT);
		expect(index.files["src/a.ts"]?.survivors).toEqual(["m1"]);
	});
	it("does not publish a non-string survivor id from a malformed in-memory record", () => {
		const malformed = symbol("s1", [mutant("m1", "survived")]);
		Object.assign(malformed.mutants, { bad: { status: "survived", mutantId: 7 } });
		const index = deriveSurvivorsIndex(manifestOf({ "src/a.ts": [malformed] }), AT);
		expect(index.files["src/a.ts"]?.survivors).toEqual(["m1"]);
	});

	it("N4: an empty manifest yields no file entries", () => {
		expect(deriveSurvivorsIndex(manifestOf({}), AT).files).toEqual({});
	});
});

// ─── write/load round-trip: positive ──────────────────────────────────────

describe("writeSurvivorsIndex / loadSurvivorsIndex — positive (must fire)", () => {
	it("P1: round-trips a written sidecar", () => {
		const dir = freshDir();
		const written = writeSurvivorsIndex(
			dir,
			manifestOf({ "src/a.ts": [symbol("s1", [mutant("m1", "survived")])] }),
			AT,
		);
		expect(loadSurvivorsIndex(dir)).toEqual(written);
	});

	it("P2: writes to the documented sidecar filename", () => {
		const dir = freshDir();
		writeSurvivorsIndex(dir, manifestOf({}), AT);
		expect(survivorsIndexPath(dir)).toBe(join(dir, "mutation-survivors-index.json"));
		expect(JSON.parse(readFileSync(survivorsIndexPath(dir), "utf-8")).version).toBe(
			SURVIVORS_INDEX_VERSION,
		);
	});

	it("P3: a second write replaces the first (cache does not serve stale data)", () => {
		const dir = freshDir();
		writeSurvivorsIndex(dir, manifestOf({ "src/a.ts": [symbol("s1", [mutant("m1", "survived")])] }), AT);
		writeSurvivorsIndex(
			dir,
			manifestOf({ "src/a.ts": [symbol("s1", [mutant("m1", "killed")])] }, { generation: 8 }),
			AT,
		);
		const loaded = loadSurvivorsIndex(dir);
		expect(loaded?.generation).toBe(8);
		expect(loaded?.files["src/a.ts"]?.survivors).toEqual([]);
	});

	it("P4: the sidecar is orders of magnitude smaller than the records it folds", () => {
		const dir = freshDir();
		const many = Array.from({ length: 200 }, (_v, i) => mutant(`m${i}`, i % 2 === 0 ? "survived" : "killed"));
		const manifest = manifestOf({ "src/big.ts": [symbol("s1", many)] });
		writeSurvivorsIndex(dir, manifest, AT);
		const sidecarBytes = readFileSync(survivorsIndexPath(dir), "utf-8").length;
		expect(sidecarBytes).toBeLessThan(JSON.stringify(manifest).length / 4);
	});
});

// ─── absent / malformed: negative (must not fire) ─────────────────────────

describe("loadSurvivorsIndex — negative (must not fire)", () => {
	it("N1: an absent sidecar reads as null, silently", () => {
		expect(loadSurvivorsIndex(freshDir())).toBeNull();
	});

	it("N2: unparseable JSON reads as absent, never as empty", () => {
		const dir = freshDir();
		writeFileSync(survivorsIndexPath(dir), "{not json", "utf-8");
		expect(loadSurvivorsIndex(dir)).toBeNull();
	});

	it("N3: an unknown version reads as absent", () => {
		const dir = freshDir();
		writeFileSync(
			survivorsIndexPath(dir),
			JSON.stringify({ version: 99, generatedAt: AT, generation: 1, authoritativeAt: AT, files: {} }),
			"utf-8",
		);
		expect(loadSurvivorsIndex(dir)).toBeNull();
	});

	it("N4: a malformed file entry rejects the whole sidecar", () => {
		const dir = freshDir();
		writeFileSync(
			survivorsIndexPath(dir),
			JSON.stringify({
				version: SURVIVORS_INDEX_VERSION,
				generatedAt: AT,
				generation: 1,
				authoritativeAt: AT,
				files: { "src/a.ts": { survivors: "nope", mutantCount: 1, killed: 0 } },
			}),
			"utf-8",
		);
		expect(loadSurvivorsIndex(dir)).toBeNull();
	});

	it("N5: parseSurvivorsIndex rejects non-object input", () => {
		expect(parseSurvivorsIndex(null)).toBeNull();
		expect(parseSurvivorsIndex([])).toBeNull();
		expect(parseSurvivorsIndex("x")).toBeNull();
	});

	it("N6: survivorsForFile returns null for a file the sidecar never measured", () => {
		const index = deriveSurvivorsIndex(manifestOf({}), AT);
		expect(survivorsForFile(index, "src/never.ts")).toBeNull();
	});
});

// ─── drift detection ──────────────────────────────────────────────────────

describe("survivorsIndexMatchesGeneration — drift detection", () => {
	it("P1: matches when the sidecar was folded from that manifest", () => {
		const manifest = manifestOf({}, { generation: 12 });
		expect(survivorsIndexMatchesGeneration(deriveSurvivorsIndex(manifest, AT), manifest)).toBe(true);
	});

	it("N1: reports drift when the manifest advanced past the sidecar", () => {
		const index = deriveSurvivorsIndex(manifestOf({}, { generation: 12 }), AT);
		expect(survivorsIndexMatchesGeneration(index, { generation: 13 })).toBe(false);
	});
});

// ─── persister decoration (the freshness contract) ────────────────────────

describe("makeManifestPersisterWithIndex — sidecar is never stale vs the manifest", () => {
	it("P1: writes the sidecar in the same call as the base persister", () => {
		const dir = freshDir();
		const seen: number[] = [];
		const persist = makeManifestPersisterWithIndex(dir, (m: MutationManifest) => {
			seen.push(m.generation);
		});
		persist(manifestOf({ "src/a.ts": [symbol("s1", [mutant("m1", "survived")])] }, { generation: 9 }), null);
		expect(seen).toEqual([9]);
		expect(loadSurvivorsIndex(dir)?.generation).toBe(9);
	});

	it("N1: does not write a sidecar when nobody persists a manifest", () => {
		const dir = freshDir();
		makeManifestPersisterWithIndex(dir, () => {});
		expect(loadSurvivorsIndex(dir)).toBeNull();
	});
});

// ─── foldSymbol malformed-shape guards (exercised indirectly via deriveSurvivorsIndex) ──

describe("foldSymbol — malformed shapes the fold must survive without crashing or over-counting", () => {
	it("test-contract: invariant — a `symbol` value of undefined in the files map (files.symbolId = undefined) is treated as absent, not read into", () => {
		const broken = manifestOf({ "src/a.ts": [symbol("s1", [mutant("m1", "survived")])] });
		// SAFETY: manifests built in memory skip loadManifest's healer; assigning a bare
		// undefined models an engine that omitted the symbol entirely for this key.
		(broken.files["src/a.ts"] as Record<string, unknown>).s2 = undefined;
		expect(() => deriveSurvivorsIndex(broken, AT)).not.toThrow();
		expect(deriveSurvivorsIndex(broken, AT).files["src/a.ts"]).toEqual({
			survivors: ["m1"],
			mutantCount: 1,
			killed: 0,
		});
	});

	it("test-contract: invariant — a real symbol whose `mutants` field is null does not crash the fold and contributes nothing", () => {
		const broken = manifestOf({ "src/a.ts": [symbol("s1", [mutant("m1", "survived")])] });
		// SAFETY: widening through unknown to model a malformed on-disk record shape;
		// the `!`s are sound because manifestOf/symbol just constructed this exact key.
		(broken.files["src/a.ts"]!.s1 as unknown as Record<string, unknown>).mutants = null;
		expect(() => deriveSurvivorsIndex(broken, AT)).not.toThrow();
		expect(deriveSurvivorsIndex(broken, AT).files["src/a.ts"]).toEqual({
			survivors: [],
			mutantCount: 0,
			killed: 0,
		});
	});

	it("test-contract: invariant — a `mutants` container that is typeof \"function\" (not a plain object) is excluded, never iterated", () => {
		const broken = manifestOf({ "src/a.ts": [symbol("s1", [])] });
		// A function is a real JS object and CAN carry its own enumerable properties,
		// so this is the one truthy, typeof-non-"object" value that would actually be
		// iterated by Object.values if the typeof guard were weakened or removed.
		const weird = Object.assign(() => {}, { m1: mutant("m1", "survived") });
		// SAFETY: `!` is sound — manifestOf/symbol just constructed this exact key.
		(broken.files["src/a.ts"]!.s1 as unknown as Record<string, unknown>).mutants = weird;
		expect(deriveSurvivorsIndex(broken, AT).files["src/a.ts"]).toEqual({
			survivors: [],
			mutantCount: 0,
			killed: 0,
		});
	});

	it("test-contract: invariant — a non-object entry inside a real `mutants` map is skipped and never counted", () => {
		const broken = manifestOf({ "src/a.ts": [symbol("s1", [])] });
		// SAFETY: `!`s are sound — manifestOf/symbol just constructed this exact key;
		// widening through unknown to insert a malformed per-mutant entry.
		(broken.files["src/a.ts"]!.s1!.mutants as unknown as Record<string, unknown>).bogus = "x";
		expect(deriveSurvivorsIndex(broken, AT).files["src/a.ts"]).toEqual({
			survivors: [],
			mutantCount: 0,
			killed: 0,
		});
	});
});

// ─── deriveSurvivorsIndex — additional guard-clause and injection-seam mutants ─────

describe("deriveSurvivorsIndex — per-file symbols-container guard and the `at` seam", () => {
	it("test-contract: invariant — a null per-file symbols entry does not crash the whole derive, yields an empty entry", () => {
		const broken = manifestOf({ "src/a.ts": [symbol("s1", [mutant("m1", "survived")])] });
		// SAFETY: models a manifest whose files map holds a corrupt value for one key.
		(broken.files as Record<string, unknown>)["src/bad.ts"] = null;
		expect(() => deriveSurvivorsIndex(broken, AT)).not.toThrow();
		expect(deriveSurvivorsIndex(broken, AT).files["src/bad.ts"]).toEqual({
			survivors: [],
			mutantCount: 0,
			killed: 0,
		});
	});

	it("test-contract: invariant — a per-file symbols container that is typeof \"function\" is excluded, never iterated", () => {
		const broken = manifestOf({});
		const weirdSymbols = Object.assign(() => {}, { s1: symbol("s1", [mutant("m1", "survived")]) });
		// SAFETY: models a corrupt per-file value; widened through unknown on purpose.
		(broken.files as Record<string, unknown>)["src/weird.ts"] = weirdSymbols;
		expect(deriveSurvivorsIndex(broken, AT).files["src/weird.ts"]).toEqual({
			survivors: [],
			mutantCount: 0,
			killed: 0,
		});
	});

	it("test-contract: invariant — a truthy `at` argument is used VERBATIM as generatedAt, not just as a presence flag", () => {
		const index = deriveSurvivorsIndex(manifestOf({}), AT);
		expect(index.generatedAt).toBe(AT);
	});
});

// ─── writeSurvivorsIndex — the cache-priming identity contract ────────────────────

describe("writeSurvivorsIndex — primes the read cache with the SAME object it returns", () => {
	it("test-contract: invariant — loadSurvivorsIndex immediately after a write returns the identical object reference, not a re-parsed copy", () => {
		const dir = freshDir();
		const written = writeSurvivorsIndex(
			dir,
			manifestOf({ "src/a.ts": [symbol("s1", [mutant("m1", "survived")])] }),
			AT,
		);
		expect(loadSurvivorsIndex(dir)).toBe(written);
	});
});

// ─── parseSurvivorsIndex / parseFileEntry — direct raw-shape probing (no file I/O) ──
// parseFileEntry is not exported; every one of its guard clauses is reachable only
// through parseSurvivorsIndex's per-file loop, so these tests target the outer
// function and let the inner one's behavior surface through the result.

function validRawSidecar(): Record<string, unknown> {
	return {
		version: SURVIVORS_INDEX_VERSION,
		generatedAt: AT,
		generation: 3,
		authoritativeAt: AT,
		files: { "src/a.ts": { survivors: ["m1", "m2"], mutantCount: 3, killed: 1 } },
	};
}

describe("parseSurvivorsIndex — well-formed input parses to the exact expected shape", () => {
	it("test-contract: public-api — a well-formed raw object parses to a structurally exact SurvivorsIndex, one real file entry included", () => {
		expect(parseSurvivorsIndex(validRawSidecar())).toEqual({
			version: SURVIVORS_INDEX_VERSION,
			generatedAt: AT,
			generation: 3,
			authoritativeAt: AT,
			files: { "src/a.ts": { survivors: ["m1", "m2"], mutantCount: 3, killed: 1 } },
		});
	});
});

describe("parseSurvivorsIndex — top-level `value` shape guard", () => {
	it("test-contract: invariant — a typeof-\"function\" top-level value with matching enumerable fields is still rejected (not a plain object)", () => {
		const weird = Object.assign(() => {}, {
			version: SURVIVORS_INDEX_VERSION,
			generatedAt: AT,
			generation: 5,
			authoritativeAt: AT,
			files: {},
		});
		expect(parseSurvivorsIndex(weird)).toBeNull();
	});
});

describe("parseSurvivorsIndex — per-field type guards reject wrong-typed values instead of passing them through", () => {
	it("test-contract: invariant — a non-string generatedAt is rejected, even when authoritativeAt is valid", () => {
		const raw = { ...validRawSidecar(), generatedAt: 12345 };
		expect(parseSurvivorsIndex(raw)).toBeNull();
	});

	it("test-contract: invariant — a non-string authoritativeAt is rejected, even when generatedAt is valid", () => {
		const raw = { ...validRawSidecar(), authoritativeAt: 999 };
		expect(parseSurvivorsIndex(raw)).toBeNull();
	});

	it("test-contract: invariant — a non-number generation is rejected rather than carried through wrong-typed", () => {
		const raw = { ...validRawSidecar(), generation: "7" };
		expect(parseSurvivorsIndex(raw)).toBeNull();
	});
});

describe("parseSurvivorsIndex — `files` container guard", () => {
	it("test-contract: invariant — files:null does not crash the parse (Object.entries(null) would throw) and reads as absent", () => {
		const raw = { ...validRawSidecar(), files: null };
		expect(() => parseSurvivorsIndex(raw)).not.toThrow();
		expect(parseSurvivorsIndex(raw)).toBeNull();
	});

	it("test-contract: invariant — a `files` container that is typeof \"function\" is excluded, never iterated for entries", () => {
		const weirdFiles = Object.assign(() => {}, {
			"src/a.ts": { survivors: ["m1"], mutantCount: 1, killed: 0 },
		});
		const raw = { ...validRawSidecar(), files: weirdFiles };
		expect(parseSurvivorsIndex(raw)).toBeNull();
	});
});

describe("parseSurvivorsIndex — per-entry parseFileEntry guard, reached via the files loop", () => {
	it("test-contract: invariant — files:null does not crash (Object.entries(null) would throw) and rejects the whole sidecar", () => {
		const raw = { ...validRawSidecar(), files: { "src/bad.ts": null } };
		expect(() => parseSurvivorsIndex(raw)).not.toThrow();
		expect(parseSurvivorsIndex(raw)).toBeNull();
	});

	it("test-contract: invariant — a typeof-\"function\" file-entry value with matching enumerable fields is still rejected (not a plain object)", () => {
		const weirdEntry = Object.assign(() => {}, { survivors: ["m1"], mutantCount: 1, killed: 0 });
		const raw = { ...validRawSidecar(), files: { "src/weird.ts": weirdEntry } };
		expect(parseSurvivorsIndex(raw)).toBeNull();
	});
});

// ─── loadSurvivorsIndex — cache-comparison mutants (path / mtimeMs / size terms) ───
// Date has millisecond-only precision, but a real write's mtimeMs can carry a
// sub-millisecond fraction — restoring a captured `stat.mtime` via utimesSync
// would silently truncate and never compare equal again. `primeWithCleanMtime`
// sidesteps that by writing directly, forcing an exact integer mtime BEFORE the
// first read, then loading once so the cache primes on that exact value.

const CLEAN_MTIME_MS = 2_000_000_000_000;

function primeWithCleanMtime(dir: string, index: SurvivorsIndex, mtimeMs: number): SurvivorsIndex | null {
	const path = survivorsIndexPath(dir);
	writeFileSync(path, JSON.stringify(index), "utf-8");
	const clean = new Date(mtimeMs);
	utimesSync(path, clean, clean);
	return loadSurvivorsIndex(dir);
}

describe("loadSurvivorsIndex — a real mtime mismatch (size unchanged) always forces a re-parse", () => {
	it("test-contract: invariant — mtime alone differing from the cache is enough to force a fresh parse, regardless of how the other terms are combined", () => {
		const dir = freshDir();
		writeSurvivorsIndex(dir, manifestOf({}, { generation: 1 }), AT);
		const path = survivorsIndexPath(dir);
		const stat1 = statSync(path);
		const written2 = deriveSurvivorsIndex(manifestOf({}, { generation: 9 }), AT);
		// Same JSON shape, single-digit generation both times -> identical byte length,
		// isolating mtime as the only term that actually changed.
		writeFileSync(path, `${JSON.stringify(written2)}\n`, "utf-8");
		const later = new Date(stat1.mtimeMs + 60_000);
		utimesSync(path, later, later);
		expect(loadSurvivorsIndex(dir)?.generation).toBe(9);
	});
});

describe("loadSurvivorsIndex — a real size mismatch (mtime unchanged) always forces a re-parse", () => {
	it("test-contract: invariant — size alone differing from the cache is enough to force a fresh parse, even when mtime matches exactly", () => {
		const dir = freshDir();
		const gen1 = deriveSurvivorsIndex(manifestOf({}, { generation: 1 }), AT);
		primeWithCleanMtime(dir, gen1, CLEAN_MTIME_MS);
		const path = survivorsIndexPath(dir);
		const gen2 = deriveSurvivorsIndex(manifestOf({}, { generation: 12345 }), AT);
		writeFileSync(path, JSON.stringify(gen2), "utf-8"); // deliberately different byte length
		const clean = new Date(CLEAN_MTIME_MS);
		utimesSync(path, clean, clean); // mtime restored to the exact cached value; size legitimately differs
		expect(loadSurvivorsIndex(dir)?.generation).toBe(12345);
	});
});

describe("loadSurvivorsIndex — the cache is keyed on path, not just mtime+size", () => {
	it("test-contract: invariant — a different directory whose file happens to share mtime AND size never serves the other directory's cached object", () => {
		const dirA = freshDir();
		const dirB = freshDir();
		const indexA = deriveSurvivorsIndex(
			manifestOf({ "src/a.ts": [symbol("s1", [mutant("m1", "survived")])] }, { generation: 1 }),
			AT,
		);
		const writtenA = primeWithCleanMtime(dirA, indexA, CLEAN_MTIME_MS);
		const indexB = deriveSurvivorsIndex(
			manifestOf({ "src/b.ts": [symbol("s1", [mutant("m9", "survived")])] }, { generation: 1 }),
			AT,
		);
		const jsonA = JSON.stringify(indexA);
		const jsonB = JSON.stringify(indexB);
		// Guards the byte-length assumption the rest of the test depends on, rather
		// than silently relying on it.
		expect(jsonB.length).toBe(jsonA.length);
		writeFileSync(survivorsIndexPath(dirB), jsonB, "utf-8");
		const clean = new Date(CLEAN_MTIME_MS);
		utimesSync(survivorsIndexPath(dirB), clean, clean);

		const loadedB = loadSurvivorsIndex(dirB);
		expect(loadedB).toEqual(indexB);
		expect(loadedB).not.toBe(writtenA);
	});
});

describe("loadSurvivorsIndex — a cold read of a well-formed sidecar (no prior cache entry for this path) returns the parsed value, not null", () => {
	it("test-contract: public-api — loadSurvivorsIndex on a fresh directory parses and returns a well-formed sidecar verbatim", () => {
		const dir = freshDir();
		const raw = {
			version: SURVIVORS_INDEX_VERSION,
			generatedAt: AT,
			generation: 4,
			authoritativeAt: AT,
			files: { "src/a.ts": { survivors: ["m1"], mutantCount: 1, killed: 0 } },
		};
		// Bypasses writeSurvivorsIndex on purpose: this must be the FIRST touch of
		// `dir`, so the cache cannot already hold an entry for it.
		writeFileSync(survivorsIndexPath(dir), JSON.stringify(raw), "utf-8");
		expect(loadSurvivorsIndex(dir)).toEqual(raw);
	});
});

describe("loadSurvivorsIndex — a malformed read never poisons the cache for a later, now-valid read", () => {
	it("test-contract: invariant — after a malformed read returns null, fixing the file (same mtime+size fingerprint) is served fresh, not the stale null", () => {
		const dir = freshDir();
		const path = survivorsIndexPath(dir);
		const malformed = { version: 999, generatedAt: AT, generation: 1, authoritativeAt: AT, files: {} };
		const malformedJson = JSON.stringify(malformed);
		writeFileSync(path, malformedJson, "utf-8");
		utimesSync(path, new Date(CLEAN_MTIME_MS), new Date(CLEAN_MTIME_MS));
		expect(loadSurvivorsIndex(dir)).toBeNull();

		const valid = { version: SURVIVORS_INDEX_VERSION, generatedAt: AT, generation: 1, authoritativeAt: AT, files: {} };
		const validJson = JSON.stringify(valid);
		// Pad to the EXACT same byte length as the malformed read so the fingerprint
		// this test depends on (mtime+size) is reproducible; trailing whitespace
		// after a complete JSON value is valid and JSON.parse ignores it.
		const padded = validJson + " ".repeat(malformedJson.length - validJson.length);
		expect(padded.length).toBe(malformedJson.length);
		writeFileSync(path, padded, "utf-8");
		utimesSync(path, new Date(CLEAN_MTIME_MS), new Date(CLEAN_MTIME_MS));

		expect(loadSurvivorsIndex(dir)).toEqual(valid);
	});
});
