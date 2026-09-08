import { nestedHookSettings, outputObject } from "./test-output.js";
import { nonNull } from "../../lib/non-null.js";
import { assert, describe, expect, it } from "vitest";
import type { HarnessDecision } from "../types.js";
import { createGeminiCliAdapter } from "./gemini-cli.js";

describe("createGeminiCliAdapter — positive (must fire)", () => {
	// test-contract: public-api — createGeminiCliAdapter's returned object
	// literal must carry its documented static identity fields.
	it("returns an adapter with the expected static shape (id/label/experimental)", () => {
		const adapter = createGeminiCliAdapter();
		expect(adapter.id).toBe("gemini-cli");
		expect(adapter.label).toBe("Gemini CLI");
		expect(adapter.experimental).toBe(true);
		expect(adapter.nativeEventNames).toContain("BeforeTool");
	});

	// test-contract: public-api — classifyToolClass must forward opts.overrides
	// into classifyFromToolName; dropping it silently falls back to defaults.
	it("classifyToolClass: an override tool_name_classes entry wins over the default", () => {
		const withOverride = createGeminiCliAdapter({
			overrides: { tool_name_classes: { customtool: "side-effect" }, command_substrings: [] },
		});
		expect(withOverride.classifyToolClass("customtool", {})).toBe("side-effect");
	});

	// test-contract: public-api — without an overrides object, an unrecognized
	// tool name with no command field falls through to the safe default.
	it("classifyToolClass: with no overrides, an unrecognized tool name classifies as 'modify'", () => {
		const withoutOverride = createGeminiCliAdapter();
		expect(withoutOverride.classifyToolClass("customtool", {})).toBe("modify");
	});

	// test-contract: public-api — parseHookInput's returned envelope pins
	// schema_version and runner to fixed protocol string literals.
	it("parseHookInput: schema_version is exactly '1' and runner is exactly 'gemini-cli'", () => {
		const adapter = createGeminiCliAdapter();
		const event = adapter.parseHookInput({}, "AfterModel");
		expect(event.schema_version).toBe("1");
		expect(event.runner).toBe("gemini-cli");
	});

	// test-contract: public-api — PHASE_MAP entry for AfterTool.
	it("parseHookInput: AfterTool maps to phase 'post-tool'", () => {
		const adapter = createGeminiCliAdapter();
		const event = adapter.parseHookInput({}, "AfterTool");
		expect(event.phase).toBe("post-tool");
	});

	// test-contract: public-api — PHASE_MAP entry for AfterModel.
	it("parseHookInput: AfterModel maps to the model response boundary", () => {
		const adapter = createGeminiCliAdapter();
		const event = adapter.parseHookInput({}, "AfterModel");
		expect(event.phase).toBe("post-model");
		expect(event.observation).toEqual({ kind: "model", boundary: "after_response" });
	});

	// test-contract: public-api — BeforeTool must build a tool_call action.
	it("parseHookInput: BeforeTool builds a tool_call action", () => {
		const adapter = createGeminiCliAdapter();
		const event = adapter.parseHookInput({ tool_name: "Bash" }, "BeforeTool");
		expect(event.action.kind).toBe("tool_call");
	});

	// test-contract: public-api — AfterTool must copy tool_response through
	// onto the built tool_call action.
	it("parseHookInput: AfterTool sets tool_response from raw", () => {
		const adapter = createGeminiCliAdapter();
		const event = adapter.parseHookInput(
			{ tool_name: "Bash", tool_response: "ok", tool_error: "boom" },
			"AfterTool",
		);
		assert(event.action.kind === "tool_call");
		expect(event.action.tool_response).toBe("ok");
	});

	// test-contract: public-api — AfterTool must copy tool_error through
	// onto the built tool_call action.
	it("parseHookInput: AfterTool sets tool_error from raw", () => {
		const adapter = createGeminiCliAdapter();
		const event = adapter.parseHookInput(
			{ tool_name: "Bash", tool_response: "ok", tool_error: "boom" },
			"AfterTool",
		);
		assert(event.action.kind === "tool_call");
		expect(event.action.tool_error).toBe("boom");
	});

	// test-contract: public-api — PreCompress must produce subkind 'pre_compact'.
	it("parseHookInput: PreCompress produces subkind 'pre_compact'", () => {
		const adapter = createGeminiCliAdapter();
		const raw = { some: "field" };
		const event = adapter.parseHookInput(raw, "PreCompress");
		assert(event.action.kind === "other");
		expect(event.action.kind).toBe("other");
		expect(event.action.subkind).toBe("pre_compact");
	});

	// test-contract: public-api — PreCompress must attach raw as the action's data.
	it("parseHookInput: PreCompress attaches raw as action.data", () => {
		const adapter = createGeminiCliAdapter();
		const raw = { some: "field" };
		const event = adapter.parseHookInput(raw, "PreCompress");
		assert(event.action.kind === "other");
		expect(event.action.data).toEqual(raw);
	});

	// test-contract: public-api — any unrecognized native event name falls
	// through to kind 'other' with subkind equal to the event name itself.
	it("parseHookInput: an unrecognized native event name yields subkind = event name", () => {
		const adapter = createGeminiCliAdapter();
		const event = adapter.parseHookInput({}, "SomeUnknownEvent");
		assert(event.action.kind === "other");
		expect(event.action.kind).toBe("other");
		expect(event.action.subkind).toBe("SomeUnknownEvent");
	});

	// test-contract: invariant — isObject must reject a non-object (string)
	// input so `raw` becomes {} rather than the string itself.
	it("parseHookInput: a string nativeJson is coerced to raw = {}", () => {
		const adapter = createGeminiCliAdapter();
		const event = adapter.parseHookInput("not-an-object", "AfterModel");
		expect(event.raw).toEqual({});
	});

	// test-contract: invariant — isObject must reject arrays specifically
	// (typeof [] === "object" but Array.isArray must still exclude it).
	it("parseHookInput: an array nativeJson is coerced to raw = {}", () => {
		const adapter = createGeminiCliAdapter();
		const event = adapter.parseHookInput([1, 2, 3], "AfterModel");
		expect(event.raw).toEqual({});
	});

	// test-contract: invariant — readString must reject non-string values so
	// a numeric session_id falls back to the "unknown" default.
	it("parseHookInput: a non-string session_id falls back to 'unknown'", () => {
		const adapter = createGeminiCliAdapter();
		const event = adapter.parseHookInput({ session_id: 12345 }, "AfterModel");
		expect(event.session_id).toBe("unknown");
	});

	// test-contract: invariant — readString must accept an actual string
	// session_id unchanged.
	it("parseHookInput: a string session_id is accepted as-is", () => {
		const adapter = createGeminiCliAdapter();
		const event = adapter.parseHookInput({ session_id: "abc-123" }, "AfterModel");
		expect(event.session_id).toBe("abc-123");
	});

	// test-contract: public-api — renderSettingsFragment must emit exactly one
	// { command } entry per native event, embedding the runner id "gemini-cli".
	it("renderSettingsFragment: each native event maps to exactly one hook command entry", () => {
		const adapter = createGeminiCliAdapter();
		const fragment = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "project");
		const hooks = (nestedHookSettings(fragment.fragment)).hooks;
		for (const event of adapter.nativeEventNames) {
			const entries = hooks[event];
			expect(entries).toHaveLength(1);
		}
	});

	// test-contract: public-api — buildHookCommand embeds the runner id
	// literally passed at the call site ("gemini-cli"), not the empty string.
	it("renderSettingsFragment: the hook command string embeds the runner id 'gemini-cli'", () => {
		const adapter = createGeminiCliAdapter();
		const fragment = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "project");
		const hooks = (nestedHookSettings(fragment.fragment)).hooks;
		const entry = hooks.BeforeTool;
		expect(entry?.[0]?.hooks[0]?.command).toContain("gemini-cli");
	});

	// test-contract: public-api — buildHookCommand embeds the binary path
	// literally passed at the call site.
	it("renderSettingsFragment: the hook command string embeds the binary path", () => {
		const adapter = createGeminiCliAdapter();
		const fragment = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "project");
		const hooks = (nestedHookSettings(fragment.fragment)).hooks;
		const entry = hooks.BeforeTool;
		expect(entry?.[0]?.hooks[0]?.command).toContain("/usr/local/bin/interlinked-hook");
	});

	// test-contract: public-api — a block decision with warnings must set both
	// the JSON reason and a stderr string joined from those warnings.
	it("encodeDecision: block with warnings sets stdout reason and joined stderr", () => {
		const adapter = createGeminiCliAdapter();
		const decision: HarnessDecision = {
			decision: "block",
			reason: "nope",
			warnings: ["w1", "w2"],
		};
		const out = adapter.encodeDecision(decision, adapter.parseHookInput({}, "BeforeTool"));
		expect(out.exit_code).toBe(0);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({ decision: "deny", reason: "nope" });
		expect(out.stderr).toBe("w1\nw2");
	});

	// test-contract: invariant — `stderr || undefined` must yield undefined
	// (not the empty string, and not a hardcoded true/false) when there are
	// no warnings to report.
	it("encodeDecision: block with no warnings has stderr undefined, not an empty string", () => {
		const adapter = createGeminiCliAdapter();
		const decision: HarnessDecision = { decision: "block", reason: "nope", warnings: [] };
		const out = adapter.encodeDecision(decision, adapter.parseHookInput({}, "BeforeTool"));
		expect(out.stderr).toBeUndefined();
	});

	// test-contract: public-api — a block decision missing `reason` must fall
	// back to the harness-bug explanatory string, not an empty message.
	it("encodeDecision: block without a reason falls back to the harness-bug explanatory message", () => {
		const adapter = createGeminiCliAdapter();
		const decision: HarnessDecision = { decision: "block", warnings: [] };
		const out = adapter.encodeDecision(decision, adapter.parseHookInput({}, "BeforeTool"));
		const parsed = outputObject(JSON.parse(nonNull(out.stdout)));
		expect(parsed.reason).toContain("Blocked by the interlinked harness");
	});

	// test-contract: public-api — an ask decision must conservatively deny and carry
	// its own reason plus warnings via stderr, distinct from block/allow.
	it("encodeDecision: ask decision conservatively denies, exit_code 0, and reports warnings via stderr", () => {
		const adapter = createGeminiCliAdapter();
		const decision: HarnessDecision = { decision: "ask", reason: "confirm?", warnings: ["hey"] };
		const out = adapter.encodeDecision(decision, adapter.parseHookInput({}, "BeforeTool"));
		expect(out.exit_code).toBe(0);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({ decision: "deny", reason: "confirm?" });
		expect(out.stderr).toBe("hey");
	});

	// test-contract: invariant — an allow decision with no warnings must have
	// stderr undefined, exercising the same `stderr || undefined` branch as
	// block/ask but on the final fallthrough return.
	it("encodeDecision: allow decision with no warnings has stderr undefined", () => {
		const adapter = createGeminiCliAdapter();
		const decision: HarnessDecision = { decision: "allow", warnings: [] };
		const out = adapter.encodeDecision(decision, adapter.parseHookInput({}, "BeforeTool"));
		expect(out.exit_code).toBe(0);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({});
		expect(out.stderr).toBeUndefined();
	});

	// test-contract: invariant — an allow decision WITH warnings must still
	// join them into stderr rather than yielding undefined or a boolean.
	it("encodeDecision: allow decision with warnings joins them into stderr", () => {
		const adapter = createGeminiCliAdapter();
		const decision: HarnessDecision = { decision: "allow", warnings: ["only-warning"] };
		const out = adapter.encodeDecision(decision, adapter.parseHookInput({}, "BeforeTool"));
		expect(out.stderr).toBe("only-warning");
	});
});
