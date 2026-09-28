// Regression tests for how a test run's red/green is EVIDENCED.
//
// The bug these pin: `tool_outcome` is the whole shell command's status, not
// the runner's. `vitest run … | tail` exits with tail's status and
// `vitest run …; echo x` exits with echo's — both 0 regardless of whether the
// tests passed. Trusting that recorded a GREEN for a failing suite, which is
// the same pipe-masking mistake the harness exists to catch, living inside the
// harness's own observation path.

import { describe, expect, it } from "vitest";
import { isOutcomeAttributable, parseTestSummary } from "./test-outcome-evidence.js";

describe("isOutcomeAttributable — can the shell exit code be trusted?", () => {
	it("trusts a bare runner invocation", () => {
		expect(isOutcomeAttributable("npx vitest run src/a.test.ts")).toBe(true);
		expect(isOutcomeAttributable("npm test")).toBe(true);
	});

	// Redirects do NOT change the exit status, so they stay attributable. This
	// is the case an earlier diagnosis blamed and it was innocent.
	it("trusts a redirected run — redirection does not change exit status", () => {
		expect(isOutcomeAttributable("npx vitest run > out.log 2>&1")).toBe(true);
		expect(isOutcomeAttributable("npx vitest run &> out.log")).toBe(true);
	});

	it("trusts operators BEFORE the runner — the runner still ends the command", () => {
		expect(isOutcomeAttributable("cd pkg && npx vitest run")).toBe(true);
		expect(isOutcomeAttributable("nvm use 22; npm test")).toBe(true);
	});

	it("distrusts a pipe after the runner (exit is the last stage's)", () => {
		expect(isOutcomeAttributable("npx vitest run | tail -12")).toBe(false);
		expect(isOutcomeAttributable("npm test 2>&1 | grep -c FAIL")).toBe(false);
	});

	it("distrusts a sequenced command after the runner", () => {
		expect(isOutcomeAttributable('npx vitest run > log 2>&1; echo "EXIT=$?"')).toBe(false);
		expect(isOutcomeAttributable("npm test; echo done")).toBe(false);
	});

	it("distrusts && / || chains after the runner", () => {
		expect(isOutcomeAttributable("npx vitest run && echo ok")).toBe(false);
		expect(isOutcomeAttributable("npm test || echo failed")).toBe(false);
	});

	it("ignores operators inside quotes", () => {
		expect(isOutcomeAttributable(`npx vitest run -t "a || b"`)).toBe(true);
		expect(isOutcomeAttributable("npx vitest run -t 'x; y'")).toBe(true);
	});

	it("returns true for a command with no runner rather than guessing", () => {
		// Caller only asks about commands already classified as test runs; a
		// non-runner string must not be reported as un-attributable noise.
		expect(isOutcomeAttributable("ls -la")).toBe(true);
	});
});

describe("parseTestSummary — the runner's own verdict", () => {
    it("accepts rg -n summaries from the captured Unit F run", () => {
        expect(parseTestSummary("5: Test Files  4 passed (4)\n6:      Tests  22 passed (22)")).toBe("green");
        expect(parseTestSummary("56: Test Files 2 failed (2)\n57: Tests 2 failed | 6 passed (8)")).toBe("red");
    });

    it("never lets a later pass summary mask a failure in the same output", () => {
        expect(parseTestSummary("1: Test Files 1 failed (1)\n2: Tests 22 passed (22)")).toBe("red");
        expect(parseTestSummary("Tests 22 passed\nTests 1 failed")).toBe("red");
        expect(parseTestSummary("Tests 0 failed | 22 passed")).toBe("green");
        expect(parseTestSummary("Tests 0 passed (0)")).toBeNull();
        expect(parseTestSummary("source.ts:12: Tests 22 passed")).toBeNull();
    });
	it("reads a vitest pass summary", () => {
		expect(parseTestSummary("\n Test Files  4 passed (4)\n      Tests  108 passed (108)\n")).toBe(
			"green",
		);
	});

	it("reads a vitest failure summary", () => {
		expect(
			parseTestSummary(" Test Files  1 failed | 989 passed (992)\n      Tests  2 failed | 21845 passed"),
		).toBe("red");
	});

	it("reads a jest summary in either direction", () => {
		expect(parseTestSummary("Tests:       1 failed, 2 passed, 3 total")).toBe("red");
		expect(parseTestSummary("Tests:       3 passed, 3 total")).toBe("green");
	});

	it("treats skipped-only runs as green", () => {
		expect(parseTestSummary("      Tests  22 skipped (22)\n Test Files  2 skipped")).toBe("green");
	});

	it("returns null when no summary is present", () => {
		expect(parseTestSummary("some unrelated output")).toBeNull();
		expect(parseTestSummary("")).toBeNull();
		expect(parseTestSummary(undefined)).toBeNull();
	});

	// "No test files found" exits non-zero in vitest but is not a test failure —
	// it is a targeting mistake, and recording it as red would wedge a cycle for
	// a file whose tests never ran.
	it("returns null when the runner found no tests at all", () => {
		expect(parseTestSummary("No test files found, exiting with code 1")).toBeNull();
	});
});
