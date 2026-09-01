// ===========================================
// Claude Code adapter
// ===========================================
// Native payload reference: https://code.claude.com/docs/en/hooks
// Checked against Claude Code's primary hooks reference as of 2026-09-01.
//
// Decision format:
//   PreToolUse uses hookSpecificOutput.permissionDecision.
//   PermissionRequest uses hookSpecificOutput.decision.behavior.
//   PostToolUse/continuation events use top-level decision: "block".
//   Events that support it receive non-blocking feedback via additionalContext.
//   exit 0 + no stdout = no hook override (ordinary events continue;
//   PermissionRequest keeps Claude's configured permission flow)

import { hookTimeoutSecondsFor } from "../../lib/hook-timeouts.js";
import { agentWorktreeCreationBlockReason } from "../../lib/hook-template-chunks/destructive-command-guard.js";
import { CLAUDE_CODE_WRITE_TOOLS } from "../../lib/write-tool-registry.js";
import { formatAskReasonWithTargets } from "../evaluator/rule-matching.js";
import { type ClassifierOverrides, classifyFromToolName } from "../tool-class-classifier.js";
import type { HarnessDecision } from "../types.js";
import type { UnifiedHookEvent } from "../unified-event.js";
import { buildDetachedHookCommand, buildHookCommand } from "./hook-command.js";
import { buildStandardAction, normalizeNativeHookEvent } from "./normalization.js";
import {
	CLAUDE_CODE_CAPABILITIES,
	eventCapability,
	installedEventNames,
} from "./provider-capabilities.js";
import type { AdapterOutput, RunnerAdapter, SettingsFragment } from "./types.js";

const NATIVE_EVENTS = installedEventNames(CLAUDE_CODE_CAPABILITIES);

function claudeMissingRuntimePolicy(event: string): "fail_closed" | "warn_open" {
	return eventCapability(CLAUDE_CODE_CAPABILITIES, event)?.missing_runtime ?? "warn_open";
}

/**
 * Regex alternation Claude Code matches against the tool name to decide which
 * PostToolUse calls reach this adapter — the tools that can change a file.
 *
 * Registering for EVERY tool (`matcher: ""`) fired the post-tool pipeline on
 * reads and searches. That is not free: the daemon builds the edited-file list
 * from a post-call filesystem diff, so a read-only call inside a busy tree
 * picked up somebody ELSE's writes and ran the whole per-file pass — including
 * `affected_tests`, which shells out to vitest — over them. `Bash` stays IN:
 * only the post-call comparison establishes a shell command's effects, and the
 * bash-edit obligation gate is built on exactly that.
 *
 * Codex derives its own mutating matcher from the same write-tool registry;
 * its native patch spelling is `apply_patch`, not Claude's `Edit`.
 *
 * The names come from `lib/write-tool-registry.ts`, NOT from a list kept here.
 * A second hand-maintained list is exactly how `MultiEdit` came to be registered
 * by this adapter and absent from the quality pipeline's direct-edit list, so a
 * MultiEdit reached the daemon and was then treated as editing nothing. Each
 * name is still spelled out in the alternation rather than relying on `Edit`
 * matching `MultiEdit` as a substring — the explicit list is what a reader can
 * check against the tool inventory.
 */
export const CLAUDE_POST_TOOL_USE_MATCHER = CLAUDE_CODE_WRITE_TOOLS.join("|");

interface ClaudeCodeAdapterOptions {
	/** Pre-loaded classifier overrides; adapter does not read disk itself. */
	overrides?: ClassifierOverrides | undefined;
}

export function createClaudeCodeAdapter(opts: ClaudeCodeAdapterOptions = {}): RunnerAdapter {
	return {
		id: "claude-code",
		label: "Claude Code",
		capabilities: CLAUDE_CODE_CAPABILITIES,
		nativeEventNames: NATIVE_EVENTS,

		detectFromEnv(env) {
			return Boolean(
				env.CLAUDE_CODE ||
					env.CLAUDE_WORKING_DIR ||
					env.CLAUDECODE ||
					env.CLAUDE_CODE_VERSION,
			);
		},

		parseHookInput(nativeJson, nativeEventName) {
			return normalizeNativeHookEvent({
				runner: "claude-code",
				capabilities: CLAUDE_CODE_CAPABILITIES,
				nativeEventName,
				nativeJson,
				buildAction: ({ raw, phase }) =>
					buildStandardAction({
						raw,
						phase,
						nativeEventName,
						...(opts.overrides ? { overrides: opts.overrides } : {}),
					}),
			});
		},

		classifyToolClass(toolName, toolInput) {
			return classifyFromToolName(
				toolName,
				toolInput,
				opts.overrides ? { overrides: opts.overrides } : {},
			);
		},

		renderSettingsFragment(binaryPath, scope): SettingsFragment {
			const path = scope === "user" ? "~/.claude/settings.json" : ".claude/settings.json";
			const hooks: Record<string, unknown[]> = {};
			for (const event of NATIVE_EVENTS) {
				// SessionEnd is fire-and-forget: nothing consumes its output, and a
				// runner that exits right after firing it (`claude update`) cancels
				// any foreground hook still booting ("Hook cancelled"). The detached
				// form returns to the shell in milliseconds. Every other event stays
				// foreground — their output (context, warnings, block decisions) is
				// consumed by the runner.
				const hookCommand =
					event === "SessionEnd"
						? buildDetachedHookCommand(binaryPath, "claude-code", event)
						: // Missing-runtime policy: only the tool gate fails closed —
							// blocking Stop-class hooks risks a stop-hook loop.
							buildHookCommand(
								binaryPath,
								"claude-code",
								event,
								claudeMissingRuntimePolicy(event),
							);
				// Per-event timeout (seconds; lib/hook-timeouts.ts is the single
				// source): PreToolUse must outlast the per-edit coverage overlay,
				// PostToolUse the full quality pass — Claude Code's 60s default
				// killed the hook after the run's cost was already paid.
				const timeout = hookTimeoutSecondsFor(event);
				// PostToolUse is the ONLY scoped event: it is the one whose handler
				// runs the per-file quality pipeline, so a read-only call must not
				// reach it. Every other event is either tool-less or needs the full
				// stream (PreToolUse must judge reads too).
				const matcher = event === "PostToolUse" ? CLAUDE_POST_TOOL_USE_MATCHER : "";
				hooks[event] = [
					{
						matcher,
						hooks: [
							{ type: "command", command: hookCommand, ...(timeout !== undefined ? { timeout } : {}) },
						],
					},
				];
			}
			return { path, fragment: { hooks }, mergeStrategy: "array-append" };
		},

		encodeDecision: encodeClaudeDecision,
	};
}

function encodeClaudeDecision(
	decision: HarnessDecision,
	event: UnifiedHookEvent | undefined,
): AdapterOutput {
	const stderr = (decision.warnings ?? []).join("\n");
	if (event?.phase === "worktree-create") {
		return encodeClaudeWorktreeCreationDecision(decision, stderr);
	}
	const isPre = event?.phase === "pre-tool";
	const isPermissionRequest = event?.phase === "permission-request";
	// Claude Code validates hookSpecificOutput.hookEventName against the
	// incoming event. Echo the native event and use a phase fallback for tests
	// or compatibility payloads that omitted it.
	const hookEventName = resolveClaudeHookEventName(event, isPre, isPermissionRequest);
	if (isPermissionRequest) {
		return encodeClaudePermissionRequestDecision(decision, hookEventName, stderr);
	}

	if (decision.decision === "block") {
		const reason = claudeBlockReason(decision);
		if (isPre) {
			return {
				stdout: JSON.stringify({
					hookSpecificOutput: {
						hookEventName,
						permissionDecision: "deny",
						permissionDecisionReason: reason,
					},
				}),
				stderr: stderr || undefined,
				exit_code: 0,
			};
		}
		return {
			stdout: JSON.stringify({ decision: "block", reason }),
			stderr: stderr || undefined,
			exit_code: 0,
		};
	}

	if (decision.decision === "ask") {
		const reason = formatAskReasonWithTargets(
			decision.reason ?? "Confirmation required",
			decision.resolved_targets,
		);
		return {
			stdout: JSON.stringify({
				hookSpecificOutput: {
					hookEventName,
					permissionDecision: "ask",
					permissionDecisionReason: reason,
				},
			}),
			stderr: stderr || undefined,
			exit_code: 0,
		};
	}

	// Exit-0 stderr is not model-visible. Route non-blocking guidance through
	// additionalContext and keep stderr for terminals. Stop re-entry is bounded
	// upstream by hook-entry.ts so continuation feedback cannot loop forever.
	const contextParts: string[] = [];
	if (decision.additional_context) contextParts.push(decision.additional_context);
	if (stderr) contextParts.push(stderr);
	if (contextParts.length === 0) return { stderr: stderr || undefined, exit_code: 0 };
	return {
		stdout: JSON.stringify({
			hookSpecificOutput: {
				hookEventName,
				additionalContext: contextParts.join("\n"),
			},
		}),
		stderr: stderr || undefined,
		exit_code: 0,
	};
}

function encodeClaudePermissionRequestDecision(
	decision: HarnessDecision,
	hookEventName: string,
	warnings: string,
): AdapterOutput {
	if (decision.decision === "block") {
		return encodeClaudePermissionRequestBlock(decision, hookEventName, warnings);
	}

	// PermissionRequest has no additionalContext member. A generic Interlinked
	// allow means "no objection", not "approve this permission on the user's
	// behalf", so allow and ask both abstain on stdout. Keep non-blocking
	// diagnostics on stderr and let Claude's configured policy and native prompt
	// remain authoritative.
	const feedback = claudePermissionRequestFeedback(decision, warnings);
	return feedback ? { stderr: feedback, exit_code: 0 } : { exit_code: 0 };
}

function claudePermissionRequestFeedback(
	decision: HarnessDecision,
	warnings: string,
): string {
	const parts: string[] = [];
	if (decision.system_message) {
		parts.push(decision.system_message);
	} else if (decision.decision === "ask") {
		parts.push(
			formatAskReasonWithTargets(
				decision.reason ?? "Confirmation required",
				decision.resolved_targets,
			),
		);
	}
	if (decision.additional_context) parts.push(decision.additional_context);
	if (warnings) parts.push(warnings);
	return parts.join("\n");
}

function encodeClaudePermissionRequestBlock(
	decision: HarnessDecision,
	hookEventName: string,
	warnings: string,
): AdapterOutput {
	return {
		stdout: JSON.stringify({
			hookSpecificOutput: {
				hookEventName,
				decision: { behavior: "deny", message: claudeBlockReason(decision) },
			},
		}),
		stderr: warnings || undefined,
		exit_code: 0,
	};
}

function resolveClaudeHookEventName(
	event: UnifiedHookEvent | undefined,
	isPre: boolean,
	isPermissionRequest: boolean,
): string {
	if (event?.runner_native_event) return event.runner_native_event;
	if (isPermissionRequest) return "PermissionRequest";
	return isPre ? "PreToolUse" : "PostToolUse";
}

function claudeBlockReason(decision: HarnessDecision): string {
	return (
		decision.reason ??
		"Blocked by the interlinked harness, but no reason was attached — likely a harness " +
			"bug; re-run, or run `interlinked harness restart`, then report it."
	);
}

function encodeClaudeWorktreeCreationDecision(
	decision: HarnessDecision,
	warnings: string,
): AdapterOutput {
	const reason = decision.reason ?? agentWorktreeCreationBlockReason();
	return {
		stderr: warnings ? `${reason}\n${warnings}` : reason,
		exit_code: 2,
	};
}
