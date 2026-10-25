# Claim verification pilot

Runnable evaluation tools for extraction, evidence retention, grounded judgment, deterministic receipts and mutation setup. All six requested stages have run; see [RESULTS-2026-10-19.md](RESULTS-2026-10-19.md) and [NEXT.md](NEXT.md). The user's amendment authorizes model adjudication: 50 complete messages now have 666 frozen reference claims. These are model references, not human ground truth.

The [October 20 graph follow-up](RESULTS-2026-10-20.md) adds one-to-one extraction matching and an evaluation-only provenance query. The earlier 64.0%/89.2% complete-recall figures are containment diagnostics; the stricter one-to-one IoU ≥0.5 comparison gives 30.6%/55.7%. Both are retained with explicit definitions.

The subsequent [six-experiment decision/graph suite](RESULTS-2026-10-20-DECISION-GRAPHS.md) ran Jev and Clef on provenance, qualifier attachment, instruction corrections, module reachability, git edit localization and mutation ranking. It also compared Clef with the cached original final judge. The suite reports construction controls separately from retrospective repository replays; no production integration was activated.

## Run

Run from the repository root with its existing Node dependencies installed:

Live Cloudflare graph, replay, mutation-ranking and Clairic extraction runs require
your own `CLOUDFLARE_ACCOUNT_ID`. They use `CLOUDFLARE_API_TOKEN` when supplied,
otherwise the existing `cf` OAuth cache. No account is hardcoded in the source.
The test commands below use fixtures and injected clients; they do not read those
credentials or submit model requests.

```sh
node --import tsx --test evals/claim-verification/*.test.mts
node_modules/.bin/tsgo --noEmit -p evals/claim-verification/tsconfig.json

# Offline extraction comparison on the existing local dataset.
node --import tsx evals/claim-verification/run.mts

# Same comparison plus live judgments of authored synthetic fixtures.
# Requires TYPESAFE_API_KEY in the environment.
node --import tsx evals/claim-verification/run.mts --jev

# Audit original native transcript paths referenced by the local dataset.
node --import tsx evals/claim-verification/evidence-audit.mts

# Small live Clairic probes; missing credentials produce an explicit skip.
# Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
node --import tsx evals/claim-verification/clairic.mts

# Portable synthetic grounding comparison; does not need the private corpus.
# Omit --jev for offline request preparation; --nouls selects independent
# citation judgments followed by a complete-claim judgment.
node --import tsx evals/claim-verification/grounding.mts \
    evals/claim-verification/grounding-holdout.json \
    scratch/claim-grounding-new-run --jev --nouls

# Four-cell diagnostic against a prepared local annotated case.
node --import tsx evals/claim-verification/diagnostic.mts \
    scratch/2026-10-19-claim-verification/diagnostic-inputs/native-case-v2.json \
    scratch/claim-diagnostic-new-run --jev

# Complete-message extraction metrics against the frozen model references.
node --import tsx evals/claim-verification/extraction-comparison.mts \
    scratch/2026-10-19-claim-verification/reference-snapshot-01 \
    scratch/2026-10-19-claim-verification/goal-run-01/labeling-sources \
    scratch/claim-extraction-new-run

# Offline one-to-one rescore, saved Clairic outputs, and provenance replay.
# No credentials or model calls; requires the saved October 19 artifacts.
node --import tsx evals/claim-verification/graph-replay.mts \
    scratch/claim-graphs-new-run

# Prepare or score disagreement-only grounding rescue on DEVELOPMENT cases.
node --import tsx evals/claim-verification/grounding-rescue.mts \
    scratch/2026-10-19-claim-verification/diagnostic-inputs/grounding-cases.json \
    scratch/claim-rescue-new-run --threshold 0.9 --jev

# Isolated fixed-pool mutation setup; no model or production source writes.
node --import tsx evals/claim-verification/mutation-setup.mts \
    scratch/claim-mutation-new-run
```

Use a new output directory under ignored `scratch/` for every run. Result files use exclusive creation; reusing an output directory fails instead of overwriting previous results. `run.mts` accepts `--out`, `--dataset`, and `--model`; other scripts show their positional arguments above or in their usage error. Jev defaults to `jev-1.13.0` and records the returned model identifier. The scaled diagnostic and rescue use `eval-client.mts` to retain every request, response, reported usage and client-estimated cost; missing billing remains unknown. Collaboration-session cost and the resolved Astra provider revision are not exposed.

The historical dataset is private and is not committed. The default path is `scratch/2026-09-16-jev-checks/a1-dataset.jsonl`. For another local corpus, supply `--dataset PATH`, with one record per line:

```json
{"id":"session:1","session":"session","final_text":"Tests pass.","claims":[],"tools":[{"input":"npm test","result":"Tests 14 passed"}]}
```

The evidence audit intentionally targets the original dataset and its original Claude transcript layout. Its source-path assumptions are explicit in `evidence-audit.mts`; it does not search archives or other clients.

## What is implemented

- **Extraction comparison:** imports the production splitter unchanged and compares it with a deterministic splitter that retains source offsets, short statements, table data rows, and sentences beyond the production cap. Eight authored fixtures contain twelve targeted claim units.
- **Fixed judgment:** invokes the unchanged production `checkable` and `evidenced` Noul questions. The initial run used synthetic receipts; the later authorized diagnostic sent selected historical claims and evidence, screened for credentials. Original transcript collections stay local. Requests, raw responses, latency, usage and client-estimated spend are retained.
- **Evidence audit:** matches tool calls and results by ID, records source line references, checks the selected turn's final-message hash, and measures text discarded by the historical evaluator's 25-call, 300-character input, and 400-character result projection. It copies no raw transcript content into its report.
- **Clairic probe scaffolding:** exercises non-BMP characters, combining marks, CRLF, repeated occurrences, negation, absent values, numeric extraction, clause lists, and field fanout. It validates span slicing under UTF-16, code-point, and UTF-8-byte conventions, ignores `guess` when `value` is null, and records billing fields and `state_text` for inspection.
- **Reproducibility:** the comparison saves dataset hashes, Git revision, Node/ICU versions, and snapshots of its principal implementation files. This is not a complete snapshot of every transitive dependency or of a dirty repository.
- **Four-cell diagnostic:** compares legacy/manual target passages against operational/curated evidence, with the production judgment held fixed. Labels can differ by evidence snapshot: a true claim can still lack support in a truncated receipt. Missing candidates, missing answers, and low checkability remain separate.
- **Grounding comparison:** lexical retrieval enumerates up to twelve neighbouring-line windows with exact source offsets and hashes. Compare the baseline with either a citation Choice or independent Nouls followed by a judgment over the selected excerpts. Every citation is validated against the retained result. Remote calls now also include selected historical material from the prepared case; original transcripts remain local, and credentials are screened before submission.
- **Deterministic test-result verification:** `receipt-facts.mts` interprets only `All N executed tests passed.` with explicit receipt, source and selection identities. `verifyTestClaim()` checks the structured runner report and preserves supported, contradicted, unsupported and not-assessable outcomes. Identity linkage must be supplied; the module does not infer it from vague prose or authenticate a receipt's producer.
- **Complete-message annotations:** `annotation-metrics.mts` validates source hashes, UTF-16 spans and receipt IDs. `extraction-comparison.mts` measures claim/qualifier retention, character precision, source-co-location attachment, polarity and scope against the frozen references. `batch-diagnostic.mts` crosses legacy/manual extraction and operational/curated evidence, keeping reference labels out of requests.
- **One-to-one scoring:** `claim-matching.mts` assigns each prediction to at most one reference using qualifier-inclusive source-character IoU. Complete retention also requires all core and qualifier characters. The primary threshold is 0.5; old containment summaries remain available. This is reference agreement, not support accuracy.
- **Provenance experiment:** `provenance-graph.mts` checks typed receipt/execution/input paths and dependency freshness for explicit test-count claims. Inferred linkage and incomplete capture remain unknown. The graph assumes trusted capture metadata; it does not authenticate receipts or infer scope.
- **Disagreement rescue:** `grounding-rescue.mts` rechecks only baseline-positive/citation-negative cases against returned evidence. Cached development baselines require identical cases and pinned model. `--holdout MANIFEST` validates the pre-existing timestamp/hash and writes an exclusive scoring marker. The October 19 fresh holdout has already been scored; never rerun it as unseen evaluation data.
- **Operational receipts:** `operational-receipts.mts` adds three exact claim forms: command completed, typecheck completed cleanly, and named file written. Tests exercise actual processes, compiler results and observed writes, with identity/completion counterfactuals separately labeled. A completed command may have a nonzero exit; completion does not assert success.
- **Mutation setup:** `mutation-setup.mts` enumerates a stable AST-based pool for `hook-timeouts.ts`, runs the existing six tests in isolated copies, and compares seeded-random and fixed operator-priority order under equal execution budgets. It records timeouts separately from kills and checks that the originals remain unchanged. No Jev mutation arm is included.

## Interpretation limits

The initial twelve target units measure **specified text retention**, not population claim recall or precision. The later historical comparison uses complete model annotations of 50 messages, with five independently double-reviewed and reconciled. Span overlap and qualifier co-location do not certify semantic correctness. This reused corpus is not a preregistered held-out-session accuracy estimate. The old 699-row candidate queue is archived, not pending human work.

The improved splitter is deliberately over-inclusive. It does not resolve supersession, group distant qualifiers, or attach table headers and headings as context. It omits fenced examples. It has not replaced the production splitter.

The current two-Noul judgment reports support, not the full protocol's outcome states. A low `evidenced` value does not distinguish contradiction, insufficient evidence, and missing capture. Numeric outputs here are model scores, not demonstrated calibration.

Clairic's `completed` status means requests returned; inspect each field assessment and its meaning before declaring acceptance. The probe explicitly requests `options.return_state_text: true`. The trust run authenticated through the existing `cf` CLI OAuth cache, validated code-point offsets on non-BMP examples, and evaluated 50 messages with the original judgment held fixed. Full context-limit behavior and a verified immutable Clairic revision remain unmeasured. Complete-clause extraction performed poorly with the tested schema; see RESULTS.

The scaled four-cell diagnostic completed 196 cells on 49 recovered turns. One unrecovered turn remains excluded from evidence scoring. The subsequent trust run added Clairic extraction and 98 fixed-judgment cells. Authenticated Opus 5.5 provided a blind cross-family adjudication sample; its separate full extraction request returned a refusal and is recorded as a failed arm. Credentials are no longer the reason these arms were unavailable. General natural-language interpretation/linkage remains unvalidated.

`grounding-holdout.json` is the earlier 28-case authored suite. The subsequent independent 24-case suite, its creation hash and single scoring marker are retained privately under `grounding-fresh-holdout-01/`. Both are stress tests, never population accuracy estimates. Rescue improved the fresh stress result from 6 to 8 supported endorsements out of 12, with zero negative endorsements among 12; it did not improve the independently re-adjudicated development cases. No production change follows from these counts.

## Repository impact

The latest user-authorized change adds only a default-off receipt observer to the internal saved-transcript command: `node --import tsx scripts/internal/jev.mjs claims FINAL TRANSCRIPT --receipt-shadow LINKS`. Public hooks, judgment decisions and blocking policy are unchanged. The shared verifier code is used by both this observer and evaluation tooling. The source router and observability skills were updated and validated; installed skill copies were not edited. Raw results and private datasets remain ignored; `.gitignore` includes only reusable sources and aggregate documentation.

## Trust-run tooling

`controls.mts` constructs ablation proposals with explicit certification/exclusion reasons. `typed-controls.mts` supplies independently constructible receipt and document-value controls. `control-judgments.mts` compares the existing evaluator, citation Choice, independent citations and rescue; `--provenance` drops assistant/unknown-origin material in code. Its `--holdout MANIFEST` marker forbids repeat holdout scoring. Deterministic routing covers only exact grammars with explicit scope links.

`external-extractors.mts` records Clairic or authenticated Claude Code extraction, validates source spans, and reports complete-message reference agreement. `mutation-pool.mts` copies modules and runtime dependencies into isolated workspaces and retains complete mutation results. `mutation-ranking.mts` freezes IDs, scoring formula and equal execution budgets before Jev scoring; equivalence predictions are logged but excluded from ranking. Vitest transpilation alone is not TypeScript validity: compiler-invalid candidates must be separated before interpreting survivors. Raw screen results and any contaminated exploratory arm remain archived.

Current run artifacts are under `scratch/2026-10-19-claim-verification/trust-run-01/`; the current aggregate report is `RESULTS-2026-10-19.md`. All labels identify their model producer. Passing known-answer controls does not turn the real-corpus model references into ground truth.
