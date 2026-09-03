// ===========================================
// Wiring test: runHookEntry actually calls attemptSelfHealOnStop
// ===========================================
// `hook-entry-stop-self-heal.test.ts` unit-tests `attemptSelfHealOnStop` in
// isolation. This file proves the OTHER half of the fix landed 2026-09-02:
// the function was exported since 814b270 but never called from the real
// entry point, so the "revives a daemon dead >60s" claim in that commit
// message was false. This drives the real `runHookEntry` (from hook-entry.ts,
// the SUT here) with a spied-on self-heal module and asserts the call
// actually happens on Stop/SubagentStop and nowhere else, and never
// influences the returned decision. Uses `vi.spyOn` on the real module
// (never `vi.mock`) so the underlying implementation always runs unchanged —
// this is an observation point, not a stub.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHookEntry } from "./hook-entry.js";
import * as stopSelfHeal from "./hook-entry-stop-self-heal.js";

let tmp = "";
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-stop-heal-wiring-"));
	mkdirSync(join(tmp, ".interlinked"), { recursive: true });
	spy = vi.spyOn(stopSelfHeal, "attemptSelfHealOnStop");
});

afterEach(() => {
	spy.mockRestore();
	rmSync(tmp, { recursive: true, force: true });
});

describe("runHookEntry -> attemptSelfHealOnStop wiring — positive (must fire)", () => {
	// P1: a real Stop event reaches the self-heal call, and the cold-fallback
	// decision it observes is still the ordinary daemon-absent allow.
	it("P1: calls attemptSelfHealOnStop for a Stop event", async () => {
		const result = await runHookEntry({
			nativeEventName: "Stop",
			nativeJson: { session_id: "s1", cwd: tmp },
			env: {},
			runner: "claude-code",
			cwd: tmp,
		});
		expect(spy).toHaveBeenCalledTimes(1);
		const [calledEvent] = spy.mock.calls[0] ?? [];
		expect((calledEvent as { phase?: string } | undefined)?.phase).toBe("stop");
		// Non-blocking: the daemon-absent cold path still returns its ordinary
		// allow decision, unaffected by whatever the self-heal call decided.
		expect(result.exit_code).toBe(0);
		expect(result.fell_back).toBe(true);
	});

	// P2: SubagentStop reaches it too — same STOP_PHASES set as the module.
	it("P2: calls attemptSelfHealOnStop for a SubagentStop event", async () => {
		const result = await runHookEntry({
			nativeEventName: "SubagentStop",
			nativeJson: { session_id: "s2", cwd: tmp },
			env: {},
			runner: "claude-code",
			cwd: tmp,
		});
		expect(spy).toHaveBeenCalledTimes(1);
		const [calledEvent] = spy.mock.calls[0] ?? [];
		expect((calledEvent as { phase?: string } | undefined)?.phase).toBe("subagent-stop");
		expect(result.exit_code).toBe(0);
	});
});

describe("runHookEntry -> attemptSelfHealOnStop wiring — negative (must NOT fire)", () => {
	// N1: an ordinary PreToolUse event never triggers the Stop-phase self-heal
	// — that traffic is covered by the reactive cold-fallback self-heal only.
	it("N1: does not call attemptSelfHealOnStop for a PreToolUse event", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: { session_id: "s3", cwd: tmp, tool_name: "Read", tool_input: {} },
			env: {},
			runner: "claude-code",
			cwd: tmp,
		});
		expect(spy).not.toHaveBeenCalled();
		expect(result.exit_code).toBe(0);
	});

	// N2: whatever the self-heal call throws or returns, it never leaks into
	// the returned hook decision — proven by forcing it to throw and asserting
	// runHookEntry still returns its ordinary cold-fallback allow decision
	// instead of rejecting.
	it("N2: a throwing self-heal call does not change the returned decision or reject the entry", async () => {
		spy.mockImplementationOnce(() => {
			throw new Error("self-heal boom");
		});
		const result = await runHookEntry({
			nativeEventName: "Stop",
			nativeJson: { session_id: "s4", cwd: tmp },
			env: {},
			runner: "claude-code",
			cwd: tmp,
		});
		expect(result.exit_code).toBe(0);
		expect(result.fell_back).toBe(true);
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
