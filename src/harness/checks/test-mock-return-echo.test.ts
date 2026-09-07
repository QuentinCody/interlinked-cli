import { describe, expect, it } from "vitest";
import { checkMockReturnEcho } from "./test-mock-return-echo.js";

function run(content: string, path = "widget.test.ts"): ReturnType<typeof checkMockReturnEcho> {
	return checkMockReturnEcho(content, path);
}

describe("checkMockReturnEcho — positive (must fire)", () => {
	it("P1: mockReturnValue string literal echoed via toBe", () => {
		const found = run(
			`it("returns the mocked value", () => { dep.mockReturnValue("echo"); const result = sut(dep); expect(result).toBe("echo"); });`,
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("mock_return_echo");
	});

	it("P2: mockReturnValueOnce echoed via toEqual", () => {
		const found = run(
			`it("returns once", () => { dep.mockReturnValueOnce("once-val"); const result = sut(dep); expect(result).toEqual("once-val"); });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P3: mockResolvedValue echoed via toBe", () => {
		const found = run(
			`it("resolves the value", async () => { dep.mockResolvedValue("async-echo"); const result = await sut(dep); expect(result).toBe("async-echo"); });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P4: mockResolvedValueOnce echoed via toBe", () => {
		const found = run(
			`it("resolves once", async () => { dep.mockResolvedValueOnce("resolved-once"); const result = await sut(dep); expect(result).toBe("resolved-once"); });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P5: mockImplementation arrow literal echoed via toBe", () => {
		const found = run(
			`it("implements", () => { dep.mockImplementation(() => "impl-echo"); const result = sut(dep); expect(result).toBe("impl-echo"); });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P6: vi.fn(() => lit) assigned to a variable, forwarded and echoed", () => {
		const found = run(
			`it("forwards fn result", () => { const spy = vi.fn(() => "fn-echo"); const result = sut(spy); expect(result).toBe("fn-echo"); });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P7: vi.fn().mockReturnValue(lit) chained and echoed", () => {
		const found = run(
			`it("forwards chained fn", () => { const spy = vi.fn().mockReturnValue("chained-echo"); const result = sut(spy); expect(result).toBe("chained-echo"); });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P8: vi.mocked(fn).mockReturnValue(lit) echoed", () => {
		const found = run(
			`it("forwards vi.mocked result", () => { vi.mocked(dep).mockReturnValue("mocked-echo"); const result = sut(dep); expect(result).toBe("mocked-echo"); });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P9: mock configured in the enclosing describe's beforeEach, one level up", () => {
		const found = run(
			`describe("widget", () => {
				beforeEach(() => { dep.mockReturnValue("shared-echo"); });
				it("returns the shared mock", () => { const result = sut(dep); expect(result).toBe("shared-echo"); });
			});`,
		);
		expect(found).toHaveLength(1);
	});

	it("P10: coarse literal fires when it is the only assertion in the block", () => {
		const found = run(
			`it("returns ok", () => { dep.mockReturnValue(true); const result = sut(dep); expect(result).toBe(true); });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P11: leaf literals inside an object mock are collected and matched via toEqual", () => {
		const found = run(
			`it("returns the mocked object", () => { dep.mockReturnValue({ a: 1, b: "two" }); const result = sut(dep); expect(result).toEqual({ a: 1, b: "two" }); });`,
		);
		expect(found).toHaveLength(1);
	});
});

describe("checkMockReturnEcho — negative (must not fire)", () => {
	it("N1: the SUT computed a literal the mock never supplied", () => {
		const found = run(
			`it("computes a real value", () => { dep.mockReturnValue(3); const result = sut(dep); expect(result).toBe(5); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N2: a call-argument pin carries a literal the mock did not supply", () => {
		const found = run(
			`it("calls with a real argument", () => { dep.mockReturnValue("echo"); const result = sut(dep); expect(result).toBe("echo"); expect(dep).toHaveBeenCalledWith("realArg"); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N3: a coarse shared literal with more than one assertion is too weak to fire", () => {
		const found = run(
			`it("returns falsy from both", () => { dep.mockReturnValue(false); const a = sutA(dep); const b = sutB(dep); expect(a).toBe(false); expect(b).toBe(false); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N4: the mocked function is the SUT's own companion module", () => {
		const found = run(
			`import { computeTotal } from "./calc";
			it("mocks the sut itself", () => { (computeTotal as any).mockReturnValue(42); const result = computeTotal(); expect(result).toBe(42); });`,
			"calc.test.ts",
		);
		expect(found).toHaveLength(0);
	});

	it("N5: the block asserts a thrown error, not a value", () => {
		const found = run(
			`it("throws on bad input", () => { dep.mockImplementation(() => { throw new Error("boom"); }); expect(() => sut(dep)).toThrow("boom"); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N6: the assertion subject is a visible transformation of the SUT's return value", () => {
		const found = run(
			`it("uppercases the result", () => { dep.mockReturnValue("hi"); const result = sut(dep); expect(result.toUpperCase()).toBe("HI"); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N7: a non-test file is never scanned", () => {
		const found = run(
			`it("returns the mocked value", () => { dep.mockReturnValue("echo"); const result = sut(dep); expect(result).toBe("echo"); });`,
			"widget.ts",
		);
		expect(found).toHaveLength(0);
	});

	it("N8: a skipped block is never flagged", () => {
		const found = run(
			`it.skip("returns the mocked value", () => { dep.mockReturnValue("echo"); const result = sut(dep); expect(result).toBe("echo"); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N9: no mock configuration exists anywhere in scope", () => {
		const found = run(
			`it("computes directly", () => { const result = sut(); expect(result).toBe("echo"); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N10: a beforeEach in a different describe is out of proximity scope", () => {
		const found = run(
			`describe("other", () => {
				beforeEach(() => { dep.mockReturnValue("far-away"); });
			});
			describe("widget", () => {
				it("has no local mock", () => { const result = sut(dep); expect(result).toBe("far-away"); });
			});`,
		);
		expect(found).toHaveLength(0);
	});
});
