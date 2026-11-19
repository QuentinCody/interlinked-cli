---
name: interlinked-coordination
description: "Coordinate with other agents and humans through the optional Interlinked MCP Server, local checkpoints, and file reservations. Load to pick up or hand off work (`tasks`, `send`, `inbox`, `handoff`), switch workspace (`workspace`, `attach`), when a write is blocked as \"reserved by\" another agent, for `interlinked guard` (git-hook reservations), CI failure rates (`ci-status`), or `checkpoint`/`rewind`/`resume`. WARNING: those three change git state (stash, checkout, clean -fd); run them only with explicit per-turn user authorization."
---

# interlinked-coordination — multi-agent server surface & local checkpoints

The Interlinked CLI is a **local companion**; the **Interlinked MCP Server** is the source of
truth for coordination. Two halves:
- **Server-backed** (needs auth + a reachable server): `tasks`, `send`, `inbox`, `handoff`,
  `workspace`. These are thin wrappers that POST to the server; **they do nothing useful offline**
  (they short-circuit with "Not authenticated. Run: interlinked login"). (`cloud recent` also needs
  a token but via a separate `cloud_governor.url`. `attach` is **not** server-gated — it writes
  config locally and only *best-effort* contacts the server, so it works offline.)
- **Local-only** (offline): `checkpoint`, `rewind`, `resume`, `guard` (git-hook reservation
  checks), `reminder`, `ci-status`, `mcp stdio`, and **automatic file reservations** among
  sibling agents on the same machine.

The whole server half is opt-in. Auth resolution: explicit `--token` → `access_token` in
`config.local.json` (auto-refresh) → Claude Code credentials fallback. **localhost/127.0.0.1
`server_url` skips auth entirely** (dev mode).

## Load this when
- Picking up / handing off work, messaging a peer, or checking your inbox.
- A write was blocked/warned because a file is "reserved by" another agent.
- Switching workspace context.
- Creating or restoring a local checkpoint (**read the git-safety warning first**).
- Installing the git-hook reservation guard, or checking CI failure rates.

## ⚠️ Git-safety (read before any checkpoint/rewind/resume)
`checkpoint`, `rewind`, `resume`, and `git link-checkpoint --apply` **mutate git state** —
`git stash`, detached HEAD updates, `git restore --staged` / `--worktree`, and `git clean -fd`
(discards uncommitted changes + deletes untracked files), or commit amend. Under the standing
rule that **each commit/push/reset/stash/checkout is an independent per-turn ask**, an agent
must **not** run these autonomously — describe and recommend, don't execute, unless the user
explicitly authorizes it this turn. Checkpoint creation retains a snapshot object
and restores the captured index/worktree. Restore verifies its snapshot and base
before forced cleanup.

## Server-backed commands
`tasks`/`send`/`inbox`/`handoff`/`workspace` are auth-gated (`!isAuthenticated &&
!isLocalDevServer` ⇒ error) with no local fallback; `send` + `tasks create/claim/complete` also
require `agent_name` (`interlinked enable --agent <name>` or `INTERLINKED_AGENT_NAME`).
**Exceptions in this table:** `attach` writes config locally and only best-effort contacts the
server (works offline); `cloud recent` gates on `cloud_governor.url` + a token, not `isAuthenticated`.

| Command | Purpose |
|---|---|
| `tasks list` *(default)* `[--status --assignee --priority --limit]` | List server tasks. |
| `tasks create <title> [--description --assignee --priority]` | Create a task. |
| `tasks show <id>` / `tasks claim <id>` / `tasks complete <id>` | Inspect / claim / complete. |
| `send <to> [message] [--file --importance normal\|urgent]` | Message a peer (body from arg or `--file`). |
| `inbox [--all --agent --limit]` | Your messages (unread-only by default). |
| `workspace list` / `workspace switch <ws_…>` | List / select the **registry** workspace (writes `workspace_id`). |
| `handoff <from-agent> <to-agent> [--include-files]` | Send an urgent message with your work-context summary. |
| `attach [--workspace --workspace-key --project --agent --auto]` | Link identity + set **internal MCP** `workspace_key`/`project_key` defaults. |
| `cloud recent [--limit]` | Recent cloud-governor events (a **separate** HTTP surface — reads `cloud_governor.url`, not `/api/ui/call`). |

> **Two workspace notions:** the registry `workspace_id` (`ws_…`, set by `workspace switch`,
> for routing/sync) vs. the internal MCP `workspace_key`/`project_key` (defaults `main`/`main`,
> set by `attach`). Mixing them routes tool calls to the wrong context.

```bash
interlinked tasks list --status open
interlinked tasks claim 42 && interlinked tasks complete 42
interlinked send bob "rebased onto main, pull before you push" --importance urgent
interlinked inbox --all
interlinked handoff alice bob
```

## File reservations — automatic, no `reserve` command

Reservation evidence carries the requesting session, child actor and tool-call identity;
conflict rows also identify the holder when its grant was observed locally. Releases retain
the owner's grant identity. Join this evidence to file-touch records using those keys,
never the display name alone. A reservation expresses ownership of a lease, not proof of
who wrote the file. `harness test` simulates conflicts without granting or releasing leases.
Use **interlinked-observability** for shadow file touches and evidence joins.

Reservations are an **automatic side-effect of writing**, enforced in the daemon (there is no
`interlinked reserve`). On a Write/Edit, over each path the call mutates:
- **No conflict →** optimistic local grant (5-min TTL) + async server confirm. If the server
  rejects/unreachable, the local grant **rolls back** and a `conflict` event is emitted.
- **Conflict, holder is remote (not in your local cohort) → BLOCK:** *"File reserved by <agent>…
  Coordinate via MCP messages."*
- **Conflict, holder is a sibling agent on this machine →** default a **warning** (auto-releases
  ~30s after that agent goes idle); escalates to a block only when the coordination story is
  fully known (≥2 known agents, not a parent↔child pair). Unknown → fails **open** to a warning.

Codex subagents can share the root session id. When their stable `subagent_id` is present,
Interlinked counts each sibling as a distinct local actor and targets activity/leave events by
that id; root-session and thread-id aliases still resolve parent↔child lineage, so ordinary
delegation keeps the lineage exemption instead of being mistaken for an unrelated conflict.

For Codex/Copilot `apply_patch`, "each path" means every patch-section destination plus the
source of every `*** Move to:` operation, de-duplicated in patch order. PreToolUse acquisition and
PostToolUse idle-release scheduling share that exact target list, so a multi-file patch does not
strand all but one lease until its 5-minute TTL.

Multi-path acquisition preflights the whole set before making any new local grant or server
request. If any conflict is blocking, none of the free paths are leased; warning-only sibling
conflicts are skipped and the other free paths still lease. Reacquiring an owned path cancels its
older idle timer before renewal, so an in-flight follow-up edit cannot lose its lease to the prior
edit's 30-second timer.

Auto-release fires ~30s after the last edit (idle) and at session end. **When you hit a
reservation conflict, coordinate via `send`/`inbox` — don't force it**; leases self-heal. (Escape
hatch for the local-lease block: `INTERLINKED_DISABLE_LOCAL_LEASE_BLOCK=1`.) Without an API
client wired in, reservations are a purely local optimistic lease shared across sibling agents —
still useful, just no cross-machine truth.

## Local checkpoints (git-mutating — see the warning above)
Metadata lives in `.interlinked/checkpoints.json` or the configured data directory.
A checkpoint captures HEAD SHA, changed files and a stash object ID. Snapshots are
pinned by `refs/interlinked/checkpoints/<id>` and also retain their ordinary stash
entry. Clearing the ordinary stash list leaves the pinned object available.
Metadata pruning and archiving retain snapshot objects and refs.

An absent metadata file starts an empty history. An existing unreadable file,
invalid JSON or malformed checkpoint record instead stops the operation with its
path; it is never treated as empty. Creation validates metadata before stashing,
and prune/archive cannot overwrite a malformed ledger. Preserve and repair the
existing metadata before retrying rather than deleting it to clear the error.

Restoration stops when Git cannot determine the working-tree status or check out
the checkpoint's base commit. `rewind` reports the error before applying a stash.
Archiving beyond the active-checkpoint capacity retires the oldest checkpoints
first, retaining the newest eligible checkpoints.
Stored base commits used by restore/compare must be full SHA-1 or SHA-256 object
IDs. Inventory and retention commands preserve existing metadata for repair.
Restore verifies the commit object before forced cleanup. Input-bearing Git
operations pass literal argument arrays, including structured stash messages.
It also verifies snapshot/index/untracked trees, their paths and matching base. Legacy stored object
IDs and message-based lookup remain supported. Missing or inconsistent data fails
before forced cleanup. Capture, source-tree restoration and untracked cleanup
exclude owned state in both the index and worktree, including tracked configuration
and checkpoint history. Detaching HEAD preserves the original branch tip.
`checkpoint prune --older-than` and `--keep-latest` require positive safe integers.
Invalid explicit values fail before metadata mutation.

| Command | Effect |
|---|---|
| `interlinked checkpoint [message]` | Captures source changes with `git stash push`, pins the object, and restores captured worktree/index trees while excluding owned state. A clean source tree creates metadata-only history and preserves older user stashes. Git discovery failures stop before writing history. |
| `checkpoint list` / `show <id>` / `compare <id1> <id2>` | Metadata/diff-stat only — **no git mutation**. |
| `checkpoint prune [--older-than --keep-latest]` / `archive` | Rewrite metadata only (stash cleanup deliberately skipped). |
| `interlinked rewind [id] [--force]` | Refuses a dirty tree without `--force`. Preflights the base and snapshot trees, detaches HEAD without moving the original branch, and restores source index/worktree/untracked paths. Forced cleanup preserves tracked and untracked owned state. |
| `interlinked resume [id]` | Non-destructive on a dirty tree, **but still `git checkout <base>` (detaches HEAD) on a clean tree**; then best-effort server work-context. |
| `interlinked git link-checkpoint --apply` | **Amends HEAD** to link a server checkpoint (rewrites the commit). |

Git link apply resolves its selected commit and HEAD before server work and
rechecks them before local mutation. The selected commit must resolve to HEAD.
Amend and notes subprocesses use literal arguments. Required message/identity
discovery failures and incomplete writes exit nonzero with `applied:false`.
JSON includes `apply_error` when a local apply step fails. A notes failure after
amending leaves the new commit identity in the result for recovery.
Explicit checkpoint IDs must be complete positive safe integers. Omitting the
ID retains the latest-checkpoint lookup, and an explicit blank ID fails.

## `interlinked guard` — git-hook reservation enforcement
A separate git pre-commit/pre-push hook (not the PreToolUse daemon guard):
```bash
interlinked guard install --mode warn|block [--pre-push]   # writes the hook, sets guard_mode
interlinked guard check --files <paths…>                   # diff staged files vs active reservations; exit 1 in block mode on conflict
interlinked guard status | uninstall
```
`guard check` uses a **5-min stale cache** when the server is down (warns loudly) — results can
be outdated.

## `ci-status`, `reminder`, `mcp`
- `interlinked ci-status [--limit --branch]` — shells out to `gh run list` (needs the GitHub
  `gh` CLI, **not** the Interlinked server); aggregates per-workflow failure rate. "This step
  failed 7 of the last 10 pushes" before you push.
  A failed gh process or malformed response exits nonzero. A successful empty array
  remains an empty run collection. Limit text must be a complete safe integer, and
  accepted integers retain the existing 1–100 clamping.
- `interlinked reminder add --glob <p> --message <t> [--ops Edit,Write,Read] [--team]` /
  `reminder list` / `reminder remove` — file-touch reminders that warn when a matching file is
  edited.
- `interlinked mcp stdio --server <name> -- <command…>` — a local **recording proxy** that
  spawns a real stdio MCP server and records its JSON-RPC traffic for observability. **There is
  no `mcp serve`; it does not expose Interlinked's own tools.** The real MCP Server is the remote
  Worker reached over HTTP by the server-backed commands above.
  Set `--inline-limit <bytes>` to a non-negative decimal integer through
  9007199254740991. Zero sends every nonempty payload to blob storage. Invalid
  values fail before the server starts.

## Common workflows
- **Pick up a task:** `tasks list --status open` → `tasks claim <id>` → work → `tasks complete <id>`.
- **Hand off:** `handoff <me> <peer>` (urgent message + work-context), or targeted `send`.
- **Reservation conflict:** coordinate via `send`/`inbox`; don't force — leases self-heal.
- **Local safety net before risky work:** propose `interlinked checkpoint "before refactor"` —
  but **get the user's OK first** (it stashes). Restoring is git-mutating → explicit ask.

## Gotchas
- Server commands have **no offline fallback** (unlike `status`/`doctor`/`activity`) — they just
  print "Not authenticated" / "Server error".
- `handoff --include-files` and `inbox --since` are accepted but currently **inert**.
- Hook activity posts and the reservation server-confirm are fire-and-forget (rejection now
  rolls back, not silently).

## Related skills
- **interlinked-setup** — `login` / `attach`, sync modes, server config.
- **interlinked-observability** — `watch` (server poll), activity the hooks capture.
- **interlinked-harness** — the PreToolUse daemon guard (distinct from `interlinked guard`).
