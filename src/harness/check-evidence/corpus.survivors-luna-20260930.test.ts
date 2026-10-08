import { describe, expect, it } from "vitest";
import { buildCorpusRecord, hitSignature } from "./corpus.js";

describe("corpus survivor regressions", () => {
	// test-contract: public-api — buildCorpusRecord promises a canonical sorted signature list; literal signatures make order observable independently of sorting the result under test.
	it("returns signatures in canonical ascending order", () => {
		const record = buildCorpusRecord([
			{ file: "z.ts", line: 1, text: "zzz" },
			{ file: "a.ts", line: 1, text: "aaa" },
			{ file: "m.ts", line: 1, text: "mmm" },
		], 3);

		expect(record.hits).toEqual([
			"01ba337b5308dc44",
			"2738391f9a094415",
			"c2764e731d46aa6d",
		]);
	});

	// test-contract: invariant — hitSignature normalizes whitespace runs to one space, preserving token separation so distinct normalized source lines cannot collapse to the same signature.
	it("preserves a separator between tokens when normalizing whitespace", () => {
		const separated = hitSignature({ file: "src/a.ts", text: 'const label = "foo bar";' });
		const joined = hitSignature({ file: "src/a.ts", text: 'const label = "foobar";' });

		expect(separated).not.toBe(joined);
	});
});
