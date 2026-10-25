# Tool-output efficiency

## Selection rule — fixed before measurement

Recorded on 2026-10-20, before running the new measurement pass.

For each output category, calculate:

`selection_score = output_tokens × token-weighted share with no observed later use`

Choose the category with the largest score. Break ties by category name. Do not
choose by novelty or by how interesting a model application appears. Categories:
file reads, search, test/build diagnostics, structured data, diffs/status, mixed
operations, and other. Mixed and other remain eligible; narrow the winning category
by its largest contributing tool family, using the same rule.

“Use” is an observable proxy: a later exact textual quotation, an edit to a file
named by the output, or execution of a command suggested by the output. Measure
blocks of at most 16 lines / 2,000 characters. A match conservatively marks the
whole block used. No observed use is not proof that the agent did not reason from
the output, or that removing it would be safe. Do not call the score saved tokens.

Primary population: the 188 Interlinked parent sessions retained in the earlier
scan, excluding transcripts modified within 24 hours of the frozen manifest time.
Child sessions in this project provide a separate comparison population. Never
combine independent agents into one context. Freeze file lengths before parsing.
Report unreadable, malformed, incomplete, and unknown records explicitly.

Count repeated unchanged content separately within the same agent and compaction
epoch, across compaction in that agent, and across agents. Exact normalized lines
of at least 20 non-whitespace characters are repetition candidates; short syntax
lines are excluded. Multiple appearances within one output are not rereads.
These are potentially avoidable tokens, not proven redundant reads. Cross-agent
comparisons use recorded timestamps and retain unknown order separately.

Report output additions, deduplicated provider input usage, cache-read usage, and
peak reported input per session separately. Do not sum cumulative usage counters.
Do not invent prices where historical model/billing evidence is missing. Compaction
markers define observed epochs; absent markers do not establish perfect capture.

Freeze this file's initial SHA-256 in the run manifest. Store raw-derived artifacts
locally under `.local/`; publish aggregate results only. Use a single analysis
process with bounded caches. Do not alter hooks or native tool behavior.

## Intervention and experiment rules

Build the winner first, then the remaining adapters: file reads, search,
test/build logs, structured JSON, and historical evidence retrieval. The wrapper
keeps original bytes with a content ID and source version, returns verbatim spans,
reports omissions, and supports explicit full output and expansion. Small outputs
and calls without an explicit question keep the existing bounded baseline.
Mandatory failures and incomplete execution remain visible. Never execute commands
found in an output. Never silently replace an explicit full read with a selection.

Compare captured existing output, a declared head/tail baseline where native
truncation is unknown, code-only extraction, decision scoring, and an optional
embedding-plus-decision arm when an embedding backend is available. Do not label
lexical scores as embeddings or synthetic decisions as model results.

Replay measures text retained, later-use proxy recall, expansion, and exact-byte
recovery. It cannot measure live task success, agent trust, or actual expansion
behavior. Keep those outcomes unmeasured until a controlled live trial. Log real
model latency, failures, token usage, and costs when available. Native session
content stays local; live model probes use public repository code or synthetic
fixtures only. No production activation follows automatically from an offline win.

## Results

The fixed rule selected **mixed outputs**, principally functions.exec. The first
intervention is an opt-in wrapper with retained receipts and expansion. Category
adapters, local replay, Jev controls, and real embedding controls are implemented
and have run. **The current selector is not ready for automatic filtering.**

### Corpus and accounting

- 2,343 native transcript files: 182 parent sessions (23 Claude, 159 Codex) and
  2,161 child sessions (692 Claude, 1,469 Codex).
- 5.249 GB of retained native records; 1.948 GB belongs to the primary parents.
  Nine candidate transcripts were excluded because they were modified within
  24 hours of the manifest. Six of those were previous parent sessions.
- No malformed/incomplete records or failed files were reported. 2,149 duplicate
  storage records were ignored. This does not establish complete provider capture.
- The run took 443 seconds in one process. Peak resident memory was 536 MB.
- Primary output estimates total 72,501,528 o200k tokens, counted per text block.
  These are recorded additions, not live context occupancy or billed input.
- Parent-session reported input: Claude 2,957,233,343 tokens, including
  2,910,646,918 cache reads; Codex 5,079,025,094, including 4,913,847,808 cache reads.
  Counts cover 6,442 and 37,635 model calls respectively.
- Largest reported parent input call: Claude 966,487; Codex 272,815 tokens.
  These are input measurements, not advertised model capacity or exact total
  context including output/reasoning. Historical dollar cost remains unknown.

### Mechanical category selection

| Category | Output tokens | No observed later use | Selection score |
|---|---:|---:|---:|
| Mixed calls | 38,148,173 | 55.8% | **21,298,061** |
| File reads | 19,621,423 | 65.9% | 12,925,295 |
| Other | 8,438,736 | 90.8% | 7,665,411 |
| Search | 3,306,970 | 86.6% | 2,863,435 |
| Test/build | 1,430,400 | 90.9% | 1,300,093 |
| Diffs/status | 1,344,691 | 89.0% | 1,197,294 |
| Structured data | 211,135 | 89.2% | 188,307 |

Within mixed calls, functions.exec contributes 18,563,853 score tokens out of
33,990,038 output tokens. That determined the first intervention. Classification
is conservative: compound shell pipelines can land in mixed, and unknown commands
remain other. This is not a clean breakdown of every inner tool in an exec batch.

The use matcher compares case-preserved eight-word windows, with punctuation and
whitespace normalized, later edits to named paths, and exact later command lines.
A match marks the entire block used. It does not prove causal use or non-use.
A successful test result may inform the agent without being quoted later. These
scores must never be described as safely removable tokens.

Initial rule SHA-256:
c7d3c787921ba27a05c528117abb05747866c0e611f12beee3ba1d32972881a0.
Its original bytes are retained in .local/run-01/protocol-before-measurement.md.

### Repetition

The following are exact normalized-line token estimates in parent sessions.
They exclude short syntax lines and keep same-output repetition separate.

| Relationship | Claude | Codex | Total |
|---|---:|---:|---:|
| Same agent, same compaction period | 220,688 | 3,622,438 | **3,843,126** |
| Same agent, across compaction | 150,813 | 8,021,046 | 8,171,859 |
| Earlier matching content in another agent | 238,411 | 4,882,773 | 5,121,184 |

The first row is about 5.3% of parent output estimates. Only 2,216,086 tokens in
that row were clearly classified as file-read/search output. Mixed calls are not
silently reassigned to reads. Neither number proves that suppressing a read is
safe. Repeated boilerplate and identical text from different sources can match.
Cross-agent order is based on timestamps; 261,224 token estimates had uncertain
cross-agent order and were reported separately. The categories do not certify
content remaining in the actual model context.

### First intervention and local replay

The wrapper stores original text with source/version/call identity and a verified
hash. It returns selected verbatim spans, omission counts, and an expansion ID.
Explicit full reads bypass selection. No question returns the declared baseline.
Small results skip model calls. Recognized failure markers stay visible, even
when that exceeds the nominal character budget.

The local replay sampled up to eight large outputs per parent session by a fixed
hash order: 1,016 outputs, totaling 5,214,865 tokens. Native as-delivered text is
the real baseline. The head/tail policies below are declared alternative baselines,
not claims about each client's native truncation implementation.

| Replay arm | Initial response tokens, including wrapper metadata | Later-use token recall | Outputs with omitted later-used material |
|---|---:|---:|---:|
| Native as delivered | 5,214,865 | 100% | 0 |
| Plain head/tail | 1,300,493 | 15.3% | 365 |
| Head/tail with required markers retained | 2,101,987 | 41.2% | 345 |
| Code-only selection with the same required markers | 2,108,861 | 41.6% | 341 |

The code selector reduced initial response tokens by 59.6%, but omitted 595,914
tokens matched to later use. Its improvement over the comparable marker-preserving
baseline is only about 0.4 percentage points. The majority of the apparent gain
over plain truncation comes from preserving marked blocks, not relevance scoring.

Both marker-preserving arms exceeded the nominal 4,000-character budget in 403
outputs. Failure words inside code cause conservative over-retention. A future
integration should use structured runner results where available.

Replay uses preceding tool arguments as a query proxy, not an explicit read
question. It does not establish real agent intent. No private session content
was sent to Jev or the embedding service. Missing later-used blocks suggest
expansion needs; these are not observations of an agent choosing to expand.
The failed first streaming-reader attempt and earlier replay versions remain
locally retained. Final figures use replayed-v5.jsonl and Unicode-aware offsets.

### Decision and embedding experiments

Twelve authored cases cover mixed output, file reads, search, test/build logs,
structured data, and historical receipts. Each has two required passages placed
in the middle. This intentionally tests middle-content loss, not production
relevance accuracy.

| Arm | Required passages retained | Initial response tokens |
|---|---:|---:|
| Head/tail | 0/24 | 6,924 |
| Code only | 24/24 | 7,068 |
| Jev | 24/24 | 7,068 |
| Real embeddings | 24/24 | 7,068 |
| Embeddings then Jev | 24/24 | 7,068 |

Original fixture output totals 26,826 tokens. The successful arms produced the
same retained text. **This experiment shows no accuracy advantage for Jev or
embeddings over code on these easy controls.**

Direct Jev: 12 calls, 64,652 input tokens, median selection latency 105 ms,
range approximately 77–238 ms, estimated cost $0.002715.
Embedding shortlist then Jev: 12 calls, 28,364 input tokens, median 124 ms,
maximum 212 ms, estimated Jev cost $0.001191.

The real embedding call used Cloudflare @cf/baai/bge-small-en-v1.5: 28 distinct
strings, 6,104 reported prompt tokens, and 923 ms for the shared batch. This
batch latency is not a per-tool latency measurement. At the published
$0.0202/million rate, its estimated cost is $0.000123. The model name is a
versioned family, not a verified immutable serving revision.

Total successful model-call estimate: **$0.004030**. One earlier embedding
authentication rejection has unknown billing. The existing Cloudflare login was
usable after its normal authentication check. Requests, responses, model IDs and
usage are retained locally. Estimates are not invoice reconciliation.

Documentation: [TypeSafe Noul](https://docs.typesafe.ai/primitives/noul),
[TypeSafe re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe),
[Cloudflare embedding reference](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/).

### Delivered and still unmeasured

Implemented: frozen corpus analysis; compaction-aware repetition accounting;
the mixed-output wrapper; file/search/log/JSON/history adapters; exact named JSON
field projection; independent Jev judgments; real vector retrieval and hybrid
ranking; private local replay; receipts, expansion events, and full bypass.

Not established: safe automatic omission, actual end-to-end task savings,
agent expansion behavior, rerun reasons, or task correctness under reduced
context. Live agent trials belong in the main conversation; this side
conversation does not spawn agents. Native hooks and production policies remain
unchanged. Search was not the selected first target, so no jevgrep comparison
was represented as completed.

Validation: 16 Node tests and 11 Python tests pass; evaluation TypeScript checks,
scoped secret/whitespace checks, and both source-skill validations pass.
These are scoped checks, not a clean verdict for the main thread's entire worktree.
Installed skill copies were not changed. The source
router and observability skill document the new opt-in workflow.
