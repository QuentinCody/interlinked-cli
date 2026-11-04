# Astra supplemental analysis — post-result

This is **post-result analysis**, written after inspecting Jev and authenticated Haiku outputs. It is separate from, and does not revise, the original blind Astra labels. The observations support a limited capability claim: models can distinguish some scenario-specific consequences that a call edge alone cannot express. They do not establish independent truth, production accuracy, or deployment qualification.

I loaded the frozen input and result bundles through `relation-freeze.loadRelationArtifact`, including gzip artifacts. Sources were `B-targeted-{input,result,H-input,H-result}`, `fixtures-{input,result,H-input,H-result}`, the corresponding labels/protocols, `B-targeted-cases.json`, and `fixture-checks.json`. Packet IDs and evidence hashes match between J and H, and the stored request objects are identical. J reports `jev-1.14.0` with backend distributions; H reports `claude-haiku-5-5` with self-reported probabilities. H's protocol records the authentication repair as preserving `USER` in the minimal environment, with no tool-policy relaxation. Natural A/B H result bundles were absent when checked; this analysis did not wait for them.

## Observed decisions at 0.8

“Agreement” below means agreement with the authored reference, not independently measured correctness. Explicit `insufficient_evidence` is a selected semantic outcome; threshold abstention is a different event.

| Set | Arm | Substantive answers | Explicit insufficient evidence | Threshold abstentions | Selected reference agreements | Argmax reference agreements |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Targeted, 12 scenarios / 6 pairs | J | 6 | 0 | 6 | 6/6 | 12/12 |
| Targeted, 12 scenarios / 6 pairs | H | 8 | 0 | 4 | 8/8 | 12/12 |
| Fixtures, 16 cases / mixed contracts | J | 5 | 0 | 11 | 5/5 | 14/16 |
| Fixtures, 16 cases / mixed contracts | H | 13 | 2 | 1 | 15/15 | 16/16 |

On targeted changes, H selects all six `update` references; J selects four and abstains on the pytest `not_run` and admission `deferred` extensions. Each selects two of six `verify_only` controls, but different ones: J selects pytest and admission; H selects pytest and report validation. Both abstain on the corpus, index-validity and request-requirement controls. Consequently, H's larger overall decision coverage does not mean stronger coverage on every class.

On fixtures, J's two argmax disagreements are `B-unaffected-consumer` and `B-direction-reversal`: it favors `verify_only` over the reference `independent` (0.46 versus 0.30; 0.43 versus 0.39). Both are abstentions at 0.8, not selected false positives. H selects `independent` at 0.92 and 0.93. Conversely, `B-deferred-control` is selected by J at 0.81 but abstained by H at 0.60, although H selects the closely related `B-verification-only` at 0.85. This single-run contrast warrants a wording/representation stability test, not a causal explanation.

## What the code examples support

The targeted matched pairs hold supplied implementations and direct connectivity constant while changing the prospective contract. In `readPytestCaseEvidence → withPytestEvidence`, replacing `unavailable` with `not_run` makes the existing ternary yield `false` instead of the required no-verdict `null`; adding another rejection under the existing `unavailable` shape requires no new consumer branch. Both models rank the two scenarios differently in the intended direction. Connectivity alone cannot distinguish them.

Two cases especially illustrate semantic content beyond finding a caller. `manifestValidity → selectShards` adds `complete:false` while allowing `valid:true`; the caller's `.valid` guard still typechecks but no longer establishes reuse authority. `meetsRequirements → pendingRequestsMet` changes a boolean to three strings: the unchanged `filter` predicate treats `unsatisfied` and `unavailable` as truthy. H and J select `update` for both. These are concrete candidates for testing incremental value over a typechecker; this experiment did not actually run that comparison.

The fixtures also encode two useful distinctions. A direct caller reading only an unchanged `id` can be unaffected by a status extension. Conversely, two adapters with no call edge can require coordinated policy updates: `B-no-import-policy-twin` stipulates that both enforce the same non-pass policy. H selects the reference update; J ranks it highest but abstains. The policy relationship is **given in the scenario**, so this tests use of supplied semantic context, not discovery of a hidden relationship.

## Construct limitations

1. **Fixture answer cues are visible.** Stored requests include invariant/scenario IDs and source paths such as `B-required-update`, `B-verification-only`, `B-unaffected-consumer`, and `A-equivalent-control-flow`. These names reveal intended distinctions. The 15 selected H agreements cannot isolate code reasoning from label-like cues. Targeted identifiers are neutral numbered scenarios, but their prose still gives unusually precise behavioral obligations.
2. **The targeted sample is six prospective migrations, not twelve independent natural changes.** It was added because the broad lexical cohort lacked update positives. All six pairs are direct calls, and references are balanced update/control constructions. Do not pool these results with broad-cohort precision or claim sensitivity to naturally occurring hidden coupling. Split future evaluation by pair/repository, not merely scenario.
3. **`verify_only` mixes semantics with workflow.** The unchanged caller can already be shown to preserve the contract, yet the reference prescribes checking a new path. The contract's brief “B requires verification” wording does not specify why that differs from independent or how existing exhaustive tests affect the obligation. Repeated control abstentions are consistent with an underspecified category boundary, though they do not prove that explanation.
4. **The target is broader than no-false-pass.** The report-envelope migration makes `if (issue)` defer even a successful report and assign an object as the reason. That is an update requirement, but principally a false-unavailable/schema failure. The pytest case similarly preserves no-pass while misclassifying no-verdict as failure. Keep representation preservation, successful-path preservation and false-pass prevention distinct in reported results.
5. **Executed fixture checks substantiate narrow behavior only.** All 16 recorded checks pass. Some compare expressions rather than executing an integrated changed implementation; `typeof externalPolicy === "undefined"` establishes missing context, not a semantic dependency theorem. The targeted protocol explicitly records no executed reproductions. Neither model agreement nor these checks independently validate every authored label.
6. **Confidence scales differ.** H self-reports probabilities; J supplies a backend distribution. A common 0.8 cutoff is an operating rule, not evidence of equal calibration. Argmax agreement is descriptive and must not retroactively replace abstentions. These are small, single-run sets, and the fixture table mixes membership, role, compatibility, group and coupling constructs.

## Recommended next experiment

First, rerun a newly frozen fixture set with opaque IDs/paths and neutral wording; retain the current results as the cue-exposed condition. Randomize names and equivalent syntax, including the two passed-only status consumers whose H confidence differed. Define `verify_only` operationally as exercising a changed input path through an unchanged preserving consumer, and specify whether existing tests can discharge that work.

Next, materialize the six prospective producer changes in isolated executable harnesses and check both positive and negative consumer behavior. Compare against separate deterministic baselines: directed call/import connectivity, changed-field use, type diagnostics, and bounded truthiness/status-flow analysis. The index `valid:true/complete:false` case and the string-valued `filter` predicate are stronger tests than a straightforward removed property. Add natural, held-out policy twins without call edges, with explicit evidence that both implement the same obligation and realistic missing-context controls.

Report selected-outcome coverage, explicit insufficient evidence, abstention and reference disagreement separately, by relation and scenario family. Preserve paired scenarios as clusters and keep authored references distinct from execution observations. The current evidence justifies further evaluation of semantics-aware change triage; it does not yet show that a model contributes reliable value beyond richer deterministic program analysis.

## Measured neutral-identifier control — appended post-result

The completed `fixtures-neutral-{input,result,labels,audit,protocol}` control replaces descriptive model-visible IDs and paths with opaque hashes. I loaded its frozen bundles through `loadRelationArtifact`, confirmed the result uses the frozen plan, and compared stored requests against the original fixtures: after removing `id`, `file`, and `invariantId` fields, request objects match exactly. Code, scenario prose, options and the 0.8 threshold are unchanged. Descriptive case names below are reporting labels, not the new model-visible identifiers.

| Arm / condition | Substantive answers | Explicit insufficient evidence | Abstentions | Selected reference agreements | Argmax reference agreements |
| --- | ---: | ---: | ---: | ---: | ---: |
| J / original | 5 | 0 | 11 | 5/5 | 14/16 |
| J / neutral | 5 | 0 | 11 | 5/5 | 15/16 |
| H / original | 13 | 2 | 1 | 15/15 | 16/16 |
| H / neutral | 14 | 0 | 2 | 13/14 | 15/16 |

The neutral H run has **one selected disagreement**: `B-verification-only` changes from `verify_only` at 0.85 to `independent` at 0.82 (`verify_only`: 0.11). Its consumer remains `return left().status === "passed"` when the producer adds `unavailable`. Thus the disagreement concerns whether this already-preserving consumer requires verification under the authored workflow definition; it is not a prediction that an unsafe consumer is safe. H now selects `B-deferred-control` as `verify_only` at 0.85, versus its original abstention at 0.60. Both missing-context cases move from explicit insufficient-evidence selections to abstentions, each still assigning the highest probability, 0.70, to insufficient evidence.

J's total decision coverage is unchanged, but six cases change selection status. It gains reference-matching selections on `A-boundary-assumptions`, `B-verification-only`, and `B-no-import-policy-twin`, while abstaining on previously selected `A-composition-loses-status`, `B-required-update`, and `B-deferred-control`. Its only neutral argmax disagreement is now `B-required-update`: `verify_only` 0.55 versus `update` 0.39. That case replaces a boolean with an object consumed by `Boolean(left())`; the object is truthy even when unavailable. The wrong ranking remains below the selection threshold. J's original two argmax disagreements on unaffected consumption and reverse direction now rank the reference first.

The neutral run demonstrates that many reference-matching decisions persist without descriptive identifiers, while also exposing a selected `independent`/`verify_only` disagreement. It does **not** identify the causal effect of the names: each condition has only one independent stochastic run, and changes go in both directions. The original cue-exposure limitation remains valid, but attributing any particular transition to cue removal would exceed these observations. Repeat both conditions with paired randomized naming/syntax variants and a clarified verification-work policy before estimating a cue effect or comparing calibrated operating points.
