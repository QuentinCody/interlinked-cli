import { describe, expect, it } from "vitest";
import { checkTestNameMatcherMismatch } from "./test-discrimination-title.js";

// `checkTestNameMatcherMismatch` flags an it()/test() whose TITLE's HEAD WORD
// claims a specific outcome (throws / returns null / returns undefined /
// returns empty / calls) while the BODY carries no acceptable evidence for
// that family — falsifier corpus u032: a static proxy for "the name
// promises one thing, the assertion pins another." The claim must be
// title-INITIAL (round 2 of calibration): a verb inside a subordinate clause
// ("skips an entry whose statSync throws") or a parenthetical aside never
// fires — see N9/N10.

function run(content: string, path = "sut.test.ts"): ReturnType<typeof checkTestNameMatcherMismatch> {
	return checkTestNameMatcherMismatch(content, path);
}

describe("checkTestNameMatcherMismatch — positive (must fire)", () => {
	it("P1: title claims throws, body has no throw matcher", () => {
		const found = run(`it("throws when input is invalid", () => { expect(add(1, 2)).toBeDefined(); });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("test_name_matcher_mismatch");
		expect(found[0]?.text).toContain("throws");
	});

	it("P2: title claims returns null, body asserts the wrong shape", () => {
		const found = run(`it("returns null for a missing key", () => { expect(lookup("x")).toBeUndefined(); });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("returns null");
	});

	it("P3: title claims returns undefined, body asserts null instead", () => {
		const found = run(`it("returns undefined when not found", () => { expect(lookup("x")).toBe(null); });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("returns undefined");
	});

	it("P4: title claims returns an empty result, body pins a non-empty length", () => {
		const found = run(`it("returns an empty array when there are no matches", () => { expect(scan(f).length).toBe(1); });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("returns empty");
	});

	it("P5: title claims the callback is called, body never checks mock calls", () => {
		const found = run(`it("calls the onError handler", () => { const r = handle(cb); expect(r).toBe(true); });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("calls");
	});

	it("P6: a case-label prefix is stripped before the verb-first check", () => {
		const found = run(`it("P1: throws when config is missing", () => { expect(load()).toBeDefined(); });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("throws");
	});
});

describe("checkTestNameMatcherMismatch — negative (must not fire)", () => {
	it("N1: title claims throws, body has a matching toThrow", () => {
		expect(
			run(`it("throws when input is invalid", () => { expect(() => parse("x")).toThrow(); });`),
		).toEqual([]);
	});

	it("N2: title claims returns null, body has a matching toBeNull", () => {
		expect(run(`it("returns null for a missing key", () => { expect(lookup("x")).toBeNull(); });`)).toEqual([]);
	});

	it("N3: negated claim — 'does not throw' is not a claim of throwing", () => {
		expect(
			run(`it("does not throw when input is valid", () => { expect(parse("x")).toBe(1); });`),
		).toEqual([]);
	});

	it("N4: title carries no claim vocabulary at all", () => {
		expect(run(`it("adds two numbers", () => { expect(add(1, 2)).toBe(3); });`)).toEqual([]);
	});

	it("N5: it.skip is never examined", () => {
		expect(
			run(`it.skip("throws when input is invalid", () => { expect(add(1, 2)).toBeDefined(); });`),
		).toEqual([]);
	});

	it("N6: it.todo is never examined", () => {
		expect(run(`it.todo("returns null for a missing key");`)).toEqual([]);
	});

	it("N7: body delegates the claimed assertion to an in-file assert* helper", () => {
		const content = `
function assertThrows(fn) { expect(fn).toThrow(); }
it("throws on an invalid config", () => { assertThrows(() => load(cfg)); });
`;
		expect(run(content)).toEqual([]);
	});

	it("N8: async rejects satisfies a throws claim via .rejects.toThrow()", () => {
		expect(
			run(`it("rejects when the fetch fails", async () => { await expect(fetchIt()).rejects.toThrow(); });`),
		).toEqual([]);
	});

	it("N9: a subordinate-clause 'throws' is not title-initial and never fires", () => {
		expect(
			run(
				`it("skips an entry whose statSync throws (self-referential symlink)", () => { expect(walk()).toEqual(["a"]); });`,
			),
		).toEqual([]);
	});

	it("N10: a parenthetical 'returns null' aside is not title-initial and never fires", () => {
		expect(
			run(
				`it("falls back to a flat update when readLocalConfig returns null", () => { expect(update).toHaveBeenCalledWith({ id: 1 }); });`,
			),
		).toEqual([]);
	});

	it("N11: a text matcher naming the outcome satisfies the claim (widened evidence)", () => {
		expect(
			run(`it("returns null for a missing key", () => { expect(String(lookup("x"))).toMatch(/null/); });`),
		).toEqual([]);
	});

	it("N12: a captured mock-call array satisfies a calls claim (widened evidence)", () => {
		const content = `
it("calls the logger with the right payload", () => {
	const calls = [];
	const logger = (msg) => calls.push(msg);
	run(logger);
	expect(calls[0]).toBe("done");
});
`;
		expect(run(content)).toEqual([]);
	});
});

describe("checkTestNameMatcherMismatch — file scoping", () => {
	it("stays silent on a non-test file", () => {
		expect(run(`it("throws when input is invalid", () => { expect(1).toBe(1); });`, "sut.ts")).toEqual([]);
	});

	it("stays silent on a non-JS/TS file", () => {
		expect(run(`it("throws when input is invalid", () => { expect(1).toBe(1); });`, "sut.test.py")).toEqual([]);
	});
});
