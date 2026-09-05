---
name: interlinked-semantic-index
description: "Install and operate Interlinked's optional local semantic function index. Load this for `interlinked semantic models/install/index/status/search/similar`, local embedding runtime setup, model or index corruption, stale/model-mismatch states, or questions about canonical tokens versus embedding-model tokens. The feature is local-only and experimental; it never controls code-edit gates."
---

# interlinked-semantic-index — local function retrieval

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
