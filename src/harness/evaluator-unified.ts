// ===========================================
// Unified evaluator — UnifiedHookEvent entry point
// ===========================================
// Sits above the existing evaluatePreToolUse / evaluatePostToolUse functions
// in ./evaluator.ts. The existing functions take a Claude-shaped HarnessEvent;
// this module converts a UnifiedHookEvent into that shape, enforces the
// per-tool-class budget, and filters CheckRegistration results by tool_class
// metadata.
//
// Why a wrapper and not a rewrite: the existing evaluator is 3700+ LOC with
// deep coupling to HarnessEvent and many specialized check pipelines. A
// big-bang rewrite would regress coverage. The wrapper preserves all existing
// behavior while adding the surface the new adapter layer needs.

import type { JsonObject } from "../lib/json-types.js";
import type { CohortManager } from "./cohort.js";
import type { ErrorHistory } from "./error-history.js";
import { evaluatePostToolUse, evaluatePreToolUse } from "./evaluator.js";
import { liftOutcomeEvidence } from "./outcome-evidence.js";
import type { ProjectGraph } from "./project-graph.js";
import type { ReservationManager } from "./reservations.js";
import type { RouteMap } from "./route-map.js";
import { baselineCallKey, consumeBaselineSnapshot } from "./evaluator/baseline-effect-guard.js";
import type { SessionTracker } from "./session-state.js";
import type {
	AgentSource,
	CheckResultEntry,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "./types.js";
import type { ToolClass, UnifiedHookEvent } from "./unified-event.js";

/** Per-tool-class budgets. The evaluator aborts the call when the budget is
 *  exceeded; the hook layer still enforces its own hard timeout on top. */
export interface ToolClassBudgets {
	read_budget_ms: number;
	modify_budget_ms: number;
	side_effect_budget_ms: number;
	long_running_budget_ms: number;
	unknown_budget_ms: number;
}

export const DEFAULT_BUDGETS: ToolClassBudgets = {
	read_budget_ms: 300,
	modify_budget_ms: 800,
	side_effect_budget_ms: 2000,
	long_running_budget_ms: 5000,
	unknown_budget_ms: 800,
};

export function budgetFor(
	toolClass: ToolClass,
	budgets: ToolClassBudgets = DEFAULT_BUDGETS,
): number {
	switch (toolClass) {
		case "read":
			return budgets.read_budget_ms;
		case "modify":
			return budgets.modify_budget_ms;
		case "side-effect":
			return budgets.side_effect_budget_ms;
		case "long-running":
			return budgets.long_running_budget_ms;
		default:
			return budgets.unknown_budget_ms;
	}
}

export interface EvaluateUnifiedContext {
	rules: GuardRulesConfig;
	session: SessionTrajectory | undefined;
	reservations: ReservationManager;
	cohort: CohortManager;
	graph?: ProjectGraph;
	sessions?: SessionTracker;
	routeMap?: RouteMap;
	errorHistory?: ErrorHistory;
	budgets?: ToolClassBudgets;
	/** Optional sink for telemetry events. When set the evaluator reports
	 *  budget-timeout and check-skip events to it. */
	onTelemetry?: (event: UnifiedEvaluatorTelemetry) => void;
	/** Test seam: override the tool-class filter. Defaults to the real
	 *  `filterCheckResultsByToolClass`, which is currently a no-op (always
	 *  count 0) until checks carry `tool_classes` metadata — this lets a test
	 *  exercise the `check_filtered` telemetry branch without waiting for
	 *  that metadata to land. */
	filterCheckResults?: typeof filterCheckResultsByToolClass;
}

export type UnifiedEvaluatorTelemetry =
	| {
			kind: "budget_exceeded";
			event_id: string;
			tool_class: ToolClass;
			budget_ms: number;
			elapsed_ms: number;
	  }
	| { kind: "check_filtered"; event_id: string; tool_class: ToolClass; filtered_count: number }
	| {
			kind: "evaluated";
			event_id: string;
			tool_class: ToolClass;
			elapsed_ms: number;
			decision: HarnessDecision["decision"];
	  };

/** Main unified entry point. */
export async function evaluateUnified(
	event: UnifiedHookEvent,
	ctx: EvaluateUnifiedContext,
): Promise<HarnessDecision> {
	const toolClass = extractToolClassFromEvent(event);
	const budget = budgetFor(toolClass, ctx.budgets);
	const started = Date.now();

	const harnessEvent = toHarnessEvent(event);

	// Lifecycle events don't run checks.
	if (event.phase === "session-start" || event.phase === "session-end") {
		return { decision: "allow" };
	}

	const work = runEvaluator(event, harnessEvent, ctx);
	const decision = await runWithBudget(work, budget, event, toolClass, ctx);

	const filtered = (ctx.filterCheckResults ?? filterCheckResultsByToolClass)(decision, toolClass);
	if (filtered.count > 0 && ctx.onTelemetry) {
		ctx.onTelemetry({
			kind: "check_filtered",
			event_id: event.event_id,
			tool_class: toolClass,
			filtered_count: filtered.count,
		});
	}

	const elapsed = Date.now() - started;
	if (ctx.onTelemetry) {
		ctx.onTelemetry({
			kind: "evaluated",
			event_id: event.event_id,
			tool_class: toolClass,
			elapsed_ms: elapsed,
			decision: filtered.decision.decision,
		});
	}

	return filtered.decision;
}

/** Convert the tagged-union action to the flat HarnessEvent shape consumed by
 *  the existing evaluator. Only the fields the evaluator reads are populated. */
export function toHarnessEvent(event: UnifiedHookEvent): HarnessEvent & { cwd: string } {
	const out: HarnessEvent & { cwd: string } = {
		hook_event: unifiedToNativeEventName(event),
		session_id: event.session_id,
		agent_source: mapAgentSource(event.runner),
		cwd: event.context.cwd,
		timestamp: event.ts,
	};

	if (event.context.agent?.id) out.agent_name = event.context.agent.id;
	// Carried for delivery de-duplication (not read by checks): the daemon
	// keys redundant hook deliveries on tool_use_id.
	if (event.tool_use_id) out.tool_use_id = event.tool_use_id;
	if (event.post_delivery_token) out.post_delivery_token = event.post_delivery_token;
	if (event.post_delivery_pid) out.post_delivery_pid = event.post_delivery_pid;

	const action = event.action;
	if (action.kind === "tool_call") {
		out.tool_name = nativeToolName(event.runner, action.tool_name);
		out.tool_input = sanitizeToolInput(action.tool_input);
		if (action.tool_response !== undefined) out.tool_response = action.tool_response;
		if (event.phase === "post-tool") {
			// The adapter's tool_error is the canonical diagnostic when present.
			if (action.tool_error !== undefined) out.error_message = action.tool_error;
			liftOutcomeEvidence(out);
		}
	} else if (action.kind === "shell_command") {
		out.tool_name = "Bash";
		out.tool_input = { command: action.command, cwd: action.cwd };
	} else if (action.kind === "file_operation") {
		out.tool_name = fileOpToToolName(action.operation);
		out.tool_input = buildFileOpInput(action);
	}

	return out;
}

function runEvaluator(
	event: UnifiedHookEvent,
	harnessEvent: HarnessEvent & { cwd: string },
	ctx: EvaluateUnifiedContext,
): Promise<HarnessDecision> {
	if (event.phase === "pre-tool") {
		return Promise.resolve(
			evaluatePreToolUse(
				harnessEvent,
				ctx.rules,
				ctx.session,
				ctx.reservations,
				ctx.cohort,
				ctx.graph,
				ctx.sessions,
				ctx.routeMap,
				ctx.errorHistory,
			),
		);
	}
	if (event.phase === "post-tool") {
		const decision = evaluatePostToolUse(
			harnessEvent,
			ctx.rules,
			ctx.session,
			ctx.reservations,
			ctx.cohort,
		);
		return Promise.resolve(withBaselineEffectWarning(harnessEvent, decision));
	}
	// Phases we don't yet wire produce a no-op allow so adapters can still
	// install hooks for them without crashing the pipeline.
	return Promise.resolve({ decision: "allow" });
}

/**
 * Effect-arm bridge for the UNIFIED path (Cursor and friends), which does not
 * run the server's pre/post pipelines. Same shared helpers as the socket path,
 * so both runners get identical semantics from one implementation.
 */
function withBaselineEffectWarning(event: HarnessEvent & { cwd: string }, decision: HarnessDecision): HarnessDecision {
	if (event.dry_run) return decision;
	const key = baselineCallKey({
		toolUseId: event.tool_use_id,
		sessionId: event.session_id,
		timestamp: event.timestamp,
	});
	const warning = consumeBaselineSnapshot(key, event.cwd);
	if (!warning) return decision;
	return { ...decision, warnings: [...(decision.warnings ?? []), warning] };
}

async function runWithBudget(
	work: Promise<HarnessDecision>,
	budget: number,
	event: UnifiedHookEvent,
	toolClass: ToolClass,
	ctx: EvaluateUnifiedContext,
): Promise<HarnessDecision> {
	const started = Date.now();
	const timeout = new Promise<HarnessDecision>((resolve) => {
		setTimeout(() => {
			const elapsed = Date.now() - started;
			if (ctx.onTelemetry) {
				ctx.onTelemetry({
					kind: "budget_exceeded",
					event_id: event.event_id,
					tool_class: toolClass,
					budget_ms: budget,
					elapsed_ms: elapsed,
				});
			}
			resolve({
				decision: "allow",
				warnings: [
					`[interlinked] evaluator exceeded ${toolClass} budget of ${budget}ms; allowing with reduced coverage`,
				],
			});
		}, budget);
	});
	return Promise.race([work, timeout]);
}

/** Extract the ToolClass from any unified event. Shell/file/tool_call actions
 *  carry it directly; others default to "unknown". */
export function extractToolClassFromEvent(event: UnifiedHookEvent): ToolClass {
	const a = event.action;
	if (a.kind === "tool_call" || a.kind === "shell_command" || a.kind === "file_operation") {
		return a.tool_class;
	}
	return "unknown";
}

/** Filter findings returned by the inner evaluator whose check declarations
 *  restrict `tool_classes` but do not include this event's class. Returns the
 *  decision (possibly with trimmed check_results) plus the filtered count. */
export function filterCheckResultsByToolClass(
	decision: HarnessDecision,
	_toolClass: ToolClass,
): { decision: HarnessDecision; count: number } {
	if (!decision.check_results || decision.check_results.length === 0) {
		return { decision, count: 0 };
	}
	// Current decision shape does not carry tool_classes metadata on each
	// finding, so filtering happens upstream in the check-registry builders
	// once they pass tool_classes into the pipeline. For now this is a no-op
	// preserving all findings; we keep the function to make the layering
	// explicit and testable as checks gain tool_classes metadata.
	return { decision, count: 0 };
}

// -----------------------------------------------------------------------------
// Helpers: UnifiedHookEvent → HarnessEvent shape
// -----------------------------------------------------------------------------

function unifiedToNativeEventName(event: UnifiedHookEvent): string {
	// Preserve native event name where possible; the existing evaluator keys
	// some logic off this. Claude runners get Claude names; others get
	// normalized Phase-based names.
	if (event.runner === "claude-code") return event.runner_native_event;
	switch (event.phase) {
		case "pre-tool":
			return "PreToolUse";
		case "post-tool":
			return "PostToolUse";
		case "session-start":
			return "SessionStart";
		case "session-end":
			return "SessionEnd";
		case "user-prompt":
			return "UserPromptSubmit";
		case "pre-compact":
			return "PreCompact";
		default:
			return event.runner_native_event;
	}
}

const AGENT_SOURCE_BY_RUNNER: Readonly<Record<string, AgentSource>> = {
	"claude-code": "claude",
	"copilot-cli": "copilot",
	codex: "codex",
	"gemini-cli": "gemini",
	cursor: "cursor",
	opencode: "opencode",
	pi: "pi",
};

function mapAgentSource(runner: string): AgentSource {
	return AGENT_SOURCE_BY_RUNNER[runner] ?? "claude";
}

function nativeToolName(runner: string, normalized: string): string {
	// The existing evaluator expects Claude-style tool names (`Edit`, `Bash`,
	// etc.). Restore capitalization for Claude; Copilot's lowercase names pass
	// through so guard rules that match Copilot tool names still fire.
	if (runner !== "claude-code") return normalized;
	switch (normalized) {
		case "edit":
			return "Edit";
		case "write":
			return "Write";
		case "multi_edit":
			return "MultiEdit";
		case "read":
			return "Read";
		case "bash":
			return "Bash";
		case "grep":
			return "Grep";
		case "glob":
			return "Glob";
		case "ls":
			return "LS";
		case "notebook_edit":
			return "NotebookEdit";
		case "web_fetch":
			return "WebFetch";
		case "web_search":
			return "WebSearch";
		case "todo_write":
			return "TodoWrite";
		case "task":
			return "Task";
		default:
			return normalized;
	}
}

function fileOpToToolName(op: "read" | "write" | "edit" | "delete"): string {
	switch (op) {
		case "read":
			return "Read";
		case "write":
			return "Write";
		case "edit":
			return "Edit";
		case "delete":
			return "Bash";
	}
}

function buildFileOpInput(action: {
	operation: "read" | "write" | "edit" | "delete";
	path: string;
	old_string?: string;
	new_string?: string;
	content?: string;
}): JsonObject {
	if (action.operation === "delete") {
		return { command: `rm ${action.path}` };
	}
	const input: JsonObject = { file_path: action.path };
	if (action.old_string !== undefined) input.old_string = action.old_string;
	if (action.new_string !== undefined) input.new_string = action.new_string;
	if (action.content !== undefined) input.content = action.content;
	return input;
}

function sanitizeToolInput(input: unknown): JsonObject {
	if (input == null || typeof input !== "object") return {};
	// SAFETY: narrowed to a non-null object on the line above; consumers treat
	// the value as an opaque bag and re-check each field they read.
	return input as JsonObject;
}

/** Extract warnings + findings into a flat list the caller can render. */
export function flattenFindings(decision: HarnessDecision): CheckResultEntry[] {
	const base = decision.check_results ?? [];
	const extras = decision.findings ?? [];
	if (extras.length === 0) return base;
	return [...base, ...extras];
}
