# interlinked-observability: calls, outcomes and explanation

Reference for [SKILL.md](../SKILL.md). Read it for `harness calls`, `harness health` finding outcomes or `harness explain`.

## Comparing calls with daemon judgments

Recurrence scans use the selected `--cwd` as their repository context. A throwing
detector or missing prerequisite emits NOT MEASURED while healthy detectors continue.
These notices are surfaced through stderr/callbacks; the retained finding receipt does
not yet contain a complete structured inventory of unavailable detector scope. An empty
finding list therefore does not establish that every detector ran successfully.

`interlinked harness calls [--since 7d] [--session <id>] [--strict] [--json]`
joins live `timeline.jsonl` tool calls to live collection judgments by session AND
tool-use ID. It lists unjudged observed calls by tool, working folder and time span.
Run from the project root. Exit 0 means reported, 1 means `--strict` found unjudged
calls, and 2 means no calls/evidence or an error. This measures the observed live
window; rotated or missing capture is a gap, not a clean enforcement claim.

## Tool-output efficiency lab (source checkout only)

Use `evals/tool-output-efficiency/README.md` for frozen native-session measurement,
code/decision/embedding selection, and the explicit capture/expand wrapper.
No question means the declared baseline; `--full` bypasses selection. Keep the
receipt ID and expand missing evidence or exact edit text before acting. Offsets
are end-exclusive UTF-16 units. Selection is advisory and does not alter hooks.
Keep native logs local unless remote submission is explicitly authorized.
The lab's live model controls are synthetic; `.local/` artifacts remain ignored.
Report same-agent/same-compaction repetition separately from later compactions
and other agents. No observed later use is not proof of waste. Character budgets,
recorded token additions, repeated provider input, costs, and live context size
are different measurements. Replay does not establish live expansion behavior
or task success. See RESULTS.md before claiming savings or adopting filtering.

## Finding outcomes and explanation

`interlinked harness health --json` adds `finding_outcomes` and `corpus_precision`. `harness health --recheck --file src/a.ts` runs up to 20 confined files (2 MB each); omitted files come from retained finding records. Read failures remain unavailable. This explicit raw-detector recheck is independent of whether the agent edits again.

The first raw file cohort is `async_promise_executor`, `nan_comparison`, and `unawaited_async_assertion`; this measurement cohort is separate from corpus qualification. Versioned `check-observations.v1` rows share the existing check-results stream. Full compatible successful rechecks with zero hits for that file/check can establish observed clearance. Partial scans, suppression, deletion, detector/config changes and missing execution cannot establish repair. The derived `finding-outcomes.v2` uses conservative file/check occurrence slots, independent of build identity. Changed text or multiplicity is ambiguous; it cannot credit a removed occurrence while that check still finds another. Counts are finding slots, not semantically unique defects. Delivery is intended/unknown, not inferred native receipt.

The report shows distinct findings, emissions, follow-up coverage, recurrence, unavailable states, execution time and the observation window. Stop records individual intended emissions after filtering, capping and deduplication; a summary count is not individual delivery evidence. Inline deferrals retain acknowledgement reason/time/session and do not count as clearance. Native receipt remains unknown. Precision uses adjudicated live corpus hits only, with unsampled hits and scope visible; corpus freshness is not recomputed by health. Triage time remains unmeasured. Observed clearance is not causal fix rate. Legacy Boolean resolution scores are no longer produced or used by this report. The current reader covers the unrotated local log only; archives and legacy outcomes remain unknown.

The outcome reader scans at most the newest 2 MiB and retains the newest 2,000 complete rows, with a 128 KiB per-line limit. JSON `read_window` reports omitted prefixes, records, oversized and incomplete lines. It does not claim all-time totals. Build-time identity is embedded in packaged code and combined with the Node runtime/platform; it needs neither a lockfile nor a directory hash at command startup. Source-mode identities remain process epochs and cannot establish cross-process clearance.

`harness explain <topic> --client <client> --json` separates implemented, enabled here, declared client support and latest retained execution (including clean execution). Observations carry timestamp, scope, configuration and detector identity; a seven-day recency field is separate from current-runtime matching. Missing observation is unknown, not disabled.

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
interlinked query stop-digest --where kind=stop-rescan-finding --where file=<file>
tail -n 40 .interlinked/stop-digest.jsonl | jq -r '[.kind,.tag//.check,.file]|@tsv'
```

Row kinds: `stop-warning` (a trimmed nudge), `stop-rescan-finding` (one row for
each finding the Stop rescan message counts, with check id, line and text: the
message prints at most four for each file, and its `...and N more` line names this
query), `unknown-writer` (a finding on a file that entered the rescan only because
Stop observed a workspace change that no tool call of the session declared),
`subagent-attributed` (a finding on
a file a SUBAGENT wrote — attributed via `timeline.jsonl` and kept out of the
main list), `pre-existing` (present in the session's git baseline), and
`sanctioned-scratch` (probe-pattern findings under root `scratch/`, which the
scratchpad policy sanctions — still reported by `interlinked verify
--all-checks`). The sanctioned classes are what a probe IS: print, no
companion test, import-time side effect, raw `JSON.parse`, plus the
entry-script family whose own rationale exempts bin/cli files — argv
boundary, env read, unjustified cast, wall clock, magic number. Product
code outside `scratch/` keeps every one of them.

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
