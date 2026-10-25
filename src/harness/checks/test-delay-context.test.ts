import { describe, expect, it } from "vitest";
import { classifyLiteralDelays, type DelayContext } from "./test-delay-context.js";
import { stripPreservingOffsets } from "./test-hygiene-shared.js";

/** Classify the first `MARK` occurrence (the delay call's start offset). */
function classify(code: string): DelayContext {
	const stripped = stripPreservingOffsets(code);
	const at = stripped.indexOf("MARK");
	if (at < 0) throw new Error("fixture has no MARK");
	const [verdict] = classifyLiteralDelays(stripped, [at]);
	if (verdict === undefined) throw new Error("no verdict");
	return verdict;
}

describe("classifyLiteralDelays — positive (not a wait in the test's own flow)", () => {
	it("P1: a delay in a callback passed to a non-test call inside test() is a SUT callback", () => {
		expect(classify("test('t', async () => { bench.add('x', async () => { await MARK(50) }) })")).toBe("sut-callback");
	});

	it("P2: an expression-bodied arrow argument counts as a callback", () => {
		expect(classify("it('t', () => { run(() => new Promise(r => MARK(r, 5))) })")).toBe("sut-callback");
	});

	it("P3: an object-literal method hook passed to a call inside describe() is a SUT callback", () => {
		expect(classify("describe('d', () => { const c = make({ decode(s) { return MARK(1) } }) })")).toBe("sut-callback");
	});

	it("P4: the interval of a braced while-predicate poll is a poll loop", () => {
		expect(classify("it('t', async () => { while (!ready()) { await MARK(10) } })")).toBe("poll-loop");
	});

	it("P5: the interval of a braceless while-predicate poll is a poll loop", () => {
		expect(classify("async function until() { while (!existsSync(p)) await MARK(25); }")).toBe("poll-loop");
	});

	it("P7: an async property function of an object literal is a fake implementation", () => {
		expect(classify("it('t', async () => { const storage = { getItem: async () => { await MARK(10) } } })")).toBe("sut-callback");
	});

	it("P8: an expression-bodied property arrow at module level is a fake implementation", () => {
		expect(classify("const fake = { get: () => MARK(10) }")).toBe("sut-callback");
	});

	it("P9: an arrow assigned to a member is a fake method, even inside the test body", () => {
		expect(classify("it('t', async () => { storage.getItem = async () => { await MARK(10) } })")).toBe("sut-callback");
	});

	it("P6: a do/while body with a promise-executor delay is a poll loop", () => {
		expect(classify("it('t', async () => { do { await new Promise(r => MARK(r, 5)) } while (!x) })")).toBe("poll-loop");
	});
});

describe("classifyLiteralDelays — negative (a wait in the test's own flow)", () => {
	it("N1: a delay directly in the test body is the test's own flow", () => {
		expect(classify("it('t', async () => { await MARK(500) })")).toBe("wait");
	});

	it("N2: a promise executor inside the test body is passthrough, not a SUT callback", () => {
		expect(classify("it('t', async () => { await new Promise(r => MARK(r, 500)) })")).toBe("wait");
	});

	it("N3: a callback to a non-test call outside any test/suite frame is a helper, not a SUT callback", () => {
		expect(classify("withServer(async () => { await MARK(500) })")).toBe("helper");
	});

	it("N9: a bare top-level promise-executor delay is a wait, not a helper", () => {
		expect(classify("await new Promise(r => MARK(r, 500))")).toBe("wait");
	});

	it("N10: a module-level function body is a helper", () => {
		expect(classify("async function settle() { await MARK(500) }")).toBe("helper");
	});

	it("N11: an arrow bound to a plain local inside the test body is the test's own helper", () => {
		expect(classify("it('t', async () => { const settle = async () => { await MARK(500) }; await settle() })")).toBe("wait");
	});

	it("N12: an equality comparison before an arrow is not a member assignment", () => {
		expect(classify("it('t', async () => { if (a.b == (() => 1)) { await MARK(500) } })")).toBe("wait");
	});

	it("N4: a delay used as a plain argument (no callback boundary) stays in the test's flow", () => {
		expect(classify("it('t', async () => { await race(fetchIt(), MARK(500)) })")).toBe("wait");
	});

	it("N5: an if-block inside a test body is not a function boundary", () => {
		expect(classify("it('t', async () => { if (x) { await MARK(500) } })")).toBe("wait");
	});

	it("N6: a curried it.each(...)(name, fn) is recognised as the test root", () => {
		expect(classify("it.each([1])('t', async () => { await MARK(500) })")).toBe("wait");
	});

	it("N7: a fixed-count for loop of sleeps is not a predicate poll", () => {
		expect(classify("it('t', async () => { for (let i = 0; i < 3; i++) { await MARK(500) } })")).toBe("wait");
	});

	it("N8: a while loop that contains a callback with the delay is not a poll of that delay", () => {
		expect(classify("it('t', async () => { while (x) { onTick(() => { MARK(500) }) } })")).toBe("sut-callback");
	});
});
