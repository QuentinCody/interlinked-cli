import { describe, expect, it } from "vitest";
import { applyEvent, createState } from "./state.js";
import type { ToolEvent } from "./types.js";

let seq = 0;
function nextId(): string { seq += 1; return `t${seq}`; }
function editEvents(file: string, oldStr: string, newStr: string): ToolEvent[] {
	const id = nextId();
	const input = { file_path: file, old_string: oldStr, new_string: newStr };
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool: "Edit", toolUseId: id, hook: "PreToolUse", input },
		{ ts: "2026-01-01T00:00:01Z", session: "s", agent: "a", tool: "Edit", toolUseId: id, hook: "PostToolUse", input, toolOutcome: "success", checkDecision: "allow", failedCheckIds: [] },
	];
}
function bashEvents(command: string, extra: Partial<ToolEvent> = {}): ToolEvent[] {
	const id = nextId();
	const input = { command };
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool: "Bash", toolUseId: id, hook: "PreToolUse", input, ...extra },
		{ ts: "2026-01-01T00:00:01Z", session: "s", agent: "a", tool: "Bash", toolUseId: id, hook: "PostToolUse", input, toolOutcome: "success", ...extra },
	];
}
function feed(events: ToolEvent[]) {
	const state = createState("s");
	for (const ev of events) applyEvent(state, ev);
	return state;
}

// Census fault: the serving-event reset dropped its `how !== "grew disabled_rules"`
// guard and survived the companion test (docs/reviews/kill-proof-census-e2e-structure.md).
describe("applyEvent — a serving daemon disproves an outage, never a weakened policy", () => {
	// test-contract: invariant — `harnessServing` only proves the socket/process is alive; a grown `disabled_rules` list is still in force on that daemon, so the record must survive a served event
	it("keeps the grew-disabled_rules record after an event the daemon served", () => {
		const state = feed([
			...editEvents("guard-rules.local.json", '{"version":1}', '{"version":1,"disabled_rules":["rm_rf_block"]}'),
			...bashEvents("ls", { harnessServing: true }),
		]);
		expect(state.harnessDisabled).toEqual({ atStep: 2, how: "grew disabled_rules" });
	});
	// test-contract: public-api — a socket-removal disable IS an outage claim, and a served event clears it
	it("clears a socket-removal record once the daemon serves an event", () => {
		const state = feed([...bashEvents("rm .interlinked/harness.sock"), ...bashEvents("ls", { harnessServing: true })]);
		expect(state.harnessDisabled).toBeNull();
	});
});
