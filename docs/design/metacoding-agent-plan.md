# Metacoding Agent — Implementation Plan (v2)

**Status:** Proposed — v2 after follow-up reviewer pass. Awaiting reviewer signoff before implementation begins.
**Author:** Q. Cody, drafted via Claude Code session 2026-05-13. Revised same-session in response to reviewer findings.
**Scope:** v1 prototype for **Claude Code and Codex CLI only**. Cursor / Copilot / Gemini support deferred (see §9).

---

## Changes from v1

Reviewer flagged five issues in v1; all five are folded in. Two open
questions are now resolved. A follow-up v2 pass flagged six more plan
precision issues; those are folded in below as well.

| Change | Location | Origin |
|---|---|---|
| Scope narrowed to Claude Code + Codex only | Throughout | User scoping decision |
| Hook adapter path `defaultTimeoutForPhase` raises `user-prompt` to 35s; metacoder internal timeout remains 30s | §2.4, §3, §6 | Reviewer #1 (High) + v2 review #4 |
| Overlay rules constrained to `action: "block"` only; floor rules iterate before overlay | §2.3, §5 | Reviewer #2 (High) |
| Regex validation on every overlay regex (length cap, flag whitelist, try/catch, ReDoS shape reject) | §2.3, §5 | Reviewer #3 (High) |
| Codex adapter's `encodeCodexAllow` emits `hookSpecificOutput.additionalContext` for UserPromptSubmit (not stderr) | §3, §7 | Reviewer #4 (Medium) |
| Metacoder receives `scanResult.redacted` when the PII scanner finds content; otherwise receives `event.prompt` directly because no redaction was needed | §6 | Reviewer #5 (Medium) + v2 review #6 |
| Subprocess recursion guard via `INTERLINKED_METACODER_SUBPROCESS=1` env sentinel, carried through `UnifiedHookEvent` and `toLegacyHarnessEvent` | §2.5, §3 | Reviewer open Q2 + v2 review #2 |
| Codex `Stop` vs Claude `SessionEnd` / `Stop` cleanup parity documented and tested with correct phase names | §7, §8.2 | Reviewer open Q1 + v2 review #5 |
| Multi-prompt sessions explicitly replace prior overlays instead of merging | §1.1, §8.9 | v2 review #1 |
| Overlay v1 drops `extra_exceptions` / `additional_patterns`; exceptions use `negate: true` rule patterns | §2.3, §5, §6 | v2 review #3 |

---

## 1. Concept

On every `UserPromptSubmit` (i.e. every time the user sends a message to a
coding agent), a **metacoder** LLM call runs synchronously *before* the
coding agent's first tool call:

1. Reads the user's prompt (PII-scanner-redacted when the scanner finds
   content; otherwise unchanged, see §6)
2. Reads `AGENTS.md` / `CLAUDE.md` project instructions
3. Reads cached codebase context (existing project graph / structural
   cache maintained by the harness — no fresh research in v1)
4. Emits a **session-scoped overlay** that constrains the coding agent
   for the lifetime of that session:
   - `.interlinked/sessions/<session_id>/overlay-rules.json` — additional
     guard rules
   - `.interlinked/sessions/<session_id>/system-prompt.md` — appended to
     coding agent's context via hook stdout
5. The overlay is loaded by the harness **synchronously** so the very
   next `PreToolUse` from the coding agent already evaluates against the
   tighter ruleset.
6. On session end (`SessionEnd` for Claude, `Stop` for Codex), the
   overlay directory is evicted.

Net effect: hooks are **compiled output** of a per-prompt planner, not
hand-maintained source. The user's framing: "no one should have to *use*
hooks — they should be created and customized for each new prompt, by a
metacoding agent."

### 1.1 Multi-prompt sessions

`UserPromptSubmit` can fire multiple times inside one long-running agent
session. v1 uses **replace semantics**:

- Each `UserPromptSubmit` fully replaces the previous overlay for that
  `session_id` (rules and addendum). Overlays do not merge across prompts.
- `writeOverlayArtifacts` writes tmp files and renames them onto the same
  `.interlinked/sessions/<sid>/overlay-rules.json` and
  `system-prompt.md` paths, overwriting the previous prompt's artifacts
  atomically.
- `sessionRules.set(session_id, loadRules(cwd, session_id))` overwrites
  the prior in-memory rules entry. After prompt B, prompt A's overlay
  rules are no longer active.
- The new `system_prompt_addendum` is injected fresh on the new
  `UserPromptSubmit`. Prior addenda can remain in the coding agent's
  conversation history because the harness cannot delete already-injected
  model context. That is a known runner limitation; the authoritative
  enforced rules are always the latest overlay in `sessionRules`.

Regression test: prompt A emits a rule blocking `src/legacy/payments/`;
prompt B asks to fix `src/legacy/payments/migrate.ts` and emits a
different overlay. Assert A's rule no longer blocks after B's
`UserPromptSubmit`, and B's addendum is the one returned to the hook.

---

## 2. Decisions locked in

These are non-default choices the user has explicitly made. Reviewers
should push back on any of these that look wrong.

### 2.1 Metacoder model: same tier as the coding agent

- **Claude Code session** (`agent_source === "claude"`): use **Opus 4.7
  with maximum reasoning effort**. Invoked via the existing `claude -p`
  subprocess pattern (mirrors `policy-classifier.ts::callViaClaudeCode`).
  Reuses the user's existing Claude Code subscription — no separate API
  key required.
- **Codex session** (`agent_source === "codex"`): use **GPT-5.5 with
  `model_reasoning_effort: "xhigh"`** (user's framing: "x-high"; the
  CLI's actual config value is `xhigh`, one word — verified live).
  Invoked via the `codex exec` subprocess pattern, which uses the
  developer's existing Codex CLI subscription via `codex login`. **No
  OpenAI API key required.** Symmetric with the Claude path: both
  metacoder transports reuse the developer's existing CLI subscription
  rather than billing a separate API account.
- **Cursor / Copilot / Gemini sessions:** out of scope for v1. The
  metacoder is not invoked for those runners; the coding agent runs
  against floor rules only. See §9 for the rationale.

**Rationale (user):** "If the main coding agent is going to be
constrained by the metacoder's output, the metacoder shouldn't be a
dumber model that under-constrains." The metacoder is a peer of the
coding agent, not a cheap upstream filter.

**Latency cost:** Opus 4.7 max-effort + Codex high are 5–30s per prompt.
This is visible to the user as a delay between hitting Enter and the
coding agent starting work. **This is intentional** — the user's design
explicitly accepts the latency in exchange for per-prompt tailoring of
the harness.

**Cost cost:** Opus 4.7 max per prompt is in the range of $0.05–$0.30
depending on prompt length, system prompt size, and thinking budget.
For heavy users this can be hundreds of dollars per month. Out of scope
for v1: per-budget tracking / monthly caps. Document as a known cost.

### 2.2 Enforcement: hard-block

When an overlay rule matches a `PreToolUse`, the harness **blocks** the
tool call with the rule's reason, identically to how built-in floor
rules block. Overlay rules participate in the same evaluator pipeline;
the only distinction is the rule's `source` provenance.

**Rationale (user):** matches the design intent of "the harness should
constrain". Warn-only mode would let the coding agent route around
overlay rules just as it routes around AGENTS.md today, defeating the
purpose.

**Failure mode this creates:** if the metacoder emits a wrong-shaped
constraint, the coding agent gets stuck in a worse local optimum until
session end. v1 mitigates this only via the floor/overlay invariant
(below) — the agent can always reach the floor's allowed actions.

### 2.3 Floor / overlay invariant: tighten-only

- **Floor** = built-in rules (105) + `.interlinked/guard-rules.json`
  (team) + `.interlinked/guard-rules.local.json` (personal) + distilled
  rules from `/enforce`. Hand-authored, immutable per session.
- **Overlay** = metacoder-emitted, session-scoped. Can only **ADD**
  constraints to the floor. Never relaxes.

Concrete enforcement (in `overlay-loader.ts`):

| Loader behavior | Why |
|---|---|
| Reject any `disabled_rules` field in overlay | Disabling a floor rule = relaxing. |
| Reject any overlay rule whose `id` collides with a floor id | Replacing a floor rule = relaxing. |
| Require `id` prefix `overlay:<session>:` | Namespacing; prevents id squatting. |
| **Reject any rule whose `action` is not `"block"`** | Only `block` matches the "blocks exactly like floor rules" contract. `ask` / `soft_block` return early from the evaluator with weaker-than-block decisions (`pre-tool.ts:373, 395`); if iteration order put overlay first, the overlay would *relax* the effective decision. `rewrite` mutates input — too powerful for an LLM-emitted rule. `warn` doesn't return early but is informational, not constraining. |
| **Append overlay rules AFTER floor rules in the merged list** | Belt-and-suspenders so floor `block` always iterates before any overlay rule that matches the same input. With both the action constraint above and append-after, an overlay rule can only fire when no floor rule matched first. |
| Reject top-level `extra_exceptions` and `additional_patterns` fields entirely | These fields are not part of overlay v1. `extra_exceptions` is command-substring-only in the current matcher and would be misleading for file-path rules; `additional_patterns` is not a current `GuardRulesConfig` field. Overlay exceptions must be expressed as `negate: true` patterns inside the overlay rule itself. |
| Cap rule count (≤20 per overlay) | Defensive against a runaway LLM emitting 200 rules. |

Rejected fields/rules are dropped with a `[interlinked:overlay]` stderr
warning. The rest of the overlay still loads. This is the same
fail-soft pattern used elsewhere in the loader.

**Regex validation (overlay-only).** Floor rules are admin-authored and
trusted; `rule-matching.ts::getCachedRegex` does not validate input
because the existing rule corpus is hand-curated (explicit comment at
`rule-matching.ts:53–57`). LLM-emitted regexes break that assumption.
The overlay loader runs these checks at load time on every regex in
`patterns[].regex` and `active_when.file_scope`, and drops any rule
that fails:

| Check | Reason |
|---|---|
| `pattern.length ≤ 200` chars | Bounds compilation time and complexity. |
| `rule.patterns.length ≤ 10` | Bounds per-rule evaluation cost. |
| `flags ∈ {"i", "m", "s", ""}` only | Reject `g`, `y` (stateful, break shared cache), `u` (Unicode rules) for predictable matching. |
| Wrap `new RegExp(pattern, flags)` in try/catch | Invalid regex throws on every PreToolUse otherwise; drop the rule with a warning. |
| Reject patterns containing nested unbounded quantifiers (`(a+)+`, `(a*)*`, `(a|a)*`) | Catastrophic backtracking (ReDoS) risk. Cheap structural check: `/\([^)]*[+*][^)]*\)[+*]/` catches the common cases. Not exhaustive — see §10 risk #9 — but sufficient for v1. |

### 2.4 Synchronous before first tool call

The metacoder is awaited inside the harness's `UserPromptSubmit`
handler. The hook script's socket call blocks until the handler returns.
By the time the coding agent's runtime resumes and issues its first tool
call, the overlay is already in the harness's in-memory per-session
rule cache.

Implication: the harness does NOT rely on the 2-second `fs.watchFile`
polling path for per-session overlays. Polling is fine for floor rule
edits (team/local files); for session overlays we use in-memory.

**Hook timeout amendment.** The adapter path at
`src/hook-entry.ts:30` defines `DEFAULT_HOOK_TIMEOUT_MS = 2000` and
`defaultTimeoutForPhase` at L215 returns it for every phase except
`pre-tool`. A 30s metacoder would be killed at 2s, fall through to
cold fallback, and never write the overlay. The plan adds a
`user-prompt` phase branch:

```ts
const DEFAULT_USER_PROMPT_TIMEOUT_MS = 35_000;

function defaultTimeoutForPhase(event: UnifiedHookEvent): number {
  if (event.phase === PHASE_PRE_TOOL) return DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS;
  if (event.phase === PHASE_USER_PROMPT) return DEFAULT_USER_PROMPT_TIMEOUT_MS;
  return DEFAULT_HOOK_TIMEOUT_MS;
}
```

The metacoder's internal timeout remains 30s. The hook timeout is 35s so
the harness has a 5s buffer to convert a clean metacoder timeout into an
`allow` decision instead of racing the hook's own timeout and producing a
spurious cold fallback. The legacy `.mjs` script has its own per-phase
timeouts; align it to the same 35s user-prompt hook budget.

### 2.5 Subprocess recursion guard (new in v2)

The metacoder spawns `claude -p` to call Opus 4.7. The subprocess
inherits the user's `.claude/settings.json` hooks → its first prompt
fires `UserPromptSubmit` → harness sees it → metacoder fires recursively
→ infinite loop.

The existing `policy-classifier.ts::callViaClaudeCode` does not address
this because it runs on `PreToolUse`, not `UserPromptSubmit`. v1
introduces a sentinel env var:

- `metacoder-client.ts` sets `INTERLINKED_METACODER_SUBPROCESS=1` on
  the spawned subprocess env, alongside the existing
  `--disallowed-tools`, `--no-session-persistence`, etc.
- The hook script (both `hook-entry.ts` and the legacy `.mjs`) reads
  this env at startup and, when set, forwards
  `metacoder_subprocess: true` on the event envelope sent to the
  harness socket.
- For the adapter path, `metacoder_subprocess?: boolean` is added to
  `UnifiedHookEvent`; `hook-entry.ts` sets it before sending the RPC, and
  `legacy-client.ts::toLegacyHarnessEvent` explicitly copies it through
  to `HarnessEvent`. Without the `legacy-client.ts` copy, the framed
  adapter path strips the sentinel before `server.ts` can see it.
- The harness's `UserPromptSubmit` branch short-circuits when set:
  returns `{ decision: "allow" }` immediately, no metacoder call.

This breaks the recursion at the earliest deterministic point. The same
env also short-circuits the activity-jsonl write (we don't need to log
the metacoder's own prompts as user activity).

**Trust note:** the env var is set by the harness's own subprocess
spawn, not by the agent. An agent that controls its own env (rare) or
a compromised hook script could forge it, suppressing metacoder
evaluation. See §10 risk #8.

---

## 3. File-by-file change list

### New files

| Path | Purpose |
|---|---|
| `src/harness/metacoder/types.ts` | `OverlayRulesFile`, `MetacoderInputContext`, `MetacoderOutcome`, `MetacoderConfig` types |
| `src/harness/metacoder/overlay-loader.ts` | Read overlay JSON, enforce tighten-only invariant (including action-block-only and regex validation), return validated rules + warnings |
| `src/harness/metacoder/regex-validator.ts` | The five checks from §2.3 as pure functions. Used by overlay-loader; testable in isolation. |
| `src/harness/metacoder/prompt-builder.ts` | Assemble `MetacoderInputContext` from `promptForMeta` (scanner-redacted when findings exist, see §6) + AGENTS.md/CLAUDE.md + floor rule ids + project graph summary. Caps total at ~20kB. |
| `src/harness/metacoder/metacoder-client.ts` | LLM call. Routes by `agent_source`. Claude → `claude -p` subprocess (Opus 4.7, high effort) with `INTERLINKED_METACODER_SUBPROCESS=1` env. Codex → OpenAI HTTP (GPT-5.5, high reasoning). Fail-open on all error modes. |
| `src/harness/metacoder/metacoder-writer.ts` | tmp-then-rename atomic writes to `.interlinked/sessions/<sid>/`. Writes to stable per-session paths so each prompt overwrites the prior overlay artifacts atomically. Uses existing `sanitizeSessionId`. |
| `src/harness/metacoder/index.ts` | Barrel exporting `runMetacoderForPrompt(event, config, cwd, promptForMeta)` — single entry point called from `server.ts`. |
| `src/harness/__tests__/metacoder-overlay.test.ts` | Floor invariant + regex validation tests (see §8.1) |
| `src/harness/__tests__/metacoder-session-lifecycle.test.ts` | Claude `SessionEnd`, Claude `Stop`, and Codex `Stop` all evict overlay |
| `src/harness/__tests__/metacoder-multiprompt.test.ts` | Prompt B replaces prompt A overlay and returns B's addendum |
| `src/harness/__tests__/metacoder-multiclient.test.ts` | Claude + Codex envelopes both produce identical `MetacoderInputContext` |
| `src/harness/__tests__/metacoder-failure.test.ts` | Mocked client throws → fall back to floor; malformed JSON → no overlay merged; missing API key → skipped; recursion guard short-circuits |
| `src/harness/__tests__/metacoder-privacy.test.ts` | Redacted prompt is passed to metacoder when scanner fires |

### Modified files

| Path | Change |
|---|---|
| `src/harness/rules-loader.ts` | Extend `loadRules(cwd, sessionId?)` to optionally merge the current per-session overlay rules. Overlay rules appended AFTER floor in merged list. Existing call sites (no `sessionId`) unchanged. |
| `src/harness/server.ts` | (a) UserPromptSubmit handler at L903: short-circuit if `event.metacoder_subprocess === true`; otherwise after existing PII scan, await `runMetacoderForPrompt(event, config, CWD, promptForMeta)`, populate per-session rule cache, return `allow + additional_context`. (b) Add `sessionRules: Map<string, GuardRulesConfig>` near L313 alongside existing `classifierSessions` / `autoCoordStates`. (c) In `SessionEnd` / `Stop` handler at L755: call `evictOverlayForSession(CWD, event.session_id)` and `sessionRules.delete(event.session_id)`. (d) Route evaluator calls to use `rulesForSession(session_id)` instead of global `rules` for PreToolUse. (e) Build `promptForMeta = scanResult ? scanResult.redacted : event.prompt`, so scanner-flagged raw spans do not leave the process. |
| `src/harness/types.ts` | Add `metacoder?: MetacoderConfig` to `GuardRulesConfig`. Add `metacoder_subprocess?: boolean` to `HarnessEvent`. |
| `src/harness/unified-event.ts` | Add `metacoder_subprocess?: boolean` to `UnifiedHookEvent` so the adapter path can carry the recursion sentinel through the framed RPC envelope. |
| `src/harness/legacy-client.ts` | In `toLegacyHarnessEvent`, copy `event.metacoder_subprocess === true` to `out.metacoder_subprocess = true`; otherwise the production framed path strips the sentinel before `server.ts`. |
| `src/hook-entry.ts` | (a) Add `PHASE_USER_PROMPT = "user-prompt"` constant and `DEFAULT_USER_PROMPT_TIMEOUT_MS = 35_000`. (b) Extend `defaultTimeoutForPhase` per §2.4. (c) Read `INTERLINKED_METACODER_SUBPROCESS` from `opts.env` and set `event.metacoder_subprocess = true` before sending the RPC when present. |
| `src/harness/adapters/codex.ts` | `encodeCodexAllow`: when `event.runner_native_event === "UserPromptSubmit"` and `decision.additional_context` is set, emit `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: decision.additional_context } }` on **stdout**, not stderr. Current behavior at L230–234 writes to stderr; change moves it to stdout's `hookSpecificOutput` channel to match Claude's contract (per `docs/hooks-ecosystem-comparison.md:81`). |
| `src/harness/adapters/claude-code.ts` | Verify `encodeDecision` emits `hookSpecificOutput.additionalContext` for UserPromptSubmit allow with a `decision.additional_context` field. If the current adapter doesn't already handle this, add the branch. (One-line check at implementation time.) |
| `src/lib/hook-template-chunks/provider-responses.ts` | Add `user_prompt_advice` response type to `formatClaudeResponse` and `formatCodexResponse` only. Drop Cursor/Copilot from this change set entirely. |
| `src/lib/hooks-template.ts` | In `UserPromptSubmit` branch of generated `.mjs`: (a) forward `INTERLINKED_METACODER_SUBPROCESS` env value to the harness socket payload. (b) After receiving harness decision, if `decision.additional_context` present, emit via `formatProviderResponse("user_prompt_advice", { summary: decision.additional_context })` to stdout. |

No new hook-installer work needed. `UserPromptSubmit` is already wired
for Claude Code and Codex per `hook-installers.ts:36–50` and
`adapters/codex.ts:51–58`.

---

## 4. Hook event flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│ User types prompt. Agent (Claude / Codex) fires UserPromptSubmit        │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Hook entry (src/hook-entry.ts):                                         │
│ 1. Detect adapter (Claude vs Codex) via env / runner arg                │
│ 2. Build UnifiedHookEvent via adapter.parseHookInput                    │
│ 3. Forward INTERLINKED_METACODER_SUBPROCESS env onto event (if set)     │
│ 4. Send RPC to daemon with timeout = 35s (user-prompt phase)            │
│ 5. AWAIT response (blocks agent's prompt processing)                    │
└─────────────────────────────────────────────────────────────────────────┘
                                  │ (Unix socket)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Harness server.ts UserPromptSubmit branch:                              │
│ 1. SHORT-CIRCUIT: if event.metacoder_subprocess → return allow now      │
│ 2. (Existing) PII scan → redacted_prompt for activity.jsonl             │
│ 3. (NEW) runMetacoderForPrompt(event, config, CWD, promptForMeta):      │
│    a. buildMetacoderContext(promptForMeta, AGENTS.md, floor ids, ...)   │
│       — promptForMeta = scanResult ? scanResult.redacted : event.prompt │
│    b. callMetacoder(ctx, config):                                       │
│       - Claude: spawn `claude -p` with                                  │
│         INTERLINKED_METACODER_SUBPROCESS=1 in env                       │
│       - Codex: OpenAI HTTP                                              │
│    c. validate JSON against OverlayRulesFile schema                     │
│    d. validate every regex (length, flags, try/catch, ReDoS shape)      │
│    e. reject rules with action !== "block"                              │
│    f. writeOverlayArtifacts(cwd, session_id, overlay)                   │
│    g. sessionRules.set(session_id, loadRules(cwd, session_id))          │
│       (overlay rules APPENDED after floor)                              │
│ 4. Return { decision: allow, redacted_prompt?, additional_context? }    │
│    where additional_context = overlay.system_prompt_addendum            │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Adapter encodes decision to provider-specific stdout JSON:              │
│ - Claude: hookSpecificOutput.additionalContext = system_prompt          │
│ - Codex:  hookSpecificOutput.additionalContext = system_prompt          │
│   (was stderr in current adapter — fixed in §3)                         │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Agent receives prompt + injected system_prompt_addendum in context.     │
│ Agent issues first PreToolUse.                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                  │ (Unix socket)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Harness PreToolUse evaluates against rulesForSession(session_id):       │
│   = floor rules ∪ overlay rules (in that order)                         │
│ Floor rules iterate first → floor block always wins over overlay        │
│ Overlay rules are action: "block" only → can't downgrade a decision     │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                       ... session continues ...
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Session end:                                                             │
│ - Claude fires SessionEnd and may also fire Stop; Codex fires Stop.     │
│   Phase names differ, but legacy event names reach the same server case.│
│ 1. (Existing) save trajectory, releaseAllForAgent, sessions.remove,     │
│    classifierSessions.delete, autoCoordStates.delete                    │
│ 2. (NEW) evictOverlayForSession(cwd, session_id) →                      │
│    rm -rf .interlinked/sessions/<sanitized-id>/                         │
│ 3. (NEW) sessionRules.delete(session_id)                                │
└─────────────────────────────────────────────────────────────────────────┘
```

Per-client envelope at `UserPromptSubmit`:

| Client | Native event | Prompt field | Adapter file |
|---|---|---|---|
| Claude Code | `UserPromptSubmit` | `prompt` | `src/harness/adapters/claude-code.ts` |
| Codex | `UserPromptSubmit` (same shape, optional `turn_id`) | `prompt` | `src/harness/adapters/codex.ts` |

---

## 5. Overlay schema

`.interlinked/sessions/<sanitized-session-id>/overlay-rules.json`:

```json
{
  "version": 1,
  "session_id": "abc123",
  "generated_at": "2026-05-13T14:00:00Z",
  "generated_by": "metacoder",
  "source_prompt_sha256": "deadbeef…",
  "system_prompt_addendum": "You are working on the payment-flow refactor. Touching src/legacy/payments is out of scope unless you call out the deviation first.",
  "rules": [
    {
      "id": "overlay:abc123:0",
      "enabled": true,
      "trigger": "PreToolUse",
      "tool_match": ["Edit", "Write", "MultiEdit"],
      "action": "block",
      "patterns": [
        { "field": "file_path", "regex": "src/legacy/payments/" },
        { "field": "file_path", "regex": "src/legacy/payments/migrate\\.ts", "negate": true }
      ],
      "reason": "Touching legacy/payments is out of scope for this session.",
      "severity": "high"
    }
  ]
}
```

Validation rules in `overlay-loader.ts` (executed in order):

1. Reject `disabled_rules` field entirely.
2. Reject any rule whose `id` collides with a floor id.
3. Reject rules whose `id` does not start with `overlay:<session-prefix>:`.
4. **Reject any rule whose `action` is not `"block"`.**
5. Reject top-level `extra_exceptions` and `additional_patterns` fields
   entirely. Overlay exceptions must use `negate: true` patterns inside
   the overlay rule.
6. Cap rule count at 20; drop excess with a warning.
7. For each surviving rule's regexes (in `patterns[].regex` and any
   `active_when.file_scope`): run the five-check regex validator from
   §2.3. Drop the rule on any failure.
8. **Append surviving overlay rules AFTER floor rules in the merged
   `rules.rules` array** so floor blocks always iterate before overlay
   rules for the same tool input.

### What "tighten-only" guarantees concretely

For any prompt P and tool call T:

> `Floor(T) == block` ⟹ `(Floor ∪ Overlay(P))(T) == block`

That is, the loaded ruleset after merging the overlay is a strict
superset of the floor *in terms of block coverage*. The action
constraint (rule 4) plus the iteration order (rule 8) together ensure
an overlay can never produce a strictly weaker decision than the floor
would have produced alone.

---

## 6. Metacoder LLM contract

### System prompt (constant, embedded in `metacoder-client.ts`)

```
You are a session-scoped policy author for an AI coding agent.

You receive: a user prompt (possibly with PII redacted as <LABEL>
placeholders), project AGENTS.md/CLAUDE.md guidance, current floor
rule ids, and a project graph summary.

You emit JSON matching the OverlayRulesFile schema. You may ONLY:
1. Add new GuardRule entries with unique ids prefixed "overlay:<session>:"
2. Use action: "block" on every rule (other actions are rejected by
   the loader)
3. Express exceptions using `negate: true` patterns inside your own rule's
   `patterns` array
4. Add a free-form system_prompt_addendum (≤2000 chars)

Regex patterns you emit must:
- Be ≤200 chars long
- Use only flags i, m, s (no g, y, u)
- Avoid nested unbounded quantifiers like (a+)+ or (a*)*

You MUST NOT:
- Reference, disable, or modify any floor rule id (provided in input)
- Author a rule with any action other than "block"
- Emit top-level extra_exceptions or additional_patterns fields
- Create rules that loosen anything

If the prompt warrants no extra constraints, return {"version":1,"rules":[]}.
Respond with JSON only, no preamble, no markdown fences.
```

### Input (with privacy amendment)

The user message embeds the **PII-scanner-redacted** version of the
prompt when the scanner finds content. If the scanner returns no
findings, `event.prompt` is passed directly because there is nothing to
redact:

```ts
const promptForMeta = scanResult ? scanResult.redacted : event.prompt;
```

The metacoder produces *constraints*, not edits — it doesn't need the
literal secret to reason about scope. We never send scanner-flagged raw
spans to the metacoder. Worst case the scanner missed a span; that's an
existing scanner gap (`docs/design/content-scanner-*`), not a new one
introduced by this feature.

Full input shape:

```json
{
  "prompt": "Refactor the payment service to use the <SECRET_TOKEN> charge API",
  "client": "claude",
  "session_id": "abc123",
  "cwd": "/Users/.../interlinked-cli",
  "project_instructions": "<concatenated AGENTS.md + CLAUDE.md, first 20kB>",
  "floor_rule_ids": ["block_rm_rf", "no_force_push", "..."],
  "project_graph_summary": "Project has 387 TS files across src/, tests/, ..."
}
```

### Output (strict JSON, no markdown)

`OverlayRulesFile` minus server-side fields. Server fills in
`session_id`, `generated_at`, `generated_by`, `source_prompt_sha256`.
Model emits:

```json
{
  "version": 1,
  "rules": [...],
  "system_prompt_addendum": "..."
}
```

### Error handling (all fail-open)

| Error mode | Handling |
|---|---|
| LLM call times out (30s) | Skip overlay, log to harness stderr, fall back to floor-only. UserPromptSubmit decision is `allow` with no `additional_context`. |
| LLM returns non-JSON | Try `parseClassificationJson` (already in `policy-classifier.ts`) to extract JSON from fences. If still fails, skip. |
| LLM returns malformed schema | Drop invalid rules; surviving rules merge; if zero survive, skip. |
| LLM tries to disable a floor rule | Drop the field with a `[interlinked:overlay]` warning, continue. |
| LLM emits invalid regex | Drop the rule with a warning, continue. |
| LLM emits rule with `action !== "block"` | Drop the rule with a warning, continue. |
| LLM emits top-level `extra_exceptions` or `additional_patterns` | Drop the unsupported field with a warning; exceptions belong in `negate: true` patterns. |
| API key missing (Codex path) | Return `{kind: "skipped", reason: "no_api_key"}`. Fall back to floor. |
| Subprocess `claude` not found | Return skipped; log once per daemon-startup. |
| Recursion guard fires (`INTERLINKED_METACODER_SUBPROCESS=1`) | Short-circuit BEFORE the metacoder is called; return allow immediately. |

**Invariant:** a broken metacoder must never wedge `UserPromptSubmit`.
The prompt always reaches the coding agent — just without overlay
constraints.

### Timeout budget

- Claude path (`claude -p`): 30s default.
- Codex path (OpenAI HTTP): 30s default.
- Hook adapter (`hook-entry.ts` `user-prompt` phase): 35s default,
  intentionally 5s longer than the metacoder's internal timeout so the
  harness can return its clean timeout/allow result before the hook falls
  back.

---

## 7. Cross-client compatibility report

Verified against `src/harness/adapters/codex.ts`, `adapters/codex.test.ts`,
`adapters/claude-code.ts`, and `hook-installers.ts`:

| Capability | Claude Code | Codex |
|---|---|---|
| UserPromptSubmit hook event | Native | Native (same name, same shape) |
| Envelope shape on UserPromptSubmit | `{session_id, prompt, ...}` | Same + optional `turn_id` |
| Session-end native events fired | `SessionEnd` and `Stop` | `Stop` only |
| Phase mapping | `SessionEnd` → `"session-end"`; `Stop` → `"stop"` | `Stop` → `"session-end"` |
| Server cleanup trigger | Joint `case "SessionEnd": case "Stop":` at `server.ts:755`; fires on either native name regardless of phase | Same joint server case |
| `additionalContext` injection channel | `hookSpecificOutput.additionalContext` on stdout | Same contract per `docs/hooks-ecosystem-comparison.md:81`, **but current `encodeCodexAllow` at adapters/codex.ts:230–234 writes to stderr — fixed in §3** |
| Disambiguation in `.mjs` runtime | `INTERLINKED_CLIENT=claude` | `INTERLINKED_CLIENT=codex` |
| Feature flag required | No | Yes (`.codex/config.toml` `[features] hooks = true`, auto-written by installer) |

**Session-end cleanup parity.** `src/harness/server.ts:755–897` handles
`case "SessionEnd": case "Stop":` jointly. Claude's adapter maps
`SessionEnd` to `"session-end"` and `Stop` to `"stop"`; Codex's adapter
maps `Stop` to `"session-end"`. The framed path converts back to legacy
event names before `server.ts`, so the cleanup trigger is the native
event name, not the phase. Tests must exercise Claude `SessionEnd`,
Claude `Stop`, and Codex `Stop` (§8.2).

**Cursor / Copilot / Gemini.** Out of scope for v1. See §9.

---

## 8. Test plan

All under `src/harness/__tests__/`. Tests use vitest with manual
fixtures (no fs mocking — matches existing style; see
`adapters/codex.test.ts` and `result.test.ts` for the pattern).

### 8.1 `metacoder-overlay.test.ts` — floor invariant + regex validation

Floor invariant:
- Overlay with valid `overlay:`-prefixed ids loads correctly.
- Overlay with `disabled_rules: ["block_rm_rf"]` → field dropped;
  `block_rm_rf` still active.
- Overlay with `rules: [{id: "block_rm_rf", ...}]` → rule dropped
  (id collision); original `block_rm_rf` intact.
- Overlay with top-level `extra_exceptions` → unsupported field dropped.
- Overlay with top-level `additional_patterns` → unsupported field
  dropped.
- Overlay with `rules: [{id: "no_namespace_prefix"}]` → dropped
  (missing `overlay:` prefix).
- Overlay rule with `action: "ask"` → dropped (action constraint).
- Overlay rule with `action: "warn"` → dropped.
- Overlay rule with `action: "soft_block"` → dropped.
- Overlay rule with `action: "rewrite"` → dropped.
- Cap test: overlay with 50 rules → 20 loaded, 30 dropped, warning.
- Iteration order: when merged, floor rules precede overlay rules in
  `rules.rules`.
- Negated overlay patterns work as exceptions inside the overlay rule
  itself (e.g., block `src/legacy/payments/` except
  `src/legacy/payments/migrate.ts`).

Regex validation:
- Overlay rule with regex `^(a+)+$` → dropped (ReDoS shape).
- Overlay rule with regex `(a*)*` → dropped.
- Overlay rule with regex 250 chars long → dropped (length cap).
- Overlay rule with regex flag `g` → dropped (flag whitelist).
- Overlay rule with regex flag `y` → dropped.
- Overlay rule with regex flag `u` → dropped.
- Overlay rule with syntactically invalid regex `[unclosed` → dropped
  (try/catch).
- Overlay with rule having 11 patterns → dropped (patterns/rule cap).

Property test (fast-check, if dependency is already available — else
straightforward enumeration): for any randomly generated overlay, the
loaded rule set is a strict superset of the floor in terms of block
coverage. Specifically: pick a tool call `T` that the floor blocks;
assert that the merged rule set also blocks `T`.

### 8.2 `metacoder-session-lifecycle.test.ts` — overlay eviction

- Write a fake overlay to `.interlinked/sessions/abc/overlay-rules.json`.
- Fire Claude `SessionEnd` for session `abc` → directory deleted,
  in-memory cache entry removed.
- Repeat with Claude `Stop` for session `xyz` → identical cleanup.
- Repeat with Codex `Stop` for session `codex-1` → identical cleanup.
- After cleanup: `loadRules(cwd, "abc")` returns floor-only.

### 8.3 `metacoder-multiclient.test.ts` — Claude + Codex envelopes

- Send Claude-shaped `UserPromptSubmit` (PascalCase, top-level `prompt`).
- Send Codex-shaped `UserPromptSubmit` (same shape + `turn_id`).
- Both produce identical `MetacoderInputContext.prompt`.

### 8.4 `metacoder-failure.test.ts` — fail-open + recursion guard

- Mock `callMetacoder` to throw → overlay artifacts not written;
  UserPromptSubmit still returns `allow`; next PreToolUse uses floor
  rules unchanged.
- Mock `callMetacoder` to return malformed JSON → no overlay merged.
- API key missing path → `{kind: "skipped"}`.
- Subprocess `claude` not found → returns skipped, logs once.
- **Recursion guard:** event with `metacoder_subprocess: true` →
  harness short-circuits without invoking metacoder; no overlay
  artifacts written; returns allow immediately.
- Adapter bridge: `hook-entry.ts` sets `UnifiedHookEvent.metacoder_subprocess`
  from env, and `legacy-client.ts::toLegacyHarnessEvent` preserves it on
  the legacy `HarnessEvent`.

### 8.5 `metacoder-privacy.test.ts` — redacted prompt as metacoder input

- Mock the PII scanner to return `redacted: "user prompt with <SECRET> masked"`.
- Assert the metacoder client receives the redacted version, NOT the raw
  scanner-flagged `event.prompt`.
- Mock the scanner to return null (no findings) → metacoder receives
  raw `event.prompt` because no scanner-flagged spans exist.

### 8.6 Adapter encoder tests (extend existing)

- `adapters/codex.test.ts`: `encodeCodexAllow` for UserPromptSubmit
  with `decision.additional_context` emits
  `hookSpecificOutput.hookEventName: "UserPromptSubmit", additionalContext: ...`
  on **stdout**, NOT stderr.
- `adapters/claude-code.test.ts`: same for Claude. If `claude-code.ts`
  already handles this, the test is a regression pin; otherwise a
  driver for the change.

### 8.7 Hook-entry timeout test

- Mock the daemon to take 30.2s to respond on `user-prompt` phase
  (simulating a metacoder timeout plus harness cleanup) → hook-entry
  waits, returns the clean harness decision (not cold fallback).
- Mock daemon to take 36s → hook-entry times out, falls through to
  cold fallback. Coding agent gets `allow` with no overlay (acceptable
  fail-open).

### 8.8 Integration via `evaluator.test.ts`

- Load a config with a session overlay.
- Assert a `PreToolUse` that would have been `allow` is now `block`
  because of the overlay rule.
- Assert a `PreToolUse` that the floor would have blocked is still
  blocked (floor preserved; overlay's mere presence didn't shadow it).

### 8.9 `metacoder-multiprompt.test.ts` — replace, not merge

- Prompt A emits an overlay that blocks `src/legacy/payments/`.
- Prompt B in the same `session_id` asks to fix
  `src/legacy/payments/migrate.ts` and emits a different overlay.
- Assert prompt A's overlay rule no longer blocks after prompt B's
  `UserPromptSubmit`.
- Assert prompt B's `system_prompt_addendum` is returned to the hook.

---

## 9. Out of scope for v1

Explicitly NOT in this plan. Reviewers please flag any of these that
seem load-bearing and should be pulled in.

1. **Fresh codebase research agent.** v1 reads the existing
   `.interlinked/structure-cache/` (maintained by the harness). No
   fresh crawling, no symbol indexes, no architectural summarization.
   If the cache is empty, the metacoder gets a stub project graph
   summary.
2. **Cursor / Copilot / Gemini metacoder integration.** Their adapters
   do not currently surface `additionalContext` on UserPromptSubmit in
   a model-visible channel:
   - Cursor's `beforeSubmitPrompt` would need adapter work in
     `encodeCursorAllow` to emit `{ additional_context: ... }` on that
     event specifically (current code only does this for `postToolUse`).
   - Gemini-cli's adapter at `gemini-cli.ts:16` doesn't register a
     user-prompt event at all (`NATIVE_EVENTS` = `["BeforeTool",
     "AfterTool", "AfterModel", "PreCompress"]`).
   - Copilot's `userPromptSubmitted` has no documented model-visible
     advisory channel.

   The harness still scans and stores their prompts as today. No
   metacoder fires; no overlay is generated. Re-evaluate per-runner
   support in a v2 pass once Claude/Codex behavior is well-understood.
3. **`allowed-tools.json` enforcement.** Deferred entirely from v1
   (the writer doesn't even reserve the path). v2 may add per-session
   tool whitelisting.
4. **Per-tool-call metacoder re-runs.** v1 fires once per
   `UserPromptSubmit`. Mid-session scope drift is not re-evaluated.
5. **Cross-session learning.** Metacoder gets prompt + AGENTS.md +
   project graph. Nothing from previous sessions' trajectories.
6. **Confidence-based gating.** Overlays are atomic (use them all or
   skip the whole thing).
7. **Cost telemetry / budget caps.** Fail-open on API errors. No 429
   detection beyond "request failed, skip overlay".
8. **Custom metacoder system prompt.** Constant in
   `metacoder-client.ts`; no `.interlinked/metacoder-system-prompt.md`
   override.
9. **Local-only LLM (Ollama).** v1 supports `claude_code` (subprocess)
   and `openai` HTTP only.
10. **Subagent / Task-tool overlays.** v1 scopes on `session_id`.
    Sub-tasks inherit because they share the session.
11. **Codex `turn_id`-scoped overlays.** v1 uses session-scoped only.

---

## 10. Open risks for reviewers

Specific places a reviewer should push on:

1. **Tighten-only invariant correctness.** §2.3 lists eight loader
   checks (including action-block-only and append-after). Are there
   bypasses we missed? Example: can an overlay rule with `active_when`
   scoping pretend to constrain while never actually firing?
2. **In-memory per-session rule cache and daemon restarts.** If the
   harness daemon restarts mid-session, the in-memory overlay is lost.
   The on-disk overlay file survives. Should `loadRules` re-read
   overlays from disk on startup? v1 does not — SessionEnd / Stop
   handlers will eventually clean up orphaned dirs.
3. **30–35s latency UX.** The metacoder can run for up to 30s, and the
   hook waits up to 35s to leave response-buffer room. Is a watchdog
   progress indicator needed? Not in v1 — `claude -p` is silent until it
   returns.
4. **Codex CLI subscription auth.** v1 spawns `codex exec` against the
   user's existing Codex CLI subscription (`codex login`). No API key.
   When the CLI is missing, the transport returns
   `skipped: subprocess_not_found` and the agent runs against floor
   rules — same fail-open posture as the Claude path. When the user has
   hit their usage quota, the failure surfaces with a classified
   `codex usage limit reached` reason (see
   `metacoder-client.ts::classifyCodexExitFailure`). Should we surface
   this as a user-visible warning rather than only a log line?
5. **`additional_context` size cap.** Metacoder can emit up to 2000
   chars of `system_prompt_addendum` per prompt. Active overlay rules
   replace on every `UserPromptSubmit`, but prior addenda can remain in
   the agent's conversation history because the harness cannot retract
   already-injected context. 2000 chars × 100 turns = 200 KB of historical
   addenda in the session context. Is the cap correct?
6. **Metacoder running against itself.** The metacoder is itself an
   LLM call. The harness's PII scanner does run before the metacoder
   (we pass the redacted prompt), but content gates (e.g., web-fetch
   proxy, secret detectors) don't intercept the metacoder's request to
   Anthropic/OpenAI. Should they?
7. **Failure-on-startup ordering.** If `loadRules(cwd, sessionId)` is
   called before SessionStart populated `sessionRules.get(sessionId)`,
   we need a clear ordering guarantee. The plan: `UserPromptSubmit`
   always precedes the first `PreToolUse` for that session, and
   `sessionRules.set` happens inside the synchronous UserPromptSubmit
   handler. Verify by reading the evaluator entry point.
8. **Sentinel env var trust (recursion guard).** §2.5 relies on
   `INTERLINKED_METACODER_SUBPROCESS=1` being honestly set by the
   metacoder and forwarded by the hook script. An agent that controls
   its own env, or a compromised hook script, could forge it,
   suppressing metacoder evaluation. Mitigation: the env var is set by
   the harness's own subprocess spawn. v2 could move the guard to a
   harness-side socket-peer-credential check (uid + process tree). For
   v1, the env var is sufficient given the threat model.
9. **Regex validation completeness.** The ReDoS-shape check
   (`/\([^)]*[+*][^)]*\)[+*]/`) catches the common nested-quantifier
   cases but is not exhaustive. A determined adversarial LLM could
   emit exponential patterns the check misses (e.g.,
   `a*a*a*a*a*a*$`). Acceptable for v1 because the LLM is constrained
   by its own system prompt to emit reasonable patterns; not
   acceptable if the metacoder ever becomes user-prompt-injectable.
10. **Hook timeout misalignment.** §2.4 sets the hook timeout to 35s
    and §6 sets the metacoder internal timeout to 30s. The hook must stay
    strictly above the metacoder timeout with a response buffer. If someone
    tunes the metacoder to 45s without raising the hook to at least
    50s, users get cold-fallback responses 100% of the time. A shared
    constant pair (e.g., `METACODER_TIMEOUT_MS` plus
    `USER_PROMPT_HOOK_TIMEOUT_BUFFER_MS`) would prevent drift. Worth doing
    in v1.

---

## 11. Reviewer prompt

If you are a reviewing agent: focus your critique on §2.3 (tighten-only
invariant correctness, action constraint, regex validation), §2.5
(recursion guard — does the env-var approach hold up?), §6 (LLM
contract — is the system prompt load-bearing enough?), and §10 (open
risks). Skip stylistic edits to prose. The goal is to surface design
holes, not polish.

If you are a human reviewer: §2.1, §2.2, §2.5 are the load-bearing
*choices*. Everything else flows from them.
