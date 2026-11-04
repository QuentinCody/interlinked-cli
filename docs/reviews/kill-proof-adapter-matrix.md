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
| Factory Droid | stdout `{}`; text on stderr only — N1 | **no** | stderr, exit 0 — N6 | no | unit-encoded; declared, not runtime-verified (experimental) |
| Copilot CLI | no stdout; text on stderr only — N2 | **no** | stderr, exit 0 — N7 | no | unit-encoded |
| Gemini CLI | stdout `{}`; text on stderr only — N3 | **no** | stderr, exit 0 — N8 | no | unit-encoded |

No row is `runtime-verified`: the e2e lane (`src/e2e/fixture.ts`) drives only the Claude Code entry
(`--runner claude-code`, `INTERLINKED_CLIENT=claude`) and its assertions read `stdout + stderr`
concatenated (e.g. `post-tool-reminders.e2e.test.ts:24`), so no e2e test distinguishes the channel,
and no e2e test exercises the kill-proof nudge. No real runner binary is ever executed;
`hook-support-catalog.json` records `runtime_verified: false` for all four catalogued runners.

## Why Factory / Copilot / Gemini drop the nudge

Their encoders route only `additional_context` to the context field; `warnings` go to stderr:

- Factory: `additional-client-decisions.ts:20-23` (`factoryDecision` reads `decision.additional_context`).
- Copilot: `provider-decisions.ts:40-48` (`body.additionalContext = decision.additional_context`; warnings → stderr).
- Gemini: `provider-decisions.ts:64-72` (same shape).

The contrast cases P3–P5 show the same text carried as `additional_context` DOES reach each runner's
context field. So the gap is the warnings→context mapping, not the native protocol: the catalog
lists `context` for Copilot `postToolUse` and Gemini `AfterTool`. Changing that mapping is an encoder
behaviour change (it would put every PostToolUse warning in model context on three runners) and was
not made here — design decision for the owner.

## Capability table

`provider-capabilities.ts` declared `modelContext: true` for `Stop` on Claude Code and Codex while
neither encoder uses a context channel at an advisory Stop and the catalog lists only `continue`
for both. Fixed (two identical lines, one per runner) and pinned by N9; PostToolUse's
`model_context: true` is pinned as backed by a catalog `context` control (P6).

Still over-claiming, not changed: `SubagentStop` on Claude Code and Codex (`modelContext: true`,
catalog `continue` only; the encoders share the Stop path).
