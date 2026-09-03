// ===========================================
// PreToolUse — later guard / context / escalation phases
// ===========================================
//
// Extracted verbatim from `evaluatePreToolUse` (pre-tool.ts) to keep the
// orchestrator under the per-file line cap. These cover the pre-checks tail
// (self-kill / env-leak / line-cap / stale-branch / dirty-tree / large-file /
// concurrent-edit) and the late escalation / permission-pattern / error-memory
// phases. Helpers push into the shared `warnings` array by reference and either
// return a `HarnessDecision` to short-circuit or mutate session state in place;
// control-flow order is unchanged.

import { isAbsolute, resolve } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import type { ErrorHistory } from "../error-history.js";
import { getPatternWarnings } from "../pattern-detector.js";
import {
	checkConcurrentEdit,
	checkDirtyWorkingTree,
	checkEnvLeakToGit,
	checkLargeFileLineCountWrite,
	checkLargeFileWrite,
	checkSelfKill,
	checkStaleBranch,
} from "../pre-checks.js";
import type { ProjectGraph } from "../project-graph.js";
import type { SessionTracker } from "../session-state.js";
import type {
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import { checkCognitiveComplexityWrite } from "./cognitive-write-guard.js";
import { recordComplexityPulse } from "./complexity-pulse.js";
import { checkFunctionComplexityWrite } from "./complexity-write-guard.js";
import { checkFunctionTokenWrite } from "./function-token-write-guard.js";
import { recordFunctionTokenPulse } from "./function-token-pulse.js";
import { addPermissionToSettings, extractPermissionPattern } from "./permission-patterns.js";
import { checkTestSignalErosion } from "./pre-tool-test-integrity.js";
import { estimateEditLine, isBash, isFileWrite, isReadOperation } from "./tool-classifiers.js";

const ESCALATION_TAIL_LENGTH = 10;
const STALE_BRANCH_CHECK_LIMIT = 3;
const PERMISSION_PATTERN_THRESHOLD = 3;

/** The harness event's tool-input bag, normalized to a non-undefined object. */
type ToolInput = NonNullable<HarnessEvent["tool_input"]>;

/**
 * PRE-CHECKS (head): self-kill + env-leak-to-git. Runs before the manifest
 * guard in the original order. `warnings` mutated by reference. Returns a
 * `HarnessDecision` to short-circuit, else `null`.
 */
export function evaluatePreChecksSelfKillEnv(
	event: HarnessEvent,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): HarnessDecision | null {
	const eventCwd = event.cwd || process.cwd();
	const selfKillBlock = blockSelfKillCommand(toolName, toolInput);
	if (selfKillBlock) return selfKillBlock;
	return blockEnvLeakToGitWrite(toolName, toolInput, eventCwd, warnings);
}

/** Self-kill pre-check for a Bash command. Non-Bash / empty commands are a
 *  no-op (null), so the caller needs no surrounding branch. */
function blockSelfKillCommand(toolName: string, toolInput: ToolInput): HarnessDecision | null {
	if (!isBash(toolName)) return null;
	const command = (toolInput.command as string) || "";
	if (!command) return null;
	const selfKillResult = checkSelfKill(command);
	if (!selfKillResult?.block) return null;
	return {
		decision: "block",
		reason: selfKillResult.block,
		rule_id: "self-kill-protection",
		severity: "critical",
		category: "process-killing",
	};
}

/** Env-leak-to-git pre-check for a file write. Blocks, or pushes the advisory
 *  warning by reference; a no-op (null) for non-writes / pathless inputs. */
function blockEnvLeakToGitWrite(
	toolName: string,
	toolInput: ToolInput,
	eventCwd: string,
	warnings: string[],
): HarnessDecision | null {
	if (!isFileWrite(toolName)) return null;
	const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
	if (!filePath) return null;
	const content = (toolInput.content as string) || (toolInput.new_string as string);
	const envResult = checkEnvLeakToGit(filePath, content, eventCwd);
	if (envResult?.block) {
		return {
			decision: "block",
			reason: envResult.block,
			rule_id: "env-leak-to-git",
			severity: "high",
			category: "security",
		};
	}
	if (envResult?.warning) warnings.push(envResult.warning);
	return null;
}

/**
 * PRE-CHECKS (tail): per-file line cap, stale-branch, dirty-tree, large-file,
 * concurrent-edit. Runs after the manifest guard in the original order.
 * Mirrors the original inline block exactly. `warnings` mutated by reference.
 * Returns a `HarnessDecision` to short-circuit, else `null`.
 */
/** Push the test-signal-erosion warning (DW P0.3 b/c) when applicable. A no-op
 *  for non-writes / non-test files (the guard lives in `checkTestSignalErosion`),
 *  so it can be called unconditionally without adding branches to the caller. */
function maybeWarnTestErosion(
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	eventCwd: string,
	warnings: string[],
): void {
	if (!session) return;
	const erosion = checkTestSignalErosion(event.tool_name ?? "", event.tool_input ?? {}, session, eventCwd);
	if (erosion) warnings.push(erosion);
}

/**
 * GUARD: per-file line cap + per-function cyclomatic/cognitive caps for a
 * Write/Edit/MultiEdit/apply_patch. Extracted out of `evaluatePreChecksTail`
 * so the two metric gates' combined branching doesn't inflate the
 * orchestrator's own complexity (dogfooded: this split is what took
 * `evaluatePreChecksTail` back under the cognitive cap after cognitive
 * promotion landed — see scratch/cognitive-verify.mts). A no-op (null) for
 * non-file-write tools.
 */
function checkFileWriteMetricCaps(
	event: HarnessEvent,
	eventCwd: string,
	toolName: string,
	toolInput: ToolInput,
): HarnessDecision | null {
	if (!isFileWrite(toolName)) return null;
	// GUARD: per-file line cap — block a Write/Edit that would grow a
	// hand-written code file past the cap (see large-file-policy.ts).
	const sizeBlock = checkLargeFileLineCountWrite(toolInput, eventCwd);
	if (sizeBlock?.block) {
		return {
			decision: "block",
			reason: sizeBlock.block,
			rule_id: "large-file-cap",
			severity: "medium",
			category: "file-size",
		};
	}
	// GUARD: per-function cyclomatic cap — block a Write/Edit that introduces
	// or worsens an over-cap function (delta semantics, no override). See
	// complexity-write-guard.ts. The observer stashes the gate's already-paid
	// before/after parses for the PostToolUse pulse (complexity-pulse.ts).
	const complexityBlock = checkFunctionComplexityWrite(
		toolInput,
		eventCwd,
		(filePath, beforeFns, afterFns, afterContent) => {
			const absPath = isAbsolute(filePath) ? filePath : resolve(eventCwd, filePath);
			recordComplexityPulse(event.session_id, absPath, beforeFns, afterFns, afterContent);
		},
	);
	// GUARD: per-function cognitive-complexity cap — promoted from warn-only
	// to a block (2026-08-01) with the SAME delta-semantics contract, mirrored
	// in cognitive-write-guard.ts. Runs independently of the cyclomatic gate
	// above so neither shadows the other: a file can trip cognitive alone,
	// cyclomatic alone, or both (reasons are concatenated below when both fire).
	const cognitiveBlock = checkCognitiveComplexityWrite(toolInput, eventCwd);
	const functionTokenBlock = checkFunctionTokenWrite(
		toolInput,
		eventCwd,
		(filePath, beforeFns, afterFns, afterContent) => {
			const absPath = isAbsolute(filePath) ? filePath : resolve(eventCwd, filePath);
			recordFunctionTokenPulse(event.session_id, absPath, beforeFns, afterFns, afterContent);
		},
	);
	if (!complexityBlock?.block && !cognitiveBlock?.block && !functionTokenBlock?.block) return null;
	// rule_id stays "cyclomatic-cap" when the cyclomatic gate fires (even
	// alongside cognitive) to preserve the existing rule_id contract other
	// consumers pin on; a cognitive-only block gets its own distinct id.
	return {
		decision: "block",
		reason: [complexityBlock?.block, cognitiveBlock?.block, functionTokenBlock?.block]
			.filter(Boolean)
			.join("\n\n"),
		rule_id: complexityBlock?.block
			? "cyclomatic-cap"
			: cognitiveBlock?.block
				? "cognitive-cap"
				: "function-tokens-cap",
		severity: "medium",
		category: "complexity",
	};
}

/** Tail WARNING-only checks: stale-branch, dirty-tree, byte-size large-file,
 *  concurrent-edit, test-signal erosion. Never blocks; pushes into `warnings`
 *  by reference. Split out of `evaluatePreChecksTail` alongside
 *  `checkFileWriteMetricCaps` for the same complexity-budget reason. */
function pushStaleBranchWarning(
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	eventCwd: string,
	warnings: string[],
): void {
	if (session && session.tool_call_count <= STALE_BRANCH_CHECK_LIMIT) {
		const staleResult = checkStaleBranch(eventCwd, event.session_id);
		if (staleResult?.warning) warnings.push(staleResult.warning);
	}
}

function pushDirtyTreeWarning(
	toolName: string,
	toolInput: ToolInput,
	eventCwd: string,
	warnings: string[],
): void {
	if (!isBash(toolName)) return;
	const command = (toolInput.command as string) || "";
	if (!command) return;
	const dirtyResult = checkDirtyWorkingTree(command, eventCwd);
	if (dirtyResult?.warning) warnings.push(dirtyResult.warning);
}

function pushLargeFileByteWarning(toolName: string, toolInput: ToolInput, warnings: string[]): void {
	if (!isFileWrite(toolName)) return;
	const content = (toolInput.content as string) || "";
	const largeResult = checkLargeFileWrite(content);
	if (largeResult?.warning) warnings.push(largeResult.warning);
}

function pushConcurrentEditWarning(
	event: HarnessEvent,
	sessions: SessionTracker | undefined,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): void {
	if (!isFileWrite(toolName) || !sessions) return;
	const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
	if (!filePath) return;
	const concurrentResult = checkConcurrentEdit(filePath, event.session_id, sessions.getAll());
	if (concurrentResult?.warning) warnings.push(concurrentResult.warning);
}

function pushTailWarnings(
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	sessions: SessionTracker | undefined,
	eventCwd: string,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): void {
	pushStaleBranchWarning(event, session, eventCwd, warnings);
	pushDirtyTreeWarning(toolName, toolInput, eventCwd, warnings);
	pushLargeFileByteWarning(toolName, toolInput, warnings);
	pushConcurrentEditWarning(event, sessions, toolName, toolInput, warnings);
	maybeWarnTestErosion(event, session, eventCwd, warnings);
}

export function evaluatePreChecksTail(
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	sessions: SessionTracker | undefined,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): HarnessDecision | null {
	const eventCwd = event.cwd || process.cwd();
	const metricBlock = checkFileWriteMetricCaps(event, eventCwd, toolName, toolInput);
	if (metricBlock) return metricBlock;
	pushTailWarnings(event, session, sessions, eventCwd, toolName, toolInput, warnings);
	return null;
}

/**
 * ESCALATION: post_injection_action — compute a pending escalation request
 * when a state-changing tool runs after an injection was detected. Returns
 * the new `EscalationRequest` (or the existing one unchanged). Mirrors the
 * original inline guard, which only synthesizes when `!pendingEscalation`.
 */
export function computePostInjectionEscalation(
	_event: HarnessEvent,
	session: SessionTrajectory | undefined,
	toolName: string,
	toolInput: ToolInput,
	pendingEscalation: EscalationRequest | undefined,
): EscalationRequest | undefined {
	if (
		session &&
		session.injection_detected_steps.length > 0 &&
		(isBash(toolName) || isFileWrite(toolName)) &&
		!pendingEscalation
	) {
		const lastInjectionStep = nonNull(
			session.injection_detected_steps[session.injection_detected_steps.length - 1],
		);
		const stepsSince = session.tool_call_count - lastInjectionStep;
		const filePath = (toolInput.file_path as string) || "";
		return {
			trigger: "post_injection_action",
			summary: `State-changing tool (${toolName}) used ${stepsSince} steps after injection was detected at step ${lastInjectionStep}`,
			tool_name: toolName,
			tool_input_redacted: filePath ? { file_path: filePath } : { command: "[REDACTED]" },
			sensitivity_level: session.sensitivity_level,
			step_number: session.tool_call_count,
			recent_tool_sequence: session.tool_sequence.slice(-ESCALATION_TAIL_LENGTH),
		};
	}
	return pendingEscalation;
}

/**
 * PERMISSION PATTERN DETECTION — tracks consecutive identical permission
 * patterns and writes a settings allowlist entry once the threshold is hit.
 * Mutates `session` and pushes to `warnings` (both by reference), exactly as
 * the original inline block.
 */
export function evaluatePermissionPatternDetection(
	session: SessionTrajectory | undefined,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): void {
	if (!session) return;
	const pattern = extractPermissionPattern(toolName, toolInput);
	if (pattern === null) {
		session.consecutive_pattern = null;
		return;
	}
	if (!pattern || session.suggested_permissions.has(pattern)) return;
	if (session.consecutive_pattern?.pattern === pattern) {
		session.consecutive_pattern.count++;
	} else {
		session.consecutive_pattern = { pattern, count: 1 };
	}
	if (session.consecutive_pattern.count < PERMISSION_PATTERN_THRESHOLD) return;
	suggestPermission(session, pattern, warnings);
}

/** Record the run of identical permission patterns as a settings allowlist
 *  entry and reset the run counter. Called once the threshold is reached. */
function suggestPermission(
	session: SessionTrajectory,
	pattern: string,
	warnings: string[],
): void {
	session.suggested_permissions.add(pattern);
	const added = addPermissionToSettings(pattern);
	if (added) {
		warnings.push(
			`[interlinked:permissions] Added "${pattern}" to .claude/settings.json — you won't be prompted for this again.`,
		);
	}
	session.consecutive_pattern = null;
}

/**
 * CONTEXT: Error memory — cross-session history. Surfaces per-file error
 * history and pattern warnings. Pushes to `warnings` by reference, identical
 * to the original inline block.
 */
export function evaluateErrorMemory(
	_event: HarnessEvent,
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
	graph: ProjectGraph | undefined,
	errorHistory: ErrorHistory | undefined,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): void {
	// SAFETY: `error_memory` is declared required on GuardRulesConfig, but a
	// partially-constructed rules object (test fixtures modeling that state,
	// and potentially a partial hot-reload merge) can omit it.
	const errorMemory = rules.error_memory as GuardRulesConfig["error_memory"] | undefined;
	if (!errorHistory || !errorMemory?.enabled) return;
	if (!isFileWrite(toolName) && !isReadOperation(toolName)) return;
	const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
	if (!filePath || !graph) return;
	const relPath = graph.toRelative(filePath);
	const historyWarning = errorHistory.getFileHistoryWarning(relPath);
	if (historyWarning) warnings.push(historyWarning);
	if (!session) return;
	const patternWarnings = getPatternWarnings(
		errorHistory.getRecords(),
		relPath,
		session,
		editedLineNumber(toolName, toolInput, filePath),
	);
	warnings.push(...patternWarnings);
}

/** The 1-based line an Edit targets, for pattern-warning locality. Undefined
 *  for any tool other than Edit, or when the edit carries no `old_string`. */
function editedLineNumber(
	toolName: string,
	toolInput: ToolInput,
	filePath: string,
): number | undefined {
	if (toolName !== "Edit" || !toolInput.old_string || !filePath) return undefined;
	return estimateEditLine(filePath, toolInput.old_string as string);
}
