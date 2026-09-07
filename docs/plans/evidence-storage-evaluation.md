# Evidence storage and search evaluation

Status: local implementations and comparisons completed, 2026-09-07. Live R2 SQL and deployed
cloud measurements await a staging catalog/account. See the
[measured results and limits](../benchmarks/evidence-storage-2026-09-07.md).

## Objective and constraints

Retain original JSONL evidence indefinitely while making agent investigations practical on
developer machines and in a future multi-tenant Cloudflare Interlinked MCP Server. Compare
implementations before changing the default. Existing logs, archives, native transcripts and
the existing SQLite database remain untouched. Experiments write to new, private directories.
No real log payloads are uploaded. Cloud runs require a configured staging destination;
local Workers runtime measurements are labeled separately from deployed service measurements.

## Implementations

1. Direct JSONL scan, with structured filters and deterministic result ordering.
2. Direct gzip scan, preserving the same records and query semantics.
3. Native Claude transcript reader: original record references, provider/session/actor/tool
   identities, and explicit metadata-only versus searchable-content coverage.
4. Existing SQLite schema and FTS5 implementation, retained as the baseline.
5. Compact SQLite using external-content FTS5, one text copy, and smaller identifiers.
6. Bounded compact SQLite: explicit database allocation limit, reported partial coverage,
   and direct-scan fallback for a complete answer. No raw-record eviction.
7. Partitioned compressed evidence with small manifests, tenant/project isolation,
   content hashes, bounded partitions, selective scans and original-record retrieval.
8. Cloudflare Worker/R2/Durable Object implementation of the partitioned path, exercised
   under the local Cloudflare runtime and deployable to an explicitly selected staging project.

R2 SQL/Iceberg is a separate analytics candidate: implement a configurable API evaluation
adapter and contract tests, and record it as unmeasured without a provisioned catalog.
Do not describe local object-storage tests as R2 SQL performance measurements.

## Common contract

All comparable engines receive the same frozen input and queries. Portable search uses
case-insensitive literal terms (AND), exact dimensions, inclusive event-time bounds,
stable IDs, and deterministic ordering. Backend-specific FTS grammar/ranking is measured
separately, never scored as equivalent to literal matching. Results expose the scanned or
indexed scope, omitted/malformed/incomplete records, and whether the answer is complete.
Original record retrieval verifies SHA-256. Missing capture never becomes evidence of absence.

Raw source snapshots retain exact complete record bytes. Manifests record source, byte
length, hash, sampling bounds and capture scope. Native transcripts and Interlinked logs
are separate corpus lanes; their total sizes are not treated as equivalent information.

## Evaluation

- Seeded synthetic corpora: multiple tenants/projects, actors, sessions, providers, Unicode,
  punctuation, repetitive and varied payloads, missing fields, undated records and duplicates.
- Bounded frozen samples of actual Interlinked streams and native Claude transcripts, kept local.
- Independent expected-answer fixtures for exact filters, literal search, boundaries,
  pagination and empty results; compare full matching-ID sets before measuring speed.
- Measure build wall/CPU time, first-query and repeated p50/p95 latency, source/compressed/index
  bytes separately, process peak RSS, query bytes/partitions read and indexed coverage.
- Measure incremental append, reopen/restart, duplicate replay, limited-disk behavior,
  partition rollover, corrupt/truncated data, hash mismatch and cross-tenant access refusal.
- Preserve raw timing samples, environment/version/source hashes and exact commands. Use
  fresh processes for engine runs. First query is not described as an OS-cold-cache test.
- Run meaningful unit/integration regressions, typecheck and build; validate affected skills.

## Operational integration

Expose explicit CLI engine selection, snapshot/build/search/show/benchmark workflows, and
JSON reports. Keep capture, lossless rotation and indexing independently configurable.
Changing an experimental index must never modify the existing production index implicitly.
An index disk limit must reserve journal/temporary headroom; per-pass ingestion budgets are
not a disk limit. On capacity exhaustion stop indexing and report coverage, preserving logs.

## Decision and handoff

Publish measured results with per-corpus tradeoffs, correctness failures and limitations.
Recommend defaults from the results, without silently enabling an unbounded index. Future
remote retention and removal of local replicas remain separate policy decisions.

Cloudflare's paid-plan SQLite limit is 10 GB per Durable Object, so partitions must roll over
well below that boundary. R2 holds original compressed evidence; Durable Objects hold bounded
coordination/catalog state. Search correctness and authorization span the partition boundary.

References checked 2026-09-07:
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/r2/
- https://developers.cloudflare.com/r2-sql/
- https://www.sqlite.org/fts5.html#external_content_and_contentless_tables
- https://code.claude.com/docs/en/claude-directory
