// ===========================================
// Protocol v3 — canonical valid envelope builders (fixture-invariant guard)
// ===========================================
// test-envelopes.ts is itself TDD-exempt (see its own header): its builders
// are exercised indirectly by every other protocol-v3 test file. This file
// pins the ONE defensive branch nothing else reaches — identityRows()'s
// internal invariant that derivePortableIdentities() returns exactly one
// identity per raw mutant. That invariant cannot be broken through real
// TypeScript parsing of the fixed fixture content (the raws array and the
// target content are both hardcoded, so the real derivation always agrees
// with them), so the only seam is the dependency itself.

import { describe, expect, it, vi } from "vitest";
import { validMutationResult } from "./test-envelopes.js";

// SAFETY: mocks a DEPENDENCY of the module under test (../identity.js), never
// test-envelopes.ts itself — the real derivation is deterministic and cannot
// be made to under-produce through any public seam.
vi.mock("../identity.js", () => ({
	derivePortableIdentities: vi.fn(() => [
		{
			mutantId: "m0",
			siteId: "s0",
			symbolId: "sym0",
			qualifiedName: "example",
			symbolContext: "example",
			mutator: "EqualityOperator",
			originalLexeme: ">",
			replacement: ">=",
			ordinalWithinSymbol: 0,
		},
		{
			mutantId: "m1",
			siteId: "s0",
			symbolId: "sym0",
			qualifiedName: "example",
			symbolContext: "example",
			mutator: "ArithmeticOperator",
			originalLexeme: "+",
			replacement: "-",
			ordinalWithinSymbol: 1,
		},
	]),
}));

describe("validMutationResult — identityRows invariant", () => {
	// test-contract: invariant — three raw mutants must always derive into
	// three portable identities (two kept, one excluded); a short derivation
	// means the fixture and the identity algorithm have drifted apart, and
	// the builder must refuse loudly rather than silently drop the excluded
	// row and mint a structurally incomplete fixture.
	it("N1: fewer derived identities than raw mutants throws instead of silently dropping the excluded row", () => {
		expect(() => validMutationResult()).toThrow("fixture portable identity missing");
	});
});
