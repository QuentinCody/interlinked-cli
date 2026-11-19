# interlinked-quality-gates: e2e coverage water-line

Reference for [SKILL.md](../SKILL.md). Read it for the e2e coverage lane. Most of it applies only in the Interlinked CLI checkout.

### E2E coverage water-line

In the Interlinked CLI repository, run `npm run build:e2e`, then
`npm run test:e2e:coverage`, then
`node dist/index.js coverage check --lane e2e --strict --require-measured`.
`interlinked coverage status` shows quality coverage lanes; it is distinct from
`interlinked harness coverage status`, which describes filesystem observations.

The e2e lane reads only `coverage-e2e/coverage-summary.json` by default. Its
adjacent `run.json` must bind a passing child-process run to the current build,
test inputs, inventory and report. Missing, partial, stale or malformed evidence
fails. The full inventory includes zeroes for unexecuted code. Generated-hook
strings are checked behaviorally and excluded from line metrics.

Create an absent `.interlinked/coverage-e2e-baseline.json` only with
`coverage check --lane e2e --init-baseline`. It refuses an existing file.
`--update-baseline` saves only after every check passes; failure preserves the
baseline bytes. All four percentages, touched-file share and weighted line
coverage have zero tolerance. `--changed-files` conflicts with `--lane e2e`.
`coverage baseline --lane e2e` displays the baseline, including line counts.

Deleted code carries no obligation; surviving files retain their floors.
A deletion plus a new boundary path is UNRESOLVED until the author records
`coverage move --lane e2e <old> <new>` or `coverage retire --lane e2e <old>`.
Retire refuses surviving executable boundaries. Moves preserve entries; use
repeatable `--map A=B --map B=C` for atomic chains. A destination must meet its
transferred, pre-write and base floors. If a move cannot meet them, collect
coverage and use `coverage check --lane e2e --map A=B --map B=C --update-baseline`
to apply mapping and measured values in one locked transaction.

Local comparisons use HEAD. CI supplies `--base <sha>`: the PR merge base or
the push's previous revision. Missing history, new-ref zero SHAs and force pushes
fail closed. `INTERLINKED_PRE_PUSH_SKIP_E2E=1` records an explicit skipped e2e
row; CI still runs. Intent and effect guards also check CLI writes; they judge
values and tree evidence without trusting a writer's identity.

Behavioral contracts complement metric gates: `tests contracts inspect|run` separates
expectation provenance, configured acceptance, execution failures and unavailable evidence.
Exact example/expectation conflicts require reconciliation; a citation without an exact
observation binding remains a semantic review obligation. Passing agent-authored tests,
coverage or mutation scores cannot certify expected answers. `tests contracts run
--previous <manifest>` retains old expectations against current code; legitimate behavior
changes remain possible through explicit requirement/rationale review. This is not a new
heuristic edit block. Use **interlinked-verify** for schema, runner budgets and ownership.

Execution evidence is available through `interlinked data checks` and `data investigate`.
`check-results.jsonl` retains per-call findings and reported execution coverage;
`check-executions.jsonl` records each configured quality-loop entry, including disabled,
skipped, deferred, error, and completed states. A completed check with no reported findings
is not necessarily a clean whole-file verdict because diff-aware filtering applies. Other
check pipelines have separate coverage. Capture does not change any gate decision.
These run before an edit lands. The local metric ratchets use **delta semantics**: holding or
reducing existing debt is allowed. Per-edit mutation is separately configurable as off, warn,
or block.
