import { makeGuardRules as completeGuardRulesConfigFixture } from "./evaluator/__tests__/fixtures.js";
import { afterEach, describe, expect, it, vi } from "vitest";

// The unified evaluator delegates the actual rule pipeline to
// `evaluatePreToolUse` / `evaluatePostToolUse` in `./evaluator.js`. We mock
// that module so the wrapper's own behaviour (phase routing, budget race,
// telemetry emission, decision flattening) can be driven deterministically
// without standing up the full reservation/cohort/graph machinery.
const preMock = vi.fn();
const postMock = vi.fn();
vi.mock("./evaluator.js", () => ({
	evaluatePreToolUse: (...args: unknown[]) => preMock(...args),
	evaluatePostToolUse: (...args: unknown[]) => postMock(...args),
}));

import { CohortManager } from "./cohort.js";
import {
	budgetFor,
	DEFAULT_BUDGETS,
	type EvaluateUnifiedContext,
	evaluateUnified,
	extractToolClassFromEvent,
	filterCheckResultsByToolClass,
	flattenFindings,
	toHarnessEvent,
	type UnifiedEvaluatorTelemetry,
} from "./evaluator-unified.js";
import { ReservationManager } from "./reservations.js";
import type { HarnessDecision } from "./types.js";
import type { UnifiedHookEvent } from "./unified-event.js";

function makeEvent(over: Partial<UnifiedHookEvent> = {}): UnifiedHookEvent {
	return {
		schema_version: "1",
		event_id: "evt-eval-1",
		session_id: "s",
		ts: "2026-04-23T00:00:00.000Z",
		runner: "claude-code",
		runner_native_event: "PreToolUse",
		phase: "pre-tool",
		action: {
			kind: "tool_call",
			tool_name: "edit",
			tool_class: "modify",
			tool_input: { file_path: "/repo/a.ts", old_string: "x", new_string: "y" },
			tool_input_redacted: {},
		},
		context: { cwd: "/repo" },
		raw: {},
		...over,
	};
}

// A minimal context. The reservation/cohort objects are never touched because
// the real evaluator is mocked out; they exist only to satisfy the type.
function makeCtx(over: Partial<EvaluateUnifiedContext> = {}): EvaluateUnifiedContext {
	const rules = ({ ...completeGuardRulesConfigFixture(), ...{ enabled: true } });
	return {
		rules,
		session: undefined,
		reservations: new ReservationManager(),
		cohort: new CohortManager(),
		...over,
	};
}

afterEach(() => {
	preMock.mockReset();
	postMock.mockReset();
	vi.useRealTimers();
});

describe("budgetFor", () => {
	it("returns the per-class budget", () => {
		expect(budgetFor("read")).toBe(DEFAULT_BUDGETS.read_budget_ms);
		expect(budgetFor("modify")).toBe(DEFAULT_BUDGETS.modify_budget_ms);
		expect(budgetFor("side-effect")).toBe(DEFAULT_BUDGETS.side_effect_budget_ms);
		expect(budgetFor("long-running")).toBe(DEFAULT_BUDGETS.long_running_budget_ms);
		expect(budgetFor("unknown")).toBe(DEFAULT_BUDGETS.unknown_budget_ms);
	});

	it("respects user-provided budgets", () => {
		const user = {
			read_budget_ms: 50,
			modify_budget_ms: 100,
			side_effect_budget_ms: 200,
			long_running_budget_ms: 500,
			unknown_budget_ms: 75,
		};
		expect(budgetFor("read", user)).toBe(50);
		expect(budgetFor("modify", user)).toBe(100);
		expect(budgetFor("side-effect", user)).toBe(200);
		expect(budgetFor("long-running", user)).toBe(500);
		expect(budgetFor("unknown", user)).toBe(75);
	});
});

describe("extractToolClassFromEvent", () => {
	it("reads tool_class from tool_call actions", () => {
		expect(extractToolClassFromEvent(makeEvent())).toBe("modify");
	});
	it("reads tool_class from shell_command", () => {
		const e = makeEvent({
			action: { kind: "shell_command", command: "ls", tool_class: "read" },
		});
		expect(extractToolClassFromEvent(e)).toBe("read");
	});
	it("reads tool_class from file_operation", () => {
		const e = makeEvent({
			action: {
				kind: "file_operation",
				operation: "read",
				path: "/a",
				tool_class: "read",
			},
		});
		expect(extractToolClassFromEvent(e)).toBe("read");
	});
	it("returns unknown for lifecycle actions", () => {
		const e = makeEvent({
			action: { kind: "session_lifecycle", event: "start" },
		});
		expect(extractToolClassFromEvent(e)).toBe("unknown");
	});
	it("returns unknown for user_prompt actions", () => {
		const e = makeEvent({ action: { kind: "user_prompt", text: "hi" } });
		expect(extractToolClassFromEvent(e)).toBe("unknown");
	});
	it("returns unknown for other actions", () => {
		const e = makeEvent({ action: { kind: "other", subkind: "ping", data: {} } });
		expect(extractToolClassFromEvent(e)).toBe("unknown");
	});
});

describe("toHarnessEvent — tool_call", () => {
	const event = makeEvent();
	const harness = toHarnessEvent(event);
	it("restores Claude-style capitalization", () => {
		expect(harness.tool_name).toBe("Edit");
	});
	it("preserves session_id and cwd", () => {
		expect(harness.session_id).toBe("s");
		expect(harness.cwd).toBe("/repo");
	});
	it("maps agent_source to claude for claude-code runner", () => {
		expect(harness.agent_source).toBe("claude");
	});
	it("preserves tool_input", () => {
		expect(harness.tool_input?.file_path).toBe("/repo/a.ts");
	});
	it("uses the native event name for claude-code", () => {
		expect(harness.hook_event).toBe("PreToolUse");
	});
	it("omits agent_name when no agent id is present", () => {
		expect(harness.agent_name).toBeUndefined();
	});
	it("omits tool_use_id when absent", () => {
		expect(harness.tool_use_id).toBeUndefined();
	});
});

describe("toHarnessEvent — optional carry-through fields", () => {
	it("carries agent.id into agent_name", () => {
		const event = makeEvent({ context: { cwd: "/repo", agent: { id: "agent-7" } } });
		expect(toHarnessEvent(event).agent_name).toBe("agent-7");
	});
	it("carries tool_use_id for delivery de-dup", () => {
		const event = makeEvent({ tool_use_id: "toolu_abc" });
		expect(toHarnessEvent(event).tool_use_id).toBe("toolu_abc");
	});
	it("carries tool_response when present (post phase)", () => {
		const event = makeEvent({
			phase: "post-tool",
			runner_native_event: "PostToolUse",
			action: {
				kind: "tool_call",
				tool_name: "read",
				tool_class: "read",
				tool_input: { file_path: "/a" },
				tool_input_redacted: {},
				tool_response: { ok: true },
			},
		});
		expect(toHarnessEvent(event).tool_response).toEqual({ ok: true });
	});
	it("omits tool_response when undefined", () => {
		const event = makeEvent();
		expect(toHarnessEvent(event).tool_response).toBeUndefined();
	});
	it("does not set agent_name when agent object has no id", () => {
		const event = makeEvent({ context: { cwd: "/repo", agent: { handle: "h" } } });
		expect(toHarnessEvent(event).agent_name).toBeUndefined();
	});
});

/** A post-phase Bash tool_call whose tool_response is the runner's raw object. */
function makeBashPostEvent(
	toolResponse: unknown,
	nativeEvent: "PostToolUse" | "PostToolUseFailure" = "PostToolUse",
	tool_error?: string,
): UnifiedHookEvent {
	return makeEvent({
		phase: "post-tool",
		runner_native_event: nativeEvent,
		action: {
			kind: "tool_call",
			tool_name: "bash",
			tool_class: "side-effect",
			tool_input: { command: "npx vitest run a.test.ts" },
			tool_input_redacted: {},
			tool_response: toolResponse,
			...(tool_error !== undefined ? { tool_error } : {}),
		},
	});
}

describe("toHarnessEvent — post-tool outcome evidence lift — positive (must lift)", () => {
	it("P1: lifts object-response stdout so the daemon can read a runner summary", () => {
		const out = toHarnessEvent(makeBashPostEvent({ stdout: "Tests  7 passed (7)" }));
		expect(out.stdout).toBe("Tests  7 passed (7)");
	});

	it("P2: lifts object-response stderr", () => {
		const out = toHarnessEvent(makeBashPostEvent({ stdout: "", stderr: "warning: x" }));
		expect(out.stderr).toBe("warning: x");
	});

	it("P3: lifts a numeric exitCode to exit_code", () => {
		const out = toHarnessEvent(makeBashPostEvent({ stdout: "", exitCode: 0 }));
		expect(out.exit_code).toBe(0);
	});

	it("P4: derives tool_outcome success from a marker-free PostToolUse object response", () => {
		const out = toHarnessEvent(makeBashPostEvent({ stdout: "ok" }));
		expect(out.tool_outcome).toBe("success");
	});

	it("P5: derives tool_outcome error from the PostToolUseFailure event name", () => {
		const out = toHarnessEvent(makeBashPostEvent({ stdout: "" }, "PostToolUseFailure"));
		expect(out.tool_outcome).toBe("error");
	});

	it("P6: keeps only the tail of an oversized stdout (runner summaries print last)", () => {
		const big = `${"x".repeat(20_000)}\nTests  7 passed (7)`;
		const out = toHarnessEvent(makeBashPostEvent({ stdout: big }));
		expect(out.stdout?.length).toBeLessThanOrEqual(8_192);
		expect(out.stdout?.endsWith("Tests  7 passed (7)")).toBe(true);
	});

	it("P7: carries the adapter's tool_error into error_message", () => {
		const out = toHarnessEvent(makeBashPostEvent({ stdout: "" }, "PostToolUseFailure", "boom"));
		expect(out.error_message).toBe("boom");
	});
});

describe("toHarnessEvent — post-tool outcome evidence lift — negative (must not misclassify)", () => {
	it("N1: a string tool_response gains no synthesized outcome fields", () => {
		const out = toHarnessEvent(makeBashPostEvent("plain text response"));
		expect(out.tool_outcome).toBeUndefined();
		expect(out.stdout).toBeUndefined();
	});

	it("N2: a pre-tool event gains no outcome fields", () => {
		const out = toHarnessEvent(makeEvent());
		expect(out.tool_outcome).toBeUndefined();
		expect(out.stdout).toBeUndefined();
		expect(out.exit_code).toBeUndefined();
	});

	it("N3: is_error true in the response object means error, never success", () => {
		const out = toHarnessEvent(makeBashPostEvent({ stdout: "ok", is_error: true }));
		expect(out.tool_outcome).toBe("error");
	});

	it("N4: a nonzero exit code means error even on a plain PostToolUse", () => {
		const out = toHarnessEvent(makeBashPostEvent({ stdout: "", exitCode: 1 }));
		expect(out.tool_outcome).toBe("error");
		expect(out.exit_code).toBe(1);
	});

	it("N5: interrupted true means interrupted, never success", () => {
		const out = toHarnessEvent(makeBashPostEvent({ stdout: "partial", interrupted: true }));
		expect(out.tool_outcome).toBe("interrupted");
	});

	it("N6: non-string stdout in the object is ignored rather than coerced", () => {
		const out = toHarnessEvent(makeBashPostEvent({ stdout: 42 }));
		expect(out.stdout).toBeUndefined();
		expect(out.tool_outcome).toBe("success");
	});
});

describe("toHarnessEvent — claude tool name mapping", () => {
	const cases: Array<[string, string]> = [
		["edit", "Edit"],
		["write", "Write"],
		["multi_edit", "MultiEdit"],
		["read", "Read"],
		["bash", "Bash"],
		["grep", "Grep"],
		["glob", "Glob"],
		["ls", "LS"],
		["notebook_edit", "NotebookEdit"],
		["web_fetch", "WebFetch"],
		["web_search", "WebSearch"],
		["todo_write", "TodoWrite"],
		["task", "Task"],
	];
	for (const [normalized, expected] of cases) {
		it(`maps ${normalized} → ${expected}`, () => {
			const event = makeEvent({
				action: {
					kind: "tool_call",
					tool_name: normalized,
					tool_class: "read",
					tool_input: {},
					tool_input_redacted: {},
				},
			});
			expect(toHarnessEvent(event).tool_name).toBe(expected);
		});
	}
	it("passes unknown claude tool names through unchanged", () => {
		const event = makeEvent({
			action: {
				kind: "tool_call",
				tool_name: "exotic_tool",
				tool_class: "read",
				tool_input: {},
				tool_input_redacted: {},
			},
		});
		expect(toHarnessEvent(event).tool_name).toBe("exotic_tool");
	});
});

describe("toHarnessEvent — copilot runner", () => {
	const event = makeEvent({
		runner: "copilot-cli",
		action: {
			kind: "tool_call",
			tool_name: "edit_file",
			tool_class: "modify",
			tool_input: { path: "/a" },
			tool_input_redacted: {},
		},
	});
	const harness = toHarnessEvent(event);
	it("maps agent_source to copilot", () => {
		expect(harness.agent_source).toBe("copilot");
	});
	it("leaves lowercase tool_name intact", () => {
		expect(harness.tool_name).toBe("edit_file");
	});
	it("derives hook_event from phase for non-claude runners", () => {
		expect(harness.hook_event).toBe("PreToolUse");
	});
});

describe("toHarnessEvent — delivery metadata", () => {
	it("carries the request-owned PostTool warning token through framed evaluation", () => {
		const harness = toHarnessEvent(
			makeEvent({
				post_delivery_token: "delivery-token-0001",
				post_delivery_pid: 4242,
				phase: "post-tool",
			}),
		);
		expect(harness.post_delivery_token).toBe("delivery-token-0001");
		expect(harness.post_delivery_pid).toBe(4242);
	});
});

describe("toHarnessEvent — runner attribution", () => {
	it.each([
		["claude-code", "claude"],
		["copilot-cli", "copilot"],
		["codex", "codex"],
		["gemini-cli", "gemini"],
		["cursor", "cursor"],
		["opencode", "opencode"],
		["pi", "pi"],
	] as const)("maps %s to %s", (runner, expected) => {
		expect(toHarnessEvent(makeEvent({ runner })).agent_source).toBe(expected);
	});
});

describe("toHarnessEvent — non-claude runner event-name mapping", () => {
	const phaseToName: Array<[UnifiedHookEvent["phase"], string]> = [
		["pre-tool", "PreToolUse"],
		["post-tool", "PostToolUse"],
		["session-start", "SessionStart"],
		["session-end", "SessionEnd"],
		["user-prompt", "UserPromptSubmit"],
		["pre-compact", "PreCompact"],
	];
	for (const [phase, name] of phaseToName) {
		it(`gemini ${phase} → ${name}`, () => {
			const event = makeEvent({
				runner: "gemini-cli",
				phase,
				runner_native_event: "ignored-native",
				action: { kind: "other", subkind: "x", data: {} },
			});
			expect(toHarnessEvent(event).hook_event).toBe(name);
		});
	}
	it("falls back to the native event name for unmapped phases", () => {
		const event = makeEvent({
			runner: "gemini-cli",
			phase: "stop",
			runner_native_event: "GeminiStop",
			action: { kind: "other", subkind: "x", data: {} },
		});
		expect(toHarnessEvent(event).hook_event).toBe("GeminiStop");
	});
});

describe("toHarnessEvent — shell_command", () => {
	const event = makeEvent({
		action: { kind: "shell_command", command: "rm -rf /x", tool_class: "side-effect" },
	});
	const harness = toHarnessEvent(event);
	it("uses Bash tool_name", () => {
		expect(harness.tool_name).toBe("Bash");
	});
	it("puts the command in tool_input", () => {
		expect(harness.tool_input?.command).toBe("rm -rf /x");
	});
	it("carries cwd into tool_input when supplied", () => {
		const e = makeEvent({
			action: { kind: "shell_command", command: "ls", cwd: "/sub", tool_class: "read" },
		});
		expect(toHarnessEvent(e).tool_input?.cwd).toBe("/sub");
	});
});

describe("toHarnessEvent — file_operation", () => {
	it("read → Read with file_path only", () => {
		const event = makeEvent({
			action: { kind: "file_operation", operation: "read", path: "/a", tool_class: "read" },
		});
		const harness = toHarnessEvent(event);
		expect(harness.tool_name).toBe("Read");
		expect(harness.tool_input?.file_path).toBe("/a");
		expect(harness.tool_input?.old_string).toBeUndefined();
		expect(harness.tool_input?.content).toBeUndefined();
	});
	it("edit → Edit with old_string and new_string", () => {
		const event = makeEvent({
			action: {
				kind: "file_operation",
				operation: "edit",
				path: "/a",
				old_string: "before",
				new_string: "after",
				tool_class: "modify",
			},
		});
		const harness = toHarnessEvent(event);
		expect(harness.tool_name).toBe("Edit");
		expect(harness.tool_input?.old_string).toBe("before");
		expect(harness.tool_input?.new_string).toBe("after");
	});
	it("write → Write with content", () => {
		const event = makeEvent({
			action: {
				kind: "file_operation",
				operation: "write",
				path: "/a",
				content: "hello",
				tool_class: "modify",
			},
		});
		const harness = toHarnessEvent(event);
		expect(harness.tool_name).toBe("Write");
		expect(harness.tool_input?.content).toBe("hello");
	});
	it("delete → Bash with rm command", () => {
		const event = makeEvent({
			action: {
				kind: "file_operation",
				operation: "delete",
				path: "/a",
				tool_class: "side-effect",
			},
		});
		const harness = toHarnessEvent(event);
		expect(harness.tool_name).toBe("Bash");
		expect(harness.tool_input?.command).toBe("rm /a");
	});
});

describe("toHarnessEvent — non tool-bearing actions", () => {
	it("leaves tool_name/tool_input unset for user_prompt", () => {
		const event = makeEvent({
			phase: "user-prompt",
			action: { kind: "user_prompt", text: "do the thing" },
		});
		const harness = toHarnessEvent(event);
		expect(harness.tool_name).toBeUndefined();
		expect(harness.tool_input).toBeUndefined();
	});
	it("leaves tool fields unset for session_lifecycle", () => {
		const event = makeEvent({
			phase: "session-start",
			action: { kind: "session_lifecycle", event: "start" },
		});
		const harness = toHarnessEvent(event);
		expect(harness.tool_name).toBeUndefined();
	});
});

describe("toHarnessEvent — tool_input sanitization", () => {
	it("coerces a null tool_input to an empty object", () => {
		const event = makeEvent({
			action: {
				kind: "tool_call",
				tool_name: "read",
				tool_class: "read",
				tool_input: null,
				tool_input_redacted: {},
			},
		});
		expect(toHarnessEvent(event).tool_input).toEqual({});
	});
	it("coerces a primitive tool_input to an empty object", () => {
		const event = makeEvent({
			action: {
				kind: "tool_call",
				tool_name: "read",
				tool_class: "read",
				tool_input: 42,
				tool_input_redacted: {},
			},
		});
		expect(toHarnessEvent(event).tool_input).toEqual({});
	});
});

describe("filterCheckResultsByToolClass", () => {
	it("passes through a decision without check_results", () => {
		const d: HarnessDecision = { decision: "allow" };
		const { decision, count } = filterCheckResultsByToolClass(d, "read");
		expect(decision).toBe(d);
		expect(count).toBe(0);
	});
	it("passes through an empty check_results array", () => {
		const d: HarnessDecision = { decision: "allow", check_results: [] };
		const { decision, count } = filterCheckResultsByToolClass(d, "modify");
		expect(decision).toBe(d);
		expect(count).toBe(0);
	});
	it("currently preserves all findings (no-op until checks carry tool_classes)", () => {
		const d: HarnessDecision = {
			decision: "allow",
			check_results: [
				{
					source: "quality",
					name: "a",
					severity: "info",
					message: "x",
					determinism: "heuristic",
				},
			],
		};
		const { decision, count } = filterCheckResultsByToolClass(d, "read");
		expect(decision.check_results).toHaveLength(1);
		expect(count).toBe(0);
	});
});

describe("flattenFindings", () => {
	it("concatenates check_results and findings", () => {
		const d: HarnessDecision = {
			decision: "allow",
			check_results: [
				{
					source: "quality",
					name: "a",
					severity: "info",
					message: "x",
					determinism: "heuristic",
				},
			],
			findings: [
				{
					source: "structural",
					name: "b",
					severity: "warning",
					message: "y",
					determinism: "heuristic",
				},
			],
		};
		expect(flattenFindings(d).length).toBe(2);
	});
	it("returns check_results alone when findings missing", () => {
		const d: HarnessDecision = {
			decision: "allow",
			check_results: [
				{
					source: "quality",
					name: "a",
					severity: "info",
					message: "x",
					determinism: "heuristic",
				},
			],
		};
		expect(flattenFindings(d).length).toBe(1);
	});
	it("returns an empty list when both are absent", () => {
		expect(flattenFindings({ decision: "allow" })).toEqual([]);
	});
	it("returns findings only when check_results absent", () => {
		const d: HarnessDecision = {
			decision: "allow",
			findings: [
				{
					source: "impact",
					name: "c",
					severity: "error",
					message: "z",
					determinism: "fully_deterministic",
				},
			],
		};
		expect(flattenFindings(d)).toHaveLength(1);
		expect(flattenFindings(d)[0]?.name).toBe("c");
	});
});

describe("evaluateUnified — lifecycle short-circuit", () => {
	it("allows session-start without invoking the inner evaluator", async () => {
		const event = makeEvent({
			phase: "session-start",
			action: { kind: "session_lifecycle", event: "start" },
		});
		const decision = await evaluateUnified(event, makeCtx());
		expect(decision).toEqual({ decision: "allow" });
		expect(preMock).not.toHaveBeenCalled();
		expect(postMock).not.toHaveBeenCalled();
	});
	it("allows session-end without invoking the inner evaluator", async () => {
		const event = makeEvent({
			phase: "session-end",
			action: { kind: "session_lifecycle", event: "end" },
		});
		const decision = await evaluateUnified(event, makeCtx());
		expect(decision).toEqual({ decision: "allow" });
		expect(preMock).not.toHaveBeenCalled();
		expect(postMock).not.toHaveBeenCalled();
	});
});

describe("evaluateUnified — pre-tool routing", () => {
	it("delegates to evaluatePreToolUse and returns its decision", async () => {
		const blocked: HarnessDecision = { decision: "block", reason: "nope" };
		preMock.mockReturnValue(blocked);
		const decision = await evaluateUnified(makeEvent(), makeCtx());
		expect(decision).toEqual(blocked);
		expect(preMock).toHaveBeenCalledTimes(1);
		expect(postMock).not.toHaveBeenCalled();
	});
	it("forwards the converted HarnessEvent and context dependencies", async () => {
		preMock.mockReturnValue({ decision: "allow" });
		const ctx = makeCtx();
		await evaluateUnified(makeEvent(), ctx);
		const [harnessArg, rulesArg, sessionArg, reservationsArg, cohortArg] =
			preMock.mock.calls[0] ?? [];
		expect(harnessArg).toHaveProperty(["tool_name"], "Edit");
		expect(rulesArg).toBe(ctx.rules);
		expect(sessionArg).toBe(ctx.session);
		expect(reservationsArg).toBe(ctx.reservations);
		expect(cohortArg).toBe(ctx.cohort);
	});
});

describe("evaluateUnified — post-tool routing", () => {
	it("delegates to evaluatePostToolUse", async () => {
		const warned: HarnessDecision = { decision: "allow", warnings: ["w"] };
		postMock.mockReturnValue(warned);
		const event = makeEvent({
			phase: "post-tool",
			runner_native_event: "PostToolUse",
			action: {
				kind: "tool_call",
				tool_name: "edit",
				tool_class: "modify",
				tool_input: { file_path: "/a" },
				tool_input_redacted: {},
			},
		});
		const decision = await evaluateUnified(event, makeCtx());
		expect(decision).toEqual(warned);
		expect(postMock).toHaveBeenCalledTimes(1);
		expect(preMock).not.toHaveBeenCalled();
	});
});

describe("evaluateUnified — unwired phases", () => {
	it("returns a no-op allow for phases with no pipeline (stop)", async () => {
		const event = makeEvent({
			phase: "stop",
			runner_native_event: "Stop",
			action: { kind: "other", subkind: "stop", data: {} },
		});
		const decision = await evaluateUnified(event, makeCtx());
		expect(decision).toEqual({ decision: "allow" });
		expect(preMock).not.toHaveBeenCalled();
		expect(postMock).not.toHaveBeenCalled();
	});
	it("returns a no-op allow for user-prompt phase", async () => {
		const event = makeEvent({
			phase: "user-prompt",
			runner_native_event: "UserPromptSubmit",
			action: { kind: "user_prompt", text: "hi" },
		});
		const decision = await evaluateUnified(event, makeCtx());
		expect(decision).toEqual({ decision: "allow" });
	});
});

describe("evaluateUnified — telemetry", () => {
	it("emits an 'evaluated' telemetry event with the final decision", async () => {
		preMock.mockReturnValue({ decision: "block", reason: "r" });
		const seen: UnifiedEvaluatorTelemetry[] = [];
		const ctx = makeCtx({ onTelemetry: (e) => seen.push(e) });
		await evaluateUnified(makeEvent({ event_id: "evt-telem" }), ctx);
		const evaluated = seen.find((e) => e.kind === "evaluated");
		expect(evaluated).toBeDefined();
		if (evaluated?.kind === "evaluated") {
			expect(evaluated.event_id).toBe("evt-telem");
			expect(evaluated.tool_class).toBe("modify");
			expect(evaluated.decision).toBe("block");
			expect(typeof evaluated.elapsed_ms).toBe("number");
			expect(evaluated.elapsed_ms).toBeGreaterThanOrEqual(0);
		}
	});
	it("does not emit a check_filtered event when nothing is filtered", async () => {
		// filterCheckResultsByToolClass is currently a no-op (count 0), so the
		// check_filtered branch must not fire even with findings present.
		preMock.mockReturnValue({
			decision: "allow",
			check_results: [
				{
					source: "quality",
					name: "a",
					severity: "info",
					message: "x",
					determinism: "heuristic",
				},
			],
		});
		const seen: UnifiedEvaluatorTelemetry[] = [];
		const ctx = makeCtx({ onTelemetry: (e) => seen.push(e) });
		await evaluateUnified(makeEvent(), ctx);
		expect(seen.some((e) => e.kind === "check_filtered")).toBe(false);
	});
	it("runs without a telemetry sink", async () => {
		preMock.mockReturnValue({ decision: "allow" });
		const event = makeEvent();
		const ctx = makeCtx();
		const decision = await evaluateUnified(event, ctx);
		expect(preMock).toHaveBeenCalledOnce();
		expect(preMock).toHaveBeenCalledWith(
			toHarnessEvent(event), ctx.rules, ctx.session, ctx.reservations, ctx.cohort,
			ctx.graph, ctx.sessions, ctx.routeMap, ctx.errorHistory,
		);
		expect(decision).toEqual({ decision: "allow" });
	});
	it("emits check_filtered with the filtered count when the filter reports findings removed", async () => {
		// filterCheckResultsByToolClass itself is a hardcoded no-op today, so
		// this drives the branch through the injectable `filterCheckResults`
		// seam rather than production filtering logic (not yet metadata-aware).
		preMock.mockReturnValue({ decision: "allow" });
		const seen: UnifiedEvaluatorTelemetry[] = [];
		const ctx = makeCtx({
			onTelemetry: (e) => seen.push(e),
			filterCheckResults: (decision) => ({ decision, count: 3 }),
		});
		await evaluateUnified(makeEvent({ event_id: "evt-filtered" }), ctx);
		const filteredEvt = seen.find((e) => e.kind === "check_filtered");
		expect(filteredEvt).toBeDefined();
		if (filteredEvt?.kind === "check_filtered") {
			expect(filteredEvt.filtered_count).toBe(3);
			expect(filteredEvt.event_id).toBe("evt-filtered");
		}
	});
});

describe("evaluateUnified — budget timeout race", () => {
	it("returns an allow-with-warning and emits budget_exceeded when work outlasts the budget", async () => {
		vi.useFakeTimers();
		// Inner evaluator returns a promise that never resolves: Promise.resolve()
		// inside runEvaluator adopts it, so the work stays pending and the budget
		// timer wins the race.
		preMock.mockReturnValue(new Promise<HarnessDecision>(() => {}));
		const seen: UnifiedEvaluatorTelemetry[] = [];
		const ctx = makeCtx({
			budgets: { ...DEFAULT_BUDGETS, modify_budget_ms: 25 },
			onTelemetry: (e) => seen.push(e),
		});
		const promise = evaluateUnified(makeEvent({ event_id: "evt-budget" }), ctx);
		await vi.advanceTimersByTimeAsync(25);
		const decision = await promise;
		expect(decision.decision).toBe("allow");
		expect(decision.warnings?.[0]).toContain("exceeded modify budget of 25ms");

		const exceeded = seen.find((e) => e.kind === "budget_exceeded");
		expect(exceeded).toBeDefined();
		if (exceeded?.kind === "budget_exceeded") {
			expect(exceeded.event_id).toBe("evt-budget");
			expect(exceeded.tool_class).toBe("modify");
			expect(exceeded.budget_ms).toBe(25);
			expect(exceeded.elapsed_ms).toBeGreaterThanOrEqual(0);
		}
		// The downstream 'evaluated' telemetry still fires on the timeout decision.
		const evaluated = seen.find((e) => e.kind === "evaluated");
		expect(evaluated?.kind === "evaluated" && evaluated.decision).toBe("allow");
	});

	it("times out cleanly with no telemetry sink configured", async () => {
		vi.useFakeTimers();
		preMock.mockReturnValue(new Promise<HarnessDecision>(() => {}));
		const ctx = makeCtx({ budgets: { ...DEFAULT_BUDGETS, modify_budget_ms: 10 } });
		const promise = evaluateUnified(makeEvent(), ctx);
		await vi.advanceTimersByTimeAsync(10);
		const decision = await promise;
		expect(decision.decision).toBe("allow");
		expect(decision.warnings?.[0]).toContain("reduced coverage");
	});

	it("returns the real decision when work finishes within budget", async () => {
		vi.useFakeTimers();
		preMock.mockReturnValue({ decision: "block", reason: "fast" });
		const ctx = makeCtx({ budgets: { ...DEFAULT_BUDGETS, modify_budget_ms: 1000 } });
		const event = makeEvent();
		const decision = await evaluateUnified(event, ctx);
		expect(preMock).toHaveBeenCalledOnce();
		expect(preMock).toHaveBeenCalledWith(
			toHarnessEvent(event), ctx.rules, ctx.session, ctx.reservations, ctx.cohort,
			ctx.graph, ctx.sessions, ctx.routeMap, ctx.errorHistory,
		);
		expect(decision).toEqual({ decision: "block", reason: "fast" });
	});
});
