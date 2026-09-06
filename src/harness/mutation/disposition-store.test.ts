import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SurvivorDisposition } from "./disposition.js";
import {
	type DispositionLedger,
	type DispositionRecord,
	isLive,
	loadLedger,
	makeRecord,
	refuseRecord,
	saveLedger,
	suppressionLevel,
	upsertRecord,
	withDispositions,
} from "./disposition-store.js";
import { applyMeasuredRun, clearManifestCache } from "./manifest.js";
import type { MutationManifest } from "./types.js";

const NOW = () => "2026-08-15T00:00:00.000Z";

function baseManifest(overrides: Partial<MutationManifest> = {}): MutationManifest {
	return {
		version: 1,
		generation: 1,
		authoritativeAt: "2026-08-15T00:00:00.000Z",
		engine: "stryker",
		engineVersion: "8",
		dependencyGraphVersion: "dg1",
		environmentHash: "env1",
		files: {
			"src/a.ts": {
				s1: {
					symbolId: "s1",
					qualifiedName: "fn",
					symbolHash: "h",
					instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
					mutants: {
						m1: {
							mutantId: "m1",
							siteId: "site1",
							mutator: "BooleanLiteral",
							originalLexeme: "true",
							replacement: "false",
							ordinalWithinSymbol: 0,
							status: "survived",
							firstSeen: "2026-08-01T00:00:00.000Z",
						},
					},
				},
			},
		},
		...overrides,
	};
}

function deadCodeRecord(over: Partial<DispositionRecord> = {}): DispositionRecord {
	return {
		file: "src/a.ts",
		symbolId: "s1",
		mutantId: "m1",
		symbolHash: "h",
		qualifiedName: "fn",
		mutator: "BooleanLiteral",
		disposition: { kind: "dead_code", resolution: "delete" },
		complexity_delta: null,
		recordedAt: NOW(),
		recordedBy: "test",
		...over,
	};
}

function emptyLedger(): DispositionLedger {
	return { version: 1, note: "", environmentHash: "", dependencyGraphVersion: "", records: [] };
}

// ===========================================================================
describe("suppressionLevel — the gaming-relevant axis", () => {
	it("P1: dead_code / duplicate / accepted_risk / proved_unreachable / outside_contract are level 1", () => {
		expect(suppressionLevel({ kind: "dead_code", resolution: "delete" })).toBe(1);
		expect(suppressionLevel({ kind: "duplicate", representativeMutantId: "x", certificate: {} as never })).toBe(1);
	});
	it("N1: unresolved suppresses nothing (level 0)", () => {
		expect(suppressionLevel({ kind: "unresolved" })).toBe(0);
		expect(suppressionLevel({ kind: "killed" })).toBe(0);
	});
	it("P2: proved_equivalent is the only level-2 kind", () => {
		expect(suppressionLevel({ kind: "proved_equivalent", method: {} as never, certificate: {} as never })).toBe(2);
	});
});

describe("refuseRecord — store-level rules, each closing a §1 hole", () => {
	it("P1: a bare unresolved (no evidence) is refused", () => {
		expect(refuseRecord(deadCodeRecord({ disposition: { kind: "unresolved" } }))).toMatch(/bare `unresolved`/);
	});
	it("P2: killed is refused (not a judgment)", () => {
		expect(refuseRecord(deadCodeRecord({ disposition: { kind: "killed" } }))).toMatch(/killed/);
	});
	it("P3: proved_equivalent is refused (goes through mutation accept, and is not durable in M0)", () => {
		const disposition = { kind: "proved_equivalent", method: {}, certificate: {} } as unknown as SurvivorDisposition;
		expect(refuseRecord(deadCodeRecord({ disposition }))).toMatch(/mutation accept/);
	});
	it("N1: an unresolved WITH evidence is accepted", () => {
		const disposition: SurvivorDisposition = {
			kind: "unresolved",
			evidence: { strategy: "fuzz", runs: 10, seed: "s", budgetMs: 100, searchedAt: NOW() },
		};
		expect(refuseRecord(deadCodeRecord({ disposition }))).toBeNull();
	});
	it("N2: a dead_code with a resolution is accepted", () => {
		expect(refuseRecord(deadCodeRecord())).toBeNull();
	});
});

describe("isLive — symbolHash invalidation", () => {
	it("P1: a matching symbolHash is live", () => {
		expect(isLive(deadCodeRecord(), baseManifest())).toBe(true);
	});
	it("N1: a changed symbolHash is stale (the whole point — the code moved under the judgment)", () => {
		expect(isLive(deadCodeRecord({ symbolHash: "different" }), baseManifest())).toBe(false);
	});
	it("N2: a symbol the manifest no longer holds is stale", () => {
		expect(isLive(deadCodeRecord({ symbolId: "gone" }), baseManifest())).toBe(false);
	});
	it("N3: a file the manifest no longer holds is stale", () => {
		expect(isLive(deadCodeRecord({ file: "src/gone.ts" }), baseManifest())).toBe(false);
	});
});

describe("makeRecord — the invalidation key comes from the manifest, never a flag", () => {
	it("P1: resolves symbolId / symbolHash / qualifiedName / mutator from the manifest; complexity_delta null", () => {
		const record = makeRecord({
			manifest: baseManifest(),
			file: "src/a.ts",
			mutantId: "m1",
			disposition: { kind: "dead_code", resolution: "delete" },
			recordedBy: "test",
			now: NOW,
		});
		expect(record).toEqual({
			file: "src/a.ts",
			symbolId: "s1",
			mutantId: "m1",
			symbolHash: "h",
			qualifiedName: "fn",
			mutator: "BooleanLiteral",
			disposition: { kind: "dead_code", resolution: "delete" },
			complexity_delta: null,
			recordedAt: NOW(),
			recordedBy: "test",
		});
	});
	it("N1: a mutant the manifest never measured yields null (a disposition for it would be a typo)", () => {
		const record = makeRecord({
			manifest: baseManifest(),
			file: "src/a.ts",
			mutantId: "nope",
			disposition: { kind: "dead_code", resolution: "delete" },
			recordedBy: "test",
			now: NOW,
		});
		expect(record).toBeNull();
	});
});

describe("upsertRecord — pure, keyed, refusal-gated", () => {
	it("P1: inserts a record", () => {
		const next = upsertRecord({ ledger: emptyLedger(), record: deadCodeRecord() });
		expect(next?.records).toHaveLength(1);
	});
	it("P2: replaces the record with the same (file, symbolId, mutantId) key rather than duplicating", () => {
		const first = upsertRecord({ ledger: emptyLedger(), record: deadCodeRecord({ recordedBy: "a" }) });
		const second = upsertRecord({ ledger: first as DispositionLedger, record: deadCodeRecord({ recordedBy: "b" }) });
		expect(second?.records).toHaveLength(1);
		expect(second?.records[0]?.recordedBy).toBe("b");
	});
	it("N1: a refused record (bare unresolved) returns null", () => {
		const next = upsertRecord({ ledger: emptyLedger(), record: deadCodeRecord({ disposition: { kind: "unresolved" } }) });
		expect(next).toBeNull();
	});
});

describe("withDispositions — apply live, suppressing records onto a manifest copy", () => {
	it("P1: a live level-1 record is applied (survivor leaves the work-list)", () => {
		const ledger = upsertRecord({ ledger: emptyLedger(), record: deadCodeRecord() }) as DispositionLedger;
		const out = withDispositions(baseManifest(), ledger);
		expect(out.files["src/a.ts"]?.s1?.mutants.m1?.disposition).toEqual({ kind: "dead_code", resolution: "delete" });
	});
	it("N1: a level-0 unresolved record is NOT applied — the evidence survivor stays open (§1.5.1)", () => {
		const disposition: SurvivorDisposition = {
			kind: "unresolved",
			evidence: { strategy: "fuzz", runs: 10, seed: "s", budgetMs: 100, searchedAt: NOW() },
		};
		const ledger: DispositionLedger = { ...emptyLedger(), records: [deadCodeRecord({ disposition })] };
		const out = withDispositions(baseManifest(), ledger);
		expect(out.files["src/a.ts"]?.s1?.mutants.m1?.disposition).toBeUndefined();
	});
	it("N2: a stale record (changed symbolHash) is NOT applied", () => {
		const ledger: DispositionLedger = { ...emptyLedger(), records: [deadCodeRecord({ symbolHash: "old" })] };
		const out = withDispositions(baseManifest(), ledger);
		expect(out.files["src/a.ts"]?.s1?.mutants.m1?.disposition).toBeUndefined();
	});
	it("N3: the input manifest is never mutated (copy-on-write)", () => {
		const manifest = baseManifest();
		const ledger = upsertRecord({ ledger: emptyLedger(), record: deadCodeRecord() }) as DispositionLedger;
		withDispositions(manifest, ledger);
		expect(manifest.files["src/a.ts"]?.s1?.mutants.m1?.disposition).toBeUndefined();
	});
	it("N4: an empty ledger short-circuits to the SAME manifest object (no 37MB copy)", () => {
		const manifest = baseManifest();
		expect(withDispositions(manifest, emptyLedger())).toBe(manifest);
	});
});

// ===========================================================================
// Persistence round-trip + the M0 headline: a re-measure does NOT wipe a record.
// ===========================================================================
describe("ledger persistence + durability regression", () => {
	let configDir: string;
	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "disposition-store-"));
		mkdirSync(configDir, { recursive: true });
	});
	afterEach(() => {
		rmSync(configDir, { recursive: true, force: true });
		clearManifestCache();
	});

	it("P1: an absent ledger loads as the honest empty state", () => {
		expect(loadLedger(configDir).records).toHaveLength(0);
	});

	it("P2: save → load round-trips a record verbatim", () => {
		const ledger = upsertRecord({ ledger: emptyLedger(), record: deadCodeRecord({ complexity_delta: 3 }) }) as DispositionLedger;
		saveLedger(configDir, ledger);
		const back = loadLedger(configDir);
		expect(back.records).toHaveLength(1);
		expect(back.records[0]).toEqual(deadCodeRecord({ complexity_delta: 3 }));
	});

	it("N1: loadLedger drops a malformed record rather than crashing", () => {
		const ledger: DispositionLedger = {
			...emptyLedger(),
			// This deliberately malformed row exercises on-disk validation.
			records: [deadCodeRecord(), { file: "x" } as any],
		};
		saveLedger(configDir, ledger);
		expect(loadLedger(configDir).records).toHaveLength(1);
	});

	it("N2: loadLedger returns the honest empty ledger when the file on disk is not valid JSON", () => {
		writeFileSync(join(configDir, "mutation-dispositions.json"), "{ this is not json", "utf-8");
		const loaded = loadLedger(configDir);
		// The corrupt-JSON path must recover to the SAME honest-empty shape as
		// an absent file (version 1, no records, blank identity fields) rather
		// than propagating the JSON.parse exception.
		expect(loaded.version).toBe(1);
		expect(loaded.records).toEqual([]);
		expect(loaded.environmentHash).toBe("");
		expect(loaded.dependencyGraphVersion).toBe("");
	});

	it("P3: a re-measure over the same symbol does NOT wipe the record — the ledger is durable (plan 18 §1.3)", () => {
		// Record a dead_code judgment against m1, persisted to the ledger.
		const ledger = upsertRecord({ ledger: emptyLedger(), record: deadCodeRecord() }) as DispositionLedger;

		// Simulate the exact operation that DESTROYED a manifest-stored disposition:
		// applyMeasuredRun rebuilds every MutantRecord with the SAME unchanged symbolHash.
		const refreshed = applyMeasuredRun({
			base: baseManifest(),
			file: "src/a.ts",
			overlayHashes: new Map([["s1", { qualifiedName: "fn", symbolHash: "h" }]]),
			measured: [
				{
					identity: {
						mutantId: "m1",
						siteId: "site1",
						symbolId: "s1",
						qualifiedName: "fn",
						mutator: "BooleanLiteral",
						originalLexeme: "true",
						replacement: "false",
						ordinalWithinSymbol: 0,
					},
					status: "survived",
				},
			],
			at: "2026-08-15T01:00:00.000Z",
		});
		// The manifest itself carries NO disposition after the refresh (that is the bug).
		expect(refreshed.files["src/a.ts"]?.s1?.mutants.m1?.disposition).toBeUndefined();

		// But the ledger record still binds (symbolHash unchanged), so the join re-applies it.
		const joined = withDispositions(refreshed, ledger);
		expect(joined.files["src/a.ts"]?.s1?.mutants.m1?.disposition).toEqual({ kind: "dead_code", resolution: "delete" });
	});
});
