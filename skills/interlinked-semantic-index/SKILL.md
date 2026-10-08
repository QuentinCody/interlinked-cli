---
name: interlinked-semantic-index
description: "Install and operate Interlinked's optional local semantic function index. Load this for `interlinked semantic models/install/index/status/search/similar`, local embedding runtime setup, model or index corruption, stale/model-mismatch states, or questions about canonical tokens versus embedding-model tokens. The feature is local-only and experimental; it never controls code-edit gates."
---

# interlinked-semantic-index — local function retrieval

## Separate decision-metrics research index

`metrics decisions embed|geometry|retrieve|candidates` uses a separate Ollama pipeline
under `.interlinked/decision-metrics/`; it does not reuse or change `semantic.json`,
the GGUF manifest, or `index/functions/`. Load **interlinked-quality-gates** for its
measurement, ledger and audit commands. `retrieve` defaults to BM25; embedding and
hybrid modes are explicit. Historical neighbors require fix provenance and exclude
future data; current-consumer candidate discovery retains retrieval misses.
`geometry` takes at most 200 records with one pinned embedding identity, retaining
uncalibrated churn, group dispersion and nearest-neighbor distances. It is not a
quality score; supply the same model identity for any prior embedding.
The default is the full `embeddinggemma-2:740m-bf16`, with all encoders retained and
768-dimensional output. Retrieval uses Google's code-query/document prompts;
geometry uses symmetric similarity prompts. Profile identity travels with the
model digest; do not mix those populations. Requests use 8K context and reject
truncation. Ollama 0.35.1 cannot pull this model; use a compatible newer runtime.
The current evidence path is text; selecting full weights does not certify image
or audio ingestion. Qwen remains available by explicit `embeddingModel` config.

The decision runtime serializes cooperating local jobs, checks resident models,
switches between the two configured models and unloads after each stage. It refuses
unrelated resident models. Embeddings are cached by exact input and model digest;
they are retrieval/ranking evidence, not calibrated quality probabilities. The
short PostToolUse advisory path does not perform repository-wide retrieval.
See `docs/decision-metrics.md` for budgets and explicit remote decision configuration;
the existing `semantic` commands below remain local-only.

Interlinked can embed complete functions into a repository-local vector index and search them by
meaning or similarity. The v1 subsystem is **experimental, explicit, and local-only**: no source,
query, vector, or model inference is sent to the Interlinked MCP Server or a cloud provider.

This is independent from the hard function-token gate. The gate uses the
`interlinked-code-v2` contract (parser-resolved JS/TS syntax, Python stdlib tokenization)
and an inclusive 500-token ceiling, without an embedding model. The semantic index uses
the active model's real tokenizer, records `modelTokens`, and syntax-chunks long inputs before
weighted-centroid aggregation. Model context changes never redefine or bypass the hard cap.
The semantic runtime's `llama-tokenize` path currently requires the installed GGUF artifact
and local llama.cpp commands, even though tokenization itself does not run neural inference.

Use **syntax tokens** (lexical tokens), not AST-node counts, when explaining the hard cap
or `metrics score`. `canonicalTokens` is the compatible field name for the versioned syntax
count; `modelTokens` describes the selected embedding tokenizer. No universal conversion
rate exists between these units. The metrics composite, behavioral evidence and per-edit
coverage workflows do not need semantic models. Route those operations to
**interlinked-quality-gates**; installing an embedding model cannot resolve missing test evidence.

## Command surface

```bash
interlinked semantic models [--json]
interlinked semantic install --model <alias> [--json]
interlinked semantic index [--rebuild] [--include-tests] [--cwd <path>] [--json]
interlinked semantic status [--cwd <path>] [--json]
interlinked semantic search <query> [--top <n>] [--language <id>] [--path <glob>] [--cwd <path>] [--json]
interlinked semantic similar <file> --line <n> [--top <n>] [--cwd <path>] [--json]
```

Use `models` first. `install` is the sole download-authorized operation: it prints the license,
size, source, and cache target, streams from an allowlisted HTTPS registry, verifies the pinned
byte count and SHA-256, then atomically promotes the artifact. It does not build an index.

The default experimental manifest is the Apache-2.0
`nomic-embed-text-v1.5-q4@0188c9bf409793f810680a5a431e7b899c46104c` GGUF artifact. Interlinked
does not execute model-repository code. In addition to the downloaded weights, the machine must
provide compatible `llama-embedding` and `llama-tokenize` commands from llama.cpp. A runtime or
model failure disables semantic results only; source edits and the guard daemon keep working.

## Configuration and storage

Team policy is `.interlinked/semantic.json`:

```json
{
  "version": 1,
  "enabled": false,
  "model": "nomic-embed-text-v1.5-q4@0188c9bf409793f810680a5a431e7b899c46104c",
  "include_tests": false,
  "include": ["src/**"],
  "exclude": []
}
```

Machine topology is `.interlinked/semantic.local.json` and may contain only `device` (`auto` or
`cpu`), non-negative `threads`, `batch_size`, `idle_unload_ms`, `incremental_indexing`, and
optional local command names `llama_embedding_command` / `llama_tokenize_command`. Unknown keys,
including remote URLs and credentials, are rejected. Zero selects runtime auto-tuning.

Weights use the platform user cache (override with `INTERLINKED_MODEL_CACHE`). Generations use
`.interlinked/index/functions/generations/`, with `.interlinked/index/functions/CURRENT` naming the
last atomically published complete generation. Local config and all index artifacts are
gitignored and are not included in sync.

## Index and query contract

- `index` scans confined, ignored-aware product source with exact function adapters. Tests are
  excluded unless team config or `--include-tests` enables them; generated/vendor/data paths stay
  excluded. `--rebuild` disables unchanged-input vector reuse.
- Every generation binds the exact model/runtime fingerprint, input schema, canonical counter,
  chunk aggregation policy, dimension, hashes, and source census. An interrupted build leaves the
  previous `CURRENT` generation readable.
- `status` distinguishes `absent`, `building`, `current`, `stale`, `corrupt`, `model-mismatch`,
  `model-missing`, `runtime-missing`, and `measurement-mismatch`.
- New metadata includes `tokenMeasurement` with the contract, language adapters and parser
  versions. Legacy/mismatched measurement metadata cannot be queried as current counts;
  `status` reports `measurement-mismatch` and exits 1. Run `semantic index` to refresh it.
  Unchanged full inputs and model/runtime fingerprints can reuse vectors while canonical counts
  and provenance are recomputed. `--rebuild` remains the explicit no-reuse option.
- `search` embeds the query locally and exact-scans cosine similarity. `similar` uses the stored
  vector of the innermost indexed function containing the requested line and excludes itself.
  Results sort by descending score, then file, line, and symbol.
- A stale index remains queryable with an explicit warning. A corrupt or fingerprint-mismatched
  index is refused; Interlinked never returns a partial generation.
- Scores are heuristic retrieval evidence and comparable only within the named fingerprint.
  Query text is not persisted.

The `enabled` flag reserves automatic idle/incremental indexing policy. Manual semantic commands
remain explicit operator actions. Current experimental builds do not schedule model work in a
blocking hook response and do not offer remote inference, hybrid ranking, or an LLM reranker.

## Troubleshooting

1. Run `interlinked semantic status` and preserve its state/reason.
2. For `model-missing`, run `semantic models`; only install after the operator has authorized the
   displayed download.
3. For `runtime-missing`, install/configure compatible local llama.cpp executables; do not add a
   cloud fallback.
4. For `stale`, run `semantic index`; the last generation is still readable meanwhile.
5. For `corrupt` or `model-mismatch`, run `semantic index --rebuild` after the configured exact
   model/runtime is available. Do not hand-edit vectors, metadata, `CURRENT`, or fingerprints.
6. For `measurement-mismatch`, run `semantic index` with the configured model/runtime available;
   this refreshes measurement metadata without forcing compatible inputs to be re-embedded.

Related skill: **interlinked-quality-gates** owns the separate deterministic 500-token ratchet.
