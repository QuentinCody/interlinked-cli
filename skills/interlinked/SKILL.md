---
name: interlinked
description: "Overview and router for the Interlinked CLI — a local guard, quality-enforcement, simplification-review, semantic-code-search, and observability layer for AI coding agents. Load this when working in a repo that has a `.interlinked/` directory, when you see any `[interlinked:*]` output or a `BLOCKED: … Suggestion: …` reason and are not sure which area it belongs to, or when you need to know what the `interlinked` command can do. This skill explains the mental model, the `.interlinked/` layout, the `[proven]`/`[heuristic]` tags, and routes you to the focused `interlinked-*` skill for setup, guard blocks, verify/checks, quality ratchets, simplification, local semantic indexing, supply-chain, spec-audit, observability, or coordination."
---

# interlinked — overview & skill router

**Interlinked is a local control plane for AI coding agents.** A local daemon ("the harness")
hooks into Claude Code, Codex, Copilot CLI, Gemini CLI, Cursor, OpenCode, and
Pi — and on every tool call the runner exposes to its hook surface it enforces deterministic
policy (block/allow in milliseconds, no model in the decision path),
fails closed on what causes incidents (destructive commands, secrets, unvetted deps), and writes
a replayable local activity log. It is **offline-first** — no required cloud dependency or
remote telemetry. Activity is recorded locally; an **optional authenticated server** provides
multi-agent coordination and configured sync.

Runner registration is not a claim of identical native APIs. OpenCode and Pi use managed
plugin/extension bridges and lack dedicated native MCP, subagent, and worktree lifecycle hooks;
load **interlinked-setup** for activation/trust and **interlinked-harness** for ask/Stop behavior.

If you're an agent working in a repo with a `.interlinked/` directory, you are being guarded by
it. This skill orients you and points to the right focused skill.

## The three surfaces
| Surface | Role |
|---|---|
| **Interlinked CLI** (`interlinked …`) | Local hooks, guard, quality checks, activity capture, diagnostics. |
| **Interlinked MCP Server** | Optional remote source of truth for tasks, messages, reservations, agent state. |
| **Web UI** (`/chat`, `/map`) | Optional human oversight and coordination. |

## The `.interlinked/` directory
Everything is per-`cwd` under `<repo>/.interlinked/`. Key files:

| File | Git | Purpose |
|---|---|---|
| `config.json` | committed | server URL, defaults, operational mode, feature flags |
| `config.local.json` | gitignored | token, agent name, workspace, sync mode |
| `guard-rules.json` / `.local.json` | team / local | guard rules, file reminders, per-edit coverage/mutation policy |
| `check-policy.json` / `.local.json` | team / local | report-ratchet settings, including the mutation-score floor |
| `package-allowlist.json` | committed | approved dependencies (default-deny installs) |
| `verify-suppressions.json` | committed | file/glob check suppressions |
| `*-baseline.json`, `metric-caps.json` | mixed | ratchet water-lines (coverage/mutation/line-cap/caps); the daemon folds session evidence into three of them at SessionEnd, tighten-only — see **interlinked-quality-gates** |
| `baseline-folds.jsonl` | local | audit row per SessionEnd water-line fold (what tightened, what was refused) |
| `mutation-manifest.json` | mixed | stable per-mutant state for the live per-edit mutation ratchet |
| `mutation-cloud-v3.local.json` | gitignored | experimental protocol-v3 endpoint, authority, key, runtime, and scheduler configuration |
| `mutation-journal.sqlite` | local | authority-scoped durable mutation jobs, leases, authenticated evidence, manifest head, and outbox |
| `mutation-findings.jsonl` | local | fsynced, deduplicated delivery records for durable background mutation findings |
| `findings/corpus.jsonl` | committed-capable | common finding storage, including recorded simplification extensions |
| `findings/simplification-runs.jsonl`, `debt/manual-marker-snapshots.jsonl` | local | explicit simplification-run and manual-marker snapshot receipts |
| `semantic.json` / `.local.json` | team / local | optional local semantic-index policy / machine runtime topology |
| `index/functions/` | local | generation-scoped function metadata and vectors; never synced |
| `activity.jsonl`, `collection.jsonl`, `timeline.jsonl` | local | captured agent activity (`enable` gitignores the first two) |
| `hook-runtime.json` | local | payload-free proof that each provider executed its current hook definition |
| `harness.sock` / `harness.pid` | — | the running daemon |

## What warnings mean: `[proven]` vs `[heuristic]`
Every message the harness sends you is tagged:
- **`[proven]`** — a real compiler/linter/scanner/parser/test-runner produced it (tsc, biome,
  gitleaks, semgrep, …). Authoritative — **fix it**.
- **`[heuristic]`** — a regex/AST-shape match that could be a false positive. **Evaluate it.**
- No tag — an unknown check id (never guessed).

A **block reason is always surfaced.** Allow-time warnings are surfaced but easy to overlook
(PreToolUse via `additionalContext`, PostToolUse via stderr) — read them.

## Where things run (server / auth / offline)
| Commands | Server needed | Works offline |
|---|---|---|
| `enable`, `disable`, `doctor`, `verify`, `harness …`, `caps`, `simplify …`, `debt …`, `impact`, `allowlist`, `logs`, `status` | no | yes |
| `sync`, `watch` | yes | no |
| `tasks`, `send`, `inbox`, `handoff`, `workspace` | yes (auth) | no |
| `checkpoint`, `rewind`, `resume`, `guard` | no | yes |

## Which skill to load for what

| Situation | Load |
|---|---|
| Installing / enabling Interlinked, connecting a coding client/hook, daemon down or **zombie**, `doctor` fails, config/mode | **interlinked-setup** |
| A Bash command or edit was **BLOCKED**; a sandbox/effect-residue warning; a `[interlinked:*]` warning; suppressions | **interlinked-harness** |
| Running `interlinked verify`; a `pre_block` check blocked an edit; landing a cross-file refactor; scratch scripts; **configuring custom build/test command overrides (`tool_commands`)** | **interlinked-verify** |
| Blocked by a **line-cap / function-token / coverage / complexity / CRAP / mutation** ratchet; configuring report, per-edit, or durable `mutation cloud` work; operating the mutation journal; "can't lower a baseline"; `adopt`; automatic obligation or manual marker debt; **dead code** (`deadcode` scan + `--categorize` deletion-safety buckets, per-edit `dead_code_action`) | **interlinked-quality-gates** |
| Finding, reviewing, recording, or auditing opportunities to delete, replace, defer, or shrink code; `simplify …`; simplification coverage/evidence/deep handoff | **interlinked-simplification** |
| Installing a local embedding model; building, inspecting, searching, or repairing the optional function-vector index | **interlinked-semantic-index** |
| An `npm/pip/cargo/…` install or manifest edit was blocked; the package **allowlist** | **interlinked-supply-chain** |
| Spec/doc facts, drift, invariants, review **findings**, `doctest`; `[interlinked:spec-*]` | **interlinked-spec-audit** |
| Inspect activity/logs, tail live, guard-block history, **recurrence**, `viz`, tamper-chain `audit`, evidence-classed `impact`, `sync` | **interlinked-observability** |
| Server-backed **tasks/messages/reservations/handoff**; local **checkpoints** (git-mutating!) | **interlinked-coordination** |
| Distill AGENTS.md / CLAUDE.md guidance into enforced harness rules | **enforce** (`/enforce`) |

## Quick orientation
```bash
interlinked                 # guided human first run (posture + hooks + skills + daemon)
interlinked enable          # explicit/automation install primitive
interlinked status          # dashboard: sessions, recent activity, health
interlinked doctor          # is everything installed & the daemon answering?
interlinked harness status  # liveness: answering / ZOMBIE / not running
interlinked harness checks   # how many checks / rules are active
interlinked --help          # full command list
```

> `harness status` and `doctor` verify liveness by **round-trip, not PID**. A red `ZOMBIE`
> (process alive, nothing answering) means the guard is off — `interlinked harness restart`.
> For Codex, doctor also compares `.codex/hooks.json` with the last executed definition hash;
> review changed hooks through `/hooks`, then run a hooked action.

## Golden rules for an agent in a guarded repo
1. **When blocked, read the `Suggestion:` and take the safe path** — don't rewrite to dodge the pattern.
2. **Meet quality gates by fixing code** (decompose, add a test, cover the line) — never lower a baseline.
3. **`[proven]` findings are real** — fix them; triage `[heuristic]` ones.
4. **Package installs are default-deny** — surface an unapproved dep to the human, don't `--force`.
5. **Checkpoints/rewind mutate git** — never run them without explicit per-turn authorization.
6. **Do not create worktrees** — use the current workspace; ask a human operator to provision
   an approved worktree when isolation is required. Listing and cleanup remain allowed.
