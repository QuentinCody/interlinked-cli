// Extracted from hooks-template.ts.
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// This chunk is nested inside `main()` in the generated script, so its leading
// indentation (4 spaces) is part of the emitted source.
//
// Each provider expects a different stdout JSON shape on hook decisions.
// The harness returns a provider-agnostic decision; this chunk emits the
// per-provider translation. Shape is split into per-provider formatter
// functions so the dispatcher stays at depth 1 and adding a new provider
// is a one-line registry change rather than another nested switch.

/**
 * Canonical Claude/Codex gate-deny shapes. This chunk is emitted once at the
 * generated script's module scope so both ordinary decision formatting and
 * the terminal main() rejection handler use the same contract.
 */
export const NATIVE_GATE_DENY_RESPONSE_CHUNK = `function nativeGateDenyResponse(provider, eventName, reason) {
    if (provider !== "claude" && provider !== "codex") return null;
    if (eventName === "PermissionRequest") {
        return { hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny", message: reason },
        }};
    }
    if (eventName === "PreToolUse") {
        return { hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
        }};
    }
    return null;
}`;

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const PROVIDER_RESPONSES_CHUNK = `    // ═══════════════════════════════════════════
    // Provider-specific response formatting
    // ═══════════════════════════════════════════
    //
    // CRITICAL: Claude Code validates hookSpecificOutput.hookEventName against
    // the incoming event name. Responses must echo back the actual event
    // (PostToolUse vs PostToolUseFailure, PreToolUse vs PermissionRequest)
    // or Claude Code rejects them with "Hook returned incorrect event name".
    //
    // Claude Code and Codex use phase-specific permission contracts.
    // PreToolUse denies use permissionDecision; PermissionRequest denies use
    // hookSpecificOutput.decision.behavior. Advisory feedback travels as
    // hookSpecificOutput.additionalContext so the tool result stands and the
    // agent gets follow-up guidance on events that support that field.

    function formatClaudeResponse(responseType, data, preEventEcho, postEventEcho) {
		const isPermissionRequest = preEventEcho === "PermissionRequest";
		if (responseType === "pre_allow" && isPermissionRequest) {
			const feedback = [data.systemMessage, data.additionalContext].filter(Boolean).join("\\n");
			if (feedback) process.stderr.write(feedback + "\\n");
			return {};
		}
        if (responseType === "pre_block_grep") {
            if (isPermissionRequest) return nativeGateDenyResponse("claude", preEventEcho, data.reason);
            return { hookSpecificOutput: {
                hookEventName: preEventEcho,
                permissionDecision: "deny",
                permissionDecisionReason: data.reason,
            }};
        }
        if (responseType === "pre_block") {
            if (isPermissionRequest) return nativeGateDenyResponse("claude", preEventEcho, data.reason);
            // PreToolUse deny lives in hookSpecificOutput.permissionDecision —
            // root {decision:"block"} is rejected for PreToolUse ("(root):
            // Invalid input"), silently failing to block. (post_block below
            // keeps root {decision:"block"}, which IS valid for PostToolUse.)
            return nativeGateDenyResponse("claude", preEventEcho, data.reason) || { hookSpecificOutput: {
                hookEventName: preEventEcho,
                permissionDecision: "deny",
                permissionDecisionReason: data.reason,
            }};
        }
        if (responseType === "pre_ask") {
			if (isPermissionRequest) {
				// Claude is already inside its native approval flow. Abstain so
				// configured policy and the user's prompt retain authority. This
				// event has no generic additionalContext response; keep the
				// explanation debug-only on stderr.
				const message = data.systemMessage || data.reason;
				if (message) process.stderr.write(message + "\\n");
				return {};
			}
            // Surface Claude Code's permission prompt so the user confirms
            // per-call. \`systemMessage\` is the user-only channel — shown in
            // the permission UI but NOT included in the model context. The
            // content scanner uses it to surface raw flagged PII while
            // keeping permissionDecisionReason agent-safe.
            const askResp = { hookSpecificOutput: {
                hookEventName: preEventEcho,
                permissionDecision: "ask",
                permissionDecisionReason: data.reason,
            }};
            if (data.systemMessage) askResp.systemMessage = data.systemMessage;
            return askResp;
        }
        if (responseType === "post_block") {
            return { decision: "block", reason: data.reason };
        }
        if (responseType === "post_warn") {
            // No summary = no model-visible content. Returning an empty
            // hookSpecificOutput (just hookEventName, no additionalContext)
            // makes Claude Code's validator reject the hook with
            // "(root): Invalid input" — emit {} instead so the caller can
            // skip writing stdout entirely.
            if (!data.summary) return {};
            return { hookSpecificOutput: {
                hookEventName: postEventEcho,
                additionalContext: data.summary,
            }};
        }
        if (responseType === "post_success") {
            if (!data.summary) return {};
            return { hookSpecificOutput: {
                hookEventName: postEventEcho,
                additionalContext: data.summary,
            }};
        }
        return {};
    }

    function formatCopilotResponse(responseType, data) {
        if (responseType === "pre_block" || responseType === "pre_block_grep" || responseType === "pre_ask") {
            // Copilot has no certified approval receipt in this fallback;
            // conservatively deny until the installed version is measured.
            return { permissionDecision: "deny", permissionDecisionReason: data.reason };
        }
        if (responseType === "post_block" || responseType === "post_warn") {
            const feedback = data.reason || data.summary;
            return feedback ? { additionalContext: feedback } : {};
        }
        if (responseType === "pre_allow" && data.updatedInput) return { modifiedArgs: data.updatedInput };
        return {};
    }

    function formatGeminiResponse(responseType, data, eventName) {
        if (responseType === "pre_block" || responseType === "pre_block_grep" || responseType === "pre_ask" || responseType === "post_block") {
            return { decision: "deny", reason: data.reason };
        }
        const nativeNames = { PreToolUse: "BeforeTool", PostToolUse: "AfterTool", UserPromptSubmit: "BeforeAgent", Stop: "AfterAgent" };
        const native = nativeNames[eventName] || eventName;
        const specific = { hookEventName: native };
        if (native === "BeforeTool" && data.updatedInput) specific.tool_input = data.updatedInput;
        const feedback = data.additionalContext || data.summary;
        if (feedback) specific.additionalContext = feedback;
        return Object.keys(specific).length > 1 ? { hookSpecificOutput: specific } : {};
    }

    function formatCursorResponse(responseType, data, incomingEvent, nativeEvent) {
        // Cursor's hook response shape uses SNAKE_CASE field names per the
        // public docs (https://cursor.com/docs/hooks):
        //   { permission: "allow"|"deny"|"ask",
        //     user_message, agent_message, updated_input?,
        //     additional_context?, updated_mcp_tool_output?,
        //     followup_message? }
        //
        // Capability map (per-event; Cursor docs are explicit about each):
        //   - beforeShellExecution / beforeMCPExecution: allow|deny|ask + msgs
        //   - preToolUse: allow|deny only (ask accepted by schema, not enforced)
        //   - beforeReadFile: allow|deny + user_message
        //   - subagentStart: allow|deny + user_message (ask treated as deny)
        //   - postToolUse: additional_context (model-visible advisory channel,
        //                  same role as Claude's PostToolUse additionalContext)
        //   - everything else (afterFileEdit, afterShellExecution,
        //                      afterMCPExecution, postToolUseFailure,
        //                      sessionEnd, stop): no enforced output —
        //                      stderr is the only human-visible surface.
        //
        // After normalization, incomingEvent carries the canonical "PreToolUse"
        // / "PostToolUse" / "PostToolUseFailure" name. nativeEvent carries the
        // raw Cursor event name (beforeShellExecution / postToolUse / etc.) so
        // we can disambiguate which post-event we're on (only postToolUse
        // honors additional_context — afterFileEdit does not).
        const native = nativeEvent || incomingEvent;
        const isShellOrMcpGate = native === "beforeShellExecution"
            || native === "beforeMCPExecution"
            || native === "beforeMcpToolExecution";
        const isOtherPreGate = native === "preToolUse"
            || native === "PreToolUse"
            || native === "beforeReadFile"
            || native === "subagentStart";
        const isPreGate = isShellOrMcpGate || isOtherPreGate;
        const supportsAdditionalContext = native === "postToolUse";

        if (responseType === "pre_block" || responseType === "pre_block_grep") {
            if (!isPreGate) return {};
            return {
                permission: "deny",
                agent_message: data.reason,
                user_message: data.reason,
            };
        }
        if (responseType === "pre_ask") {
            if (!isPreGate) return {};
            // Cursor only enforces "ask" on shell/MCP gates. On preToolUse /
            // beforeReadFile / subagentStart the docs say ask is silently
            // ignored or treated as deny — collapse to deny so the user sees
            // the reason rather than the action sneaking through.
            const permission = isShellOrMcpGate ? "ask" : "deny";
            return {
                permission,
                agent_message: data.reason,
                user_message: data.systemMessage || data.reason,
            };
        }
        if (responseType === "post_block") {
            // Cursor postToolUse can't roll back an executed tool, but the
            // model-visible additional_context channel is the right place to
            // tell the agent what's wrong so it can self-correct on the next
            // turn — same UX as Claude's PostToolUse decision:"block".
            if (supportsAdditionalContext && data.reason) {
                return { additional_context: data.reason };
            }
            if (data.reason) process.stderr.write(data.reason + "\\n");
            return {};
        }
        if (responseType === "post_warn" || responseType === "post_success") {
            if (supportsAdditionalContext && data.summary) {
                return { additional_context: data.summary };
            }
            if (data.summary) process.stderr.write(data.summary + "\\n");
            return {};
        }
        return {};
    }

    function formatCodexResponse(responseType, data, postEventEcho, incomingEvent) {
        const isPermissionRequest = incomingEvent === "PermissionRequest";
		if (responseType === "pre_allow" && isPermissionRequest) {
			const feedback = [data.systemMessage, data.additionalContext].filter(Boolean).join("\\n");
			if (feedback) process.stderr.write(feedback + "\\n");
			return {};
		}
        if (responseType === "pre_ask" && isPermissionRequest) {
            // Abstain so Codex displays its own permission prompt. Emitting
            // an allow decision here would bypass the user's normal policy.
            return {};
        }
        if (responseType === "pre_block_grep" || responseType === "pre_block" || responseType === "pre_ask") {
            // Codex has no ask primitive on PreToolUse, so unresolved asks
            // collapse to a deny. PermissionRequest has a distinct shape.
            return nativeGateDenyResponse("codex", incomingEvent, data.reason);
        }
        if (responseType === "post_block") {
            // Codex PostToolUse: legacy block shape replaces the tool result
            // with the hook reason and continues the model from there.
            return { decision: "block", reason: data.reason };
        }
        if (responseType === "post_warn") {
            // Codex inherits the same Claude-Code-shaped validator —
            // hookSpecificOutput without actual content is rejected.
            if (!data.summary) return {};
            return { hookSpecificOutput: {
                hookEventName: postEventEcho,
                additionalContext: data.summary,
            }};
        }
        if (responseType === "post_success") {
            if (!data.summary) return {};
            return { hookSpecificOutput: {
                hookEventName: postEventEcho,
                additionalContext: data.summary,
            }};
        }
        return {};
    }

    function formatProviderResponse(responseType, data) {
        // Resolve the event name to echo. For Claude/Codex, must match the
        // incoming hook_event_name exactly. For Copilot, this is a no-op.
        const incomingEvent = data.hookEventName || hookEvent;
        const isPreEvent = incomingEvent === "PreToolUse" || incomingEvent === "BeforeTool" || incomingEvent === "PermissionRequest";
        const preEventEcho = isPreEvent ? incomingEvent : "PreToolUse";
        const postEventEcho = !isPreEvent ? incomingEvent : "PostToolUse";

        if (responseType === "pre_allow" && incomingEvent === "PreToolUse" && data.updatedInput && (detectedClient === "claude" || detectedClient === "codex")) {
            return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: data.updatedInput } };
        }

        if (detectedClient === "copilot") return formatCopilotResponse(responseType, data);
        if (detectedClient === "gemini") return formatGeminiResponse(responseType, data, incomingEvent);
        if (detectedClient === "codex") return formatCodexResponse(responseType, data, postEventEcho, incomingEvent);
        if (detectedClient === "cursor") {
            // Pass the raw Cursor event (cursorNativeEvent) so per-event
            // capabilities (additional_context on postToolUse only, ask on
            // shell/MCP only) can be honored. Falls back to incomingEvent if
            // the entry didn't capture the native name (older callers).
            return formatCursorResponse(responseType, data, incomingEvent, cursorNativeEvent);
        }
        return formatClaudeResponse(responseType, data, preEventEcho, postEventEcho);
    }

    // THE OUTPUT RULE (2026-08-27): a hook with nothing to say writes ZERO
    // BYTES. Printing "{}" is not silence — Codex renders one
    // "PostToolUse hook (completed)" row per response, so an empty envelope on
    // every clean tool call is chat noise, and parallel commands multiply it.
    // Every formatter already returns {} when it has no content, so routing
    // all stdout through this one helper makes "no content ⇒ no output" a
    // property of the runtime instead of a per-site decision. Clean timing is
    // still recorded — in writeLastCheck (statusline) and the local activity
    // log, which are the telemetry surfaces. The conversation is not.
    function writeProviderResponse(responseType, data) {
        const response = formatProviderResponse(responseType, data);
        if (!response || (Object.keys(response).length === 0 && detectedClient !== "gemini")) return;
        stageProviderStdout(response);
    }`;
