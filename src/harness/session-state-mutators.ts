// interlinked-tdd: exempt
// ===========================================
// Session State — per-event trajectory mutators + ack helpers
// ===========================================
//
// Leaf helpers split out of session-state.ts to keep that file under the
// per-file line cap. These are the per-tool-call/per-file/per-command
// trajectory mutators driven by SessionTracker.recordEvent, the fresh-session
// builder, the subagent-rollup merge helpers, and the session-ack suppression
// helpers. None of them reference SessionTracker or module-private state, so
// they live cleanly in a sibling that session-state.ts imports back from.

import { resolve as resolvePath } from "node:path";
import { nonNull } from "../lib/non-null.js";
import { recordFileView } from "./read-provenance.js";
import { captureGitBaseline } from "./session-git-baseline.js";
import {
	extractWriteChunks,
	isPostToolUseEvent,
	isSequenceWriteOperation,
	recordLiteralOccurrences,
	recordRecentLineEdit,
} from "./session-literals.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";
import {
	classifyBrowserToolName,
	classifyVerificationCommand,
	isTestRunnerCommand,
	STUB_INTRODUCED_CAP,
} from "./verification-stop-checks.js";

/** Bound on `SessionTrajectory.test_commands_run` — see its doc comment in
 *  `types/session.ts`. Kept far above `commands_run`'s 100-entry ring since
 *  it only accumulates recognized test-runner commands, a small fraction of
 *  total Bash traffic. */
const TEST_COMMANDS_RUN_CAP = 500;
/** Per-entry char cap for `test_commands_run` — generous relative to
 *  `commands_run`'s 200 so a long test-runner invocation's file argument
 *  never falls past the cut (the defect this list exists to fix). */
const TEST_COMMAND_TEXT_CAP = 2000;

/**
 * Set-union the subagent's verification_observed signals into the parent.
 * Extracted from rollUpVerificationSignals to keep that orchestrator thin;
 * lazily allocates the parent's set on first use.
 */
export function mergeVerificationObserved(from: SessionTrajectory, to: SessionTrajectory): void {
	if (!from.verification_observed || from.verification_observed.size === 0) return;
	if (!to.verification_observed) to.verification_observed = new Set();
	for (const sig of from.verification_observed) to.verification_observed.add(sig);
}

/**
 * Append the subagent's introduced stubs onto the parent, honoring the global
 * STUB_INTRODUCED_CAP. Extracted from rollUpVerificationSignals; lazily
 * allocates the parent's array on first use.
 */
export function appendStubsCapped(from: SessionTrajectory, to: SessionTrajectory): void {
	if (!from.stubs_introduced || from.stubs_introduced.length === 0) return;
	if (!to.stubs_introduced) to.stubs_introduced = [];
	for (const stub of from.stubs_introduced) {
		if (to.stubs_introduced.length >= STUB_INTRODUCED_CAP) break;
		to.stubs_introduced.push({ ...stub });
	}
}

/**
 * Build a fresh SessionTrajectory for a not-yet-seen session id. Split out of
 * recordEvent so the orchestrator stays a thin dispatcher; the object literal
 * carries no decision logic beyond its two coalescing defaults.
 */
export function createFreshSession(event: HarnessEvent, sessionId: string): SessionTrajectory {
	return {
		session_id: sessionId,
		agent_name: event.agent_name || `session-${sessionId.slice(0, 8)}`,
		started_at: event.timestamp,
		tool_call_count: 0,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		test_commands_run: [],
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
		last_coordination_ts: Date.now(),
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		active_skills: new Map(),
		non_doc_files_edited_since_commit: new Set(),
		doc_files_edited_since_commit: 0,
		mid_session_nudge_emitted: false,
		stop_nudge_emitted: false,
		assertion_counts: new Map(),
		verification_observed: new Set(),
		observed_checks: new Map(),
		stubs_introduced: [],
		git_session_baseline: captureGitBaseline(event.cwd ?? process.cwd()),
	};
}

/**
 * Per-tool-call bookkeeping: total/MCP/local counts, the bounded tool sequence
 * used for pattern detection, and browser-MCP UI-verification signals. No-op
 * when the event carries no tool_name.
 */
export function trackToolCall(session: SessionTrajectory, event: HarnessEvent): void {
	if (!event.tool_name) return;
	session.tool_call_count++;

	// Classify as MCP or local tool
	if (event.tool_name.startsWith("mcp__")) {
		session.mcp_tools_used++;
	} else {
		session.local_tools_used++;
	}

	// Track tool sequence for pattern detection
	const target = extractToolTarget(event);
	session.tool_sequence.push(`${event.tool_name}:${target}`);
	if (session.tool_sequence.length > 20) {
		session.tool_sequence = session.tool_sequence.slice(-20);
	}

	// Verification-before-stop: record browser-MCP interactions as a UI
	// verification signal. Bash-command verification signals are captured in
	// trackCommand.
	const browserKind = classifyBrowserToolName(event.tool_name);
	if (browserKind) {
		if (!session.verification_observed) session.verification_observed = new Set();
		session.verification_observed.add(browserKind);
	}
}

/**
 * Outcome-gated error/recovery counters. Increments error_count and the
 * per-tool consecutive-failure counter on `error`; a `success` for a tool
 * resets that tool's counter.
 *
 * Outcome-gated, not event-name-gated: Claude/Codex/Gemini/Copilot fold tool
 * failures into the regular Post* event carrying tool_outcome === "error", and
 * Cursor's dedicated postToolUseFailure also produces tool_outcome === "error"
 * via the attachOutcome call in the normalizer. The previous event-name gates
 * were inverted for folded failures — error_count never bumped, and
 * consecutive_tool_failures was *cleared* by the very events that should have
 * incremented it. Phase 1 channels (recurrence, triage, recovery) read these
 * counters to make decisions.
 */
export function trackErrorOutcome(session: SessionTrajectory, event: HarnessEvent): void {
	if (event.tool_outcome === "error") {
		session.error_count++;
		if (event.tool_name) {
			const prev = session.consecutive_tool_failures.get(event.tool_name) || 0;
			session.consecutive_tool_failures.set(event.tool_name, prev + 1);
		}
	} else if (event.tool_outcome === "success" && event.tool_name) {
		// A successful invocation of this tool resets the consecutive counter.
		session.consecutive_tool_failures.delete(event.tool_name);
	}
}

/**
 * Read/write file-tracking for one event. Provenance gate (Channel 5 rollback
 * feasibility) requires files_written contain only paths we actually wrote
 * successfully — gating on a non-error/non-interrupted outcome prevents a
 * failed Edit attempt from being attributed to us. Path normalization stores
 * BOTH the raw form (preserves existing `.has(rawPath)` consumers in
 * structural-checks / behavioral-checks / suggestion-scorer) AND the resolved
 * absolute form (lets the Channel 5 provenance check do `.has(resolve(cwd, p))`
 * reliably regardless of input shape). Any write (even a failed one) clears
 * acknowledged checks for the file. Assumes a file_path and tool_name present.
 */
function trackReadWrite(
	session: SessionTrajectory,
	event: HarnessEvent,
	filePath: string,
	absPath: string,
): void {
	const toolName = event.tool_name;
	if (isReadOperation(toolName)) {
		session.files_read.add(filePath);
		if (absPath !== filePath) session.files_read.add(absPath);
		session.file_read_at.set(filePath, session.tool_call_count);
	}
	if (isWriteOperation(toolName)) {
		const writeSucceeded = event.tool_outcome !== "error" && event.tool_outcome !== "interrupted";
		if (writeSucceeded) {
			session.files_written.add(filePath);
			if (absPath !== filePath) session.files_written.add(absPath);
			session.file_write_times.set(filePath, event.timestamp);
			session.file_edit_counts.set(filePath, (session.file_edit_counts.get(filePath) || 0) + 1);
		}
		// Clear acknowledged checks for this file — a new edit (even a failed
		// one) may introduce genuinely different issues on the next attempt.
		clearAcknowledgedChecksForFile(session, filePath);
	}
}

/**
 * Sequence-detector input population (§3.5 / §3.18 / §3.21). Feeds
 * add_then_revert_loop and magic_literal_cross_file_proliferation; detectors
 * silently no-op when the maps are empty.
 *
 * Post-tool-use only, success-only. The §3.21 add-then-revert detector reasons
 * about *content states the file actually passed through*. A PreToolUse Edit
 * event is an INTENDED edit that may be blocked (tsc overlay, reservation
 * conflict, guard) and never land — recording it would count a state the file
 * never reached. It also double-counts: every successful edit fires both a
 * PreToolUse (outcome undefined) and a PostToolUse (outcome "success") event,
 * so recording on both inflated each file's history with a phantom duplicate.
 * The FP that motivated this gate: a blocked edit leaves the file unchanged,
 * the agent retries successfully, and the blocked attempt got counted as a
 * prior content state — firing "cycled back N times" on clean forward progress
 * with zero reverts. PostToolUse is the only point where the chunk reflects
 * content that genuinely reached disk.
 */
function recordSequenceInputs(
	session: SessionTrajectory,
	event: HarnessEvent,
	filePath: string,
): void {
	if (!isSequenceWriteOperation(event.tool_name) || !isPostToolUseEvent(event)) return;
	const seqWriteSucceeded =
		event.tool_outcome !== "error" && event.tool_outcome !== "interrupted";
	if (!seqWriteSucceeded) return;
	for (const chunk of extractWriteChunks(event)) {
		recordRecentLineEdit(session, filePath, chunk);
		recordLiteralOccurrences(session, filePath, chunk);
	}
}

/** Resolve pending completions when the agent reads/edits an affected file. */
function resolvePendingCompletions(session: SessionTrajectory, filePath: string): void {
	for (const [, completion] of session.pending_completions) {
		if (completion.affected_files.includes(filePath)) {
			completion.resolved_files.add(filePath);
		}
	}
}

/**
 * File-operation tracking for one event: read/write state, sequence-detector
 * inputs, and pending-completion resolution. No-op unless the event carries
 * both a file_path and a tool_name.
 */
export function trackFileOperations(session: SessionTrajectory, event: HarnessEvent): void {
	const filePath = event.tool_input?.file_path as string | undefined;
	if (!filePath || !event.tool_name) return;
	const eventCwd = event.cwd ?? process.cwd();
	const absPath = resolvePath(eventCwd, filePath);
	trackReadWrite(session, event, filePath, absPath);
	// LG-3 read-view snapshot (PostToolUse-gated internally, like sequence
	// inputs): records the content state this session just displayed/produced.
	recordFileView(session, event);
	recordSequenceInputs(session, event, filePath);
	resolvePendingCompletions(session, filePath);
}

/**
 * Command tracking for Bash-family tools: append to the bounded commands_run
 * ring and record the first matching verification-intent signal (typecheck /
 * test / lint / build / dev-server). We track *intent to verify* — a failed
 * `bun test` still counts because the agent did engage the verifier. No-op for
 * non-Bash tools or an absent command.
 */
export function trackCommand(session: SessionTrajectory, event: HarnessEvent): void {
	const command = event.tool_input?.command as string | undefined;
	if (!command || !isBashTool(event.tool_name)) return;
	session.commands_run.push(command.length > 200 ? command.slice(0, 200) : command);
	if (session.commands_run.length > 100) {
		session.commands_run = session.commands_run.slice(-100);
	}
	trackTestCommand(session, command);

	const cmdKind = classifyVerificationCommand(command);
	if (cmdKind) {
		if (!session.verification_observed) session.verification_observed = new Set();
		session.verification_observed.add(cmdKind);
	}
}

/**
 * Append `command` to the durable `test_commands_run` list when it's a
 * test-runner invocation. Split out of `trackCommand` so that function's own
 * cyclomatic count stays flat — this is a straight-line append, no branching
 * beyond the recognizer + cap checks it owns.
 */
function trackTestCommand(session: SessionTrajectory, command: string): void {
	if (!isTestRunnerCommand(command)) return;
	if (!session.test_commands_run) session.test_commands_run = [];
	const text =
		command.length > TEST_COMMAND_TEXT_CAP ? command.slice(0, TEST_COMMAND_TEXT_CAP) : command;
	session.test_commands_run.push(text);
	if (session.test_commands_run.length > TEST_COMMANDS_RUN_CAP) {
		session.test_commands_run = session.test_commands_run.slice(-TEST_COMMANDS_RUN_CAP);
	}
}

/** Extract a short target identifier for tool sequence tracking (used in pattern detection) */
function extractToolTarget(event: HarnessEvent): string {
	const input = event.tool_input || {};
	if (input.file_path) return shortenPath(String(input.file_path));
	if (input.path) return shortenPath(String(input.path));
	if (input.command) {
		const cmd = String(input.command);
		// Extract the core command (first word + key args)
		const parts = cmd.split(/\s+/);
		const base = parts[0];
		if (base === "npx" && parts[1]) return `${base} ${parts[1]}`;
		if (base === "npm" && parts[1]) return `${base} ${parts[1]}`;
		if (base === "git" && parts[1]) return `${base} ${parts[1]}`;
		return nonNull(base).slice(0, 30);
	}
	if (input.url) return String(input.url).slice(0, 40);
	return "";
}

/** Shorten a file path to just filename or last 2 segments */
function shortenPath(filePath: string): string {
	const parts = filePath.split("/").filter(Boolean);
	if (parts.length <= 2) return parts.join("/");
	return parts.slice(-2).join("/");
}

function isReadOperation(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return ["Read", "ReadFile", "read_file", "Glob", "Grep", "grep", "ListFiles"].includes(
		toolName,
	);
}

function isWriteOperation(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return [
		"Write",
		"Edit",
		"WriteFile",
		"EditFile",
		"write_file",
		"edit_file",
		"NotebookEdit",
	].includes(toolName);
}

function isBashTool(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return ["Bash", "Shell", "shell", "run_command"].includes(toolName);
}

// ===========================================
// Session-Ack Suppression Helpers
// ===========================================

/**
 * Build the canonical key for the acknowledged_checks set.
 * Format: "${filePath}::${checkName}"
 */
function ackKey(filePath: string, checkName: string): string {
	return `${filePath}::${checkName}`;
}

/**
 * Record that a file+check warning was shown and the user allowed the agent
 * to continue. Subsequent PostToolUse events for the same pair will skip
 * the warning (unless the file is edited again).
 */
export function acknowledgeChecks(
	session: SessionTrajectory,
	filePath: string,
	checkNames: string[],
): void {
	for (const check of checkNames) {
		session.acknowledged_checks.add(ackKey(filePath, check));
	}
}

/**
 * Check whether a file+check pair has already been acknowledged this session.
 */
export function isAcknowledged(
	session: SessionTrajectory,
	filePath: string,
	checkName: string,
): boolean {
	return session.acknowledged_checks.has(ackKey(filePath, checkName));
}

/**
 * Clear all acknowledged checks for a specific file. Called when the file
 * is edited again — a new edit may introduce genuinely different issues.
 */
function clearAcknowledgedChecksForFile(
	session: SessionTrajectory,
	filePath: string,
): void {
	const prefix = `${filePath}::`;
	for (const key of session.acknowledged_checks) {
		if (key.startsWith(prefix)) {
			session.acknowledged_checks.delete(key);
		}
	}
}
