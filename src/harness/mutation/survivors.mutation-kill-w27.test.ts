import { describe, expect, it } from "vitest";
import { restrictToFiles, type SurvivorFilter, summarizeSurvivors } from "./survivors.js";
import type { MutantRecord, MutantStatus, MutationManifest, SymbolRecord } from "./types.js";

// ===========================================
// Wave-27 survivor kills — src/harness/mutation/survivors.ts
// Fixture builders mirror survivors.test.ts exactly (kept local so this file
// has no cross-file coupling); a separate `seq` counter avoids id collisions
// with the companion file when both run in the same worker.
// ===========================================

let seq = 0;
function mutant(status: MutantStatus, over: Partial<MutantRecord> = {}): MutantRecord {
	seq += 1;
	return {
		mutantId: `w27-m${seq}`,
		siteId: `w27-s${seq}`,
		mutator: "EqualityOperator",
		originalLexeme: "===",
		replacement: "!==",
		ordinalWithinSymbol: 0,
		status,
		firstSeen: "2026-08-01T00:00:00.000Z",
		...over,
	};
}

function symbol(name: string, mutants: MutantRecord[], over: Partial<SymbolRecord> = {}): SymbolRecord {
	return {
		symbolId: `w27-sym-${name}`,
		qualifiedName: name,
		symbolHash: "hash",
		mutants: Object.fromEntries(mutants.map((m) => [m.mutantId, m])),
		instability: { events: [], consecutiveStableRuns: 3, quarantined: false },
		...over,
	};
}

function manifestOf(files: Record<string, SymbolRecord[]>): MutationManifest {
	return {
		version: 1,
		generation: 7,
		authoritativeAt: "2026-08-09T00:00:00.000Z",
		engine: "stryker",
		engineVersion: "8",
		dependencyGraphVersion: "1",
		environmentHash: "env",
		files: Object.fromEntries(
			Object.entries(files).map(([file, syms]) => [file, Object.fromEntries(syms.map((s) => [s.symbolId, s]))]),
		),
	};
}

function summarize(files: Record<string, SymbolRecord[]>, filter: SurvivorFilter = {}) {
	return summarizeSurvivors(manifestOf(files), filter);
}

describe("matches — filter string equality boundary", () => {
	// test-contract: invariant — an arbitrary literal filter string that matches
	// nothing must exclude every file (kills the StringLiteral "" -> "Stryker
	// was here!" mutant: that mutant would make `matches` return true whenever
	// the caller's needle happens to equal the literal "Stryker was here!").
	it("P: a filter string equal to the engine's canary literal still excludes non-matching files", () => {
		const s = summarize({ "src/a.ts": [symbol("f", [mutant("survived")])] }, { file: "Stryker was here!" });
		expect(s.files).toEqual([]);
	});
});

describe("tally — non-terminal statuses never fold into open work", () => {
	// test-contract: invariant — kills `record.status === "survived"` -> `true`.
	// `equivalent`/`indeterminate` are neither killed/timeout/uncovered/survived;
	// forcing the last branch true would wrongly count them as an open survivor.
	it("P: an indeterminate-status mutant contributes to the mutant count but not to open/dispositioned/uncovered", () => {
		const s = summarize({ "src/a.ts": [symbol("f", [mutant("indeterminate")])] });
		expect(s.totals.mutants).toBe(1);
		expect(s.totals.open).toBe(0);
		expect(s.totals.dispositioned).toBe(0);
		expect(s.totals.uncovered).toBe(0);
	});
});

describe("addCounts — per-file rollup sums, does not subtract", () => {
	// test-contract: invariant — kills the three `+=` -> `-=` mutants on
	// dispositioned/timeout/uncovered. Two symbols each contributing 1 makes a
	// sign flip observable (2 vs -2), whereas a single contribution would leave
	// -1 vs 1 which is also observable but this is the more direct multi-symbol
	// exercise of the actual fold.
	it("P: two symbols in one file sum their dispositioned/timeout/uncovered counts, not subtract them", () => {
		const s = summarize({
			"src/a.ts": [
				symbol("s1", [
					mutant("survived", { disposition: { kind: "dead_code", resolution: "delete" } }),
					mutant("timeout"),
					mutant("uncovered"),
				]),
				symbol("s2", [
					mutant("survived", { disposition: { kind: "dead_code", resolution: "delete" } }),
					mutant("timeout"),
					mutant("uncovered"),
				]),
			],
		});
		expect(s.totals.dispositioned).toBe(2);
		expect(s.totals.timeout).toBe(2);
		expect(s.totals.uncovered).toBe(2);
	});
});

describe("scanSymbol — includeDispositioned never resurrects a killed record", () => {
	// test-contract: invariant — kills `record.status !== "survived"` -> `false`.
	// A killed record must never appear in the rows list even when
	// includeDispositioned is true.
	it("P: a killed mutant stays absent from the rows even under includeDispositioned", () => {
		const s = summarize({ "src/a.ts": [symbol("f", [mutant("killed")])] }, { includeDispositioned: true });
		expect(s.mutants).toEqual([]);
	});
});

describe("symbolRow — quarantined flag survives a missing instability record", () => {
	// test-contract: invariant — kills both `symbol.instability?.quarantined ===
	// true` -> `true` (always-quarantined) and the OptionalChaining removal
	// (which would throw on a symbol with no `instability` field).
	it("P: a symbol with no instability field reports quarantined:false without throwing", () => {
		const bare = symbol("f", [mutant("survived")]);
		// SAFETY: deliberately building a runtime shape the type forbids (a
		// SymbolRecord missing `instability`) to exercise the manifest-loaded-
		// from-disk path, where the field may genuinely be absent at runtime.
		const { instability: _drop, ...rest } = bare;
		// SAFETY: this intentionally incomplete legacy record tests the reader's missing-instability compatibility path.
		const withoutInstability = rest as unknown as SymbolRecord;
		const m = manifestOf({});
		m.files["src/a.ts"] = { [withoutInstability.symbolId]: withoutInstability };
		expect(() => summarizeSurvivors(m)).not.toThrow();
		const s = summarizeSurvivors(m);
		expect(s.symbols[0]?.quarantined).toBe(false);
	});
});

describe("byWorkThenScore — open count outranks score, not the reverse", () => {
	// test-contract: invariant — kills `b.open !== a.open` -> `false`. Scores are
	// deliberately set so the score-only tiebreak would pick the OPPOSITE file
	// from the open-count ranking.
	it("P: a file with more open survivors ranks first even though its score is better", () => {
		const s = summarize({
			"src/many-open.ts": [
				symbol("f", [
					mutant("survived"),
					mutant("survived"),
					mutant("killed"),
					mutant("killed"),
					mutant("killed"),
					mutant("killed"),
					mutant("killed"),
					mutant("killed"),
					mutant("killed"),
					mutant("killed"),
				]),
			],
			"src/few-open.ts": [symbol("g", [mutant("survived")])],
		});
		expect(s.files.map((f) => f.file)).toEqual(["src/many-open.ts", "src/few-open.ts"]);
	});
});

describe("rankSymbols — the sort actually runs", () => {
	// test-contract: invariant — kills the `.sort(...)` -> `rows` (no-op) mutant
	// and the arrow body -> `{}` mutant: insertion order is the reverse of the
	// correct open-count order.
	it("P: symbols rank by open count even when inserted in the opposite order", () => {
		const s = summarize({
			"src/x.ts": [
				symbol("b-sym", [mutant("survived")]),
				symbol("a-sym", [mutant("survived"), mutant("survived"), mutant("survived")]),
			],
		});
		expect(s.symbols.map((r) => r.qualifiedName)).toEqual(["a-sym", "b-sym"]);
	});

	// test-contract: invariant — kills `b.open !== a.open` -> `true` and
	// `!== -> ===` on the SAME expression: opens are tied, uncovered differs,
	// and insertion order is the reverse of the correct uncovered-desc tiebreak.
	it("P: equal-open symbols tie-break by uncovered count, not insertion order", () => {
		const s = summarize({
			"src/x.ts": [
				symbol("low-uncov", [mutant("survived"), mutant("killed")]),
				symbol("high-uncov", [mutant("survived"), mutant("uncovered"), mutant("uncovered")]),
			],
		});
		expect(s.symbols.map((r) => r.qualifiedName)).toEqual(["high-uncov", "low-uncov"]);
	});

	// test-contract: invariant — kills `b.open !== a.open` -> `false`: open
	// counts genuinely differ but the symbol with FEWER open survivors has MORE
	// uncovered, so falling through to the uncovered tiebreak gives the wrong
	// answer.
	it("P: symbol ranking respects open-count first even when the loser has more uncovered", () => {
		const s = summarize({
			"src/x.ts": [
				symbol("sym-more-open", [mutant("survived"), mutant("survived"), mutant("survived")]),
				symbol("sym-less-open-more-uncov", [
					mutant("survived"),
					mutant("uncovered"),
					mutant("uncovered"),
					mutant("uncovered"),
					mutant("uncovered"),
					mutant("uncovered"),
				]),
			],
		});
		expect(s.symbols.map((r) => r.qualifiedName)).toEqual(["sym-more-open", "sym-less-open-more-uncov"]);
	});

	// test-contract: invariant — kills the ArithmeticOperator `b.open - a.open`
	// -> `b.open + a.open` mutant. Non-negative open counts make the mutated sum
	// always positive, forcing a spurious swap; insertion order here already
	// matches the correct answer so the swap is observable.
	it("P: symbol ranking's open comparator subtracts, not adds", () => {
		const s = summarize({
			"src/x.ts": [
				symbol("high-open", [
					mutant("survived"),
					mutant("survived"),
					mutant("survived"),
					mutant("survived"),
					mutant("survived"),
				]),
				symbol("low-open", [mutant("survived")]),
			],
		});
		expect(s.symbols.map((r) => r.qualifiedName)).toEqual(["high-open", "low-open"]);
	});

	// test-contract: invariant — kills `b.uncovered !== a.uncovered` -> `true`
	// and the StringLiteral emptying of the `a.file:a.qualifiedName` template.
	// Opens and uncovered are BOTH tied, so only the path fallback can produce
	// the correct order; insertion order is reversed from it.
	it("P: symbols tied on open and uncovered fall back to file:qualifiedName order", () => {
		const s = summarize({
			"src/x.ts": [symbol("zebra", [mutant("survived")]), symbol("apple", [mutant("survived")])],
		});
		expect(s.symbols.map((r) => r.qualifiedName)).toEqual(["apple", "zebra"]);
	});

	// test-contract: invariant — kills the StringLiteral emptying of the
	// `b.file:b.qualifiedName` template. Same tie shape as above but with
	// insertion order ALREADY correct, which only this specific mutant flips.
	it("P: the file:qualifiedName fallback uses both sides of the comparison, not just one", () => {
		const s = summarize({
			"src/x.ts": [symbol("apple", [mutant("survived")]), symbol("zebra", [mutant("survived")])],
		});
		expect(s.symbols.map((r) => r.qualifiedName)).toEqual(["apple", "zebra"]);
	});

	// test-contract: invariant — kills `b.uncovered !== a.uncovered` -> `false`
	// and `!== -> ===` on the SAME expression: open counts are tied, uncovered
	// genuinely differs, and insertion order is reversed from the correct
	// uncovered-desc order.
	it("P: equal-open symbols use uncovered as the tiebreak even against alphabetical order", () => {
		const s = summarize({
			"src/x.ts": [
				symbol("low", [mutant("survived")]),
				symbol("zzhigh", [
					mutant("survived"),
					mutant("uncovered"),
					mutant("uncovered"),
					mutant("uncovered"),
					mutant("uncovered"),
					mutant("uncovered"),
				]),
			],
		});
		expect(s.symbols.map((r) => r.qualifiedName)).toEqual(["zzhigh", "low"]);
	});
});

describe("mutatorRows — the per-mutator rollup actually sorts", () => {
	// test-contract: invariant — kills the ArrayDeclaration `[]` -> `["Stryker
	// was here"]` mutant: when no mutator matches the filter, the rollup must be
	// empty, not carry a phantom entry.
	it("P: no matching mutator yields an empty rollup, not a stray placeholder row", () => {
		const s = summarize(
			{ "src/a.ts": [symbol("f", [mutant("survived", { mutator: "EqualityOperator" })])] },
			{ mutator: "NoSuchMutatorXYZ" },
		);
		expect(s.mutators).toEqual([]);
	});

	// test-contract: invariant — kills the `.sort(...)` -> `rows` (no-op), the
	// arrow body -> `false`, and the whole arrow -> `() => undefined` mutants:
	// first-seen (insertion) order is the reverse of the correct open-desc order.
	it("P: mutators rank by open count even when first seen in the opposite order", () => {
		const s = summarize({
			"src/a.ts": [
				symbol("f", [
					mutant("survived", { mutator: "ZetaOperator" }),
					mutant("survived", { mutator: "AlphaOperator" }),
					mutant("survived", { mutator: "AlphaOperator" }),
					mutant("survived", { mutator: "AlphaOperator" }),
				]),
			],
		});
		expect(s.mutators.map((m) => m.mutator)).toEqual(["AlphaOperator", "ZetaOperator"]);
	});

	// test-contract: invariant — kills the whole-condition -> `true` and the
	// ArithmeticOperator `-` -> `+` mutants: first-seen order already matches
	// the correct answer, so a forced-positive comparator (always-true, or a
	// sum of two non-negative counts) forces a spurious swap.
	it("P: mutator ranking's comparator does not force a swap when order is already correct", () => {
		const s = summarize({
			"src/a.ts": [
				symbol("f", [
					mutant("survived", { mutator: "AlphaOperator" }),
					mutant("survived", { mutator: "AlphaOperator" }),
					mutant("survived", { mutator: "AlphaOperator" }),
					mutant("survived", { mutator: "ZetaOperator" }),
				]),
			],
		});
		expect(s.mutators.map((m) => m.mutator)).toEqual(["AlphaOperator", "ZetaOperator"]);
	});

	// test-contract: invariant — kills the LogicalOperator `||` -> `&&` mutant:
	// open counts genuinely differ (deciding the order on their own) while the
	// mutator NAMES compare in the opposite direction, so deferring to the name
	// comparison (as `&&` would) gives the wrong answer.
	it("P: mutator ranking does not defer to name order when open counts genuinely differ", () => {
		const s = summarize({
			"src/a.ts": [
				symbol("f", [
					mutant("survived", { mutator: "AlphaOperator" }),
					mutant("survived", { mutator: "ZetaOperator" }),
					mutant("survived", { mutator: "ZetaOperator" }),
					mutant("survived", { mutator: "ZetaOperator" }),
				]),
			],
		});
		expect(s.mutators.map((m) => m.mutator)).toEqual(["ZetaOperator", "AlphaOperator"]);
	});
});

describe("scanFile — the `undetected` gate that decides which symbols are listed", () => {
	// test-contract: invariant — kills the ArithmeticOperator
	// `+ scan.counts.uncovered` -> `- scan.counts.uncovered` mutant: a symbol
	// whose ONLY debt is uncovered mutants (open=0, dispositioned=0) must still
	// be listed as work.
	it("P: a symbol whose only debt is uncovered mutants still counts as open work", () => {
		const s = summarize({ "src/a.ts": [symbol("only-uncovered", [mutant("uncovered"), mutant("uncovered")])] });
		expect(s.symbols.map((r) => r.qualifiedName)).toEqual(["only-uncovered"]);
		expect(s.symbols[0]?.uncovered).toBe(2);
	});

	// test-contract: invariant — kills the ArithmeticOperator
	// `open + dispositioned` -> `open - dispositioned` mutant: open=1 and
	// dispositioned=1 cancel under subtraction (giving 0, hiding the symbol)
	// but must not under addition.
	it("P: a symbol with both an open and a dispositioned survivor is still counted as work", () => {
		const s = summarize({
			"src/a.ts": [
				symbol("mixed", [
					mutant("survived"),
					mutant("survived", { disposition: { kind: "dead_code", resolution: "delete" } }),
				]),
			],
		});
		expect(s.symbols.map((r) => r.qualifiedName)).toEqual(["mixed"]);
		expect(s.symbols[0]).toMatchObject({ open: 1, dispositioned: 1 });
	});
});

describe("summarizeSurvivors — the flat mutants list actually sorts", () => {
	// test-contract: invariant — kills the `.sort(...)` -> `mutants` (no-op),
	// the arrow -> `() => undefined`, and the whole-condition -> `false`
	// mutants: file insertion order is the reverse of alphabetical.
	it("P: the flat mutants list is sorted by file, not left in insertion order", () => {
		const s = summarize({
			"src/zeta.ts": [symbol("z", [mutant("survived")])],
			"src/alpha.ts": [symbol("a", [mutant("survived")])],
		});
		expect(s.mutants.map((m) => m.file)).toEqual(["src/alpha.ts", "src/zeta.ts"]);
	});

	// test-contract: invariant — kills the whole-condition -> `true` mutant:
	// file insertion order is ALREADY correct, so a forced-positive comparator
	// forces a spurious swap that only this mutant produces.
	it("P: the flat mutants list's comparator does not force a swap when order is already correct", () => {
		const s = summarize({
			"src/alpha.ts": [symbol("a", [mutant("survived")])],
			"src/zeta.ts": [symbol("z", [mutant("survived")])],
		});
		expect(s.mutants.map((m) => m.file)).toEqual(["src/alpha.ts", "src/zeta.ts"]);
	});

	// test-contract: invariant — kills the LogicalOperator `||` -> `&&` mutant:
	// file names decide the order on their own while the qualifiedNames compare
	// in the opposite direction, exposing a wrongful defer to the second term.
	it("P: the flat mutants list's file comparison wins even when qualifiedName disagrees", () => {
		const s = summarize({
			"src/zeta.ts": [symbol("aaa", [mutant("survived")])],
			"src/alpha.ts": [symbol("zzz", [mutant("survived")])],
		});
		expect(s.mutants.map((m) => `${m.file}:${m.qualifiedName}`)).toEqual([
			"src/alpha.ts:zzz",
			"src/zeta.ts:aaa",
		]);
	});
});

describe("restrictToFiles — recomputed totals sum correctly", () => {
	// test-contract: invariant — kills the three `+=` -> `-=` mutants on
	// dispositioned/uncovered/timeout AND the `staleFiles += 1` -> `-= 1` /
	// `f.stale` -> `false` mutants, all in one pass over two kept files (one
	// of them stale).
	it("P: restrictToFiles sums dispositioned/uncovered/timeout and staleFiles across kept files", () => {
		const m = manifestOf({
			"src/a.ts": [
				symbol("f", [
					mutant("survived", { disposition: { kind: "dead_code", resolution: "delete" } }),
					mutant("uncovered"),
					mutant("timeout"),
				]),
			],
			"src/b.ts": [
				symbol("g", [
					mutant("survived", { disposition: { kind: "dead_code", resolution: "delete" } }),
					mutant("uncovered"),
					mutant("timeout"),
				]),
			],
		});
		const summary = summarizeSurvivors(m, { exists: (f) => f !== "src/a.ts" });
		const kept = restrictToFiles(summary, new Set(["src/a.ts", "src/b.ts"]));
		expect(kept.totals.dispositioned).toBe(2);
		expect(kept.totals.uncovered).toBe(2);
		expect(kept.totals.timeout).toBe(2);
		expect(kept.totals.staleFiles).toBe(1);
	});

	// test-contract: invariant — kills the two ArrowFunction -> `() => undefined`
	// mutants on the symbols/mutants filters: `.every()` on an accidentally
	// emptied array is vacuously true, so this asserts non-empty content.
	it("P: restrictToFiles keeps the actual symbol/mutant rows for kept files, not an empty list", () => {
		const files = {
			"src/a.ts": [symbol("f", [mutant("survived"), mutant("killed")])],
			"src/b.ts": [symbol("g", [mutant("survived"), mutant("survived"), mutant("killed")])],
		};
		const kept = restrictToFiles(summarize(files), new Set(["src/a.ts"]));
		expect(kept.symbols).toHaveLength(1);
		expect(kept.symbols[0]?.file).toBe("src/a.ts");
		expect(kept.mutants).toHaveLength(1);
		expect(kept.mutants[0]?.file).toBe("src/a.ts");
	});
});

describe("collectMutators — the --mutator filter narrows the rollup itself", () => {
	// test-contract: invariant — kills `!matches(record.mutator, filter.mutator)`
	// -> `false`: with the guard disabled every mutator would be bumped into
	// the rollup regardless of the filter.
	it("P: the --mutator filter also narrows the mutator rollup, not just totals/mutants", () => {
		const s = summarize(
			{
				"src/a.ts": [
					symbol("f", [
						mutant("survived", { mutator: "KeepMeOperator" }),
						mutant("survived", { mutator: "DropMeOperator" }),
					]),
				],
			},
			{ mutator: "KeepMe" },
		);
		expect(s.mutators.map((m) => m.mutator)).toEqual(["KeepMeOperator"]);
	});
});
