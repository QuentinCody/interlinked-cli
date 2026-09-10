import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSymbolHashes, deriveIdentities, type SymbolHashEntry } from "./identity.js";
import {
	acceptedSurvivors,
	stampProvenance,
	provenanceOf,
	corruptManifestMessage,
	appendReceipt,
	applyMeasuredRun,
	changedSymbols,
	clearManifestCache,
	computeNewSurvivors,
	emptyManifest,
	loadManifest,
	type MeasuredMutant,
	MutationManifestTestTargetError,
	makeManifestPersister,
	mutationManifestPath,
	mutationReceiptsPath,
	normalizeManifestKey,
	quarantinedSymbols,
	saveManifest,
} from "./manifest.js";
import type {
	MutantIdentity,
	MutantRecord,
	MutantStatus,
	MutationManifest,
	MutationReceipt,
	SymbolRecord,
} from "./types.js";

const FILE = "src/a.ts";
const META = {
	engine: "stryker",
	engineVersion: "1.0.0",
	dependencyGraphVersion: "g1",
	environmentHash: "env1",
	authoritativeAt: "2026-01-01T00:00:00Z",
};

function rec(mutantId: string, status: MutantStatus): MutantRecord {
	return {
		mutantId,
		siteId: `${mutantId}-site`,
		mutator: "Op",
		originalLexeme: ">",
		replacement: ">=",
		ordinalWithinSymbol: 0,
		status,
		firstSeen: "2026-01-01T00:00:00Z",
	};
}

interface SymSpec {
	symbolId: string;
	symbolHash: string;
	mutants?: MutantRecord[];
	quarantined?: boolean;
}

function sym(spec: SymSpec): SymbolRecord {
	const mutants: Record<string, MutantRecord> = {};
	for (const m of spec.mutants ?? []) mutants[m.mutantId] = m;
	return {
		symbolId: spec.symbolId,
		qualifiedName: "fn",
		symbolHash: spec.symbolHash,
		mutants,
		instability: { events: [], consecutiveStableRuns: 0, quarantined: spec.quarantined ?? false },
	};
}

function manifestWith(file: string, symbols: SymbolRecord[]): MutationManifest {
	const records: Record<string, SymbolRecord> = {};
	for (const s of symbols) records[s.symbolId] = s;
	return { ...emptyManifest(META), files: { [file]: records } };
}

function measured(mutantId: string, symbolId: string, status: MutantStatus): MeasuredMutant {
	const identity: MutantIdentity = {
		mutantId,
		siteId: `${mutantId}-site`,
		symbolId,
		qualifiedName: "fn",
		mutator: "Op",
		originalLexeme: ">",
		replacement: ">=",
		ordinalWithinSymbol: 0,
	};
	return { identity, status };
}

const overlay = (entries: Array<[string, string]>): Map<string, { qualifiedName: string; symbolHash: string }> =>
	new Map(entries.map(([id, hash]) => [id, { qualifiedName: "fn", symbolHash: hash }]));

describe("changedSymbols", () => {
	it("flags new and hash-changed symbols, skips unchanged", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1" }),
			sym({ symbolId: "s2", symbolHash: "h2" }),
		]);
		const changed = changedSymbols(
			base,
			FILE,
			overlay([
				["s1", "h1"], // unchanged
				["s2", "h2-NEW"], // changed
				["s3", "h3"], // new
			]),
		);
		expect([...changed].sort()).toEqual(["s2", "s3"]);
	});

	it("treats a file absent from the manifest as empty (no records)", () => {
		const empty = emptyManifest(META);
		expect(changedSymbols(empty, "src/missing.ts", overlay([["s1", "h1"]]))).toEqual(new Set(["s1"]));
		expect([...acceptedSurvivors(empty, "src/missing.ts")]).toEqual([]);
		expect([...quarantinedSymbols(empty, "src/missing.ts")]).toEqual([]);
	});
});

describe("acceptedSurvivors / quarantinedSymbols", () => {
	it("collects survived+equivalent mutantIds and quarantined symbols", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived"), rec("m2", "killed")] }),
			sym({ symbolId: "s2", symbolHash: "h2", mutants: [rec("m3", "equivalent")], quarantined: true }),
		]);
		expect([...acceptedSurvivors(base, FILE)].sort()).toEqual(["m1", "m3"]);
		expect([...quarantinedSymbols(base, FILE)]).toEqual(["s2"]);
	});
});

describe("computeNewSurvivors (the invariant)", () => {
	const base = manifestWith(FILE, [
		sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("accepted", "survived")] }),
		sym({ symbolId: "s2", symbolHash: "h2", quarantined: true }),
	]);
	const sets = {
		changed: changedSymbols(base, FILE, overlay([["s1", "h1-CHANGED"], ["s2", "h2-CHANGED"], ["s3", "h3"]])),
		accepted: acceptedSurvivors(base, FILE),
		quarantined: quarantinedSymbols(base, FILE),
	};

	it("blocks a NEW survivor in a changed, non-quarantined symbol", () => {
		const out = computeNewSurvivors([measured("fresh", "s3", "survived")], sets, "now");
		expect(out.map((r) => r.mutantId)).toEqual(["fresh"]);
	});

	it("does not block a grandfathered (accepted) survivor", () => {
		expect(computeNewSurvivors([measured("accepted", "s1", "survived")], sets, "now")).toEqual([]);
	});

	it("does not block a survivor in a quarantined symbol", () => {
		expect(computeNewSurvivors([measured("q", "s2", "survived")], sets, "now")).toEqual([]);
	});

	it("does not block a killed mutant, nor a survivor in an unchanged symbol", () => {
		expect(computeNewSurvivors([measured("k", "s3", "killed")], sets, "now")).toEqual([]);
		const unchanged = { ...sets, changed: new Set<string>() };
		expect(computeNewSurvivors([measured("x", "s3", "survived")], unchanged, "now")).toEqual([]);
	});
});

describe("manifest I/O", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mut-manifest-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips through save/load", () => {
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] })]);
		saveManifest(dir, m);
		expect(loadManifest(dir)).toEqual(m);
	});

	it("returns null when no manifest exists", () => {
		expect(loadManifest(dir)).toBeNull();
	});

	it("returns null on malformed JSON", () => {
		writeFileSync(mutationManifestPath(dir), "not json {", "utf-8");
		expect(loadManifest(dir)).toBeNull();
	});

	it("returns null on an unsupported version", () => {
		writeFileSync(mutationManifestPath(dir), JSON.stringify({ version: 2, files: {} }), "utf-8");
		expect(loadManifest(dir)).toBeNull();
	});

	it("P: serves the SAME parsed object while the file is unchanged (per-edit parse cost)", () => {
		// The daemon calls loadManifest on EVERY code-edit PreToolUse. At 46MB a
		// fresh JSON.parse costs ~300MB transient heap per call — measured live
		// 2026-07-28 as the rss-ceiling kill loop. Unchanged file ⇒ identical
		// object, no re-parse.
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] })]);
		saveManifest(dir, m);
		const first = loadManifest(dir);
		const second = loadManifest(dir);
		expect(second).toBe(first);
	});

	it("P: the persisted BYTES are a loadable manifest, independent of any in-process cache", () => {
		// Guards the persist against cache-tautology: with save-primes-cache, a
		// broken write (e.g. an empty file) would be invisible to a save→load
		// round-trip because the cache serves the good object. Read the raw disk
		// bytes instead — this is what a FRESH daemon will actually parse.
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] })]);
		saveManifest(dir, m);
		const parsed = JSON.parse(readFileSync(mutationManifestPath(dir), "utf-8"));
		expect(parsed).toEqual(m);
	});

	it("P: saveManifest primes the cache — the next load returns the saved object itself", () => {
		// A measured-clean pass persists the refreshed manifest; without priming,
		// every persist invalidates the read cache and the NEXT edit re-parses
		// 46MB (~300MB transient) — the cache would self-defeat under exactly the
		// traffic it exists for.
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] })]);
		saveManifest(dir, m);
		expect(loadManifest(dir)).toBe(m);
	});

	it("P: clearManifestCache drops the resident copy so the next load re-parses", () => {
		// The idle-shrink path: a daemon idle for minutes should not stay a
		// ~1GB jetsam target for the sake of a cache the next event can rebuild
		// in ~200ms. After clearing, identity must change (fresh parse).
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] })]);
		saveManifest(dir, m);
		const first = loadManifest(dir);
		clearManifestCache();
		const second = loadManifest(dir);
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
	});

	it("N: a rewritten manifest is re-parsed (mtime/size key)", () => {
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] })]);
		saveManifest(dir, m);
		const first = loadManifest(dir);
		// A second symbol changes the serialized SIZE, so the re-parse triggers
		// deterministically regardless of filesystem mtime granularity.
		const m2 = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] }),
			sym({ symbolId: "s2", symbolHash: "h2", mutants: [rec("m2", "killed")] }),
		]);
		saveManifest(dir, m2);
		const second = loadManifest(dir);
		expect(second).not.toBe(first);
		expect(Object.keys(second?.files[FILE] ?? {})).toHaveLength(2);
	});
});

describe("applyMeasuredRun (measured-clean refresh)", () => {
	const AT = "2026-06-28T12:00:00Z";

	it("bumps the generation and stamps authoritativeAt", () => {
		const base = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1" })]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1-CHANGED"]]),
			measured: [measured("m1", "s1", "killed")],
			at: AT,
		});
		expect(out.generation).toBe(base.generation + 1);
		expect(out.authoritativeAt).toBe(AT);
		expect(base.files[FILE]?.s1?.symbolHash).toBe("h1"); // base untouched (pure)
	});

	// test-contract: invariant — the partial-scope laundering guard (external
	// review 2026-08-23, third pass, finding 1). Stryker omits mutants whose
	// whole AST span exceeds a requested range, so a ranged run's mutant set is
	// a floor, never a census: it must MERGE into the manifest, never replace.
	it("P: a PARTIAL run on an unchanged symbol retains unmeasured prior mutants (the m1/m2 repro)", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived"), rec("m2", "survived")] }),
		]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1"]]),
			measured: [measured("m1", "s1", "killed")],
			at: AT,
			partial: true,
		});
		const mutants = out.files[FILE]?.s1?.mutants ?? {};
		expect(mutants.m1?.status).toBe("killed"); // measured status wins
		expect(mutants.m2?.status).toBe("survived"); // NOT dropped by the partial view
	});

	it("P: a PARTIAL run on a CHANGED symbol keeps the prior record verbatim", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived"), rec("m2", "survived")] }),
		]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1-CHANGED"]]),
			measured: [measured("m1", "s1", "killed")],
			at: AT,
			partial: true,
		});
		const record = out.files[FILE]?.s1;
		expect(record?.symbolHash).toBe("h1"); // prior record carried, not replaced
		expect(Object.keys(record?.mutants ?? {}).sort()).toEqual(["m1", "m2"]);
		expect(record?.mutants.m2?.status).toBe("survived");
	});

	it("N: a FULL run still replaces the symbol's mutant map (differential refresh unchanged)", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived"), rec("m2", "survived")] }),
		]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1-CHANGED"]]),
			measured: [measured("m1", "s1", "killed")],
			at: AT,
		});
		expect(Object.keys(out.files[FILE]?.s1?.mutants ?? {})).toEqual(["m1"]);
	});

	it("preserves firstSeen for a persisting mutantId and stamps new ones", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] }),
		]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1-CHANGED"]]),
			measured: [measured("m1", "s1", "killed"), measured("m2", "s1", "killed")],
			at: AT,
		});
		const mutants = out.files[FILE]?.s1?.mutants ?? {};
		expect(mutants.m1?.firstSeen).toBe("2026-01-01T00:00:00Z"); // preserved
		expect(mutants.m1?.status).toBe("killed"); // status refreshed
		expect(mutants.m2?.firstSeen).toBe(AT); // new mutant stamped now
	});

	it("carries an unchanged, unmeasured symbol forward verbatim (differential skip)", () => {
		const prior = sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] });
		const base = manifestWith(FILE, [prior]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1"]]),
			measured: [],
			at: AT,
		});
		expect(out.files[FILE]?.s1).toBe(prior); // same record, knowledge kept
	});

	it("quarantines on mutantId churn under an UNCHANGED hash", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "killed")] }),
		]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1"]]), // hash unchanged…
			measured: [measured("mX", "s1", "killed")], // …but the ids differ → churn
			at: AT,
		});
		const inst = out.files[FILE]?.s1?.instability;
		expect(inst?.quarantined).toBe(true);
		expect(inst?.events.at(-1)).toEqual({ at: AT, kind: "id_churn" });
	});

	it("does NOT count new ids in a hash-CHANGED symbol as churn", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "killed")] }),
		]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1-CHANGED"]]), // edited symbol…
			measured: [measured("mX", "s1", "killed")], // …new ids are expected
			at: AT,
		});
		const inst = out.files[FILE]?.s1?.instability;
		expect(inst?.quarantined).toBe(false);
		expect(inst?.consecutiveStableRuns).toBe(1);
	});

	it("drops symbols no longer present in the overlay (deleted code)", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1" }),
			sym({ symbolId: "s2", symbolHash: "h2" }),
		]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1"]]),
			measured: [],
			at: AT,
		});
		expect(Object.keys(out.files[FILE] ?? {})).toEqual(["s1"]);
	});
});

describe("receipt persistence", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mut-receipts-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const receipt: MutationReceipt = {
		overlayHash: "a".repeat(64),
		generation: 1,
		sites: [{ mutantId: "m1", symbolId: "s1", status: "killed" }],
		engine: "stryker",
		engineVersion: "1.0.0",
		measuredAt: "2026-06-28T12:00:00Z",
		outcome: "measured_clean",
	};

	it("appends one JSON line per receipt", () => {
		appendReceipt(dir, receipt);
		appendReceipt(dir, { ...receipt, generation: 2 });
		const lines = readFileSync(mutationReceiptsPath(dir), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "{}").generation).toBe(1);
		expect(JSON.parse(lines[1] ?? "{}").generation).toBe(2);
	});

	it("makeManifestPersister writes both the manifest and the receipt", () => {
		const persist = makeManifestPersister(dir);
		const manifest = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1" })]);
		persist(manifest, receipt);
		expect(loadManifest(dir)?.files[FILE]?.s1?.symbolHash).toBe("h1");
		expect(readFileSync(mutationReceiptsPath(dir), "utf-8")).toContain('"overlayHash":"a');
	});
});

// ---------------------------------------------------------------------------
// Phase D ratchet: 16 survivors of 129. This module is the ratchet's FLOOR — a
// silently-wrong load or merge does not fail loudly, it changes what counts as
// "new", which is the one thing every mutation verdict is measured against.
// ---------------------------------------------------------------------------

describe("loadManifest — a malformed file must read as absent, never as empty", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mut-load-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null when no manifest exists", () => {
		expect(loadManifest(dir)).toBeNull();
	});

	it("round-trips a manifest it saved", () => {
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1" })]);
		saveManifest(dir, m);
		expect(loadManifest(dir)?.files[FILE]?.s1?.symbolHash).toBe("h1");
	});

	it("returns null on unparseable JSON rather than throwing", () => {
		writeFileSync(mutationManifestPath(dir), "{ not json");
		expect(loadManifest(dir)).toBeNull();
	});

	it("rejects a manifest from a different schema version", () => {
		// Reading a v2 file as v1 would silently reinterpret every record.
		writeFileSync(mutationManifestPath(dir), JSON.stringify({ version: 2, files: {} }));
		expect(loadManifest(dir)).toBeNull();
	});

	it("rejects a manifest with no files map", () => {
		writeFileSync(mutationManifestPath(dir), JSON.stringify({ version: 1 }));
		expect(loadManifest(dir)).toBeNull();
	});

	it("rejects a JSON scalar where an object was expected", () => {
		for (const body of ["null", "7", '"x"']) {
			writeFileSync(mutationManifestPath(dir), body);
			expect(loadManifest(dir)).toBeNull();
		}
	});
});

// ---------------------------------------------------------------------------
// parseManifestShell (loadManifest's boundary parser, replacing an unchecked
// `JSON.parse(...) as MutationManifest` cast). Exercised through loadManifest
// — the parser is not exported, matching this file's own convention for
// loadManifest's other internal helpers (cachedManifest, isAlreadyCanonical).
// ---------------------------------------------------------------------------

describe("loadManifest — top-level shell parsing (parseManifestShell)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mut-shell-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("P1: tolerates a missing/malformed top-level scalar by defaulting instead of rejecting the whole manifest", () => {
		// The old unchecked cast trusted EVERY field, not just version+files. A
		// real manifest.json is written only by this codebase's own writers, so
		// this leniency is a defensive backstop, not something a real file needs
		// — but it must not regress: a manifest a real writer produced years ago,
		// before a field existed, must still load.
		writeFileSync(
			mutationManifestPath(dir),
			JSON.stringify({ version: 1, files: {}, generation: "not-a-number", engine: 7 }),
		);
		const loaded = loadManifest(dir);
		expect(loaded).not.toBeNull();
		expect(loaded?.generation).toBe(0);
		expect(loaded?.engine).toBe("");
		expect(loaded?.authoritativeAt).toBe("");
	});

	it("P2: passes well-typed scalars and fileProvenance through unchanged", () => {
		writeFileSync(
			mutationManifestPath(dir),
			JSON.stringify({
				version: 1,
				generation: 3,
				authoritativeAt: "2026-01-01T00:00:00Z",
				engine: "stryker",
				engineVersion: "1.2.3",
				dependencyGraphVersion: "g1",
				environmentHash: "env1",
				files: {},
				fileProvenance: { "src/a.ts": { at: "t0", scope: "import_graph", testCount: 2, surface: "per_edit" } },
			}),
		);
		const loaded = loadManifest(dir);
		expect(loaded?.generation).toBe(3);
		expect(loaded?.engine).toBe("stryker");
		expect(loaded?.fileProvenance?.["src/a.ts"]?.testCount).toBe(2);
	});

	it("N1: rejects a manifest whose files field is present but not an object (previously only checked for truthiness)", () => {
		writeFileSync(mutationManifestPath(dir), JSON.stringify({ version: 1, files: "oops" }));
		expect(loadManifest(dir)).toBeNull();
	});

	it("N2: rejects a manifest whose files field is an array (arrays are typeof 'object' but not a keyed record)", () => {
		writeFileSync(mutationManifestPath(dir), JSON.stringify({ version: 1, files: [] }));
		expect(loadManifest(dir)).toBeNull();
	});

	it("N3: ignores a malformed fileProvenance rather than rejecting the manifest", () => {
		writeFileSync(mutationManifestPath(dir), JSON.stringify({ version: 1, files: {}, fileProvenance: "oops" }));
		const loaded = loadManifest(dir);
		expect(loaded).not.toBeNull();
		expect(loaded?.fileProvenance).toBeUndefined();
	});
});

describe("changedSymbols — what counts as changed decides what counts as new", () => {
	const entry = (symbolId: string, symbolHash: string) =>
		new Map([[symbolId, { symbolId, qualifiedName: "fn", symbolHash }]]);

	it("treats a symbol with no prior record as changed", () => {
		// A brand-new symbol has nothing to compare against, so everything in it is
		// new work; calling it unchanged would skip it entirely.
		const base = manifestWith(FILE, []);
		expect([...changedSymbols(base, FILE, entry("s1", "h1"))]).toEqual(["s1"]);
	});

	it("treats a differing hash as changed", () => {
		const base = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "old" })]);
		expect([...changedSymbols(base, FILE, entry("s1", "new"))]).toEqual(["s1"]);
	});

	it("treats an identical hash as UNCHANGED", () => {
		const base = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "same" })]);
		expect([...changedSymbols(base, FILE, entry("s1", "same"))]).toEqual([]);
	});

	it("ignores a prior record for a different file", () => {
		const base = manifestWith("src/other.ts", [sym({ symbolId: "s1", symbolHash: "same" })]);
		expect([...changedSymbols(base, FILE, entry("s1", "same"))]).toEqual(["s1"]);
	});
});

// ---------------------------------------------------------------------------
// The persist round-trip (plan 16 §11.1). `applyMeasuredRun` rebuilds a file's
// record by iterating `overlayHashes`, so a measured mutant whose symbolId is
// absent from that map is dropped without a trace. Module-scope mutants hit
// exactly that hole until `computeSymbolHashes` learned to emit a "(module)"
// entry. These tests use the REAL identity derivation — a hand-built map would
// pin the fixture, not the agreement between the two producers.
// ---------------------------------------------------------------------------

describe("applyMeasuredRun — no measured mutant may be dropped on persist", () => {
	const MIXED_FILE = "src/mixed.ts";
	// Both kinds in one file: a module-scope constant and a function body.
	const MIXED = `const LIMIT = 10;\n\nexport function over(x: number): boolean {\n\treturn x > LIMIT;\n}\n`;
	const AT = "2026-07-30T00:00:00Z";

	function identities(): MutantIdentity[] {
		const ids = deriveIdentities(MIXED_FILE, MIXED, [
			{ file: MIXED_FILE, mutator: "Num", originalLexeme: "10", replacement: "11", startOffset: MIXED.indexOf("10") },
			{ file: MIXED_FILE, mutator: "Op", originalLexeme: ">", replacement: ">=", startOffset: MIXED.indexOf("> LIMIT") },
		]);
		if (!ids) throw new Error("typescript unavailable — identity derivation returned null");
		return ids;
	}

	function hashes(): Map<string, SymbolHashEntry> {
		const h = computeSymbolHashes(MIXED_FILE, MIXED);
		if (!h) throw new Error("typescript unavailable — symbol hashing returned null");
		return h;
	}

	const asMeasured = (ids: MutantIdentity[]): MeasuredMutant[] =>
		ids.map((identity) => ({ identity, status: "survived" }));

	const persistedMutantIds = (m: MutationManifest): string[] =>
		Object.values(m.files[MIXED_FILE] ?? {})
			.flatMap((s) => Object.keys(s.mutants))
			.sort();

	const idOf = (ids: MutantIdentity[], qualifiedName: string): string =>
		ids.find((i) => i.qualifiedName === qualifiedName)?.mutantId ?? "missing";

	it("P: persists BOTH a function mutant and a module-scope mutant", () => {
		const ids = identities();
		const out = applyMeasuredRun({
			base: emptyManifest(META),
			file: MIXED_FILE,
			overlayHashes: hashes(),
			measured: asMeasured(ids),
			at: AT,
		});
		expect(persistedMutantIds(out)).toEqual(ids.map((i) => i.mutantId).sort());
		expect(
			Object.values(out.files[MIXED_FILE] ?? {})
				.map((s) => s.qualifiedName)
				.sort(),
		).toEqual(["(module)", "over"]);
	});

	it("N: a mutant whose symbolId is absent from the hash map is still dropped (the mechanism)", () => {
		// Pins WHY the fix belongs in computeSymbolHashes: an incomplete symbol
		// universe loses mutants silently here, and always will.
		const ids = identities();
		const partial = new Map(hashes());
		partial.delete(ids.find((i) => i.qualifiedName === "(module)")?.symbolId ?? "");
		const out = applyMeasuredRun({
			base: emptyManifest(META),
			file: MIXED_FILE,
			overlayHashes: partial,
			measured: asMeasured(ids),
			at: AT,
		});
		expect(persistedMutantIds(out)).toEqual([idOf(ids, "over")]);
	});
});

describe("applyMeasuredRun — carrying knowledge forward", () => {
	const hashes = (symbolId: string, symbolHash: string) =>
		new Map([[symbolId, { symbolId, qualifiedName: "fn", symbolHash }]]);

	it("preserves firstSeen for a mutant that was already known", () => {
		// firstSeen is how long a survivor has been tolerated; resetting it on every
		// run would erase the age of every finding.
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] }),
		]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: hashes("s1", "h1"),
			measured: [measured("m1", "s1", "survived")],
			at: "2026-06-06T00:00:00Z",
		});
		expect(out.files[FILE]?.s1?.mutants.m1?.firstSeen).toBe("2026-01-01T00:00:00Z");
	});

	it("stamps firstSeen from this run for a mutant never seen before", () => {
		const base = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1" })]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: hashes("s1", "h1"),
			measured: [measured("m9", "s1", "survived")],
			at: "2026-06-06T00:00:00Z",
		});
		expect(out.files[FILE]?.s1?.mutants.m9?.firstSeen).toBe("2026-06-06T00:00:00Z");
	});

	it("carries an unchanged, unmeasured symbol forward verbatim", () => {
		// Differential runs skip unchanged symbols; dropping them would discard
		// knowledge and make every later run look like a first sighting.
		const prior = sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] });
		const out = applyMeasuredRun({
			base: manifestWith(FILE, [prior]),
			file: FILE,
			overlayHashes: hashes("s1", "h1"),
			measured: [],
			at: "2026-06-06T00:00:00Z",
		});
		expect(out.files[FILE]?.s1).toEqual(prior);
	});

	it("bumps the generation so a refreshed manifest is distinguishable", () => {
		const base = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1" })]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: hashes("s1", "h1"),
			measured: [measured("m1", "s1", "killed")],
			at: "2026-06-06T00:00:00Z",
		});
		expect(out.generation).toBe(base.generation + 1);
	});
});

// ---------------------------------------------------------------------------
// Key-normalization defect (measured 2026-07-31): 17 manifest keys were
// ABSOLUTE paths duplicating an existing repo-relative entry, and 2 keys were
// test files. `normalizeManifestKey` is the ONE choke point that makes both
// impossible at the write boundary; `healManifestFiles` (via `loadManifest`)
// converges an already-corrupted file on disk instead of leaving it broken.
// ---------------------------------------------------------------------------

describe("normalizeManifestKey — the manifest's ONE canonical key", () => {
	const CWD = "/repo/root";

	it("P1: leaves an already-relative path untouched", () => {
		expect(normalizeManifestKey("src/a.ts", CWD)).toBe("src/a.ts");
	});

	it('P2: strips a leading "./"', () => {
		expect(normalizeManifestKey("./src/a.ts", CWD)).toBe("src/a.ts");
	});

	it("P3: converts backslashes to forward slashes", () => {
		expect(normalizeManifestKey("src\\a.ts", CWD)).toBe("src/a.ts");
	});

	it("P4: relativizes an absolute path against cwd", () => {
		expect(normalizeManifestKey("/repo/root/src/a.ts", CWD)).toBe("src/a.ts");
	});

	it("P5: an absolute path, a \"./\"-prefixed path, and a backslash path all collapse to ONE key", () => {
		const keys = new Set([
			normalizeManifestKey("/repo/root/src/a.ts", CWD),
			normalizeManifestKey("./src/a.ts", CWD),
			normalizeManifestKey("src\\a.ts", CWD),
			normalizeManifestKey("src/a.ts", CWD),
		]);
		expect([...keys]).toEqual(["src/a.ts"]);
	});

	// REGRESSION (2026-07-31): the first version of this "canonical" key ran the
	// resolve->relative round-trip only for ABSOLUTE inputs and returned relative
	// ones after string cleanup alone. Measured, one file then produced FIVE keys
	// — the very two-spellings/one-map class this function exists to kill,
	// reintroduced inside the fix. P5 above could not catch it because none of its
	// four spellings contains a redundant segment.
	it("P6: redundant segments in a RELATIVE path collapse — //, /./ and /../", () => {
		expect(normalizeManifestKey("src//a.ts", CWD)).toBe("src/a.ts");
		expect(normalizeManifestKey("src/./a.ts", CWD)).toBe("src/a.ts");
		expect(normalizeManifestKey("src/sub/../a.ts", CWD)).toBe("src/a.ts");
	});

	it("P7: a relative path that walks out of cwd and back resolves to the same key", () => {
		expect(normalizeManifestKey("../root/src/a.ts", CWD)).toBe("src/a.ts");
	});

	it("P8: every spelling of one file yields exactly ONE key", () => {
		const keys = new Set(
			[
				"src/a.ts",
				"./src/a.ts",
				"src//a.ts",
				"src/./a.ts",
				"src/sub/../a.ts",
				"src\\a.ts",
				"/repo/root/src/a.ts",
				"/repo/root/./src/a.ts",
				"../root/src/a.ts",
			].map((s) => normalizeManifestKey(s, CWD)),
		);
		expect([...keys]).toEqual(["src/a.ts"]);
	});

	it("N2: a file genuinely OUTSIDE cwd keeps its distinct escaping key", () => {
		// Canonicalizing must not collapse a real sibling-repo path into the repo.
		expect(normalizeManifestKey("/repo/other/src/a.ts", CWD)).toBe("../other/src/a.ts");
	});

	it("N: is idempotent — normalizing an already-normalized key changes nothing", () => {
		for (const input of ["/repo/root/src/a.ts", "./src/a.ts", "src\\a.ts", "src/a.ts"]) {
			const once = normalizeManifestKey(input, CWD);
			expect(normalizeManifestKey(once, CWD)).toBe(once);
		}
	});

	it("defaults cwd to process.cwd() when omitted", () => {
		const abs = join(process.cwd(), "src/z.ts");
		expect(normalizeManifestKey(abs)).toBe("src/z.ts");
	});
});

describe("applyMeasuredRun — key normalization at the write boundary", () => {
	const AT = "2026-07-31T00:00:00Z";
	const CWD = "/repo/root";

	function runAt(file: string): MutationManifest {
		return applyMeasuredRun({
			base: emptyManifest(META),
			file,
			overlayHashes: overlay([["s1", "h1"]]),
			measured: [measured("m1", "s1", "killed")],
			at: AT,
			cwd: CWD,
		});
	}

	it("P1: an absolute path and its repo-relative twin resolve to the SAME single key", () => {
		const viaAbsolute = runAt("/repo/root/src/a.ts");
		const viaRelative = runAt("src/a.ts");
		expect(Object.keys(viaAbsolute.files)).toEqual(["src/a.ts"]);
		expect(Object.keys(viaRelative.files)).toEqual(["src/a.ts"]);
		expect(viaAbsolute.files["src/a.ts"]).toEqual(viaRelative.files["src/a.ts"]);
	});

	it('P2: a "./"-prefixed path and a backslash path key identically too', () => {
		expect(Object.keys(runAt("./src/a.ts").files)).toEqual(["src/a.ts"]);
		expect(Object.keys(runAt("src\\a.ts").files)).toEqual(["src/a.ts"]);
	});

	it("P3: writing under an absolute key REFRESHES the SAME record a prior relative-keyed write created", () => {
		// The actual bug this closes: a live per-edit gate write (absolute) used to
		// land in a SEPARATE record from a sweep write (relative) for the same file,
		// so the survivor-diff invariant compared an edit against the wrong history.
		const afterSweep = runAt("src/a.ts");
		const afterEdit = applyMeasuredRun({
			base: afterSweep,
			file: "/repo/root/src/a.ts",
			overlayHashes: overlay([["s1", "h1"]]),
			measured: [measured("m1", "s1", "survived")],
			at: AT,
			cwd: CWD,
		});
		expect(Object.keys(afterEdit.files)).toEqual(["src/a.ts"]);
		expect(afterEdit.files["src/a.ts"]?.s1?.mutants.m1?.status).toBe("survived");
	});

	it("N1: rejects a test-file target — throws MutationManifestTestTargetError, nothing is written", () => {
		expect(() =>
			applyMeasuredRun({
				base: emptyManifest(META),
				file: "src/a.test.ts",
				overlayHashes: overlay([["s1", "h1"]]),
				measured: [measured("m1", "s1", "survived")],
				at: AT,
			}),
		).toThrow(MutationManifestTestTargetError);
	});

	it("N2: rejects a test target reached via an absolute path too (normalize-then-check, not check-then-normalize)", () => {
		expect(() =>
			applyMeasuredRun({
				base: emptyManifest(META),
				file: "/repo/root/src/a.test.ts",
				overlayHashes: overlay([["s1", "h1"]]),
				measured: [measured("m1", "s1", "survived")],
				at: AT,
				cwd: CWD,
			}),
		).toThrow(MutationManifestTestTargetError);
	});
});

describe("loadManifest — self-heals an already-corrupted files map", () => {
	let repoRoot: string;
	let dir: string;

	beforeEach(() => {
		repoRoot = mkdtempSync(join(tmpdir(), "mut-heal-"));
		dir = join(repoRoot, ".interlinked");
		mkdirSync(dir, { recursive: true });
	});
	afterEach(() => {
		rmSync(repoRoot, { recursive: true, force: true });
	});

	function writeRaw(files: Record<string, unknown>): void {
		const raw = { ...emptyManifest(META), files };
		writeFileSync(mutationManifestPath(dir), JSON.stringify(raw), "utf-8");
	}

	it("P1: merges an absolute-path record into its repo-relative twin without losing data", () => {
		const absKey = join(repoRoot, "src/a.ts");
		writeRaw({
			[absKey]: { s1: sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] }) },
			"src/a.ts": { s2: sym({ symbolId: "s2", symbolHash: "h2", mutants: [rec("m2", "killed")] }) },
		});
		const healed = loadManifest(dir);
		expect(healed).not.toBeNull();
		const files = healed?.files ?? {};
		expect(Object.keys(files)).toEqual(["src/a.ts"]);
		const merged = files["src/a.ts"] ?? {};
		expect(Object.keys(merged).sort()).toEqual(["s1", "s2"]);
		expect(merged.s1?.mutants.m1?.status).toBe("survived");
		expect(merged.s2?.mutants.m2?.status).toBe("killed");
	});

	it("P2: a same-symbolId conflict keeps the MORE CAUTIOUS status and the EARLIER firstSeen", () => {
		const absKey = join(repoRoot, "src/b.ts");
		const survivedFirst: MutantRecord = { ...rec("m1", "survived"), firstSeen: "2026-01-01T00:00:00Z" };
		const killedLater: MutantRecord = { ...rec("m1", "killed"), firstSeen: "2026-02-01T00:00:00Z" };
		writeRaw({
			[absKey]: { s1: sym({ symbolId: "s1", symbolHash: "h1", mutants: [survivedFirst] }) },
			"src/b.ts": { s1: sym({ symbolId: "s1", symbolHash: "h1", mutants: [killedLater] }) },
		});
		const healed = loadManifest(dir);
		const m1 = healed?.files["src/b.ts"]?.s1?.mutants.m1;
		// A merge must never silently clear a survivor one of the two copies
		// recorded — that would read as the ratchet auto-resolving itself without
		// a real new measurement.
		expect(m1?.status).toBe("survived");
		// firstSeen is the true first sighting, independent of which side's status
		// won — always the earlier of the two.
		expect(m1?.firstSeen).toBe("2026-01-01T00:00:00Z");
	});

	it("P3: a reviewed disposition on either side always wins the status conflict", () => {
		const absKey = join(repoRoot, "src/c.ts");
		const reviewed: MutantRecord = {
			...rec("m1", "equivalent"),
			accepted_reason: "poll loop only branches on ready/gone",
		};
		const unreviewedSurvived: MutantRecord = rec("m1", "survived");
		writeRaw({
			[absKey]: { s1: sym({ symbolId: "s1", symbolHash: "h1", mutants: [reviewed] }) },
			"src/c.ts": { s1: sym({ symbolId: "s1", symbolHash: "h1", mutants: [unreviewedSurvived] }) },
		});
		const healed = loadManifest(dir);
		const m1 = healed?.files["src/c.ts"]?.s1?.mutants.m1;
		expect(m1?.status).toBe("equivalent");
		expect(m1?.accepted_reason).toContain("ready/gone");
	});

	it("N: drops a test-file record entirely, keeping the other files intact", () => {
		writeRaw({
			"src/a.test.ts": { s1: sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] }) },
			"src/a.ts": { s2: sym({ symbolId: "s2", symbolHash: "h2" }) },
		});
		const healed = loadManifest(dir);
		expect(Object.keys(healed?.files ?? {})).toEqual(["src/a.ts"]);
	});

	it("N: a test-file record that ALSO collides with an absolute duplicate is still dropped", () => {
		const absTestKey = join(repoRoot, "src/a.test.ts");
		writeRaw({
			[absTestKey]: { s1: sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] }) },
			"src/a.test.ts": { s1: sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] }) },
			"src/a.ts": { s2: sym({ symbolId: "s2", symbolHash: "h2" }) },
		});
		const healed = loadManifest(dir);
		expect(Object.keys(healed?.files ?? {})).toEqual(["src/a.ts"]);
	});

	it("a manifest with no duplicates and no test files heals to an equivalent shape", () => {
		writeRaw({
			"src/a.ts": { s1: sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "killed")] }) },
		});
		const healed = loadManifest(dir);
		expect(healed?.files["src/a.ts"]?.s1?.symbolHash).toBe("h1");
	});
});


describe("mutation provenance defaults and move review fidelity", () => {
    it("uses the process workspace consistently when provenance callers omit cwd", () => {
        const base = emptyManifest(META);
        const provenance = { at: "2026-09-08", scope: "import_graph" as const, testCount: 12, surface: "measure" as const };
        const stamped = stampProvenance({ manifest: base, file: join(process.cwd(), FILE), provenance });
        expect(provenanceOf(stamped, FILE)).toEqual(provenance);
        expect(base.fileProvenance).toBeUndefined();
    });

    it("carries a structured review without inventing legacy reason text and ignores stale move hints", () => {
        const prior = { ...rec("old", "equivalent"), disposition: { kind: "proved_equivalent", evidence: "review-123" } };
        const base = manifestWith(FILE, [sym({ symbolId: "before", symbolHash: "old-hash", mutants: [prior] })]);
        const next = applyMeasuredRun({ base, file: FILE, overlayHashes: overlay([["after", "new-hash"]]),
            measured: [measured("new", "after", "survived"), measured("fresh", "after", "killed")], at: "2026-09-08",
            moves: [{ previousMutantId: "old", currentMutantId: "new" }, { previousMutantId: "absent", currentMutantId: "fresh" }],
        });
        expect(next.files[FILE]?.after?.mutants.new).toMatchObject({ status: "equivalent", firstSeen: prior.firstSeen, disposition: prior.disposition });
        expect(next.files[FILE]?.after?.mutants.new?.accepted_reason).toBeUndefined();
        expect(next.files[FILE]?.after?.mutants.fresh).toMatchObject({ status: "killed", firstSeen: "2026-09-08" });
        expect(next.files[FILE]?.after?.mutants.fresh?.disposition).toBeUndefined();
    });
});


it("directs recovery toward the damaged manifest rather than fresh adoption", () => {
    const message = corruptManifestMessage("/repo/.interlinked", "invalid files shape");
    expect(message).toContain("/repo/.interlinked/mutation-manifest.json");
    expect(message).toContain("CORRUPT (invalid files shape)");
    expect(message).toContain('not "missing"');
    expect(message).toContain("preserved for recovery");
});
