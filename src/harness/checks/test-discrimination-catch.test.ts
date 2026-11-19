import { describe, expect, it } from "vitest";
import { checkCatchWithoutAssertionGuard } from "./test-discrimination-catch.js";
import { withForegroundCheckScan } from "./check-scan-policy.js";

function run(content: string, path = "cart.test.ts"): ReturnType<typeof checkCatchWithoutAssertionGuard> {
	return checkCatchWithoutAssertionGuard(content, path);
}

describe("checkCatchWithoutAssertionGuard foreground result collection", () => {
	it("P1 retains twenty test blocks and their tail while ordinary edits keep ten", () => {
		const content = Array.from({ length: 20 }, (_, index) => `it("case ${index}", () => { try { sut(); } catch (err) { expect(err.message).toBe("bad"); } });`).join("\n");
		expect(run(content)).toHaveLength(10);
		expect(withForegroundCheckScan(() => run(content)).map(match => match.line)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
		expect(run(content)).toHaveLength(10);
	});

	it("P2 retains twenty try/catch statements within a single foreground test", () => {
		const tries = Array.from({ length: 20 }, () => 'try { sut(); } catch (err) { expect(err.message).toBe("bad"); }').join("\n");
		const content = `it("many failures", () => {\n${tries}\n});`;
		expect(run(content)).toHaveLength(10);
		expect(withForegroundCheckScan(() => run(content)).map(match => match.line)).toEqual(Array.from({ length: 20 }, (_, index) => index + 2));
		expect(run(content)).toHaveLength(10);
	});

	it("N1 keeps assertion-count guards and skipped tests exempt in foreground scans", () => {
		const content = Array.from({ length: 20 }, (_, index) => `it("guard ${index}", () => { expect.assertions(1); try { sut(); } catch (err) { expect(err.message).toBe("bad"); } });\nit.skip("skipped ${index}", () => { try { sut(); } catch (err) { expect(err.message).toBe("bad"); } });`).join("\n");
		expect(withForegroundCheckScan(() => run(content))).toEqual([]);
	});
});

describe("checkCatchWithoutAssertionGuard — positive (must fire)", () => {
	it("flags a try/catch whose only assertion lives in the catch", () => {
		const found = run(`it("throws", () => {
			try {
				sut();
			} catch (e) {
				expect(e.message).toBe("bad");
			}
		});`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("catch_without_assertion_guard");
	});

	it("flags the async/await variant", () => {
		const found = run(`it("throws async", async () => {
			try {
				await sut();
			} catch (e) {
				expect(e.message).toBe("bad");
			}
		});`);
		expect(found).toHaveLength(1);
	});

	it("flags an assert.* call inside the catch (not just expect)", () => {
		const found = run(`test("asserts", () => {
			try {
				sut();
			} catch (e) {
				assert.strictEqual(e.message, "bad");
			}
		});`);
		expect(found).toHaveLength(1);
	});

	it("flags a try body with unrelated non-assertion statements before the catch assertion", () => {
		const found = run(`it("logs then asserts in catch", () => {
			try {
				const x = 1;
				sut(x);
			} catch (e) {
				expect(e.message).toBe("bad");
			}
		});`);
		expect(found).toHaveLength(1);
	});

	it("fires once per unguarded try/catch when multiple exist in one block", () => {
		const found = run(`it("two tries", () => {
			try {
				sut();
			} catch (e) {
				expect(e.message).toBe("bad");
			}
			try {
				sut2();
			} catch (e2) {
				expect(e2.message).toBe("bad2");
			}
		});`);
		expect(found).toHaveLength(2);
	});
});

describe("checkCatchWithoutAssertionGuard — negative (must not fire)", () => {
	it("does not fire when expect.assertions(n) guards the block", () => {
		const found = run(`it("guarded", () => {
			expect.assertions(1);
			try {
				sut();
			} catch (e) {
				expect(e.message).toBe("bad");
			}
		});`);
		expect(found).toHaveLength(0);
	});

	it("does not fire when expect.hasAssertions() guards the block", () => {
		const found = run(`it("guarded", () => {
			expect.hasAssertions();
			try {
				sut();
			} catch (e) {
				expect(e.message).toBe("bad");
			}
		});`);
		expect(found).toHaveLength(0);
	});

	it("does not fire when the try body ends with a throw fail-sentinel", () => {
		const found = run(`it("guarded", () => {
			try {
				sut();
				throw new Error("should have thrown");
			} catch (e) {
				expect(e.message).toBe("bad");
			}
		});`);
		expect(found).toHaveLength(0);
	});

	it("does not fire when the try body ends with expect.unreachable()", () => {
		const found = run(`it("guarded", () => {
			try {
				sut();
				expect.unreachable();
			} catch (e) {
				expect(e.message).toBe("bad");
			}
		});`);
		expect(found).toHaveLength(0);
	});

	it("does not fire on try/finally with no catch clause", () => {
		const found = run(`it("cleanup only", () => {
			try {
				sut();
			} finally {
				cleanup();
			}
		});`);
		expect(found).toHaveLength(0);
	});

	it("does not fire on a catch that only re-throws (cleanup, not assertion)", () => {
		const found = run(`it("rethrows", () => {
			try {
				sut();
			} catch (e) {
				logError(e);
				throw e;
			}
		});`);
		expect(found).toHaveLength(0);
	});

	it("does not fire when both the try body and the catch assert (ambiguous)", () => {
		const found = run(`it("both assert", () => {
			try {
				expect(sut()).toBe(1);
			} catch (e) {
				expect(e.message).toBe("bad");
			}
		});`);
		expect(found).toHaveLength(0);
	});

	it("does not fire when expect(...).toThrow() is used elsewhere in the block instead", () => {
		const found = run(`it("uses toThrow", () => {
			expect(() => sut()).toThrow();
		});`);
		expect(found).toHaveLength(0);
	});

	it("does not fire when a recognized toThrow assertion guards a catch-only try/catch in the same block", () => {
		// The case above has no try/catch, so it passes with or without the guard (E64 blind mutants k4).
		const found = run(`it("guarded by toThrow", () => {
			expect(() => sut()).toThrow("bad");
			try {
				sut();
			} catch (e) {
				expect(e.message).toBe("bad");
			}
		});`);
		expect(found).toHaveLength(0);
	});

	it("does not fire on await expect(p).rejects.toThrow() (no try/catch at all)", () => {
		const found = run(`it("rejects", async () => {
			await expect(sut()).rejects.toThrow();
		});`);
		expect(found).toHaveLength(0);
	});

	it("does not fire on a skipped test block", () => {
		// interlinked-ignore: disabled_tests — fixture string, not a real skipped test
		const found = run(`it.skip("skipped", () => {
			try {
				sut();
			} catch (e) {
				expect(e.message).toBe("bad");
			}
		});`);
		expect(found).toHaveLength(0);
	});

	it("does not fire on a non-test file", () => {
		const found = run(
			`function f() {
				try {
					sut();
				} catch (e) {
					expect(e.message).toBe("bad");
				}
			}`,
			"cart.ts",
		);
		expect(found).toHaveLength(0);
	});
});
