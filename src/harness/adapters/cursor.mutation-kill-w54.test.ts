import { nonNull } from "../../lib/non-null.js";
import { flatHookSettings, outputString } from "./test-output.js";
import { describe, expect, it } from "vitest";
import { createCursorAdapter } from "./cursor.js";
import type { UnifiedHookEvent } from "../unified-event.js";
import type { HarnessDecision } from "../types.js";

function baseEvent(nativeEvent: string): UnifiedHookEvent {
	return {
		schema_version: "1",
		event_id: "e1",
		session_id: "s1",
		ts: new Date().toISOString(),
		runner: "cursor",
		runner_native_event: nativeEvent,
		phase: "pre-tool",
		action: { kind: "other", subkind: nativeEvent, data: {} },
		context: { cwd: "/tmp" },
		raw: {},
	};
}

describe("createCursorAdapter — classifyToolClass overrides (mutantId aaec67830947d129)", () => {
	// positive — with an override configured, an overridden tool name must
	// resolve to the override's class, not the built-in classifier's guess.
	it("P1: passes opts.overrides through to the classifier when set", () => {
		const adapter = createCursorAdapter({
			overrides: {
				tool_name_classes: { MyWeirdTool: "read" },
				command_substrings: [],
			},
		});
		const result = adapter.classifyToolClass("MyWeirdTool", {});
		expect(result).toBe("read");
	});

	// negative — with no overrides configured, the same tool name must NOT
	// hit the override branch (mutant {} would make this also pass by
	// accident only if the override happened to coincide — so we pick a
	// name whose built-in classification is provably different from the
	// override value used above).
	it("N1: does not apply an override when opts.overrides is undefined", () => {
		const adapter = createCursorAdapter({});
		const result = adapter.classifyToolClass("MyWeirdTool", {});
		expect(result).not.toBe("read");
	});
});

describe("createCursorAdapter — encodeDecision allow additional_context (mutantId 0983b06ba039a607)", () => {
	// The ConditionalExpression mutant replaces `decision.additional_context`
	// (truthy check) with `true`, which would make the additional_context
	// branch fire even when additional_context is falsy/empty — collapsing
	// the "no context, gated event" branch into "emit additional_context".
	it("P1: postToolUse allow WITH additional_context emits it in stdout", () => {
		const adapter = createCursorAdapter({});
		const decision: HarnessDecision = { decision: "allow", additional_context: "hello" };
		const out = adapter.encodeDecision(decision, baseEvent("postToolUse"));
		expect(out.stdout).toBe(JSON.stringify({ additional_context: "hello" }));
	});

	it("N1: postToolUse allow WITHOUT additional_context does NOT emit that key (falls through)", () => {
		const adapter = createCursorAdapter({});
		const decision: HarnessDecision = { decision: "allow" };
		const out = adapter.encodeDecision(decision, baseEvent("postToolUse"));
		// postToolUse is not in GATED_EVENTS, so with no additional_context we
		// must fall to stderrOut (stdout undefined), not a JSON payload.
		expect(out.stdout).toBeUndefined();
	});
});

describe("createCursorAdapter — ask/reason separators use real newlines (mutantId ea43b396ed2b36cf)", () => {
	it("joins multiple warnings with a newline character, not an empty string", () => {
		const adapter = createCursorAdapter({});
		const decision: HarnessDecision = {
			decision: "allow",
			warnings: ["warning one", "warning two"],
		};
		const out = adapter.encodeDecision(decision, baseEvent("stop"));
		expect(out.stderr).toBe("warning one\nwarning two");
		expect(out.stderr).not.toBe("warning onewarning two");
	});
});

describe("createCursorAdapter — NATIVE_EVENTS string contents (mutantIds 40f49ee1/4d4c295c/2d987ec2/9dde065c/d6f635f7/b6f49912/25e215c3/9a131e73/36e8c7bf/1fd7b30b/93c91cd1/3044b59c/c358e160/1f5122aa/46a7bd81/fe5f5d3a)", () => {
	it("nativeEventNames contains the exact literal event names, not empty strings", () => {
		const adapter = createCursorAdapter({});
		const names = adapter.nativeEventNames;
		expect(names).toContain("beforeMcpToolExecution");
		expect(names).toContain("beforeMCPExecution");
		expect(names).toContain("afterMCPExecution");
		expect(names).toContain("afterMcpToolExecution");
		expect(names).toContain("sessionStart");
		expect(names).toContain("sessionEnd");
		expect(names).toContain("stop");
		expect(names).toContain("preCompact");
		expect(names).toContain("beforeSubmitPrompt");
		expect(names).toContain("beforeShellExecution");
		expect(names).toContain("afterShellExecution");
		expect(names).toContain("beforeReadFile");
		expect(names).toContain("afterFileEdit");
		expect(names).toContain("preToolUse");
		expect(names).toContain("postToolUse");
		expect(names).toContain("postToolUseFailure");
		expect(names).toContain("subagentStart");
		expect(names).toContain("subagentStop");
		expect(names).not.toContain("");
		expect(names.length).toBe(18);
	});

	it("parseHookInput resolves the correct phase for every distinguishing native event", () => {
		const adapter = createCursorAdapter({});
		const cases: Array<[string, string]> = [
			["sessionStart", "session-start"],
			["sessionEnd", "session-end"],
			["stop", "stop"],
			["preCompact", "pre-compact"],
			["beforeSubmitPrompt", "user-prompt"],
			["beforeShellExecution", "pre-tool"],
			["afterShellExecution", "post-tool"],
			["beforeMCPExecution", "pre-tool"],
			["afterMCPExecution", "post-tool"],
			["beforeReadFile", "pre-tool"],
			["afterFileEdit", "post-tool"],
			["preToolUse", "pre-tool"],
			["postToolUse", "post-tool"],
			["postToolUseFailure", "post-tool"],
			["subagentStart", "pre-tool"],
			["subagentStop", "subagent-stop"],
		];
		for (const [event, expectedPhase] of cases) {
			const parsed = adapter.parseHookInput({}, event);
			expect(parsed.phase, `phase for ${event}`).toBe(expectedPhase);
		}
		// An unmapped event name must default to "other" (PHASE_MAP fallback),
		// which also proves the map keys are the real literal strings above —
		// if any PHASE_MAP key were mutated to "", it would leak into the
		// default bucket and the mapped case would silently become "other" too,
		// which the per-event assertions above already catch case-by-case.
		const unknown = adapter.parseHookInput({}, "totally-unknown-event");
		expect(unknown.phase).toBe("other");
	});
});

describe("createCursorAdapter — adapter identity (mutantId 0dbd718ed0187610)", () => {
	it("label is 'Cursor', not an empty string", () => {
		const adapter = createCursorAdapter({});
		expect(adapter.label).toBe("Cursor");
		expect(adapter.label).not.toBe("");
	});
});

describe("createCursorAdapter — settings fragment (mutantIds 59b867fbf6edcc8a/44d92293572c51b4/260b80030fa10f90/5f63bc77e11a5563/54bdf9eb57c9b89e/fbd0134a832bd175)", () => {
	it("renderSettingsFragment returns version 1, mergeStrategy array-append, real hook entries", () => {
		const adapter = createCursorAdapter({});
		const frag = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "user");
		const fragment = flatHookSettings(frag.fragment);
		expect(fragment.version).toBe(1);
		expect(frag.mergeStrategy).toBe("array-append");
		expect(frag.mergeStrategy).not.toBe("");

		const preToolEntries = fragment.hooks.preToolUse;
		expect(preToolEntries).toBeDefined();
		const entry = nonNull(preToolEntries?.[0]);
		expect(entry.type).toBe("command");
		expect(entry.type).not.toBe("");
		expect(typeof entry.command).toBe("string");
		expect(outputString(entry.command).length).toBeGreaterThan(0);
		expect(entry.failClosed).toBe(true);
	});
});

describe("createCursorAdapter — buildCursorAction override plumbing (isObject predicate, mutantId 64e37cf82e6447e4)", () => {
	// isObject's typeof-object check gates whether raw hook JSON is treated
	// as an object vs coerced to {}. Feeding a non-object native payload
	// exercises the false branch of `typeof v === "object"`; the true-mutant
	// would treat a string payload as an object too and skip the `raw = {}`
	// fallback, changing what parseHookInput reads session_id/cwd from.
	it("parseHookInput falls back to defaults when nativeJson is not an object (a string)", () => {
		const adapter = createCursorAdapter({});
		const parsed = adapter.parseHookInput("not-an-object", "sessionStart");
		expect(parsed.session_id).toBe("unknown");
		expect(parsed.raw).toEqual({});
	});

	it("parseHookInput reads through real object payloads (object branch true)", () => {
		const adapter = createCursorAdapter({});
		const parsed = adapter.parseHookInput({ session_id: "abc123" }, "sessionStart");
		expect(parsed.session_id).toBe("abc123");
	});
});
