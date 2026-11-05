# Kill-proof hook surfaces — adapter channel matrix (2026-11-04)

Question: does the kill-proof correction reach the **model** on each runner?

- PostToolUse nudge: `[interlinked:kill-proof] …` from `evaluator/post-tool-kill-proof.ts`,
  appended to `HarnessDecision.warnings` via `collectPostWriteFileWarnings`
  (`evaluator/post-tool.ts:119`).
- Stop warning: `[interlinked:mutation-kill-evidence] …`, an advisory (allow) Stop warning.

Evidence file: `src/harness/adapters/kill-proof-nudge-encoding.test.ts` (labels `P<n>` = lands in a
stdout JSON field the runner documents as model context, `N<n>` = stderr on exit 0 only).

| Runner | PostToolUse nudge channel | Model-visible? | Stop warning channel | Model-visible? | Evidence level |
|---|---|---|---|---|---|
| Claude Code | stdout `hookSpecificOutput.additionalContext` (+ stderr copy) — P1 | yes (encoded) | stderr, exit 0 — N4 | no | unit-encoded |
| Codex | stdout `hookSpecificOutput.additionalContext` — P2 | yes (encoded) | stderr, exit 0 — N5 | no | unit-encoded |
| Factory Droid | stdout `hookSpecificOutput.additionalContext` (+ stderr copy) — P7 (was N1) | yes (encoded) | stderr, exit 0 — N6, N10 (SubagentStop) | no | unit-encoded; declared, not runtime-verified (experimental) |
| Copilot CLI | stdout top-level `additionalContext` (+ stderr copy) — P8 (was N2) | yes (encoded) | stderr, exit 0 — N7, N11 (subagentStop) | no | unit-encoded |
| Gemini CLI | stdout `hookSpecificOutput.additionalContext` (+ stderr copy) — P9 (was N3) | yes (encoded) | stderr, exit 0 — N8, N12 (AfterAgent keeps `additional_context`, never the warning) | no | unit-encoded |

No row is `runtime-verified`: the e2e lane (`src/e2e/fixture.ts`) drives only the Claude Code entry
(`--runner claude-code`, `INTERLINKED_CLIENT=claude`) and its assertions read `stdout + stderr`
concatenated (e.g. `post-tool-reminders.e2e.test.ts:24`), so no e2e test distinguishes the channel,
and no e2e test exercises the kill-proof nudge. No real runner binary is ever executed;
`hook-support-catalog.json` records `runtime_verified: false` for all four catalogued runners.

## Factory / Copilot / Gemini: warnings now reach the context field (2026-11-05)

Before 2026-11-05 these three encoders routed only `additional_context` to the context field and
`warnings` to stderr, so every PostToolUse warning was hidden from the model. They now share
`postToolContextText` (`provider-decisions.ts`): on a `post-tool` event whose declared controls
include `context`, the context payload is `[additional_context, warnings.join("\n")]` joined by
newline — the same rule as Codex's `feedbackText`. The stderr copy is kept. Stop, SubagentStop and
PreToolUse encoding is unchanged (N6–N8, N10–N12). No runner declares a size limit for the context
field in this codebase, so nothing is truncated. P10–P12 pin the join order; P3–P5 still pin
`additional_context` alone.

## Capability table

`provider-capabilities.ts` declared `modelContext: true` for `Stop` on Claude Code and Codex while
neither encoder uses a context channel at an advisory Stop and the catalog lists only `continue`
for both. Fixed (two identical lines, one per runner) and pinned by N9; PostToolUse's
`model_context: true` is pinned as backed by a catalog `context` control (P6), now for all five
runners (Copilot `postToolUse` and Gemini `AfterTool` gained `modelContext: true` with this change).

Still over-claiming, not changed: `SubagentStop` on Claude Code and Codex (`modelContext: true`,
catalog `continue` only; the encoders share the Stop path).
