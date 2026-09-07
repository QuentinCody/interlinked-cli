import { describe, expect, it } from "vitest";
import { checkSpyCallUnpinnedArgs } from "./test-discrimination-spy.js";

function run(content: string, path = "widget.test.ts"): ReturnType<typeof checkSpyCallUnpinnedArgs> {
	return checkSpyCallUnpinnedArgs(content, path);
}

describe("checkSpyCallUnpinnedArgs — positive (must fire)", () => {
	it("P1: bare toHaveBeenCalled with no other assertion", () => {
		const found = run(`it("calls save", () => { save(); expect(spy).toHaveBeenCalled(); });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spy_call_unpinned_args");
	});

	it("P2: toHaveBeenCalledTimes(n)", () => {
		const found = run(`it("calls twice", () => { run(); expect(spy).toHaveBeenCalledTimes(2); });`);
		expect(found).toHaveLength(1);
	});

	it("P3: toHaveBeenCalledOnce", () => {
		const found = run(`it("calls once", () => { run(); expect(spy).toHaveBeenCalledOnce(); });`);
		expect(found).toHaveLength(1);
	});

	it("P4: spy assertion plus a zero-information fallback assertion", () => {
		const found = run(
			`it("calls save", () => { const r = save(); expect(r).toBeUndefined(); expect(spy).toHaveBeenCalled(); });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P5: positive toHaveBeenCalled alongside a negated sibling assertion", () => {
		const found = run(
			`it("calls exactly one", () => { run(); expect(other).not.toHaveBeenCalled(); expect(spy).toHaveBeenCalled(); });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P6: jest-alias toBeCalledTimes", () => {
		const found = run(`it("calls jest-style", () => { run(); expect(spy).toBeCalledTimes(1); });`);
		expect(found).toHaveLength(1);
	});
});

describe("checkSpyCallUnpinnedArgs — negative (must not fire)", () => {
	it("N1: toHaveBeenCalledWith pins the arguments", () => {
		const found = run(
			`it("calls with args", () => { save("x"); expect(spy).toHaveBeenCalledWith("x"); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N2: .mock.calls is inspected directly", () => {
		const found = run(
			`it("inspects calls", () => { save("x"); expect(spy).toHaveBeenCalled(); expect(spy.mock.calls[0][0]).toBe("x"); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N3: a returned value is asserted with a real literal", () => {
		const found = run(
			`it("returns total", () => { const total = compute(); expect(spy).toHaveBeenCalled(); expect(total).toBe(3); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N4: not.toHaveBeenCalled() alone with a real non-spy literal assertion", () => {
		const found = run(
			`it("guards the call", () => { const total = compute(); expect(total).toBe(0 + 5); expect(spy).not.toHaveBeenCalled(); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N5: skipped block is never flagged", () => {
		const found = run(`it.skip("calls save", () => { save(); expect(spy).toHaveBeenCalled(); });`);
		expect(found).toHaveLength(0);
	});

	it("N6: toHaveBeenLastCalledWith pins the arguments", () => {
		const found = run(
			`it("last call args", () => { save("a"); save("b"); expect(spy).toHaveBeenLastCalledWith("b"); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N7: a non-test file is never scanned", () => {
		const found = run(
			`it("calls save", () => { save(); expect(spy).toHaveBeenCalled(); });`,
			"widget.ts",
		);
		expect(found).toHaveLength(0);
	});

	it("N8: an object-shaped assertion on returned state clears the block", () => {
		const found = run(
			`it("computes state", () => { const state = update(); expect(spy).toHaveBeenCalled(); expect(state).toEqual({ ok: true }); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N9: a bare not.toHaveBeenCalled() with no positive spy claim is a real abstention guarantee", () => {
		const found = run(`it("does not call save", () => { skip(); expect(spy).not.toHaveBeenCalled(); });`);
		expect(found).toHaveLength(0);
	});
});
