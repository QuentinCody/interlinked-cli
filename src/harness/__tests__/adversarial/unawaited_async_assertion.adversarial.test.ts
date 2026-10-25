// Independent adversarial review of the `unawaited_async_assertion` pre_block
// check (2026-10-21). Of 13 realistic candidates
// (scratch/2026-10-21-adversarial/unawaited_async_assertion.probe.mts) the
// statement-position gate held on 10; the three that fired were the Jest
// done-callback idiom, where the matcher promise is CONSUMED by a
// continuation that observes rejection. The refinement in
// checks/test-async-assertions.ts mirrors typescript-eslint's
// no-floating-promises: `.catch(handler)` or a two-argument `.then` is
// handled; a one-argument `.then(cb)` and `.finally(cb)` are not.

import { describe, expect, it } from "vitest";
import { detectUnawaitedAsyncAssertions } from "../../checks/test-async-assertions.js";

const T = "src/lib/__tests__/thing.test.ts";

describe("unawaited_async_assertion — negative (must not fire)", () => {
	it("N1: done-callback idiom — chain consumed by .then(done, done)", () => {
		const src = ['it("rejects", (done) => {', "  expect(doWork()).rejects.toThrow().then(done, done);", "});", ""].join("\n");
		expect(detectUnawaitedAsyncAssertions(src, T)).toEqual([]);
	});

	it("N2: chain consumed by .then(...) and then .catch(done) across lines", () => {
		const src = [
			'it("resolves", (done) => {',
			"  expect(compute()).resolves.toBe(1)",
			"    .then(() => done())",
			"    .catch(done);",
			"});",
			"",
		].join("\n");
		expect(detectUnawaitedAsyncAssertions(src, T)).toEqual([]);
	});

	it("N3: chain consumed directly by .catch(handler)", () => {
		const src = ['it("rejects", (done) => {', "  expect(doWork()).rejects.toThrow().catch(done);", "});", ""].join("\n");
		expect(detectUnawaitedAsyncAssertions(src, T)).toEqual([]);
	});

	it("N4: two-argument .then whose first callback holds a comma inside braces", () => {
		const src = [
			'it("resolves", (done) => {',
			"  expect(compute()).resolves.toEqual({ a: 1, b: 2 }).then(() => { log(1, 2); done(); }, done);",
			"});",
			"",
		].join("\n");
		expect(detectUnawaitedAsyncAssertions(src, T)).toEqual([]);
	});

	// Round 2 (resumed review): a one-argument `.then` that reaches the test's
	// own done callback is not a silent pass — a failed matcher leaves done
	// uncalled and the runner fails the test on timeout.
	it("N5: one-argument .then(done) in a done-callback test", () => {
		const src = ['it("rejects", (done) => {', "  expect(doWork()).rejects.toThrow().then(done);", "});", ""].join("\n");
		expect(detectUnawaitedAsyncAssertions(src, T)).toEqual([]);
	});

	it("N6: one-argument .then(() => done()) in a done-callback test", () => {
		const src = ['it("resolves", (done) => {', "  expect(load()).resolves.toBe(1).then(() => done());", "});", ""].join("\n");
		expect(detectUnawaitedAsyncAssertions(src, T)).toEqual([]);
	});

	it("N7: function(cb) test callback with the chain consumed by .then(cb) on the next line", () => {
		const src = ['test("x", function (cb) {', "  expect(load()).rejects.toThrow()", "    .then(cb);", "});", ""].join("\n");
		expect(detectUnawaitedAsyncAssertions(src, T)).toEqual([]);
	});

	it("N8: beforeEach hook that waits on done", () => {
		const src = ["beforeEach((done) => {", "  expect(boot()).resolves.toBeUndefined().then(done);", "});", ""].join("\n");
		expect(detectUnawaitedAsyncAssertions(src, T)).toEqual([]);
	});
});

describe("unawaited_async_assertion — positive (must fire)", () => {
	it("P5: .then(done) in an ASYNC test, where done is not the test's callback, still fires", () => {
		const src = ['it("x", async () => {', "  expect(load()).resolves.toBe(1).then(done);", "});", ""].join("\n");
		expect(detectUnawaitedAsyncAssertions(src, T).map((m) => m.line)).toEqual([2]);
	});

	it("P6: a one-argument .then that never reaches done in a done test still fires", () => {
		const src = ['it("x", (done) => {', "  expect(load()).resolves.toBe(1).then(() => log());", "  done();", "});", ""].join("\n");
		expect(detectUnawaitedAsyncAssertions(src, T).map((m) => m.line)).toEqual([2]);
	});

	it("P7: .then(done) after a previous done-test closed, inside a later async test, still fires", () => {
		const src = [
			'it("a", (done) => {',
			"  done();",
			"});",
			'it("b", async () => {',
			"  expect(load()).resolves.toBe(1).then(done);",
			"});",
			"",
		].join("\n");
		expect(detectUnawaitedAsyncAssertions(src, T).map((m) => m.line)).toEqual([5]);
	});

	it("P1: a bare floating chain still fires", () => {
		const src = 'it("x", async () => {\n  expect(doWork()).rejects.toThrow();\n});\n';
		expect(detectUnawaitedAsyncAssertions(src, T).map((m) => m.line)).toEqual([2]);
	});

	it("P2: a one-argument .then(cb) leaves the rejection unobserved and still fires", () => {
		const src = 'it("x", async () => {\n  expect(doWork()).rejects.toThrow().then(() => log("ok"));\n});\n';
		expect(detectUnawaitedAsyncAssertions(src, T).map((m) => m.line)).toEqual([2]);
	});

	it("P3: .finally(cb) does not observe rejection and still fires", () => {
		const src = 'it("x", (done) => {\n  expect(doWork()).resolves.toBe(1).finally(done);\n});\n';
		expect(detectUnawaitedAsyncAssertions(src, T).map((m) => m.line)).toEqual([2]);
	});

	it("P4: an empty .catch() still fires", () => {
		const src = 'it("x", async () => {\n  expect(doWork()).rejects.toThrow().catch();\n});\n';
		expect(detectUnawaitedAsyncAssertions(src, T).map((m) => m.line)).toEqual([2]);
	});
});
