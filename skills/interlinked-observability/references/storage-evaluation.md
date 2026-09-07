# Evidence storage experiments

Use `data scan` for an immediate bounded investigation of the original files. Use `data lab`
when measuring or selecting a storage engine. Lab commands create private output directories
and refuse to overwrite an existing output. They do not change the production index, capture
configuration, retention, or original JSONL files. Keep experiment artifacts unless their
removal is separately authorized.

`data scan --full-text` searches all decoded string values rather than the 32 Ki-character,
2,048-visit/depth-8 normalized projection. It keeps previews bounded and reports the same
physical byte/line limits. `--raw` includes the full returned record; request a small limit.
This full-value lane deliberately has different recall from the comparable normalized engines.

## Reproduce a local comparison

```bash
interlinked data lab generate --out ./evidence-synthetic --records 20000 --payload-bytes 1024
interlinked data lab benchmark --corpus ./evidence-synthetic --out ./evidence-results --disk-mb 8 --repetitions 5
interlinked data lab snapshot --cwd . --out ./evidence-local --max-mb 32 --records 20000 --max-files 16
interlinked data lab benchmark --corpus ./evidence-local --out ./evidence-local-results
```

Prefer an output outside `.interlinked/` to avoid discovering experiment replicas as capture.
Snapshots take bounded complete-line prefixes of recently modified files; they are samples,
not backups of all retained history. A native Claude comparison requires an explicit
`--native-dir /path/to/one/project/transcripts`. Native overflow assets outside JSONL are not
copied, and an index cannot recover unrecorded or externally stored content. Original native
records are retained while provider/model/actor fields are projected for comparable filtering.

## Engines and retrieval

| Engine | Storage and query behavior |
|---|---|
| `scan` | Reads a frozen JSONL corpus directly; no derived index. |
| `gzip` | Lossless whole-file compression plus direct scan; decompression starts at file start. |
| `legacy` | Runs the existing production SQLite importer/schema in an isolated project. |
| `compact` | One searchable text copy with external-content FTS5 and smaller indexes; separate experimental format. |
| `bounded` | Compact index with explicit total allocation budget, including rollback headroom. Capacity exhaustion falls back to a full corpus scan. |
| `segments` | Content-addressed gzip JSONL with source/session/time summaries and verified hashes. |
| `cloud` | Synthetic-only evaluation via Worker, R2 payload objects and bounded SQLite DO catalogs. |

```bash
interlinked data lab build --corpus ./evidence-local --out ./evidence-small-index --engine bounded --disk-mb 8
interlinked data lab search --corpus ./evidence-local --index ./evidence-small-index --engine bounded --query '{"session":"SESSION","text":"error","limit":10}'
interlinked data lab show --corpus ./evidence-local --id RECORD_ID
interlinked data lab fts --index ./evidence-results/compact --engine compact --query '{"text":"error OR timeout"}'
```

`compact` is capped at a 2 GiB total allocation budget in CLI builds/benchmarks; `bounded`
uses `--disk-mb`. The database ceiling is approximately half that budget to reserve rollback
space. The bounded index admits a corpus-order prefix, not a moving recent-history window.
It never evicts raw evidence. A partial `compact` query reports incomplete coverage; use
`bounded` for automatic scan fallback. Library resume accepts immutable prior files plus
new segments, rejects removed/replaced prior files, and deduplicates replay.

Lab text queries use ASCII case folding and ANDed literal substrings over a bounded normalized
text projection. Non-ASCII characters remain literal. Time bounds in `--query` are numeric epoch
milliseconds; null times are excluded by bounds. Exact dimensions include tenant, project,
source, category, session, actor, provider, model, call, kind, decision, origin, file and check.
Unknown query keys are rejected. Ordering is event time descending then ID ascending. `show`
verifies the original record hash; it requires the original corpus (or its gzip equivalent).

FTS uses SQLite unicode61 tokens/phrases; `needl` does not match `needle`. Raw `rg` searches
serialized JSON, including field names and escaped strings, and counts physical lines. Neither
is interchangeable with portable search. Projection truncation is reported; completeness is
relative to the frozen corpus and normalized projection, not the original unsampled history.

## Read benchmark results

`report.json` retains exact queries, corpus hashes, per-query times, first/warm p50/p95,
build time, engine storage, CPU and process peak RSS. Engine workers use fresh processes.
File verification/build warm caches; first-query latency is not an OS-cold measurement.
Correctness compares full matching-ID sets and ordered pages before accepting timing results.
FTS equivalence is a separate lane; raw `rg` counts are descriptive, not scored against IDs.

Storage is incremental engine storage: add the original corpus size for total retained disk
use. Legacy fixtures also copy raw input for isolation; that copy is reported separately.
Cloud storage figures describe local upload artifacts, not deployed billing. Full ID sets cost
memory proportional to matches; this is an evaluation API, not an unbounded production RPC.
`bytesRead` is expanded source bytes for whole-file scans, compressed bytes for segment scans,
and zero raw-source bytes for indexed queries. It is not physical disk I/O; SQLite/cache reads
are unmeasured. Performance on a busy development machine is descriptive, not an SLA.

## Cloud and analytics boundaries

The source repository's `experiments/evidence-cloud/wrangler.jsonc` runs with `wrangler dev
--local`. The Worker stores immutable gzip payloads in R2 and partitions catalogs into at most
128 KiB of manifest JSON per SQLite Durable Object. Queries scan at most 1,000 candidate
segments and mark overflow incomplete. Results include an object locator; the authenticated
GET object route retrieves compressed original evidence for hash verification.

The prototype uses a token bound to one configured tenant per deployment. It is not the
Interlinked MCP Server's production multi-user authentication or permission system. A deploy
still needs a selected staging account, bucket, secrets and operator review. The benchmark
client permits only synthetic corpora, including when pointed at localhost. Real logs stay local.

R2 SQL queries Iceberg tables, not arbitrary gzip JSONL. `data lab analytics-export` writes a
local JSONL ingestion artifact and schema guidance; it does not create a catalog/table or upload
data. `analytics-query --account ID --bucket NAME --table namespace.table --tenant TENANT
--project PROJECT --query '{...}'` uses `WRANGLER_R2_SQL_AUTH_TOKEN` and the documented HTTPS
API. Scope is required, text is literal, identifiers are restricted, and unsupported file/check
array predicates fail explicitly. Live correctness, ingestion, freshness, network cost and
performance remain unmeasured until tested against a provisioned staging catalog.
