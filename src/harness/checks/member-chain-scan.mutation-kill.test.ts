// Mutation-kill tests for member-chain-scan.ts — kill-proof census row 15
// (docs/reviews/kill-proof-census-harness.md): postfix `!` joins a chain.
import { describe, expect, it } from "vitest";
import { memberChainStart } from "./member-chain-scan.js";

describe("memberChainStart — non-null assertion", () => {
	// test-contract: public-api — a postfix non-null `!` before the dot is part of the chain
	it("walks back across x!.y to the head identifier", () => {
		expect(memberChainStart("a!.b", 2)).toBe(0);
		expect(memberChainStart("run(xs[0]!.y)", 10)).toBe(4);
	});
	// test-contract: public-api — a prefix negation `!` is not part of the chain
	it("stops at the identifier after a prefix !", () => {
		expect(memberChainStart("!a.b", 2)).toBe(1);
	});
});
