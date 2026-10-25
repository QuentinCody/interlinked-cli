// Mutation-hardening tests for ../activity-writer.ts (Campaign A, 2026-10-21).
// Each case pins one behavior that a single-change mutant of the module left
// undetected by the sibling tests.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLocalActivity } from "../../../lib/local-activity.js";
import { recurrencesPath } from "../../recurrence.js";
import type { HarnessDecision, HarnessEvent } from "../../types.js";
import {
	mapDecisionToGuardRecord,
	mapEventToActivityRecord,
	mapLifecycleEventToActivityRecord,
	writeGuardDecisionRecord,
} from "../activity-writer.js";

function ev(partial: Record<string, unknown> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "sess-mut",
		agent_source: "claude",
		timestamp: "2026-10-21T00:00:00.000Z",
		...partial,
	} as HarnessEvent;
}

function dec(partial: Partial<HarnessDecision> = {}): HarnessDecision {
	return { decision: "allow", ...partial };
}

function lifecycle(hook: string, partial: Record<string, unknown> = {}, decision?: HarnessDecision) {
	return mapLifecycleEventToActivityRecord(ev({ hook_event: hook, ...partial }), "/r", decision);
}

describe("lifecycle summaries and tool labels", () => {
	it("skips an empty-string field and uses the next summary field", () => {
		const rec = lifecycle("Stop", { tool_input: { stop_reason: "", reason: "done" } });
		expect(rec?.summary).toBe("done");
	});

	it("truncates a user_prompt summary to exactly 200 chars but keeps the full prompt", () => {
		const prompt = "p".repeat(250);
		const rec = lifecycle("UserPromptSubmit", { prompt });
		expect(rec?.summary).toBe("p".repeat(200));
		expect(rec?.prompt).toBe(prompt);
	});

	it("truncates a field-derived lifecycle summary to exactly 200 chars", () => {
		const rec = lifecycle("Notification", { tool_input: { notification_message: "n".repeat(300) } });
		expect(rec?.summary).toBe("n".repeat(200));
	});

	it("summarizes a permission_request by its tool input and labels it with the tool name", () => {
		const rec = lifecycle("PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls -la" } });
		expect(rec?.summary).toBe("ls -la");
		expect(rec?.tool).toBe("Bash");
	});

	it("labels teammate_idle with the teammate name and model_response with the model", () => {
		expect(lifecycle("TeammateIdle", { teammate_name: "bob" })?.tool).toBe("bob");
		expect(lifecycle("AfterModel", { model: "model-x" })?.tool).toBe("model-x");
	});

	it("does not copy empty-string payload fields onto the record", () => {
		const rec = lifecycle("SessionStart", { source: "" });
		expect(rec).not.toBeNull();
		expect(rec && "source" in rec).toBe(false);
	});

	it("uses an empty prompt and no scrub flag for a prompt event with no prompt and no decision", () => {
		const rec = lifecycle("UserPromptSubmit");
		expect(rec?.prompt).toBe("");
		expect(rec?.summary).toBeNull();
		expect(rec && "scrubbed" in rec).toBe(false);
	});

	it("marks a prompt as scrubbed even when the redacted prompt is the empty string", () => {
		const rec = lifecycle("UserPromptSubmit", { prompt: "secret" }, dec({ redacted_prompt: "" }));
		expect(rec?.scrubbed).toBe(true);
		expect(rec?.prompt).toBe("");
	});

	it("flags an Interrupt record with is_interrupt", () => {
		expect(lifecycle("Interrupt")?.is_interrupt).toBe(true);
	});

	it("keeps seq 0 on a lifecycle record", () => {
		expect(lifecycle("Stop", { seq: 0 })?.seq).toBe(0);
	});
});

describe("tool summary precedence", () => {
	const summaryOf = (tool_input: Record<string, unknown>) =>
		mapEventToActivityRecord(ev({ tool_name: "T", tool_input }), "/r")?.summary;

	it("prefers file_path over path over notebook_path", () => {
		expect(summaryOf({ file_path: "/f", path: "/p", notebook_path: "/n" })).toBe("/f");
		expect(summaryOf({ path: "/p", notebook_path: "/n" })).toBe("/p");
	});

	it("falls back to notebook_path when it is the only path-like field", () => {
		expect(summaryOf({ notebook_path: "/nb.ipynb" })).toBe("/nb.ipynb");
	});

	it("prefers pattern over query, and uses query when pattern is absent", () => {
		expect(summaryOf({ pattern: "pat", query: "qry" })).toBe("pat");
		expect(summaryOf({ query: "qry" })).toBe("qry");
	});

	it("keeps seq 0 on a tool record", () => {
		expect(mapEventToActivityRecord(ev({ seq: 0 }), "/r")?.seq).toBe(0);
	});
});

describe("workspace key precedence", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "aw-mut-keys-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("prefers default_workspace_key over workspace_id when both are configured", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "config.json"), JSON.stringify({ default_workspace_key: "ws-default" }));
		writeFileSync(join(dir, ".interlinked", "config.local.json"), JSON.stringify({ workspace_id: "ws-id" }));
		const rec = mapEventToActivityRecord(ev({ cwd: dir }), dir);
		expect(rec?.workspace_key).toBe("ws-default");
	});
});

describe("guard record mapping", () => {
	it("records an allow carrying exactly one warning as guard_warn", () => {
		const rec = mapDecisionToGuardRecord(ev(), dec({ warnings: ["only"] }), "/r");
		expect(rec?.type).toBe("guard_warn");
	});

	it("uses the reason, not the warnings, as the summary when both exist", () => {
		const rec = mapDecisionToGuardRecord(ev(), dec({ decision: "block", reason: "why", warnings: ["w"] }), "/r");
		expect(rec?.summary).toBe("why");
	});

	it("uses null (not undefined) for an absent rule id and absent warnings", () => {
		const rec = mapDecisionToGuardRecord(ev(), dec({ decision: "block" }), "/r");
		expect(rec?.guard_rule_id).toBeNull();
		expect(rec?.guard_warnings).toBeNull();
	});

	it("keeps seq 0 and a 0ms harness timing", () => {
		const rec = mapDecisionToGuardRecord(ev({ seq: 0 }), dec({ decision: "block", checks_timing_ms: 0 }), "/r");
		expect(rec?.seq).toBe(0);
		expect(rec?.guard_harness_ms).toBe(0);
	});
});

describe("writeGuardDecisionRecord — persisted side effects", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "aw-mut-guard-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("persists the captured warning list (empty array for a block without warnings)", () => {
		writeGuardDecisionRecord(ev({ cwd: dir }), dec({ decision: "block", reason: "no" }), dir);
		const recs = readLocalActivity({ cwd: dir });
		expect(recs).toHaveLength(1);
		expect(recs[0]?.guard_warnings).toEqual([]);
	});

	it("feeds a refused rule into the recurrence ledger", () => {
		writeGuardDecisionRecord(
			ev({ cwd: dir, tool_name: "Bash", tool_input: { command: "rm x" } }),
			dec({ decision: "block", reason: "BLOCKED", rule_id: "rule-recur" }),
			dir,
		);
		const path = recurrencesPath(dir);
		expect(existsSync(path)).toBe(true);
	});
});
