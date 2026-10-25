# Decision models and graphs: six pilot experiments

All six pilot areas ran, plus a Clef-flash comparison against the original frozen final-judge benchmark. The strongest new evidence favors **semantic linking followed by deterministic checks**, especially qualifier attachment and token localization. It does not support replacing graph queries, applying Jev thresholds to Clef, or promoting any result to a blocking policy.

Artifacts are under `scratch/2026-10-20-decision-graphs/`. `completion-audit.json` records calls, cost, input equality, mutation-source integrity and observed kill-graph results. All semantic labels used in the mutation and historical extraction replays remain explicitly model-produced.

## Design and execution

The construction suite contains 48 provenance cases, 24 extraction messages, 24 instruction histories and 16 module graphs. Each has development and held-out rows, fixed before requests. The held-out results below use 36 provenance cases, 18 extraction messages, 18 instruction histories and 12 module graphs. Related templates make these small controlled tests, not population estimates.

The repository replays use 50 historical messages with 666 frozen model-reference claims, 24 git changes covering 22 distinct functions/files, and the existing 166 compiler-valid mutants. Replays are retrospective. No new labels, model wording or ranking weights were tuned against their outcomes.

Jev used `jev-1.13.0`. Clef used the hosted `clef-flash` selector; an immutable backend revision is not exposed. Each request, response, returned model, latency and usage is retained. Requests use at most 60 questions to fit Clef's current 64-question limit. [TypeSafe models](https://docs.typesafe.ai/models), [Clef-flash reference](https://developers.cloudflare.com/workers-ai/models/clef-flash/)

The first Cloudflare request failed with 401 because the stored OAuth access token had expired. `cf auth whoami` refreshed it through the existing login. The missing Clef arm resumed with byte-identical cases and unchanged question builders; Jev was not rerun. The failed request remains in `core-01/clef-flash/`; completed Clef results are in `core-clef-02/`. The first run therefore has no top-level completed summary, but its four Jev phase results are complete.

## 1. Provenance: selecting a receipt works better here than asking for an overall verdict

Cases combine component aliases with current passing receipts, failed runs, changed dependencies/configuration, assistant summaries, missing input capture, execution races and environment changes. Positive controls also include unrelated edits and matching restored bytes. Answers are known by construction; the graphs assume trustworthy capture metadata.

| Arm | Supported positives /12 | False endorsements /24 |
| --- | ---: | ---: |
| Graph + lexical receipt selection | 12 | 13 |
| Graph with supplied correct receipt link, privileged-input ceiling | 12 | 0 |
| Jev overall Noul over raw records, threshold 0.9 | 0 | 0 |
| Jev overall Noul over graph-filtered receipts, threshold 0.9 | 0 | 0 |
| Jev receipt Choice → deterministic verifier | **10** | **0** |
| Clef overall Noul over raw or graph-filtered receipts, threshold 0.9 | 0 | 0 |
| Clef receipt Choice → deterministic verifier | 2 | 0 |

The ten Jev positive endorsements used the correct receipt, not a passing distractor. The model supplies an inferred scope link; code owns freshness and runner-result checks. This is evidence for a narrow link-selection role on these controls, not a reason to treat model edges as observed facts.

The Noul result is threshold- and wording-specific. The new current-checkout question at 0.9 is **not** the earlier two-Noul evaluator at its existing thresholds. It neither overturns that earlier result nor demonstrates that every possible Noul formulation fails.

No live capture coverage was measured. The previous actual-receipt replay remains not assessable for current-state reuse because it lacks complete runtime-input evidence. A graph cannot reconstruct missing observations or authenticate a summary merely because a tool printed it.

## 2. Extraction and one-to-one matching

### Construction controls: qualifier attachment adds information

Each held-out message has three factual completion claims, one scope qualification, a future plan and a question. Qualifiers can be separated from their claim by unrelated clauses. Code enumerates source spans; model Nouls classify clauses and score qualifier-to-claim edges. Code chooses an attachment and applies one-to-one matching with qualifier-inclusive IoU ≥0.5.

| Arm | Complete claims /54 | Predictions |
| --- | ---: | ---: |
| Span-preserving splitter | 36 | 108 |
| Clause enumeration | 36 | 108 |
| Heuristic cores + nearest preceding qualifier attachment | 30 | 54 |
| Heuristic cores + lexical qualifier attachment | 42 | 54 |
| Jev claim filter alone | 36 | 54 |
| Jev filter + qualifier graph | **51** | 54 |
| Clef filter + qualifier graph | **50** | 54 |

Jev attached 15/18 required qualifiers, versus 6/18 for lexical attachment. Clef attached 14/18. The matching algorithm itself needs no model; model utility appears before scoring, in deciding which source passages belong together.

### Historical messages: filtering trades recall for precision

The reference annotations and candidate spans are unchanged. No reference labels were supplied to model requests.

| Arm | Complete claims /666 | Predictions retained | Complete recall | Complete precision |
| --- | ---: | ---: | ---: | ---: |
| Splitter | 371 | 699 | 55.7% | 53.1% |
| Jev filter, fixed 0.8 | 324 | 446 | 48.6% | 72.6% |
| Clef filter, fixed 0.8 | 211 | 267 | 31.7% | 79.0% |

Jev removes 253 candidates but loses 47 completely retained claims. Clef removes 432 but loses 160. These losses rule out describing filtering as an unqualified improvement. These are reference-agreement metrics on a reused corpus; review time and downstream finding quality were not measured.

The prior containment-versus-matching correction remains in [RESULTS-2026-10-20.md](RESULTS-2026-10-20.md). No new Clairic calls were made; this experiment evaluates decision models over code-enumerated spans.

## 3. Instruction corrections: authority and scope rules did the work

| Arm | Correct active numeric instruction /18 |
| --- | ---: |
| Latest message | 3 |
| Scoped deterministic parser | **18** |
| Raw Jev or raw Clef Choice | 15 |
| Authority-filtered Choice, either model | 18 |
| Model replacement edges + deterministic resolution, either model | 18 |

Controls distinguish corrections from assistant suggestions, quotations, changes to another component, delay-only changes and withdrawal without a replacement value. The graph-style resolution adds no accuracy over the scoped parser on this narrow grammar. This does not evaluate arbitrary instruction conflicts, every exception, or a general authority policy.

## 4. Documentation liveness: use reachability

Literal imports are parsed with TypeScript. Reachability starts from the designated entry module. Computed imports preserve an unknown outcome instead of proving absence. Semantic linking identifies which module a prose description concerns.

| Arm | Correct reachable/unreachable/unknown /12 |
| --- | ---: |
| Has an importer | 6 |
| Jev judges the raw modules | 11 |
| Clef judges the raw modules | 7 |
| Lexical module link + graph | **12** |
| Jev module link + graph | 12 |
| Clef module link + graph | 11 |

The model adds nothing over the lexical-plus-graph arm here. These are controlled module fixtures, not a codebase-wide proof of documentation liveness. Dynamic registrations, unresolved imports and function-level liveness require additional evidence.

## 5. Token localization: a positive result for Jev

From the first 300 non-merge source commits, the collector retained 24 small named-function changes with 8–254 lexical tokens. The function before the edit and commit message are supplied; code records token replacements/deletions and anchors insertions to the preceding old token. Exclusion reasons are retained.

Each model sees two shuffled option orderings for token, line and top-level AST-statement Choices. Line/statement probabilities are distributed uniformly over their tokens for comparison. The graph uses token adjacency and resolved local-symbol references, **not a full control/data-flow graph**.

| Arm | Top-ranked token overlaps recorded edit /24 | Mean reciprocal rank |
| --- | ---: | ---: |
| Lexical overlap | 4 | 0.234 |
| Lexical overlap + graph diffusion | 4 | 0.248 |
| Jev token Choice | **8** | **0.477** |
| Jev line Choice | 5 | 0.340 |
| Jev AST-statement Choice | 4 | 0.239 |
| Jev token Choice + graph diffusion | 9 | 0.500 |
| Clef token Choice | 6 | 0.381 |
| Clef line Choice | 5 | 0.322 |
| Clef AST-statement Choice | 3 | 0.183 |
| Clef token Choice + graph diffusion | 5 | 0.349 |

An exploratory 5,000-resample bootstrap clustered by the 22 distinct file/function pairs gives Jev token-minus-lexical MRR difference interval **+0.084 to +0.402**. The graph's incremental Jev MRR interval is **−0.023 to +0.080**, so this pilot does not establish an added diffusion benefit. Clef token-minus-lexical spans −0.010 to +0.305.

These intervals describe this selected historical corpus, not prospective task accuracy. Commit messages were written after changes; the target function is supplied; recorded changes may be wrong or out of scope. Ties use source order. No scope-drift false-alarm rate was measured.

Audit correction: the initial diffusion normalized away the probability assigned to “none.” `diffusePreservingMass` now preserves it. `graph-mass-correction.json` recomputes graph mass from cached responses; top-1 and MRR are unchanged. Original artifacts remain intact. This correction and bootstrap made no model calls.

## 6. Mutation ranking, structural diversity and kill graphs

The existing 166-mutant compiler-valid pool was frozen. Jev scores were reused; Clef supplied four scores per mutant, with predicted equivalence logged but excluded. Hybrids average ordinal ranks with equal weight. The structural graph groups mutants by their smallest enclosing AST statement and penalizes repeatedly selecting the same neighborhood. Every nonrandom arm reserves every tenth slot for the same seeded exploration order.

All eight arms ran against tests in isolated copies under a 10-second execution budget. The final in-flight timeout is a budget cutoff, never a survivor. Original source and tests are unchanged.

| Arm | Executed attempts | Meaningful survivors | Distinct meaningful groups |
| --- | ---: | ---: | ---: |
| Random | 20 | 9 | 6 |
| Fixed operator heuristic | 29 | 16 | **11** |
| Jev | 24 | 10 | 5 |
| Clef | 38 | 16 | 11 |
| Heuristic + Jev | 20 | 11 | 7 |
| Heuristic + Clef | 21 | 10 | 6 |
| Heuristic + structural diversity | 36 | 12 | 10 |
| Heuristic + Jev + structural diversity | 37 | 15 | **13** |

Replaying the frozen per-mutant screen times gives the same group counts. The combined arm is interesting; the simple Jev hybrid does not improve on the heuristic. One module, one live ordering and model-produced meaningfulness/group labels cannot establish general superiority. Structural proximity is a ranking heuristic, not evidence of semantic equivalence.

The observed test-case kill graph contains **70 killed mutants, four distinct nonempty kill sets and two strict subsumption edges**. All **93 survivors remain ungrouped by kill sets**. Three observed test cases are required to cover the killed-mutant classes; no smaller subset covers them. This is test-case granularity, not individual assertion contribution. It neither authorizes deleting other tests nor evaluates a dynamic checked-coverage implementation.

## Additional comparison: Clef is not a drop-in final judge

The original 96 controls, evidence projections, question text and thresholds were reused exactly for Clef. Jev results are cached; its scored-once benchmark was not rerun. Code skips the original no-eligible-evidence cases, leaving 64 actual Clef requests.

| Arm | Supported positives /32 | False endorsements /64 |
| --- | ---: | ---: |
| Cached Jev baseline | 32 | **1** |
| Clef with the same baseline thresholds | 32 | **29** |
| Deterministic-first + Clef baseline fallback | 32 | 5 |

The baseline thresholds are checkable ≥0.5 and evidenced ≥0.3, distinct from the new provenance experiment's 0.9 threshold. This is a test of direct substitution, not separately calibrated model quality. The new deterministic-first Clef arm uses the baseline fallback, not the old citation-rescue policy. No threshold was retuned on these controls.

## Utility, limits and cost

The promising roles are:

- Jev proposes a claim-to-receipt link; code checks that receipt's identity, freshness and result.
- A decision model attaches an explicit qualifier to a code-enumerated claim; code preserves source spans and validates the assembly.
- Jev ranks token edit locations inside an already selected function; execution and prospective evaluation remain necessary.

Graph queries already settle instruction scope and module reachability on the tested grammars. Adding a model there adds cost and possible errors. Mutation ranking remains inconclusive, with a possible interaction between semantic scores and structural diversity.

There were **685 attempted model calls, 684 successful**, at **$0.050514382 known incremental API cost**. One rejected authentication call lacks usage, so its cost is unknown. Combined with the prior reported $2.076606022, known external cost is about **$2.1271**, below the existing $5 stop. Assistant-session billing is not included.

Measured request latency:

| Model | Successful calls | Median | p95 |
| --- | ---: | ---: | ---: |
| Jev 1.13 | 304 | 96 ms | 197 ms |
| Clef-flash | 380 | 405 ms | 1,908 ms |

These mix batch sizes, inputs and concurrent local work. They are not a live per-edit SLA; in particular, the Clef sample does not justify assuming a 1,500 ms budget.

All **90 evaluation tests pass**, as does the evaluation TypeScript check. Scoped Gitleaks and `git diff --check` pass. There is no whole-repository clean/check-coverage claim.

Skill-impact review: changes are evaluation tools, aggregate documentation and explicit ignore exceptions for those reports. No production CLI, hook, configuration, blocking or advisory contract changed, so no additional skill edits are required. No commit or push was made. Live sessions, full program-dependence graphs, dynamic slicing, assertion-level minimization and deployment were not part of these pilots.

## Reproduction

Use a new output directory for each command. The scripts preserve raw calls and refuse to overwrite result files.

```sh
node --import tsx evals/claim-verification/graph-lab.mts scratch/new-core core
node --import tsx evals/claim-verification/graph-lab-replays.mts scratch/new-localization localization
node --import tsx evals/claim-verification/graph-lab-replays.mts scratch/new-extraction historical-extraction
node --import tsx evals/claim-verification/mutation-graph-lab.mts scratch/new-mutation
node --import tsx evals/claim-verification/final-judge-comparison.mts scratch/new-clef-comparison
```

Reproduction needs the existing private artifacts, repository history, dependencies, TypeSafe key and Cloudflare login. Each stage has a bounded client budget; orchestration across further runs must also check the cumulative ledger. A rerun is a replication, not a fresh holdout.
