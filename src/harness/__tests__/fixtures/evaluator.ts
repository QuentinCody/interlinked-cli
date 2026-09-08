import type { HarnessEvent, SessionTrajectory } from "../../types.js";

// Deterministic fixtures. Tests don't rely on relative time calculations
// that need real `Date.now()` — they only need a valid timestamp shape.
export const FIXED_NOW = 1_700_000_000_000;
export const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

export function makeMinimalEvent(): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "test-session",
		agent_source: "claude",
		timestamp: FIXED_TIMESTAMP,
	};
}

export function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		...makeMinimalEvent(),
		agent_name: "test-agent",
		tool_name: "Bash",
		tool_input: { command: "ls -la" },
		...overrides,
	};
}

export function makeSession(): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 0,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: FIXED_NOW,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
	};
}
