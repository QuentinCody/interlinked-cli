import { describe, expect, it } from "vitest";
import { checkWildcardInObservable } from "./test-discrimination-wildcard.js";

// `checkWildcardInObservable` flags it()/test() blocks whose assertions are
// ALL wildcard-shaped (quantifier-only regexes, `expect.any`/`anything`,
// trivial numeric bounds, type-only checks, presence-only property checks) —
// a shape that passes for nearly any implementation, including a broken one.

function run(content: string, path = "cart.test.ts"): ReturnType<typeof checkWildcardInObservable> {
	return checkWildcardInObservable(content, path);
}

describe("checkWildcardInObservable — coverage-only shapes (adjudication 2026-09-16)", () => {
	it("P: flags a block whose only observable is not.toThrow() with no argument", () => {
		const found = run(`it("runs the checks", () => { expect(() => runChecks(ctx)).not.toThrow(); });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("toThrow");
	});

	it("P: flags expect(Array.isArray(x)).toBe(true) — shape, not contents", () => {
		expect(run(`it("lists", () => { expect(Array.isArray(result.items)).toBe(true); });`)).toHaveLength(1);
	});

	it("P: flags Array.isArray + not.toThrow() together with no literal", () => {
		const code = `it("scans", () => { expect(() => scan(c)).not.toThrow(); expect(Array.isArray(c.hits)).toBeTruthy(); });`;
		expect(run(code)).toHaveLength(1);
	});

	it("N: a title that DECLARES the no-throw contract makes bare not.toThrow() the behavior, not a wildcard", () => {
		const titles = [
			"never throws on an unwritable cwd",
			"does not throw when console.warn is not a function",
			"survives a broken symlink",
			"tolerates an unreadable entry",
			"fails open without a config",
			"must not throw resolving paths",
		];
		for (const title of titles) {
			expect(run(`it("${title}", () => { expect(() => f()).not.toThrow(); });`), title).toEqual([]);
		}
	});

	it("P: the no-throw title exemption does not cover a second, unrelated wildcard", () => {
		const code = `it("never throws", () => { expect(() => f()).not.toThrow(); expect(Array.isArray(f())).toBe(true); });`;
		expect(run(code)).toHaveLength(1);
	});

	it("N: not.toThrow(SomeError) names the error and is NOT a wildcard", () => {
		expect(run(`it("rejects", () => { expect(() => parse(x)).not.toThrow(SyntaxError); });`)).toEqual([]);
	});

	it("N: not.toThrow() beside a literal-pinning assertion does not fire", () => {
		const code = `it("runs", () => { expect(() => run()).not.toThrow(); expect(run()).toEqual([1, 2]); });`;
		expect(run(code)).toEqual([]);
	});

	it("N: expect(Array.isArray(x)).toBe(false) pins a negative shape claim and is left alone", () => {
		expect(run(`it("scalar", () => { expect(Array.isArray(v)).toBe(false); });`)).toEqual([]);
	});
});

describe("checkWildcardInObservable — positive (must fire)", () => {
	it("flags a quantifier-only regex on toMatch (u051: byte-count wildcard)", () => {
		const found = run(`it("logs the byte count", () => { expect(msg).toMatch(/\\d+/); });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("wildcard_in_observable");
	});

	it("flags a trivial toBeGreaterThan(-1) bound", () => {
		expect(run(`it("has length", () => { expect(len).toBeGreaterThan(-1); });`)).toHaveLength(1);
	});

	it("flags a trivial toBeGreaterThanOrEqual(0) bound on a count", () => {
		expect(run(`it("counts", () => { expect(count).toBeGreaterThanOrEqual(0); });`)).toHaveLength(1);
	});

	it("flags a standalone expect.any(Number) assertion", () => {
		expect(run(`it("returns a number", () => { expect(val).toEqual(expect.any(Number)); });`)).toHaveLength(1);
	});

	it("flags a presence-only toHaveProperty with no value", () => {
		expect(run(`it("has id", () => { expect(obj).toHaveProperty("id"); });`)).toHaveLength(1);
	});

	it("flags a typeof-compared-to-toBe(bool) assertion", () => {
		expect(run(`it("is a number", () => { expect(typeof val === "number").toBe(true); });`)).toHaveLength(1);
	});

	it("flags a typeof subject asserted with toBe(typeName)", () => {
		expect(run(`it("is a number", () => { expect(typeof val).toBe("number"); });`)).toHaveLength(1);
	});

	it("flags toBeInstanceOf(Object)", () => {
		expect(run(`it("is an object", () => { expect(thing).toBeInstanceOf(Object); });`)).toHaveLength(1);
	});

	it("flags toBeTypeOf", () => {
		expect(run(`it("is a string", () => { expect(res).toBeTypeOf("string"); });`)).toHaveLength(1);
	});

	it("flags a standalone expect.anything() assertion", () => {
		expect(run(`it("returns something", () => { expect(val).toEqual(expect.anything()); });`)).toHaveLength(1);
	});

	it("flags an empty expect.stringContaining('')", () => {
		expect(run(`it("has a message", () => { expect(msg).toEqual(expect.stringContaining("")); });`)).toHaveLength(1);
	});

	it("flags an empty expect.objectContaining({})", () => {
		expect(run(`it("returns an object", () => { expect(res).toEqual(expect.objectContaining({})); });`)).toHaveLength(1);
	});

	it("flags a block whose several assertions are all wildcard-shaped", () => {
		const found = run(
			`it("logs", () => { expect(a).toMatch(/\\w+/); expect(b).toBeGreaterThan(-1); });`,
		);
		expect(found).toHaveLength(1);
	});

	it("reports the it( line of the flagged block", () => {
		const found = run(`\nit("counts", () => { expect(count).toBeGreaterThanOrEqual(0); });`);
		expect(found[0]?.line).toBe(2);
	});
});

describe("checkWildcardInObservable — negative (must not fire)", () => {
	it("does not flag a wildcard regex next to a literal assertion in the same block", () => {
		expect(
			run(`it("logs", () => { expect(msg).toMatch(/\\d+/); expect(msg).toBe("42 items"); });`),
		).toEqual([]);
	});

	it("does not flag expect.any(Number) nested inside a toEqual that also pins a literal field", () => {
		expect(
			run(`it("shapes", () => { expect(obj).toEqual({ id: expect.any(Number), name: "x" }); });`),
		).toEqual([]);
	});

	it("does not flag a regex that carries literal structure", () => {
		expect(run(`it("versions", () => { expect(v).toMatch(/^v\\d+\\.\\d+\\.\\d+$/); });`)).toEqual([]);
	});

	it("does not flag toBeGreaterThan with a real bound", () => {
		expect(run(`it("is big enough", () => { expect(n).toBeGreaterThan(5); });`)).toEqual([]);
	});

	it("does not flag toBeGreaterThanOrEqual with a real bound", () => {
		expect(run(`it("is big enough", () => { expect(n).toBeGreaterThanOrEqual(10); });`)).toEqual([]);
	});

	it("does not flag toHaveProperty when a value is also pinned", () => {
		expect(run(`it("has id 1", () => { expect(obj).toHaveProperty("id", 1); });`)).toEqual([]);
	});

	it("does not flag toBeInstanceOf a real class", () => {
		expect(run(`it("is a widget", () => { expect(thing).toBeInstanceOf(Widget); });`)).toEqual([]);
	});

	it("does not flag a skipped test block", () => {
		expect(run(`it.skip("logs", () => { expect(msg).toMatch(/\\d+/); });`)).toEqual([]);
	});

	it("does not flag a todo test block", () => {
		expect(run(`it.todo("logs", () => { expect(msg).toMatch(/\\d+/); });`)).toEqual([]);
	});

	it("does not flag an assertion-free block", () => {
		expect(run(`it("setup", () => { const r = calcTotal([1]); });`)).toEqual([]);
	});

	it("does not flag a negated wildcard-shaped assertion", () => {
		expect(run(`it("no message", () => { expect(msg).not.toMatch(/\\d+/); });`)).toEqual([]);
	});

	it("ignores non-test files", () => {
		expect(run(`it("adds", () => { expect(msg).toMatch(/\\d+/); });`, "src/cart.ts")).toEqual([]);
	});

	it("ignores non-JS/TS test files", () => {
		expect(run(`it("adds", () => { expect(msg).toMatch(/\\d+/); });`, "foo_test.go")).toEqual([]);
	});
});
