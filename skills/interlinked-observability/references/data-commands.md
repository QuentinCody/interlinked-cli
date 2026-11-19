# interlinked-observability: data command detail

Reference for [SKILL.md](../SKILL.md). Read it when a `data` command result needs its budgets, coverage or retention rules.

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
Catalog source names and categories stay consistent between direct scans and indexed search,
including sources stored under nested paths such as `logs/latency.jsonl`.
Unknown event timestamps are excluded by time bounds. The older `query` command scans a
bounded physical tail of one file and reports its scope; it does not promise archive coverage.

Each indexed answer carries a record ID; `data show` retrieves the original JSON and verifies
its SHA-256. Projection text/field traversal is bounded, and oversized or malformed rows are
reported without deleting their raw bytes. Check `data status` for freshness and parse failures.
Invalid UTF-8 is malformed evidence: scans and new imports report it and continue to later
complete records; `data show` refuses to verify it. A valid replacement character (`�`) in
UTF-8 is ordinary text. For indexes created before strict UTF-8 validation, use an explicit
`data index --rebuild` to remove earlier lossy projections; historical raw bytes remain intact.
Exact duplicate raw records within one logical source share an indexed record but retain all
physical locations. Cross-stream observations are not automatically independent executions.

`data sessions/files/checks/usage/schema/suggestions` expose evidence aggregates. `investigate`
correlates exact provider/session/actor/call identities and labels missing phases; a file filter
also strictly folds the obligations ledger. A block count is not a prevented-defect estimate.
Suggestion `shown` means selected for presentation, not acknowledged; later absence is an
observation, not proof of a fix. Usage has unknown values and no invented prices; never add
overlapping timeline and costs totals. Recurrence inventory is separate from incident counts.
Usage deduplication chooses a provider-message representative within the query's retained
scope, so superseded source generations and excluded archives do not hide a retained copy.
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
not infer tampering intent. Its source line and byte offset refer to the physical record even
when archived blank lines are omitted from the verifier's combined line count.
After investigation, `data audit checkpoint --reason TEXT` records
an explicit payload-verified live observation boundary. `data audit verify --checkpoint ID`
checks subsequent retained evidence, including after rotation. The historical verdict stays
unchanged; checkpoints never rewrite or reset the old chain.
