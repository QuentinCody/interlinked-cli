// ===========================================
// Policy Classifier — LLM-based escalation for ambiguous PreToolUse cases
// ===========================================
// Shadow mode (v1): logs classifications but never changes the deterministic decision.
// The classifier is always awaited — verdicts are logged before tool execution proceeds.
// Failures fail-open (allow). No circuit breaker.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";

/**
 * Resolve an API key by name. Checks:
 * 1. process.env[envVarName]
 * 2. .interlinked/config.local.json (gitignored, same pattern as access_token)
 */
export function resolveApiKey(envVarName: string): string | undefined {
	if (!envVarName) return undefined;
	const fromEnv = process.env[envVarName];
	if (fromEnv) return fromEnv;
	try {
		const localConfig = JSON.parse(
			readFileSync(join(process.cwd(), ".interlinked", "config.local.json"), "utf-8"),
		);
		return localConfig[envVarName] || localConfig[envVarName.toLowerCase()] || undefined;
	} catch {
		return undefined;
	}
}


import {
	parseAnthropicResponse,
	parseClaudeCodeOutput,
	parseOpenAIResponse,
} from "./policy-classifier-parsers.js";
import { loadPolicies } from "./policy-classifier-policies.js";
import type {
	ClassifierConfig,
	EscalationRequest,
	HarnessEvent,
	PolicyClassification,
	PolicyEvidence,
	SessionTrajectory,
} from "./types.js";

// ===========================================
// Session State (per classifier instance)
// ===========================================

export interface ClassifierSessionState {
	/** Incremented on each classifier call (metrics only, NOT enforced as hard limit) */
	calls_this_session: number;
	/** Tracked for observability — no circuit breaker */
	consecutive_failures: number;
}

export function createClassifierSessionState(): ClassifierSessionState {
	return {
		calls_this_session: 0,
		consecutive_failures: 0,
	};
}

// ===========================================
// System Prompt (fixed, ships with harness)
// ===========================================

export const CLASSIFIER_SYSTEM_PROMPT = `You are a security policy classifier for an AI coding agent orchestration system.
You evaluate whether an agent's current action complies with workspace policies.

Respond with JSON only:
{"compliant": true|false, "confidence": 0.0-1.0, "reasoning": "one sentence", "policy_id": "which_policy_violated_or_null"}

Evaluate ONLY the policies provided. Do not invent additional policies.
If the evidence is insufficient to determine compliance, respond with {"compliant": true, "confidence": 0.5, "reasoning": "insufficient evidence"}.`;

// ===========================================
// Action Classification
// ===========================================

/**
 * Map a recognized tool name to its action label, or undefined when the tool
 * is not a known file/search operation (callers then fall back to command
 * classification). Pure name dispatch — no command inspection.
 */
function classifyToolName(toolName: string): string | undefined {
	if (
		toolName === "Write" ||
		toolName === "WriteFile" ||
		toolName === "write_file" ||
		toolName === "create"
	) {
		return "file_write";
	}
	if (
		toolName === "Edit" ||
		toolName === "EditFile" ||
		toolName === "edit_file" ||
		toolName === "str_replace"
	) {
		return "file_edit";
	}
	if (
		toolName === "Read" ||
		toolName === "ReadFile" ||
		toolName === "read_file" ||
		toolName === "view"
	) {
		return "file_read";
	}
	if (toolName === "Glob" || toolName === "Grep") {
		return "file_search";
	}
	return undefined;
}

/**
 * Classify a bash command string into a safe action label. An empty command
 * yields "unknown"; an unrecognized non-empty command yields "bash_other".
 * No raw command text leaks — only the category label is returned.
 */
function classifyCommand(cmd: string): string {
	if (!cmd) return "unknown";

	// Network commands
	if (/\b(curl|wget)\b/i.test(cmd)) {
		if (/localhost|127\.0\.0\.1/i.test(cmd)) return "curl_localhost";
		return "curl_external";
	}
	if (/\b(ssh|scp|sftp|rsync)\b/i.test(cmd)) return "network_ssh";
	if (/\b(nc|ncat|netcat|socat|telnet)\b/i.test(cmd)) return "network_raw";
	if (/\bnpm\s+publish\b/i.test(cmd)) return "npm_publish";

	// Git commands
	if (/\bgit\s+(push|pull|fetch|clone)\b/i.test(cmd)) return "git_network";
	if (/\bgit\s+(commit|add|stash|reset|checkout|rebase|merge)\b/i.test(cmd)) return "git_local";

	// Test/build commands
	if (/\b(npm\s+(test|run)|npx\s+(vitest|jest|mocha))\b/i.test(cmd)) return "npm_test";
	if (/\b(npm\s+(install|ci)|yarn|pnpm)\b/i.test(cmd)) return "npm_install";
	if (/\b(tsc|biome|eslint|prettier)\b/i.test(cmd)) return "lint_typecheck";
	if (/\b(make|cargo|go\s+build|gcc|g\+\+)\b/i.test(cmd)) return "build";

	// File operations
	if (/\brm\s/i.test(cmd)) return "file_delete";
	if (/\b(chmod|chown)\b/i.test(cmd)) return "file_permissions";
	if (/\b(cat|head|tail|less|more|wc)\b/i.test(cmd)) return "file_read_cmd";
	if (/\b(mkdir|touch|cp|mv)\b/i.test(cmd)) return "file_manage";
	if (/\b(ls|find|fd)\b/i.test(cmd)) return "file_list";

	return "bash_other";
}

/** Classify a tool call into a safe action label (no raw commands leak) */
function classifyAction(toolName: string, toolInput: JsonObject): string {
	const byTool = classifyToolName(toolName);
	if (byTool) return byTool;
	return classifyCommand(String(toolInput.command || ""));
}

/** Build a redacted target summary (no raw URLs, commands, or content) */
function buildTargetSummary(toolName: string, toolInput: JsonObject): string {
	const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
	if (filePath) return `file: ${filePath}`;

	const cmd = String(toolInput.command || "");
	if (!cmd) return toolName;

	// For curl/wget: classify the target without revealing the URL
	if (/\b(curl|wget)\b/i.test(cmd)) {
		if (/localhost|127\.0\.0\.1/i.test(cmd)) return "curl to localhost";
		return "curl to external URL (non-localhost)";
	}

	const actionClass = classifyAction(toolName, toolInput);
	return actionClass;
}

// ===========================================
// Evidence Envelope Builder
// ===========================================

/**
 * Build a redacted, structured evidence envelope for the classifier.
 * This is the SINGLE serialization point — all data leaving the process
 * passes through here. Security review should focus on this function.
 *
 * Explicitly excluded: raw commands, file contents, credentials, message bodies,
 * auth tokens, user identity beyond agent name/role.
 */
export function buildEvidenceEnvelope(
	event: HarnessEvent,
	session: SessionTrajectory,
	escalation: EscalationRequest,
	intentState?: { goal?: string; file_patterns?: string[] },
): PolicyEvidence {
	const toolInput = event.tool_input || {};
	const toolName = event.tool_name || "";

	// Classify recent actions (last 10 from tool_sequence)
	const recentActions = session.tool_sequence.slice(-10);

	// Count taint sources by level
	const taintSourceLevels = session.taint_sources.map((s) => s.level);

	// Injection detection context (`injection_detected_steps` is a required
	// field on SessionTrajectory — always an array, never undefined)
	const injectionDetected = session.injection_detected_steps;
	const injectionInSession = injectionDetected.length > 0;
	const stepsSinceInjection = injectionInSession
		? session.tool_call_count - nonNull(injectionDetected[injectionDetected.length - 1])
		: undefined;

	// Load policies from .interlinked/policies.json if available
	const policies = loadPolicies(escalation.trigger);

	return {
		tool: toolName,
		action_class: classifyAction(toolName, toolInput),
		target_summary: buildTargetSummary(toolName, toolInput),

		trigger: escalation.trigger,
		trigger_reason: escalation.summary,

		session_sensitivity: session.sensitivity_level,
		step_number: session.tool_call_count,
		taint_source_count: session.taint_sources.length,
		taint_source_levels: taintSourceLevels,
		recent_actions: recentActions,
		agent_role: event.agent_role || "unknown",
		files_written_count: session.files_written.size,
		errors_this_session: session.error_count,

		intent_goal: intentState?.goal,
		intent_file_patterns: intentState?.file_patterns,

		injection_detected_in_session: injectionInSession,
		steps_since_injection: stepsSinceInjection,

		policies,
	};
}

// ===========================================
// Classifier Client
// ===========================================

/**
 * Call the LLM classifier with structured evidence.
 * Fails open on any error (returns allow with confidence 0).
 * Increments sessionState.calls_this_session on every call.
 */
export async function callClassifier(
	evidence: PolicyEvidence,
	config: ClassifierConfig,
	sessionState: ClassifierSessionState,
): Promise<PolicyClassification> {
	sessionState.calls_this_session++;

	// Truncate evidence if it exceeds max_input_tokens (rough estimate: 4 chars per token)
	const evidenceStr = JSON.stringify(evidence);
	const maxChars = (config.max_input_tokens || 800) * 4;
	const truncatedEvidence =
		evidenceStr.length > maxChars ? evidenceStr.slice(0, maxChars) : evidenceStr;

	if (config.provider === "claude_code") {
		return callViaClaudeCode(truncatedEvidence, config, sessionState);
	}

	const apiKey = resolveApiKey(config.api_key_env);
	if (!apiKey) {
		return { label: "allow", confidence: 0, reasoning: "No API key configured" };
	}

	return callViaHttp(truncatedEvidence, apiKey, config, sessionState);
}

/** JSON schema for structured classifier output */
const CLASSIFIER_JSON_SCHEMA = JSON.stringify({
	type: "object",
	properties: {
		compliant: { type: "boolean" },
		confidence: { type: "number", minimum: 0, maximum: 1 },
		reasoning: { type: "string" },
		policy_id: { type: ["string", "null"] },
	},
	required: ["compliant", "confidence", "reasoning"],
});

/**
 * Call the classifier via the `claude` CLI subprocess.
 * Uses the user's existing Claude Code subscription (Max/Pro) — no API key needed.
 * Uses --bare to skip hooks/LSP (avoids recursive harness, faster startup).
 */
async function callViaClaudeCode(
	evidence: string,
	config: ClassifierConfig,
	sessionState: ClassifierSessionState,
): Promise<PolicyClassification> {
	const model = config.model || "haiku";
	const timeoutMs = config.timeout_ms || 15000;

	return new Promise((resolve) => {
		const child = spawn(
			"claude",
			[
				"-p",
				"--model",
				model,
				"--no-session-persistence",
				"--disallowed-tools",
				"Bash,Edit,Write,Read,Glob,Grep,Agent,WebFetch,WebSearch",
				"--effort",
				"low",
				"--output-format",
				"json",
				"--system-prompt",
				CLASSIFIER_SYSTEM_PROMPT,
				"--json-schema",
				CLASSIFIER_JSON_SCHEMA,
				evidence,
			],
			{ stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs },
		);

		let stdout = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.on("close", (code) => {
			if (code !== 0) {
				sessionState.consecutive_failures++;
				resolve({
					label: "allow",
					confidence: 0,
					reasoning: `Claude Code exit code ${code}`,
				});
				return;
			}
			const classification = parseClaudeCodeOutput(stdout.trim());
			sessionState.consecutive_failures = 0;
			resolve(classification);
		});
		child.on("error", (err: Error) => {
			sessionState.consecutive_failures++;
			resolve({
				label: "allow",
				confidence: 0,
				reasoning: `Claude Code spawn failed: ${err.message}`,
			});
		});
	});
}

/**
 * Call the classifier via HTTP to an inference provider (Groq, HuggingFace, Anthropic, etc.).
 * Requires an API key in the environment.
 */
/**
 * Build the fail-open classification used when the classifier HTTP call cannot
 * produce a verdict. The classifier is shadow-mode and deliberately fails open
 * (allow) with no circuit breaker, but the failure must be VISIBLE — so this
 * logs loudly to stderr rather than silently substituting a benign-looking
 * result. The `confidence: 0` + explicit `reasoning` already mark the verdict
 * as a non-answer for downstream consumers.
 */
function failOpenClassification(reason: string): PolicyClassification {
	console.warn(`[interlinked:policy-classifier] fail-open: ${reason}`);
	return { label: "allow", confidence: 0, reasoning: reason };
}

async function callViaHttp(
	evidence: string,
	apiKey: string,
	config: ClassifierConfig,
	sessionState: ClassifierSessionState,
): Promise<PolicyClassification> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeout_ms || 3000);

	try {
		const isAnthropic = config.provider === "anthropic";
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		let body: string;

		if (isAnthropic) {
			headers["x-api-key"] = apiKey;
			headers["anthropic-version"] = "2023-06-01";
			body = JSON.stringify({
				model: config.model,
				system: CLASSIFIER_SYSTEM_PROMPT,
				messages: [{ role: "user", content: evidence }],
				max_tokens: 150,
				temperature: 0,
			});
		} else {
			headers.Authorization = `Bearer ${apiKey}`;
			const isReasoning =
				config.model.includes("gpt-oss") || config.model.includes("reasoning");
			body = JSON.stringify({
				model: config.model,
				messages: [
					{ role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
					{ role: "user", content: evidence },
				],
				...(isReasoning
					? { max_completion_tokens: 1024, reasoning_effort: "low" }
					: { max_tokens: 150 }),
				temperature: 0,
			});
		}

		const response = await fetch(
			isAnthropic ? "https://api.anthropic.com/v1/messages" : config.endpoint,
			{ method: "POST", headers, body, signal: controller.signal },
		);

		if (!response.ok) {
			sessionState.consecutive_failures++;
			return failOpenClassification(`Classifier HTTP error: ${response.status}`);
		}

		const data = (await response.json()) as JsonObject;
		const classification = isAnthropic
			? parseAnthropicResponse(data)
			: parseOpenAIResponse(data);
		sessionState.consecutive_failures = 0;
		return classification;
	} catch (err) {
		sessionState.consecutive_failures++;
		const detail = err instanceof Error ? err.message : String(err);
		return failOpenClassification(`Classifier call failed: ${detail}`);
	} finally {
		clearTimeout(timer);
	}
}

// ===========================================
// Shadow Log
// ===========================================

export interface ShadowLogEntry {
	ts: string;
	session_id: string;
	agent_name: string;
	trigger: string;
	tool_name: string;
	action_class: string;
	local_decision: "allow" | "block";
	classification: PolicyClassification;
	would_have_changed: boolean;
	latency_ms: number;
	evidence_hash?: string;
}

/**
 * Append a shadow log entry to .interlinked/policy-shadow.jsonl.
 * This file is gitignored and used for tuning confidence thresholds.
 */
export function appendShadowLog(entry: ShadowLogEntry, cwd?: string): void {
	try {
		const dir = join(cwd || process.cwd(), ".interlinked");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const logPath = join(dir, "policy-shadow.jsonl");
		appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
	} catch (e) {
		void e;
	}
}

/**
 * Compute a SHA-256 hash of the evidence for deduplication/audit.
 */
export function hashEvidence(evidence: PolicyEvidence): string {
	const hash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
	return `sha256:${hash.slice(0, 16)}`;
}
