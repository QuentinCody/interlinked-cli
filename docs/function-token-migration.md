# Function-token gate migration

Implemented scope: migrate the existing counter, validate the counting differences,
and preserve the over-limit hold-or-shrink rule. The oversized-function reduction
campaign is deferred; no backlog cleanup batches are part of this change.

## Measurement contract

The aggregate contract is `interlinked-code-v2`. Its JS/TS adapter uses
`interlinked-ts-ast-v1`, the same parser-resolved written-token counter already
used by `metrics score`. Python keeps its existing `ast`/`tokenize` counting
behavior, now identified separately as `interlinked-python-tokenize-v1`.

For JS/TS, count written keywords, identifiers, literals, operators, punctuation
and type annotations in complete implementation spans. Exclude whitespace,
comments, JSDoc and zero-width parser markers. A regex literal is one token;
template heads, middles and tails are each tokens including their delimiters.
JSX is interpreted in its parser context. These are syntax units, not a count of
every AST node, characters, words, billed tokens or an embedding-window estimate.

Function size includes nested implementations. Scoring exposure assigns each
token to its innermost implementation, avoiding duplicate weight. File inventory
`summedFunctionTokens` intentionally sums inclusive function sizes; it is not a
unique whole-file count. Offsets remain half-open UTF-16 offsets in JS strings.

Parser/adapter versions determine reproducibility; there is no universal AST
token count across languages or parsers. Inventory JSON retains `canonicalTokens`
and `tokenizer`, adds `measurement` provenance, and names language adapters and
parser versions. Python's runtime version matters even though its policy did
not change. Historical v1 numbers and unversioned pulse text remain historical;
they are never relabeled as v2.

## Gate and compatibility behavior

- Edit, commit, verify and metrics inventory consume the same language adapters.
  The JS/TS scoring counter is shared at `src/harness/function-tokens/ast-tokens.ts`.
- The shipped cap remains inclusive 500; configured stricter caps and existing
  source exemptions remain in force. No 1,000-token gate or 150-token target is added.
- Compare both before and after source with v2. Existing functions above the cap
  may hold or shrink, including functions newly revealed as oversized by corrected
  counting. Growth above the cap and new oversized functions block.
- Preserve the existing hybrid identity/rank comparison for uniquely named,
  repeated-name and anonymous functions. Moving debt into a new oversized named
  helper cannot use a shrinking original as an allowance.
- Unsupported adapters, missing parsers and recovered syntax remain explicitly
  unmeasured. If either comparison side cannot be measured, fail open with a
  visible warning. Do not interpret an invalid old source as an empty baseline.
- No baseline reset or manual adoption is necessary: the source before an edit,
  or HEAD source for a commit, supplies the comparison. Verify still reports the
  current over-cap inventory, including debt that a holding edit may retain.
- The parsed-source cache binds content and parser mode. Cached AST counts are
  immutable and weakly keyed by the parsed source, so evicted trees release their
  counts and caller-owned metric rows cannot alter later measurements.

Neither the gate nor structural scoring requires an embedding model, network
request or neural inference. The optional semantic runtime still uses
`llama-tokenize` and `llama-embedding` with an installed GGUF artifact.

Semantic generations record `tokenMeasurement`. Old contracts, absent metadata
or changed parser versions produce `measurement-mismatch`; status exits 1 and
queries refuse those counts. An explicit `interlinked semantic index` refreshes
counts and provenance. Compatible full input hashes and model/runtime fingerprints
allow vector reuse while metadata is replaced. Changed inputs are embedded again;
`--rebuild` explicitly disables reuse. No model download or indexing is triggered
by a source edit or by this migration.

## Validation evidence

The paired scan checks the same source bytes with the frozen v1 adapter and v2,
requiring equal implementation populations, identities and spans. It checks clean
commit pins before and after every corpus scan. The local working tree is labeled
unpinned and retains its observed source hash separately.

The 12 pinned repositories contain 17,330 measured JS/TS implementations; 5,446
counts changed with no population, identity or span changes. In pinned Interlinked,
33 functions newly cross 500 and 3 move below it: the over-cap census changes from
22 to 52. The local observation measured 16,659 functions, with 34 newly over-cap
and 3 moving below, changing 21 to 52. These are counting corrections, not changes
to the inspected repositories. Template rescanning can explain large upward
corrections; regex/JSX context can also reduce scanner overcounts.

All 12 structural scores, component aggregates, profile hashes and source hashes
match the previous corpus run exactly. Scoring weights and normalization knots
are unchanged. Missing source evidence remains explicit.

Benchmarks use separate adapter processes on Node 22.22.0 / Apple M4 Pro, 80
before/after pairs per representative file. Cold means cleared AST cache with
the Node module cache already loaded; warm means both parsed trees are cached.
For the guard, JSON-output and tool-execution files respectively, warm median
milliseconds changed from 0.095/0.388/0.556 to 0.066/0.316/0.381. Cold medians
changed from 0.559/1.448/1.693 to 0.798/3.453/5.197. Sampled process RSS peaked
around 249 MiB for v1 and 311 MiB for v2 across these cases. These include the
TypeScript runtime and process heap; they are not isolated per-function allocations.
The machine had concurrent workloads and high timing variance, so these results
do not establish a latency SLA or a cold-path speedup. The migration improves
correctness; caching avoids repeating the token traversal on warm parses.

Regression coverage exercises parser-sensitive syntax, nested ownership and cache
isolation, absent parsers, invalid before/after source, 500/501 and stricter caps,
migration-created debt, helper relocation, anonymous/repeated names, edit/commit/
verify parity, operation without llama executables/models, and semantic metadata
refresh with unchanged/changed embedding inputs.

Validation passed 349 focused tests in the shared working tree and 330 in an
isolated migration-only snapshot. That snapshot passes `npm run typecheck`;
the shared tree's later compiler errors were in concurrent pre-tool-dispatcher
edits. `npm run build`, `npm run docs`, focused Biome checks and validation of
all four affected source skills passed.

## Reproduction and completion checklist

Use the manifest shape documented in [metrics scoring](metrics-scoring.md), with
local clean clones checked out to full commit SHAs:

```bash
node --import tsx scripts/function-token-migration.ts --manifest corpus.json --out comparison.json
node --expose-gc --import tsx scripts/function-token-migration-benchmark.ts legacy src/commands/verify/output-json.ts
node --expose-gc --import tsx scripts/function-token-migration-benchmark.ts current src/commands/verify/output-json.ts
node --import tsx scripts/metrics-corpus.ts --manifest corpus.json --out scores
```

Add `--working-tree /path` only for an explicitly unpinned observation. Comparison
artifacts include per-function differences, source hashes, missing measurements
and discovery issues. This session's complete comparison, score rerun and timing
artifacts are under `scratch/2026-09-05-token-migration/`; the tracked
[validation summary](function-token-migration-corpus-2026-09-05.json) preserves
repository pins, measurement provenance and aggregate results.

- Shared counter, consumer parity, versioned metadata and brownfield semantics.
- Regression tests, type checking, build and source-skill validation.
- Paired corpus/source pins, unchanged scoring and runtime/memory measurements.
- Updated quality-gates, semantic-index, verify and router source skills.
- Deferred: split and simplify the oversized-function backlog in a future campaign.
