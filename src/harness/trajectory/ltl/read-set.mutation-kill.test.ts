import { describe, expect, it } from "vitest";
import { recordReads } from "./read-set.js";

describe("recordReads — mutation-directed", () => {
	// test-contract: boundary — reads are recorded through three nesting levels and no deeper
	it("records a third nesting level and stops wrapping at the fourth", () => {
		const rec = recordReads({ a: { b: { c: { d: 1 } } } }, {});
		const c = rec.state.a.b.c;
		expect(c.d).toBe(1);
		expect(rec.reads()).toEqual(["state.a", "state.a.b", "state.a.b.c"]);
	});
});
