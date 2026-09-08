import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import {
	type ClassifierOverrides,
	classifyFromToolName,
} from "../tool-class-classifier.js";
import type {
	RunnerId,
	UnifiedAction,
	UnifiedHookContext,
	UnifiedHookEvent,
	UnifiedPhase,
} from "../unified-event.js";
import { makeEventId as defaultMakeEventId } from "../unified-event.js";
import { eventCapability } from "./provider-capabilities.js";
import { observeNativeHook } from "./hook-observation.js";
import type { RunnerCapabilities } from "./types.js";

export interface NativeFieldAliases {
	sessionId: readonly string[];
	cwd: readonly string[];
	workspaceRoot: readonly string[];
	toolUseId: readonly string[];
	turnId: readonly string[];
	parentEventId: readonly string[];
	runnerVersion: readonly string[];
	model: readonly string[];
	transcriptPath: readonly string[];
	permissionMode: readonly string[];
	agentId: readonly string[];
	agentRole: readonly string[];
}

export const DEFAULT_NATIVE_FIELD_ALIASES: NativeFieldAliases = {
	sessionId: ["session_id", "sessionId"],
	cwd: ["cwd"],
	workspaceRoot: ["workspace_root", "workspaceRoot"],
	toolUseId: ["tool_use_id", "toolUseId"],
	turnId: ["turn_id", "turnId", "prompt_id", "promptId"],
	parentEventId: ["parent_event_id", "parentEventId"],
	runnerVersion: ["runner_version", "cli_version", "version"],
	model: ["model"],
	transcriptPath: ["transcript_path", "transcriptPath"],
	permissionMode: ["permission_mode", "permissionMode"],
	agentId: ["agent_id", "subagent_id", "agent_name", "agentId"],
	agentRole: ["agent_type", "agent_role", "agentType", "agentRole"],
};

export interface NormalizeNativeHookOptions {
	runner: RunnerId;
	capabilities: RunnerCapabilities;
	nativeEventName: string;
	nativeJson: unknown;
	buildAction: (args: {
		raw: JsonObject;
		phase: UnifiedPhase;
		nativeEventName: string;
	}) => UnifiedAction;
	aliases?: Partial<NativeFieldAliases>;
	now?: () => Date;
	makeEventId?: () => string;
	/** Compatibility bridge for the original Codex adapter, which exposed its
	 * turn id as parent_event_id before UnifiedHookEvent gained turn_id. */
	turnIdAsParentEventId?: boolean;
}

interface EnvelopeMetadata {
	sessionId: string;
	cwd: string;
	workspaceRoot?: string | undefined;
	toolUseId?: string | undefined;
	turnId?: string | undefined;
	parentEventId?: string | undefined;
	runnerVersion?: string | undefined;
	model?: string | undefined;
	transcriptPath?: string | undefined;
	permissionMode?: string | undefined;
	agentId?: string | undefined;
	agentRole?: string | undefined;
}

/** Provider-neutral native-payload boundary. It owns canonical correlation,
 * metadata, phase lookup, and envelope construction. Provider adapters supply
 * only action extraction and response/config syntax. */
export function normalizeNativeHookEvent(
	opts: NormalizeNativeHookOptions,
): UnifiedHookEvent {
	const raw = isJsonObject(opts.nativeJson) ? opts.nativeJson : {};
	const aliases = mergeAliases(opts.aliases);
	const phase = eventCapability(opts.capabilities, opts.nativeEventName)?.phase ?? "other";
	const metadata = extractEnvelopeMetadata(raw, aliases, opts.turnIdAsParentEventId === true);
	const event = baseEvent({ opts, raw, phase, metadata });
	copyOptionalEnvelopeFields(event, metadata);
	const observation = observeNativeHook(event, raw);
	if (observation) event.observation = observation;
	return event;
}

function extractEnvelopeMetadata(
	raw: JsonObject,
	aliases: NativeFieldAliases,
	turnIdAsParentEventId: boolean,
): EnvelopeMetadata {
	const turnId = firstString(raw, aliases.turnId) ?? undefined;
	const nativeParent = firstString(raw, aliases.parentEventId) ?? undefined;
	return {
		sessionId: firstString(raw, aliases.sessionId) ?? "unknown",
		cwd: firstString(raw, aliases.cwd) ?? process.cwd(),
		workspaceRoot: firstString(raw, aliases.workspaceRoot) ?? undefined,
		toolUseId: firstString(raw, aliases.toolUseId) ?? undefined,
		turnId,
		parentEventId: nativeParent ?? (turnIdAsParentEventId ? turnId : undefined),
		runnerVersion: firstString(raw, aliases.runnerVersion) ?? undefined,
		model: firstString(raw, aliases.model) ?? undefined,
		transcriptPath: firstString(raw, aliases.transcriptPath) ?? undefined,
		permissionMode: firstString(raw, aliases.permissionMode) ?? undefined,
		agentId: firstString(raw, aliases.agentId) ?? undefined,
		agentRole: firstString(raw, aliases.agentRole) ?? undefined,
	};
}

function baseEvent(args: {
	opts: NormalizeNativeHookOptions;
	raw: JsonObject;
	phase: UnifiedPhase;
	metadata: EnvelopeMetadata;
}): UnifiedHookEvent {
	const { opts, raw, phase, metadata } = args;
	return {
		schema_version: "1",
		event_id: (opts.makeEventId ?? defaultMakeEventId)(),
		session_id: metadata.sessionId,
		ts: (opts.now ?? (() => new Date()))().toISOString(),
		runner: opts.runner,
		runner_native_event: opts.nativeEventName,
		phase,
		action: opts.buildAction({ raw, phase, nativeEventName: opts.nativeEventName }),
		context: buildContext(metadata),
		raw,
	};
}

function buildContext(metadata: EnvelopeMetadata): UnifiedHookContext {
	const context: UnifiedHookContext = { cwd: metadata.cwd };
	if (metadata.workspaceRoot) context.workspace_root = metadata.workspaceRoot;
	if (metadata.model) context.model = metadata.model;
	if (metadata.transcriptPath) context.transcript_path = metadata.transcriptPath;
	if (metadata.permissionMode) context.permission_mode = metadata.permissionMode;
	if (metadata.agentId || metadata.agentRole) {
		context.agent = {};
		if (metadata.agentId) context.agent.id = metadata.agentId;
		if (metadata.agentRole) context.agent.role = metadata.agentRole;
	}
	return context;
}

function copyOptionalEnvelopeFields(
	event: UnifiedHookEvent,
	metadata: EnvelopeMetadata,
): void {
	if (metadata.parentEventId) event.parent_event_id = metadata.parentEventId;
	if (metadata.toolUseId) event.tool_use_id = metadata.toolUseId;
	if (metadata.turnId) event.turn_id = metadata.turnId;
	if (metadata.runnerVersion) event.runner_version = metadata.runnerVersion;
}

export interface StandardActionOptions {
	phase: UnifiedPhase;
	nativeEventName: string;
	raw: JsonObject;
	overrides?: ClassifierOverrides;
	toolNameKeys?: readonly string[];
	toolInputKeys?: readonly string[];
	toolResponseKeys?: readonly string[];
	toolErrorKeys?: readonly string[];
	promptKeys?: readonly string[];
}

/** Default action extractor for conventional stdin hook payloads. Specialized
 * providers can replace it while retaining the shared envelope normalizer. */
export function buildStandardAction(opts: StandardActionOptions): UnifiedAction {
	if (opts.phase === "user-prompt") return buildPromptAction(opts);
	const lifecycle = lifecycleEventForPhase(opts.phase);
	if (lifecycle) return { kind: "session_lifecycle", event: lifecycle };
	if (isToolPhase(opts.phase)) return buildToolAction(opts);
	return {
		kind: "other",
		subkind: compactSubkind(opts.phase, opts.nativeEventName),
		data: opts.raw,
	};
}

function buildPromptAction(opts: StandardActionOptions): UnifiedAction {
	return {
		kind: "user_prompt",
		text: firstString(opts.raw, opts.promptKeys ?? ["prompt", "message", "userPrompt"]) ?? "",
	};
}

function buildToolAction(opts: StandardActionOptions): UnifiedAction {
	const toolNameRaw =
		firstString(opts.raw, opts.toolNameKeys ?? ["tool_name", "toolName", "name"]) ??
		"unknown";
	const toolInput = firstValue(
		opts.raw,
		opts.toolInputKeys ?? ["tool_input", "toolInput", "arguments"],
	) ?? {};
	const base = {
		kind: "tool_call" as const,
		tool_name: normalizeToolName(toolNameRaw),
		tool_class: classifyFromToolName(
			toolNameRaw,
			toolInput,
			opts.overrides ? { overrides: opts.overrides } : {},
		),
		tool_input: toolInput,
		tool_input_redacted: toolInput,
	};
	if (opts.phase !== "post-tool") return base;
	return {
		...base,
		tool_response: firstValue(
			opts.raw,
			opts.toolResponseKeys ?? ["tool_response", "toolResponse", "response"],
		),
		tool_error:
			firstString(
				opts.raw,
				opts.toolErrorKeys ?? ["tool_error", "toolError", "error", "error_message"],
			) ?? undefined,
	};
}

export function normalizeToolName(tool: string): string {
	return tool
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[\s.-]+/g, "_")
		.toLowerCase()
		.replace(/^_+|_+$/g, "");
}

function isToolPhase(phase: UnifiedPhase): boolean {
	return phase === "pre-tool" || phase === "post-tool" || phase === "permission-request";
}

function lifecycleEventForPhase(
	phase: UnifiedPhase,
): "start" | "end" | "stop" | null {
	if (phase === "session-start") return "start";
	if (phase === "session-end") return "end";
	if (phase === "stop") return "stop";
	return null;
}

function compactSubkind(phase: UnifiedPhase, nativeEventName: string): string {
	if (phase === "pre-compact") return "pre_compact";
	if (phase === "post-compact") return "post_compact";
	if (phase === "error") return "error";
	return nativeEventName;
}

function mergeAliases(overrides: Partial<NativeFieldAliases> | undefined): NativeFieldAliases {
	return { ...DEFAULT_NATIVE_FIELD_ALIASES, ...overrides };
}

function firstString(raw: JsonObject, keys: readonly string[]): string | null {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "string") return value;
	}
	return null;
}

function firstValue(raw: JsonObject, keys: readonly string[]): unknown {
	for (const key of keys) {
		if (raw[key] !== undefined) return raw[key];
	}
	return undefined;
}
