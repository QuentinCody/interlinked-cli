# Decision-model code-quality measurements

This experimental implementation of the October 6, 2026 spec adds
`interlinked metrics decisions`. It measures bounded semantic questions with
ThinkThen, retains raw observations, and evaluates them against independent labels.
**The probabilities are unvalidated on code. No learned blocking gate is enabled.**

The implementation keeps deterministic PreToolUse enforcement separate from
optional PostToolUse advice. A model answer does not establish behavioral
equivalence, passing tests, or calibrated defect risk.

## Quick start

Install ThinkThen and Ollama separately; this feature downloads nothing. The local
defaults are `clef-flash:9b` and the full `embeddinggemma-2:740m-bf16`. Qwen3 Embedding
4B remains an explicit comparison model. ThinkThen 0.1.2 was exercised
during implementation. Use an explicit executable path if it is not on PATH.

```bash
interlinked metrics decisions init
interlinked metrics decisions catalog
interlinked metrics decisions prepare --base HEAD --unit function --output changes.json
interlinked metrics decisions measure changes.json --metrics name_matches --plan --output plan.json
interlinked metrics decisions measure changes.json --metrics name_matches --output run.json
interlinked metrics decisions replay run.json --band 0.3:0.7 --output replay.json
interlinked metrics decisions labels run.json --output labels.json
```

The output files are immutable: use a new filename for a different observation.
Manual commands are explicit inference requests even when automatic hooks are off.
`--plan` asks the installed ThinkThen CLI to print its requests without inference.
`--fresh` performs new inference without replacing the first cached observation.

A small illustrative input is in
[`src/lib/decision-metrics/fixtures/increment.json`](../src/lib/decision-metrics/fixtures/increment.json).
It is an integration fixture, not a calibration cohort.

## Configuration and resource policy

`init` creates `.interlinked/decision-metrics.json` with both flags disabled.
It refuses to replace an existing different configuration. Configuration is
versioned; unknown keys are errors. A minimal opt-in example is:

```json
{
  "version": 1,
  "enabled": true,
  "command": "thinkthen",
  "backend": "ollama",
  "url": "http://127.0.0.1:11434/v1",
  "model": "clef-flash:9b",
  "embeddingModel": "embeddinggemma-2:740m-bf16",
  "ollamaUrl": "http://127.0.0.1:11434",
  "band": [0.2, 0.8],
  "deadlineMs": 120000,
  "maxRecords": 100,
  "maxEvidenceBytes": 24000,
  "maxRequestBytes": 60000,
  "hook": {
    "enabled": true,
    "deadlineMs": 1500,
    "maxRecords": 2,
    "metrics": ["name_matches"]
  }
}
```

Omitted fields take the defaults shown by `init`. Hook metrics must be function
contracts. The inference deadline is bounded; shutdown can take up to five
additional seconds to unload and verify residency. The default hook budget is
deliberately short and often insufficient for cold local inference. Hook deadlines
can be configured up to 10,000 ms. Use explicit review commands when that latency
is unsuitable.

A machine-wide lock serializes cooperating CLI processes for a local Ollama port.
The runtime inspects resident models, unloads the other configured model before
switching, refuses unrelated resident models, and unloads the target after the
stage. External applications can still load models independently. A failed
residency check is an error, never a clean quality result. A crashed process can
leave a lock in the OS temporary directory; inspect its owner PID and ensure the
process has exited before removing that specific stale lock.

Local model identity includes the installed digest. Embedding caches are keyed by
model digest and exact input. ThinkThen executable bytes also participate in
answer-cache identity. No automatic cloud fallback exists.

EmbeddingGemma 2 uses Google's code-query/document prompts for retrieval and
symmetric similarity prompts for `embed`/`geometry`. Representation identity
includes the prompt profile; incompatible profiles cannot share a geometry
population. Its full 768-dimensional output is required, and requests specify
8,192 context tokens with truncation disabled. Encoders are not disabled by this
client. Generic other model names retain raw input behavior for comparison.
Ollama 0.35.1 rejects the new model manifest; a compatible newer runtime is needed.
The implementation trial used the official Ollama 0.40.0-rc6 binary on a separate
loopback port. Configured `url` and `ollamaUrl` must point to that same instance;
the CLI never upgrades or restarts a user's installed runtime automatically.

For a deliberately configured remote System One endpoint, set `allowRemote: true`,
an HTTPS `url` ending at the API base (the adapter appends `/systemone`), an
appropriate backend and an immutable model name. Supported backend names are
`ollama`, `typesafe`, `liquid`, `openrouter`, and `perplexity`. Credentials come
from their corresponding `*_API_KEY` environment variables, never configuration.
The recorder owns the upstream credential; the child process receives a loopback
placeholder. Hosted backends were not exercised in this implementation run.

## Evidence and records

`prepare` reads committed changes without checkout, or changes from a base to the
working tree, including untracked source. It uses a pinned Myers diff and
Interlinked's function adapters. Native TS measurements include syntax tokens,
function lines, cyclomatic complexity, cognitive complexity and nesting. Their
extractor/compiler versions are recorded; these are not mislabeled as bca metrics.

Optional bca enrichment requires both `--bca-command <path>` and
`--bca-version "<exact bca --version output>"`. It verifies source hashes, runs
`metrics --no-config -O json`, and retains matched per-function values in a
separate `metrics.bca` namespace. bca is optional and was unavailable for a live
run on the implementation machine.

Evidence readers accept arrays, JSONL, and envelopes with a `records` array.
Each record carries repository, revision, timestamp, unit, file, line, evidence,
extractor identity, source hash and metric implementation identity.
Missing selectors, oversized records and budget exclusions remain explicit.
Required tests, callers, comments and verification receipts must actually be
supplied; the extractor does not invent them or claim that test snippets ran.

Every (unit, question) has one of five states:

| State | Meaning |
|---|---|
| answered | A valid interpreted model result |
| insufficient_evidence | Required evidence absent, or the rubric chose that outcome |
| abstained | Valid probabilities inside the uncertainty band or a tied choice |
| failed | Local, transport, adapter or backend failure |
| unassessed | Candidate not retrieved, budget exceeded, or plan-only |

A score retains its complete named-level distribution and its weighted position.
Vendor confidence is retained but never used as a cutoff. Distributions are
validated without renormalization. Probability sums are not presented as expected
defect counts.

Runs, per-record inputs/question sets, exact request/response bodies, and native
results live under `.interlinked/decision-metrics/runs/<id>/`. Files are private.
Answer and embedding caches are separate. HTTP credentials are excluded from
exchange records. `requestHashes` identify exact wire bodies; `questionKey` is
ThinkThen's separate question-cache key. Batch composition is retained.
ThinkThen retries and its own cache are disabled so this layer owns the deadline,
cache interpretation and research observations.

`replay` is offline and changes only interpretation. A cache hit is reproducible
replay, not evidence of fresh-run stability. `diff` reports changed probabilities
and model/question/measurement drift; it never installs a new gate threshold.

## Relational review and retrieval

```bash
interlinked metrics decisions prepare --revision HEAD --unit function --output commit.json
interlinked metrics decisions review commit.json --analysis atomicity --output atomicity.json
interlinked metrics decisions review commit.json --analysis faithfulness --claims claims.json --output faithfulness.json
interlinked metrics decisions snapshot --revision HEAD --max-files 2000 --output corpus.json
interlinked metrics decisions prepare --revision HEAD --unit hunk --output contracts.json
interlinked metrics decisions candidates contracts.json --corpus corpus.json --retrieval hybrid --output candidates.json
interlinked metrics decisions review candidates.json --analysis obligations --output ledger.json
```

Atomicity and faithfulness require one repository revision per review. Atomicity
classifies pairs and clusters the resulting graph; contradictory edges and
missing pairs remain visible. Faithfulness checks literal description claims,
then behavior changes, then description omissions. The optional claims file is a
JSON string array of literal spans. Without it, description lines are the explicit
lexical baseline. ThinkThen's name recognizer is not treated as a validated
proposition extractor.

The obligation ledger runs two passes. The satisfaction pass receives the actual
first-pass judgment and supplied implementation/verification evidence. A
`verify_only` result does not require a code edit. Rows include no-work, satisfied,
missing, verify-only and unresolved states, along with assessment coverage.

Candidate discovery combines AST import declarations, lexical symbols, supplied
historical co-change edges, and optional BM25/embedding/hybrid retrieval.
Hunk evidence retains changed type, interface and enum declaration names, so
contract changes without a changed function still enter candidate discovery.
Import resolution is a limited relative-path heuristic, not a full compiler
dependency proof. Same-file consumers are included. Non-selected and future
consumers remain unassessed rows in the supplied cohort. Discovery is bounded at
50,000 pairs; partition larger analyses explicitly. Snapshot reports retain
unscanned/unavailable file counts. Coverage of a supplied snapshot is not recall
over consumers that were never inventoried.

`review --analysis compare` takes one pair with `left`, `right`, `criterion`
and `contract` evidence, swaps order, and reports disagreement rather than
averaging it away. `coupling` requires `left`, `right`, and `scenario`.
`rework` additionally requires a declared equal follow-up window.

Historical retrieval is separate:

```bash
interlinked metrics decisions embed changes.json --output embedded.json
interlinked metrics decisions geometry embedded.json --output geometry.json
interlinked metrics decisions retrieve embedded.json --corpus fixes.json --retrieval hybrid --output enriched.json
interlinked metrics decisions measure enriched.json --metrics name_matches --output enriched-run.json
```

Bug-neighbor records need `evidence.fixCommit` and label-source provenance.
Retrieval excludes future entries and identical source hashes. BM25 is the
default baseline; semantic similarity and reciprocal-rank fusion are optional.
Embeddings supply context and geometry, not calibrated quality scores.

`geometry` computes nearest-neighbor distance, outlier distance and group
dispersion over at most 200 records from the same pinned embedding model.
`evidence.cohesionGroup` defines a method/class group; absent that, the file is the
group. Semantic churn additionally requires `evidence.previousEmbedding` and a
matching `previousEmbeddingModelIdentity`. The report retains the population and
marks every geometry value uncalibrated; none is a code-quality verdict.

## Pilot, labels and acceptance

```bash
interlinked metrics decisions pilot --count 200 --before 2026-10-01 --output pilot.json
interlinked metrics decisions measure pilot.json --metrics name_matches --max-records 100 --output pilot-run.json
interlinked metrics decisions labels pilot-run.json --output blind-labels.json
# Two independent reviewers adjudicate the labels, including missed/failed cases.
interlinked metrics decisions join-labels pilot-run.json --labels blind-labels.json --output cases.json
interlinked metrics decisions audit cases.json --cutoff 2026-08-01 --output audit.json
```

`pilot` samples recent non-merge commits within the date bounds and retains
unavailable revisions. This is a collection tool, not a claim of representative
sampling. Choose repositories, change-family strata, equal follow-up windows and
clone/fork groups before drawing conclusions. Repeat collection in two or three
repositories and combine evidence deliberately. Root commits without a parent
are reported unavailable.

Labels must cover the full cohort and bind the original identity/date. Templates
omit model answers and strip dependent model judgments. Positive means the
metric's declared adverse event. Set the change family, clone/fork group,
reviewer identities and adjudicated label. A generated label template is not
labeled data. Audit one metric and pinned model arm at a time.
Binary audit labels refer to the declared adverse event. Multiclass intent or tag
outputs without such an event do not become an automatic binary quality score.

Audit reports Brier, AUC, ten-bin reliability/ECE, the training-base-rate Brier,
train-only standardized logistic size/structural/embedding baselines, available
hand-rule predictions, operational completion, full-cohort recall, uncertainty,
false-alert rate, and repository/change-family slices. Unretrieved cases,
abstentions and failures count as misses in operational recall. Clone/fork groups
crossing the temporal split are rejected.
Suggested uncertainty bands are selected on training labels only, then reported
on held-out cases. Native cases retain their full distribution and question
contract, so replaying a band preserves multiclass ties and the polarity of
questions where a negative answer is adverse. Mixed question versions are rejected.

To compare all five arms, supply independently defined `ruleProbability`
values in the cases and vectors for the trained embedding head, then run:

```bash
interlinked metrics decisions audit direct-cases.json --comparison retrieval-cases.json --cutoff 2026-08-01 --output five-arms.json
```

Arms must have identical identities, labels, dates and baseline features.
Direct-versus-retrieval probability statistics additionally report their common
assessed subset; full-cohort operational results remain separate. An unavailable
baseline is reported as unavailable, not a synthetic win.

Acceptance diagnostics default to at least 50 train and 50 held-out observations,
two adjudicators, Brier below base rate, ECE below 0.05, AUC at least 0.02 above
both size and structural baselines, uncertainty below 20%, false-alert rate at
most 1%, and completion at least 80%. These are explicit pilot defaults, not an
agreed production blocking budget. Audits do not turn advice into enforcement.

`probe <one-record-file>` performs fresh repetition, question-order, single versus
batched, missing-evidence, irrelevant-context, leading-whitespace and false-assurance
controls under a shared deadline. Add independently constructed rename,
real-defect/large-rewrite and task-outcome cases to the cohort. Diagnostics do not
establish invariance or correctness by themselves.

## Hook behavior and exit codes

Automatic advice requires both `enabled` and `hook.enabled`. It runs after
deterministic per-file checks on observed edits. The hook validates actual
before/after source hashes, reuses exact pre-edit observations when available,
and compares bounded touched-function measurements. It suppresses unchanged
legacy adverse judgments. A missing pre-edit source captures a baseline and
reports the edit unassessed. Model uncertainty is advisory review context;
it cannot pre-block, force a test-file edit, or silently authorize an operation.
This analysis does not change `DEFAULT_ADVISORY_SKIPS` or the deterministic check registry.

CLI exits: 0 completed/plan; 2 usage/configuration; 3 uncertainty or insufficient
evidence; 4 all assessments failed or runtime cleanup failed; 6 partial backend
failure; 7 unassessed population. The JSON artifact preserves every state.
No/false quality answers are data, not shell exit 1.

The existing coverage, mutation, e2e and type-check evidence remains authoritative
for executable behavior. This feature adds semantic review evidence.

## Implementation validation and remaining qualification

Local implementation checks on October 6 used ThinkThen 0.1.2, Clef Flash 9B
digest `9f411549…`, and Qwen3 Embedding 4B digest `df5bd2e3…`.

- Clef passed ThinkThen's four-request `check`: zero critical findings, three
  documented Ollama description-object warnings. Rubrics use plain strings.
- A five-question live annotate run produced all five typed answers. Observed
  call times were about 10–13 seconds on this machine.
- Qwen produced 2,560-dimensional vectors; residency was empty after each stage.
- The full EmbeddingGemma 2 BF16 tag, digest `54d80964…`, reported 744,369,976
  parameters and embedding/vision/audio capabilities. Its text path produced 768
  dimensions. On this Apple M4 Pro, one fixture embedding took 2.27 seconds and a
  three-input hybrid-candidate stage took 2.58 seconds, including CLI startup and
  model lifecycle. Peak observed Ollama model allocation was about 1.49 GB;
  this is neither total process RSS nor a CPU-only benchmark. Polling both local
  instances observed at most one loaded model, with both empty after the ledger.
- A hybrid-retrieval/two-pass ledger run over two synthetic consumers reported one
  missing companion update and one abstention, with assessment coverage of 50%.
  This exercised model switching and dependent questions, not real-world accuracy.
- On one naming fixture, fresh repeats and unused context matched; removing the
  body produced insufficient evidence. Whitespace and an assurance comment moved
  the probability by approximately 0.021 and 0.037 respectively without changing
  the interpreted answer. This is not a benchmark.
- In a two-question probe, reversing question order shifted behavior-change and
  adverse-naming probabilities by approximately 0.032 and 0.068. Single-question
  versus batched requests also differed. Answers stayed outside the uncertainty
  band; identical fresh repeats matched. Batch composition is therefore part of
  this implementation's cache identity, and each research run retains wire bytes.
- A ten-commit repository sample yielded 1,562 function/hunk records. A bounded
  30-file snapshot yielded 196 function records and explicitly recorded 4,715
  unscanned files. These are preparation artifacts, not adjudicated results.

No code-domain calibration or quality improvement has been established.
Independent multi-repository adjudication, SZZ/bug-inducing labels, recalibration,
task-conditioned changeability trials, full compiler/schema/co-change extraction,
SQL orchestration, automatic claim recognition and promotion to any enforcement
policy remain subsequent work. The generic decision-graph and logistic-head
primitives are available for those experiments; this release does not claim to
have completed them.

## EmbeddingGemma 2 comparison

The user-selected full 740M EmbeddingGemma 2 is the configured embedding default;
its quality remains unvalidated for these tasks. Its
[Google model card](https://huggingface.co/google/embeddinggemma-2) describes a
270M text backbone, an 8,192-token context, 768-dimensional vectors and supported
512/256/128-dimensional truncation. The reported code MTEB score is 78.68 versus
68.76 for its predecessor; that is not a comparison with Qwen3 Embedding 4B or
evidence of downstream code-quality improvement. The
[Ollama listing](https://ollama.com/library/embeddinggemma-2) provides an explicit
`740m-bf16` full-model tag, used here to avoid the `740m` alias's NVFP4
quantization in the primary comparison. Its table advertises
256K context despite the 8K model-card limit; use the documented 8K budget until
runtime behavior is qualified.

Compare BM25, Qwen and EmbeddingGemma 2, with and without lexical fusion, on the
same eligible candidates and evidence-token budget. Hold Clef, questions and bands
fixed. Record retrieval recall, downstream omission detection, false alerts,
context consumed, cold/warm latency, peak memory and model-switch overhead.
Use the full 740M model and native 768 dimensions for the primary arm.
Keep one model resident at a time and pin the installed digest and quantization.

Task prefixes are part of the experiment, cache and index identity. Google's code
retrieval query prefix differs from its document format; similarity uses a
symmetric prefix. These formats are implemented for EmbeddingGemma 2; dimension
truncation is not enabled. The [developer guide](https://developers.googleblog.com/embeddinggemma-2-the-developer-guide/)
explains that full-model loading adds vision and audio encoders around the shared
text backbone. Image/screenshot/spec retrieval remains a separate extension;
the current evidence path is text even when the full model is selected.
