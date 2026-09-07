---
name: interlinked-spec-audit
description: "Keep prose specs and design docs honest against the code using Interlinked's spec-audit system. Load this when extracting a doc's invariants or facts (`interlinked spec invariants`, `spec agenda`), when you see `[interlinked:spec-drift]`, `[interlinked:spec-marker]`, `[interlinked:spec-xref]`, or `[interlinked:disputed-ground]` warnings after editing markdown, when ingesting/triaging an external review report (`interlinked findings ingest / status / verify / ack`), or when running executable doc examples (`interlinked doctest`). The system detects and tracks — it never auto-fixes; you write the fix. Covers the fact ledger, findings reconciliation, invariants/agenda, and current-state caveats."
---

# interlinked-spec-audit — keep prose specs honest against code

The spec-audit system is three cooperating substrates plus doctest. Its one policy: **detect,
never autofix** — findings carry evidence and candidate resolutions, but the agent always writes
the fix.
- **Fact ledger** (`interlinked spec`) — deterministically extracts the *enumerable facts* that
  drift during revision (ID registries like `FG-INV-07`/`B7`, count/range claims, headings/
  `§`-refs, backticked paths, `<!-- fact:NAME -->` markers), merges them cross-file, and flags
  disagreements ("drift") at edit time.
- **Findings reconciliation** (`interlinked findings`) — ingest an external reviewer's numbered
  report into a durable corpus, then track each finding to closure (*touched* by an overlapping
  edit, or *acked* with a reason).
- **Invariants + review agenda** — extract a doc's invariants into a taxonomy, and generate a
  standing discovery agenda for the next reviewer.

## Load this when
- Extracting invariants/facts from a design doc, or building a review agenda.
- You see a `[interlinked:spec-*]` or `[interlinked:disputed-ground]` warning after a markdown edit.
- Ingesting or triaging an external code-review report.
- Running executable examples embedded in docs.

## `interlinked spec`
Two subcommands, no flags:
```bash
interlinked spec agenda                       # → .interlinked/review-agenda.md
interlinked spec invariants <file>            # → .interlinked/policies/<basename>.invariants.md
```
- **`spec agenda`** — walks cwd, writes a review agenda with three sections: **compose-checks**
  (an ID namespace/declared fact constrained from ≥2 files — "read them together, confirm no
  contradiction"), **coverage gaps** (a section whose heading matches a *kind* — format /
  protocol / crypto-keys / … — but whose body omits that kind's standard concerns), and
  **outstanding deterministic drift**, then an **open review-findings** section appended last. It
  asks questions, never renders verdicts.
- **`spec invariants <file>`** — for markdown: numbered registry rows + MUST/never/"sole truth"
  doctrine sentences (fenced code/blockquotes skipped). For code: `// INVARIANT:` / `// SAFETY:`
  comments + `assert(`/`assert!` calls. Output is a labeled taxonomy with verbatim quotes +
  `file:line` provenance (review context / Tier-2 classification input).

## `interlinked findings`
Review-report ingestion + reconciliation. The CLI operates on `review_`-prefixed findings.
```bash
interlinked findings ingest <report> [--reviewer <name>]   # parse a numbered report into the corpus
interlinked findings status [--all]                        # "N total — X open, Y touched, Z acked"
interlinked findings verify [--write]                      # re-anchor findings whose lines moved
interlinked findings ack <findingId> --reason <text> [--by <name>]
```
- **ingest** parses findings that start at **column 0** as `N. [severity: high] statement…`
  (severity optional; first repo-path`:line` token = the anchor; `Evidence:` line = the quote).
  `bug_class` is derived from the statement's first 6 words, so **re-ingesting a reworded finding
  creates a new row** (same text merges provenance).
- **status** folds the reconciliation sidecar; open findings are what you must close.
- **verify** re-checks each finding's anchor against the tree (live / moved / drifted / gone /
  unverified); `--write` re-anchors *moved* rows. **verify never changes reconciliation state** —
  it keeps the ledger true, it doesn't close anything.
- **ack** appends an `acked` txn (a later touch never downgrades an ack).
- An edit that overlaps a finding's cited span (±3 lines) **auto-marks it *touched***.

**Storage:** corpus `.interlinked/findings/corpus.jsonl` (append-only, last-write-wins per `id`)
+ global cache `~/.interlinked/findings-corpus.jsonl`; reconciliation sidecar
`.interlinked/findings/reconciliation.jsonl` (states: open/touched/acked). Two-axis model:
corpus `status` (candidate/approved/…) vs. the reconciliation state the CLI reports.

## `interlinked doctest`
Executes markdown code-fences that opted in with a `doctest` info-string token, asserting each
exits 0. Only tagged fences run (untagged `rm -rf` examples are never executed).
````
```bash doctest
interlinked findings status
```
````
Flags: `--path <file|dir>` (default cwd), `--json`. Each block is an independent
`bash -c` (60s timeout); output `doctest: P/T block(s) passed`, exit 1 on any failure.
**Caveats (verified):** it runs in the CLI's `process.cwd()`, **not** `--path`'s directory (run
it from the repo root); a **missing/typo'd `--path` silently reports `0/0` and exits 0** (check
the total is nonzero); no `cd`/env/var state carries across blocks; the fence language is ignored
(everything runs as bash).

## Checks you encounter at edit time
All gated by config `spec_checks` (default **on**).

The repository ledger skips directory trees Git reports as fully ignored, including local
archive copies. Tracked files inside an ignored directory still participate. Incremental
refreshes and previews preserve the scope captured when the ledger was built; rebuild after
changing ignore or tracking rules. The shared Git-directory query caches for up to one minute.
If Git is unavailable, the bounded filesystem walk still runs with its standard exclusions.
Do not rewrite historical snapshots to satisfy a live-repository link warning. After updating
the daemon, the next markdown observation refreshes the derived Stop stash; evidence logs stay
intact.
A fresh `spec agenda` run can confirm repository scope independently of the daemon's ledger.

**PostToolUse single-file** (8 checks, `severity: warning`): `spec_dangling_anchor` (proven — a
`[x](#slug)` or `§N.N` ref with no target), `spec_numbering`, `spec_count_claim` ("six bets"
above a B1..B7 census), `spec_pitfall` (curated spec falsehoods), `spec_claim_untagged`,
`spec_capacity_claim`, `spec_table_sum` (proven — a Total row that doesn't recompute),
`spec_stage_order`.

**PostToolUse cross-file drift** — on a markdown edit, `[interlinked:spec-drift]` for
count/range/declared-fact/xref drift *involving the edited file* (≤5/edit; the rest deferred to
the evidence log and review agenda).

Quoted code examples, quoted phrases and explicit `Evidence:`/`Example:`/input/output fields
do not assert live numeric facts or contribute example IDs to the census. Individually
formatted identifiers and count tokens remain supported. These rules depend on content,
not repository names or review-directory paths. Declared `fact:` markers must be live markup:
markers inside inline code, fenced code or blockquotes are examples, not declarations.

Generic count claims use a scoped identifier census. A README may describe its directory;
other documents must mention the namespace or link to its home near the claim before sibling
files enter the census. Nearby explicit links can select another document set. A shared noun
such as “gates” does not join an unrelated repository-wide identifier namespace. Stop reports
a repository snapshot; it does not claim
that the current session introduced every finding. Full comparisons, related files, stable
finding IDs and observation provenance are retained in `spec-drift.jsonl` and can be searched
with `interlinked data search --source spec-drift`. The prior session stash is bounded, so
first observation is not evidence of when a defect was introduced.

**PreToolUse spec pre-gates** (arm after the session's first markdown edit builds the ledger):
- **Introduced declared-marker drift → decision `ask`** (`[interlinked:spec-marker]`, exact-match,
  zero-FP): a write setting `<!-- fact:NAME -->` to a value conflicting with other files prompts
  the **human** — it's an *ask*, not a hard block. Response: update every site of the fact (or
  fix the source of truth first), then retry.
- **Removing a heading other files link to → warning** (`[interlinked:spec-xref]`).
- **Introducing new cross-file drift → warning** (`[interlinked:spec-drift]`, introduced-only).

**Disputed-ground** — reading or editing a file that carries **open review findings** emits
`[interlinked:disputed-ground] <file> carries N open review finding(s)… you are building on
disputed ground`.

**Stop nudges** (stderr, never block): retained structural marker/link findings, and ingested
review findings with neither a touching edit nor an ack. Inferred count/range comparisons are
heuristic evidence and never become spec Stop nudges or automatic sibling-edit obligations.
Unclassified legacy stash entries also do not qualify. Structural findings take priority before
the bounded Stop stash is capped, so advisory volume cannot crowd them out. Old inferred
completion entries remain preserved but do not trigger completion reminders or code-signature
Stop warnings.

All observed drift remains append-only in `spec-drift.jsonl`, including heuristic findings;
`stop_eligible` records whether its kind qualifies for a Stop nudge. Search with
`interlinked data search --source spec-drift --json`, or inspect the live tail with
`interlinked query spec-drift`. A quiet Stop does not certify that all prose agrees.
After upgrading Interlinked CLI, use the normal build/update and `reload` workflow in each
running project so its daemon loads the new parser and Stop policy. Existing log history and
review documents are preserved; the next markdown observation refreshes the derived stash.

**How to respond:** for inferred count/range drift, first check whether the text is an example,
historical quotation, sub-range or a live assertion about the same registry. Preserve quoted
review evidence. Only after establishing a real contradiction decide which side is stale,
fix it, recount, then check sibling docs stating the same fact. For dangling
anchors — fix or qualify the ref. For a marker `ask` — update all sites, retry. For
disputed-ground/open findings — resolve with an edit, or `interlinked findings ack <id> --reason`.

## Config & files (`.interlinked/`)
`findings/corpus.jsonl`, `findings/reconciliation.jsonl`, `review-agenda.md`,
`policies/<file>.invariants.md`. Disable the checks with `{"spec_checks":{"enabled":false}}` in
guard-rules.

## Common workflows
```bash
interlinked spec invariants docs/design/big-plan.md   # taxonomy of the doc's invariants
interlinked spec agenda                                # repo-wide review agenda
interlinked findings ingest audit.md --reviewer sol    # triage an external review
interlinked findings status                            # open/touched/acked
# …edit to address findings (overlaps auto-mark "touched")…
interlinked findings ack <id> --reason "deferred to v2; tracked in #412"
interlinked findings verify --write                    # re-anchor moved findings
```

## Current-state notes (honest — verified 2026-07)
- **The findings corpus is local-only despite a "COMMITTED" code comment.** The blanket
  `.interlinked/*` gitignore has no `!` carve-out for `findings/`, so the corpus, reconciliation
  log, and agenda **do not travel in PR diffs or to teammates**. (To actually commit it you'd add
  `!.interlinked/findings/corpus.jsonl` to `.gitignore`.)
- **Cross-file ledger drift is not surfaced in `interlinked verify`** yet — only in the
  PostToolUse ledger phase, Stop, and `spec agenda`. Don't expect `verify` to report it.
- **Statusline spec counters are unpopulated** (no live spec heartbeat on the statusline yet).
- **Marker-drift is an `ask`, not a hard block**, and only arms after the session's first
  markdown edit — the very first markdown write of a fresh daemon is ungated.
- **`findings ingest` is format-specific** (numbered `N. [severity] …` at column 0); reworded
  re-ingests create distinct rows.

## Related skills
- **interlinked-verify** — the general check catalog and how findings/suppressions work.
- **interlinked-harness** — how `ask`/warning decisions reach you; suppression grammar.
- **interlinked-observability** — `interlinked collect` (backfill Codex sessions into the timeline).
