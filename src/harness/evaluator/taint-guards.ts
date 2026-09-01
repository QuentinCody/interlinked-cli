// ===========================================
// Taint Tracking + Step-Budget Guards (PreToolUse)
// ===========================================
//
// Enforces the session-sensitivity model (Public / Internal / Confidential /
// Secret): ratchets sensitivity when the agent reads labelled files, blocks
// outbound network commands once the session is tainted, escalates for the
// classifier at the Internal threshold, and enforces step budgets with
// graceful degradation to read-only once exceeded.
//
// Provenance axis (orthogonal to sensitivity): the
// `checkProvenanceTaintToExternalAction` guard intercepts external-action
// tool calls whose input strings contain references to files whose taint
// source was flagged as `fetched_external` or `mcp_remote`. This is the
// "data from the internet flowing into a publish / push / deploy" failure
// mode — even if the data is labelled Public, the agent should confirm
// before acting on it externally.

import type { JsonObject } from "../../lib/json-types.js";
import {
	classifyFileSensitivity,
	formatTaintSources,
	getStepBudgetWarning,
	isNetworkCommand,
	isStepLimitExceeded,
	ratchetSensitivity,
	SENSITIVITY_ORDER,
	shouldBlockNetwork,
} from "../taint-tracker.js";
import type {
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	SessionTrajectory,
	TaintProvenance,
	TaintSource,
	TaintTrackingConfig,
} from "../types.js";
import {
	classifyToolExternality,
	isBash,
	isFileWrite,
	isReadOperation,
} from "./tool-classifiers.js";

/** Read-only tools that stay allowed once the step budget is exhausted. */
const READ_ONLY_TOOLS_ON_BUDGET = new Set(["Read", "Glob", "Grep", "Ls", "WebSearch"]);

/** Tail length for `recent_tool_sequence` when assembling an escalation request. */
const ESCALATION_TAIL_LENGTH = 10;

/** High-water mark (fraction of step limit) past which we raise an escalation
 *  on a state-changing tool call. */
const HIGH_BUDGET_THRESHOLD = 0.8;

/**
 * `GuardRulesConfig.taint_tracking` is declared non-optional, but that's the
 * fully-defaulted `resolveConfig()` shape, not a runtime guarantee at every
 * call site — unit tests deliberately construct `GuardRulesConfig` objects
 * missing the field (`{ enabled: true, rules: [] } as unknown as
 * GuardRulesConfig`) to model stale/partial configs. Routing the read
 * through this accessor keeps the type at this boundary honest so the
 * defensive check downstream stays necessary instead of looking dead to
 * `no-unnecessary-condition`.
 */
function taintTrackingOf(rules: GuardRulesConfig): TaintTrackingConfig | undefined {
	return rules.taint_tracking;
}

/**
 * `SessionTrajectory.taint_sources` is likewise declared non-optional, but a
 * legacy session object hydrated before this field existed can genuinely
 * lack it at runtime (the "tolerates a legacy session without taint_sources"
 * test forces this with a type-bypassed `undefined`). Route the read through
 * a function call rather than a plain local assignment — TypeScript narrows
 * a `const`'s type to its initializer's (narrower) type at the point of
 * assignment even when the local is annotated wider, which would silently
 * defeat a `const taintSources: TaintSource[] | undefined = session.taint_sources`
 * pattern.
 */
function taintSourcesOf(session: SessionTrajectory): TaintSource[] | undefined {
	return session.taint_sources;
}

/** Public API — return shape from {@link evaluateTaintGuards}. */
export type TaintGuardsResult =
	| { kind: "block"; decision: HarnessDecision }
	| { kind: "ask"; decision: HarnessDecision }
	| { kind: "allow-readonly"; decision: HarnessDecision }
	| { kind: "ok"; warnings: string[]; escalation?: EscalationRequest | undefined };

/** Untrusted provenance values — taint sources from these origins gate the
 *  external-action confirmation. Local code reads and document reads of
 *  local files are considered trusted (the prose may carry instructions
 *  but did not come over an unverified channel). */
const UNTRUSTED_PROVENANCE: ReadonlySet<TaintProvenance> = new Set<TaintProvenance>([
	"fetched_external",
	"mcp_remote",
]);

/**
 * Flatten the tool_input into a single searchable string — every value in
 * the JsonObject is concatenated so substring matching can find a tainted
 * file path regardless of which key it was passed under (`file_path`,
 * `command`, `url`, `body`, MCP-specific keys, etc.).
 *
 * v1 derivation tracking is coarse substring-match — it catches the obvious
 * cases ("pipe README.md through curl") but misses derived values (read the
 * file, base64-encode it, send the result). v2 is byte-level data-flow.
 *
 * TODO(provenance-v2): track byte-level data-flow so derived/transformed
 * values from a tainted source still trip this guard.
 */
function flattenToolInputToString(toolInput: JsonObject): string {
	const parts: string[] = [];
	const walk = (v: unknown): void => {
		if (v == null) return;
		if (typeof v === "string") {
			parts.push(v);
			return;
		}
		if (typeof v === "number" || typeof v === "boolean") {
			parts.push(String(v));
			return;
		}
		if (Array.isArray(v)) {
			for (const e of v) walk(e);
			return;
		}
		if (typeof v === "object") {
			for (const e of Object.values(v as JsonObject)) walk(e);
		}
	};
	walk(toolInput);
	return parts.join("\n");
}

/**
 * Public API — guard that fires `decision: "ask"` when an external-action
 * tool call carries any reference (substring match) to a taint source whose
 * provenance is `fetched_external` or `mcp_remote`. Returns `null` when no
 * untrusted-provenance flow is detected, letting the rest of the guard
 * chain proceed.
 *
 * The "ask" decision is preferred over "block" here because the action
 * may be legitimate — the agent might intentionally be pushing data the
 * user gave it from the web. Confirmation lets the user make the call.
 */
export function checkProvenanceTaintToExternalAction(
	toolName: string,
	toolInput: JsonObject,
	session: SessionTrajectory,
): HarnessDecision | null {
	if (classifyToolExternality(toolName, toolInput) !== "external_action") return null;
	const taintSources = taintSourcesOf(session);
	if (!taintSources || taintSources.length === 0) return null;

	const haystack = flattenToolInputToString(toolInput);
	if (!haystack) return null;

	for (const src of taintSources) {
		if (!UNTRUSTED_PROVENANCE.has(src.provenance)) continue;
		if (!src.file) continue;
		if (haystack.includes(src.file)) {
			return {
				decision: "ask",
				reason:
					`${toolName} would act on data sourced from untrusted provenance ` +
					`(${src.file} via ${src.provenance}). Confirm intent before proceeding.`,
			};
		}
	}
	return null;
}

/**
 * Stage 1 — on a file read, ratchet session sensitivity to the file's level
 * if higher, and push the escalation warning. Mutates `session` (via
 * `ratchetSensitivity`) and appends to `warnings`. Side-effecting; returns void.
 */
function applySensitivityRatchet(
	toolName: string,
	toolInput: JsonObject,
	taint: TaintTrackingConfig,
	session: SessionTrajectory,
	warnings: string[],
): void {
	if (!isReadOperation(toolName)) return;
	const filePath = (toolInput.file_path as string) || "";
	if (!filePath) return;
	const fileSensitivity = classifyFileSensitivity(filePath, taint);
	if (SENSITIVITY_ORDER[fileSensitivity] <= SENSITIVITY_ORDER[session.sensitivity_level]) {
		return;
	}
	ratchetSensitivity(session, filePath, fileSensitivity, taint);
	const blockStatus = shouldBlockNetwork(session, taint) ? "BLOCKED" : "monitored";
	warnings.push(
		`[interlinked:taint] Sensitivity escalated to ${fileSensitivity} after reading ${filePath}. Outbound network commands will be ${blockStatus}.`,
	);
}

/**
 * Stage 2 — hard block on outbound network commands while the session is
 * tainted at/above the configured block threshold. Returns a terminal block
 * result, or null to continue the guard chain.
 */
function checkTaintedNetworkBlock(
	toolName: string,
	toolInput: JsonObject,
	taint: TaintTrackingConfig,
	session: SessionTrajectory,
	warnings: string[],
): TaintGuardsResult | null {
	if (!isBash(toolName) || !shouldBlockNetwork(session, taint)) return null;
	const cmd = (toolInput.command as string) || "";
	if (!isNetworkCommand(cmd)) return null;
	return {
		kind: "block",
		decision: {
			decision: "block",
			reason: `BLOCKED: Outbound network command while session is tainted at ${session.sensitivity_level} level (tainted by: ${formatTaintSources(session)}). Sensitive data may be exfiltrated.`,
			warnings,
		},
	};
}

/**
 * Stage 4a — escalate `tainted_network_internal` when a network command runs
 * at Internal sensitivity (Confidential+ is hard-blocked in stage 2). Returns
 * the escalation request, or null when it does not apply.
 */
function buildTaintedNetworkInternalEscalation(
	toolName: string,
	toolInput: JsonObject,
	taint: TaintTrackingConfig,
	session: SessionTrajectory,
): EscalationRequest | null {
	if (!isBash(toolName) || shouldBlockNetwork(session, taint)) return null;
	if (SENSITIVITY_ORDER[session.sensitivity_level] < SENSITIVITY_ORDER.Internal) return null;
	const cmd = (toolInput.command as string) || "";
	if (!isNetworkCommand(cmd)) return null;
	return {
		trigger: "tainted_network_internal",
		summary: `Network command while session is tainted at ${session.sensitivity_level} level (tainted by: ${formatTaintSources(session)})`,
		tool_name: toolName,
		tool_input_redacted: { command: "[REDACTED — network command]" },
		sensitivity_level: session.sensitivity_level,
		step_number: session.tool_call_count,
		recent_tool_sequence: session.tool_sequence.slice(-ESCALATION_TAIL_LENGTH),
	};
}

/**
 * Stage 5a — escalate `high_step_budget` when a state-changing tool runs past
 * the high-water mark of the step budget. Returns the escalation request, or
 * null when it does not apply.
 */
function buildHighStepBudgetEscalation(
	toolName: string,
	toolInput: JsonObject,
	session: SessionTrajectory,
): EscalationRequest | null {
	const overThreshold =
		session.step_limit !== Number.POSITIVE_INFINITY &&
		session.tool_call_count > session.step_limit * HIGH_BUDGET_THRESHOLD;
	if (!overThreshold) return null;
	if (!isFileWrite(toolName) && !isBash(toolName)) return null;
	const filePath = (toolInput.file_path as string) || "";
	return {
		trigger: "high_step_budget",
		summary: `Agent at ${Math.round((session.tool_call_count / session.step_limit) * 100)}% of step budget (${session.tool_call_count}/${session.step_limit}) with state-changing tool`,
		tool_name: toolName,
		tool_input_redacted: filePath ? { file_path: filePath } : { command: "[REDACTED]" },
		sensitivity_level: session.sensitivity_level,
		step_number: session.tool_call_count,
		recent_tool_sequence: session.tool_sequence.slice(-ESCALATION_TAIL_LENGTH),
	};
}

/**
 * Stage 6 — step-limit graceful degradation: read-only tools stay allowed
 * (with a wrap-up warning) while mutations are blocked once the limit is
 * exceeded. Returns a terminal result, or null when under the limit.
 */
function checkStepLimitDegradation(
	toolName: string,
	session: SessionTrajectory,
	warnings: string[],
): TaintGuardsResult | null {
	if (!isStepLimitExceeded(session)) return null;
	if (READ_ONLY_TOOLS_ON_BUDGET.has(toolName)) {
		warnings.push(
			`[interlinked:budget] Step limit (${session.step_limit}) exceeded — read-only mode. Mutations are blocked. Wrap up and commit.`,
		);
		return { kind: "allow-readonly", decision: { decision: "allow", warnings } };
	}
	return {
		kind: "block",
		decision: {
			decision: "block",
			reason: `BLOCKED: Step limit (${session.step_limit}) exceeded at ${session.sensitivity_level} sensitivity level. Read-only tools (Read, Glob, Grep) are still allowed.`,
			warnings,
		},
	};
}

interface TaintGuardsArgs {
	toolName: string;
	toolInput: JsonObject;
	rules: GuardRulesConfig;
	session: SessionTrajectory;
	pendingEscalation: EscalationRequest | undefined;
}

/** Public API — consumed by evaluator/pre-tool.ts when `rules.taint_tracking.enabled`
 *  and a live session are both present. Encapsulates all four sub-checks:
 *  sensitivity ratcheting, tainted-network blocking, step-budget warnings,
 *  and step-limit graceful degradation. */
export function evaluateTaintGuards(args: TaintGuardsArgs): TaintGuardsResult {
	const { toolName, toolInput, rules, session } = args;
	const warnings: string[] = [];
	let escalation = args.pendingEscalation;

	// `GuardRulesConfig.taint_tracking` is declared non-optional, but that's
	// the fully-defaulted `resolveConfig()` shape, not a runtime guarantee at
	// every call site: `taintTrackingOf` documents the boundary this defends
	// (mutation-kill + unit tests deliberately construct configs missing the
	// field to model stale/partial config objects).
	const taint = taintTrackingOf(rules);
	if (!taint) return { kind: "ok", warnings, escalation };

	// Stage 1 — on file read, check sensitivity and ratchet (mutates session/warnings).
	applySensitivityRatchet(toolName, toolInput, taint, session, warnings);

	// Stage 2 — hard block on network commands when tainted.
	const networkBlock = checkTaintedNetworkBlock(toolName, toolInput, taint, session, warnings);
	if (networkBlock) return networkBlock;

	// Stage 3 — provenance axis (orthogonal to sensitivity): an external-action
	// tool whose input references a taint source with untrusted provenance
	// (fetched_external / mcp_remote) gets a confirmation prompt. The
	// sensitivity-axis hard block above already catches Confidential+
	// exfiltration; this catches Public-but-untrusted data flowing outward.
	const provenanceAskDecision = checkProvenanceTaintToExternalAction(
		toolName,
		toolInput,
		session,
	);
	if (provenanceAskDecision) {
		return { kind: "ask", decision: { ...provenanceAskDecision, warnings } };
	}

	// Stage 4 — ESCALATION tainted_network_internal: network command at Internal
	// sensitivity. Confidential+ is hard-blocked above; Internal is a judgment
	// call for the classifier. First escalation wins (precedence over stage 5).
	if (!escalation) {
		escalation =
			buildTaintedNetworkInternalEscalation(toolName, toolInput, taint, session) ?? undefined;
	}

	// Stage 5 — step budget warnings (at 80% and 95%).
	const budgetWarning = getStepBudgetWarning(session);
	if (budgetWarning) warnings.push(budgetWarning);

	// Stage 5b — ESCALATION high_step_budget: approaching step limit with a
	// state-changing tool (only if no escalation was raised in stage 4).
	if (!escalation) {
		escalation = buildHighStepBudgetEscalation(toolName, toolInput, session) ?? undefined;
	}

	// Stage 6 — step limit check: graceful degradation (block mutations, allow
	// reads) so the agent can investigate and hand off cleanly.
	const stepLimitResult = checkStepLimitDegradation(toolName, session, warnings);
	if (stepLimitResult) return stepLimitResult;

	return { kind: "ok", warnings, escalation };
}
