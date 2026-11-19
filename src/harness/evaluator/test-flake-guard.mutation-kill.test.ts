import { describe, expect, it } from "vitest";
import type { CoverageRunResult } from "../coverage-runner.js";
import { flakeDivergence } from "./test-flake-guard.js";

function run(over: Partial<CoverageRunResult>): CoverageRunResult {
	return {
		ok: true,
		suiteMs: 100,
		perFile: new Map(),
		testsPassed: false,
		...over,
	};
}

describe("test-flake-guard mutation-kill", () => {
	// test-contract: boundary — a second run failing a strict subset of the first run's failing files is a divergence
	it("warns when run 2 fails a strict subset of the files run 1 failed", () => {
		const w = flakeDivergence(
			run({ failingTestFiles: ["a.test.ts", "b.test.ts"] }),
			run({ failingTestFiles: ["a.test.ts"] }),
		);
		expect(w).toContain("[interlinked:flake]");
		expect(w).toContain("different");
	});
});
