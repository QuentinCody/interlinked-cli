# Semantic relations: exploratory implementation and model study

Interlinked now has a reproducible bounded-review workflow for shared invariants,
directed semantic coupling and before/after relation comparison. The evidence supports
continuing with explicit invariants and supplied change scenarios. It does not qualify
automatic relationship discovery, blocking alerts or a numeric drift score.

The principal result is the retrieval ceiling: at k=12 the shared candidate rules recover
1 of 16 registered counterpart opportunities, and lexical retrieval recovers 3 of 16.
The targeted coupling examples show a narrower useful capability: the same structural
connection can require an update under one scenario and verification only under another.
Both Jev and Haiku can make that distinction on supplied examples, with different
abstention rates. This is not evidence that a decision model uniquely supplies the value.

[Computed tables](RESULTS.md) and [machine-readable summary](summary.json) contain every
contract's full denominator, status counts, reference agreement, retrospective argmax,
runtime and cost. [Astra's supplemental analysis](ASTRA-ANALYSIS.md) examines the constructs
and concrete cases after results were available; it does not replace the blind labels.

## Candidate recall comes first

| Candidate budget per invariant anchor | Shared rules | Lexical |
| --- | --- | --- |
| 3 | 0/16 | 1/16 |
| 6 | 1/16 | 1/16 |
| 10 | 1/16 | 1/16 |
| 12 | 1/16 | 3/16 |

These are counterpart opportunities from three authored invariant registries: 11 for
`verification.no-false-pass`, 3 for `evidence.target-bound`, and 2 for
`obligation.persists-until-discharged`. Participants shared between invariants are separate
opportunities. All selectors resolve; missing history does not explain these misses.
History is bounded by ancestry and absolute dates at the source revision. The small
registry is a supplied reference set, not a complete gold graph. Even against that limited
reference, neither method approaches the proposed 90% target. Curated judgment performance
cannot repair missing candidates. No embedding arm was implemented or measured.

## Protocol and provenance

The user replaced human review with GPT-6 Astra review. There are **no human reviews
pending**. Three named Astra instances supplied blind source judgments: two reviewed
disjoint 100-case halves of A, and one reviewed all 200 B cases. Each case has an option,
rationale and quoted evidence. There was no two-reviewer-per-case replication or human
adjudication. Natural-code scores measure agreement with these model references.

The source revision is `b1978d3c5d54a41ded34ed05c6d1fb2dbed060f0`. Selection uses pinned
source, not the dirty live checkout. Natural cases come from 2,092 eligible bounded function
units, using a deterministic lexical selection with every fifth case hash-selected as a
control. The cohort is development data from one repository. There is no held-out
qualification cohort, independent temporal evaluation or repository-scale cost experiment.

The initial threshold is 0.80 for all model arms. It was not tuned after results. Ties and
lower maxima abstain; insufficient evidence, failures and unassessed cases remain explicit.
Retrospective argmax is reported separately, with ties unresolved. It is not shipped as a
new operating point. H reports its own probability distribution; it is not established as
calibrated or comparable in scale to Jev's backend distribution.

| Arm | Backend and identity | Disposition |
| --- | --- | --- |
| Structural | Same file or forward import; explicit naive classification mapping | Measured on A/B, distinct from candidate retrieval |
| Lexical | Token Jaccard ≥0.15; explicit naive classification mapping | Measured on A/B |
| D | Default Ollama `clef-flash:9b`, ThinkThen adapter | Unavailable: model not installed and adapter absent; no substitute or download |
| J | TypeSafe API, pinned `jev-1.14.0` | Measured independently |
| H | Claude Code 2.1.311, `claude-haiku-5-5`, low effort | Measured independently through the user's subscription |
| Reference | GPT-6 Astra, blind source reads | Model reference, not ground truth |

H receives the same packet state, instructions and criteria as J, plus a frozen system
instruction requiring supplied evidence and typed output. It cannot see J's answers.
The runner explicitly disables tools, MCP, slash commands and persistence, runs in an empty
temporary directory, and checks the init inventory and an absolute-path secret canary.
The observed canary had an empty inventory and did not disclose the secret. This tests the
configured CLI boundary; it does not establish an operating-system sandbox.

Initial H preflights failed because the minimal runner environment omitted `USER`, which
Claude Code needs to locate its macOS keychain account. The user completed Chrome login;
preserving `USER` fixed credential lookup. H was rerun on unchanged packets and references
with unchanged threshold and tool restrictions. The original failed preflights are retained.
They are not evidence of an expired subscription. H input freezes record the repaired runner.

The first broad B execution encountered a Jev transport failure and stopped admission when
spend became unknown. A declared fresh **full-cohort** retry preserved the original failed
run; it did not retry only incorrect or uncertain cases. The retry attempted all 200 cases,
with one malformed distribution retained as a failure. `B-retry-protocol.json` records this
amendment; primary B/J tables use that run. No successful answer was selected from multiple
replicates based on agreement.

Each input bundle embeds policy, source, packets, contract hashes, tool policy and the
transitive implementation source closure. Result bundles retain raw responses and accounting.
Earlier A/B J observations predate the conservative whole-snapshot cache binding; they remain
readable as legacy relation records. Later H and C observations include it. Final accounting
hardening rejects malformed H cost/token values; recorded study usage is valid and questions
did not change. Study results do not claim all arms ran under one identical source digest.
Available input freezes preserve implementation bytes; the original protocol's
`sourceImplementationCommit` field was misnamed and identifies the baseline source commit,
not the uncommitted implementation. The summary corrects that name while preserving the
original protocol and its digest. The B retry retains the original frozen plan and requests
but has no separate execution freeze; exact runner-version attribution for that retry is a
provenance limitation, not reconstructed after the fact. See `provenance-amendment.json`.
Files are reviewable local
exports, not a claim that these uncommitted artifacts have already been published.

## A: shared invariants

A contains 80 membership questions, 60 separate role questions, 45 pair compatibility
questions and 15 explicit group questions. Groups were not inferred from pairwise answers.
At the frozen threshold, J produced 8 answered, 29 insufficient-evidence and 163 abstained
observations. Per-contract J/H tables are in RESULTS.md; pooling these contracts would hide
their different meanings and reference populations.

H produces 32 substantive answers, 20 insufficient-evidence choices, 147 abstentions and
one malformed response. On membership specifically, H matches 24 of its 25 substantive
answers (24/80 over the full membership cohort); J matches 2 of 4 (2/80). Neither arm makes
a substantive pair-compatibility or group-compatibility choice at 0.80 on natural A. All
15 group references themselves are insufficient-evidence. This sample does not validate
positive or negative group compatibility despite exercising the group mechanics.

The reference review exposes a context problem. Isolated function bodies often call helpers
whose semantics are necessary to decide compatibility. A missing contract should lead to
insufficient evidence, not an invented compatible edge. The role `assumes` is also less
operationally precise than an explicit enforcement check; its future revision needs examples
and a new contract version. High agreement on negative or insufficient-evidence cases would
not establish the ability to detect invariant violations.

The naive role control always says absent; compatibility and group controls always say
compatible. Their results expose class imbalance and must not be mistaken for a strong
semantic baseline. The small authored fixture set separately checks known compositions,
inverted defaults, explicit exceptions and missing policy context.

## B: semantic coupling

The original 200-case lexical cohort received 187 independent and 13 insufficient-evidence
Astra references, with **zero update or verify-only references**. It therefore cannot
estimate update recall, even if a model gets most of those cases right. This is a failed
sampling frame for the intended positive construct. The constants and naive controls are
especially strong on such a negative-heavy population; overall accuracy is misleading.

J selects independent on 4/200 cases, abstains on 195 and fails on one malformed
distribution. H selects independent on 22/200 and abstains on 178. All substantive choices
match the model reference, but that only establishes agreement on selected negative cases;
it says nothing about detecting a required update.

A supplemental 12-case study was declared separately after that weakness was known. Astra
authored two prospective scenarios for each of six explicit producer/consumer boundaries:
one requiring update, one requiring verification only. Expected options were frozen before
new J/H inference, and opaque packet IDs conceal reference words. The cases were not pooled
with broad B. These are authored prospective expectations over real code; the changes were
not implemented or executed.

At 0.80, J answered 6/12 and matched all six references (4 update, 2 verify-only); H answered
8/12 and matched all eight (6 update, 2 verify-only). Remaining cases abstained. That is
full-cohort update recall of 4/6 for J and 6/6 for H, with only six authored positive cases.
Neither meets an 80% substantive assessment-coverage gate across all 12 cases. Perfect
agreement among answered cases is not deployment precision.

For example, `readPytestCaseEvidence → withPytestEvidence` remains the same call boundary
whether a changed evidence shape requires consumer adaptation or an equivalent representation
only requires verification. Connectivity cannot select the action. This is the useful
semantic primitive: **action conditioned on a supplied behavioral scenario and explicit
contract**. The study does not establish hidden cross-module discovery, executed repair
prediction, or superiority to every deterministic program analysis.

The initial 16 authored fixtures execute mechanism checks separately from their semantic labels.
H gives 13 substantive answers, 2 insufficient-evidence choices and 1 abstention, with all
15 resolved choices matching the authored expectations. J gives 5 substantive answers and
11 abstentions, with all five answers matching. Passing the mechanism checks substantiates
the specified examples; it does not validate natural-code generalization.

Post-result review found a label-cue defect: original model-visible IDs and filenames
included names such as `B-required-update` and `B-verification-only`. These runs are retained
as cue-exposed pilot evidence. A separate `fixtures-neutral` control replaces only IDs and
paths with opaque hashes; source bytes, scenario prose, options and threshold remain the
same. The fixture generator now uses opaque identifiers by default, with a regression test.
In this fresh neutral control, J again answers 5/16, all matching the authored references;
H answers 14/16, with 13 matches and one selected `independent` where the reference is
`verify_only`. Both missing-context cases now make H abstain. Each condition has one run,
so a particular change cannot be causally attributed to metadata rather than sampling
variation. The control prevents the original 15 resolved H matches from being presented
as uncued code-reasoning accuracy.

## C: comparison, not a drift verdict

C ran after A/B and uses eight before cases, seven after cases and an intentional deletion.
Four executed checks establish a preserved behavior, two removed false-pass counterexamples
and an introduced false-pass counterexample. Separate edits add unsupported “fixed” and
“broken” comments. Both revisions are represented in a paired assessment plan that the
public assess command consumes. Unresolved measurements and the deleted participant remain
non-comparable; matching raw distributions do not certify preservation.

Five fresh repeats of each before packet measure variability without code changes. In the
original cue-exposed condition, J's
categorical states are stable across all eight packets, while individual probability
components vary by as much as 0.28. H's measured repetition and comparison outcomes are in
RESULTS.md. C was also rerun for both J and H with neutral fixture identifiers, including
five fresh repeats per arm; the original J condition remains separate. Those ranges are
empirical observations from five repeats, not estimated noise
bounds. A probability delta is therefore unsuitable as a drift alarm without a separately
validated transition construct.

With neutral identifiers, H reports four unchanged categorical assessments, three changed
assessments corresponding to the engineered behavioral changes, and the deletion as
non-comparable. It keeps the unsupported-comment controls unchanged. J reports one same,
one changed and six non-comparable outcomes. Across five neutral repeats, status-plus-choice
is stable on 7/8 H packets and 5/8 J packets; one J repetition is a malformed-response
failure, so that stability count combines uncertainty and service validity. Largest observed
valid probability-component ranges are 0.10 for H and 0.18 for J. No input-identical repeat
is interpreted as actual code drift.

No preserved/weakened/strengthened model was trained, exposed or qualified. The planned
200-case natural-code transition pilot was conditional and was not collected; qualification
would be a separate study. The
delivered product behavior is before/after evidence and categorical comparison, with explicit
non-comparability. The four executed controls are not 200 natural transition labels.

## Statistics, cost and resulting product decision

The audit includes confusion matrices, per-class precision/recall/F1, full-cohort coverage,
raw-distribution Brier scores, failures and cost. Natural cases reuse functions and policies;
distinct IDs do not establish independent observations. Their binomial confidence bounds are
therefore withheld. The audit's exact one-sided 95% Clopper–Pearson routine is available for
the authored fixture examples, descriptively only. Neither those bounds nor model references
establish the proposed 90% alert precision / 80% lower-bound deployment gate. No qualification
or scale claim passes by default, and no human staffing cost is carried forward.

J cost fields are adapter estimates using $0.042 per million input tokens, not provider
invoices. H cost fields are CLI-reported list-equivalent usage under the subscription, not
incremental charges. Tables separate primary cohorts and C conditions; H assessment
costs include their canaries, whose envelopes are also retained. The original failed B
attempt is recorded separately from its full-cohort retry.
Latency includes process overhead and is affected by concurrent local validation workloads;
this was not a controlled latency benchmark. Astra review time and token cost were not
metered, so these totals are not end-to-end review economics.

The implemented CLI remains an experimental, advisory workflow. The next product iteration
should use explicit invariant registries and reviewed participant groups, require a concrete
change scenario for coupling, and retrieve dependency/context bundles before judging. Improve
candidate coverage before expanding judgment volume. Retain Haiku as a standing independent
arm: these experiments do not establish a unique Jev advantage. Expand executable scenario
controls and separate development from held-out evaluation before changing thresholds.

Embedding retrieval, reviewed rename maps, selective dependency invalidation, deployment
qualification and scale economics remain unimplemented or unmeasured. No learned result
enters deterministic pre-execution blocking. Current invalidation conservatively binds the
whole snapshot, and exact unique logical identities are required for revision matching.

## Reproduce and inspect

Run `node --import tsx semantic-relations/summarize-experiments.ts` from the source checkout
to regenerate summary.json and RESULTS.md without model calls. A fresh model replication
must use new immutable input/result destinations. Use the scripts in `semantic-relations/`
and the public workflow in its README; freezes refuse implementation changes during replay.
The original inputs, references, actual model responses, failed attempts and supplemental
protocols are retained alongside this report. Validation results are in VALIDATION.md.

| Evidence | Primary files |
| --- | --- |
| Source/cohort definition | `protocol.json`, `selection.json`, `engines.json`, `A-input/`, `B-input/` |
| Blind natural references | `A-astra-1.json`, `A-astra-2.json`, `A-labels.json`, `B-astra.json`, `B-labels.json` |
| Broad J/H results | `A-result/`, `A-H-result/`, `B-retry-result/`, `B-H-result/`, matching `*-audit.json` |
| Retained B service failure | `B-result/`, `B-retry-protocol.json` |
| Targeted prospective cases | `B-targeted-cases.json`, `B-targeted-{input,result}/`, `B-targeted-H-{input,result}/` |
| Original fixtures / neutral control | `fixtures-{input,result}/`, `fixtures-H-{input,result}/`, `fixtures-neutral-{input,result}/`, `fixture-checks.json` |
| Original C / neutral C | `C-protocol.json`, `C-comparison.json`, `C-repeats.json`, `C-neutral-*/`, `C-neutral-comparison.json`, `C-neutral-{J,H}-repeats.json` |
| Authentication/isolation evidence | `preflights.json`, `H-authenticated-preflight.json`, `*-H-protocol.json`, envelopes in H result bundles |
