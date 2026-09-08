// ===========================================
// Auto-Coordination — Periodic read-only check-in with MCP server
// ===========================================
// Handles routine plumbing (heartbeat, inbox check, task state) during
// PreToolUse evaluation. Read-only: only mutation is heartbeat update.
// Fail-open: server unreachable → skip, no warnings.

import type { HarnessDecision, SessionTrajectory } from "./types.js";

// ===========================================
// Types
// ===========================================

export interface AutoCoordinationConfig {
	/** Whether auto-coordination is enabled (default: false for v1) */
	enabled: boolean;
	/** Tool call count interval between checks (default: 10) */
	check_interval: number;
	/** Minimum time between checks in ms (default: 30000 = 30s) */
	min_interval_ms: number;
	/** Force check after this many ms (default: 120000 = 2min) */
	max_interval_ms: number;
	/** HTTP timeout in ms (default: 2000) */
	timeout_ms: number;
	/** Tools to skip coordination for (default: ["Read", "Glob", "Grep", "Ls"]) */
	skip_tools: string[];
	/** Minimum importance level to inject as warning (default: "high") */
	urgent_importance: string;
	/** Disable after this many consecutive misses (default: 5) */
	max_misses_before_disable: number;
}

export interface AutoCoordinationState {
	/** tool_call_count at last successful check-in */
	lastCoordAt: number;
	/** Date.now() at last successful check-in */
	lastCoordTs: number;
	/** Failed check-ins in a row */
	consecutiveMisses: number;
	/** Lifetime successful check-in count for this session */
	totalCheckins: number;
	/** Set true after max_misses exceeded — stops attempts for rest of session */
	disabled: boolean;
}

export interface CoordinationResponse {
	heartbeat_recorded: boolean;

	unread: {
		/** Total unread messages across all importance levels */
		total: number;
		/** Messages at urgent_importance threshold or above (max 5) */
		urgent: Array<{
			id: number;
			subject: string;
			importance: string;
			sender_name: string;
			preview: string;
		}>;
	};

	/** Tasks that were cancelled, blocked, or reassigned in the last 5 minutes */
	task_changes: Array<{
		id: number;
		title: string;
		status: string;
		change_type: "reassigned" | "cancelled" | "blocked";
		current_assignee?: string;
	}>;

	/** Agent's active intent (if assigned), null otherwise */
	intent?: {
		id: number;
		goal: string;
		status: string;
		constraints: string;
	} | null;

	server_time?: string;
}

// ===========================================
// Default Configuration
// ===========================================

export const DEFAULT_AUTO_COORDINATION_CONFIG: AutoCoordinationConfig = {
	enabled: false,
	check_interval: 10,
	min_interval_ms: 30_000,
	max_interval_ms: 120_000,
	timeout_ms: 2_000,
	skip_tools: ["Read", "Glob", "Grep", "Ls"],
	urgent_importance: "high",
	max_misses_before_disable: 5,
};

// ===========================================
// State Factory
// ===========================================

export function createAutoCoordinationState(): AutoCoordinationState {
	return {
		lastCoordAt: 0,
		lastCoordTs: Date.now(),
		consecutiveMisses: 0,
		totalCheckins: 0,
		disabled: false,
	};
}

// ===========================================
// Interval Logic
// ===========================================

/**
 * Determine whether the harness should coordinate with the server on this tool call.
 * Pure function — no side effects, no I/O.
 */
export function shouldCoordinate(
	session: SessionTrajectory,
	state: AutoCoordinationState,
	config: AutoCoordinationConfig,
	toolName: string,
): boolean {
	if (!config.enabled) return false;
	if (state.disabled) return false;
	if (config.skip_tools.includes(toolName)) return false;

	const stepsSince = session.tool_call_count - state.lastCoordAt;
	const msSince = Date.now() - state.lastCoordTs;

	// Force check if max interval exceeded (agent has been busy for a while)
	if (msSince >= config.max_interval_ms) return true;

	// Skip if under min interval (prevent rapid-fire during bursts)
	if (msSince < config.min_interval_ms) return false;

	// Normal interval check
	return stepsSince >= config.check_interval;
}

// ===========================================
// Warning Injection
// ===========================================

/**
 * Convert a CoordinationResponse from the server into HarnessDecision warnings.
 * Each urgent message, high unread count, or task change becomes a separate
 * `[interlinked:coord]` warning line that flows through the hook script to the agent.
 *
 * Mutates `decision.warnings` in place.
 */
export function injectCoordinationWarnings(
	decision: HarnessDecision,
	response: CoordinationResponse,
): void {
	const warnings = decision.warnings ?? [];

	// Urgent messages — each one is a separate warning line
	for (const msg of response.unread.urgent) {
		warnings.push(
			`[interlinked:coord] ${msg.importance.toUpperCase()} from ${msg.sender_name}: "${msg.subject}" — ${msg.preview}`,
		);
	}

	// High unread count nudge (only if > 5 total unread)
	if (response.unread.total > 5) {
		warnings.push(
			`[interlinked:coord] ${response.unread.total} total unread messages. Use execute_coordination_script to check your inbox.`,
		);
	}

	// Task changes
	for (const tc of response.task_changes) {
		if (tc.change_type === "reassigned") {
			warnings.push(
				`[interlinked:coord] Task "${tc.title}" was reassigned to ${tc.current_assignee}. Stop work on this task.`,
			);
		} else {
			warnings.push(`[interlinked:coord] Task "${tc.title}" is now ${tc.change_type}.`);
		}
	}

	// Only update decision if we added new warnings
	if (warnings.length > (decision.warnings?.length ?? 0)) {
		decision.warnings = warnings;
	}
}
