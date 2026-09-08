import { describe, expect, it } from "vitest";
import type { CoverageRunResult } from "../coverage-runner.js";
import { flakeDivergence, runFlakeDoubleCheck } from "./test-flake-guard.js";

function run(over: Partial<CoverageRunResult>): CoverageRunResult {
	return {
		ok: true,
		suiteMs: 100,
		perFile: new Map(),
		testsPassed: true,
		...over,
	};
}

describe("flakeDivergence", () => {
	it("fires on a pass→fail flip", () => {
		const w = flakeDivergence(run({ testsPassed: true }), run({ testsPassed: false, failingTestFiles: ["a.test.ts"] }));
		expect(w).toContain("[interlinked:flake]");
		expect(w).toContain("passed then FAILED");
	});

	it("fires on a fail→pass flip (the retry-pass case)", () => {
		const w = flakeDivergence(run({ testsPassed: false, failingTestFiles: ["a.test.ts"] }), run({ testsPassed: true }));
		expect(w).toContain("FAILED then passed");
	});

	it("fires when both runs fail but with different failing sets", () => {
		const w = flakeDivergence(
			run({ testsPassed: false, failingTestFiles: ["a.test.ts"] }),
			run({ testsPassed: false, failingTestFiles: ["b.test.ts"] }),
		);
		expect(w).toContain("different");
		expect(w).toContain("a.test.ts");
		expect(w).toContain("b.test.ts");
	});

	it("is quiet when both runs agree (both green)", () => {
		expect(flakeDivergence(run({ testsPassed: true }), run({ testsPassed: true }))).toBeNull();
	});

	it("is quiet when both runs fail with the SAME failing set (deterministic red)", () => {
		expect(
			flakeDivergence(
				run({ testsPassed: false, failingTestFiles: ["a.test.ts", "b.test.ts"] }),
				run({ testsPassed: false, failingTestFiles: ["b.test.ts", "a.test.ts"] }),
			),
		).toBeNull();
	});

	it("is quiet (can't judge) when either run has an indeterminate verdict", () => {
		expect(flakeDivergence(run({ testsPassed: null }), run({ testsPassed: true }))).toBeNull();
		expect(flakeDivergence(run({ testsPassed: true }), run({ testsPassed: null }))).toBeNull();
	});
});

describe("runFlakeDoubleCheck", () => {
	it("runs the suite twice and reports divergence", async () => {
		const results = [run({ testsPassed: true }), run({ testsPassed: false, failingTestFiles: ["x.test.ts"] })];
		let n = 0;
		const w = await runFlakeDoubleCheck(async () => results[n++]!);
		expect(n).toBe(2);
		expect(w).toContain("[interlinked:flake]");
	});

	it("short-circuits BEFORE the second run when the first is indeterminate", async () => {
		let n = 0;
		const w = await runFlakeDoubleCheck(async () => {
			n++;
			return run({ testsPassed: null });
		});
		expect(n).toBe(1); // second run skipped — no verdict to compare
		expect(w).toBeNull();
	});

	it("short-circuits when the first run produced no parseable coverage (ok:false)", async () => {
		let n = 0;
		const w = await runFlakeDoubleCheck(async () => {
			n++;
			return run({ ok: false, testsPassed: null });
		});
		expect(n).toBe(1);
		expect(w).toBeNull();
	});

	it("never throws — a rejected run resolves to no warning", async () => {
		await expect(
			runFlakeDoubleCheck(async () => {
				throw new Error("runner exploded");
			}),
		).resolves.toBeNull();
	});

	it("is quiet when both runs agree", async () => {
		const w = await runFlakeDoubleCheck(async () => run({ testsPassed: true }));
		expect(w).toBeNull();
	});
});
