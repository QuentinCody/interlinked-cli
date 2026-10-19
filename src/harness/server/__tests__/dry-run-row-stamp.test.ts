// U3c (2026-10-08): `interlinked harness test` probes reached activity.jsonl as
// ordinary tool rows (session "cli-test", no tool_use_id, no blocked flag), so a
// log reader counted `rm -rf /` probes as allowed executions. Every row the
// daemon writes for such an event now carries `dry_run: true` — the SAME
// `HarnessEvent.dry_run` flag the persisting evaluators honor.
import { describe, expect, it } from "vitest";
import { buildHarnessTestEvent } from "../../../commands/harness-test-event.js";
import { buildCollectionRecord } from "../../../lib/collection/builder.js";
import type { HarnessEvent } from "../../types.js";
import { mapDecisionToGuardRecord, mapEventToActivityRecord } from "../activity-writer.js";
import { mapEventToCollectionInput } from "../collection-writer.js";

function probe(): HarnessEvent {
	// The real probe payload, as the CLI sends it over the socket.
	const { event } = buildHarnessTestEvent({ kind: "bash", toolName: "Bash", command: "rm -rf /" });
	return event as unknown as HarnessEvent;
}

function live(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse", session_id: "s1", agent_source: "claude",
		timestamp: "2026-10-08T00:00:00.000Z", tool_name: "Bash",
		tool_input: { command: "rm -rf /" }, tool_use_id: "toolu_1", ...partial,
	};
}

describe("dry_run row stamp — positive (must fire)", () => {
	it("P1: the probe event uses the evaluators' flag name, dry_run: true", () => {
		expect(probe().dry_run).toBe(true);
	});
	it("P2: the activity tool_use_start row for a probe carries dry_run: true", () => {
		expect(mapEventToActivityRecord(probe(), "/repo")).toMatchObject({ type: "tool_use_start", session: "cli-test", dry_run: true });
	});
	it("P3: the guard_block row for a probe carries dry_run: true", () => {
		const rec = mapDecisionToGuardRecord(probe(), { decision: "block", reason: "BLOCKED: rm -rf" }, "/repo");
		expect(rec).toMatchObject({ type: "guard_block", dry_run: true });
	});
	it("P4: the collection.v1 record for a probe carries dry_run: true", () => {
		const rec = buildCollectionRecord(mapEventToCollectionInput(probe(), "/repo"));
		expect(rec).toMatchObject({ phase: "pre", dry_run: true });
	});
});

describe("dry_run row stamp — negative (must not fire)", () => {
	it("N1: a real tool row carries no dry_run field at all", () => {
		const rec = mapEventToActivityRecord(live(), "/repo");
		expect(rec).not.toBeNull();
		expect(rec && "dry_run" in rec).toBe(false);
	});
	it("N2: an explicit dry_run: false is not stamped", () => {
		const guard = mapDecisionToGuardRecord(live({ dry_run: false }), { decision: "block", reason: "x" }, "/repo");
		expect(guard && "dry_run" in guard).toBe(false);
	});
	it("N3: a real collection record carries no dry_run field", () => {
		const rec = buildCollectionRecord(mapEventToCollectionInput(live(), "/repo"));
		expect(rec && "dry_run" in rec).toBe(false);
	});
});
