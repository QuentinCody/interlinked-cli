import { describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_SECONDS, hookTimeoutSecondsFor } from "./hook-timeouts.js";

describe("hook timeout policy", () => {
	it("grants PreToolUse enough to outlast the per-edit coverage overlay", () => {
		expect(hookTimeoutSecondsFor("PreToolUse")).toBe(240);
		// Must exceed the dist client's 180s transport failsafe, else Claude Code
		// kills the hook while the client is still legitimately waiting.
		expect(hookTimeoutSecondsFor("PreToolUse")).toBeGreaterThan(180);
	});

	it("grants PostToolUse room for the full quality pass", () => {
		expect(hookTimeoutSecondsFor("PostToolUse")).toBe(120);
	});

	it("leaves unlisted events on the client default", () => {
		expect(hookTimeoutSecondsFor("SessionStart")).toBeUndefined();
		expect(hookTimeoutSecondsFor("Stop")).toBeUndefined();
	});

	it("caps observational Interrupt handling at three seconds", () => {
		expect(hookTimeoutSecondsFor("Interrupt")).toBe(3);
	});

	it("grants native compiler batches room beyond the 60s transport deadline", () => {
        expect(hookTimeoutSecondsFor("PostToolBatch")).toBe(120);
    });
	it("exposes exactly the four governed events", () => {
		expect(Object.keys(HOOK_TIMEOUT_SECONDS).sort()).toEqual([
			"Interrupt",
			"PostToolBatch",
			"PostToolUse",
			"PreToolUse",
		]);
	});
});
