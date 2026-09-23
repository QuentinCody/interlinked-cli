import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isStopHookReentry } from "./hook-entry.js";

/**
 * The Stop/SubagentStop re-entrancy guard. On a Stop event,
 * `hookSpecificOutput.additionalContext` is a CONTINUE instruction, so a hook
 * that re-emits it on every stop attempt re-prompts the model forever —
 * observed live 2026-07-28 as "A hook blocked the turn from ending 9
 * consecutive times", every turn, until the runner's cap force-ended it.
 * The runner marks the re-entry passes with `stop_hook_active: true`; the
 * guard yields on those and ONLY those, so every nudge still surfaces once.
 */
describe("isStopHookReentry — positive (must yield)", () => {
	it("P1: yields on a Stop re-entry", () => {
		expect(isStopHookReentry("Stop", { stop_hook_active: true })).toBe(true);
	});

	it("P2: yields on a SubagentStop re-entry", () => {
		expect(isStopHookReentry("SubagentStop", { stop_hook_active: true })).toBe(true);
	});

	it("P3: honors the camelCase casing some runners deliver", () => {
		// One-casing reads go silently undefined under the other runner family —
		// which would re-enable the loop for exactly that runner. Caught by this
		// repo's own payload-casing check minutes after the guard first landed.
		expect(isStopHookReentry("Stop", { stopHookActive: true })).toBe(true);
	});
});

describe("isStopHookReentry — negative (must not mute)", () => {
	it("N1: the FIRST Stop of a turn still surfaces every nudge", () => {
		expect(isStopHookReentry("Stop", { stop_hook_active: false })).toBe(false);
		expect(isStopHookReentry("Stop", {})).toBe(false);
	});

	it("N2: never touches tool events, whatever flags they carry", () => {
		expect(isStopHookReentry("PreToolUse", { stop_hook_active: true })).toBe(false);
		expect(isStopHookReentry("PostToolUse", { stop_hook_active: true })).toBe(false);
	});

	it("N3: a truthy-but-not-true flag is not a re-entry — the contract is boolean", () => {
		expect(isStopHookReentry("Stop", { stop_hook_active: "yes" })).toBe(false);
		expect(isStopHookReentry("Stop", { stop_hook_active: 1 })).toBe(false);
	});

	it("N4: survives non-object payloads", () => {
		expect(isStopHookReentry("Stop", null)).toBe(false);
		expect(isStopHookReentry("Stop", "x")).toBe(false);
		expect(isStopHookReentry("Stop", undefined)).toBe(false);
	});
});

describe("wiring — the guard actually short-circuits the entry point", () => {
	it("runHookEntry records suppression before contacting the daemon", () => {
		// Source-text pin, same convention as the Stop-rescan wiring test: a
		// refactor that keeps the helper but drops the call reintroduces the loop
		// with every unit test still green.
		const source = readFileSync(new URL("./hook-entry.ts", import.meta.url), "utf-8");
		expect(source).toMatch(/if \(isStopHookReentry\(opts.nativeEventName, opts.nativeJson\)\)\s*\{\s*recordSuppressedStop\([^;]+;\s*recordTransport\("suppressed"\);\s*return \{ exit_code: 0, fell_back: false \};/);
	});
});
