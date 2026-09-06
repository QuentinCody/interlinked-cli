// Unit tests for taste-checks-shared.ts
//
// findBlockEnd:
//   P1  a body with no `=>`/`function` marker whose braces never balance
//       falls through the legacy brace-counter's fallback and returns the
//       last line index (not `null`, not the unbalanced-open line).

import { describe, expect, it } from "vitest";
import { findBlockEnd } from "./taste-checks-shared.js";

describe("findBlockEnd", () => {
	it("returns the last line when a marker-less body never balances its braces", () => {
		// No "=>" and no the-word "function" anywhere in these lines, so
		// findBlockEnd's marker search misses and it falls back to
		// legacyFindBlockEnd's brace-counter — which never sees an opening
		// "{" here, so depth never balances and it returns the last index.
		const lines = ["plain line one, no braces here", "plain line two, still none"];
		expect(findBlockEnd(lines, 0)).toBe(lines.length - 1);
	});
});
