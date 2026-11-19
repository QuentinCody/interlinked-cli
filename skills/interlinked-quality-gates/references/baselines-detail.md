# interlinked-quality-gates: baseline detail

Reference for [SKILL.md](../SKILL.md). Read it for decomposition campaigns, the SessionEnd auto-fold or `max_predicate_drift`.

### Decomposition campaigns (added 2026-09-02)
The gates carry campaign-aware relaxations so a refactor is never blocked by the
metric it improves: the cyclomatic block lists a `↳ plan:` (fewest arm
extractions to get under the cap); per-edit coverage treats a RELOCATED uncovered
line as moved, not added; per-edit mutation reconciles survivors that moved into
an extracted helper; `mutation_directed_assertion_removal` recognizes an assertion
moved to a new test file (`INTERLINKED_ASSERTION_MOVE_WAIVER=1` is the logged
escape). `structural_checks.characterize_mode: block` requires a test run covering
the file before a ledger-listed function is edited. Two advisory nudges catch the
decomposition footguns: `new_export_without_importer` and
`extracted_helper_duplicate`.

### SessionEnd baseline auto-fold (added 2026-08-16)

Three of those water-lines used to go stale, because refreshing them needed a human to
remember a manual full run — measured 2026-08-16, the coverage and untested-files
baselines were 49 and 66 days old, and one `interlinked adopt` dropped 38 exemptions
that had been earned weeks earlier. The daemon now folds the session's own evidence
back in at **SessionEnd**, so the bar tracks the tree instead of lagging it:

| Fold | What it does | Refusal direction |
|---|---|---|
| coverage | raises per-file high-waters from a **fresh** `coverage/coverage-summary.json` | a pct that FELL is held at its high-water, never lowered |
| untested-files | drops the exemption for a file you wrote that now has a companion test | never ADDS an exemption |
| large-files | drops (or lowers) the grandfather count for a file you brought back under the cap | never adds a new entry, never raises a count |

Each fold is independent and skippable; the whole pass is time-bounded (~2s) and never
throws into SessionEnd. When something folds, the session shows one line —
`[interlinked:baseline-fold] coverage +N raised, untested -M dropped, large-files -K dropped`
— and one JSONL row per fold lands in `.interlinked/baseline-folds.jsonl`. A dry run
(`interlinked harness test`) writes nothing.

The fold writes through plain `fs` from inside the daemon, so it does not pass the
PreToolUse baseline-integrity gate — the same sanctioned carve-out `coverage-ratchet.ts`
and `interlinked adopt` use. That is safe only because the loosening direction is refused
in the planners themselves, not merely avoided.

**Opt out** with `{"baseline_autofold": {"enabled": false}}` in
`.interlinked/guard-rules.local.json` (default ON). This does not replace
`interlinked adopt` — adopt still seeds a repo from scratch and folds metrics the
auto-fold leaves alone.

The unjustified-cast ratchet counts distinct assertion-token lines, even when a line contains
multiple assertions. AST detection broadens syntax coverage without changing that unit.
Both pre-edit and proposed content use the same file path and parser selection. If the
optional TypeScript parser is unavailable, the legacy lexical counter is used; malformed
syntax retains lexical findings alongside recovered AST findings. This remains an advisory
cast review signal, not proof that an assertion is unsound or a safety comment is correct.

### `max_predicate_drift` — ratchet the unchecked-assertion count to zero (added 2026-08-09)

A repo-wide COUNT water-line, not a per-function cap. It bounds how many
`type_predicate_drift` findings the tree may carry: a hand-rolled
`function isFoo(v): v is Foo` that validates some of `Foo`'s required properties
and silently ignores the rest.

Why it needs a ratchet rather than a block: `v is T` is an **unchecked assertion**.
TypeScript never compares the predicate body to `T`, so adding a required field to
`T` leaves every stale guard returning `true` — no compile error, no test failure.
The count only ever grows by accident, so the water-line only ever falls.

To clear a finding, do not enlarge the guard — replace it with a parser:

```ts
export function parseFoo(v: unknown): Foo | null {
  if (!isJsonObject(v)) return null;
  // …validate each field…
  return { a, b, c };   // CONSTRUCTED literal — the compiler checks it against Foo
}
```

The constructed return is the point: add a required field to `Foo` and this fails
to compile at the boundary instead of under-validating at runtime.

Measure the current count with `interlinked verify --all-checks` (section
"type predicate drift"), then lower `max_predicate_drift` to match. Raising it is
blocked by `baseline_integrity_gate`.

> **Two different "min coverage" numbers:** `metric-caps.json → min_coverage` = the per-file
> **floor for the edit-time gate** (default 0 = off). `untested-files-baseline.json →
> min_coverage_pct` = the threshold deciding whether a companion-less file counts as "tested"
> for the `untested_files` verify check (default 60). And **two coverage baselines**:
> `coverage-baseline.json` (full-suite CLI) vs `coverage-edit-baseline.json` (per-edit gate).
> Editing the wrong one has no effect on the gate you're trying to satisfy.
