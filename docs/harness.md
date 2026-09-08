# Interlinked Harness — Architecture & Decision Record

## What Is The Harness?

The Interlinked Harness is a local server that runs on each developer's machine. It receives the events that configured coding-agent integrations deliver, normalizes them, evaluates them against guard rules, manages file reservations, and enforces only the lifecycle controls each provider exposes. Claude Code and Codex are supported; the Cursor, Copilot CLI, Gemini CLI, OpenCode, and Pi integrations are experimental.

It is the **third component** of the Interlinked platform:

| Component | Role | Runs Where |
|-----------|------|------------|
| Interlinked MCP Server | System of record: agents, messages, tasks, reservations, team state | Cloudflare Workers (shared) |
| Interlinked CLI | Hook installation, activity capture, local storage, developer observability | Each developer's machine |
| **Interlinked Harness** | Guard evaluation, auto-reservations, agent lifecycle, quality checks | Each developer's machine (Node.js) |

The CLI and harness are shipped together from the `QuentinCody/interlinked-cli` source checkout.

## Why A Local Harness Server?

### The Problem

AI coding agents can:
- Run destructive shell commands (`rm -rf /`, `git push --force`, `DROP DATABASE`)
- Create unbounded Git worktrees that consume disk and fragment shared-agent state
- Write secrets into source files
- Wait inefficiently in the terminal instead of using an agent-native or MCP wait primitive
- Ask the human for input through a provider surface that may not support native confirmation
- Edit files that another agent (on the same or a different developer's machine) is already editing
- Curl localhost URLs when they should be using MCP tools (indicating a disconnected MCP server)
- Write code with type errors, security vulnerabilities, or invalid syntax

### Why Not Just Inline Pattern Matching?

The original approach was a standalone `command-guard-hook.ts` file that pattern-matched shell commands. This had limitations:

1. **No state** — couldn't track what the agent had done previously in the session (trajectory)
2. **No coordination** — couldn't check file reservations from the server
3. **No quality checks** — couldn't run `tsc` or linters after file edits
4. **No cohort awareness** — couldn't distinguish "my other agent" from "someone else's agent"
5. **Single agent only** — was Claude Code-specific and did not generalize across runner protocols

### Why Not Call the Remote Server for Every Check?

Adding 50-200ms of network latency to every PreToolUse event would be too slow. The agent would feel sluggish. The harness runs locally with <5ms evaluation latency.

### The Sondera Inspiration

[Sondera](https://github.com/sondera-ai/sondera-coding-agent-hooks) built a similar architecture in Rust: a local harness server on a Unix socket that evaluates Cedar policies with YARA signature matching. Their key insights that we adopted:

- **Unix socket for speed** — sub-millisecond IPC, no HTTP overhead
- **Agent-agnostic event normalization** — same evaluation engine regardless of which agent
- **Default-permit with targeted forbid** — allow everything except known-bad patterns
- **STEER over BLOCK** — deny with reasoning so agents can self-correct

What we added that Sondera doesn't have:
- **Remote server coordination** — file reservation sync, team-wide visibility
- **Agent lifecycle normalization** — provider-specific continuation, interruption, and MCP-first guidance where the native API exposes them
- **Cohort awareness** — tracking all of one developer's agents together
- **Auto file reservation** — transparent lease management without explicit MCP calls
- **Quality checks** — PostToolUse TypeScript compilation, lint, secrets scanning

### Runtime: Node.js

The harness runs on Node.js using `node:net` for Unix socket IPC. The server is pre-compiled to JavaScript via tsup (`dist/harness/server.js`) for fast startup, or can be run from TypeScript source via `npx tsx` during development.

**Why Node.js?**
1. **Universal** — no extra runtime install required (Node.js is already a dependency)
2. **Pre-compiled startup** — tsup-compiled JS starts in ~100ms, eliminating the need for a separate runtime
3. **Same language** as the rest of the CLI codebase (TypeScript)
4. **Standard Unix socket support** via `node:net` `createServer({ path: ... })`
5. **Source distribution** — built and linked from a GitHub checkout with no binary compilation needed

> **Historical note:** The harness originally used Bun for its fast startup and native TypeScript support. It was migrated to Node.js to eliminate the Bun dependency and simplify distribution. Pre-compiling to JS via tsup achieves comparable startup performance.

## Architecture

```
Claude / Codex / Copilot / Gemini / Cursor hook arrays
    │
    ├──► Packaged `interlinked-hook` (`dist/hook-entry.js`)
    │
OpenCode / Pi managed plugin or extension
    │
    └──► Packaged `interlinked-hook` (`dist/hook-entry.js`)
    │
    ├─── Normalize native event and connect to harness Unix socket
    │    │
    │    ▼
    │  Interlinked Harness Server (Node.js)
    │    │
    │    ├─ Guard Evaluator
    │    │  ├─ Lifecycle: provider-supported permission/continuation controls
    │    │  ├─ Destructive: rm -rf, force push, DROP DATABASE, pkill
    │    │  ├─ Security: secrets, path traversal, exfiltration, pipe-to-bash
    │    │  ├─ Code quality: JSON validity, Edit old_string verification
    │    │  ├─ Reservations: auto-reserve files, check for conflicts
    │    │  └─ MCP connectivity: curl-to-localhost detection
    │    │
    │    ├─ Grep Accelerator (PreToolUse Grep/Bash interception)
    │    │  ├─ Trigram index query (~10-50μs)
    │    │  ├─ Candidate file narrowing
    │    │  └─ Block-and-answer with ripgrep results
    │    │
    │    ├─ Quality Checks (PostToolUse, 8+ languages — count: docs/generated/quality-checks.md)
    │    │  ├─ TypeScript (tsc), Biome, ESLint, secrets, strong typing, affected tests
    │    │  ├─ Python (mypy, ruff), Rust (cargo check/clippy), Go (go build, golangci-lint)
    │    │  ├─ C/C++ (compile, clang-tidy), Semgrep, gitleaks, dependency audit
    │    │  └─ Prompt injection detection
    │    │
    │    ├─ Structural Checks (PostToolUse, <!-- gen:structural_check_count -->26<!-- /gen:structural_check_count --> dependency-aware checks)
    │    │  ├─ Export surface, import resolution, hallucinated imports, dead imports/exports
    │    │  ├─ Import cycles, interface change impact, blast radius, smart tsc
    │    │  └─ Stale read warnings, sibling awareness, route context, completion tracking
    │    │
    │    ├─ Analysis Subsystems
    │    │  ├─ Project graph (multi-file dependency tracking with cache)
    │    │  ├─ Impact analysis (cross-file breaking change detection)
    │    │  ├─ Change propagation (side-effect tracking)
    │    │  ├─ Error history (pattern memory, optional embeddings)
    │    │  ├─ Taint tracker (sensitivity classification: Public/Confidential/Secret)
    │    │  └─ Suggestion scorer (weighted finding ranking)
    │    │
    │    ├─ Trigram Index (.interlinked/index/)
    │    │  ├─ Loaded on startup, incremental update on SessionStart
    │    │  └─ Dirty layer updated on PostToolUse file edits
    │    │
    │    ├─ Cohort Manager (tracks all agents for this developer)
    │    ├─ Session Tracker (per-session trajectory state)
    │    ├─ Reservation Manager (local cache + server sync)
    │    ├─ Local activity/timeline capture for events the daemon receives
    │    └─ Optional Server Bridge (reservation sync, guard event reporting)
    │
    ▼
  Provider-specific pre-tool decision / post-tool feedback
```

### Graceful Degradation

If the harness is not running:
- The packaged hook runtime falls back to a **self-contained deterministic subset** for ordinary hook phases
- Checks that need the full evaluator do not run and must not be reported clean
- No grep acceleration (agents use full ripgrep scan — slower but correct)
- No auto-reservations (relies on server-side reservation system via MCP tools)
- Only events that reach a running daemon are guaranteed to enter the local activity log; a cold-fallback decision is not a complete outage audit trail

This is a bounded degraded mode, not equivalence with the full harness. Deterministic inline
checks can still refuse proven hazards and the hook attempts bounded self-heal, but external
checks, project context, reservations, and complete capture remain unavailable until
`interlinked harness status` confirms the socket is answering. If the packaged hook binary
itself is missing or broken, the installed hook wrapper allows only provider-owned read
builtins and exact repair commands; mutating or unclassified pre-tool calls fail closed.
Inside the generated runtime, a parseable Claude/Codex `PreToolUse` or `PermissionRequest`
whose main handler throws receives the same native deny envelope as an ordinary block. Hook
stdout is staged until audit work completes, so terminal recovery replaces rather than appends
to a pending response; non-gating failures emit no stdout and exit nonzero as a warning path.

## Key Design Decisions

### 1. PreToolUse vs PostToolUse — What Goes Where?

**PreToolUse** (blocks before the tool executes):
- All checks that can be done with the tool call arguments alone (no execution needed)
- Pattern matching on commands, file paths, content
- File reservation conflict detection
- Must be fast (<500ms total, ideally <50ms)

For ordinary agent `Edit`/`Write` calls, the proposed-content blocker is the
deterministic, introduced-only `pre_block` registry. It does not synchronously
launch TypeScript, Biome, or another external tool.

**PostToolUse** (feedback after the tool executes):
- Checks that need the full project context or take significant time
- TypeScript compilation (`tsc --noEmit`) — needs tsconfig.json, node_modules, all source files
- Lint checks — need full project context
- Results use each provider's model-visible post-tool channel when one exists; Copilot remains stderr-only
- Capacity or tool unavailability produces an explicit `NOT CHECKED` no-verdict result, never a clean result

**Why not PreToolUse for type checking?**
Running `tsc` on PreToolUse would mean:
1. The proposed code needs to be written to a temp file first (the agent's Edit hasn't landed yet)
2. `tsc --noEmit` on one file still needs the full project context
3. It adds 5-15 seconds to every `.ts` file edit
4. The agent would feel very slow

PostToolUse is better because:
1. The file is already written to disk — `tsc` can check it directly
2. The agent continues working while the check runs
3. If errors are found, the next provider-visible warning lets the agent self-correct
4. A write followed by its fix is more efficient than blocking repeatedly

Transactional CLI paths serve a different contract. `interlinked write`,
`multi-edit`, and `verify-changeset` evaluate proposed content with the shared
`pre_block → Biome → TypeScript` gate. Unavailable analyzer results reject the
transaction; a project without Biome configuration skips that analyzer.
`verify-changeset` is read-only. Both write commands capture target bytes and
permissions before verification, compare them under a shared project commit
lock, and abort if any target changed. Parent-directory resolution is rechecked
before staging, committing, and rollback. Rollback restores earlier targets only
while their contents and parent resolution still match the transaction's write. This protects
cooperating transactions from lost updates; it is not crash-atomic multi-file
commit and does not lock out ordinary editors.

### 2. Auto File Reservation — Optimistic Locking

**Decision:** Reservations are checked against a local cache (instant), confirmed with the server asynchronously (non-blocking).

**Why:** Checking the server synchronously on every file write would add 50-200ms latency. The optimistic approach means:
- First write: check local cache → no conflict → allow immediately → reserve on server in background
- Subsequent writes to same file: local cache already shows reservation by this agent → allow instantly
- Conflict detection: another developer's agent reserved the file → local cache (refreshed every 30s) shows the conflict → block

**Trade-off:** There's a ~30 second window where two developers could both start editing the same file before the cache syncs. In practice this is rare, and the server's reservation system is the authoritative conflict resolver.

**Release timing:** Files are auto-released 30 seconds after the last edit. This prevents rapid reserve/release churn during multi-file edits while ensuring files don't stay locked when the agent moves on.

### 3. Agent Cohort Model

**Decision:** The harness tracks all agents belonging to one human developer as a "cohort."

**Why:** A developer often has multiple agents running:
- A primary Claude Code session
- Subagents spawned by the primary (researcher, test-writer)
- A secondary Gemini CLI for quick tasks
- An OpenCode or Pi session using the same normalized policy and reservation state

The cohort model lets the harness:
- **Warn** when two of the developer's own agents conflict (instead of blocking)
- **Block** when a different developer's agent holds a reservation
- Track agent health across all sessions (detect "lost" agents that stopped responding)

**Lifecycle events:**
- `agent_join` — agent connects, registered in cohort
- `agent_leave` — agent disconnects gracefully
- `agent_lost` — no events for 5 minutes, likely crashed or disconnected
- `subagent_join/leave` — subagents tracked as children of their parent

### 4. Waiting and MCP-First Communication

**Decision:** Interlinked recommends provider-native waiting or MCP coordination,
but the current rule set has no standalone block for a `sleep` command.

When an Interlinked MCP Server is configured, an agent can wait through the
available coordination tool and receive tasks/messages without polling a terminal.
Provider lifecycle and question controls are normalized only where their native APIs
deliver them. Curl-to-localhost trajectory rules can still flag a likely disconnected
MCP path, and unbounded spin/resource-bomb rules remain independent safety checks.

### 5. Multi-Agent Provider Support

**Decision:** One evaluator consumes normalized events, while each adapter
registers, controls, and renders only the native surfaces its provider offers.
Registration is not a claim of provider parity.

**How:** The packaged hook entry (or an OpenCode/Pi managed bridge in front of
it) normalizes native payloads into `UnifiedHookEvent`. Shared helpers classify
provider-specific names such as Claude/Codex `Bash`, Gemini `Shell`, Cursor's
shell/MCP/file events, Copilot `preToolUse`, OpenCode
`tool.execute.before`/`after`, and Pi `tool_call`/`tool_result` plus
`user_bash`. The evaluator returns one `HarnessDecision`; the adapter then
encodes it using that provider's actual response contract.

Claude Code and Codex are the supported integrations. Claude exposes native
pre-tool, permission, continuation, subagent, compaction, and worktree event
shapes; `PreToolUse` uses `permissionDecision`, while a `PermissionRequest` deny uses
`hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } }`.
Interlinked otherwise abstains on that event so Claude's native permission policy keeps
authority. Claude's installed `WorktreeCreate` event is a deliberate hard stop. Codex
covers its twelve-event native surface, including its distinct
PermissionRequest and continuation envelopes. Codex's observation-only
`Interrupt` event records cancellation asynchronously and has no control
output or terminal cleanup. Both translate to the same internal decision, not
the same upstream UI or response object. See
[`design/cli-hook-normalization.md`](design/cli-hook-normalization.md) and the
current matrix in `src/harness/adapters/README.md`.

Codex does not expose a custom status-line command slot comparable to Claude
Code. Interlinked uses hook `statusMessage`, `interlinked status`, and the
definition-hash runtime receipt instead of claiming UI parity the provider
cannot supply.

Cursor, Copilot CLI, and Gemini CLI use packaged hook-array adapters and remain
experimental. Cursor has model-visible context only on its generic
`postToolUse` channel; its event-specific after-hooks are observation-only.
Copilot's feedback is stderr-only and canonical `ask` becomes deny. Gemini's
decision/ask contract remains provisional. These adapters run shared policy
where their event reaches Interlinked, but are not marketed as equivalent
enforcement contracts.

OpenCode and Pi use manifest-owned JavaScript bridges at
`.opencode/plugins/interlinked.ts` and `.pi/extensions/interlinked.js`. OpenCode's stable plugin
API provides a hard generic tool gate but no native confirmation call there, so `ask` denies;
its `session.idle` event records Stop but cannot veto or continue it. Pi uses `ctx.ui.confirm` for
`ask` when a UI is present and denies in headless mode. Its separate `user_bash` event closes the
gap between model tool calls and shell commands the user launches directly. Pi's
`agent_settled` Stop signal is observation-only. Neither provider exposes dedicated native MCP,
subagent, or worktree lifecycle hooks, so Interlinked does not claim those parts of
Claude/Codex parity. Command-driven `git worktree add` remains blocked by the shared shell rule.

Runtime activation is provider-owned: restart OpenCode after installation; Pi requires `/reload`
or restart plus its project-extension trust approval. Interlinked refuses to overwrite a foreign
bridge and preserves a bridge modified after installation.

### 6. Rules Configuration — Team-Shared + Personal Overrides

**Decision:** Two-tier rule configuration mirroring the Interlinked CLI config pattern.

| File | Git | Purpose |
|------|-----|---------|
| `.interlinked/guard-rules.json` | Committed | Team-shared rules, protected files, quality check config |
| `.interlinked/guard-rules.local.json` | Gitignored | Personal overrides: disable specific rules, add exceptions |

**Why:** Teams need shared safety policies (everyone should be blocked from `rm -rf /`), but individual developers may need exceptions (e.g., a DevOps engineer who legitimately uses `terraform destroy`).

The rules are loaded at harness startup and hot-reloaded when files change. Built-in rules (<!-- gen:builtin_rule_count -->121<!-- /gen:builtin_rule_count --> rules across <!-- gen:builtin_rule_category_count -->25<!-- /gen:builtin_rule_category_count --> categories — see `docs/generated/guard-rules.md` for the full reference) are always active unless explicitly disabled in the local override file.

### 7. Server Bridge — Coordination Without Dependency

**Decision:** The harness works standalone but coordinates with the Interlinked MCP server when available.

**When server is available:**
- File reservations are synced every 30 seconds
- Guard events (blocks, warnings) are reported to the server for team dashboard visibility
- `X-Interlinked-Harness-Version` header on activity POSTs identifies harness-processed events

**When server is unavailable:**
- Harness continues working with local-only reservation cache
- Guard events are queued and flushed when connectivity returns
- Quality checks and pattern matching are unaffected (entirely local)

## File Reference

**Core:**
| File | Purpose |
|------|---------|
| `cli/src/harness/types.ts` | All type definitions: events, decisions, rules, cohort, reservations, config |
| `cli/src/harness/server.ts` | Node.js Unix socket server — the main entry point (`node:net`) |
| `cli/src/harness/evaluator.ts` | Guard evaluation — PreToolUse blocking + PostToolUse feedback |
| `cli/src/harness/rules-loader.ts` | Rule loading: <!-- gen:builtin_rule_count -->121<!-- /gen:builtin_rule_count --> built-in + team JSON + personal overrides + hot-reload |
| `cli/src/harness/session-state.ts` | Per-session trajectory tracking (files, commands, tool counts) |
| `cli/src/harness/cohort.ts` | Agent cohort manager (join/leave/lost detection, file tracking) |
| `cli/src/harness/reservations.ts` | Auto file reservation (optimistic lock, 30s release, server sync) |
| `cli/src/harness/quality-checks.ts` | PostToolUse runners: <!-- gen:quality_check_count -->34<!-- /gen:quality_check_count --> checks across 8+ languages |
| `cli/src/harness/server-bridge.ts` | Server coordination: reservation sync, guard event reporting |
| `cli/src/harness/trigram-index.ts` | Trigram search index: build, query, serialize, dirty layer, incremental git update |
| `cli/src/harness/regex-trigrams.ts` | Regex → trigram decomposition, ripgrep command parsing, shell tokenizer |
| `cli/src/harness/grep-accelerator.ts` | PreToolUse grep acceleration: intercept search tools, query index, block-and-answer |

**Analysis subsystems:**
| File | Purpose |
|------|---------|
| `cli/src/harness/structural-checks.ts` | <!-- gen:structural_check_count -->26<!-- /gen:structural_check_count --> dependency-aware checks (export surface, imports, cycles, blast radius) |
| `cli/src/harness/generic-checks.ts` | 50+ inline code analysis checks (SQL injection, complexity, async/await, etc.) |
| `cli/src/harness/project-graph.ts` | Multi-project file dependency graph with caching |
| `cli/src/harness/impact-analysis.ts` | Cross-file dependency tracking and breaking change detection |
| `cli/src/harness/change-propagation.ts` | Side-effect tracking across edits |
| `cli/src/harness/error-history.ts` | Error pattern memory with optional embeddings support |
| `cli/src/harness/language-profiles.ts` | Language-specific checks for 12+ languages |
| `cli/src/harness/taint-tracker.ts` | Sensitivity classification and flow tracking |
| `cli/src/harness/pattern-detector.ts` | Cross-cutting pattern detection |
| `cli/src/harness/suggestion-scorer.ts` | Weighted finding scoring and ranking |
| `cli/src/harness/suppressions.ts` | Inline suppression directives |
| `cli/src/harness/check-metadata.ts` | Structural check metadata for docs generation |
| `cli/src/harness/check-engine/` | Unified caching/memoization layer for checks |

**CLI commands and config:**
| File | Purpose |
|------|---------|
| `cli/src/commands/harness.ts` | CLI commands: `interlinked harness start/stop/status/test` |
| `cli/src/commands/index-cmd.ts` | CLI commands: `interlinked index build/update/status/query` |
| `cli/scripts/generate-docs.ts` | Auto-generates reference docs from source code |
| `.interlinked/guard-rules.json` | Default team-shared guard rules configuration |
| `.interlinked/index/trigram.bin` | Binary trigram index (generated by `interlinked index build`) |
| `.interlinked/index/meta.json` | Index metadata: file count, trigram count, base commit, build time |

**Auto-generated reference docs** (run `npm run docs` to regenerate):
| File | Contents |
|------|----------|
| `cli/docs/generated/guard-rules.md` | All <!-- gen:builtin_rule_count -->121<!-- /gen:builtin_rule_count --> built-in guard rules by category |
| `cli/docs/generated/quality-checks.md` | All <!-- gen:quality_check_count -->34<!-- /gen:quality_check_count --> PostToolUse quality checks |
| `cli/docs/generated/structural-checks.md` | All <!-- gen:structural_check_count -->26<!-- /gen:structural_check_count --> structural checks by tier |
| `cli/docs/generated/configuration.md` | Default config: diff-aware filtering + structural check settings |

## Grep Acceleration — Trigram Search Index

### What It Does

The harness intercepts Grep and Bash (rg/grep) tool calls and uses a trigram inverted index to narrow the file set before running ripgrep. Instead of scanning every file in the repo, ripgrep only scans the files that could possibly contain the search pattern.

This accelerates searches from all tools: Claude Code's `Grep` tool, `Bash` commands running `rg`/`grep`, and subagent searches (Explore, Search agents). The acceleration is transparent — agents don't need to change how they search.

### How It Works

1. **Build an index**: `interlinked index build` scans all git-tracked files, breaks content into overlapping 3-character sequences (trigrams), and builds an inverted index: trigram → file list.

2. **Harness loads the index** on startup and incrementally updates it from `git diff` on each `SessionStart`.

3. **On every Grep/rg call**: the harness decomposes the search pattern into trigrams, intersects the posting lists, and gets a set of candidate files. If the candidates are a small subset of the total, it runs ripgrep only on those files and returns results via the block-and-answer pattern.

4. **Dirty layer**: when agents edit files (PostToolUse), the harness re-extracts trigrams for the edited file in memory. Agent writes are searchable immediately.

### Performance

Measured on the Interlinked monorepo (612 files, 3.8 MB index):

| Pattern | Index query | Candidates | Compared to full rg |
|---------|-------------|------------|---------------------|
| `handleAuthCallback` | 10μs | 1/612 | ~1,000x faster |
| `evaluatePreToolUse` | 13μs | 7/612 | ~900x faster |
| `OAuthProvider` | 12μs | 10/612 | ~900x faster |
| `execute_coordination_script` | 35μs | 59/612 | ~330x faster |

Index build: **0.4 seconds** for 612 files. Incremental update after branch switch: **< 1 second**.

The speedup is more dramatic on larger repos. On a 50K-file monorepo, ripgrep scans take 5-15 seconds; the index query still takes ~10-50μs.

### CLI Commands

```bash
interlinked index build               # Full build from git HEAD
interlinked index update              # Incremental from git diff since base commit
interlinked index status              # Show index stats and freshness
interlinked index query <pattern>     # Debug: show candidate files for a pattern
interlinked index query --regex <pat> # Debug: regex pattern decomposition
```

### Decision Logic

When the harness intercepts a search tool call:

| Condition | Action |
|-----------|--------|
| No index loaded | Pass through (normal grep) |
| Pattern has < 3 literal characters | Pass through (can't form a trigram) |
| Pattern is pure wildcard (`.*`, `.+`) | Pass through (no extractable literals) |
| 0 candidate files | Block with "no files match" (saves agent a slow empty search) |
| 1–500 candidates (< 30% of repo) | Block with ripgrep results on candidates only |
| > 500 candidates or > 30% of repo | Allow with warning: "broad pattern, consider narrowing" |

### What Agents See

When the index intercepts a search, the agent sees results like:

```
[interlinked:index] Searched 7 candidate files (from 612 total, 1.14% selectivity)

src/harness/evaluator.ts:112: export function evaluatePreToolUse(
src/harness/server.ts:263:   const preDecision = evaluatePreToolUse(
...
```

This includes selectivity metadata that helps the agent assess whether results are complete.

### Index Freshness

| Trigger | What happens | Speed |
|---------|-------------|-------|
| `interlinked index build` | Full rebuild from `git ls-files` | 0.1-0.5s for small repos, ~10s for 50K files |
| `SessionStart` hook | Incremental update from `git diff` since base commit | < 1 second |
| Agent edits a file | Dirty layer update (in-memory, per-file) | ~5μs |
| `interlinked index update` | Explicit incremental CLI update | < 1 second |

### Files

| Path | Contents |
|------|----------|
| `.interlinked/index/trigram.bin` | Binary index (gitignored) |
| `.interlinked/index/meta.json` | Metadata: file count, trigram count, base commit, build time |

The index should be added to `.gitignore` — it's machine-local and fast to rebuild.

## Guard Rules — Overview

> **Full reference:** See `docs/generated/guard-rules.md` (auto-generated, <!-- gen:builtin_rule_count -->121<!-- /gen:builtin_rule_count --> rules across <!-- gen:builtin_rule_category_count -->25<!-- /gen:builtin_rule_category_count --> categories).

### Lifecycle Enforcement

| Check | PreToolUse | Action | Condition |
|-------|-----------|--------|-----------|
| Curl-to-MCP detection | Yes | Warn → Block | `curl localhost:PORT` (escalates after 5 calls) |

### Built-in Rule Categories (<!-- gen:builtin_rule_count -->121<!-- /gen:builtin_rule_count --> rules across <!-- gen:builtin_rule_category_count -->25<!-- /gen:builtin_rule_category_count --> categories)

Category counts below are derived from `docs/generated/guard-rules.md` (the
auto-generated source of truth — regenerate with `npm run docs` after adding
or removing a rule).

| Category | Rules | Examples |
|----------|-------|---------|
| Process Killing | 9 | `pkill -f`, `killall`, `kill -9`, multi-PID kill |
| Process Safety | 5 | detached network processes, scheduled-task persistence |
| File Deletion | 3 | `rm -rf /`, `rm .wrangler`, `rm node_modules` |
| Git Operations | 10 | `--force` push, `reset --hard`, `clean -f`, `filter-branch`, `stash drop`, `worktree add` |
| Database | 5 | `DROP DATABASE/TABLE`, `TRUNCATE`, `DELETE` without WHERE, MongoDB drop, Redis flush |
| Cloud Providers | 5 | AWS destructive ops, S3 recursive, GCP/Azure destructive |
| Containers | 8 | Docker prune/rm -f/volume rm, kubectl mass delete/drain, helm uninstall |
| Infrastructure | 3 | Terraform destroy/auto-approve, Pulumi destroy |
| Supply Chain | 6 | Lock file deletion/tampering, build script injection, registry override |
| Filesystem | 4 | `dd` to block device, `shred`, disk format, `wipefs` |
| System Operations | 4 | `sudo rm`, `chmod 777`, shutdown/reboot, LVM removal |
| Wrangler | 5 | State deletion, worker deletion, KV bulk delete, D1 destructive SQL |
| Vercel | 2 | Deployment/project removal, env var deletion |
| Inline Scripts | 2 | Destructive ops in inline scripts, `bash -c` destructive |
| Language Destructive | 6 | Python/Rust/Go/C/Java destructive filesystem operations |
| Information Flow | 1 | Env exfiltration via shell redirection |

### Security Checks (evaluator-level)

| Check | PreToolUse | Action | What It Detects |
|-------|-----------|--------|-----------------|
| Secrets in file writes | Yes | Block | API keys, tokens, private keys, JWTs in Write/Edit content |
| Protected file paths | Yes | Block | .env, .pem, .key, CI configs, migration files |
| Path traversal | Yes | Block | `../`, `/etc/`, `/usr/` in file paths |
| Pipe-to-bash | Yes | Warn | `curl \| bash`, `wget \| sh` |
| Environment exfiltration | Yes | Block | `env \| curl`, `printenv \| nc` |
| Data exfiltration | Yes | Warn | `curl -d` POST to external URLs |
| Dependency confusion | Yes | Warn | `npm install --registry`, `pip install -i` |
| `--no-verify` bypass | Yes | Warn | `--no-verify` flag on any git command |
| `file://` protocol | Yes | Block | `WebFetch file://` |

### Code Quality (PreToolUse)

| Check | Action | What It Detects |
|-------|--------|-----------------|
| JSON validity | Warn | Invalid JSON syntax in `.json` file writes |
| Edit old_string verification | Block | `old_string` not found in file (edit will fail, saves a wasted tool call) |
| Oversized file read | Warn | Files >10MB (context consumption risk) |

### Code Quality (PostToolUse) — <!-- gen:quality_check_count -->34<!-- /gen:quality_check_count --> checks

> **Full reference:** See `docs/generated/quality-checks.md` (auto-generated).

| Language | Checks | Default |
|----------|--------|---------|
| TypeScript/JS | tsc, Biome, ESLint, strong typing, affected tests | tsc + strong typing enabled |
| Python | mypy, ruff | Disabled |
| Rust | cargo check, cargo clippy | Disabled |
| Go | go build, golangci-lint | Disabled |
| C/C++ | compile, clang-tidy | Disabled |
| Cross-language | Secrets-in-source, Semgrep, gitleaks, dependency audit, prompt injection | Secrets enabled |

### Structural Checks (PostToolUse) — <!-- gen:structural_check_count -->26<!-- /gen:structural_check_count --> checks

> **Full reference:** See `docs/generated/structural-checks.md` (auto-generated).

| Tier | Checks | Examples |
|------|--------|---------|
| Tier 1 (fast, sub-100ms) | 15 | Export surface, import resolution, dead imports/exports, hallucinated imports, stale read warnings |
| Tier 2 (medium, sub-1s) | 9 | Import cycles, interface change impact, test proximity, blast radius, layer violations |
| Tier 3 (conditional, 1-5s) | 2 | Smart tsc (single-file when safe), full impact analysis |

### Diff-Aware Filtering

> **Full reference:** See `docs/generated/configuration.md` (auto-generated).

Quality and structural checks support **diff-aware filtering** — pre-existing findings are suppressed so agents only see issues they introduced. Configurable per-check via `guard-rules.json`.

### Auto File Reservation

| Behavior | Trigger | Action |
|----------|---------|--------|
| Auto-reserve | PreToolUse Write/Edit | Reserve file, check for conflicts |
| Same-agent re-edit | PreToolUse Write/Edit on reserved file | Allow (already holds lock) |
| Same-cohort conflict | PreToolUse Write/Edit | Warn ("your other agent has this file") |
| Remote conflict | PreToolUse Write/Edit | Block ("Bob's agent has src/auth/*") |
| Auto-release | 30s after last edit | Release reservation |
| Session end | SessionEnd event | Release all reservations for agent |
| Agent lost | 5 min no events | Release all reservations |

## Testing

```bash
# All CLI tests (~765 total, includes harness)
cd cli && npx vitest run

# Guard evaluator tests
cd cli && npx vitest run src/harness/__tests__/evaluator.test.ts

# Trigram index + grep accelerator tests
cd cli && npx vitest run src/harness/__tests__/trigram-index.test.ts

# Structural checks, generic checks, impact analysis, etc.
cd cli && npx vitest run src/harness/__tests__/structural-checks-extended.test.ts
cd cli && npx vitest run src/harness/__tests__/generic-checks-extended.test.ts
cd cli && npx vitest run src/harness/__tests__/impact-analysis.test.ts

# Docs freshness (validates generated docs match source code)
cd cli && npx vitest run src/harness/__tests__/docs-freshness.test.ts

# Manual harness test
node cli/dist/harness/server.js --verbose &
interlinked harness test "rm -rf /"          # → BLOCKED
interlinked harness test "git push --force"  # → BLOCKED
interlinked harness test "npm run build"     # → ALLOWED
interlinked harness stop

# Build and test index
interlinked index build
interlinked index status
interlinked index query "handleAuth"

# Regenerate reference docs
cd cli && npm run docs
```

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| **macOS** | Fully supported | Unix socket IPC, primary development platform |
| **Linux** | Fully supported | Unix socket IPC |
| **Windows (WSL)** | Supported | Runs inside WSL with Unix socket IPC |
| **Windows native** | Not yet supported | Future: TCP localhost fallback (Unix sockets unavailable natively) |

The harness communicates via a Unix domain socket at `.interlinked/harness.sock`. This provides sub-millisecond IPC latency on macOS and Linux. Windows users should use WSL, which supports Unix sockets natively.

## Quality Check Configuration

Quality checks, structural checks, and diff-aware filtering are all configurable via `.interlinked/guard-rules.json` (team-shared) and `.interlinked/guard-rules.local.json` (personal overrides).

See `docs/generated/configuration.md` for the full default configuration reference.

**Key configuration sections:**
- `quality_checks` — enable/disable each of the <!-- gen:quality_check_count -->34<!-- /gen:quality_check_count --> PostToolUse checks
- `structural_checks` — enable/disable each of the <!-- gen:structural_check_count -->26<!-- /gen:structural_check_count --> structural checks + thresholds
- `diff_aware` — control which checks suppress pre-existing findings
- `error_memory` — error pattern history with optional embeddings support

## ML Content Scanner — Bidirectional PII/Secret Exfil Guard

A detector-style layer that scans tool-call content with a learned token classifier (default: OpenAI's [privacy-filter](https://huggingface.co/openai/privacy-filter)) and returns canonical `ask` so an ask-capable interactive runner can request human confirmation. Provider rendering is explicit: Claude and supported Cursor gates use native ask; interactive Pi uses `ctx.ui.confirm`; headless Pi and OpenCode's stable tool gate deny, as do other ask-incapable pre-tool surfaces. This is distinct from the generative policy classifier (`src/harness/policy-classifier.ts`) — that one emits free-form verdicts; this one emits structured spans.

**Off by default.** Requires a one-time `pip install opf`. Enable with:

```jsonc
// .interlinked/guard-rules.local.json
{ "content_scanner": { "enabled": true } }
```

### Bidirectional model

The scanner guards exfiltration in both directions:

| Direction | Trigger | What happens | Exfil risk mitigated |
|---|---|---|---|
| **Outbound** (PreToolUse) | Write / Edit / MultiEdit / NotebookEdit content; Bash command body; WebFetch URL + prompt; external MCP tool string args | Scanner runs on each text part; if any span is detected the server returns `ask`. Ask-capable interactive runners prompt; ask-incapable or headless surfaces deny with the categorized reason. | PII being committed to disk, piped to curl, or sent to external services |
| **Inbound** (PostToolUse) | `Read` / `Grep` / `Glob` return payloads | Scanner runs on `tool_response`; detections ratchet `session.sensitivity_level` to `Confidential` (or `HighlyConfidential` for `secret` / `account_number` labels) and push the step index into `pii_detected_steps` | Sensitive data read into agent context → subsequent outbound actions blocked by the existing taint-tracking rules (`network_block_at: Confidential`) without needing the scanner to re-detect anything |

The inbound→outbound chain is the load-bearing integration: once a session reads PII, *every* subsequent network command is blocked by taint tracking even if the outbound command itself has been stripped of PII before send.

### Taxonomy

OPF emits one of eight category labels per detected span (pinned in `OPF_LABELS` in `src/harness/content-scanner/types.ts`):

```
account_number, private_address, private_date, private_email,
private_person, private_phone, private_url, secret
```

Block-reason summaries enumerate every detected category with a count, alphabetical by label — e.g. `[account_number(1), private_email(2), secret(1)]`. Matched substrings are **never** echoed in the reason, to avoid leaking the very content the scanner flagged.

### Runtime backends

| Runtime | Config value | What it does | Ready today |
|---|---|---|---|
| **Local Python sidecar** | `"local"` (default) | Spawns `python -m opf` once, keeps it alive, JSONL protocol on stdin/stdout. Multi-second cold load, ~100 ms – few-seconds warm scans on CPU. | ✅ |
| **HuggingFace Inference API** | `"huggingface"` | HTTP POST to `api-inference.huggingface.co/models/<model>`. Usable today for `gpt-oss-safeguard-20b` and other standard-architecture models. **Not** usable for `openai/privacy-filter` — that model ships a custom architecture requiring `trust_remote_code`. | ✅ for gpt-oss-safeguard; ❌ for privacy-filter on the free tier |
| **Custom HTTP endpoint** | `"custom_http"` | HTTP POST to any endpoint returning HF's token-classification response shape. Use for self-hosted TGI/vLLM, a paid HF Inference Endpoint, or the Interlinked MCP server (when server-proxied inference lands). | ✅ |

See `docs/design/content-scanner-remote-hosting.md` for the deployment playbook and the upcoming server-proxied path.

### Policy: `ask`, not `block`

The scanner emits `decision: "ask"` (not `"block"`) for any finding above `min_score`. Claude Code, supported Cursor gates, and interactive Pi can surface native confirmation; OpenCode's stable tool gate, headless Pi, and other ask-incapable pre-tool surfaces safely render the same decision as deny. This is deliberate: OPF is probabilistic and false-positives on:

- `example.com` and RFC 5322 test addresses in test fixtures
- Code variable names that happen to look like personal names (`alice`, `bob`, `jane_doe`)
- Regex patterns that match phone / email / URL shapes
- Dates in docs (`1990-01-02` eval examples, timestamps)
- Path-like strings (`.scratch/events/foo.json` → `private_url`)

A hard block would trap the agent on legitimate content. `ask` keeps the human in the loop while still attaching the categorized summary as evidence. Operators who want stricter `block`-by-default can fork the policy layer (`src/harness/content-scanner/policy.ts`).

### Two-channel disclosure: agent-safe reason + local-only unmasked file

The `reason` string that surfaces in the confirmation UI is shipped to Anthropic on the agent's next turn (it becomes part of the model's context). That means **anything** the scanner puts in the reason leaks the flagged content back out through the model API — the exact exfil vector the scanner is built to prevent.

The CLI solves this with two channels:

1. **`reason` field (agent-safe)** — sent through the hook protocol, visible to both the user and the model. Contains:
   - The category summary `[private_email(2), private_person(1)]`.
   - A per-source preview with every matched span replaced by `<CATEGORY>` (e.g. `WebFetch.url: https://api.example.com/?email=<PRIVATE_EMAIL>`).
   - A pointer to the local-only pending-prompt file.
   - **Never** contains any matched-span substring.

2. **Pending-prompt file (local-only)** at `.interlinked/scanner/pending/<timestamp>-<hash>.json` — written by the harness, mode `0600`, never transmitted anywhere. Contains the full unmasked content + every detected span with its text. The user opens it from another terminal (`cat`, their editor, etc.) while the approval prompt waits. Pruned after 1 hour.

```
privacy-filter detected sensitive content [private_email(2), private_person(1)].

Preview (PII masked — values replaced with <CATEGORY>):
  WebFetch.url: https://api.example.com/?email=<PRIVATE_EMAIL>
  WebFetch.prompt: fetch <PRIVATE_PERSON>'s profile

Full unmasked content: .interlinked/scanner/pending/2026-04-24T15-42-00-a1b2c3.json
  (local-only — not sent to Anthropic)
```

Self-defending: if the agent tries to `Read` the pending file to recover the values, the PostToolUse Read scan picks up the same PII and ratchets session sensitivity — the file contents flagged the scanner in the first place, so they flag it again on read-back.

The directory is gitignored (`.interlinked/scanner/`); nothing lands in commits.

### Hook points

Per-hook toggles live under `content_scanner.scan_points`; each is `true` by default when the scanner is enabled.

| Toggle | Fires on | Built by |
|---|---|---|
| `write_edit` | Write, Edit, MultiEdit, NotebookEdit, str_replace, apply_patch, create | `extractor.ts` → `resolveProposedContent(…)` from `overlay-content.ts` |
| `bash_command` | Bash, Shell, shell, bash, run_command | `extractor.ts` reads `tool_input.command` |
| `external_egress` | WebFetch, web_fetch, WebSearch, any `mcp__*` tool | `extractor.ts` walks URL + prompt + query + top-level string fields |
| `read_grep_taint` | PostToolUse Read / Grep / Glob | `post-scan.ts` reads `tool_response`, calls `ratchetSensitivity(…)` |

### Performance knobs

All under `content_scanner.local`:

- `startup_timeout_ms` (default 90 000) — first scan includes OPF cold load
- `scan_timeout_ms` (default 30 000) — warm scans on CPU, serialized queue
- `idle_shutdown_ms` (default 30 min) — free the ~1.3 GB resident model after inactivity; next scan re-spawns
- `max_restarts` (default 3) — bounded auto-restart on sidecar crash; after this limit the scanner disables itself fail-open for the session

On Apple Silicon (no MPS in OPF) every scan is CPU-bound. Latency scales with input length and the queue depth; a 15 KB Edit behind other pending scans can take ~10–20 s. For sustained agent workloads, the remote-hosting path (see design doc) is the recommended production configuration.

### Fail-open posture

Every scanner error path — spawn failure, timeout, network error, malformed response, `opf not installed` — returns `allow` (never blocks). Errors are logged to stderr via `[interlinked:opf-local]` so operators can spot timing problems. This matches the rest of the harness's safety-continuity policy: a broken scanner must never wedge an otherwise-working agent.

### Known limitations

- **FP on test fixtures**: `alice@example.com`, Faker-style names, and similar canonical test data will trip the filter. That's a feature (it forces a human review) but creates friction when deliberately writing scanner tests — see `reference-repos/privacy-filter/README.md` "Static Label Policy" note.
- **Secret coverage is narrow**: OPF catches obvious key shapes but may miss project-specific token formats. Pair with a regex-based secret scanner (gitleaks etc.) for defense in depth.
- **Routing numbers, SSNs, credit-card-shaped digits** are inconsistently flagged — OPF's `account_number` class isn't exhaustive. Custom patterns feeding the same policy layer close this gap.
- **CPU-only on macOS.** Upstream OPF ships `device: "cpu" | "cuda"`. Apple Silicon MPS isn't a supported device, so Mac hosts pay the CPU tax.

### Related source files

| File | Purpose |
|---|---|
| `src/harness/content-scanner/types.ts` | `ContentScanner`, `ContentScannerConfig`, `ScanFinding`, `OPF_LABELS` |
| `src/harness/content-scanner/extractor.ts` | Per-tool content extraction (PreToolUse) |
| `src/harness/content-scanner/policy.ts` | Findings → `ask`/`allow` verdict, alphabetical summary |
| `src/harness/content-scanner/sidecar-manager.ts` | Long-running Python subprocess + JSONL protocol |
| `src/harness/content-scanner/sidecars/opf-sidecar.py` | Python daemon wrapping `opf.OPF` |
| `src/harness/content-scanner/opf-local.ts` | `ContentScanner` backed by the sidecar |
| `src/harness/content-scanner/opf-http.ts` | HTTP backend for HF / self-hosted / server-proxied |
| `src/harness/content-scanner/registry.ts` | Factory: config → scanner |
| `src/harness/content-scanner/post-scan.ts` | PostToolUse Read/Grep scan + taint ratchet |

## Future Work (Not Yet Implemented)

- **Server-proxied inference** — MCP server hosts an OPF deployment and the CLI's `custom_http` runtime points at it. See `docs/design/content-scanner-remote-hosting.md`.
- **Auto-checkpointing** — harness triggers git checkpoints before destructive operations or after N tool calls
- **Server-pushed team rules** — workspace owners configure rules via dashboard, harness pulls them
- **Agent loop enforcement** — detect when agent hasn't called `wait_for_work` in 5+ minutes, alert human
