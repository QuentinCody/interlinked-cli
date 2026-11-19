// @codegen-data — template-string carrier for the generated .mjs hook; no
// hand-written runtime logic to unit-test (exempts the every-file-tested gate).
// Extracted from event-normalizers.ts (decomposed for the 1500-line cap).
// This is DATA — part of the body of the generated
// `.interlinked/hooks/interlinked-activity.mjs`. Do NOT edit escape sequences
// (`\\s`, `\\n`, `\\*`, `\\u0000`, etc.) — they are the source form for the
// runtime script (`\\s` here becomes `\s` in the emitted .mjs).
//
// Shared helpers (envelope, error classification, LOC delta, outcome capture) + Claude Code and Codex CLI normalizers.
// Concatenated verbatim by event-normalizers.ts into EVENT_NORMALIZERS_CHUNK;
// the join is direct (no separators) so the emitted bytes are unchanged.

export const CLAUDE_NORMALIZERS = `// --- Client Normalizers ---

// Fields present on every Claude Code hook invocation: cwd + transcript_path
// + session_id. Pulling them once at the top of the normalizer means every
// event carries the agent's working directory and transcript pointer.
function envelopeFieldsClaude(input) {
    return {
        cwd: input.cwd || null,
        transcript_path: input.transcript_path || null,
        session_id_hint: input.session_id || null,
    };
}

// Classify an error/diagnostic string into a coarse category so downstream
// tooling can group failures without re-parsing free-text. Heuristic; errs
// toward "tool_error". Pass interrupted=true to short-circuit to
// "user_interrupt". Called from attachOutcome, so every client's folded
// failures get categorized through one path.
function classifyErrorText(text, interrupted) {
    if (interrupted) return "user_interrupt";
    const raw = String(text || "").toLowerCase();
    if (!raw) return "unknown";
    if (raw.includes("timed out") || raw.includes("timeout")) return "timeout";
    if (raw.includes("permission") || raw.includes("denied") || raw.includes("not allowed")) return "permission";
    if (raw.includes("blocked") || raw.includes("guard")) return "blocked";
    if (raw.includes("not found") || raw.includes("enoent")) return "not_found";
    if (raw.includes("abort") || raw.includes("cancel")) return "aborted";
    return "tool_error";
}

// Step 1b — lines-of-code delta per edit. Computed from the tool_input alone
// (no filesystem I/O), so it's essentially free on every PostToolUse.
// Returns null for tools that aren't file edits — callers skip attaching
// the fields in that case. \`hunks\` is the count of independent edit pairs
// (1 for Edit/Write/NotebookEdit, edits.length for MultiEdit).
function computeLocDelta(toolName, toolInput) {
    if (!toolInput) return null;
    const nl = (s) => (typeof s === "string" ? (s.match(/\\n/g) || []).length : 0);
    if (toolName === "Edit" || toolName === "str_replace" || toolName === "apply_patch") {
        return { added: nl(toolInput.new_string), removed: nl(toolInput.old_string), hunks: 1 };
    }
    if (toolName === "Write" || toolName === "create_file") {
        // No baseline for Write — report as all-added.
        return { added: nl(toolInput.content), removed: 0, hunks: 1 };
    }
    if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
        let added = 0, removed = 0;
        for (const e of toolInput.edits) {
            added += nl(e.new_string);
            removed += nl(e.old_string);
        }
        return { added, removed, hunks: toolInput.edits.length };
    }
    if (toolName === "NotebookEdit") {
        // Rough proxy — notebook cells aren't line-based, count content lines.
        return { added: nl(toolInput.new_source), removed: nl(toolInput.old_source), hunks: 1 };
    }
    return null;
}

// Cap value used by capStderr / capStdout. Read once per hook invocation;
// agents can override via INTERLINKED_STDERR_MAX_BYTES env var.
function streamCapBytes() {
    const raw = parseInt(process.env.INTERLINKED_STDERR_MAX_BYTES || "", 10);
    if (!Number.isFinite(raw) || raw <= 0) return 8192;
    // Hard ceiling so a typo doesn't bloat activity.jsonl.
    return Math.min(raw, 65536);
}

// Middle-truncate a string to maxBytes. Preserves head + tail + a marker
// so the most-useful diagnostic context (top of compiler output, bottom of
// test runner output) survives independently of which end carries signal.
function middleTruncateBytes(s, maxBytes) {
    if (!s) return "";
    const buf = Buffer.from(String(s), "utf8");
    if (buf.length <= maxBytes) return buf.toString("utf8");
    const half = Math.max(1, Math.floor(maxBytes / 2));
    const head = buf.slice(0, half).toString("utf8");
    const tail = buf.slice(buf.length - half).toString("utf8");
    return head + "\\n...[interlinked:truncated " + (buf.length - maxBytes) + " bytes]...\\n" + tail;
}

// SHA-256 fingerprint of the canonical write payload. Lets downstream
// retry-loop / thrashing detection compare "agent ran the exact same edit
// twice in a row" without storing the full payload twice. Returns null on
// failure (e.g., crypto unavailable in some sandboxed runtimes).
function fingerprintWrite(toolName, toolInput) {
    if (!toolInput) return null;
    let canonical = "";
    try {
        if (toolName === "Edit" || toolName === "str_replace" || toolName === "apply_patch") {
            canonical = String(toolInput.old_string || "") + "\\u0000" + String(toolInput.new_string || "");
        } else if (toolName === "Write" || toolName === "create_file") {
            canonical = String(toolInput.content || "");
        } else if (toolName === "MultiEdit") {
            canonical = JSON.stringify(toolInput.edits || []);
        } else if (toolName === "NotebookEdit") {
            canonical = String(toolInput.old_source || "") + "\\u0000" + String(toolInput.new_source || "");
        } else {
            return null;
        }
        const h = createHash("sha256");
        h.update(canonical);
        return h.digest("hex").slice(0, 16);
    } catch {
        return null;
    }
}

// Cap an arbitrary tool_response (string or object) before persisting to
// activity.jsonl. Without this, a single 'find /' or 'curl https://...'
// can land megabytes into the log; an unbounded log breaks every consumer
// (statusline reads, sync, grep). Object responses get string-cap on each
// large string field. Returns:
//   - null/undefined → unchanged
//   - small (under cap) → unchanged
//   - large string → middle-truncated string
//   - large object → shallow clone with each oversized string field
//     middle-truncated and a _truncated metadata field appended.
function capToolResponse(toolResponse) {
    if (toolResponse === null || toolResponse === undefined) return toolResponse;
    const cap = (() => {
        const raw = parseInt(process.env.INTERLINKED_TOOL_RESPONSE_MAX_BYTES || "", 10);
        if (!Number.isFinite(raw) || raw <= 0) return 32768;
        return Math.min(raw, 524288);
    })();
    if (typeof toolResponse === "string") {
        return Buffer.byteLength(toolResponse, "utf8") <= cap
            ? toolResponse
            : middleTruncateBytes(toolResponse, cap);
    }
    if (typeof toolResponse !== "object") return toolResponse;
    // Shallow-clone so we never mutate the upstream Claude Code payload.
    let totalBytes = 0;
    let truncated = false;
    const clone = Array.isArray(toolResponse) ? [] : {};
    for (const [k, v] of Object.entries(toolResponse)) {
        if (typeof v === "string") {
            const bytes = Buffer.byteLength(v, "utf8");
            totalBytes += bytes;
            if (bytes > cap) {
                clone[k] = middleTruncateBytes(v, cap);
                truncated = true;
            } else {
                clone[k] = v;
            }
        } else {
            clone[k] = v;
        }
    }
    if (truncated && !Array.isArray(clone)) {
        clone._interlinked_truncated_bytes = totalBytes;
    }
    return clone;
}

// SHA-256 fingerprint of any tool_response (string or object). Used as a
// general "exact same output" detector across all tools, not just edits.
function fingerprintResponse(toolResponse) {
    if (toolResponse === null || toolResponse === undefined) return null;
    try {
        const s = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
        if (!s) return null;
        const h = createHash("sha256");
        h.update(s);
        return h.digest("hex").slice(0, 16);
    } catch {
        return null;
    }
}

// Pull the most-specific diagnostic text out of a tool_response across
// every supported provider shape. Returns null when nothing useful is set
// (callers fall back to truncated stderr). Order matches the design doc's
// 1a-fix step: Claude tool_response.message → Cursor error_message → Copilot
// toolResult.error / error → Gemini tool_response.error.
function extractProviderErrorMessage(toolResponse, errorDetail) {
    if (typeof errorDetail === "string" && errorDetail) return errorDetail;
    if (toolResponse && typeof toolResponse === "object") {
        if (typeof toolResponse.message === "string" && toolResponse.message) return toolResponse.message;
        if (typeof toolResponse.error === "string" && toolResponse.error) return toolResponse.error;
        if (typeof toolResponse.error_message === "string" && toolResponse.error_message) return toolResponse.error_message;
        if (toolResponse.toolResult && typeof toolResponse.toolResult === "object") {
            if (typeof toolResponse.toolResult.error === "string" && toolResponse.toolResult.error) return toolResponse.toolResult.error;
            if (typeof toolResponse.toolResult.message === "string" && toolResponse.toolResult.message) return toolResponse.toolResult.message;
        }
    }
    if (errorDetail && typeof errorDetail === "object") {
        if (typeof errorDetail.message === "string" && errorDetail.message) return errorDetail.message;
        try { return JSON.stringify(errorDetail); } catch { return null; }
    }
    return null;
}

// Derive canonical tool outcome fields from a PostToolUse / PostToolUseFailure
// payload. The shape is stable across all clients (Claude / Codex / Gemini /
// Cursor / Copilot) — downstream consumers can read tool_outcome / exit_code /
// stderr / error_message without re-parsing each client's tool_response shape.
// error_message is the canonical diagnostic text for Channels 2/3/6 to classify.
//
// Capture policy (per the design discussion):
//   - On success: skip stderr/stdout (they're noise). Hash the response so
//     identical-output detection still works.
//   - On error: full stderr up to streamCapBytes() (default 8 KB), stdout
//     up to half that. Middle-truncate so head+tail both survive — vitest
//     puts the assertion delta at the bottom, npm install puts the error
//     at the top.
function deriveToolOutcome(toolName, toolResponse, errorDetail, status, isInterrupt) {
    const result = {
        tool_outcome: status === "error" ? "error" : "success",
        error_message: null,
        exit_code: null,
        stderr: null,
        stdout: null,
        tool_response_sha256: fingerprintResponse(toolResponse),
    };
    if (isInterrupt) {
        result.tool_outcome = "interrupted";
    }
    const cap = streamCapBytes();
    const isBash = toolName === "Bash" || toolName === "Shell" || toolName === "shell" || toolName === "run_command";

    if (isBash && toolResponse !== null && toolResponse !== undefined) {
        if (typeof toolResponse === "object") {
            const codeRaw = toolResponse.exitCode ?? toolResponse.exit_code ?? toolResponse.returncode;
            if (typeof codeRaw === "number") result.exit_code = codeRaw;
            const interrupted = toolResponse.interrupted === true;
            if (interrupted) result.tool_outcome = "interrupted";
            const failed = result.tool_outcome !== "success" || (typeof codeRaw === "number" && codeRaw !== 0);
            if (failed) {
                if (result.tool_outcome === "success") result.tool_outcome = "error";
                const respStderr = toolResponse.stderr;
                const respStdout = toolResponse.stdout;
                if (respStderr) result.stderr = middleTruncateBytes(respStderr, cap);
                if (respStdout) result.stdout = middleTruncateBytes(respStdout, Math.floor(cap / 2));
            }
        } else if (typeof toolResponse === "string" && result.tool_outcome === "error") {
            // Bash variants that stringify combined output — capture as stderr.
            result.stderr = middleTruncateBytes(toolResponse, cap);
        }
    } else if (result.tool_outcome === "error") {
        // Non-Bash failure: errorDetail OR the response string is the diagnostic.
        let msg = "";
        if (errorDetail !== null && errorDetail !== undefined) {
            msg = typeof errorDetail === "string" ? errorDetail : JSON.stringify(errorDetail);
        } else if (typeof toolResponse === "string") {
            msg = toolResponse;
        } else if (toolResponse) {
            msg = JSON.stringify(toolResponse);
        }
        if (msg) result.stderr = middleTruncateBytes(msg, cap);
    }
    if (result.exit_code === null && typeof errorDetail === "string") {
        // Claude Code's PostToolUseFailure states a failed Bash call's code on
        // the FIRST line of its error text ("Exit code 3"). Mirrors
        // exitCodeFromErrorText in src/harness/outcome-evidence.ts.
        const codeLine = /^Exit code (-?\\d+)[ \\t]*(?:\\r?\\n|$)/.exec(errorDetail);
        if (codeLine) result.exit_code = Number(codeLine[1]);
    }
    if (result.tool_outcome === "error") {
        // Canonical diagnostic text. Channels 2/3/6 classify on this.
        const providerMsg = extractProviderErrorMessage(toolResponse, errorDetail);
        if (providerMsg) {
            result.error_message = middleTruncateBytes(providerMsg, cap);
        } else if (result.stderr) {
            result.error_message = result.stderr;
        }
    }
    return result;
}

// Attach canonical outcome fields onto a PostToolUse / PostToolUseFailure
// result record. Mutates and returns the record so per-event handlers can
// chain it after attachEditMetrics. Always sets tool_outcome; the optional
// fields are skipped when null so the on-disk row stays compact.
function attachOutcome(result, toolName, toolResponse, errorDetail) {
    const out = deriveToolOutcome(
        toolName,
        toolResponse,
        errorDetail,
        result.status,
        result.is_interrupt === true,
    );
    result.tool_outcome = out.tool_outcome;
    if (out.exit_code !== null) result.exit_code = out.exit_code;
    if (out.stderr) result.stderr = out.stderr;
    if (out.stdout) result.stdout = out.stdout;
    if (out.tool_response_sha256) result.tool_response_sha256 = out.tool_response_sha256;
    // deriveToolOutcome computes the canonical diagnostic text — carry it
    // through. This assignment used to be missing, so error_message was
    // computed and dropped: harnessEvent.error_message + the failure-recovery
    // channels always saw null.
    if (out.error_message) result.error_message = out.error_message;
    // Coarse failure category. attachOutcome is the single path every
    // client's folded failures pass through (Claude/Codex/Gemini/Copilot
    // deliver tool failures on the regular PostToolUse event), so
    // categorizing here covers all of them with no per-normalizer code.
    if (out.tool_outcome !== "success") {
        result.error_category = classifyErrorText(
            out.error_message || (typeof errorDetail === "string" ? errorDetail : ""),
            out.tool_outcome === "interrupted",
        );
    }
    return result;
}

// Step 1b — sniff whether a Write created a new file vs updated an existing
// one. Claude Code emits distinct response strings: "File created successfully"
// for creates, "has been updated" for updates. For Edit/MultiEdit we always
// return false (can't edit what doesn't exist).
function sniffIsNewFile(toolName, toolResponse) {
    if (toolName !== "Write" && toolName !== "create_file") return false;
    if (!toolResponse) return false;
    const text = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
    if (/file created successfully/i.test(text)) return true;
    if (/has been updated/i.test(text)) return false;
    return false;
}

// Attach loc + is_new_file + is_test_file onto a PostToolUse result object
// when the event is a file-editing tool. Helper so the switch cases stay
// narrow. Mutates and returns the passed object.
function attachEditMetrics(result, toolName, toolInput, toolResponse) {
    const loc = computeLocDelta(toolName, toolInput);
    if (loc) {
        result.lines_added = loc.added;
        result.lines_removed = loc.removed;
        result.net_loc_delta = loc.added - loc.removed;
        result.hunks_count = loc.hunks;
    }
    const sha = fingerprintWrite(toolName, toolInput);
    if (sha) result.content_sha256 = sha;
    result.is_new_file = sniffIsNewFile(toolName, toolResponse);
    const fp = toolInput && (toolInput.file_path || toolInput.path || toolInput.target_file);
    if (typeof fp === "string") {
        result.is_test_file = /(?:^|[\\/.])(?:__tests?__|tests?|spec)(?:[\\/.]|$)|\\.(?:test|spec)\\./i.test(fp);
    }
    return result;
}

// Pull token usage out of a Claude / Codex Stop or SubagentStop event.
// Either input.usage or input.token_usage is set. Returns null if no
// recognised fields are present so callers can skip the property.
function extractClaudeTokens(input) {
    const u = input.usage || input.token_usage;
    if (!u) return null;
    const tokens = {};
    if (u.input_tokens) tokens.input = u.input_tokens;
    if (u.output_tokens) tokens.output = u.output_tokens;
    if (u.cache_read_input_tokens) tokens.cache_read = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens) tokens.cache_creation = u.cache_creation_input_tokens;
    if (u.thinking_tokens || u.reasoning_tokens) tokens.thinking = u.thinking_tokens || u.reasoning_tokens;
    return Object.keys(tokens).length > 0 ? tokens : null;
}

// Build the per-event context once so each handler can pluck the fields it
// needs without re-running the same input parsing. \`tokens\` and \`duration_ms\`
// are pre-computed because half the handlers need them.
function buildClaudeContext(input) {
    return {
        input,
        env: envelopeFieldsClaude(input),
        tokens: extractClaudeTokens(input),
        duration_ms: input.duration_ms || input.durationMs || null,
    };
}

// Per-event handlers. Each takes the shared context and returns the
// canonical event record. Adding a new Claude / Codex event = add one
// handler + one entry in CLAUDE_DISPATCH below.
const CLAUDE_DISPATCH = {
    SessionStart: ({ input, env }) => ({
        event_type: "session_start", tool_name: null, tool_input_summary: null,
        hook_event: "SessionStart",
        source: input.source || null, model: input.model || null, agent_type: input.agent_type || null,
        cli_version: input.cli_version || input.claude_code_version || null,
        available_tools_count: Array.isArray(input.available_tools) ? input.available_tools.length : null,
        ...env,
    }),
    SessionEnd: ({ input, env, tokens, duration_ms }) => ({
        event_type: "session_end", tool_name: null, tool_input_summary: null,
        hook_event: "SessionEnd", tokens,
        reason: input.reason || null, duration_ms, ...env,
    }),
	Interrupt: ({ input, env }) => ({
		event_type: "interrupt", tool_name: null, tool_input_summary: null,
		hook_event: "Interrupt", model: input.model || null,
		permission_mode: input.permission_mode || null,
		...env,
	}),
    Stop: ({ input, env, tokens }) => ({
        event_type: "agent_stop", tool_name: null, tool_input_summary: null,
        hook_event: "Stop", tokens,
        stop_hook_active: input.stop_hook_active || false,
        stop_reason: input.stop_reason || null,
        last_assistant_message: input.last_assistant_message || null,
        ...env,
    }),
    UserPromptSubmit: ({ input, env }) => {
        const prompt = input.prompt || input.user_prompt || "";
        return {
            event_type: "user_prompt", tool_name: null, tool_input_summary: truncate(prompt, 200),
            hook_event: "UserPromptSubmit",
            prompt: prompt || null,
            prompt_chars: prompt ? prompt.length : 0,
            ...env,
        };
    },
    PreToolUse: ({ input, env }) => {
        const toolInput = input.tool_input || {};
        return {
            event_type: "tool_use_start", tool_name: input.tool_name || null,
            tool_input_summary: summarize(input.tool_name, toolInput),
            hook_event: "PreToolUse",
            tool_input: toolInput, tool_use_id: input.tool_use_id || null,
            tool_input_bytes: Buffer.byteLength(JSON.stringify(toolInput)),
            ...env,
        };
    },
    PostToolUse: ({ input, env, duration_ms }) => {
        const toolName = input.tool_name || null;
        const toolInput = input.tool_input || {};
        const toolResponseRaw = input.tool_response || null;
        const toolResponseBytes = toolResponseRaw === null ? 0
            : typeof toolResponseRaw === "string" ? Buffer.byteLength(toolResponseRaw)
            : Buffer.byteLength(JSON.stringify(toolResponseRaw));
        const toolResponse = capToolResponse(toolResponseRaw);
        // Folded failures: Codex (and older Claude Code) deliver tool failures
        // on the regular PostToolUse event with tool_response.is_error === true.
        // Claude Code 2.1.325 delivers a failed Bash call ONLY as
        // PostToolUseFailure (handled below; subscribed since 2026-11-16). The
        // daemon drops a second completion of one tool_use_id. Channels 2/3/5/6
        // depend on this gate firing — treating these as success would silently
        // drop every folded failure from the recovery pipeline.
        const isError = toolResponseRaw && typeof toolResponseRaw === "object"
            && toolResponseRaw.is_error === true;
        const result = {
            event_type: "tool_use", tool_name: toolName, tool_input_summary: summarize(toolName, toolInput),
            hook_event: "PostToolUse", duration_ms,
            tool_input: toolInput, tool_response: toolResponse, tool_use_id: input.tool_use_id || null,
            tool_output_bytes: toolResponseBytes,
            status: isError ? "error" : "success",
            ...env,
        };
        const filePath = extractFilePath(toolName, toolInput);
        if (filePath) result.files_modified = [filePath];
        attachEditMetrics(result, toolName, toolInput, toolResponseRaw);
        attachOutcome(result, toolName, toolResponseRaw, null);
        if (input.parent_tool_use_id) result.parent_tool_use_id = input.parent_tool_use_id;
        return result;
    },
    PostToolUseFailure: ({ input, env, duration_ms }) => {
        const failToolName = input.tool_name || null;
        const failInput = input.tool_input || {};
        const errorDetail = input.error || input.tool_error || input.message || null;
        const summary = errorDetail
            ? truncate(String(errorDetail), 200)
            : summarize(failToolName, failInput);
        const result = {
            event_type: "tool_use_error", tool_name: failToolName, tool_input_summary: summary,
            hook_event: "PostToolUseFailure", duration_ms,
            tool_input: failInput, error: errorDetail, is_interrupt: input.is_interrupt || false,
            tool_use_id: input.tool_use_id || null,
            status: "error",
            ...env,
        };
        // attachOutcome sets tool_outcome / error_message / error_category /
        // stderr / tool_response_sha256 — one path for every client.
        attachOutcome(result, failToolName, input.tool_response || null, errorDetail);
        if (input.parent_tool_use_id) result.parent_tool_use_id = input.parent_tool_use_id;
        return result;
    },
    SubagentStart: ({ input, env }) => ({
        event_type: "subagent_start", tool_name: input.agent_type || null,
        tool_input_summary: null, hook_event: "SubagentStart",
        parent_agent: input.parent_agent_name || null, subagent_id: input.agent_id || null,
        agent_type: input.agent_type || null,
        agent_transcript_path: input.agent_transcript_path || null,
        ...env,
    }),
    SubagentStop: ({ input, env, tokens, duration_ms }) => ({
        event_type: "subagent_stop", tool_name: input.agent_type || null,
        tool_input_summary: null, hook_event: "SubagentStop",
        parent_agent: input.parent_agent_name || null, subagent_id: input.agent_id || null,
        tokens, agent_type: input.agent_type || null,
        agent_transcript_path: input.agent_transcript_path || null,
        last_assistant_message: input.last_assistant_message || null,
        duration_ms,
        ...env,
    }),
    Notification: ({ input, env }) => ({
        event_type: "notification", tool_name: null,
        tool_input_summary: truncate(input.message || "", 200),
        hook_event: "Notification",
        notification_type: input.notification_type || null,
        notification_title: input.title || null,
        notification_message: input.message || null,
        ...env,
    }),
    PreCompact: ({ input, env }) => ({
        event_type: "context_compact", tool_name: null, tool_input_summary: null,
        hook_event: "PreCompact",
        trigger: input.trigger || null, custom_instructions: input.custom_instructions || null,
        context_size_hint: input.context_size || input.token_count || null,
        ...env,
    }),
    PostCompact: ({ input, env }) => ({
        event_type: "context_compacted", tool_name: null, tool_input_summary: null,
        hook_event: "PostCompact",
        trigger: input.trigger || null,
        context_size_hint: input.context_size || input.token_count || null,
        ...env,
    }),
    TaskCompleted: ({ input, env }) => ({
        event_type: "task_completed", tool_name: null,
        tool_input_summary: truncate(input.task_subject || input.task_id || "", 200),
        hook_event: "TaskCompleted",
        task_id: input.task_id || null, task_subject: input.task_subject || null,
        task_description: input.task_description || null,
        teammate_name: input.teammate_name || null, team_name: input.team_name || null,
        ...env,
    }),
    TeammateIdle: ({ input, env }) => ({
        event_type: "teammate_idle", tool_name: input.teammate_name || null,
        tool_input_summary: null, hook_event: "TeammateIdle",
        teammate_name: input.teammate_name || null, team_name: input.team_name || null,
        ...env,
    }),
	PermissionRequest: ({ input, env }) => {
        const permToolName = input.tool_name || null;
        const permToolInput = input.tool_input || {};
        return {
            event_type: "permission_request", tool_name: permToolName,
            tool_input_summary: summarize(permToolName, permToolInput),
            hook_event: "PermissionRequest",
            tool_input: permToolInput,
            permission_suggestions: input.permission_suggestions || null,
            permission_mode: input.permission_mode || null,
            ...env,
		};
	},
	WorktreeCreate: ({ input, env }) => ({
		event_type: "worktree_create", tool_name: null,
		tool_input_summary: truncate(input.name || "", 200),
		hook_event: "WorktreeCreate", worktree_name: input.name || null,
		...env,
	}),
};

function normalizeClaudeUnknown(hookEvent, ctx) {
    const { input, env } = ctx;
    return {
        event_type: hookEvent ? hookEvent.toLowerCase() : "unknown",
        tool_name: input.tool_name || null,
        tool_input_summary: summarize(input.tool_name, input.tool_input || {}),
        hook_event: hookEvent,
        tool_input: input.tool_input || null,
        ...env,
    };
}

function normalizeClaudeEvent(input) {
    const hookEvent = input.hook_event_name || "unknown";
    const ctx = buildClaudeContext(input);
    const handler = CLAUDE_DISPATCH[hookEvent];
    return handler ? handler(ctx) : normalizeClaudeUnknown(hookEvent, ctx);
}

// Codex CLI shipped its hook contract using Claude Code's envelope shape:
// PascalCase event names (PreToolUse, PostToolUse, PermissionRequest, ...)
// and mostly overlapping stdin fields. We delegate to the Claude
// normalizer rather than maintain a parallel switch — both clients map to
// the same canonical record. Two small Codex-specific touches:
//   - tag with client_runner so provider-responses can format decisions
//     in Codex's expected shape (PermissionRequest in particular)
//   - propagate Codex's turn_id field, which Claude doesn't emit
function normalizeCodexEvent(input) {
    const result = normalizeClaudeEvent(input);
    result.client_runner = "codex";
    if (input.turn_id) result.turn_id = input.turn_id;
    return result;
}

`;
