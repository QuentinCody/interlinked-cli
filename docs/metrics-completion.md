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
as `2d4bc02f` and `68a03cda`; final isolated validation and agent guidance follow
after CLI integration. Repository-wide type checking currently encounters separate
concurrent edits; those failures are not counted as passing checks.

Stage 3: strict Istanbul and Stryker-style readers, hashed receipts, stale-input
detection, bounded isolated execution, cancellation and content-matched resume
implemented. Regression tests exercise real child-process assertions, artifact
tampering, test-only edits, fixture edits, mutation source mismatch and timeouts.
Dependency identity records manifests/lockfiles; it does not attest an unmodified
host or install packages. Imported CI receipts preserve their asserted origin.
