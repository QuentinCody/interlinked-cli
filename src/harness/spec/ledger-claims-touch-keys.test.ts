import { describe, expect, it } from "vitest";
import { claimsTouchKeys } from "./ledger-claims-touch-keys.js";
import type { CountClaim, RangeClaim, SpecFacts } from "./types.js";

function makeFacts(overrides: Partial<SpecFacts> = {}): SpecFacts {
	return {
		filePath: "a.md",
		lineCount: 1,
		namespaces: [],
		looseDefinedIds: [],
		countClaims: [],
		rangeClaims: [],
		headings: [],
		sectionRefs: [],
		anchorLinks: [],
		pathRefs: [],
		declaredFacts: [],
		fencedBlocks: [],
		claimSentences: [],
		...overrides,
	};
}

function rangeClaim(overrides: Partial<RangeClaim> = {}): RangeClaim {
	return {
		prefix: "FG-INV",
		style: "dashed",
		from: 1,
		to: 20,
		toExplicit: true,
		raw: "FG-INV-01 through FG-INV-20",
		line: 1,
		col: 0,
		...overrides,
	};
}

function countClaim(overrides: Partial<CountClaim> = {}): CountClaim {
	return {
		noun: "bets",
		nounSingular: "bet",
		value: 6,
		raw: "six bets",
		line: 1,
		...overrides,
	};
}

describe("claimsTouchKeys", () => {
	it("returns true when a range claim binds a scoped key", () => {
		const facts = makeFacts({ rangeClaims: [rangeClaim()] });
		const keys = new Set(["dashed FG-INV"]);
		expect(claimsTouchKeys(facts, new Map(), keys)).toBe(true);
	});

	it("returns true when a count claim's bound namespace matches a scoped key", () => {
		const facts = makeFacts({ countClaims: [countClaim()] });
		const bindings = new Map([["bet", new Set(["dashed B"])]]);
		const keys = new Set(["dashed B"]);
		expect(claimsTouchKeys(facts, bindings, keys)).toBe(true);
	});

	it("returns false when no claim binds any scoped key", () => {
		const facts = makeFacts({
			rangeClaims: [rangeClaim()],
			countClaims: [countClaim()],
		});
		const bindings = new Map([["bet", new Set(["dashed OTHER"])]]);
		const keys = new Set(["dashed UNRELATED"]);
		expect(claimsTouchKeys(facts, bindings, keys)).toBe(false);
	});
});
