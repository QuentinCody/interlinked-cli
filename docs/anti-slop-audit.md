# Anti-slop audit qualification — 2026-09-22

The focused profile adopts two complementary detectors as an **audit**, with the
existing imported-lint runner and baseline. It adds no native daemon checks,
Effect policy, blanket module-mocking ban, or default-gate promotion.

## Reproducible inputs

- Upstream: `dmmulroy/anti-slop`, commit
  `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.
- Host/runtime: `oxlint@1.85.0`, `@oxlint/plugins@1.85.0` (exact matching pins).
- Generic source is vendored with reporting-helper extraction in
  `no-known-value-widening.ts` to meet the repository's function-size cap;
  Effect files are omitted. `tools/oxlint/anti-slop/UPSTREAM.json` retains
  upstream hashes and records local adaptations separately.
- Census: all 18 generic rules at warning severity, correctness defaults off,
  4,370 source files from a fixed copy of the current `src/` tree. Tests are
  included in the total. The production column excludes `__tests__/` and
  `.test.`/`.spec.` paths; it is a path classification, not a semantic category.
- The snapshot is a working-tree copy, not a clean commit. Its per-file hashes
  are in `scratch/2026-09-22-anti-slop/snapshot/source-sha256.json`.
- Complete raw report: `scratch/2026-09-22-anti-slop/research-snapshot.json`;
  SHA-256 `58ec31158f2364c1812689e05eb955edf41065c151ba168962b8f7d6dffeb92f`.
  The snapshot was run outside the repository's ignored scratch directory;
  the temporary config preserved every rule and used an absolute plugin path
  with no ignores. Only its copied `src/` was scanned.
- Oxlint reported `start_time: 4.33054275` and 12 threads. This is one execution,
  not a latency distribution or a claim about per-edit cost.

## Per-rule disposition

Counts are actual analyzer diagnostics, not grep counts, true-positive counts,
or counts of unique bugs. The upstream author’s taste is not our policy.

| Generic rule | All src | Production paths | Decision |
| --- | ---: | ---: | --- |
| no-array-filter-map | 75 | 65 | Research only; no demonstrated bug class or promised speedup |
| no-reduce-accumulator-copy | 0 | 0 | Focused audit; adds non-spread copies beyond our spread check |
| no-chained-type-assertions | 83 | 19 | Research only; broader ban than overlap-aware smuggling checks |
| no-conditional-empty-object-spread | 487 | 419 | Retain existing native advisory; upstream semantics differ |
| no-known-value-widening | 1,071 | 622 | Research only; legitimate extension/return contracts are flagged |
| no-module-mocking | 1,669 | 0 | Observe only; baseline capability tested, no new policy imposed |
| no-object-parameters | 32 | 13 | Research only; partial overlap with existing broad-object checks |
| no-reflect-apply | 8 | 0 | Research only; blanket reflection restriction unqualified |
| no-reflect-get | 32 | 13 | Research only; blanket reflection restriction unqualified |
| no-runtime-typeof | 2,496 | 1,991 | Reject as policy; legitimate boundary narrowing |
| no-shape-in-symbol-names | 478 | 333 | Reject as policy; arbitrary vocabulary restriction |
| no-unknown-parameters | 1,602 | 1,109 | Reject as blanket policy; unknown is useful at boundaries |
| no-unknown-returns | 160 | 73 | Research only; boundary contracts need case-specific review |
| no-unknown-type-aliases | 0 | 0 | Retain existing native advisory; no duplicate adoption |
| no-unsafe-dictionary-type | 773 | 247 | Reject blanket policy; unknown-valued dictionaries can be valid |
| no-widen-then-assert | 0 | 0 | Focused audit; adds cross-statement evidence-loss detection |
| require-readable-spacing | 67,867 | 37,794 | Reject additional spacing policy; keep formatter ownership |
| require-safety-comment-for-type-assertion | 27 | 9 | Existing native comment requirement; equivalence is not exact |

For example, the widening rule reports `headers: Record<string, string>` in
`src/harness/replay/candidate-runner.ts`, where the implementation subsequently
adds an optional authorization header. It also reports the open-dictionary return
contract of `forwardHeaders` in `src/harness/replay/inference-proxy.ts`, which
constructs headers from request keys. These are legitimate extensible contracts;
removing their breadth indiscriminately would not improve the program.

Upstream's widening detector uses syntax and local scope/alias information,
not the TypeScript checker. It can still be useful on its supported cases;
cross-file semantic equivalence requires stronger evidence than its rule name.

## Qualification and integration

`lint-anti-slop.integration.test.ts` runs the actual vendored plugin and installed
host through Interlinked's imported runner. It verifies non-spread copying via
`Object.assign({}, acc, item)` and `acc.concat(item)`, while accepting mutation
of the reducer's local accumulator. It exercises widening then assertion,
plugin dependency fingerprints, warning-only results, and audit cadence.

The module-mocking fixture proves the existing baseline can adopt current debt,
retire a fixed occurrence, and report reintroduction without a native mock counter.
It accepts a shadowed local `vi.mock`, exercising the upstream scope distinction.
This capability test does not make module mocking a repository policy.

The focused two-rule audit produced a complete imported measurement with zero
findings and seeded an empty baseline. Both rules have positive fixtures; a quiet
tree alone did not qualify them. They remain audit-only pending representative
cross-repository review, precision/coverage measurement and latency qualification.
No automatic fixes are enabled: mutation of an accumulator is safe only where
ownership and callback behavior permit it.

The old standalone `verify` row discarded successful Oxlint output. It now parses
exit-zero warnings, with regression coverage. The imported runner already had the
correct warning behavior and stricter unavailable/truncation handling.

`lint import --only-selected` was added to prevent this experiment from enrolling
unrelated discovered linters. It retains previously adopted profiles, applies
cadence only to explicit selections, and leaves the original broad import mode
unchanged. The source closure still fingerprints the plugin's local imports and
package/lock context; changes require reviewed re-import.

Commands and baseline semantics: [lint adoption](lint-adoption.md).
The all-18 census exceeds 10 MiB and stays a raw report outside the imported
capture path. A truncated or unavailable run is not evidence of zero findings.
The research config is never imported by this change.

## Skill impact and deferred work

Updated the source `interlinked-verify` skill for selective audit adoption and the
`interlinked` router for its discovery. Installed `.agents/skills/` copies are not
the source of truth. No quality-cap values or baseline direction rules changed.

Jev work remains deferred in `docs/design/jev-semantic-typescript-review.md`.
No inference call or new semantic review implementation belongs to this change.
