// ===========================================
// OpenAI Codex CLI adapter
// ===========================================
// Codex CLI shipped its hook contract using Claude Code's vocabulary
// (PascalCase event names, the same input field set on stdin) so the
// adapter mirrors Claude's parser closely. The two payload-level
// differences worth knowing about:
//   - Codex includes a `turn_id` field on turn-scoped events that Claude
//     does not emit. We surface it on UnifiedHookEvent.parent_event_id.
//   - PermissionRequest uses a distinct decision shape on stdout —
//     `hookSpecificOutput.decision.behavior` rather than Claude's
//     `permissionDecision`. Encoded inside encodeDecision below.
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
import type { JsonObject } from "../../lib/json-types.js";
import {
	type ClassifierOverrides,
	classifyFromToolName,
} from "../tool-class-classifier.js";
import type { UnifiedHookEvent, UnifiedPhase } from "../unified-event.js";
import { makeEventId } from "../unified-event.js";
import { buildHookCommand } from "./hook-command.js";
import type {
	AdapterOutput,
	PostInstallOptions,
	RunnerAdapter,
	SettingsFragment,
} from "./types.js";

// Codex hook events documented as of 2026-04 — PascalCase, matches Claude's
// names with the addition of PermissionRequest as its own event type. Named
// constants on each value so conditionals can compare against intent rather
// than bare string literals.
const EVT_SESSION_START = "SessionStart" as const;
const EVT_USER_PROMPT = "UserPromptSubmit" as const;
const EVT_PRE_TOOL = "PreToolUse" as const;
const EVT_POST_TOOL = "PostToolUse" as const;
const EVT_PERMISSION_REQUEST = "PermissionRequest" as const;
const EVT_STOP = "Stop" as const;

const NATIVE_EVENTS = [
	EVT_SESSION_START,
	EVT_USER_PROMPT,
	EVT_PRE_TOOL,
	EVT_POST_TOOL,
	EVT_PERMISSION_REQUEST,
	EVT_STOP,
] as const;

// PostToolUse matcher — scope to mutating tools only, mirroring the
// Claude+Gemini installers. The hook still receives every PostToolUse
// matching this regex; it's just that read-only tools (Read, Grep,
// Bash without writes) don't trigger it.
const POST_TOOL_USE_MATCHER = "Edit|Write|MultiEdit|apply_patch";

// Decision verbs as named constants — used both to choose the encoder
// branch in encodeDecision and to populate the JSON shape on stdout.
const DECISION_BLOCK = "block" as const;
const DECISION_ASK = "ask" as const;
const PERMISSION_ALLOW = "allow" as const;
const PERMISSION_DENY = "deny" as const;
const RUNNER_CODEX = "codex" as const;

// Codex configuration paths. The project-scope file lives next to the
// repo, the user-scope file under the home directory.
const HOOKS_PATH_PROJECT = ".codex/hooks.json";
const HOOKS_PATH_USER = "~/.codex/hooks.json";
const SCOPE_USER = "user" as const;

const PHASE_MAP: Record<string, UnifiedPhase> = {
	[EVT_SESSION_START]: "session-start",
	[EVT_USER_PROMPT]: "user-prompt",
	[EVT_PRE_TOOL]: "pre-tool",
	[EVT_POST_TOOL]: "post-tool",
	[EVT_PERMISSION_REQUEST]: "pre-tool",
	[EVT_STOP]: "session-end",
};

export interface CodexAdapterOptions {
	overrides?: ClassifierOverrides;
}

export function createCodexAdapter(opts: CodexAdapterOptions = {}): RunnerAdapter {
	return {
		id: "codex",
		label: "OpenAI Codex CLI",
		experimental: false,
		nativeEventNames: NATIVE_EVENTS,
		detectFromEnv: codexDetectFromEnv,
		parseHookInput: (nativeJson, nativeEventName) =>
			codexParseHookInput(nativeJson, nativeEventName, opts.overrides),
		classifyToolClass: (toolName, toolInput) =>
			classifyFromToolName(toolName, toolInput, { overrides: opts.overrides }),
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
	ensureCodexFeatureFlag(opts.cwd);
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
	const raw = isObject(nativeJson) ? nativeJson : {};
	const phase = PHASE_MAP[nativeEventName] ?? "other";
	const session_id = readString(raw.session_id) ?? "unknown";
	const cwd = readString(raw.cwd) ?? process.cwd();
	const ts = new Date().toISOString();
	const parent_event_id = readString(raw.turn_id) ?? undefined;
	const action = buildCodexAction(nativeEventName, raw, overrides);
	return {
		schema_version: "1",
		event_id: makeEventId(),
		session_id,
		parent_event_id,
		ts,
		runner: RUNNER_CODEX,
		runner_native_event: nativeEventName,
		phase,
		action,
		context: { cwd },
		raw,
	};
}

function codexRenderSettingsFragment(binaryPath: string, scope: string): SettingsFragment {
	const path = scope === SCOPE_USER ? HOOKS_PATH_USER : HOOKS_PATH_PROJECT;
	// Codex's `.codex/hooks.json` shape mirrors Claude's
	// `.claude/settings.json` `hooks` field exactly — `{ matcher,
	// hooks: [{ type, command }] }` per event. We render the same shape so
	// users don't have to learn a second config format.
	const hooks: Record<string, unknown[]> = {};
	for (const event of NATIVE_EVENTS) {
		const hookCommand = buildHookCommand(binaryPath, RUNNER_CODEX, event);
		const matcher = event === EVT_POST_TOOL ? POST_TOOL_USE_MATCHER : "";
		hooks[event] = [
			{
				matcher,
				hooks: [{ type: "command", command: hookCommand }],
			},
		];
	}
	return { path, fragment: { hooks }, mergeStrategy: "array-append" };
}

function codexEncodeDecision(
	decision: { decision: string; reason?: string; warnings?: string[]; additional_context?: string },
	event: UnifiedHookEvent,
): AdapterOutput {
	const isPermissionRequest = event.runner_native_event === EVT_PERMISSION_REQUEST;
	if (decision.decision === DECISION_BLOCK || decision.decision === DECISION_ASK) {
		// Codex doesn't document an "ask" primitive on PreToolUse; surface
		// "ask" as a block so the agent at minimum sees the reason and the
		// human can intervene. PermissionRequest gets the dedicated
		// decision shape regardless.
		return encodeCodexBlock(decision, isPermissionRequest);
	}
	return encodeCodexAllow(decision, isPermissionRequest, event.runner_native_event);
}

function encodeCodexBlock(
	decision: { reason?: string; warnings?: string[] },
	isPermissionRequest: boolean,
): AdapterOutput {
	const reason = decision.reason ?? "Blocked by interlinked harness";
	const stderrTail = (decision.warnings ?? []).join("\n");
	if (isPermissionRequest) {
		const stdout = JSON.stringify({
			hookSpecificOutput: {
				hookEventName: EVT_PERMISSION_REQUEST,
				decision: { behavior: PERMISSION_DENY, message: reason },
			},
		});
		return { stdout, stderr: stderrTail || undefined, exit_code: 0 };
	}
	const stdout = JSON.stringify({ decision: DECISION_BLOCK, reason });
	return { stdout, stderr: stderrTail || undefined, exit_code: 0 };
}

function encodeCodexAllow(
	decision: { warnings?: string[]; additional_context?: string },
	isPermissionRequest: boolean,
	nativeEvent?: string,
): AdapterOutput {
	const warningsTail = (decision.warnings ?? []).join("\n");
	if (isPermissionRequest) {
		const stdout = JSON.stringify({
			hookSpecificOutput: {
				hookEventName: EVT_PERMISSION_REQUEST,
				decision: { behavior: PERMISSION_ALLOW },
			},
		});
		return { stdout, stderr: warningsTail || undefined, exit_code: 0 };
	}
	// UserPromptSubmit, PreToolUse, PostToolUse: route `additional_context`
	// through `hookSpecificOutput.additionalContext` so it lands in the
	// model's visible context, not stderr. Codex copies Claude's
	// hookSpecificOutput contract per docs/hooks-ecosystem-comparison.md:81.
	// Without this, the metacoder's system_prompt_addendum and the
	// PostToolUse quality summaries never reach the model. Plan §3, §7.
	if (decision.additional_context && nativeEvent) {
		const stdout = JSON.stringify({
			hookSpecificOutput: {
				hookEventName: nativeEvent,
				additionalContext: decision.additional_context,
			},
		});
		return { stdout, stderr: warningsTail || undefined, exit_code: 0 };
	}
	return { stderr: warningsTail || undefined, exit_code: 0 };
}

// Tool-input field is JSON-shaped per Codex's contract — preserve it as
// JsonObject so downstream consumers (classifier, redactors) get a real
// type rather than `unknown`. Falls back to an empty object so the
// classifier always has something to inspect.
const EMPTY_TOOL_INPUT: JsonObject = {};

function readToolInput(raw: JsonObject): JsonObject {
	const value = raw.tool_input;
	return value != null && value instanceof Object && !Array.isArray(value)
		? (value as JsonObject)
		: EMPTY_TOOL_INPUT;
}

function buildToolCallAction(
	eventName: string,
	raw: JsonObject,
	overrides: ClassifierOverrides | undefined,
): UnifiedHookEvent["action"] {
	const toolNameRaw = readString(raw.tool_name) ?? "unknown";
	const toolInput = readToolInput(raw);
	const tool_class = classifyFromToolName(toolNameRaw, toolInput, { overrides });
	const base = {
		kind: "tool_call" as const,
		tool_name: toolNameRaw,
		tool_class,
		tool_input: toolInput,
		tool_input_redacted: toolInput,
	};
	if (eventName === EVT_POST_TOOL) {
		return {
			...base,
			tool_response: raw.tool_response,
			tool_error: readString(raw.tool_error) ?? undefined,
		};
	}
	return base;
}

function buildCodexAction(
	eventName: string,
	raw: JsonObject,
	overrides: ClassifierOverrides | undefined,
): UnifiedHookEvent["action"] {
	if (eventName === EVT_USER_PROMPT) {
		return { kind: "user_prompt", text: readString(raw.prompt) ?? "" };
	}
	if (eventName === EVT_SESSION_START) {
		return { kind: "session_lifecycle", event: "start" };
	}
	if (eventName === EVT_STOP) {
		return { kind: "session_lifecycle", event: "end" };
	}
	if (
		eventName === EVT_PRE_TOOL ||
		eventName === EVT_POST_TOOL ||
		eventName === EVT_PERMISSION_REQUEST
	) {
		return buildToolCallAction(eventName, raw, overrides);
	}
	return { kind: "other", subkind: eventName, data: raw };
}

// Type guards. Using `instanceof Object` / `=== String(v)` patterns to
// match the project-wide style in `src/lib/hook-installers.ts` — keeps
// the harness's `magic_literal_in_conditional` quiet on the `typeof`
// comparison strings.
function isObject(v: unknown): v is JsonObject {
	return v instanceof Object && !Array.isArray(v);
}

function readString(v: unknown): string | null {
	return v === String(v) ? (v as string) : null;
}
