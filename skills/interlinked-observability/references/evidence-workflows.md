# Investigating retained evidence

Use these workflows when recorded history can answer a concrete question. They run locally
without the Interlinked MCP Server. Replace uppercase IDs with observed values, choose an
appropriate time window, and use paths relative to the project root.

## Establish coverage before interpreting results

```bash
interlinked data status --json
interlinked data health --json
interlinked data catalog --json
```

Status describes the search projection: stale/missing files, incomplete import cursors,
malformed or oversized rows, and unknown dates/origins. Health describes capture receipts;
its newest 10,000-row / 4 MiB window is not a lifetime coverage claim. A populated source
without a receipt is unmeasured. An idle event-driven source is not necessarily broken.
The catalog identifies exact logical source names, producers, categories and retention classes.
Unknown discovered files are searchable; their meaning is not automatically known.

For `spec-drift`, inspect the finding kind and `stop_eligible`. Inferred prose count/range
comparisons remain searchable advisory evidence, while Stop summarizes structural marker/link
findings. Quoted examples can explain older false positives; preserve those original records
and review documents. Absence of a Stop nudge is not proof that all prose was verified.

If relevant evidence has not been indexed, run `interlinked data index --json` and inspect the
result. Repeat bounded passes if needed; exit zero alone does not mean the backlog is covered.
For one known source, use `data index --source SOURCE --json`. SessionEnd automation can be
deferred and does not refresh every Stop or watch a still-active session. Describe the
coverage reached rather than promising a perfectly current snapshot during ongoing writes.
If a command reports `database is locked`, let the concurrent index operation finish and
retry. Report unavailable coverage if it persists; a lock error is not an empty result and
does not justify deleting or rebuilding evidence.

## Choose the source for the question

| Question | Evidence and interpretation |
|---|---|
| What did this session/tool call do? | Search the session, then investigate the exact provider/session/call. Activity, collection and timeline can observe the same execution. |
| Did a quality check run, skip, defer or fail? | `check-executions` records states in its configured loop; `check-results` records findings and reported coverage. Other pipelines have separate coverage. |
| What happened to a file? | `data investigate --file` combines matching history with a strict obligations fold. Also inspect the relevant domain ledger and current code. |
| Why does a warning keep appearing? | Search `warning-occurrences` and its first/changed warning text; occurrences are distinct from the shortened activity mirror. |
| Was a suggestion presented or later absent? | `data suggestions` and raw records describe selection, scores, suppression and later observations. Presentation is not acknowledgement; absence is not a causal fix. |
| How many tokens were measured? | Filter `data usage` to one source, session and provider where available. Do not sum overlapping costs and timeline measurements. |
| Is a repeated finding a new incident? | `data recurrence-inventory` describes scoped scan inventory. Re-observing a finding does not create an independent incident. |
| What is an unfamiliar log? | Use catalog metadata, `data schema --source SOURCE`, a few search results, and verified raw rows. Observed fields are not a validated schema. |

`data` source filters use catalog IDs such as `activity` and `check-results`. Aliases accepted
by the separate `query` command, such as `blocks`, are not automatically `data` source IDs.

## Diagnose a failure or a missing check

```bash
interlinked data search --source tests --decision fail --since 1d --limit 10 --json
interlinked data search --source check-executions --session SESSION --limit 20 --json
interlinked data search --source check-results --session SESSION --limit 20 --json
interlinked data investigate --provider codex --session SESSION --call CALL_ID --limit 100 --json
interlinked data show RECORD_ID --json
```

Start from a returned session/call identity; do not guess that similar timestamps prove a
shared execution. `investigate` groups exact provider/session/actor/call identities and labels
missing phases. A missing phase can reflect capture, indexing or result bounds. A completed
check with no reported finding can reflect diff-aware filtering, not a clean whole-file verdict.
Use the recorded command and finding to select a fresh, targeted verification of current code.

## Recover file context before changing it

```bash
interlinked data investigate --file src/app.ts --since 7d --limit 100 --json
interlinked data search --file src/app.ts --source files-touched --since 7d --limit 10 --json
interlinked data show RECORD_ID --json
```

The obligations fold uses the domain state machine; malformed transactions make that state
unavailable. Do not interpret an unavailable fold or an empty search as proof there is no debt.
Historical evidence can explain intent and earlier failures; read the current file and its
current applicable checks before implementing a change.

## Inspect usage or an unfamiliar schema

```bash
interlinked data usage --source costs --session SESSION --limit 10 --json
interlinked data schema --source costs --limit 20 --json
interlinked data search --source costs --session SESSION --limit 3 --json
interlinked data show RECORD_ID --json
```

Usage counts are source-specific measurements with unknown values preserved. Message-delta
deduplication does not make all historical streams disjoint; do not invent missing prices.
The schema view applies only source and limit, even though common CLI flags are accepted.
It is a source-wide field census, not a session/time-filtered or exhaustive payload schema.
Projection text and field traversal have explicit bounds; raw retrieval resolves relevant detail.

## Bound searches without claiming completeness

Search defaults to 20 results and supports `--offset`. `investigate` defaults to 200 matching
records, selects the newest bounded subset, then orders it by event time; it is not a complete
session transcript. Both cap requested limits at 1,000. Inspect `more` where returned. Narrow
time windows or page `data search --offset N`; investigate does not expose offset pagination.
Concurrent appends can shift pagination, so pin an `--until` time when comparing pages.

Aggregate views provide example evidence IDs for inspection. Their limits constrain returned
groups, not all database work; narrow supported source/session/time filters before running
broad aggregates. Time bounds exclude undated records. Unknown origins remain unknown; a
fixture-looking path or session name is not proof that a record came from a test.

## Preserve records and verify archive retrieval

Keep all raw records, gzip segments, manifests and integrity checkpoints indefinitely. Do not
delete or expire them to reclaim disk. Rotation preserves the older prefix in gzip and recent
records in the live file. `data search` includes indexed archives by default; `--no-archives`
and older live-tail commands deliberately have narrower coverage.

`data show ID --json` retrieves the raw record and checks its SHA-256. Verify that result before
relying on it. If retrieval fails after external rotation, rerun the index and retry; preserve
the original error if it persists. Do not edit evidence to make verification pass. The search
database is derived and can be rebuilt without changing raw history, but do not routinely
rebuild it for freshness. Per-pass limits do not cap its total disk footprint.

Historical chain verification and raw-row hash verification answer different questions. An
audit checkpoint is an explicit local observation boundary, not a repair or a signed trust
anchor. Do not create one merely to turn a failing historical verdict into a passing report.

## Handoff with enough evidence to assess the result

Include the question and project/session/file/time scope, relevant capture and index coverage,
the observed result, supporting record IDs and raw-hash verification, and unresolved gaps.
State which fresh checks verified the current code. For maintenance, report which streams
rotated, where archives live, retained live-tail settings, raw and index storage separately,
and the exact automation trigger. Include installed skill updates and any customized copies
the installer preserved. Do not claim all actions were captured or old findings prove a fix.
