import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionTracker } from "../session-state.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import { buildSessionEvidence, writeSessionEndEvidence } from "./session-end-evidence.js";

function ev(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		cwd: "/repo",
		timestamp: "t",
	};
}

function fresh(): SessionTrajectory {
	return new SessionTracker().recordEvent(ev("ls"));
}

describe("buildSessionEvidence", () => {
	it("reports an unverified session with no test runs or verification", () => {
		const e = buildSessionEvidence(fresh());
		expect(e.session_id).toBe("s1");
		expect(e.result).toBe("unverified");
		expect(e.tests).toEqual({ run: 0, passed: 0, failed: 0 });
		expect(e.verification).toEqual([]);
	});

	it("counts tests and marks verified when a verification signal was observed", () => {
		const s = fresh();
		s.test_runs.set("a.test.ts", { status: "pass", at_step: 1 });
		s.test_runs.set("b.test.ts", { status: "fail", at_step: 2 });
		s.files_written.add("/repo/src/a.ts");
		s.warnings_issued.set("a.ts::x", { check_name: "x", issue_count: 1, first_issued_at: 0, last_issued_at: 0, resolved: false });
		s.verification_observed = new Set(["typecheck", "test"]);

		const e = buildSessionEvidence(s);
		expect(e.tests).toEqual({ run: 2, passed: 1, failed: 1 });
		expect(e.files_edited).toBe(1);
		expect(e.warnings_surfaced).toBe(1);
		expect(e.verification).toEqual(["test", "typecheck"]); // sorted
		expect(e.result).toBe("verified");
	});
});

describe("writeSessionEndEvidence", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "evidence-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("writes a JSON bundle under .interlinked/evidence/", () => {
		const s = fresh();
		s.verification_observed = new Set(["build"]);
		writeSessionEndEvidence(cwd, s);
		const p = join(cwd, ".interlinked", "evidence", "s1.json");
		expect(existsSync(p)).toBe(true);
		expect(JSON.parse(readFileSync(p, "utf-8")).result).toBe("verified");
	});

	it("never throws on an unwritable target", () => {
		expect(() => writeSessionEndEvidence("/nonexistent-root-xyz/nope", fresh())).not.toThrow();
	});
});
