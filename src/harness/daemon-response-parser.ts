import { isJsonObject } from "../lib/json-types.js";
import { isHookCoverageReport } from "./hook-coverage-control.js";
import type { CheckResultEntry, HarnessDecision } from "./types.js";
import { decodeFrame, isError, type RpcError, type RpcMethod, type RpcResponse, type RpcResult, type TsgoDiagnostic } from "./daemon-protocol.js";
import { wireAbsentOptional, wireArray, wireBoolean, wireLiteral, wireNumber, wireObject, wireOptional, wireRecord, wireString, type WireValidator } from "../lib/value-validation.js";

const stringArray = wireArray(wireString);
const diagnostic = wireObject<TsgoDiagnostic>({
	line: wireNumber, column: wireNumber, code: wireNumber,
	severity: wireLiteral("error", "warning", "info"), message: wireString, file: wireString,
});

const checkResult = wireObject<CheckResultEntry>({
	source: wireLiteral("quality", "structural", "suggestion", "impact", "structure", "spec", "registry_parity"),
	name: wireString, severity: wireLiteral("error", "warning", "info"), message: wireString,
	file: wireAbsentOptional(wireOptional(wireString)), detail: wireAbsentOptional(wireOptional(wireString)), score: wireAbsentOptional(wireOptional(wireNumber)),
	affected_files: wireAbsentOptional(wireOptional(stringArray)), line: wireAbsentOptional(wireOptional(wireNumber)),
	determinism: wireLiteral("fully_deterministic", "partially_deterministic", "heuristic"),
	phase: wireAbsentOptional(wireOptional(wireLiteral("pre_block", "pre_warn", "post"))),
	provenance: wireAbsentOptional(wireOptional(wireLiteral("declared", "extracted", "inferred"))),
	artifact_kind: wireAbsentOptional(wireOptional(wireString)), artifact_id: wireAbsentOptional(wireOptional(wireString)),
	required_updates: wireAbsentOptional(wireOptional(wireArray(wireObject({ file: wireString, kind: wireString, reason: wireString })))),
	confidence: wireAbsentOptional(wireOptional(wireNumber)),
});

export const isHarnessDecision = wireObject<HarnessDecision>({
	decision: wireLiteral("allow", "block", "ask"), reason: wireAbsentOptional(wireOptional(wireString)),
	warnings: wireAbsentOptional(wireOptional(stringArray)), updated_input: wireAbsentOptional(isJsonObject),
	watch_paths: wireAbsentOptional(stringArray),
	log_entries: wireAbsentOptional(wireArray(wireObject<NonNullable<HarnessDecision["log_entries"]>[number]>({ type: wireString, summary: wireString, detail: wireAbsentOptional(wireString) }))),
	reservation: wireAbsentOptional(wireObject<NonNullable<HarnessDecision["reservation"]>>({ action: wireLiteral("reserved", "conflict", "extended", "released"), file: wireString, holder: wireAbsentOptional(wireString), expires_at: wireAbsentOptional(wireString) })),
	rule_id: wireAbsentOptional(wireOptional(wireString)), severity: wireAbsentOptional(wireOptional(wireLiteral("critical", "high", "medium", "low"))),
	category: wireAbsentOptional(wireOptional(wireString)), failing_test_files: wireAbsentOptional(wireOptional(stringArray)),
	check_results: wireAbsentOptional(wireArray(checkResult)),
	checks_skipped: wireAbsentOptional(wireArray(wireObject({ check: wireString, reason: wireString, category: wireLiteral("tool_missing", "config_disabled", "file_type_mismatch", "resource_busy", "timeout", "error") }))),
	checks_timing_ms: wireAbsentOptional(wireNumber), checks_ran: wireAbsentOptional(stringArray),
	tool_breakdown: wireAbsentOptional(wireArray(wireObject({ tool: wireString, ms: wireNumber, finding_count: wireNumber }))),
	phase_breakdown: wireAbsentOptional(wireRecord(wireNumber)),
	grep_stats: wireAbsentOptional(wireObject({ candidates: wireNumber, total_files: wireNumber, selectivity_pct: wireNumber, match_count: wireNumber, accelerated: wireBoolean })),
	summary: wireAbsentOptional(wireString),
	_escalation: wireAbsentOptional(wireOptional(wireObject({ trigger: wireString, summary: wireString, tool_name: wireString, tool_input_redacted: wireRecord(wireString), sensitivity_level: wireLiteral("Public", "Internal", "Confidential", "HighlyConfidential"), step_number: wireNumber, recent_tool_sequence: stringArray }))),
	_contentScan: wireAbsentOptional(wireOptional(wireObject({ hook: wireLiteral("pre_write_edit", "pre_bash_command", "pre_external_egress", "post_read_grep", "user_prompt"), parts: wireArray(wireObject({ source: wireString, text: wireString })) }))),
	additional_context: wireAbsentOptional(wireOptional(wireString)), system_message: wireAbsentOptional(wireString),
	telemetry_receipt_id: wireAbsentOptional(wireOptional(wireString)), findings: wireAbsentOptional(wireArray(checkResult)), redacted_prompt: wireAbsentOptional(wireString),
	resolved_targets: wireAbsentOptional(wireArray(wireObject({ kind: wireLiteral("file", "table", "url", "branch", "recipient", "package"), value: wireString }))),
});

const resultValidators: { [M in RpcMethod]: WireValidator<RpcResult[M]> } = {
	"daemon.coverage": isHookCoverageReport,
	"hook.pre_tool_use": isHarnessDecision, "hook.post_tool_use": isHarnessDecision, "hook.session_start": isHarnessDecision,
	"hook.session_end": isHarnessDecision, "hook.user_prompt": isHarnessDecision, "hook.pre_compact": isHarnessDecision,
	"hook.permission_request": isHarnessDecision, "hook.post_compact": isHarnessDecision, "hook.lifecycle": isHarnessDecision,
	"daemon.health": wireObject({ status: wireLiteral("ready", "warming", "degraded"), uptime_ms: wireNumber,
		warm_caches: stringArray, tsgo_status: wireLiteral("ready", "starting", "unavailable"), rpc_inflight: wireNumber, protocol_version: wireLiteral("1") }),
	"daemon.shutdown": wireObject({ ack: wireLiteral(true) }),
	"daemon.invalidate": wireObject({ ack: wireLiteral(true) }),
	"tsgo.check_file": wireObject({ diagnostics: wireArray(diagnostic), cached: wireBoolean, elapsed_ms: wireNumber }),
	"tsgo.simulate_edit": wireObject({ new_diagnostics: wireArray(diagnostic), elapsed_ms: wireNumber }),
};

/** Validate the response against the method of the correlated request. */
export function parseResponseFrame<M extends RpcMethod>(frame: string, method: M): RpcResponse<M> | RpcError | null {
	let envelope;
	try {
		envelope = decodeFrame(frame);
	} catch {
		return null;
	}
	if (isError(envelope)) return envelope;
	if ("error" in envelope || "method" in envelope) return null;
	const result = envelope.result;
	return resultValidators[method](result) ? { id: envelope.id, result } : null;
}
