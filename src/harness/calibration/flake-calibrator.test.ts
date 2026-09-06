import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeFlakeOutcome } from "./flake-calibrator.js";

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "flake-cal-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

const statePath = () => join(cwd, ".interlinked", "flake-eprocess.json");

describe("observeFlakeOutcome", () => {
	it("does not escalate on clean runs and persists accumulating state", () => {
		for (let i = 0; i < 5; i++) {
			expect(observeFlakeOutcome(cwd, false)).toBeNull();
		}
		expect(existsSync(statePath())).toBe(true);
		const state = JSON.parse(readFileSync(statePath(), "utf-8"));
		expect(state.n).toBe(5);
		expect(state.positives).toBe(0);
		expect(state.logE).toBeLessThan(0); // evidence for H0 (not flaky)
	});

	it("does not escalate on a single one-off divergence", () => {
		expect(observeFlakeOutcome(cwd, true)).toBeNull();
	});

	it("escalates once flakiness is statistically elevated (sustained divergence)", () => {
		expect(observeFlakeOutcome(cwd, true)).toBeNull(); // 1
		expect(observeFlakeOutcome(cwd, true)).toBeNull(); // 2 — still under threshold
		const escalation = observeFlakeOutcome(cwd, true); // 3 — crosses 1/α = 100
		expect(escalation).not.toBeNull();
		expect(escalation).toContain("statistically elevated");
		expect(escalation).toContain("nondeterminism problem");
	});

	it("re-arms after an alarm (state resets to fresh)", () => {
		observeFlakeOutcome(cwd, true);
		observeFlakeOutcome(cwd, true);
		observeFlakeOutcome(cwd, true); // alarm → reset
		const state = JSON.parse(readFileSync(statePath(), "utf-8"));
		expect(state.n).toBe(0); // re-armed
		expect(state.logE).toBe(0);
		// A single divergence right after the re-arm is again a one-off, not an alarm.
		expect(observeFlakeOutcome(cwd, true)).toBeNull();
	});

	it("never throws on a fresh cwd with no prior state", () => {
		expect(() => observeFlakeOutcome(cwd, false)).not.toThrow();
	});

	it("N1: treats a non-object state file (top-level array) as absent, starting fresh", () => {
		mkdirSync(dirname(statePath()), { recursive: true });
		writeFileSync(statePath(), JSON.stringify([1, 2, 3]), "utf-8");
		expect(() => observeFlakeOutcome(cwd, false)).not.toThrow();
		const state = JSON.parse(readFileSync(statePath(), "utf-8"));
		// A fresh e-process folded one observation: n=1, not carried over from
		// the array (which has no logE/n/positives fields to misread).
		expect(state.n).toBe(1);
		expect(state.positives).toBe(0);
	});

	it("N2: treats a state file with a non-numeric field as absent, starting fresh", () => {
		mkdirSync(dirname(statePath()), { recursive: true });
		writeFileSync(statePath(), JSON.stringify({ logE: "bad", n: 5, positives: 1 }), "utf-8");
		expect(() => observeFlakeOutcome(cwd, false)).not.toThrow();
		const state = JSON.parse(readFileSync(statePath(), "utf-8"));
		expect(state.n).toBe(1);
	});

	it("N3: treats an unparseable state file (malformed JSON) as absent, starting fresh", () => {
		mkdirSync(dirname(statePath()), { recursive: true });
		writeFileSync(statePath(), "{ not valid json", "utf-8");
		expect(() => observeFlakeOutcome(cwd, false)).not.toThrow();
		const state = JSON.parse(readFileSync(statePath(), "utf-8"));
		// The catch path folds one observation into a fresh e-process (n=1), the
		// same outcome as a missing file — proof the JSON.parse throw was caught
		// rather than propagated (an uncaught throw would have failed the
		// `not.toThrow` assertion above).
		expect(state.n).toBe(1);
		expect(state.positives).toBe(0);
	});

	it("P1: resumes accumulating from a valid persisted state", () => {
		mkdirSync(dirname(statePath()), { recursive: true });
		writeFileSync(
			statePath(),
			JSON.stringify({ logE: -0.5, n: 3, positives: 0 }),
			"utf-8",
		);
		observeFlakeOutcome(cwd, false);
		const state = JSON.parse(readFileSync(statePath(), "utf-8"));
		expect(state.n).toBe(4); // resumed from 3, not reset to 1
	});
});
