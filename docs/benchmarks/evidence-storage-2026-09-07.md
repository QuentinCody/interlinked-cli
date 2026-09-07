# Evidence storage evaluation — 2026-09-07

The original JSONL files remain authoritative. Direct scans require no SQLite; optional
compact indexes use substantially less space than the existing index, while compressed
segments provide the smallest tested representation suitable for an R2 payload store.
No original logs, archives, native transcripts, or existing production database were removed.
Neither automatic indexing nor automatic rotation was enabled.

The [aggregate measurements](evidence-storage-2026-09-07.json) retain query timings, full
matching-ID hashes, ordered-page hashes, coverage, build times, CPU and RSS. Private selectors
and payloads remain in `scratch/evidence-storage-evaluation/`, outside committed artifacts.
The [implementation plan](../plans/evidence-storage-evaluation.md) and
[operator workflow](../../skills/interlinked-observability/references/storage-evaluation.md)
describe the contracts and commands.

## What was built and exercised

- `data scan`: direct, bounded JSONL/gzip search; `--raw` returns original record text/hash.
  `--full-text` searches all decoded string values beyond the bounded normalized projection.
- `data lab`: explicit generate/snapshot/build/search/show/benchmark commands, with fresh
  worker processes, immutable sample manifests, original-byte verification and portable queries.
- Legacy SQLite baseline using the actual existing importer/schema in an isolated project.
- Compact SQLite with one searchable text copy, integer FTS row references, external-content
  FTS5, fewer indexes, and page-bounded payload retrieval. FTS is a separate comparison lane.
- Bounded compact indexing with rollback-journal headroom, declared capacity exhaustion,
  immutable-segment append/replay support, and complete-scan fallback. This admits a prefix
  of the corpus; it is not a recent-event sliding window.
- Content-addressed gzip segments with verified payload hashes, tenant/project scope,
  source/session/time pruning and immutable publication.
- A Worker with actual local R2 and SQLite Durable Object bindings. Payloads live in R2;
  catalogs are immutable partitions capped at 128 KiB of manifest JSON per DO. Query overflow
  beyond 1,000 candidate segments is explicitly incomplete. Object retrieval verifies hashes.
- R2 SQL local ingestion export, restricted SQL builder, HTTPS API adapter and contract tests.
  Unsupported file/check array predicates fail explicitly. No Iceberg table was provisioned.
- Rotation and indexing controls separated: `auto_compact` alone never invokes the SQLite
  importer. `data maintain --execute --compact --no-index` preserves logs without touching
  the existing database. Numeric gzip rotations are discovered and categorized correctly.
- Source skills and bundled workflow references updated, validated, and refreshed through
  ownership-aware writes for the repository's existing Claude/Codex installations.

## Storage results

Sizes are MiB (1,048,576 bytes), rounded. Every row uses the same frozen bytes across engines.
These are different corpora, not equivalent conversations or capture coverage.

| Corpus | Physical records | Raw JSONL | Whole-file gzip | Existing SQLite | Compact SQLite | Segments + manifests |
|---|---:|---:|---:|---:|---:|---:|
| Generated small | 1,000 | 1.25 | 0.031 | 7.25 | 2.83 | 0.038 |
| Generated larger | 20,000 | 24.99 | 0.595 | 138.25 | 53.77 | 0.755 |
| Interlinked sample | 16,689 | 13.33 | 1.592 | 53.90 | 24.17 | 1.688 |
| Claude native sample | 4,806 | 24.45 | 5.208 | 52.90 | 30.08 | 5.452 |

The compact database is about 55% smaller than the existing database on the Interlinked
sample, and 43% smaller on the Claude sample. It still consumes additional disk alongside
JSONL. Whole-file gzip and segments here are additional experiment copies; originals were
retained. The legacy fixture also copies source JSONL for isolation, excluded from its index
column and reported separately by its build receipt.

An 8 MiB total allocation budget produced a 2.83 MiB complete bounded index for the small
generated corpus. The larger corpora filled about 3.65–3.88 MiB of database/receipt storage,
reserving the remaining space for rollback writes. Their bounded queries fell back to direct
scans and returned the complete expected IDs. Per-pass import budgets on the old index remain
distinct from this total allocation limit.

Generated payloads contain substantial repetition. Their compression ratio is not a forecast
for arbitrary human/agent content. The real native sample compressed much less aggressively.

## Search results and interpretation

All four corpus comparisons passed: every tested portable query returned the same full ID set,
count, completeness flag and ordered result page across the relevant engines. The two generated
corpora included the local cloud engine; real logs were tested only locally. Each corpus had
11–14 portable queries and five repetitions. Four FTS expressions were compared separately
between the two SQLite schemas, with matching IDs and completeness.

Portable queries use ASCII-folded ANDed substrings over the same bounded string-value projection,
plus exact dimensions and inclusive event-time bounds. The projection keeps up to 32,768 string
characters, 2,048 field visits and depth 8. Completeness means the frozen corpus/projection was
searched; it does not mean an unsampled original history or every original character was searched.

For the literal `error` query, reported warm p50 latency was:

| Engine | Interlinked sample | Claude sample |
|---|---:|---:|
| Direct normalized scan | 214 ms | 555 ms |
| Gzip normalized scan | 201 ms | 241 ms |
| Existing SQLite substring query | 16 ms | 35 ms |
| Compact SQLite substring query | 34 ms | 40 ms |
| Bounded index + complete-scan fallback | 191 ms | 245 ms |
| Compressed segment scan | 217 ms | 298 ms |
| Raw `rg` line search | 6 ms | 6 ms |

Raw `rg` and FTS are different search operations. Raw grep includes JSON field names and escaped
serialization; FTS matches tokens/phrases and excludes partial-token matches unless requested by
its grammar. They are not alternative timings for the same portable predicate. SQLite FTS was
fast for the tested token queries; expressions and all samples are retained in the JSON report.

On the Claude sample, raw grep found `error` on 767 lines. Of these, 375 had no matching decoded
string value: the match was in JSON keys. There were 392 string-value matches, of which 14 were
omitted by the normalized projection. The new full-text direct scan recovered all 392; its warm
p50 was 286 ms in a separate run. Returning the original JSONL preserves the omitted text.
On the Interlinked sample, 836 physical matching lines became 827 distinct source/record IDs
through exact replay deduplication; no `error` string-value match was lost to projection there.
Eleven Interlinked records and 65 Claude records had some projection truncation overall.

The local cloud run returned correct results for 20,000 generated events, with a 1.4-second
build/upload and roughly 0.6–0.9-second warm queries for several tested predicates. These include
local Worker/R2/DO coordination, not internet latency or production billing. After terminating
and restarting Wrangler with persisted storage, both the 1,000- and 20,000-event catalogs returned
the same rare-match and whole-corpus ID hashes without re-uploading.

## Validation and measurement limits

The regression suites exercise exact filters, time boundaries, Unicode, punctuation, pagination,
independent expected results, replay, append/reopen, capacity exhaustion, malformed/partial data,
hash mismatch, CRLF/blank offsets, gzip replay, source preservation, rotation without SQLite,
catalog partitioning, authentication, tenant isolation, corrupt objects, forged pruning metadata
and original-object retrieval. A compiled CLI smoke comparison covers all six local engines.

Typecheck and build were validated in an exported HEAD snapshot with only this change overlaid.
The final focused run passed 86 local regression tests plus six real local cloud integration
tests. The compiled CLI comparison passed all six local engines, and four persisted catalog
queries passed after a full Wrangler restart.
The shared workspace contains unrelated concurrent changes; its general build/typecheck can fail
outside these files. The attempted workspace build encountered unrelated `src/index.ts`
health-check call typing errors; its installed binary was not replaced with a failed build.
Use `npm run dev -- data ...` while that separate work is unfinished. This is not a claim that
every repository test passed. The local cloud
integration suite uses Wrangler 4.95.0/workerd with compatibility date 2026-06-02; no new dependency
or real cloud deployment was required.

Engine runs use fresh Node processes and proceed sequentially within each benchmark. Hash
verification and builds warm caches before the first query. First-query results are not OS-cold;
warm p50/p95 use the remaining four samples. The development machine was busy with unrelated
work, so timing differences are descriptive and noisy. The report includes individual samples;
do not extrapolate an SLA or production capacity from this run. RSS includes runtime/imports;
full ID-set verification still needs memory proportional to matches.

Scan byte counts are expanded input, segment counts are compressed bytes, and indexed queries
report zero raw JSONL bytes. These are not measured physical disk reads. Node CPU/RSS figures
do not include the separate workerd service or `rg` child. Local experiment data occupy about
876 MiB; the isolated validation export is about 103 MiB. All artifacts were retained.

Not measured: deployed regional/network latency, Cloudflare billing, real R2 SQL ingestion/query
performance and freshness, Claude's interactive UI search latency, Linux/Windows performance,
or multi-user MCP authorization. R2 SQL operates on Iceberg tables and needs a staging catalog;
it does not directly query arbitrary gzip JSONL. The prototype's one-token/one-tenant deployment
is an evaluation boundary, not the Interlinked MCP Server's production identity model.

## Decision supported by this run

Keep JSONL authoritative and automation opt-in. Use direct/full-text scans for occasional agent
investigations; use an explicit bounded or compact SQLite index when repeated structured/token
queries justify the extra local storage. Preserve the existing database until its disposition
is explicitly chosen. The measured compact schema does not make SQLite free or unlimited.

For a future Cloudflare design, the tested R2-payload/bounded-DO-catalog split is a practical
starting point. Production work still needs MCP identity/authorization, durable upload queues,
reconciliation, query admission/budgeting and deployment measurements. Iceberg/R2 SQL remains
an analytics option pending actual catalog evaluation, not a prerequisite for preserving JSONL.

Primary references checked September 7, 2026:

- [Cloudflare Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [R2 SQL query API and Iceberg requirement](https://developers.cloudflare.com/r2-sql/query-data/)
- [R2 SQL string functions](https://developers.cloudflare.com/r2-sql/sql-reference/scalar-functions/)
- [SQLite external-content FTS5](https://www.sqlite.org/fts5.html#external_content_and_contentless_tables)
