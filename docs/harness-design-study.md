# Applying the harness-design study to Interlinked CLI

Source: Fan et al., [An Empirical Study of Harness Design for Coding Agents](https://arxiv.org/pdf/2609.20804), arXiv:2609.20804v1, 17 September 2026. Reviewed 11 October 2026.

## Evidence and limits

The study compares 176 settings across four models and two coding benchmarks.
Context management primarily prevents overflow under tight budgets; early rule-based
elision reduces summarization cost. Recall is rarely used. Planning can reduce excess
verification for stronger models, while tool-interface benefits depend on model and
task (sections 3–4). Planning and interface ablations use only T4/128k. The interface
comparison also changes instructions, state tracking and diagnostics. Safety and
stuck detection are held fixed, so the paper does not establish their causal benefits
or justify removing guards (section 2.4 and Limitations).

## Local decisions

Interlinked CLI supplies checks and feedback around provider-owned agent loops. It
does not own their context windows or compaction policies. The practical application
here is to reduce avoidable CLI output before it consumes the provider's context.

`tests plan` previously rendered every selected test and all its selection reasons.
Default full-suite selection can make that list dominate a tool response before the
agent reaches the execution diagnostics. `tests status` similarly listed every pending
input without a display bound.

The normal display now keeps the counts, snapshot, reuse eligibility and classifier
estimate, while showing at most 12 entries in each listing and shortening long entries.
Every display omission names what was hidden and how to expand it. `--details` reveals
the complete listings, including tests omitted from execution; JSON remains complete.
The display never changes the scheduler request, pending queue, receipt, runner output,
failure reason or exit code. There is no model call or separate recall store.

`tests run` also identifies whether its passing evidence comes from a completed run,
a shared run or a reused receipt. Runtime validation that is absent or incomplete is
stated explicitly. Non-passing requests never acquire a passing claim from an eligible
plan or an earlier runtime check. Status identifies a pending full-suite request even
when it has no named input paths.

The verification skill now recommends defining the required scope, tracking completed
checks, and repeating them when changed inputs or unresolved evidence warrant it.
Existing gated batch edits provide a way to group coherent changes. Provider tools,
security policy, verification gates and the default prohibition on static test
selection/result reuse are unchanged. The paper is not evidence that classifier-based
omission is safe, that all shell edits are preferable, or that tests should be skipped.

## Validation

Formatter regressions exercise 5,000 tests, hundreds of long reasons, missing timing,
complete detail recovery, immutable plan data and distinct evidence states. Command
regressions preserve full JSON, failure diagnostics and exit codes while exercising
compact and detailed modes. Registrar tests cover `--details` for plan/run/status.

A synthetic full-suite plan with 5,000 `test-N.test.ts` entries, each carrying
`Full reconciliation requested`, rendered 244,042 characters with the previous
formatter and 786 with the compact formatter (99.68% less display text).

These checks establish a bounded display and preserved execution behavior. They do
not measure agent accuracy, billed tokens or task completion time. Those require
paired runs on the same tasks, model, provider, budget and checks, recording both
functional outcomes and native usage; the existing `evals/compare-builds.mjs` is the
appropriate starting point for an explicitly requested agent pilot.

Skill impact: `skills/interlinked-verify/SKILL.md` owns the updated command and
verification workflow. Existing router destinations and harness behavior are unchanged.
