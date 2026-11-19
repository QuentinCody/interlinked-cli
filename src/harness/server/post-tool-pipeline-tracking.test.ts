import { describe, expect, it } from "vitest";
import { createFreshSession } from "../session-state-mutators.js";
import type { HarnessEvent } from "../types.js";
import { trackRunEvidence, trackTestRun, trackVerificationOutcome } from "./post-tool-pipeline-tracking.js";

/**
 * trackTestRun's evidence handling. The wedge this pins (observed live
 * 2026-07-28): a PASSING bare `vitest run` whose event carried no outcome
 * evidence resolved "neither" and was dropped SILENTLY — reds recorded via
 * PostToolUseFailure, greens could not clear them, and the commit gate stayed
 * shut with nobody able to see why. Greens must record when evidence arrives,
 * and evidence starvation must be SAID, not swallowed.
 */
const CWD = "/repo";
const VITEST_GREEN = " RUN  v4.1.8 /repo\n\n Test Files  1 passed (1)\n      Tests  7 passed (7)\n";
const VITEST_RED = " Test Files  1 failed (1)\n      Tests  2 failed | 5 passed (7)\n";

function bashPost(command: string, over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-07-28T00:00:00.000Z",
		tool_name: "Bash",
		tool_input: { command },
		...over,
	};
}

function freshSession(event: HarnessEvent) {
	const session = createFreshSession(event, "s");
	session.tool_call_count = 42;
	return session;
}

describe("trackTestRun — positive (evidence present, must record)", () => {
	it("P1: a green runner summary in lifted stdout records a pass", () => {
		const event = bashPost("npx vitest run src/a.test.ts", { stdout: VITEST_GREEN });
		const session = freshSession(event);
		expect(trackTestRun(event, session, CWD)).toBeNull();
		expect(session.test_runs.get("/repo/src/a.test.ts")?.status).toBe("pass");
	});

	it("P2: a red runner summary records a fail even when the shell exited 0", () => {
		const event = bashPost("npx vitest run src/a.test.ts | tail -5", { stdout: VITEST_RED });
		const session = freshSession(event);
		trackTestRun(event, session, CWD);
		expect(session.test_runs.get("/repo/src/a.test.ts")?.status).toBe("fail");
	});

	it("P3: tool_outcome success on a bare run records a pass without a summary", () => {
		const event = bashPost("npx vitest run src/a.test.ts", { tool_outcome: "success" });
		const session = freshSession(event);
		trackTestRun(event, session, CWD);
		expect(session.test_runs.get("/repo/src/a.test.ts")?.status).toBe("pass");
	});

	it("P4: a PostToolUseFailure event records a fail", () => {
		const event = bashPost("npx vitest run src/a.test.ts", { hook_event: "PostToolUseFailure" });
		const session = freshSession(event);
		trackTestRun(event, session, CWD);
		expect(session.test_runs.get("/repo/src/a.test.ts")?.status).toBe("fail");
	});
});

describe("trackTestRun — negative (no evidence, must not guess — and must say so)", () => {
	it("N1: a bare run with NO evidence at all warns about starvation instead of silence", () => {
		const event = bashPost("npx vitest run src/a.test.ts");
		const session = freshSession(event);
		const warning = trackTestRun(event, session, CWD);
		expect(warning).toContain("NOT counted");
		expect(warning).toContain("no outcome evidence");
		expect(session.test_runs.size).toBe(0);
	});

	it("N2: a piped run with no summary keeps the pipe-masking warning", () => {
		const event = bashPost("npx vitest run src/a.test.ts | tail -3");
		const session = freshSession(event);
		const warning = trackTestRun(event, session, CWD);
		expect(warning).toContain("NOT counted");
		expect(warning).toContain("pipe");
		expect(session.test_runs.size).toBe(0);
	});

	it("N3: an interrupted run stays silent — cancellation is not a transport gap", () => {
		const event = bashPost("npx vitest run src/a.test.ts", { tool_outcome: "interrupted" });
		const session = freshSession(event);
		expect(trackTestRun(event, session, CWD)).toBeNull();
		expect(session.test_runs.size).toBe(0);
	});

	it("N4: a non-test command records nothing and warns nothing", () => {
		const event = bashPost("ls -la", { stdout: "total 0" });
		const session = freshSession(event);
		expect(trackTestRun(event, session, CWD)).toBeNull();
		expect(session.test_runs.size).toBe(0);
	});
});

/**
 * The check-level tracker must not believe a shell status that a pipe or a
 * later command owns. `npx tsc --noEmit | tail` exits 0 when the typecheck
 * fails; recording that GREEN cleared a real red.
 */
describe("trackVerificationOutcome — a hidden exit status proves nothing", () => {
	it("V1: a direct check still records green and red", () => {
		const session = freshSession(bashPost("npx tsc --noEmit"));
		expect(trackVerificationOutcome(bashPost("npx tsc --noEmit", { tool_outcome: "error" }), session)).toBeNull();
		expect(session.observed_checks?.get("typecheck")?.status).toBe("red");
		expect(trackVerificationOutcome(bashPost("npx tsc --noEmit", { tool_outcome: "success" }), session)).toBeNull();
		expect(session.observed_checks?.get("typecheck")?.status).toBe("green");
	});

	it("V2: a piped check does not clear a red, and says why", () => {
		const session = freshSession(bashPost("npx tsc --noEmit"));
		trackVerificationOutcome(bashPost("npx tsc --noEmit", { tool_outcome: "error" }), session);
		const warning = trackVerificationOutcome(bashPost("npx tsc --noEmit 2>&1 | tail -5", { tool_outcome: "success" }), session);
		expect(session.observed_checks?.get("typecheck")?.status).toBe("red");
		expect(warning).toContain("[interlinked:check-evidence] typecheck result NOT counted");
		expect(warning).toContain("pipefail");
	});

	it("V3: a hidden non-zero status does not record a red", () => {
		const session = freshSession(bashPost("npm run lint"));
		const event = bashPost("npm run lint | grep -c error", { hook_event: "PostToolUseFailure", tool_outcome: "error" });
		expect(trackVerificationOutcome(event, session)).toContain("lint result NOT counted");
		expect(session.observed_checks?.get("lint")).toBeUndefined();
	});

	it("V4: pipefail makes a piped check count again", () => {
		const session = freshSession(bashPost("npx tsc --noEmit"));
		const command = "set -o pipefail; npx tsc --noEmit 2>&1 | tail -5";
		expect(trackVerificationOutcome(bashPost(command, { tool_outcome: "success" }), session)).toBeNull();
		expect(session.observed_checks?.get("typecheck")?.status).toBe("green");
	});

	it("V5: a piped whole-suite run is decided by the runner summary, with no second warning", () => {
		const session = freshSession(bashPost("npx vitest run"));
		const red = bashPost("npx vitest run 2>&1 | tail -5", { tool_outcome: "success", stdout: VITEST_RED });
		expect(trackVerificationOutcome(red, session)).toBeNull();
		expect(session.observed_checks?.get("test-suite")?.status).toBe("red");
		const blind = bashPost("npx vitest run 2>&1 | tail -1", { tool_outcome: "success", stdout: "done" });
		expect(trackVerificationOutcome(blind, session)).toBeNull();
		expect(session.observed_checks?.get("test-suite")?.status).toBe("red");
	});

	it("V6: a direct whole-suite failure stays red even when the summary shows only passes", () => {
		const session = freshSession(bashPost("npx vitest run"));
		const event = bashPost("npx vitest run", { tool_outcome: "error", stdout: VITEST_GREEN });
		trackVerificationOutcome(event, session);
		expect(session.observed_checks?.get("test-suite")?.status).toBe("red");
	});
});

describe("trackRunEvidence — both trackers run, and their warnings are collected", () => {
	it("E1: records the per-file run and returns no warning on a clean direct run", () => {
		const event = bashPost("npx vitest run src/a.test.ts", { stdout: VITEST_GREEN });
		const session = freshSession(event);
		expect(trackRunEvidence(event, session, CWD)).toEqual([]);
		expect(session.test_runs.get("/repo/src/a.test.ts")?.status).toBe("pass");
	});

	it("E2: a compound command keeps both results: the piped test run warns, the direct typecheck records", () => {
		const event = bashPost("npx vitest run src/a.test.ts | tail -3; npx tsc --noEmit", { tool_outcome: "success" });
		const session = freshSession(event);
		const warnings = trackRunEvidence(event, session, CWD);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[interlinked:test-evidence]");
		expect(session.observed_checks?.get("typecheck")?.status).toBe("green");
	});

	it("E3: a piped typecheck returns the check-evidence warning", () => {
		const event = bashPost("npx tsc --noEmit | tail -3", { tool_outcome: "success" });
		const session = freshSession(event);
		const warnings = trackRunEvidence(event, session, CWD);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[interlinked:check-evidence]");
	});
});
