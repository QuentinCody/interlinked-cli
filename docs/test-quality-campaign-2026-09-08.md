# Test-quality campaign: September 2026

This report records the test-quality campaign and its September 8 stop-warning
review. Counts describe the captured runs, not a continuously verified repository.
Detailed local evidence remains under
`scratch/test-quality-checks/campaign-2026-09-07/`.

## Review and repairs

The September 7 baseline scanned 2,174 tracked test files and reported 531
findings across 285 files. Three Terra workers and the coordinating reviewer
adjudicated every baseline finding. The final ledger contains the same 531
unique `(file, check, line)` keys, with no missing or duplicate keys.

| Disposition | Findings |
| --- | ---: |
| Repaired | 139 |
| Intentional contract | 267 |
| Detector false positive | 125 |
| Pending review | 0 |

Repairs pin forwarded arguments and concrete results, restore shared state,
give duplicate cases distinct inputs or consolidate equivalent bodies, and
exercise exported behavior. A subsequent scan exposed an additional analytics
test gap: the foreign-project guard lacked coverage beside the foreign-tenant
guard. Both exact errors are now asserted, and all four focused tests passed.
That additional repair is outside the baseline's 531 findings.

The campaign changed 86 distinct test files in three commits:

| Commit | Concern | Test files |
| --- | --- | ---: |
| `1e675dd5` | Detector contracts and duplicate cases | 14 |
| `b11d47c0` | Shared-state restoration | 7 |
| `991bc788` | Assertions and integration fixtures | 65 |

The final batch also incorporates reviewed existing test adjustments for
concurrent API changes: removal of dead warning-drain cases, valid Python
write/read fixtures replacing malformed quotes, the Biome unavailable-result
shape, and removal of an obsolete global timer assertion. The associated
production changes remained with their originating work.

## Census and validation

The final census snapshot scanned 2,194 tracked tests and reported 409 findings
across 225 files, with no unreadable files (`census-completed.json`). This is
not a causal before/after experiment: the corpus, production source, and other
tests changed concurrently. The 409 warnings are not directly comparable with
the 392 retained baseline dispositions. They are not 409 established defects.
The fourteen test-discrimination checks remain advisory.

The final 65-file batch passed **2,941/2,941 tests**, with retries disabled,
using the exact staged test contents against the working production tree.
The compiler-host overlay reported zero diagnostics in those captured tests
and eight diagnostics in other physical working-tree files. Biome lint reported
zero diagnostics on materialized copies of all 65 staged files; their hashes
matched the capture. Unsuccessful stdin/no-files lint attempts were excluded
from that verdict. The final commit's test contents also matched the capture.
Relevant artifacts are `staged-test-blobs-v3.json`, `validation-staged-v3.json`,
`staged-overlay-typecheck-v3-report.json`, and `staged-blob-biome-v3-summary.json`.

This validation does not establish that a checkout of the test commits without
the concurrent production changes is green. Earlier detector and isolation
batches were checked separately. Two read-only fault probes showed that repaired
tests reject swapped exported bindings and bypassed TypeScript-load caching
that the original tests accepted. These are specific discriminatory improvements,
not a measured mutation score.

The canonical `npm run dev -- verify --all-checks --json` run scanned 4,325 files
and was not clean: 144 TypeScript issues, three Biome warnings, and five dependency
vulnerabilities (two high, two moderate, one low). Semgrep and Gitleaks reported
zero findings; project setup and registry parity reported zero issues. The 106
`test_regressions` entries were static findings, not executed failing tests.
`npm run docs:check` passed separately. The later compiler-host count of eight
describes a different snapshot, not a rerun of the complete canonical pipeline.

## Stop-warning review

The reported `pre-tool-coverage-gates.ts` regression did not reproduce in the
September 8 recheck. Three coverage-gate test files passed 75 tests with retries
disabled (`stop-coverage-regression.log`). A subsequent visible main-companion
run passed 46 tests. The live session then recorded the test as passing at step
36 and its source cycle as `green`; the historical trajectory retained the
earlier failure at step 1006. No source edit or manual evidence rewrite was
needed for that recheck.

Two workaround signals remained in the fingerprint archive. Their records retain
only detector/rule pairs, so the exact later tool actions cannot be reconstructed
from those records alone. Neither signal was suppressed or deleted.

A concrete interpreter-write guard defect is supported by activity record
`exec-9e04996e-d970-48e5-88dc-9d84d912b4ed`, September 7 at 21:49:34 UTC.
The rejected program writes the scratch file `worker2-worker3-owned-selection.json`
through a constant path variable. A tracked test filename is a JSON key, but the
guard reports that filename as the source write target. This conflates a data
value with the filesystem sink. The subsequent work used reviewed edit/patch
tools. A guard regression should distinguish a constant scratch sink from a
tracked source sink without weakening detection of actual source writes. The
available records do not identify which later candidate produced the signal.

The commit block at September 7 21:30:53 UTC,
`exec-8096aac8-e2a1-4e50-8c6c-0311620cba98`, cites the coverage-gate failure at
step 1006. Current passing evidence resolved that prerequisite. The sparse
workaround record does not establish whether its later signal represented a
verified retry or a different action; both signals are not declared false positives.

The source CLI's `harness capabilities --json` was inspected and
`harness coverage verify --json --no-wait` started daemon job
`1681317d-dbbf-46a5-a5af-af2f43edb51c` with 832 pending versions. At the recorded
progress snapshot it was still running; this report makes no final-verdict claim.
Unmeasured reasons included absent optional package-manager lockfiles and
affected-test timeouts. Concurrent writes can add or supersede pending versions.
Writer identity remained unknown where evidence reported unknown. No policy was
accepted or pending version manually acknowledged to clear the warning. The
disabled per-edit coverage gate was not represented as measured or passing.

## Skill impact

This campaign repairs tests and records evidence. It changes no CLI, harness
policy, configuration, or operator contract, so no source skill update is needed.
The local ledger, captures, and generated logs remain ignored working artifacts.
