# Semantic relations research

Interlinked CLI now provides `metrics decisions relations` for bounded invariant
review and directed coupling over pinned source. It shares extraction, candidate
rules and runtime storage with `src/harness/semantic-graph/`; decision-metrics owns
the typed questions, inference adapters and audit. All results remain experimental.

The user revised the validation protocol on 2026-10-27: **GPT-6 Astra performs source
review; there is no human-review stage.** Natural-code results measure agreement
with blind Astra references. Executable fixtures substantiate authored behavioral
examples separately. Neither establishes deployment accuracy or repository-scale
benefit. The original human-label staffing estimates are superseded.

## Workflow

Write explicit invariant definitions and scenarios in `invariants.json` and
`scenarios.json`. Commit policy for reviewable revision provenance; use
`--exploratory` while developing an uncommitted registry. Engine specifications are
an explicit JSON array; the study's `engines.json` is an example. D is local
ThinkThen/Ollama with an installed model digest; J is a pinned Jev release; H is
standalone Haiku 5.5 with low effort. No model is installed automatically.

```sh
interlinked metrics decisions relations catalog
interlinked metrics decisions relations prepare \
  --revision HEAD --policy-revision HEAD --engines engines.json \
  --history-tip HEAD --since 2026-01-01T00:00:00Z --until 2026-10-27T00:00:00Z \
  --mode curated --output plan.json
interlinked metrics decisions relations freeze plan.json --output study/input
interlinked metrics decisions relations labels study/input --output study/blind.json
interlinked metrics decisions relations assess study/input --output study/run.json
interlinked metrics decisions relations audit study/run.json --labels study/labels.json --output study/audit.json
interlinked metrics decisions relations export study/run.json --output study/result
```

`prepare --mode retrieved --method shared_rules|lexical --k 3|6|10|12` reports the
authored registry participants recovered by each candidate budget. It keeps missing
selectors in the denominator. This is registry coverage, not proof that the registry
is complete. Curated judgment cases do not establish discovery recall. Embedding
retrieval is optional research and is not implemented in this new command.

For revision comparison, prepare and assess each revision with the **same history
tip and absolute time window from before the change**. Then:

```sh
interlinked metrics decisions relations compare before.json --after after.json --output-plan paired.json
interlinked metrics decisions relations freeze paired.json --output study/paired-input
interlinked metrics decisions relations assess study/paired-input --output study/paired-run.json
interlinked metrics decisions relations compare --assessment-run study/paired-run.json --output study/comparison.json
```

The paired plan carries both revisions and a common engine configuration. Exact
unique logical participants are matched; renamed, split, merged, deleted or ambiguous
participants remain unmatched. No rename guess is treated as continuity. An invariant
or scenario policy change requires a new study. Ordered preserved/weakened/strengthened
judgments are not shipped. Probability changes never become drift or repair labels.

## Artifacts and interpretation

The v1 decision commands and description-claim records remain readable through their
existing readers. Relations use version 2 measurements with explicit record kinds
and populations; group claims cannot mix with description claims. Every observation
binds evidence, dependency hashes, question, engine identity and uncertainty band.
Current observations bind the entire source snapshot as a conservative dependency
boundary: even a change outside selected spans invalidates cached inference.
Selective dependency refresh remains future optimization. Comparisons with changed
snapshots but identical visible packets require context review. Earlier study
observations without `snapshotDigest` remain readable as legacy relation artifacts.
`--fresh` records another observation.
Append-only runtime claims and immutable content-addressed artifacts live beneath
`.interlinked/semantic-graph/`. Freeze bundles include source spans, policy, questions,
tool policy and implementation source assets; assessment refuses changed implementation.
Exported bundles are self-contained and can live in version control. Local Git status
is not changed by these commands; uncommitted exports remain exploratory drafts.

This repository keeps raw study JSON, compressed bundles, model responses and
runtime snapshots local under the ignored `studies/` tree. Only readable Markdown
reports are committed there; root policy JSON and reusable drivers are versioned.
Fresh clones do not contain the evidence needed to rerun the summary scripts. Retain
the original local bundles, or generate a new study in a new directory; the reports
alone are not a complete reproducibility archive.

Assessments retain answered, insufficient-evidence, abstained, failed and unassessed
states. A completed artifact means cohort accounting completed, not successful judgments.
Commands return 0 for artifact completion and 1 for invalid configuration/artifacts;
read the retained statuses for model failures. D/J/H are independent arms, not a cascade.
H runs in an empty directory with tools and MCP explicitly disabled, fixed system prompt,
safe mode and no persistence. It must pass the isolation canary and expose empty tool
inventory; attempted tool calls invalidate the result. Authentication failures remain
failures, with usage/cost retained where available.
On macOS the minimal environment retains `USER` as well as `HOME`, so Claude Code
can resolve the user's existing subscription credentials from the keychain. The study's
initial H failure was caused by omitting `USER`; the recovered H arm uses the same
frozen packets and threshold, with the original failed preflights preserved.

`audit` separates each contract, engine, label source and development/holdout split.
It reports full-cohort confusion, coverage, raw probability Brier scores and explicit
one-sided 95% Clopper–Pearson bounds. H's probabilities are self-reported. Bounds are
descriptive, conditional on independent case IDs, and do not turn model labels into
truth. No learned threshold, deployment qualification or automatic alert is implied.

## Reproduce the exploratory study

From a source checkout, run `node --import tsx semantic-relations/run-experiments.ts
prepare <new-study-directory>`, then `assess <study-directory> fixtures|A|B`.
The script freezes 16 executed mechanism fixtures and 200 cases each for A and B,
with named backends and bounded spend. The local study retains the frozen inputs,
blind Astra references, actual backend outputs, candidate coverage and failure records.
Use a new study directory when changing inputs or implementation. The initial frozen
threshold is 0.80; retrospective argmax diagnostics must not replace that operating point.

See [the experiment report](studies/2026-10-27-exploratory/REPORT.md) for actual results,
unavailable arms, construct limitations and the resulting product decision.

See [the runtime evaluation](studies/2026-10-27-runtime/REPORT.md) for use of the
built CLI during actual debugging, ordinary Astra review as a prior baseline, real
child-process probes, a source repair, candidate misses, and fresh versus cached cost.
`--cwd` selects the source repository through the full nested command hierarchy.
Source is always read from the pinned revision; `--exploratory` only changes policy
loading. The runtime study captures dirty source in a separate Git repository without
committing or staging the developer's working tree.

The completed study also includes `run-haiku-arm.ts`, `run-targeted-coupling.ts`,
`run-comparison-controls.ts`, `run-haiku-comparison.ts` and `run-neutral-controls.ts`.
The neutral control preserves source/scenario bytes while removing descriptive fixture
IDs from model-visible metadata; original cue-exposed results remain separate. Supplemental runs preserve
their own input freezes and protocol amendments. Regenerate the numerical tables
without making model calls with `node --import tsx semantic-relations/summarize-experiments.ts`.
Do not rerun a study into an existing immutable input/result directory; use a new
destination and preserve failed attempts alongside any full-cohort retry.
