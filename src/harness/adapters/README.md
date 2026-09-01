# Runner adapters

Each adapter normalizes native hook payloads from a coding-agent CLI into the
canonical `UnifiedHookEvent` shape (`cli/src/harness/unified-event.ts`). Adapters
also render installer settings fragments and translate `HarnessDecision` back
into the runner's stdout/stderr/exit-code contract.

**Key docs:**
- `docs/design/cli-hook-normalization.md` — per-runner quirks, decision table
- `docs/design/free-cli-architecture.md` — directory layout, installer manifest
- `docs/design/three-product-architecture.md` — latency budgets

## Runner matrix (as of 2026-08-30)

| Runner         | `id`           | Status       | Native events                                                                    | Decision contract                                  | Native ask | Post→model |
| -------------- | -------------- | ------------ | -------------------------------------------------------------------------------- | -------------------------------------------------- | ---------- | ---------- |
| Claude Code    | `claude-code`  | Supported    | 14 registered, including `PermissionRequest` and the `WorktreeCreate` hard stop; `PostToolUseFailure` parse-only | phase-specific native JSON (`PreToolUse.permissionDecision`; `PermissionRequest.decision.behavior`); WorktreeCreate exits non-zero without a path | ✅ | ✅ `additionalContext` outside PermissionRequest |
| Copilot CLI    | `copilot-cli`  | Experimental (payload drift vs current docs, e.g. `toolArgs`) | 6 events | stderr + exit 2 = deny; exit 0 = allow | ❌ → deny | ❌ stderr only |
| Cursor         | `cursor`       | Experimental (no provider-level contract test) | 18 events | snake_case decision/context responses | ✅ on shell/MCP gates | ✅ `additional_context` on `postToolUse` |
| Codex CLI      | `codex`        | Supported | Complete 12-event native surface | native hook JSON with permission/continuation envelopes | `PreToolUse` ask → deny; `PermissionRequest` uses native prompt | ✅ `additionalContext` |
| Gemini CLI     | `gemini-cli`   | Experimental | 9 events | stdout JSON (provisional) | 🚧 provisional | 🚧 provisional |
| OpenCode      | `opencode`     | Experimental managed plugin | 11 installed callbacks: generic tool/prompt/compaction plus session/permission bus observations | throw from `tool.execute.before` to deny | ❌ → deny | ✅ tool result/context mutation; bus events observe only |
| OpenCode v2 (`opencode2`) | `opencode2` | Experimental plugin | 5 plugin hooks: `tool.execute.before/after`, `session.created/deleted/idle` | socket JSON `{decision}`; in-process throw on block | ❌ → deny | ✅ append to tool output |
| Pi            | `pi`           | Experimental managed extension | 13 callbacks, including `tool_call`, `tool_result`, `input`, `user_bash`, lifecycle, and compaction | Pi extension return objects | ✅ `ctx.ui.confirm`; headless → deny | ✅ `tool_result` content + UI notification |

**Native ask** = runner has a user-confirm primitive (Claude `permissionDecision: "ask"`, Cursor `permission: "ask"` on `beforeShellExecution` / `beforeMCPExecution`, Pi `ctx.ui.confirm` when `ctx.hasUI`). When absent — including headless Pi and OpenCode's stable `tool.execute.before` — the harness collapses canonical `ask` to a hard deny so the user still sees the reason and can refine.

**Post→model** = a model-visible PostToolUse advisory channel exists. Claude uses `hookSpecificOutput.additionalContext`, Codex echoes `additionalContext`, **Cursor uses snake_case `additional_context` on `postToolUse`** (the generic post-tool hook — specific `afterFileEdit` / `afterShellExecution` / `afterMCPExecution` / `postToolUseFailure` are observation-only stderr). Copilot has no model-visible post channel.

**Cursor field naming**: response keys are snake_case per the public docs (`user_message`, `agent_message`, `additional_context`, `updated_input`, `updated_mcp_tool_output`, `followup_message`). Earlier camelCase emissions were silently dropped by Cursor — denial messages reached the runner empty.

**Managed-bridge boundary:** OpenCode and Pi install whole source files at
`.opencode/plugins/interlinked.ts` and `.pi/extensions/interlinked.js` (user scope:
`~/.config/opencode/plugins/interlinked.ts` and `~/.pi/agent/extensions/interlinked.js`). The
manifest hash protects foreign or subsequently modified files. Restart OpenCode after install;
Pi requires `/reload` or restart and a project-extension trust decision. OpenCode's stable surface
has no controllable permission/Stop hook and neither provider exposes dedicated native MCP,
subagent, or worktree lifecycle hooks. Pi uniquely gates direct `user_bash`; interactive ask uses
its UI and headless ask denies.

When a runner ships a 1.0 hook contract that differs from what is in this table,
update the adapter, stamp the file header with today's date, and re-run the
cross-runner equivalence tests in `index.test.ts`.

## Contract

All adapters conform to `RunnerAdapter` in `./types.ts`:

- `detectFromEnv(env)` — heuristic process-env check for auto-detection.
- `nativeEventNames` — the runner's own event names this adapter knows.
- `parseHookInput(nativeJson, nativeEventName)` — returns a `UnifiedHookEvent`.
  Must tolerate unknown fields; runners evolve their payload shapes.
- `classifyToolClass(toolName, toolInput)` — delegates to
  `tool-class-classifier.ts` plus user overrides from
  `.interlinked/tool-class-overrides.json`.
- `renderSettingsFragment(binaryPath, scope)` — produces a merge-safe settings
  fragment. Hook arrays are appended, never replaced.
- `encodeDecision(decision, event)` — translates to runner-specific output.

## Adding a new runner

1. Read the runner's hooks documentation at the time of implementation.
2. Stamp the adapter header comment with today's date.
3. Implement all six methods above.
4. Add the adapter to `buildAllAdapters()` in `index.ts`.
5. Update the matrix above.
6. Co-locate `{runner}.test.ts` covering parse, classify, encode, and the
   settings fragment.
7. Extend `index.test.ts` cross-runner equivalence tests to include the new
   runner.
