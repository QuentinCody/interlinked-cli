---

name: interlinked-observability
description: "Investigate agent activity and JSONL/gzip evidence. Load for data scan, catalog/health/index/search/show/investigate, storage-engine experiments and benchmarks, native transcript comparisons, file/session history, capture gaps, lossless rotation, audit integrity, and evidence-backed handoffs. Also covers activity, logs, impact, trace, recurrence, viz, collect, compact, and optional sync. Missing capture is not absence; correlation is not causation."
---

# interlinked-observability — inspect what agents did

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

`recurrence propose <signature>` reports a missing proposal with a nonzero exit.
Its JSON mode emits a structured error on stderr. `trajectory show --json`
validates retained JSON before printing it. Missing, unreadable or malformed
snapshots produce a structured JSON error and nonzero exit. Valid raw JSON keeps
its stored formatting.

`collect --since` requires an explicit nonempty duration. Omitting it retains
whole-history collection. `telemetry --follow --json --limit N` emits JSONL for
both the initial tail and later events. When a watched spool shrinks, following
restarts at byte zero, which can replay retained rows after compaction.

Git attribution preserves exact NUL-delimited paths and uses literal arguments
for filenames and revisions. Untracked-only work participates in its existing
patch-line estimate. Attribution remains a heuristic observation.

- "What did I / another agent do this session?" — or you want to tail activity live.
- Reviewing what the guard blocked or warned.
- Finding recurring mistakes to harden against.
- Reporting recorded local changes without turning correlation into a savings or causal claim.
- Inspecting a specific session, event, or the repo dependency graph.
- Backfilling external (Codex) sessions, verifying the audit log, or syncing to the server.

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

The bundled [workflow reference](references/evidence-workflows.md) is available in installed
skills. In the Interlinked CLI source repository, `docs/data-observability.md` and
`docs/generated/data-catalog.md` provide the operator contract and generated source catalog;
in another project, use `data catalog --json` to inspect its sources.

## Command surface
Output-mode flags are **per-command** (not uniform); all support `--json`. `--since` grammar is
strict: `\d+(s|m|h|d)` (e.g. `30m`, `2d`) — `15` or `1.5h` throw.

`status --watch --json` emits a sequence of complete JSON objects at each refresh.
Terminal clearing and refresh banners are limited to human output modes.

**Dashboard / feed**
| Command | Purpose | Key flags |
|---|---|---|
| `status` | Local-first dashboard: sessions, recent activity, sync + optional server health | `--watch [s]` · `--short --full --json` |
| `activity` | Recent feed (local+server merged/deduped, token/cost totals) | `--agent --limit --since` · `--json` |
| `impact` | Evidence-classed local git, dependency, baseline-fold, activity, and findings facts | `--base <ref>` (def `HEAD`) · `--short --full --json` |
| `logs` | View/tail **local activity.jsonl** (offline, no server) | `-f/--follow --agent --tool --type --since --limit --raw` · `--json --short` |
| `explain` | Narrative chronological timeline + agent/human line-attribution | `--agent --since` (def 1h) `--full` · `--json` |
| `watch` | **Server** poll: unread messages, pending tasks, active agents (diffs between polls) | `--interval` (def 10s) · `--short --json` |

`activity` isolates local and server read failures: available server events still
render if the local read fails, and local events remain available if the server
client fails. A local read failure with no available server events is reported as
an error.

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

`interlinked query checks --actions --json` projects selected retained hook evidence
into the same action schema as metrics and verification, without executing checks or
calling a model. Normal/full output includes next steps and validation. The ordinary
query time, row and byte bounds still apply and remain in the report; increase them
explicitly to inspect more history. This is historical evidence, not a current unresolved
worklist. Revalidate source and policy before acting. Captured observations with a
consistent nonempty primary source hash are snapshot-bound. Supplied `sourceEvidence`
also retains captured producer/consumer paths, lines and hashes. Grouped historical
versions with conflicting primary or supporting hashes have unknown freshness and
retain every version's evidence. This does not certify complete dependency capture
or current disk freshness; older record formats may retain only primary evidence.
Legacy records without detailed findings remain unknown, and simulated rows are
excluded. Suppressed raw observations retain their reason and structured suppression
metadata. Supplied evidence is appended without a function-argument count cutoff;
the query window limits still apply. Supplied, accepted and rejected finding-row
counts expose unsupported detail rows separately from unrecognized records. The flag requires
the `checks` source and cannot combine with `--by`, `--sum` or `--fields`.
Query row limits must be positive safe integers; byte budgets must represent at least
one byte. Malformed numeric suffixes are errors rather than partially parsed numbers.

For measured gate execution, `interlinked metrics gates --json` separates enabled policy
from actual attempts, fresh source-bound reach, stale/deferred/unavailable work and recorded
latency percentiles. `.interlinked/metrics/executions.jsonl` is the bounded local execution
journal; malformed/truncated evidence is reported. Historical ratchet file counts are not
current test coverage, and a disabled gate measures nothing. `metrics evidence status`
lists behavioral receipt freshness; `metrics coverage status` validates the contribution
index. `metrics coverage warm` explicitly runs the suite and belongs to
**interlinked-quality-gates**, so do not trigger its CPU work merely to display status.

For hook-check evidence, `harness coverage status --progress --json` reads cached
observation time, generation, pending count and job counters without rehashing files
or serializing receipt history. `readiness` describes that observation, not a fresh
coverage verdict. Plain `harness coverage status --json` reconciles selected files and
returns full pending identities and receipts. Neither starts recovery; route explicit
`harness coverage verify` and unresolved check prerequisites to **interlinked-verify**.
Hook-check receipts with nonempty `unavailable` retain partial work; their pending version
is not discharged. Do not count them as fully checked files or reusable passing evidence.
Receipts may separately retain `advisoryGaps` with a check, file and reason. These record
unmeasured advisory scope, such as incomplete Commander reverse-import evidence. They are
not defect findings and do not create required retry or blocking obligations. Completed
listed checks can settle their work while advisory coverage remains explicitly unknown.
Own-barrel pre-write unknowns also retain explicit unavailable advisory observations
in `check-executions`; see [capture notes](references/capture-notes.md). A zero finding
count on an unavailable observation is not a clean graph verdict.
For runtime scan profiling, Node's `interlinked.coverage-runtime-scan` diagnostics channel
emits root, completed flag, bytes read, entries visited and duration even on failed captures.
Subscribers must be in the scanning process. The optional `evals/slopcodebench/scan-cost.mjs`
preload prints bounded measurements to stderr; it emits no contents or environment values.

Live Codex subagent correlation reads at most a 64 KiB owner header and a 1 MiB recent
tail per rollout, and retains at most 16 parsed rollouts. Root-owner metadata ends the
read immediately. Calls outside that window, partial records and ambiguous actors remain
unattributed; use native transcript investigation for older evidence. These are correlation
limits, not transcript retention limits. Dirty search-index membership uses compact numeric
arrays with exact membership; its file limits and native-search fallback are unchanged.

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

File-touch records distinguish `declared-target`, `observed-in-window`, and `shadow`.
Keep shadow rows when investigating workspace changes, but filter `shadow != true` for
per-actor totals. A shell observation is temporal correlation, not authenticated authorship;
concurrent shell writers and daemon restarts limit attribution. Join reservation grants to
file touches with `session_id`, `subagent_id`, and `tool_use_id`, not the display agent name.
Release rows retain the owner's grant call in `grant_tool_use_id`; conflicts also carry
`holder_*` fields. Missing join keys mean unavailable attribution, not a different actor.

Simulated `harness test` records carry `dry_run: true`. Exclude these when counting executed
calls or real guard blocks (for example `query blocks --where dry_run!=true`). Probes do not
acquire reservations or call decision models. Opt-in decision/edit shadows share
`decision-shadow.jsonl`; distinguish them by `surface` and retain failed/unconfigured states
as missing predictions. Use **interlinked-harness** for their opt-in configuration.

Hook-coverage receipts live in `hook-coverage-history.jsonl`; only the byte prefix named by
`hook-coverage.json` is committed. Use **interlinked-verify** for migration and offline repair.
Do not interpret a shorter history after an explicit loss repair as successful verification.

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

**Codex input roles:** imported user-shaped input retains its `input_role`.
Developer/system context remains available as evidence but does not start a human
experience episode. Historical rows without the role retain the old interpretation
until their source transcript is reparsed; do not compare episode counts without
accounting for that migration.

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

Claude Code reports a failed Bash call only as `PostToolUseFailure` (row type `tool_use_error`).
Installs before 2026-11-16 did not subscribe it, so failed calls from that time have no
completion row and `tests.jsonl` has no `fail` rows for them. That gap is missing capture, not
proof that the calls passed. Run `interlinked install-hooks --refresh --preserve-mode` to subscribe
it. A failed test command then gets `outcome: "fail"` and the `exit_code` from the error text.

Read `outcome` in `tests.jsonl` together with `basis`. `exit_code` is always the shell's status,
and it is the check's verdict only when `exit_attributable` is `true`. After a pipe or a later
command (`vitest run … | tail`, `npm test; echo done`) the status belongs to that other command,
so the row gets `basis: "runner-summary"` when the output holds a vitest or jest summary line, and
`outcome: "unknown"` with `basis: "exit-status-not-attributable"` when it does not. `set -o
pipefail` before the check makes a piped status attributable again. Rows written before
2026-11-16 have no `exit_attributable` field: a `pass` with `basis: "provider"` on a piped
command there is the shell's status, not proof that the check passed. The same rule decides the
red/green state behind the Stop `unresolved-red` nudge: a typecheck, build or lint run with a
hidden status records nothing and returns an `[interlinked:check-evidence]` warning.

**Sync modes** (`sync_mode`, or `INTERLINKED_SYNC_MODE`): `realtime` (default — per-event POST +
session-end batch), `local` (never posts), `manual` (per-event POST, no auto batch — you run
`interlinked sync`).

## The Stop digest — what end-of-turn stderr actually shows

`src/harness/stop-digest.ts` caps the Stop stderr wall to 15 lines: up to 3 full warnings, one
`[interlinked:digest]` count line per other category, and a pointer to `.interlinked/stop-digest.jsonl`
(the full detail). A repeat Stop prints only what is new. The row kinds, the spool queries and the
introduced-only rules are in [references/calls-and-outcomes.md](references/calls-and-outcomes.md).

## `interlinked query stages` — where verification time goes

`.interlinked/verification-stages.jsonl` (added 2026-09-28) holds one row per
check per pipeline stage: `stage` (`edit` from the hook path, `push` from the
pre-push hook, `cli` otherwise), `check` (`vitest:selected`, `vitest:full`,
`npm run typecheck:stable`, `e2e-tests`, `e2e-merge`, …), `queue_ms`,
(the `e2e-merge` row's `detail` carries the merger's per-phase profile —
`read_ms`, `merge_ms`, `convert_ms`, `summary_ms` plus file, script and
conversion counts — on that ONE row, never as further rows, so `--sum post_ms`
counts a merge once; measured 2026-09-29 the convert phase was 165 s of a
168 s merge until `ast-v8-to-istanbul` was pinned at 1.0.7, then 2.7 s),
`wait_capacity_ms`, `validate_ms` (runtime snapshot + hash that decides
reuse; paid on hits, misses and early stale returns), `lookup_ms`, `exec_ms`,
`post_ms`, `peak_rss_bytes` (peak sampled RSS of the bounded child tree, taken
every 500 ms; numeric only when at least one sample exists, otherwise absent or
explicitly null), `rss_budget_bytes` (the budget the command was
admitted under; `peak_rss_bytes / rss_budget_bytes` is the headroom, and
`scripts/run-resource-bounded.ts` prints a `[resources] HEADROOM:` stderr line
above 85%), `heap_limit_mb` (the `--max-old-space-size` the command started
with), `reused` and
`reuse_denied_reason` (`no-receipt`, `plan-not-reusable:<issue>`,
`stale-inputs`, `budget-exceeded`, `capacity-timeout`,
`memory-budget-unavailable`, `interrupted`, `empty-selection`,
`handoff-fallback:<cause>`). Since 2026-11-05 a row may also carry `trace` (the
request's correlation id, `INTERLINKED_VERIFICATION_TRACE`: minted by the daemon
for a judged push, inherited by the native command and the pre-push hook, or
minted by the hook when none is inherited), `owner` (`daemon`, `git-hook`, …,
`INTERLINKED_VERIFICATION_OWNER`), and for test runs `tests_executed` /
`tests_reused`. `interlinked tests trace [--trace <id>]` folds one trace's rows
into owners, phase costs, the wall-clock wait and the fallback cause. File counts
come from completed runner file results; a missing or malformed report leaves the
count absent. The summary exposes `tests.unmeasured_runs` alongside observed counts.
A native replacement carries the trace for delegated and recognized fallback pushes;
if a client disconnects before receiving it, the hook mints a separate trace and the
join is incomplete. Do not merge those rows by temporal proximity alone. A dry run
never writes a row; a write failure is silent. Rows the pre-push hook writes
inside its disposable export land in the source checkout through
`INTERLINKED_STAGES_LEDGER`.

This repository's Vitest worker setup clears inherited stage, ledger, trace and
owner variables so fixture checks cannot pollute the enclosing push's evidence.
The outer verification supervisor retains its correlation and ledger destination.

Legacy asynchronous Git pre-tool checks now write `pre-tool:project-typecheck`
and `pre-tool:project-tests` rows, including admission and execution times and
available process-tree memory observations. One caller owns each row; observers
do not create duplicate rows. A missing RSS sample is absent or null, never zero. Resource
waiting and failed admission are not passing evidence. See
`docs/verification-efficiency.md` for the corresponding execution changes.

```bash
interlinked query stages --by reuse_denied_reason        # why results are not reused
interlinked query stages --where check=coverage:index    # Unit 7: the index route (reused = no shard re-ran; unavailable rows carry the reason)
interlinked query coverage-compare                       # pre-push comparison mode: full vs index verdict per pushed sha, `agree`
interlinked query stages --by check --sum exec_ms        # where the minutes go
interlinked query stages --where stage=push              # one push's timeline
interlinked query stages --where trace=<id>              # every row of one request (daemon + hook)
interlinked tests trace                                  # the newest push, explained from its trace
```

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

## References

Read a reference file only when the task needs it.

- [references/evidence-workflows.md](references/evidence-workflows.md): task recipes, source selection, pagination and a handoff checklist.
- [references/data-commands.md](references/data-commands.md): direct-scan budgets, `data catalog`, indexing, `data show`, aggregates, `data maintain`, rotation, auto-index and `data audit diagnose`.
- [references/storage-evaluation.md](references/storage-evaluation.md): storage experiments and `data lab`.
- [references/capture-notes.md](references/capture-notes.md): capture-record notes, such as `hook-observation.v1`, `hook-reentry.jsonl`, receipt scopes, `source-scan-scope.v1` and Cowork receipts.
- [references/viz.md](references/viz.md): the `interlinked viz` lenses and the vitest TESTS reporter.
- [references/calls-and-outcomes.md](references/calls-and-outcomes.md): `harness calls`, the tool-output efficiency lab, finding outcomes and `harness explain`.

## Related skills
- **interlinked-quality-gates** — `interlinked metrics` (code-quality hotspots) and `recurrence scan`.
- **interlinked-harness** — the guard whose block/warn telemetry you're inspecting.
- **interlinked-coordination** — the server-backed side (tasks, messages) `watch`/`sync` reach.
- **interlinked-simplification** — advisory opportunities whose estimated and validated impact
  must remain separate.
