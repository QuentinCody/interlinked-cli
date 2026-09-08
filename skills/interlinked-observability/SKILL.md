---
name: interlinked-observability
description: "Investigate agent activity and JSONL/gzip evidence. Load for data scan, catalog/health/index/search/show/investigate, storage-engine experiments and benchmarks, native transcript comparisons, file/session history, capture gaps, lossless rotation, audit integrity, and evidence-backed handoffs. Also covers activity, logs, impact, trace, recurrence, viz, collect, compact, and optional sync. Missing capture is not absence; correlation is not causation."
---

# interlinked-observability — inspect what agents did

## Search and organize all local evidence

When history can help diagnose a failure or explain prior work, use the logs as evidence:

1. Establish scope: project, session/call or file, and time window. Read `data status --json`
   and `data health --json` before interpreting missing results.
2. Choose the storage cost deliberately. `data scan` reads JSONL/gzip directly without an
   index or corpus copy. If an existing index is appropriate, explicitly run `data index`
   for stale sources; its import budget does not limit total disk growth. Report coverage.
3. Search with exact filters and a small `--limit`; correlate relevant records with
   `data investigate`, then retrieve supporting IDs with `data show ID --json`.
4. Report what was observed, the evidence IDs and hash-verification result, and capture or
   search limits. Recheck the current code before claiming an old failure is fixed.

Read [evidence investigation workflows](references/evidence-workflows.md) for task-specific
recipes, source selection, pagination, and a concrete handoff checklist. Prefer bounded JSON
results over dumping whole logs into context. Evidence payloads may contain user/code content;
retrieve only relevant records and keep local evidence local unless sharing is authorized.

Read [storage experiments](references/storage-evaluation.md) to compare direct scans, native
Claude snapshots, legacy/compact/bounded SQLite, compressed segments, and the experimental
Cloudflare path. `data lab` always uses explicit corpus/output directories. Its portable
literal queries, FTS token queries, and raw `rg` searches have distinct semantics.

```bash
interlinked data scan "compiler import" --source check-results --max-mb 32 --limit 10 --full-text --raw --json
```

Direct scans default to 32 MiB expanded input and 25,000 physical lines, taking complete-line
prefixes of the most recently modified files. They include retained gzip archives and numeric
rotations. A narrow time filter does not jump to a newer portion of a large file. Inspect
`coverage.complete` and `scope`; increase explicit budgets or choose an existing index when
necessary. `--raw` returns the observed source text with its hash. Scan/lab IDs are separate
from production `data show` IDs. File filters for `data scan` use project-relative paths.
Use `--full-text` when omission by the bounded index projection matters: it searches all
decoded string values inside each readable complete record, excluding JSON field names.
Byte/line budgets and oversized-record limits still apply. Without this flag, a complete scan
with `coverage.truncated > 0` does not establish that a term is absent from original payloads.

Use `interlinked data catalog` to discover registered and unknown JSONL files recursively,
including numeric rotations and gzip archives. `data health` distinguishes observed writes,
unsupported/disabled/idle producers, failures, and unmeasured populated files. Its receipt
window is bounded; a quiet event-driven feed is not automatically broken. `doctor` reports
capture failures and unmeasured coverage.

```bash
interlinked data index --max-mb 256 --max-records 250000 --json
interlinked data status --json
interlinked data search "compiler import" --since 7d --json
interlinked data search --source check-results --session SESSION --json
interlinked data show RECORD_ID
interlinked data investigate --session SESSION --json
interlinked data investigate --file src/app.ts --json
interlinked data checks --check typescript --json
interlinked data usage --session SESSION --json
interlinked data suggestions --json
interlinked data recurrence-inventory --json
```

Indexing is incremental and bounded: repeat until the retained backlog is covered. `--rebuild`
clears only derived tables. SQLite/FTS5 loads lazily; use a Node runtime with built-in SQLite
(Node 22.13+ avoids needing the earlier experimental flag). Search includes retained archives;
`--no-archives` restricts it to live files. `--fts` opts into FTS5 query grammar. Structured
filters include source/category/session/actor/provider/model/file/check/call/kind/decision/origin.
Unknown event timestamps are excluded by time bounds. The older `query` command scans a
bounded physical tail of one file and reports its scope; it does not promise archive coverage.

Each indexed answer carries a record ID; `data show` retrieves the original JSON and verifies
its SHA-256. Projection text/field traversal is bounded, and oversized or malformed rows are
reported without deleting their raw bytes. Check `data status` for freshness and parse failures.
Exact duplicate raw records within one logical source share an indexed record but retain all
physical locations. Cross-stream observations are not automatically independent executions.

`data sessions/files/checks/usage/schema/suggestions` expose evidence aggregates. `investigate`
correlates exact provider/session/actor/call identities and labels missing phases; a file filter
also strictly folds the obligations ledger. A block count is not a prevented-defect estimate.
Suggestion `shown` means selected for presentation, not acknowledged; later absence is an
observation, not proof of a fix. Usage has unknown values and no invented prices; never add
overlapping timeline and costs totals. Recurrence inventory is separate from incident counts.
Aggregate limits bound returned groups, not necessarily database work; narrow supported
filters first. `schema` is a source-wide observed field census: only `--source` and `--limit`
affect its scope, even though its CLI accepts the shared filter flags.

`data maintain` previews retention. `data maintain --execute --compact --no-index` losslessly
rotates eligible collection/timeline history without opening or creating SQLite. Add `--index`
to explicitly import a bounded batch and translate existing evidence pointers during rotation.
Without either index flag, indexing follows `auto_index`. It never deletes evidence or
automatically compacts activity/state ledgers/corpora.
Activity still requires the existing cursor-aware `compact` workflow. After an external
compactor, rerun `data index` to discover replacement files and archives.

Preserve evidence indefinitely: do not delete, expire, truncate, sample away, or rewrite raw
records, archives, manifests, or integrity checkpoints to reclaim space or hide bad rows.
Lossless rotation changes physical placement while retaining every record. A smaller live
file is not less retained history. Search archives with `data search`; older live-file readers
cannot answer questions about the complete retained history. `--rebuild` replaces derived
index tables only and is not a routine retention operation. Index storage can exceed raw-log
storage substantially; the per-pass import budget is not a cap on total index size.

Rotation prepares the bulk retained suffix before acquiring the append lock. Identity is
rechecked under the lock, and only a bounded catch-up plus the atomic rename exclude writers.
An excessive append burst or competing replacement aborts safely for retry. Maintenance
operation failures are recorded in capture health.

`data configure --auto-index on` opts into bounded SessionEnd background indexing;
`--auto-compact on` independently enables collection/timeline rotation. Both default off;
enabling rotation alone does not enable or run the SQLite importer.
Defaults are 256 MiB/250,000 records per pass, a 256 MiB rotation threshold, and a 64 MiB live
tail. Configure via `--index-mb`, `--index-records`, `--compact-at-mb`, `--keep-live-mb`.
Settings live in `data.config.json` under the resolved data directory; capture itself continues
independently. Load new daemon capture code through the normal build/reload workflow.
SessionEnd is an actual provider lifecycle event, not each assistant Stop. This automation
does not continuously watch files or refresh a long-running active session on a timer. Run an
explicit index pass when recent evidence matters; a deferred background job is not freshness.

`data audit diagnose` locates the first historical failure by physical source/offset and does
not infer tampering intent. After investigation, `data audit checkpoint --reason TEXT` records
an explicit payload-verified live observation boundary. `data audit verify --checkpoint ID`
checks subsequent retained evidence, including after rotation. The historical verdict stays
unchanged; checkpoints never rewrite or reset the old chain.

The bundled [workflow reference](references/evidence-workflows.md) is available in installed
skills. In the Interlinked CLI source repository, `docs/data-observability.md` and
`docs/generated/data-catalog.md` provide the operator contract and generated source catalog;
in another project, use `data catalog --json` to inspect its sources.

Interlinked captures normalized tool-call events that configured Claude Code,
Codex, Copilot CLI, Gemini CLI, Cursor, OpenCode, and Pi integrations deliver —
locally via hooks, offline-first, into append-only JSONL under `.interlinked/`.
The running daemon persists those delivered events. Detached lifecycle events and
asynchronous PostTool findings can arrive after the originating provider action,
and a cold fallback is not a complete capture path, so the log is evidence of
events already delivered and persisted—not a synchronous transcript of every
agent action. You can answer *what did I (or a parallel agent) just do? what ran,
on what files, with what tokens? what did the guard block? what mistakes keep
recurring?* — **all without a server** (the server is optional enrichment).

## Load this when
- "What did I / another agent do this session?" — or you want to tail activity live.
- Reviewing what the guard blocked or warned.
- Finding recurring mistakes to harden against.
- Reporting recorded local changes without turning correlation into a savings or causal claim.
- Inspecting a specific session, event, or the repo dependency graph.
- Backfilling external (Codex) sessions, verifying the audit log, or syncing to the server.

## Command surface
Output-mode flags are **per-command** (not uniform); all support `--json`. `--since` grammar is
strict: `\d+(s|m|h|d)` (e.g. `30m`, `2d`) — `15` or `1.5h` throw.

**Dashboard / feed**
| Command | Purpose | Key flags |
|---|---|---|
| `status` | Local-first dashboard: sessions, recent activity, sync + optional server health | `--watch [s]` · `--short --full --json` |
| `activity` | Recent feed (local+server merged/deduped, token/cost totals) | `--agent --limit --since` · `--json` |
| `impact` | Evidence-classed local git, dependency, baseline-fold, activity, and findings facts | `--base <ref>` (def `HEAD`) · `--short --full --json` |
| `logs` | View/tail **local activity.jsonl** (offline, no server) | `-f/--follow --agent --tool --type --since --limit --raw` · `--json --short` |
| `explain` | Narrative chronological timeline + agent/human line-attribution | `--agent --since` (def 1h) `--full` · `--json` |
| `watch` | **Server** poll: unread messages, pending tasks, active agents (diffs between polls) | `--interval` (def 10s) · `--short --json` |

**Event log & raw**
| Command | Purpose |
|---|---|
| `telemetry [-f] [--limit] [--spool <p>]` | Tail the raw guard telemetry spool (`offline-spool.jsonl`: `hook_decision` rows). |
| `trace export [--since --agent --output --format json\|jsonl]` / `trace import <file>` | Export/import a portable agent-trace (dedups). |
| `collect [--provider codex --since --dir --dry-run]` | Fold Codex rollout history (`~/.codex/sessions/`) into `timeline.jsonl`; live Codex hooks capture the twelve native lifecycle/tool events. |
| `search <query> [--path --glob --type --limit --context --engine]` | Local codebase search (ripgrep, native fallback; multi-term → OR + density rank). |

`collect` retains only the bounded incoming Codex candidate batch (at most
250,000 records / 64 MiB; each rollout file is capped at 64 MiB) and streams
the existing timeline to remove already-seen keys. A corrupt, oversized-row,
or unreadable destination timeline is an error, not an empty history: the
command exits nonzero without appending duplicates. Full timeline rebuilds are
an in-memory sort and therefore explicitly refuse inputs or existing snapshots
over 250,000 records / 64 MiB instead of exhausting application memory.

**Audit & maintenance**
| Command | Purpose |
|---|---|
| `audit verify` | Verify the **tamper-evident, hash-chained guard-decision log** (`compact` archives read first). Bare `interlinked audit` just prints help — you must pass `verify`. *Not* a dependency audit — that's `interlinked allowlist verify`. |
| `compact [--dry-run --keep-recent-mb --all]` | Lossless gzip + rotate `activity.jsonl` (safe prefix ≤ sync cursor, audit-chain-aware) PLUS `collection.jsonl` / `timeline.jsonl` (plain recent-tail rotation, per-log `manifest-<log>.json`). Appenders and rotation share a cross-process lock, so appends made during compaction survive. A durable per-log claim precedes final segment publication; retry verifies its source identity, recorded prefix, gzip size, and SHA-256 before completing the SAME segment, even when the process died before the manifest write. Unknown or mismatched segment bytes stay untouched and stop that recovery. While either a durable claim or a legacy claim-less pending manifest row exists, `clean` and whole-file timeline rebuilds refuse to replace that log; ordinary appends remain allowed so recovery includes later rows. Activity recovery also refuses any recorded sync cursor beyond the retained suffix. Activity compaction refuses a sync cursor beyond the current EOF (unless `--all` explicitly bypasses sync bounds). All bytes remain recoverable via `gunzip` in manifest order. |
| `sync [--dry-run --limit]` | Push buffered events to the server (`POST /api/hooks/activity/batch`, secret+PII scrubbed at egress). Network — use `--dry-run` for a safe pending count. |

`interlinked metrics` (whole-repo code-quality scan) lives in **interlinked-quality-gates**;
`interlinked context` (effective config) in **interlinked-setup**.

For measured gate execution, `interlinked metrics gates --json` separates enabled policy
from actual attempts, fresh source-bound reach, stale/deferred/unavailable work and recorded
latency percentiles. `.interlinked/metrics/executions.jsonl` is the bounded local execution
journal; malformed/truncated evidence is reported. Historical ratchet file counts are not
current test coverage, and a disabled gate measures nothing. `metrics evidence status`
lists behavioral receipt freshness; `metrics coverage status` validates the contribution
index. `metrics coverage warm` explicitly runs the suite and belongs to
**interlinked-quality-gates**, so do not trigger its CPU work merely to display status.

## `interlinked impact` — facts, not attribution

`interlinked impact [--base <ref>] [--experiment-manifest <path>] [--cwd <path>]
[--short|--full|--json]` is local and read-only. It compares a verified commit (default `HEAD`)
with the worktree and reports four evidence classes without promoting one into another:

| Class | Current command contract |
|---|---|
| `potential` | Estimated deltas from valid explicitly recorded simplification receipts. Complete repository/selected-path receipts replace their authoritative scope; partial runs never imply disappearance. One strongest representative is selected per non-null overlap group. |
| `sandbox-validated` | Exact deltas only from a latest recorded finding with a passed Sandbox receipt and non-null validated impact. It is still an unaccepted candidate. |
| `observed` | Recorded facts from verified git/dependency deltas, baseline folds, retained sessions, legacy and simplification finding states, and manual debt-marker lifecycle. Observation is not causation. |
| `causal` | Available only for a strict controlled manifest whose raw-results, analysis-output, safety-receipt, and completeness-coverage artifacts all match their declared SHA-256 values. |

Every class/source is labeled `available`, `not-recorded`, or `unavailable`. An invalid `--base`
makes git and dependency evidence unavailable rather than silently choosing another comparison.
An explicitly named but unreadable experiment manifest is a command error; malformed manifests
or artifact hash/read failures leave causal evidence unavailable. Untracked paths are counted
without LOC; `.interlinked/` evidence files are excluded from that count.

Keep the source scopes separate. Activity edit totals are gross retained events and can overlap
the git delta. A baseline fold records tightened/refused water-lines, not why they changed.
Finding `touched` or `acked` states are workflow facts, not proof that a defect was fixed. Never
sum these sources into “saved LOC/time/money,” call them a gain, or say Interlinked caused them.

## The event-log model
Data dir: `INTERLINKED_DATA_DIR` → `config.local.json.data_dir` → `INTERLINKED_HOME` →
`<cwd>/.interlinked/` (CWD-relative — run from the repo root).

| File | Holds |
|---|---|
| `activity.jsonl` | **Full-fidelity legacy stream — ALL event types** (lifecycle, prompts, tokens, guard telemetry, tool events). Also the hash-chained audit log. |
| `collection.jsonl` | Canonical normalized tool and agent lifecycle records with provider attribution. |
| `timeline.jsonl` | Transcript records including provider-exposed summaries/text and usage; live appends and backfill can arrive out of event-time order. `collect` target. |
| `sessions/<id>.json` | Per-session state: agent, phase, tool_count, files, tokens. |
| `sync-state.json` | Sync cursor = **byte offset** into activity.jsonl. |
| `costs.jsonl` | Incremental per-call token rows read from provider transcripts at Stop/SessionEnd. |
| `costs-cursor.json` | Per-provider, per-actor transcript offsets; prevents replay and keeps sibling Codex subagents independent. |
| `hook-runtime.json` | Payload-free provider execution receipt: event, timestamp, and current hook-definition hash. All adapter runners write provider rows; `doctor` currently uses the Codex row to detect unreviewed/stale project hooks. |

Claude transcript rows need nonempty string timestamp, UUID and session identifiers before
they can produce timeline records. Malformed optional metadata, model names and tool identifiers
are omitted. Valid content blocks retain their original sequence index and raw tool payloads;
an invalid optional field does not discard the rest of the block. Token usage is included only
when its numeric fields are finite. Missing or malformed input is not evidence of an empty turn.

`activity.jsonl` and `collection.jsonl` **overlap on tool events by design**; readers dedup by
event identity (`tool_use_id` + projected type), not by type — no double-counting, no lost
history. Don't "clean up" by deleting collection rows or dropping tool types from activity.jsonl.

**Codex collaboration attribution:** Codex currently emits a spawned agent's live hooks with the
parent thread as `session_id` and no actor/model fields. Interlinked correlates the hook's local
`exec-*` tool id (or its just-written pending call at PreToolUse) with the spawned rollout under
`~/.codex/sessions/`, then stamps `agent`/`agent_name` with the canonical task path plus
`subagent_id`, `parent_agent`, and `model`. The parent `session` stays unchanged so one delegated
turn remains a coherent trajectory. `interlinked collect --provider codex` also understands the
current `session_meta.payload.id` + `source.subagent.thread_spawn` shape and writes
`agent_id`/`parent_agent`/`attribution_agent`/`is_sidechain` into `timeline.jsonl`. Correlation is fail-open: if
the rollout is missing, stale, outside the repo cwd, or unmatched, the event remains provider-only
rather than receiving a guessed identity. Exact execution-id evidence wins; pending-call fallback
also declines when otherwise-matching evidence names more than one distinct child actor. The first
`session_meta` owns a rollout file: later duplicate root metadata cannot erase child attribution,
and when both are present the child `payload.id` takes precedence over root `payload.session_id`.

**Codex token accounting:** rollout metrics and the generated hook read
`event_msg.payload.type: "token_count"` rows and add only
`info.last_token_usage`, which is the per-call delta. Never sum
`total_token_usage`; it is cumulative and would multiply usage when appended repeatedly. Codex
`input_tokens` stays the raw input count, `cached_input_tokens` maps separately to cache-read,
`cache_write_input_tokens` maps to cache-creation, and `reasoning_output_tokens` is recorded without
being added to output a second time. `turn_context.payload.model` supplies the model. Generated-hook
cursors include provider, transcript path, and actor identity because sibling subagents can share the
parent `session_id`; `agent_transcript_path` is the authoritative child transcript at SubagentStop.

**OpenCode/Pi observability boundary:** their managed bridges emit provider-attributed tool,
prompt, lifecycle, and compaction records, and a loaded bridge leaves an `opencode` or `pi` row in
`hook-runtime.json`. OpenCode maps `session.idle` and Pi maps `agent_settled` to normalized Stop,
but both upstream signals are observation-only: no native continuation or veto is implied.
Neither bridge receives dedicated MCP, subagent, or worktree lifecycle events, so the absence of
those rows is an upstream capability gap, not evidence that no such higher-level activity occurred.
The AGENTS lens can label OpenCode/Pi root sessions, but cannot invent subagent lanes without a
native actor event.

**`logs --type <t>`** filters the raw `event.type` exactly (not the uppercase display labels).
Values: `session_start`, `session_end`, `tool_use_start`, `tool_use`, `tool_use_error`,
`permission_request`, `user_prompt`, `subagent_start`, `subagent_stop`, `notification`,
`context_compact`, `task_completed`, `agent_stop`, and guard telemetry `guard_allow` /
`guard_warn` / `guard_block`.

**Sync modes** (`sync_mode`, or `INTERLINKED_SYNC_MODE`): `realtime` (default — per-event POST +
session-end batch), `local` (never posts), `manual` (per-event POST, no auto batch — you run
`interlinked sync`).

## The Stop digest — what end-of-turn stderr actually shows

Every Stop event runs ~20 independent nudge families. They no longer print in
full: `src/harness/stop-digest.ts` ranks and caps the whole wall to **≤15
stderr lines**, and everything it trims goes to the spool.

| Position | Contents |
|---|---|
| TOP | up to 3 warnings printed in full (≤4 lines each), ordered **actionable → measurement-threatening → reflection** |
| SUMMARY | one line per remaining category: `[interlinked:digest] <tag> xN (see …)` |
| POINTER | `.interlinked/stop-digest.jsonl` — the full detail, per-session capped |

Read the spool when a count line is not enough:

```bash
interlinked query .interlinked/stop-digest.jsonl --where kind=subagent-attributed
tail -n 40 .interlinked/stop-digest.jsonl | jq -r '[.kind,.tag//.check,.file]|@tsv'
```

Row kinds: `stop-warning` (a trimmed nudge), `subagent-attributed` (a finding on
a file a SUBAGENT wrote — attributed via `timeline.jsonl` and kept out of the
main list), `pre-existing` (present in the session's git baseline), and
`sanctioned-scratch` (probe-pattern findings under `scratch/`, which the
scratchpad policy sanctions — still reported by `interlinked verify
--all-checks`).

Two consequences worth knowing:
- **The rescan reports introduced-only.** A whole-file scan still runs, but a
  finding your session did not introduce is spooled, not printed.
- **Suite failures are not multiplied into per-file regressions.** A cycle
  reddened only by a whole-suite failure is excluded from the green→red Stop
  list; the unresolved `test-suite` outcome remains one check-level signal
  until a targeted test run supplies file-level evidence.
- **A repeat Stop prints only what is new**, plus one `R resolved, S unchanged
  (suppressed)` line. Per-session state lives in
  `.interlinked/.stop-digest-state.json` (daemon bookkeeping — do not hand-edit).

Activating a change to any of this needs `npm run build && interlinked harness
restart`: the daemon serves the build it started with.

## `interlinked recurrence` — repeating-pattern aggregation
Deterministic counting/grouping over `.interlinked/recurrences.jsonl` (no LLM), ranked by count.
Check-health aggregation accepts only caught rows with a nonempty string check ID and a string
timestamp. Optional file, message, and session fields must also be strings when supplied;
malformed rows are skipped. Captured source identities remain open strings so legacy and
internal CLI events retain their original attribution.
Daemon-ledger readers also validate optional fields while preserving legacy and future string
event labels; writers use the current event contract. Gate-reach snapshots validate every nested
gate and skip-count value before comparison. A corrupt newest snapshot leaves the last valid
snapshot available, rather than manufacturing a new measurement.
Four observation kinds (all filterable via `--kind`):

| Kind | Source | Suggested action |
|---|---|---|
| `harness_caught` | auto — every PostToolUse check failure | ratchet (advisory→default→block) |
| `harness_missed` | manual — `recurrence flag <sig>` | scaffold a new rule |
| `codebase_existing` | `recurrence scan --record` (walks the tree, runs inline detectors) | cleanup PR |
| `tool_failure` | auto — repeated tool failures (same tool + error class) | inspect the pattern |

```bash
interlinked recurrence list --kind harness_caught --top 10
interlinked recurrence detail <signature>          # every event for one row
interlinked recurrence flag raw-sql-concat --message "spotted in db.ts" --file src/db.ts
interlinked recurrence scan --record               # append codebase_existing rows
interlinked recurrence propose <signature>         # suggested action for one signature
```

## `interlinked viz` — the live dashboard
```bash
interlinked viz serve [--port 6403] [--root <dir>]   # loopback-only HTTP dashboard, live SSE tail of activity
interlinked viz snapshot [--json] [--full]           # print the graph summary (no server): "N files · M imports · most depended-on: <id>"
```
`viz serve` renders the repo as a file/import graph and tails the local logs live over SSE
(daemon not required). It surfaces unscrubbed tool I/O, so it **binds loopback only** and
**blocks until Ctrl-C** — don't call it in a one-shot step. While it is listening it writes
`.interlinked/viz.status` (`url=` + `pid=`), which the statusline reads to render a clickable
`◈ viz` row; the row disappears when that pid dies, so the link is never stale.

Six lenses, each fed by its own SSE route:

| Lens | Route | Source | Shows |
|---|---|---|---|
| FILES | `/api/graph` + `/api/stream` | project graph + `activity.jsonl` | one dot per source file, one line per import, dot size = how many files depend on it; a touched file pulses in the colour of the agent that touched it |
| GATES | `/api/checks` | `check-results.jsonl` | one frame per tool call: which checks ran, which fired, allowed or blocked, `[proven]`/`[heuristic]` |
| AGENTS | `/api/agents` | `activity.jsonl` (folded) | one lane per agent session working in this repo, indented lanes for subagents it spawned: runner, model, calls/edits/blocks/warns, current tool + file, live-vs-idle |
| TESTS | `/api/tests` | `test-events.jsonl` | every test case in the order the runner finished it; pass/fail/skip, slow cases outlined, failure messages |
| MUTANTS | `/api/mutants` | `mutation-manifest.json` | every mutant, survivors first; live kill-rate; a tile flashes when its status flips |
| DRIFT | — | — | not built yet (standby pane) |

The AGENTS lens needs no producer: attributed activity rows carry `agent`, `session`,
`subagent_id`, `parent_agent`, and `model`, so presence is a fold over the stream the dashboard already tails
(`src/lib/viz/agent-roster.ts`, hosted at `/api/agents`). Each actor gets a stable hue from its
id, and that hue is reused for its ticker rows and its file pulses — with two sessions running,
colour alone answers "who did that". A subagent gets its OWN lane keyed under its parent, so a
session's own edits are never conflated with its subagents'. When a runner names the parent by
thread/session id, the roster resolves that id through the root lane's session before linking the
child. Lanes dim to idle after 2 minutes of silence rather than disappearing.

The TESTS lens needs a producer. Any repo using vitest adds one line:

```ts
// vitest.config.ts
reporters: ["default", "interlinked-cli/viz-reporter"]
```

Gating it behind an env var is the recommended setup, so a normal `vitest run` stays
byte-identical and only an explicit opt-in emits the feed — that is how interlinked-cli's own
`vitest.config.ts` wires it: `INTERLINKED_VIZ=1 npx vitest run`. Any equivalent conditional
works; nothing about the lens requires that variable name. The feed schema
(`.interlinked/test-events.jsonl`) is runner-agnostic — `{kind: run_start|file_start|test|run_end,
run_id, file?, name?, status?, ms?, error?}` — so a pytest/cargo adapter writes the same lines
and the lens renders unchanged. Every feed degrades to an honest empty state when its file is
absent; nothing about the dashboard is repo-specific.

## Common workflows
```bash
interlinked status                       # sessions + last events + sync/server health
interlinked explain --since 30m          # narrative timeline of the window
interlinked logs -f --type tool_use_error # tail only failing tool calls, live
interlinked logs --type guard_block --since 1h   # what the guard blocked
interlinked recurrence list --kind harness_caught --top 10   # recurring mistakes
interlinked status --full                # per-session tools + files + tokens
interlinked impact --base HEAD --full    # scoped observed facts + explicit claim boundary
interlinked viz snapshot                 # one-line dependency-graph summary
interlinked sync --dry-run               # safe: pending count, no send
```

## Gotchas
- **`activity` vs `logs`:** `activity` = merged local+server feed (`--json` only); `logs` =
  local activity.jsonl only (offline, `--tool`/`--type`/`--follow`). Prefer `logs`/`status`/
  `explain` for pure introspection — they never touch the network.
- **`watch` and the send half of `sync` are server-only** — they need auth (and `workspace_id`
  for localhost dev); `watch` prints "Not authenticated" offline.
- **`sync` is restart-safe and memory-bounded:** it sends at most 100 events per batch,
  checkpoints the byte cursor after each accepted batch, and leaves an unterminated final
  JSONL record pending until its newline arrives. Each response body is capped at 256 KiB and
  the request timeout remains active until that body is consumed. Run-wide type, agent, tool,
  and session summaries retain at most 256 keys per dimension (512 characters per key); JSON
  reports `breakdown_complete` plus exact omission counts in `summary_truncated`, and a partial
  breakdown is never persisted as an exact last-sync summary.
- **Session summaries are bounded and fail loudly:** `status`, checkpoint/resume context, and
  impact evidence stream at most 10,000 session JSON files, 1 MiB per file, and 32 MiB total.
  Crossing a ceiling refuses the scan instead of returning an incomplete list as exact;
  ordinary malformed/unreadable legacy rows remain skipped.
- **`viz serve` / `logs -f` / `watch` / `telemetry -f` block** until Ctrl-C.
- **`--type` filters the raw type** (`tool_use_error`, `guard_block`), not display labels
  (`ERROR`). Passing an unsupported mode flag to a command errors (flags are per-command).
- **Don't hand-truncate `activity.jsonl`** — the sync cursor is a byte offset; use
  `interlinked compact` (it respects the cursor and audit chain).
- **`impact` does not create evidence.** It can project recorded potential/Sandbox receipts and
  verify a supplied controlled experiment's artifact bindings, but it does not run or reproduce
  an experiment. No class is a generic savings claim.

## Related skills
- **interlinked-quality-gates** — `interlinked metrics` (code-quality hotspots) and `recurrence scan`.
- **interlinked-harness** — the guard whose block/warn telemetry you're inspecting.
- **interlinked-coordination** — the server-backed side (tasks, messages) `watch`/`sync` reach.
- **interlinked-simplification** — advisory opportunities whose estimated and validated impact
  must remain separate.
