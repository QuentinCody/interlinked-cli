import { describe, expect, it } from "vitest";
import type {
	SurvivorFileRow,
	SurvivorFilter,
	SurvivorMutantRow,
	SurvivorMutatorRow,
	SurvivorRemedy,
	SurvivorSummary,
	SurvivorSymbolRow,
	SurvivorTotals,
} from "./survivors-types.js";

describe("survivors-types — row/summary shapes", () => {
	it("SurvivorFilter admits every optional field, including omission", () => {
		const empty: SurvivorFilter = {};
		const full: SurvivorFilter = {
			file: "a.ts",
			mutator: "ConditionalExpression",
			includeDispositioned: true,
			exists: (f) => f.length > 0,
		};
		expect(empty.file).toBeUndefined();
		expect(full.exists?.("x")).toBe(true);
	});

	it("SurvivorMutantRow carries a null disposition for an unjudged survivor", () => {
		const row: SurvivorMutantRow = {
			file: "a.ts",
			symbolId: "s1",
			qualifiedName: "a.fn",
			mutantId: "m1",
			mutator: "ConditionalExpression",
			originalLexeme: "&&",
			replacement: "||",
			firstSeen: "2026-01-01T00:00:00.000Z",
			disposition: null,
		};
		expect(row.disposition).toBeNull();
	});

	it("SurvivorSymbolRow tracks quarantine independent of counts", () => {
		const row: SurvivorSymbolRow = {
			file: "a.ts",
			symbolId: "s1",
			qualifiedName: "a.fn",
			open: 2,
			dispositioned: 1,
			uncovered: 0,
			total: 3,
			quarantined: true,
		};
		expect(row.quarantined).toBe(true);
		expect(row.open + row.dispositioned + row.uncovered).toBeLessThanOrEqual(row.total);
	});

	it("SurvivorRemedy is exactly the three job kinds", () => {
		const remedies: SurvivorRemedy[] = ["write_test", "strengthen_tests", "unknown"];
		expect(remedies).toHaveLength(3);
	});

	it("SurvivorFileRow can report a stale, unqualified file", () => {
		const row: SurvivorFileRow = {
			file: "gone.ts",
			symbols: 0,
			open: 0,
			dispositioned: 0,
			uncovered: 0,
			timeout: 0,
			killed: 0,
			total: 0,
			score: 1,
			stale: true,
			remedy: "unknown",
			provenance: null,
		};
		expect(row.stale).toBe(true);
		expect(row.provenance).toBeNull();
	});

	it("SurvivorMutatorRow reports an escape rate in [0,1]", () => {
		const row: SurvivorMutatorRow = { mutator: "ConditionalExpression", open: 1, total: 4, escapeRate: 0.25 };
		expect(row.escapeRate).toBeGreaterThanOrEqual(0);
		expect(row.escapeRate).toBeLessThanOrEqual(1);
	});

	it("SurvivorTotals.openByRemedy is keyed by every SurvivorRemedy", () => {
		const totals: SurvivorTotals = {
			files: 1,
			symbols: 1,
			mutants: 1,
			killed: 0,
			survived: 1,
			open: 1,
			dispositioned: 0,
			uncovered: 0,
			timeout: 0,
			staleFiles: 0,
			unqualifiedFiles: 0,
			openByRemedy: { write_test: 1, strengthen_tests: 0, unknown: 0 },
			score: 0,
		};
		expect(Object.keys(totals.openByRemedy).sort()).toEqual(["strengthen_tests", "unknown", "write_test"]);
	});

	it("SurvivorSummary composes every row kind under one generation", () => {
		const summary: SurvivorSummary = {
			generation: 1,
			authoritativeAt: "2026-01-01T00:00:00.000Z",
			totals: {
				files: 0,
				symbols: 0,
				mutants: 0,
				killed: 0,
				survived: 0,
				open: 0,
				dispositioned: 0,
				uncovered: 0,
				timeout: 0,
				staleFiles: 0,
				unqualifiedFiles: 0,
				openByRemedy: { write_test: 0, strengthen_tests: 0, unknown: 0 },
				score: 1,
			},
			files: [],
			symbols: [],
			mutators: [],
			mutants: [],
		};
		expect(summary.files).toEqual([]);
		expect(summary.totals.score).toBe(1);
	});
});
