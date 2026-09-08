# Metrics completion implementation

This work completes the deterministic metrics pipeline in dependency order.
The existing inclusive 500 syntax-token gate and over-limit hold-or-shrink
behavior remain the measurement contract. Oversized-function cleanup is deferred.

## Ordered stages

1. Catalog every metric, content check, external check, and session guard;
   establish shared source roles, units, denominators, and measurement states.
2. Add scoring adapters for file size, behavioral evidence, test integrity,
   redundancy, types, architecture, and correctness/contracts.
3. Bind behavioral evidence to source, tests, configuration, dependencies,
   runner identity, execution outcome, and artifact hashes; support bounded runs.
4. Join deletion evidence and correct unsupported mutation conclusions.
5. Publish an explained, versioned composite with explicit ranking eligibility.
6. Expose catalog, explanation, comparison, corpus, and evidence workflows in
   the CLI; record actual coverage execution and benchmark incremental work.
7. Expand the pinned corpus and test stability, exclusions, and gaming cases.
8. Standardize syntax-token terminology and complete documentation and skills.

## Completion evidence

Each stage requires focused regression tests and a reviewed change. Final
validation includes type checking, CLI behavior, build, generated references,
skill validation, and pinned corpus results. An unavailable measurement is not
a passing measurement; a surviving mutant is not proof that code is dead.

Stage 1: shared source-role inventory, explicit measurement states, registry-derived
catalog and reviewed-registry fingerprint implemented. Focused inventory/catalog
regressions cover test-only hash changes, symlink gaps, temporary fixtures,
unsupported source languages, source-role spoofing, and complete registry coverage.

Stage 2: structural, behavioral, test-integrity, duplicate/dead-store/reachability,
typed-operation, import-architecture and declarative-contract adapters implemented.
Eleven catalog/inventory/adapter tests passed. The initial two stages are committed
as `2d4bc02f` and `68a03cda`. Final validation and agent guidance are recorded below;
validation uses committed snapshots because the shared working tree has concurrent
edits. Failures in that changing tree are not counted as passing checks.

Stage 3: strict Istanbul and Stryker-style readers, hashed receipts, stale-input
detection, bounded isolated execution, cancellation and content-matched resume
implemented. Regression tests exercise real child-process assertions, artifact
tampering, test-only edits, fixture edits, mutation source mismatch and timeouts.
Dependency identity records manifests/lockfiles; it does not attest an unmodified
host or install packages. Imported CI receipts preserve their asserted origin.

Stage 4: survivor wording now distinguishes weak tests from inert code and requires
exact source sites for paired polarities. Joined deletion candidates remain
advisory. Isolated removal trials require passing baseline and candidate tests
plus type checking. Sixteen focused tests passed; committed as `689c9402`.

Stage 5: `interlinked-slop-v1` distributes 100 points across bounded groups,
explains each metric, and reports observed burden, missing-evidence bounds and
ranking eligibility separately. CRAP and uncovered mutation sites remain
diagnostics. Twelve adapter/composite/report tests passed. The following stages
complete CLI integration, operational coverage evidence, corpus calibration and
agent guidance.

Stage 6: the CLI now exposes score profiles, catalog, explanation, comparison,
corpus, behavioral evidence, deletion validation, gate reach and coverage-index
operations. The Vitest index validates full-report parity, replaces changed
test contributions, invalidates dependencies/configuration/discovery/environment,
and promotes a staged generation only after its source fingerprint is on disk.
Content-addressed blobs and locked generation checks preserve accepted evidence.
Coverage churn under identical inputs quarantines reuse until three full runs agree.
Unsupported capture degrades visibly; it does not authorize a guessed coverage block.
Full warm runs also produce source-bound scoring evidence. Failed or cancelled
attempts prevent an older passing receipt from silently satisfying resume/ranking.

The combined metrics/index/gate regression run passed 341 tests in 25 files.
The final receipt/stability integration checks passed five tests in three files.
`npx tsx benchmarks/metrics-coverage.mts` measured eight controlled test files:
median incremental wall time 668 ms versus 1,997 ms for full runs (three samples).
Each incremental run executed one test file while retaining coverage for all eight.
This fixture demonstrates the mechanism; it does not establish this repository's
full-suite cost. The local per-edit gate remains explicitly disabled pending an
acceptable full-suite warm run. At the September 8 snapshot, the historical ratchet
knew 1,565 of 2,004 eligible files (78.1% reach); no per-edit execution journal existed.
Those figures describe measurement reach, not the fraction of source lines tested.

Stage 7: expanded to 24 pinned repositories with 100–200 observed stars, including
six held out. Fixed-profile calibration corrected scope, alias, type-binding,
entry-point and real coverage-format errors. Existing tests in two libraries
evaluated 492 generated mutants; missing files, survivors, uncovered sites and
timeouts remain distinct. The archived committed source passed TypeScript and
404 focused tests. Portable manifests, hashed reports and reproduction details
are in [the calibration report](metrics-corpus-2026-09-08.md). No model calls were
used for these measurements. Full composite rankings remain withheld wherever
evidence is incomplete.

Stage 8: [the scoring contract](metrics-scoring.md) now documents the 23 metrics,
versioned composite, source roles, missing-evidence bounds, evidence provenance,
deletion trials, incremental coverage and compatibility profile. Public guidance
uses syntax tokens for parser-counted source units and distinguishes them from
embedding-model tokens. The inclusive 500-token gate and hold-or-shrink semantics
are preserved; no embedding model or model calls are required for enforcement.
Six source skills were updated and validated: the router, quality gates, semantic
index, simplification, observability and verification. Generated CLI help includes
every nested metrics command and matches regeneration from committed source.

## Final validation and integration

All eight implementation stages are complete. An immutable archive of committed
snapshot `cfc89599` passed `npm run typecheck`, `npm run build`, and 535 focused
tests across 37 files covering metrics, evidence, coverage indexing, gates and
the integrated recovery controls. A separate generated-document freshness run
passed 16 tests. All six affected committed skills passed the skill validator.
The built and source CLI produced identical score JSON for the pinned
`antfu/diff-match-patch-es` checkout, including zero model calls. This is focused
validation, not a claim that the entire repository test suite ran.

The documentation commit `e45d6b50` also included concurrently staged harness
recovery files after a staging check failed and the commit incorrectly proceeded.
Those changes were preserved because subsequent commits already depended on them.
Commits `7e1ef385` and `cfc89599` repaired callback placement and fixture contracts;
the combined committed snapshot is the one validated above. Subsequent commits
used explicit file scopes. Unrelated working-tree changes remain with their owners.

Operational limits remain visible: this repository's local per-edit coverage gate
is still disabled pending acceptable full-suite warm-run cost; the shared harness
did not confirm the final pending-version verification request, so it is recorded
as unmeasured. Neither condition is presented as passing coverage. The corpus
contains provisional observations rather than complete repository rankings, and
deletion candidates still require review. Reducing existing oversized functions
is intentionally deferred to the separately authorized future campaign.
