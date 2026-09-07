# Local data capture and search

Interlinked CLI retains JSONL as evidence. `data scan` searches it directly; a separate SQLite
projection is optional. Ordinary capture/search stay local. Explicit `data lab` experiments
compare storage engines and can contact a configured synthetic-only cloud evaluation service;
they do not connect to the Interlinked MCP Server or migrate existing logs.

## Start with the directory you have

```bash
interlinked data catalog --json
interlinked data health --json
interlinked data scan "error" --source check-results --max-mb 32 --raw --json
interlinked data status --json
```

The [generated catalog](generated/data-catalog.md) declares each known stream's purpose,
category, producer and retention class. Machine-readable catalog entries additionally describe
schemas, timestamps, identity fields, readers and expected triggers. Recursive discovery includes
unknown JSONL files, numeric rotations and gzip archives; unknown files are retained and labeled.
Discovery skips symlinks and reports its traversal limits and issues.

The index lives at `index/data/search.sqlite` under the resolved data directory. Node's built-in
SQLite and FTS5 load only when needed. Node 22.13 or newer avoids the earlier SQLite flag
requirement. No package installation, embedding model, network service or API key is required.

Agents should follow the bundled [investigation workflows](../skills/interlinked-observability/references/evidence-workflows.md):
check capture and index coverage, search a bounded question, verify supporting raw records,
then report evidence and limitations. Installed skills include this reference locally.

## Search, inspect and correlate

`data scan [text]` creates no database or corpus copy. It reads complete-line prefixes of the
most recently modified files, including gzip/numeric archives, within 32 MiB/25,000 physical
lines by default. Set `--max-mb`, `--max-records`, and exact filters; inspect `coverage.complete`
and `scope`. `--raw` returns original record text and SHA-256. Scan IDs differ from indexed
`data show` IDs. Text uses ASCII-folded ANDed literal substrings over the bounded projection;
`--since`/`--until` retain the duration/ISO grammar. File filters are project-relative.
`--full-text` matches all decoded string values in each readable record, bypassing the
32 Ki-character text projection; JSON field names are excluded. Returned previews remain
bounded, while `--raw` includes the complete matching record. Physical scan limits still apply.

For repeatable engine comparisons and native transcript snapshots, see
[storage evaluation](../skills/interlinked-observability/references/storage-evaluation.md).
The commands below use the optional production index; run `data index` explicitly if needed.

```bash
interlinked data search "compiler import" --since 7d
interlinked data search '"dependency audit" OR timeout*' --fts
interlinked data search --source tests --decision fail --since 30d
interlinked data search --session SESSION --provider codex --origin production
interlinked data search --file src/app.ts --check typescript
interlinked data show RECORD_ID
interlinked data investigate --session SESSION
interlinked data investigate --call CALL_ID --session SESSION
interlinked data investigate --file src/app.ts
```

Default text search requires all whitespace-separated terms; `--fts` enables SQLite FTS5
phrases, prefixes and Boolean grammar. Exact filters are bound parameters. Results support
`--limit 1..1000`, `--offset`, `--since`, `--until`, and `--no-archives`. `--json` is suitable
for scripts. Search time bounds use event time, independently of index ingestion time.
Unknown timestamps are excluded from time windows and counted in index coverage.

Every result has a stable ID derived from its logical source and raw-record SHA-256. Exact
duplicate raw rows within a source share one indexed record; physical source/generation/byte
locations remain separate. Cross-stream rows are retained independently. `data show` opens
the original JSON and verifies its raw hash, trying alternate locations if a file moved.

`investigate` groups matching provider/session/actor/call identities and reports observed and
missing phases. It does not guess missing identities or treat absence as proof a tool did not
run. Results are bounded and event-time ordered. A file investigation also streams and folds
the obligations ledger through its domain state machine. Malformed transactions make that
state unavailable rather than making the file appear debt-free. Other domain ledgers remain
separate sources and are not implicitly interchangeable.

The older `query` command remains a fast, bounded tail reader. It filters every visited row by
time, including out-of-order backfill, and reports unknown dates and scanned time coverage.
It reads one physical file; use `data search` for indexed archive history.

## Views and evidence limits

| Command | Question answered |
|---|---|
| `data sessions` | Which sessions, actors and providers have indexed observations? |
| `data files` | Which files have recorded activity, and when? |
| `data checks` | Which check states were observed, including deferred and failed execution? |
| `data usage` | Which session/model token measurements exist in each source? |
| `data suggestions` | Which checks produced candidates, scores, suppression and later observations? |
| `data schema --source NAME` | Which field paths and value types were observed? |
| `data recurrence-inventory` | What finding inventory was most recently observed for each scan scope? |

Counts describe indexed observations. They do not establish causality, prevented defects,
saved time or money. Costs rows with `usage-delta.v1` deduplicate by provider message identity.
Legacy usage remains source-specific observations; never sum overlapping timeline and costs
totals. Unknown tokens and prices stay null. Historical origin stays unknown unless explicitly
recorded; session names and fixture-looking text do not establish origin.

New capture carries ingestion time, producer, origin, provider/session where available, event
identity and producer redaction policy. SessionStart records provider capability declarations.
Only data actually exposed by a provider can be captured; reasoning summaries are not hidden
model reasoning. Native completed-tool capture records verification outcomes from explicit
exit/provider status and every supplied filesystem effect, including shell/MCP writes. Missing
duration or line counts remain unmeasured. Graph snapshots reuse the daemon's initialized graph.

`check-results` retains per-call findings and reported execution coverage. `check-executions`
records every entry in the configured quality-check loop, including disabled, skipped, deferred,
error and completed states. Other check pipelines have separate coverage. No reported finding
can reflect diff-aware filtering; it is not necessarily a clean whole-file verdict.

Repeated warnings retain full first/changed text plus occurrence identities, hashes and counts.
Only their activity-log mirror is shortened; guard decisions are unchanged. Suggestion scores
are measured before display selection, including hidden candidates. `shown` means selected for
presentation, with acknowledgement unmeasured. The next same-session/file scan can observe a
candidate still present, suppressed or absent. None of those states alone proves a causal fix.
Unchanged recurrence scans append receipts without duplicating every finding as a new incident.

## Health and bounded indexing

`data health` separates successful capture, failures, unsupported/disabled/idle producers,
not-observed streams and populated sources without measurement. Receipts cover the newest
10,000 rows / 4 MiB, separately per producer and provider. Older files can be healthy event-driven
feeds; file age alone is not a failure. `doctor` highlights failed or unmeasured producer coverage.

The default import budget is 256 MiB expanded input and 250,000 records. Repeat `data index` to
resume. Imported records, evidence pointers, parse failures and complete-line cursors commit in
one transaction. An exclusive process lease prevents concurrent importers. File identity, size,
head and cursor-adjacent anchors detect ordinary replacement, truncation and rewriting. Source
hashes verified on retrieval remain the stronger evidence check.

The text projection is bounded to 32,768 characters per row, 2,048 field visits and depth 8. Raw JSONL rows
above the materialization limit are reported with offsets and retained unchanged. An incomplete
last line is held until complete. Gzip expansion has a separate safety budget; resuming compressed
input may replay decompression to its uncompressed byte cursor. `data status` reports incomplete,
stale, missing, malformed and oversized sources. Search results reflect indexed coverage, which
can lag an actively growing directory. `data index --rebuild` clears only the derived projection.
Per-file import errors exit nonzero; a normal bounded pass with remaining backlog can exit zero.

Import budgets bound work per pass, not total storage. The index retains normalized rows,
search text, full-text structures, dimensions and physical evidence locations; it can occupy
substantially more disk than compressed source logs. Compression savings on the raw logs do
not imply savings across the entire data directory. `--limit` bounds returned results or
groups; aggregate queries can still inspect many indexed rows. Narrow supported filters first.
The schema view only applies source and limit filters and describes observed shapes, not schema
validation or per-session coverage.

## Retention and background operation

```bash
interlinked data configure
interlinked data configure --auto-index on --index-mb 256 --index-records 250000
interlinked data maintain
interlinked data maintain --execute --compact --no-index
interlinked data configure --auto-compact on --compact-at-mb 256 --keep-live-mb 64
```

Configuration is stored in `data.config.json`. Both automation flags default off. Enabled jobs
use the existing SessionEnd background resource governor, outside the hook decision path.
SessionEnd is the provider's session lifecycle event, not every assistant Stop. There is no
continuous watcher or periodic active-session refresh. Before investigating recent events,
check `data status` or use direct scans if the relevant files are stale.
`maintain` without `--execute` previews the plan. `--index` explicitly imports a bounded batch;
`--no-index` skips SQLite even when automatic indexing is configured. Otherwise indexing
follows `auto_index`. Rotation follows `--compact` or `auto_compact` independently. Enabling
rotation alone does not open/create SQLite. Eligible collection/timeline files are losslessly
rotated into gzip archives; the default live tail is 64 MiB. When indexing also runs, existing
index pointers are translated during rotation; otherwise index freshness must be reassessed;
remaining backlog can be imported later. No data maintenance command deletes raw evidence.
The bulk retained suffix is copied before acquiring the append lock. Under the lock, rotation
rechecks file identity and catches up at most 16 MiB before the atomic rename. A competing
replacement or larger append burst aborts safely for retry. Maintenance failures leave a
producer-health receipt.

Activity uses the separate audit/sync-cursor-aware `compact` workflow. State ledgers, corpora,
unknown sources and diagnostics without archive-aware domain readers are preserved. This
preservation policy deliberately favors full capture over diagnostic sampling or expiry.
After external compaction, rerun the importer. A crash between physical rotation and projection
translation leaves raw evidence recoverable; rebuilding the index reconstructs its pointers.
Ordinary domain commands that only read a live file retain their documented scope.

Retain raw evidence indefinitely. Do not delete archives, expire old records, discard unknown
sources, or rewrite malformed rows as a storage optimization. Preserve manifests and integrity
checkpoints with the logs. Lossless rotation relocates the complete archived prefix and keeps
the recent suffix live; it is not an expiry policy. The derived index can be rebuilt from
retained evidence, but rebuilding is separate from retention and is not needed after every
rotation. Search archived history through `data search`, rather than assuming a live-tail
command includes it.

## Audit investigation

```bash
interlinked data audit diagnose --json
interlinked data audit checkpoint --reason "Investigated historical writer continuity"
interlinked data audit verify --checkpoint CHECKPOINT_ID --json
```

Diagnosis preserves the existing strict archived/live verdict and locates the first failing
physical record. An integrity or continuity mismatch can have several causes; the command
does not declare intent. An explicit checkpoint verifies live payload hashes and records an
observation boundary and reason. Verification after that boundary leaves historical validity
unchanged. Neither command resets, repairs or rewrites the original chain. Invalid verification
exits nonzero. Checkpoints are local evidence, not externally signed trust anchors.

## Development

New source contracts belong in `src/lib/data/catalog.ts`; run `npm run docs` after a build.
Capture writers should use explicit project roots and `appendCapturedData` for provenance and
write receipts. Test capture refuses the real project's `.interlinked/` directory. Use per-test
temporary roots; do not change process cwd globally or redirect all tests into one shared log.
Capture failures remain visible through receipts without changing production guard policy.
