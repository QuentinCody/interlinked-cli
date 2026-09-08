import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
	NATIVE_GATE_DENY_RESPONSE_CHUNK,
	PROVIDER_RESPONSES_CHUNK,
} from "./provider-responses.js";

// PROVIDER_RESPONSES_CHUNK is a template-literal string that becomes runtime
// JS in the generated `.interlinked/hooks/interlinked-activity.mjs`. We
// can't import its functions directly (they reference outer-scope
// variables defined in the surrounding template), so we verify shape: the
// per-provider formatters exist, the dispatcher is depth-1, and each
// provider's documented response shape is present.

function executeProviderResponse(
	responseType: string,
	data: Record<string, unknown>,
	hookEvent = "PermissionRequest",
	detectedClient = "claude",
): { response: unknown; stderr: string } {
	let stderr = "";
	const sandbox: Record<string, unknown> = {
		detectedClient,
		hookEvent,
		cursorNativeEvent: undefined,
		responseType,
		data,
		process: {
			stderr: {
				write(value: unknown) {
					stderr += String(value);
				},
			},
		},
	};
	runInNewContext(
		`${NATIVE_GATE_DENY_RESPONSE_CHUNK}\n${PROVIDER_RESPONSES_CHUNK}\nresult = formatProviderResponse(responseType, data);`,
		sandbox,
	);
	return { response: sandbox.result, stderr };
}

describe("PROVIDER_RESPONSES_CHUNK — shape", () => {
	it.each(["pre_block", "pre_ask", "post_block"])("Gemini %s uses its native denial contract", responseType => {
		expect(executeProviderResponse(responseType, { reason: "policy" }, "BeforeTool", "gemini").response).toEqual({ decision: "deny", reason: "policy" });
	});
	it("Gemini retains a rewrite and Copilot retains post-tool feedback", () => {
		expect(executeProviderResponse("pre_allow", { updatedInput: { command: "safe" } }, "PreToolUse", "gemini").response).toEqual({ hookSpecificOutput: { hookEventName: "BeforeTool", tool_input: { command: "safe" } } });
		expect(executeProviderResponse("post_block", { reason: "review" }, "PostToolUse", "copilot").response).toEqual({ additionalContext: "review" });
	});
	it("is a non-empty string", () => {
		expect(typeof PROVIDER_RESPONSES_CHUNK).toBe("string");
		expect(PROVIDER_RESPONSES_CHUNK.length).toBeGreaterThan(100);
	});

	it("exposes formatProviderResponse as the dispatcher", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain("function formatProviderResponse(");
	});

	it("defines per-provider formatters (claude / copilot / codex)", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain("function formatClaudeResponse(");
		expect(PROVIDER_RESPONSES_CHUNK).toContain("function formatCopilotResponse(");
		expect(PROVIDER_RESPONSES_CHUNK).toContain("function formatCodexResponse(");
	});

	it("dispatches based on detectedClient", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain('detectedClient === "copilot"');
		expect(PROVIDER_RESPONSES_CHUNK).toContain('detectedClient === "codex"');
	});

	it("Claude post_block uses the top-level decision: 'block' shape", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain('decision: "block"');
		expect(PROVIDER_RESPONSES_CHUNK).toContain("reason: data.reason");
	});

	it("Claude pre_block_grep uses hookSpecificOutput.permissionDecision", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain("hookSpecificOutput");
		expect(PROVIDER_RESPONSES_CHUNK).toContain('permissionDecision: "deny"');
		expect(PROVIDER_RESPONSES_CHUNK).toContain("permissionDecisionReason");
	});

	it.each(["pre_block", "pre_block_grep"])(
		"P: Claude PermissionRequest %s emits the exact native deny object",
		(responseType) => {
			const { response, stderr } = executeProviderResponse(responseType, {
				reason: "policy denied",
			});
			expect(response).toEqual({
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: { behavior: "deny", message: "policy denied" },
				},
			});
			expect(stderr).toBe("");
		},
	);

	it("P: Claude PreToolUse block keeps permissionDecision", () => {
		const { response } = executeProviderResponse(
			"pre_block",
			{ reason: "policy denied" },
			"PreToolUse",
		);
		expect(response).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "policy denied",
			},
		});
	});

	it("Claude pre_ask uses permissionDecision: 'ask' with optional systemMessage", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain('permissionDecision: "ask"');
		expect(PROVIDER_RESPONSES_CHUNK).toContain("data.systemMessage");
		expect(PROVIDER_RESPONSES_CHUNK).toContain("askResp.systemMessage");
	});

	it("Claude PermissionRequest ask abstains for the native prompt", () => {
		const claudeBlock = PROVIDER_RESPONSES_CHUNK.match(
			/function formatClaudeResponse[\s\S]*?function formatCopilotResponse/,
		);
		expect(claudeBlock?.[0]).toContain(
			'const isPermissionRequest = preEventEcho === "PermissionRequest"',
		);
		expect(claudeBlock?.[0]).toMatch(/pre_ask[\s\S]*isPermissionRequest[\s\S]*return \{\};/);
	});

	it("N: Claude PermissionRequest ask emits no JSON fields and keeps its message on stderr", () => {
		const { response, stderr } = executeProviderResponse("pre_ask", {
			reason: "agent-safe reason",
			systemMessage: "user-only explanation",
		});
		expect(response).toEqual({});
		expect(stderr).toBe("user-only explanation\n");
	});

	it("N: Claude PermissionRequest allow context emits no JSON fields and stays on stderr", () => {
		const { response, stderr } = executeProviderResponse("pre_allow", {
			additionalContext: "permission context",
		});
		expect(response).toEqual({});
		expect(stderr).toBe("permission context\n");
	});

	it("Copilot collapses ask → deny (no ask primitive)", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain("Copilot has no");
		expect(PROVIDER_RESPONSES_CHUNK).toMatch(/Copilot[\s\S]*permissionDecision: "deny"/);
	});

	it("Copilot post_block writes to stderr (observation-only postToolUse)", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain("process.stderr.write");
	});

	it("Claude post_warn uses additionalContext instead of the block shape", () => {
		const claudeBlock = PROVIDER_RESPONSES_CHUNK.match(
			/function formatClaudeResponse[\s\S]*?function formatCopilotResponse/,
		);
		expect(claudeBlock?.[0]).toContain('responseType === "post_warn"');
		expect(claudeBlock?.[0]).toContain("additionalContext: data.summary");
	});

	it("Copilot post_warn shares the observation-only stderr path", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain('responseType === "post_block" || responseType === "post_warn"');
	});

	it("Codex PermissionRequest uses hookSpecificOutput.decision.behavior", () => {
		// PermissionRequest has its own phase shape, distinct from PreToolUse's
		// permissionDecision field.
		expect(NATIVE_GATE_DENY_RESPONSE_CHUNK).toContain(
			"function nativeGateDenyResponse(",
		);
		expect(NATIVE_GATE_DENY_RESPONSE_CHUNK).toContain(
			'hookEventName: "PermissionRequest"',
		);
		expect(NATIVE_GATE_DENY_RESPONSE_CHUNK).toContain('behavior: "deny"');
	});

	it("Codex PreToolUse uses permissionDecision while PostToolUse uses continuation", () => {
		const codexBlock = PROVIDER_RESPONSES_CHUNK.match(
			/function formatCodexResponse[\s\S]*?function formatProviderResponse/,
		);
		expect(codexBlock).not.toBeNull();
		expect(codexBlock?.[0]).toContain("nativeGateDenyResponse");
		expect(NATIVE_GATE_DENY_RESPONSE_CHUNK).toContain(
			'hookEventName: "PreToolUse"',
		);
		expect(NATIVE_GATE_DENY_RESPONSE_CHUNK).toContain(
			'permissionDecision: "deny"',
		);
		expect(codexBlock?.[0]).toContain('decision: "block"');
	});

	it("Codex PermissionRequest ask abstains for the native prompt", () => {
		const codexBlock = PROVIDER_RESPONSES_CHUNK.match(
			/function formatCodexResponse[\s\S]*?function formatProviderResponse/,
		);
		expect(codexBlock?.[0]).toContain(
			'if (responseType === "pre_ask" && isPermissionRequest)',
		);
		expect(codexBlock?.[0]).toContain("return {};");
	});

	it("Codex post_success surfaces additionalContext on the canonical event echo", () => {
		const codexBlock = PROVIDER_RESPONSES_CHUNK.match(
			/function formatCodexResponse[\s\S]*?function formatProviderResponse/,
		);
		expect(codexBlock?.[0]).toContain("additionalContext: data.summary");
		expect(codexBlock?.[0]).toContain("hookEventName: postEventEcho");
	});

	it("Codex post_warn uses additionalContext so advisory findings do not look blocked", () => {
		const codexBlock = PROVIDER_RESPONSES_CHUNK.match(
			/function formatCodexResponse[\s\S]*?function formatProviderResponse/,
		);
		expect(codexBlock?.[0]).toContain('responseType === "post_warn"');
		expect(codexBlock?.[0]).toContain("additionalContext: data.summary");
	});

	it("preEventEcho reflects PermissionRequest as a pre-event for Claude", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain('"PermissionRequest"');
		expect(PROVIDER_RESPONSES_CHUNK).toMatch(
			/incomingEvent === "PreToolUse" \|\| incomingEvent === "BeforeTool" \|\| incomingEvent === "PermissionRequest"/,
		);
	});
});
