# Interlinked CLI — Architecture

For user workflows and command playbooks, start with:
- `docs/how-to-use.md`
- `docs/command-reference.md`

## 1. Vision

The Interlinked platform has two components with distinct roles:

**Interlinked MCP Server** (Cloudflare Workers + Durable Objects)
- System of record for multi-agent coordination
- Manages workspaces, projects, agents, messages, tasks, file locks
- Provides the MCP protocol interface that AI agents connect to
- Hosts the web UI (dashboard, chat, map)

**Interlinked CLI** (this tool)
- Local glue that covers what a remote MCP server cannot touch
- Captures the events that configured Claude Code, Codex, Copilot CLI, Gemini
  CLI, Cursor, OpenCode, and Pi integrations actually deliver
- Stores activity locally for offline use
- Syncs activity to the Interlinked MCP Server for cross-agent visibility
- Provides developer-facing observability (status, explain, activity)

The activity log is the **shared coordination substrate** — each event delivered
to the running harness is timestamped, stored locally, and can optionally be
synced to the Interlinked MCP Server where it becomes queryable by other agents
and visible to humans. It is not proof of actions a provider never exposed or a
hook never delivered.

### What the CLI is NOT

Interlinked CLI is not a replacement for Interlinked MCP Server and is not an alternate control plane to bypass MCP. The server remains authoritative for messages, tasks, file locks, workspace state, and agent records.

The CLI includes convenience wrappers (`workspace`, `tasks`, `inbox`, `send`, `handoff`) for human/operator workflows, but these wrappers call server APIs and do not replace MCP/DO coordination logic.

### Inspiration: Entire CLI

The local-first, hook-driven architecture draws inspiration from [Entire CLI](https://github.com/entireio/cli), which captures AI agent sessions via git hooks and stores them on a shadow branch. Key differences:

| Aspect | Entire CLI | Interlinked CLI |
|--------|-----------|----------------|
| Storage | Git branches (local) | JSONL files (local) + SQLite DO (remote) |
| Transport | Git push | HTTP POST to Interlinked MCP Server |
| Scope | Single agent, single repo | Multi-agent, multi-workspace |
| Data model | Session transcripts + checkpoints | Activity events (tool calls, errors, sessions) |
| Server | None (git remotes only) | Interlinked MCP Server with full coordination suite |

## 2. Command Inventory

| Command | Purpose | Server? | Category |
|---------|---------|---------|----------|
| `enable` | Install hooks into AI coding clients, create `.interlinked/` config | No | Setup |
| `disable` | Stand the harness down; hooks and config remain unless `--uninstall` is passed | No | Setup |
| `login` | OAuth PKCE browser flow for server authentication | Yes | Setup |
| `setup` | One-command bootstrap (`enable` + conditional `login`) | Optional | Setup |
| `status` | Local-first dashboard: sessions, activity, sync, server health | Optional | Observability |
| `activity` | Activity feed merging local JSONL + server data | Optional | Observability |
| `explain` | Narrative timeline of agent actions from activity log | Optional | Observability |
| `sync` | Manual batch sync of buffered events to server | Yes | Sync |
| `doctor` | Diagnose config, hooks, auth, and server issues | Optional | Maintenance |
| `caps` / `metrics` | Configure tighten-only quality water-lines and inspect current measurements | No | Quality |
| `simplify scan|review|audit|status` | Collect, optionally record, and inspect advisory simplification evidence | No | Quality |
| `debt markers` | Scan or explicitly snapshot source-owned design-debt ceilings and triggers | No | Quality |
| `impact` | Render evidence-classed simplification, lifecycle, worktree, and experiment facts | No | Observability |
| `semantic` | Explicitly install a pinned local embedding model and build/query the experimental function index | No | Local retrieval |
| `clean` | Remove stale sessions, truncate large logs | No | Maintenance |
| `reset` | Nuclear: remove all Interlinked CLI config and hooks | No | Maintenance |
| `workspace` | List/switch workspaces on the remote server | Yes | Workspace |
| `inbox` | Read server messages | Yes | Messaging |
| `send` | Send server message to an agent | Yes | Messaging |
| `tasks` | Task list/create/show/claim/complete wrappers | Yes | Tasks |
| `handoff` | Explicit agent-to-agent handoff helper | Yes | Tasks |
| `checkpoint` | Manage local Git checkpoints | No | Checkpointing |
| `rewind` | Restore working tree from checkpoint | No | Checkpointing |
| `resume` | Resume context from checkpoint | No | Checkpointing |
| `trace` | Export/import local activity trace | No | Interop |
| `completions` | Shell completions script output | No | UX |
| `version` | Show CLI version + server reachability | Optional | UX |

"Server?" indicates whether the command requires server connectivity. "Optional" means the command works offline with graceful degradation.

## 3. Auth Model

### Token Resolution (multi-source priority)

For API-wrapper commands (`workspace`, `inbox`, `send`, `tasks`, `handoff`, `version`), `resolveAuthTokenWithRefresh()` checks:

1. **CLI's own token** from `.interlinked/config.local.json` (`access_token` field)
2. If expired and refresh is available, **refresh token** at `POST /token` (`grant_type=refresh_token`)
3. **Claude Code credentials fallback** from `~/.claude/.credentials.json` -> `mcpOAuth` object — matches by `mcp_prefix` against config key prefix, or by `serverName` containing "interlinked"

For hook posting and `sync`, token resolution uses `resolveAuthToken()` (no refresh step in that path): CLI token first, then Claude Code fallback.

### OAuth PKCE Login Flow

The `login` command implements a full OAuth 2.1 PKCE flow:

1. Generate `code_verifier` (32 bytes, base64url) and `code_challenge` (SHA-256)
2. Dynamic Client Registration at `POST /register` (RFC 7591)
3. Open browser to `/authorize` with PKCE params and `resource=serverUrl`
4. Local HTTP callback server receives authorization code
5. Exchange code for tokens at `POST /token`
6. Save tokens to `config.local.json`

The CLI also stores `oauth_client_id` locally so refresh can include client identity when required by the authorization server.

### Dev Mode Bypass

When `server_url` is `localhost` or `127.0.0.1`, auth is skipped entirely. The server has a dev mode that accepts unauthenticated requests.

### Multi-Server Isolation

`config.local.json` supports a `servers` map with an `active_server` key. Each server entry has its own `server_url`, `workspace_id`, and `mcp_prefix`. This prevents token/workspace cross-contamination between dev and production environments.

## 4. Activity Log as Shared Substrate

### Event Capture Pipeline

```
Configured provider hook or managed bridge
    |  (only events that provider surface delivers)
    v
Packaged runtime (dist/hook-entry.js)
    |  normalize provider payload + call the repo daemon
    v
Interlinked Harness (Unix socket)
    |
    +--> Persist delivered activity and session/timeline state under .interlinked/
    |
    +--> Pre-tool: return the provider-specific allow / block / ask response
    |
    +--> Post-tool: record the landed change and schedule external checks
    |     +-- compiler/linter work runs asynchronously after the write
    |     +-- findings are spooled and delivered once through a model-visible hook
    |     +-- unavailable work is reported as NOT CHECKED, never as clean
    |
    +--> Optional buffered sync to the Interlinked MCP Server
```

Hook-array providers and the OpenCode/Pi managed bridges converge on the same
packaged runtime and daemon event loop. A generated
`.interlinked/hooks/interlinked-activity.mjs` may remain for compatibility with
legacy installs, but it is not the canonical adapter runtime.

### Event Normalization

The packaged runtime normalizes delivered events from different AI clients into
a common shape:

```json
{
  "ts": "2026-02-16T10:30:00.000Z",
  "agent": "claude-code",
  "type": "tool_use",
  "tool": "Edit",
  "summary": "src/index.ts",
  "session": "session-abc123",
  "hook": "PostToolUse"
}
```

| Client | Registered Events (2026-08-30) | Hook Mechanism |
|--------|-------------------------------|----------------|
| Claude Code | 14 events (`WorktreeCreate` is a hard policy stop; `PostToolUseFailure` remains parse-only to avoid duplicate post-hook reporting) | `.claude/settings.json` hooks |
| Codex | 12 events (complete native surface, including permission, compaction, subagent, interruption, and session-end hooks) | `.codex/hooks.json` + `[features] hooks = true` in config.toml |
| Cursor (experimental) | 18 events | `.cursor/hooks.json` |
| Copilot CLI (experimental) | 6 events | `.github/hooks/hooks.json` |
| Gemini CLI (experimental) | 9 events | `.gemini/settings.json` hooks |
| OpenCode (experimental) | 11 installed plugin callbacks; stable permission/Stop signals are observation- or deny-only | managed `.opencode/plugins/interlinked.ts` |
| OpenCode v2 (`opencode2`, experimental) | 5 plugin hooks (`tool.execute.before/after`, `session.created/deleted/idle` via `event.subscribe`); ask collapses to deny | managed `.opencode/plugins/interlinked-opencode2.ts` |
| Pi (experimental) | 13 extension callbacks, including `tool_call`, `tool_result`, and direct `user_bash` | managed `.pi/extensions/interlinked.js` |

Runtime reporting derives from the adapters' `nativeEventNames` lists
(`installedEventsFor`); the dated table above and the parity regression tests intentionally
pin expected SNAPSHOTS of those lists so drift is visible, and they carry their date for the
same reason. Claude Code and Codex are the supported provider-contract pair. Copilot,
Gemini, and Cursor remain experimental because their end-to-end provider contracts are not
proven. OpenCode, OpenCode v2, and Pi have managed-bridge execution tests, but also remain experimental:
their upstream extension APIs expose a narrower native control surface than Claude/Codex. OpenCode v2 stays experimental until a real-host acceptance test passes.

All adapters share the capability and envelope layer described in
[`docs/design/cli-hook-normalization.md`](design/cli-hook-normalization.md). Unknown
lifecycle events route to an observation-only RPC instead of falling through to
the pre-tool evaluator. Every adapter execution writes a provider row to
`.interlinked/hook-runtime.json`; doctor currently uses Codex's definition hash as the
enforced trust proof for the current project hooks.

OpenCode and Pi are installed as whole-file managed bridges, not settings fragments. OpenCode
must be restarted to load `.opencode/plugins/interlinked.ts`. Pi loads
`.pi/extensions/interlinked.js` after `/reload` or restart and requires the provider's project
extension trust approval. Hash ownership makes both paths collision-safe: install refuses a
foreign file and uninstall preserves a bridge whose bytes changed after installation.

The OpenCode stable plugin API can hard-deny `tool.execute.before` but cannot launch native
confirmation there, so `ask` becomes deny. `session.idle` is a Stop observation with no
continuation/veto contract. Pi can confirm `ask` through `ctx.ui.confirm` in interactive mode;
headless Pi denies, and `user_bash` covers commands launched outside the model tool loop. Neither
managed bridge has dedicated native MCP, subagent, or worktree lifecycle hooks.

Agent-created worktrees are disabled by default. Claude's native
`WorktreeCreate` replacement hook refuses creation before its default Git path
runs. OpenCode and Pi have no equivalent native replacement event, so the shared shell guard
is their enforcement path for `git worktree add`, as it is for every client.
Existing worktrees can still be listed and removed.

### Local Storage Layout

```
.interlinked/
+-- config.json            # Shared team config (committed)
+-- config.local.json      # Personal config + tokens (gitignored)
+-- activity.jsonl         # Append-only event log (gitignored)
+-- realtime-retry.jsonl   # Realtime POST retry buffer (gitignored)
+-- sync-errors.jsonl      # Sync/retry diagnostics log (gitignored)
+-- sync-state.json        # Byte-offset sync cursor (gitignored)
+-- hook-runtime.json      # Provider hook-execution receipt (gitignored)
+-- sessions/              # Per-session state files (gitignored)
|   +-- session-abc.json
|   +-- session-def.json
+-- hooks/
    +-- interlinked-activity.mjs  # Legacy compatibility runtime (gitignored)
```

### Server-Side Storage

Events synced to the server are stored in the `agent_activity` table within the Workspace Durable Object's SQLite database:

```sql
agent_activity (
    id, agent_id, workspace_id,
    event_type, tool_name, tool_input_summary,
    occurred_at, duration_ms
)
```

Queryable via the `query_activity_feed` MCP tool (available in `extended` tier and via the Code Mode SDK).

## 5. Sync Architecture

### Three Sync Modes

| Mode | Description | Hook: local write | Hook: POST | Session end: batch sync |
|------|-------------|-------------------|------------|------------------------|
| `realtime` (default) | Best-effort real-time + retry buffer + reliable on session end | Always | Yes | Yes |
| `local` | Offline-only, no server communication | Always | No | No |
| `manual` | Best-effort real-time, sync manually when ready | Always | Yes | No |

Set via: `interlinked enable --sync-mode <mode>` or edit `config.local.json`.

### Byte-Offset Cursor

The sync system uses a byte-offset cursor (`sync-state.json`) rather than event IDs:

```json
{
  "synced_through_bytes": 48230,
  "last_sync_at": "2026-02-16T10:30:00.000Z"
}
```

This enables efficient partial reads: `openSync` + `readSync` from the cursor position to EOF, without scanning the entire JSONL file. The cursor only advances after a successful batch sync (all batches return 2xx).

### Batch Sync Protocol

Events are pushed to `POST /api/hooks/activity/batch` in chunks of 100:

```json
{
  "events": [
    { "agent_name": "...", "event_type": "...", "tool_name": "...", "tool_input_summary": "...", "occurred_at": "..." }
  ]
}
```

The server deduplicates events (same agent + tool within a 1-second window is skipped) and prunes records older than 24 hours.

### Deduplication Strategy

When local and server activity are merged for display (`activity` and `explain` commands), `mergeAndDedup()` uses a composite key: `${agent}|${type}|${tool}|${2-second-bucket}`. Server events are authoritative — if a local event matches a server event, the server version is kept.

## 6. Offline-First Design

Every command works without server connectivity:

| Command | Offline behavior |
|---------|-----------------|
| `status` | Shows local sessions, activity, sync status. Server section shows "unreachable". |
| `activity` | Shows local JSONL events only. Notes "server unavailable" in output. |
| `explain` | Builds narrative from local events only. |
| `sync` | Fails with clear error: "Cannot reach server at {url}". |
| `doctor` | Runs all local checks. Server checks report "unreachable". |

The running daemon persists events it receives before optional buffered sync.
Detached lifecycle delivery and asynchronous PostTool results can appear shortly
after the originating provider action, and the cold fallback is not a complete
capture path; readers should treat the log as durable evidence of delivered,
persisted events rather than a universal transcript of agent activity.

## 7. Config System

### Two-Tier Design

| File | Purpose | Git behavior | Read by |
|------|---------|-------------|---------|
| `config.json` | Team-shared settings: `server_url`, `default_project` | Committed | CLI + hook script |
| `config.local.json` | Personal: tokens, agent name, workspace, sync_mode, multi-server map | Gitignored | CLI + hook script |

### Multi-Server Support

```json
{
  "active_server": "production",
  "servers": {
    "production": {
      "server_url": "https://interlinked.example.workers.dev",
      "workspace_id": "ws_abc123",
      "mcp_prefix": "Interlinked-production"
    },
    "local": {
      "server_url": "http://localhost:8787",
      "workspace_id": "ws_dev456"
    }
  }
}
```

`resolveConfig()` merges both files and resolves the active server entry into a flat config object.

## 8. Harness Server (Guard + Lifecycle + Auto-Reservation)

The CLI includes a local harness server (`src/harness/`) that evaluates agent actions in real-time. It runs as a Node.js process with a repo-scoped legacy raw socket (`.interlinked/harness.sock`) and, in the default dual-protocol mode, a framed RPC front door (`.interlinked/harness-<session>.sock`, falling back to `.interlinked/harness-default.sock`).

**Full documentation: `docs/harness.md`** — includes architecture, design decisions,
guard behavior, and testing instructions.

### Key Architectural Choices

1. **Node.js on Unix socket** (not HTTP, not inline) — sub-5ms evaluation latency, stateful trajectory tracking, agent-agnostic
2. **PreToolUse blocking + asynchronous PostToolUse feedback** — fast deterministic checks can block before execution; external compiler/linter work runs after the write and its spooled findings are delivered once through a later model-visible hook
3. **Optimistic file reservation** — check local cache (instant), confirm with server (async), 30s auto-release
4. **Agent cohort model** — tracks all agents for one developer, distinguishes "my agent" from "other developer's agent"
5. **Sleep/terminal prevention** — enforces MCP-first communication (agents should use `wait_for_work`, not `bash sleep`)
6. **Graceful degradation** — falls back to inline pattern matching when harness is unavailable

### Harness Protocol State Model

The current design uses a **single repo daemon with per-session framed sockets**.
One long-lived `server.ts` process owns cohort state, reservations, project graphs,
route maps, error history, classifier state, activity/latency logging, and async
analysis. The packaged `dist/hook-entry.js` adapter runtime uses the framed path;
`session-daemon.ts` is a thin dispatcher in that same process. Raw compatibility
traffic is converted into the same `HarnessEvent` path, so both transports share
runtime side effects. A true per-session state split would require a separate
coordinator or durable on-disk locking for reservations and cohort awareness.

### Inspiration

The harness architecture draws from [Sondera](https://github.com/sondera-ai/sondera-coding-agent-hooks) (Cedar policies, YARA signatures, Unix socket harness) and [Entire CLI](https://github.com/entireio/cli) (local-first capture, git-native checkpoints). The key differentiator is server coordination — the harness syncs file reservations and guard events with the Interlinked MCP Server for team-wide visibility.

## 9. Function-size enforcement and local semantic retrieval

The Interlinked CLI now has two intentionally separate function-level surfaces:

1. The hard `max_function_tokens` quality metric uses the versioned
   `interlinked-code-v1` canonical code lexer. The shipped cap is inclusive at
   500, may only ratchet downward, and has exact TypeScript/JavaScript and
   Python adapters. Pre-existing over-cap functions may hold or shrink, but a
   new over-cap function or growth above the water-line blocks. Unsupported
   languages fail open with a visible not-measured result; embeddings never
   participate in this decision.
2. The optional `semantic` command group canonicalizes complete function
   inputs, counts with the selected model's actual tokenizer, directly embeds
   inputs that fit, and syntax-chunks/aggregates longer inputs. It publishes
   immutable, hash-verified generations under
   `.interlinked/index/functions/`; `CURRENT` changes only after the metadata,
   JSONL function rows, and little-endian float32 vectors validate.

`interlinked metrics` reuses the exact cap adapters for a read-only repository
census. Its JSON report contains every measured function plus per-file
`summedFunctionTokens`, distributions, percentiles, and deterministic function
and file outliers. The sum is nested-inclusive by design rather than a unique
whole-file lexical count. Default discovery matches the hard-cap product scope;
`--include-tests` adds test/spec functions as advisory measurements. Product
files whose extension has no exact adapter remain visible as not measured,
including in a bounded normal-output preview; vendored and markup/data paths
are excluded by the shared cappable-file policy, as are documentation and
configuration, dependency/build, binary, and runner tool-state artifacts,
rather than disappearing at the analyzer layer. Its cap-specific discovery
keeps hidden product source and files above the ordinary verify walk's size
limit in the classification universe.

The initial experimental registry entry pins an Apache-2.0 Nomic Embed v1.5
GGUF artifact by repository revision, byte count, and SHA-256. Download is
authorized only by `interlinked semantic install`; ordinary commands, setup,
hooks, and the daemon never auto-download weights. Inference uses optional
local llama.cpp `llama-embedding` and `llama-tokenize` executables. There is no
cloud fallback, repository model code execution, semantic blocking rule, or
sync of source-derived vectors and queries to the Interlinked MCP Server.

Search exact-scans cosine similarity and binds each generation/result to the
full model/runtime/input/chunk-policy fingerprint. A stale generation remains
queryable with an explicit warning; corrupt and fingerprint-mismatched
generations are refused. Automatic daemon idle indexing and hybrid retrieval
remain deferred while the feature is experimental. See
`docs/semantic-index.md` and plan 29 for the operator and design contracts.

## 10. Relationship to Entire CLI

The local-first, hook-driven architecture draws inspiration from Entire CLI. Both projects share the philosophy that AI agent activity should be captured locally, durably, and transparently. The key divergence is scope: Entire captures session transcripts for single-agent, single-repo workflows; Interlinked MCP Server + Interlinked CLI capture activity events for multi-agent, multi-workspace orchestration.
