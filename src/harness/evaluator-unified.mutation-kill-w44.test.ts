import { afterEach, describe, expect, it, vi } from "vitest";

// Same mocking strategy as evaluator-unified.test.ts: mock out the delegated
// evaluators and the baseline-effect-guard helpers so evaluateUnified's own
// routing / gating logic can be driven deterministically.
const preMock = vi.fn();
const postMock = vi.fn();
vi.mock("./evaluator.js", () => ({
	evaluatePreToolUse: (...args: unknown[]) => preMock(...args),
	evaluatePostToolUse: (...args: unknown[]) => postMock(...args),
}));

const baselineCallKeyMock = vi.fn((opts: unknown) => JSON.stringify(opts));
const consumeBaselineSnapshotMock = vi.fn((_key: string, _root: string) => null as string | null);
vi.mock("./evaluator/baseline-effect-guard.js", () => ({
	baselineCallKey: (opts: unknown) => baselineCallKeyMock(opts),
	consumeBaselineSnapshot: (key: string, root: string) => consumeBaselineSnapshotMock(key, root),
}));

import type { CohortManager } from "./cohort.js";
import {
	budgetFor,
	DEFAULT_BUDGETS,
	type EvaluateUnifiedContext,
	evaluateUnified,
	filterCheckResultsByToolClass,
	flattenFindings,
	toHarnessEvent,
	type UnifiedEvaluatorTelemetry,
} from "./evaluator-unified.js";
import type { ReservationManager } from "./reservations.js";
import type { GuardRulesConfig, HarnessDecision } from "./types.js";
import type { UnifiedHookEvent } from "./unified-event.js";

function makeEvent(over: Partial<UnifiedHookEvent> = {}): UnifiedHookEvent {
	return {
		schema_version: "1",
		event_id: "evt-w44",
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

function makeCtx(over: Partial<EvaluateUnifiedContext> = {}): EvaluateUnifiedContext {
	const rules = { enabled: true } as unknown as GuardRulesConfig;
	return {
		rules,
		session: undefined,
		reservations: {} as unknown as ReservationManager,
		cohort: {} as unknown as CohortManager,
		...over,
	};
}

afterEach(() => {
	preMock.mockReset();
	postMock.mockReset();
	baselineCallKeyMock.mockReset();
	baselineCallKeyMock.mockImplementation((opts: unknown) => JSON.stringify(opts));
	consumeBaselineSnapshotMock.mockReset();
	consumeBaselineSnapshotMock.mockImplementation(() => null);
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Lifecycle short-circuit: kills the OR/AND/string-literal/block mutants on
// `event.phase === "session-start" || event.phase === "session-end"`.
// The short-circuit returns before `onTelemetry` is ever touched; any mutant
// that lets execution fall through reaches the "evaluated" telemetry emit.
// ---------------------------------------------------------------------------
describe("evaluateUnified — lifecycle short-circuit never touches telemetry", () => {
	it("session-start: no telemetry event is ever emitted", async () => {
		const event = makeEvent({
			phase: "session-start",
			action: { kind: "session_lifecycle", event: "start" },
		});
		const seen: UnifiedEvaluatorTelemetry[] = [];
		const decision = await evaluateUnified(event, makeCtx({ onTelemetry: (e) => seen.push(e) }));
		expect(decision).toEqual({ decision: "allow" });
		expect(seen).toHaveLength(0);
	});

	it("session-end: no telemetry event is ever emitted", async () => {
		const event = makeEvent({
			phase: "session-end",
			action: { kind: "session_lifecycle", event: "end" },
		});
		const seen: UnifiedEvaluatorTelemetry[] = [];
		const decision = await evaluateUnified(event, makeCtx({ onTelemetry: (e) => seen.push(e) }));
		expect(decision).toEqual({ decision: "allow" });
		expect(seen).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Elapsed-time arithmetic: `Date.now() - started` must be a subtraction, not
// an addition. Verified with fake timers so the delta is exact.
// ---------------------------------------------------------------------------
describe("evaluateUnified — elapsed_ms uses subtraction", () => {
	it("outer elapsed_ms is 0 when no time passes before the inner evaluator resolves", async () => {
		vi.useFakeTimers();
		preMock.mockReturnValue({ decision: "allow" });
		const seen: UnifiedEvaluatorTelemetry[] = [];
		await evaluateUnified(makeEvent(), makeCtx({ onTelemetry: (e) => seen.push(e) }));
		const evaluated = seen.find((e) => e.kind === "evaluated");
		expect(evaluated).toBeDefined();
		if (evaluated?.kind === "evaluated") {
			expect(evaluated.elapsed_ms).toBe(0);
		}
	});

	it("budget-timeout elapsed_ms equals the exact advanced time, not a sum", async () => {
		vi.useFakeTimers();
		preMock.mockReturnValue(new Promise<HarnessDecision>(() => {}));
		const seen: UnifiedEvaluatorTelemetry[] = [];
		const ctx = makeCtx({
			budgets: { ...DEFAULT_BUDGETS, modify_budget_ms: 25 },
			onTelemetry: (e) => seen.push(e),
		});
		const promise = evaluateUnified(makeEvent(), ctx);
		await vi.advanceTimersByTimeAsync(25);
		await promise;
		const exceeded = seen.find((e) => e.kind === "budget_exceeded");
		expect(exceeded).toBeDefined();
		if (exceeded?.kind === "budget_exceeded") {
			expect(exceeded.elapsed_ms).toBe(25);
		}
	});
});

// ---------------------------------------------------------------------------
// toHarnessEvent: conditional field assignment must gate on the ACTUAL
// condition, not always be true — checked via hasOwnProperty so a mutant that
// assigns `undefined` unconditionally is still caught (toBeUndefined() alone
// would not catch it).
// ---------------------------------------------------------------------------
function makeBashPostEvent(toolResponse: unknown, tool_error?: string): UnifiedHookEvent {
	return makeEvent({
		phase: "post-tool",
		runner_native_event: "PostToolUse",
		action: {
			kind: "tool_call",
			tool_name: "bash",
			tool_class: "side-effect",
			tool_input: { command: "echo hi" },
			tool_input_redacted: {},
			tool_response: toolResponse,
			...(tool_error !== undefined ? { tool_error } : {}),
		},
	});
}

describe("toHarnessEvent — conditional assignment gating", () => {
	it("does not set error_message as an own property when tool_error is absent", () => {
		const out = toHarnessEvent(makeBashPostEvent({ stdout: "ok" }));
		expect(Object.prototype.hasOwnProperty.call(out, "error_message")).toBe(false);
	});

	it("does not lift error_message on a pre-tool event, even with tool_error present", () => {
		const event = makeEvent({
			phase: "pre-tool",
			action: {
				kind: "tool_call",
				tool_name: "edit",
				tool_class: "modify",
				tool_input: {},
				tool_input_redacted: {},
				tool_error: "should not surface pre-tool",
			},
		});
		const out = toHarnessEvent(event);
		expect(out.error_message).toBeUndefined();
	});

	it("does not set tool_response as an own property when absent (pre-tool)", () => {
		const out = toHarnessEvent(makeEvent());
		expect(Object.prototype.hasOwnProperty.call(out, "tool_response")).toBe(false);
	});

	it("does not set tool_use_id as an own property when the event carries none", () => {
		const event = makeEvent({ tool_use_id: undefined });
		const out = toHarnessEvent(event);
		expect(Object.prototype.hasOwnProperty.call(out, "tool_use_id")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// nativeToolName: the claude-code capitalization switch must only apply to
// the claude-code runner, even when a non-claude tool name happens to collide
// with a claude switch case string.
// ---------------------------------------------------------------------------
describe("toHarnessEvent — runner gate on tool-name mapping", () => {
	it("leaves a copilot tool_name of 'edit' unmapped (does not become 'Edit')", () => {
		const event = makeEvent({
			runner: "copilot-cli",
			action: {
				kind: "tool_call",
				tool_name: "edit",
				tool_class: "modify",
				tool_input: {},
				tool_input_redacted: {},
			},
		});
		expect(toHarnessEvent(event).tool_name).toBe("edit");
	});
});

// ---------------------------------------------------------------------------
// buildFileOpInput: same own-property gating pattern for file_operation
// fields (old_string / new_string / content) on a bare read operation.
// ---------------------------------------------------------------------------
describe("toHarnessEvent — file_operation input gating", () => {
	function readEvent(): UnifiedHookEvent {
		return makeEvent({
			action: { kind: "file_operation", operation: "read", path: "/a", tool_class: "read" },
		});
	}

	it("does not set old_string as an own property on a read operation", () => {
		const input = toHarnessEvent(readEvent()).tool_input as Record<string, unknown>;
		expect(Object.prototype.hasOwnProperty.call(input, "old_string")).toBe(false);
	});

	it("does not set new_string as an own property on a read operation", () => {
		const input = toHarnessEvent(readEvent()).tool_input as Record<string, unknown>;
		expect(Object.prototype.hasOwnProperty.call(input, "new_string")).toBe(false);
	});

	it("does not set content as an own property on a read operation", () => {
		const input = toHarnessEvent(readEvent()).tool_input as Record<string, unknown>;
		expect(Object.prototype.hasOwnProperty.call(input, "content")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// flattenFindings: when there are no extra findings, the function must
// return the SAME check_results array reference, not a freshly spread copy.
// ---------------------------------------------------------------------------
describe("flattenFindings — reference identity on the no-extras path", () => {
	it("returns the exact check_results array reference when findings is absent", () => {
		const checkResults = [
			{
				source: "quality" as const,
				name: "a",
				severity: "info" as const,
				message: "x",
				determinism: "heuristic" as const,
			},
		];
		const d: HarnessDecision = { decision: "allow", check_results: checkResults };
		expect(flattenFindings(d)).toBe(checkResults);
	});
});

// ---------------------------------------------------------------------------
// DEFAULT_BUDGETS: pin the literal values so an emptied object literal fails.
// ---------------------------------------------------------------------------
describe("budgetFor — DEFAULT_BUDGETS literal values", () => {
	it("has the documented literal per-class budgets", () => {
		expect(budgetFor("read")).toBe(300);
		expect(budgetFor("modify")).toBe(800);
		expect(budgetFor("side-effect")).toBe(2000);
		expect(budgetFor("long-running")).toBe(5000);
		expect(budgetFor("unknown")).toBe(800);
	});
});

// ---------------------------------------------------------------------------
// withBaselineEffectWarning (reached only via post-tool routing): dry_run
// gate, the callKey object shape, the cwd ?? fallback, and the !warning gate.
// ---------------------------------------------------------------------------
function makePostToolEvent(over: Partial<UnifiedHookEvent> = {}): UnifiedHookEvent {
	return makeEvent({
		phase: "post-tool",
		runner_native_event: "PostToolUse",
		tool_use_id: "tu-1",
		action: {
			kind: "tool_call",
			tool_name: "edit",
			tool_class: "modify",
			tool_input: { file_path: "/a" },
			tool_input_redacted: {},
		},
		...over,
	});
}

describe("evaluateUnified — post-tool baseline-effect gating", () => {
	// test-contract: bug — mutant 847d34a0 flips `event.dry_run` to a
	// hardcoded `true`, which would short-circuit and merge no warning even
	// though `consumeBaselineSnapshot` (mocked here) reports a real loosening.
	it("surfaces a baseline-loosening warning on a real (non-dry-run) post-tool call", async () => {
		consumeBaselineSnapshotMock.mockReturnValue("BASELINE LOOSENED: caps.json");
		postMock.mockReturnValue({ decision: "allow" });
		const event = makePostToolEvent();
		const ctx = makeCtx();
		const decision = await evaluateUnified(event, ctx);
		expect(consumeBaselineSnapshotMock).toHaveBeenCalledOnce();
		expect(consumeBaselineSnapshotMock).toHaveBeenCalledWith(
			JSON.stringify({ toolUseId: "tu-1", sessionId: "s", timestamp: "2026-04-23T00:00:00.000Z" }),
			"/repo",
		);
		expect(decision.warnings).toEqual(["BASELINE LOOSENED: caps.json"]);
	});

	// test-contract: bug — mutant 464e7b96 empties the `{toolUseId, sessionId,
	// timestamp}` object literal passed to `baselineCallKey`, which would
	// change the derived key and thus the lookup used by
	// `consumeBaselineSnapshot`.
	it("builds the baseline call key from toolUseId, sessionId, and timestamp", async () => {
		postMock.mockReturnValue({ decision: "allow" });
		await evaluateUnified(
			makePostToolEvent({ tool_use_id: "tu-42", session_id: "sess-9", ts: "2026-05-01T00:00:00.000Z" }),
			makeCtx(),
		);
		expect(baselineCallKeyMock).toHaveBeenCalledWith({
			toolUseId: "tu-42",
			sessionId: "sess-9",
			timestamp: "2026-05-01T00:00:00.000Z",
		});
	});

	it("falls back to process.cwd() when the event carries no cwd (?? not &&)", async () => {
		postMock.mockReturnValue({ decision: "allow" });
		const event = makePostToolEvent({
			context: { cwd: undefined as unknown as string },
		});
		await evaluateUnified(event, makeCtx());
		const [, rootArg] = consumeBaselineSnapshotMock.mock.calls[0] ?? [];
		expect(rootArg).toBeTruthy();
		expect(typeof rootArg).toBe("string");
	});

	it("merges the loosening warning into decision.warnings when one is found", async () => {
		consumeBaselineSnapshotMock.mockReturnValue("BASELINE LOOSENED: caps.json");
		postMock.mockReturnValue({ decision: "allow", warnings: ["existing"] });
		const event = makePostToolEvent();
		const ctx = makeCtx();
		const decision = await evaluateUnified(event, ctx);
		expect(consumeBaselineSnapshotMock).toHaveBeenCalledOnce();
		expect(consumeBaselineSnapshotMock).toHaveBeenCalledWith(
			JSON.stringify({ toolUseId: "tu-1", sessionId: "s", timestamp: "2026-04-23T00:00:00.000Z" }),
			"/repo",
		);
		expect(decision.warnings).toContain("BASELINE LOOSENED: caps.json");
		expect(decision.warnings).toContain("existing");
	});
});

// ---------------------------------------------------------------------------
// filterCheckResultsByToolClass sanity check (no new mutants killable here —
// both branches of the function are currently behaviorally identical no-ops;
// this test just pins today's contract so future changes are noticed).
// ---------------------------------------------------------------------------
describe("filterCheckResultsByToolClass — contract pin", () => {
	it("always returns count 0 and the original decision reference", () => {
		const d: HarnessDecision = { decision: "allow" };
		expect(filterCheckResultsByToolClass(d, "read")).toEqual({ decision: d, count: 0 });
	});
});
