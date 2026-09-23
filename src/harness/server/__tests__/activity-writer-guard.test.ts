// Guard-decision telemetry restore (2026-06-01 regression): the daemon path
// must persist a guard_block / guard_warn record for a PreToolUse/PostToolUse
// decision, joinable to its tool_use_start via tool_use_id. Pairs with
// writeGuardDecisionRecord in ../activity-writer.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyAuditChain } from "../../../lib/audit-chain.js";
import { readLocalActivity } from "../../../lib/local-activity.js";
import type { HarnessDecision, HarnessEvent } from "../../types.js";
import { mapDecisionToGuardRecord, writeGuardDecisionRecord } from "../activity-writer.js";

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		timestamp: "2026-06-23T00:00:00.000Z",
		...partial,
	};
}

function dec(partial: Partial<HarnessDecision> = {}): HarnessDecision {
	return { decision: "allow", ...partial };
}

describe("mapDecisionToGuardRecord -- guard telemetry mapping", () => {
	it("correlates daemon guard decisions with transport receipts by event id", () => {
		const record = mapDecisionToGuardRecord(ev({ event_id: "transport-event-1" }), dec({ decision: "block" }), "/repo");
		expect(record).toMatchObject({ event_id: "transport-event-1", writer: "daemon", type: "guard_block" });
	});
	it("maps a block decision to a guard_block record carrying the guard fields", () => {
		const rec = mapDecisionToGuardRecord(
			ev({ tool_name: "Edit", tool_use_id: "tu_9" }),
			dec({
				decision: "block",
				reason: "BLOCKED: nope",
				rule_id: "r1",
				severity: "high",
				category: "pre-block",
				checks_timing_ms: 12,
			}),
			"/repo",
		);
		expect(rec?.type).toBe("guard_block");
		expect(rec?.guard_decision).toBe("block");
		expect(rec?.guard_rule_id).toBe("r1");
		expect(rec?.guard_severity).toBe("high");
		expect(rec?.guard_category).toBe("pre-block");
		expect(rec?.guard_reason).toBe("BLOCKED: nope");
		expect(rec?.tool_use_id).toBe("tu_9");
		expect(rec?.guard_harness_ms).toBe(12);
	});

	it("maps an allow-with-warnings decision to a guard_warn record", () => {
		const rec = mapDecisionToGuardRecord(ev(), dec({ warnings: ["w1", "w2"] }), "/repo");
		expect(rec?.type).toBe("guard_warn");
		expect(rec?.guard_warnings).toEqual(["w1", "w2"]);
		expect(rec?.summary).toContain("w1");
	});

	it("returns null for a bare allow (derivable from absence; keeps the log lean)", () => {
		expect(mapDecisionToGuardRecord(ev(), dec(), "/repo")).toBeNull();
	});

	it("maps an ask decision to guard_block", () => {
		const rec = mapDecisionToGuardRecord(ev(), dec({ decision: "ask", reason: "confirm?" }), "/repo");
		expect(rec?.type).toBe("guard_block");
	});
});

describe("writeGuardDecisionRecord -- round-trips through readLocalActivity", () => {
	it("a block decision is written and read back as a guard_block", () => {
		const dir = mkdtempSync(join(tmpdir(), "guard-writer-"));
		try {
			writeGuardDecisionRecord(
				ev({ tool_name: "Bash", cwd: dir, session_id: "rt", tool_use_id: "tu_1" }),
				dec({ decision: "block", reason: "BLOCKED: x", rule_id: "destructive" }),
				dir,
			);
			const recs = readLocalActivity({ cwd: dir });
			expect(recs.length).toBe(1);
			expect(recs[0]?.type).toBe("guard_block");
			expect(recs[0]?.guard_rule_id).toBe("destructive");
			expect(recs[0]?.tool_use_id).toBe("tu_1");
			expect(verifyAuditChain(dir)).toMatchObject({
				valid: true,
				guard_events: 1,
				chained_events: 1,
				unchained_guard_events: 0,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a bare allow writes nothing (best-effort, never throws)", () => {
		const dir = mkdtempSync(join(tmpdir(), "guard-writer-"));
		try {
			expect(() => writeGuardDecisionRecord(ev({ cwd: dir }), dec(), dir)).not.toThrow();
			expect(readLocalActivity({ cwd: dir })).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
