# Semantic relations in actual use — 2026-10-27

**It helped as a bounded second opinion, but this trial did not establish incremental
debugging benefit over Astra inspection and execution.** Haiku identified an actual
inconsistency between two outcome-reporting functions and its pair assessment followed
the repair, including two comment controls. Astra had already identified that defect
and its distinguishing test before seeing the predictions. Jev abstained on the relevant
pair and group throughout. No additional verified defect or necessary test came solely
from the semantic judgments.

Using the built CLI did uncover a separate `--cwd` integration defect. Both that defect
and the interrupted-child reporting defect are repaired with regression tests. Those
are useful dogfooding outcomes; they do not establish semantic discovery quality.

## Retrieval first

Three authored invariants covered completed-verdict reporting, worker memory, and
inference accounting. Each named three functions. Retrieval sought the other two
participants from the first anchor, at k=12:

| Invariant | Shared rules | Lexical |
|---|---:|---:|
| Completed verdict | 0/2 | 1/2 |
| Worker memory | 1/2 | 2/2 |
| Inference accounting | 0/2 | 1/2 |
| Total | **1/6** | **4/6** |

This is registry-relative coverage in a **533-unit source capture**, not repository-wide
recall. The isolated repository has one initial capture commit, excluded from co-change
pair generation by the 30-file commit limit; its history is available but its co-change
map is empty. Real historical co-change was not evaluated here. Neither retrieval arm
recovered the authored registry completely. Shared-rule group packets remained incomplete
for all three invariants; lexical retrieval missed the accounting group. Judgments below
use curated participants and therefore do not cure these discovery misses.

## What was actually run

The prior [exploratory study](../2026-10-27-exploratory/REPORT.md) covers broader A/B
cohorts, directed coupling and authored comparison fixtures. This follow-up uses the
**packaged `dist/index.js` commands** during real debugging: prepare, freeze, assess,
cached assess, export, paired-plan creation, paired assessment and comparison. Child
command receipts, frozen inputs and result bundles are retained here.

The dirty source under review was copied into a separate Git repository under
`scratch/semantic-relations-runtime/repo`; no main-repository commit or staging was
performed. [Protocol](protocol.json) records source hashes, the source checkout's
base commit, prior knowledge and the utility criterion. All repair/control preparations
use the original policy revision and pre-change history tip/window. Later fixes cannot
enter the candidate history. The study's snapshots are retained in exported artifacts.

J is pinned to `jev-1.14.0`. H is subscription Claude Code 2.1.312,
`claude-haiku-5-5`, low effort, with the frozen tool restrictions and a successful isolation
canary. Both use the existing 0.80 answer threshold. D remained unavailable because the
local adapter/model was not installed; it was not replaced or downloaded. Astra supplied
the [blind ordinary-inspection baseline](ASTRA-BASELINE.md) and later reviewed the fixes.
The [final Astra review](ASTRA-REVIEW.md) found no actionable corrections to this report.
There is no human-review or deployment-qualification claim.

The authored completed-verdict invariant explicitly names null exit status and absent
local cancellation flags. It supplies the semantic rule and the edge case. This is an
assessment of selected code against a known invariant, not discovery of that invariant.
The success criterion was a new verified finding, a new necessary test, or materially
less source inspection beyond the frozen baseline. None was established.

## Real debugging outcomes

| Task | Execution/source evidence | What the relation judgments added |
|---|---|---|
| External child termination | Supervisor returned 75 without interruption stderr or a deferred row. The bounded-command path retained both distinctions. | H confirmed Astra's prior hypothesis; J abstained. No new probe or defect. |
| Worker memory | Five previously failing files passed all 76 tests on Node 22. Actual V8 total heap differed between Node 22 and 25 at the same old-space cap. | H accepted a supplied producer pair/group; the packet omitted the failing assertions, so it did not diagnose the test failures. J mostly abstained. |
| Inference accounting | Exact reuse returned all 36 measurements with zero calls. Paired reuse returned all 72 with zero calls. Focused tests cover error/budget/cache semantics. | Mostly membership answers and abstentions; no new accounting failure. |
| Nested CLI options | Real `prepare --cwd <isolated repo> --revision <isolated SHA>` initially resolved the SHA in the main repository. | Found by executing the CLI, not by a semantic model. |

The CLI fix merges Commander ancestor options with leaf options before dispatch. Tests
exercise both `prepare` and positional `assess` through the actual metrics registration
hierarchy. The failed prepare receipt and successful retry are preserved.

The supervisor fix requires a non-null exit code before returning without interruption
telemetry. A failing-before/passing-after test distinguishes external termination from
a child's own numeric exit 75. Real Node subprocess probes confirm the same distinction:

| Probe | Before | After |
|---|---|---|
| Child terminates itself with SIGTERM | Exit 75; no diagnostic; zero ledger rows | Exit 75; no-verdict diagnostic; one deferred identity-null row |
| Child deliberately exits 75 | Exit 75; no interruption fallback | Same |
| Bounded-command success, failures 3/75/127, external SIGTERM | Expected completed/failure/interruption classification | Same |

This repairs **observability**, not a reproduced false pass. See
[corrected before probes](runtime-probes-before-files.json) and [after probes](runtime-probes-after.json).
For bounded-command probes, the parent instrumentation prints the outcome; its own
process status is not the check's status. Use the recorded outcome/report and ledger.

One limitation remains: on POSIX, `nice` cannot execute a nonexistent target and exits
127. The structured result classifies this like a target that genuinely starts and exits
127. This loses target-launch provenance, although it records failure and never a pass
in these probes. Blanket remapping of 127 would break the deliberate-exit control.
Reliable launch provenance is separate follow-up work.

## Repair and wording controls

Before and repaired snapshots each contain 18 packets per model: nine membership,
six compatibility and three group questions. The outcome totals were:

| Arm | Before answered / abstained | After answered / abstained |
|---|---:|---:|
| Jev | 6 / 12 | 5 / 13 |
| Haiku | 8 / 10 | 7 / 11 |

No model call failed. The repaired predicate is `result.code !== null && ...`.
It also has a comment explaining external signals. Two post-hoc controls separate
those changes: the comment added to the broken predicate, and the fixed predicate
without the added comment. Each requests three pair/group judgments per arm;
twelve over-budget observations remain explicitly unassessed in each control run.

| Code condition | H reporter/supervisor pair | H same-participant group | J pair / group |
|---|---|---|---|
| Broken, original comments | Contradictory .87 | Contradictory .82 | Abstain / abstain |
| Fixed, explanatory comment | Compatible .92 | Abstain (contradictory .55) | Abstain / abstain |
| Broken, explanatory comment only | Contradictory .86 | Contradictory .88 | Abstain / abstain |
| Fixed, added comment removed | Compatible .82 | Compatible .82 | Abstain / abstain |

These are selected-answer probabilities, not correctness probabilities. H's pair
behavior follows the code in this small control set. The group result is less stable.
Even the unchanged reporter/`commandStatus` pair moved between answered and abstained
across fresh reads (.80, .72, .80, .85 compatible for H), despite identical visible
evidence. One observation per condition cannot separate sampling variation from wording
sensitivity. J's repaired pair still leaned contradictory below threshold; abstention
prevented an actionable false alarm, but supplied no repair signal.

The actual [paired comparison](comparison.json) reports 1 changed categorical
assessment, 2 same assessments and 33 non-comparable rows: 25 unresolved and 8 with an
unchanged visible packet inside a changed whole snapshot. There are no unmatched
participants. It correctly does **not** declare the run fully comparable or label the
repair as semantic drift. Executable probes substantiate the behavioral repair.

## Latency, cost and working friction

| CLI assessment | Wall time | New calls |
|---|---:|---:|
| Initial 36 judgments | 117.864 s | 37, including H canary |
| Same frozen input, cached | 0.347 s | 0 |
| Repaired 36 judgments | 112.464 s | 37, including H canary |
| Paired 72 observations, cached | 0.499 s | 0 |
| Comment-only control | 17.935 s | 7, including H canary |
| Fix without added comment | 21.833 s | 7, including H canary |

Initial J cost is an adapter estimate of $0.001555302; initial H usage is
$0.02071580 at CLI-reported list equivalence under the subscription. Repair figures
are $0.001560972 and $0.01279356 respectively. Control costs and all call accounting
are in [summary.json](summary.json). J estimates use $0.042 per million input tokens;
these are not invoices. H figures are not incremental subscription charges. Cache-hit
measurement costs remain null, with zero calls; historical response costs are not
charged again. Astra review and orchestration were not metered, so this is not a
total-cost or time-saving comparison.

The expensive part for an interactive reviewer is setup: capture the intended dirty
source, author the invariant, select participants/context, specify engines, freeze,
assess, then inspect large JSON artifacts. This run needed custom summarization to see
the useful rows. An unchanged input is fast to revisit; any source-snapshot change
invalidates all inference reuse, and invisible changes conservatively limit comparison.
Neither cached latency nor low model usage establishes a fast edit-time workflow.

## Verification and retained failures

- Full Node 22 run: **65,827 passed, 1 failed**, 4 expected failures and 13 skipped;
  2,954 files passed, one failed and two skipped. The failure was current corpus
  qualification for `async_promise_executor`. Source was being edited during the run.
- With source quiet, that entire file passed **11 tests**. A fresh diagnostic scanned
  all 5,214 eligible inputs, reported no hits/failures, and retained a current binding.
  Concurrent edits are a plausible cause, not proven by the original log. No clean
  rerun of all 65,845 tests is claimed.
- Final focused Node 25 run: **116 tests in 14 files passed**, including relation
  workflow/history/store/engine/fixture tests, option routing, resource commands and
  real cancellation integration tests.
- The five files that failed under Node 25 in the earlier full run passed **76 tests
  on Node 22**. The earlier ten Node 25 failures are not claimed fixed. Heap probes
  measure 1536 MiB old space as 1584 MiB total heap on Node 22 versus 1728 MiB on Node 25;
  this does not explain every symlink/runtime failure.
- Stable TypeScript checks, packaged build and docs checks passed. Docs retain the
  pre-existing stale landing-page date warning. Three affected repository skills
  were updated and validated; routing is unchanged.

Logs and machine-readable results are in [verification/](verification/results.json).
Two study-harness mistakes are preserved: the first supervisor probe used `--eval`,
which was forwarded through `process.execArgv` and did not run the intended child;
only `runtime-probes-before-files.json` is used for supervisor conclusions. The first
control-cohort assertion incorrectly expected over-budget packets to be dropped;
the product correctly retained them. The assertion was corrected and the same
prepared plan resumed before any model calls. Neither is presented as a product defect.

## What I would use now

I would use this for an **explicit invariant review with already selected context**,
as a recorded second opinion followed by code inspection and execution. I would not
yet make it my default runtime navigator or treat its changes as alerts. This run
showed zero verified findings unique to the semantic judges, substantial setup work,
retrieval misses and unresolved group comparisons. It did show a useful Haiku pair
signal on a real defect and repair, plus functioning immutable evidence and cache reuse.

The next product work should lower the cost of preparing and reading a bounded review,
improve candidate/context recall, and test incremental utility on unseen tasks with
the ordinary Astra baseline recorded first. Pair and group reliability need separate
measurement. Jev has not earned preference over the small-LLM arm in this runtime case.

Regenerate the derived numerical summary without inference:

```sh
node --import tsx semantic-relations/summarize-runtime.ts
```

`runtime-evaluation.ts` and `runtime-probes.ts` retain the executed recipes. Their
study destinations are fixed and existing inputs/results must not be overwritten.
For a new run, copy the recipe and set fresh study and source-capture directories before executing
prepare → assess → cache → repair → repair-assess → compare, then the two controls.
