// ===========================================
// OpenAI Codex CLI adapter
// ===========================================
// Codex CLI uses Claude Code's PascalCase hook vocabulary but has its own
// response semantics. This adapter covers Codex's full twelve-event surface,
// keeps `turn_id` distinct in the unified envelope, abstains on allowed/asked
// PermissionRequest events so Codex's native policy can prompt, and translates
// Stop/SubagentStop feedback into Codex's continuation shape.
//
// Configuration: Codex reads `.codex/hooks.json` (project) or
// `~/.codex/hooks.json` (user). Hooks are gated by a `[features]
// hooks = true` flag in `.codex/config.toml` (legacy `codex_hooks` is
// still recognized but emits a deprecation warning; our writer
// migrates it on every run). The legacy installer in
// `src/lib/hook-installers.ts` writes that flag automatically. The
// modern installer in `src/harness/installer.ts` only writes the
// hooks.json fragment — operators using Phase D should set the flag
// themselves or call `interlinked enable --clients codex`.

import { ensureCodexFeatureFlag } from "../../lib/codex-feature-flag.js";
import { hookTimeoutSecondsFor } from "../../lib/hook-timeouts.js";
import { CODEX_WRITE_TOOLS } from "../../lib/write-tool-registry.js";
import { formatAskReasonWithTargets } from "../evaluator/rule-matching.js";
import {
	type ClassifierOverrides,
	classifyFromToolName,
} from "../tool-class-classifier.js";
import type { HarnessDecision } from "../types.js";
import type { UnifiedHookEvent } from "../unified-event.js";
import { buildDetachedHookCommand, buildHookCommand } from "./hook-command.js";
import { buildStandardAction, normalizeNativeHookEvent } from "./normalization.js";
import {
	CODEX_CAPABILITIES,
	eventCapability,
	installedEventNames,
} from "./provider-capabilities.js";
import type {
	AdapterOutput,
	PostInstallOptions,
	RunnerAdapter,
	SettingsFragment,
} from "./types.js";

// Native event spellings are cataloged in provider-capabilities.ts; only the
// values needed by response/config branching are named locally.
const EVT_PRE_TOOL = "PreToolUse" as const;
const EVT_POST_TOOL = "PostToolUse" as const;
const EVT_PERMISSION_REQUEST = "PermissionRequest" as const;
const EVT_STOP = "Stop" as const;
const EVT_SUBAGENT_STOP = "SubagentStop" as const;
const EVT_SESSION_END = "SessionEnd" as const;
const EVT_INTERRUPT = "Interrupt" as const;

const NATIVE_EVENTS = installedEventNames(CODEX_CAPABILITIES);

// PostToolUse is an edit-quality path, not a general telemetry tap. Restrict
// registration to Codex's write-capable tools so reads, coordination calls,
// and other no-effect tools never start a hook process or contact the daemon.
// Bash stays because only its post-call ChangeSet can prove whether a command
// wrote; the daemon's deterministic command/effect resolver handles that arm.
export const CODEX_POST_TOOL_USE_MATCHER = CODEX_WRITE_TOOLS.join("|");

// Decision verbs as named constants — used both to choose the encoder
// branch in encodeDecision and to populate the JSON shape on stdout.
const DECISION_BLOCK = "block" as const;
const DECISION_ASK = "ask" as const;
const PERMISSION_DENY = "deny" as const;
const RUNNER_CODEX = "codex" as const;

// Codex configuration paths. The project-scope file lives next to the
// repo, the user-scope file under the home directory.
const HOOKS_PATH_PROJECT = ".codex/hooks.json";
const HOOKS_PATH_USER = "~/.codex/hooks.json";
const SCOPE_USER = "user" as const;

interface CodexAdapterOptions {
	overrides?: ClassifierOverrides | undefined;
}

export function createCodexAdapter(opts: CodexAdapterOptions = {}): RunnerAdapter {
	return {
		id: "codex",
		label: "OpenAI Codex CLI",
		experimental: false,
		capabilities: CODEX_CAPABILITIES,
		nativeEventNames: NATIVE_EVENTS,
		detectFromEnv: codexDetectFromEnv,
		parseHookInput: (nativeJson, nativeEventName) =>
			codexParseHookInput(nativeJson, nativeEventName, opts.overrides),
		classifyToolClass: (toolName, toolInput) =>
			classifyFromToolName(
				toolName,
				toolInput,
				opts.overrides ? { overrides: opts.overrides } : {},
			),
		renderSettingsFragment: codexRenderSettingsFragment,
		encodeDecision: codexEncodeDecision,
		postInstall: codexPostInstall,
	};
}

function codexPostInstall(opts: PostInstallOptions): void {
	// Codex hooks are gated by `[features] hooks = true` in
	// `<scope>/.codex/config.toml` (legacy `codex_hooks` is auto-migrated
	// by the writer). Without the flag, the hooks.json file we just
	// merged is silently ignored. Writing is idempotent and preserves
	// existing user-managed config — see `src/lib/codex-feature-flag.ts`.
	if (opts.dryRun) {
		process.stderr.write(
			`[interlinked] codex postInstall (dry-run): would ensure ${opts.cwd}/.codex/config.toml has [features] hooks = true\n`,
		);
		return;
	}
	// `"refused"` is a FAILURE, not a variety of success (Grok 2026-08-28
	// issue 5): duplicate `[features]` headers make the TOML invalid, Codex
	// rejects the whole file, and no hook ever fires — an install that reports
	// ok on top of that is an inert install. `runPostInstall` treats a throw as
	// the failure signal, so throwing threads `InstallResult.ok === false`.
	const action = ensureCodexFeatureFlag(opts.cwd);
	if (action === "refused") {
		throw new Error(
			`.codex/config.toml has duplicate [features] tables — Codex rejects the whole file, so hooks cannot fire. Merge the duplicate tables (see the repair note printed above), then re-run enable.`,
		);
	}
}

function codexDetectFromEnv(env: NodeJS.ProcessEnv): boolean {
	return Boolean(
		env.CODEX_CLI ||
			env.OPENAI_CODEX_CLI ||
			env.CODEX_SESSION_ID ||
			env.CODEX_VERSION ||
			env.INTERLINKED_CLIENT === RUNNER_CODEX,
	);
}

function codexParseHookInput(
	nativeJson: unknown,
	nativeEventName: string,
	overrides: ClassifierOverrides | undefined,
): UnifiedHookEvent {
	return normalizeNativeHookEvent({
		runner: RUNNER_CODEX,
		capabilities: CODEX_CAPABILITIES,
		nativeEventName,
		nativeJson,
		turnIdAsParentEventId: true,
		buildAction: ({ raw, phase }) =>
			buildStandardAction({
				raw,
				phase,
				nativeEventName,
				...(overrides ? { overrides } : {}),
			}),
	});
}

function codexRenderSettingsFragment(binaryPath: string, scope: string): SettingsFragment {
	const path = scope === SCOPE_USER ? HOOKS_PATH_USER : HOOKS_PATH_PROJECT;
	// Codex's `.codex/hooks.json` shape mirrors Claude's
	// `.claude/settings.json` `hooks` field exactly — `{ matcher,
	// hooks: [{ type, command }] }` per event. We render the same shape so
	// users don't have to learn a second config format.
	const hooks: Record<string, unknown[]> = {};
	for (const event of NATIVE_EVENTS) {
		hooks[event] = [codexRegistration(binaryPath, event)];
	}
	return { path, fragment: { hooks }, mergeStrategy: "array-append" };
}

function codexRegistration(binaryPath: string, event: string): Record<string, unknown> {
	const capability = eventCapability(CODEX_CAPABILITIES, event);
	if (!capability) {
		throw new Error(`Codex event ${event} is missing from the capability catalog`);
	}
	const command =
		event === EVT_SESSION_END
			? buildDetachedHookCommand(binaryPath, RUNNER_CODEX, event)
			: buildHookCommand(binaryPath, RUNNER_CODEX, event, capability.missing_runtime);
	const handler: Record<string, unknown> = {
		type: "command",
		command,
		timeout: event === EVT_SESSION_END ? 3 : hookTimeoutSecondsFor(event),
		statusMessage: codexStatusMessage(event),
	};
	if (capability.background) {
		handler.async = true;
	}
	if (capability.model_context) {
		handler.additionalContextLimit = 2_500;
	}
	return {
		matcher: event === EVT_POST_TOOL ? CODEX_POST_TOOL_USE_MATCHER : "",
		hooks: [handler],
	};
}

function codexStatusMessage(event: string): string {
	if (event === EVT_PRE_TOOL || event === EVT_PERMISSION_REQUEST) {
		return "Interlinked policy check";
	}
	if (event === EVT_POST_TOOL) {
		return "Interlinked quality review";
	}
	return "Interlinked lifecycle check";
}

function codexEncodeDecision(decision: HarnessDecision, event: UnifiedHookEvent): AdapterOutput {
	const special = encodeCodexSpecialDecision(decision, event);
	if (special) {
		return special;
	}
	if (decision.decision === DECISION_BLOCK || decision.decision === DECISION_ASK) {
		return encodeCodexBlock(decision, event);
	}
	return encodeCodexAllow(decision, event);
}

function encodeCodexSpecialDecision(
	decision: HarnessDecision,
	event: UnifiedHookEvent,
): AdapterOutput | null {
	if (event.runner_native_event === EVT_INTERRUPT) {
		// Interrupt's strict output schema permits only an optional systemMessage.
		// Interlinked records it asynchronously and intentionally emits zero bytes.
		return { exit_code: 0 };
	}
	if (event.runner_native_event === EVT_PERMISSION_REQUEST) {
		return encodeCodexPermissionDecision(decision);
	}
	if (
		event.runner_native_event === EVT_STOP ||
		event.runner_native_event === EVT_SUBAGENT_STOP
	) {
		return encodeCodexContinuationDecision(decision);
	}
	return null;
}

function encodeCodexPermissionDecision(decision: HarnessDecision): AdapterOutput {
	const stderr = feedbackText(decision);
	if (decision.decision === DECISION_BLOCK) {
		return withOptionalStderr(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: EVT_PERMISSION_REQUEST,
					decision: { behavior: PERMISSION_DENY, message: decisionReason(decision) },
				},
			}),
			stderr,
		);
	}
	// Allow and ask both abstain. Codex then applies its normal permission
	// policy, including the native user prompt for an unresolved request.
	return stderr ? { stderr, exit_code: 0 } : { exit_code: 0 };
}

function encodeCodexContinuationDecision(decision: HarnessDecision): AdapterOutput {
	const reason = feedbackText(decision);
	if (decision.decision === "allow" && !reason) {
		return { exit_code: 0 };
	}
	return {
		stdout: JSON.stringify({
			decision: DECISION_BLOCK,
			reason: reason || decisionReason(decision),
		}),
		exit_code: 0,
	};
}

function encodeCodexBlock(decision: HarnessDecision, event: UnifiedHookEvent): AdapterOutput {
	const reason = decisionReason(decision);
	const stderr = warningText(decision);
	if (event.runner_native_event === EVT_PRE_TOOL) {
		return withOptionalStderr(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: EVT_PRE_TOOL,
					permissionDecision: PERMISSION_DENY,
					permissionDecisionReason: reason,
				},
			}),
			stderr,
		);
	}
	return withOptionalStderr(JSON.stringify({ decision: DECISION_BLOCK, reason }), stderr);
}

function encodeCodexAllow(decision: HarnessDecision, event: UnifiedHookEvent): AdapterOutput {
	const feedback = feedbackText(decision);
	if (!feedback) {
		return { exit_code: 0 };
	}
	const capability = eventCapability(CODEX_CAPABILITIES, event.runner_native_event);
	if (!capability?.model_context) {
		return { stderr: feedback, exit_code: 0 };
	}
	return {
		stdout: JSON.stringify({
			hookSpecificOutput: {
				hookEventName: event.runner_native_event,
				additionalContext: feedback,
			},
		}),
		exit_code: 0,
	};
}

function decisionReason(decision: HarnessDecision): string {
	const fallback =
		"Blocked by the interlinked harness, but no reason was attached — likely a harness bug; " +
		"re-run, or run `interlinked harness restart`, then report it.";
	return formatAskReasonWithTargets(decision.reason ?? fallback, decision.resolved_targets);
}

function warningText(decision: HarnessDecision): string {
	return (decision.warnings ?? []).join("\n");
}

function feedbackText(decision: HarnessDecision): string {
	return [decision.additional_context, warningText(decision)].filter(Boolean).join("\n");
}

function withOptionalStderr(stdout: string, stderr: string): AdapterOutput {
	return stderr ? { stdout, stderr, exit_code: 0 } : { stdout, exit_code: 0 };
}
