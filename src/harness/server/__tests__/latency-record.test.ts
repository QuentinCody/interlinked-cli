import { describe, expect, it } from "vitest";
import type { HarnessDecision } from "../../types.js";
import { buildLatencyRecord } from "../latency-record.js";

function decision(partial: Partial<HarnessDecision> = {}): HarnessDecision {
	return { decision: "allow", ...partial };
}

describe("buildLatencyRecord", () => {
	it("extracts event metadata from the raw line", () => {
		const line = JSON.stringify({
			hook_event: "PostToolUse",
			tool_name: "Bash",
			session_id: "sess-9",
			agent_source: "claude",
		});
		const rec = buildLatencyRecord(line, decision({ decision: "block" }));
		expect(rec.hook_event).toBe("PostToolUse");
		expect(rec.tool_name).toBe("Bash");
		expect(rec.session_id).toBe("sess-9");
		expect(rec.agent_source).toBe("claude");
		expect(rec.decision).toBe("block");
	});

	it("carries timing and breakdown fields from the decision", () => {
		const rec = buildLatencyRecord(
			JSON.stringify({ hook_event: "PostToolUse" }),
			decision({
				checks_ran: ["tsc", "biome"],
				checks_timing_ms: 42,
				tool_breakdown: [{ tool: "tsc", ms: 30, finding_count: 1 }],
				phase_breakdown: { "quality-checks": 30 },
			}),
		);
		expect(rec.checks_ran).toEqual(["tsc", "biome"]);
		expect(rec.checks_timing_ms).toBe(42);
		expect(rec.tool_breakdown).toEqual([{ tool: "tsc", ms: 30, finding_count: 1 }]);
		expect(rec.phase_breakdown).toEqual({ "quality-checks": 30 });
	});

	it("defaults optional decision fields to null when absent", () => {
		const rec = buildLatencyRecord(JSON.stringify({ hook_event: "Stop" }), decision());
		expect(rec.checks_ran).toBeNull();
		expect(rec.checks_timing_ms).toBeNull();
		expect(rec.tool_breakdown).toBeNull();
		expect(rec.phase_breakdown).toBeNull();
	});

	it("nulls non-string event fields rather than passing through wrong types", () => {
		const line = JSON.stringify({ hook_event: 123, tool_name: null, session_id: {} });
		const rec = buildLatencyRecord(line, decision());
		expect(rec.hook_event).toBeNull();
		expect(rec.tool_name).toBeNull();
		expect(rec.session_id).toBeNull();
		expect(rec.agent_source).toBeNull();
	});

	it.each(["{not valid json", "null", "[]", "42", "true", '"event"'])("preserves decision metadata for a non-object event: %s", (line) => {
		const rec = buildLatencyRecord(line, decision({ decision: "block" }));
		expect(rec.hook_event).toBeNull();
		expect(rec.tool_name).toBeNull();
		expect(rec.session_id).toBeNull();
		expect(rec.agent_source).toBeNull();
		// decision metadata still comes through
		expect(rec.decision).toBe("block");
	});
});
