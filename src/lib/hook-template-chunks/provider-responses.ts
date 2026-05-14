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
    // Codex CLI shipped its hook contract using Claude Code's vocabulary, so
    // for PreToolUse/PostToolUse blocks the legacy {decision:"block", reason}
    // shape works for both. Advisory PostToolUse feedback travels as
    // hookSpecificOutput.additionalContext so the tool result stands and the
    // agent gets follow-up guidance. Codex's PermissionRequest uses a distinct
    // hookSpecificOutput.decision.behavior shape — handled in formatCodexResponse.

    function formatClaudeResponse(responseType, data, preEventEcho, postEventEcho) {
        if (responseType === "pre_block_grep") {
            return { hookSpecificOutput: {
                hookEventName: preEventEcho,
                permissionDecision: "deny",
                permissionDecisionReason: data.reason,
            }};
        }
        if (responseType === "pre_block") {
            return { decision: "block", reason: data.reason };
        }
        if (responseType === "pre_ask") {
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
        if (responseType === "user_prompt_advice") {
            // Metacoder system_prompt_addendum lands in the agent's context
            // via Claude's UserPromptSubmit hookSpecificOutput.additionalContext
            // channel. Plan §3.
            if (!data.summary) return {};
            return { hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: data.summary,
            }};
        }
        return {};
    }

    function formatCopilotResponse(responseType, data) {
        if (responseType === "pre_block" || responseType === "pre_block_grep" || responseType === "pre_ask") {
            // Copilot has no "ask" primitive — collapse to deny so the user
            // sees the reason and can retry deliberately.
            return { permissionDecision: "deny", permissionDecisionReason: data.reason };
        }
        if (responseType === "post_block" || responseType === "post_warn") {
            // Copilot postToolUse is observation-only — write to stderr instead.
            if (data.reason) process.stderr.write(data.reason + "\\n");
            return {};
        }
        return {};
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

    function codexPermissionDeny(reason) {
        return { hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny", message: reason },
        }};
    }

    function formatCodexResponse(responseType, data, postEventEcho, incomingEvent) {
        const isPermissionRequest = incomingEvent === "PermissionRequest";
        if (responseType === "pre_block_grep" || responseType === "pre_block" || responseType === "pre_ask") {
            // Codex has no documented "ask" primitive — collapse to a hard
            // block. PermissionRequest uses a dedicated decision shape; for
            // PreToolUse the legacy {decision:"block"} form is accepted.
            if (isPermissionRequest) return codexPermissionDeny(data.reason);
            return { decision: "block", reason: data.reason };
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
        if (responseType === "user_prompt_advice") {
            // Codex mirrors Claude's hookSpecificOutput.additionalContext
            // contract per docs/hooks-ecosystem-comparison.md:81 — emit the
            // metacoder addendum on the model-visible channel. Plan §3.
            if (!data.summary) return {};
            return { hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
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

        if (detectedClient === "copilot") return formatCopilotResponse(responseType, data);
        if (detectedClient === "codex") return formatCodexResponse(responseType, data, postEventEcho, incomingEvent);
        if (detectedClient === "cursor") {
            // Pass the raw Cursor event (cursorNativeEvent) so per-event
            // capabilities (additional_context on postToolUse only, ask on
            // shell/MCP only) can be honored. Falls back to incomingEvent if
            // the entry didn't capture the native name (older callers).
            return formatCursorResponse(responseType, data, incomingEvent, cursorNativeEvent);
        }
        return formatClaudeResponse(responseType, data, preEventEcho, postEventEcho);
    }`;
