import { describe, expect, it } from "vitest";
import type { ScenarioVerdict } from "./qualify.js";
import { StopReminderMemory, stopSummary } from "./stop-summary.js";

const dims: ScenarioVerdict["dimensions"] = { execution: "passed", provenance: "matched", boundary: "process-driver", authority: "accepted", scope: "complete", completion: "complete", sensitivity: "not-required", stability: "not-required", observations: "not-required" };
const open = (id: string, status: ScenarioVerdict["status"], message = "no way"): ScenarioVerdict => ({ key: `p/${id}`, projectId: "p", scenarioId: id, required: true, satisfied: false, status, generation: `g-${id}`, reasons: [{ code: "CASE_FAILED", message }], advisories: [], dimensions: dims });

describe("stopSummary next action", () => {
	// test-contract: boundary — a mixed set (one unavailable, one runnable) is not a handoff, it names the run command
	it("tells the agent to run the first scenario when only some open scenarios are unavailable", () => {
		const line = stopSummary([open("a", "unavailable", "cargo missing"), open("b", "failed")], new StopReminderMemory(), "s1");
		expect(line).toContain("Run: interlinked tests e2e run --project p --scenario a");
		expect(line).not.toContain("hand off");
		expect(line).not.toContain("cargo missing");
	});
});
