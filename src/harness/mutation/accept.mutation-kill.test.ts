import { describe, expect, it } from "vitest";
import { acceptMutant } from "./accept.js";
import type { SurvivorDisposition } from "./disposition.js";
import { emptyManifest } from "./manifest.js";
import type { MutantRecord, MutationManifest, SymbolRecord } from "./types.js";

const FILE = "src/a.ts";
const META = {
	engine: "stryker",
	engineVersion: "9",
	dependencyGraphVersion: "1",
	environmentHash: "e",
	authoritativeAt: "t0",
};

function rec(mutantId: string): MutantRecord {
	return {
		mutantId,
		siteId: `${mutantId}-site`,
		mutator: "ObjectLiteral",
		originalLexeme: "{ a: 1 }",
		replacement: "{}",
		ordinalWithinSymbol: 0,
		status: "survived",
		firstSeen: "t0",
	};
}

function symbol(id: string, mutantId: string): SymbolRecord {
	return {
		symbolId: id,
		qualifiedName: id,
		symbolHash: `hash-${id}`,
		mutants: { [mutantId]: rec(mutantId) },
		instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
	};
}

const twoSymbols: MutationManifest = {
	...emptyManifest(META),
	files: { [FILE]: { sym1: symbol("sym1", "m1"), sym2: symbol("sym2", "m2") } },
};

const disposition: SurvivorDisposition = {
	kind: "proved_equivalent",
	method: {
		kind: "rewrite_lemma",
		lemmaId: "unobservable-default-arm",
		normalizedOriginalHash: "n1",
		normalizedMutantHash: "n1",
	},
	certificate: {
		producedBy: "equivalence-verifier",
		verifierVersion: "1.0.0",
		producedAt: "2026-07-31T00:00:00Z",
		validity: {
			mutantId: "m1",
			sourceSymbolHash: "hash-sym1",
			environmentHash: META.environmentHash,
			dependencyGraphVersion: META.dependencyGraphVersion,
		},
	},
};

describe("accept mutation-kill", () => {
	// test-contract: invariant — accepting one mutant leaves every other symbol record of the same file intact
	it("keeps sibling symbol records of the file when accepting a mutant", () => {
		const out = acceptMutant({ base: twoSymbols, file: FILE, mutantId: "m1", disposition });
		expect(out?.files[FILE]?.sym1?.mutants.m1?.status).toBe("equivalent");
		expect(out?.files[FILE]?.sym2).toEqual(twoSymbols.files[FILE]?.sym2);
		expect(Object.keys(out?.files[FILE] ?? {}).sort()).toEqual(["sym1", "sym2"]);
	});
});
