import { describe, expect, it } from "vitest";
import { failure, spawnText, testsPassedFromStatus } from "./coverage-run-helpers.js";
import type { SpawnOutcome } from "./coverage-runner.js";

describe("failure", () => {
	it("builds a not-measured result that fails open", () => {
		const r = failure(120, "boom");
		expect(r.ok).toBe(false);
		expect(r.error).toBe("boom");
		expect(r.testsPassed).toBeNull();
		expect(r.perFile.size).toBe(0);
		expect(r.suiteMs).toBe(120);
	});
});

describe("spawnText", () => {
	it("concatenates stdout and stderr", () => {
		const o: SpawnOutcome = { stdout: "out", stderr: "err", status: 0 };
		expect(spawnText(o)).toBe("out\nerr");
	});
	it("joins empty output streams", () => {
		expect(spawnText({ status: 0, stdout: "", stderr: "" })).toBe("\n");
	});
});

describe("testsPassedFromStatus", () => {
	it("0 → passed, failExit → failed, else null (fail-open)", () => {
		expect(testsPassedFromStatus(0, 1)).toBe(true);
		expect(testsPassedFromStatus(1, 1)).toBe(false);
		expect(testsPassedFromStatus(2, 1)).toBeNull();
		expect(testsPassedFromStatus(null, 1)).toBeNull();
	});
});
