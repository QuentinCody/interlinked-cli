# Pinned repository calibration — September 8, 2026

The composite implementation was exercised against **24 repositories**, each with
100–200 GitHub stars when checked at 11:01 UTC. Eighteen belong to calibration and
six were held out. Twelve retain earlier pilot pins; twelve additional TypeScript
repositories were selected before inspecting their scores. This is a purposive
sample, not a representative survey. The manifest retains full commit SHAs.

Weights and burden curves were held fixed. Calibration corrected measurement
errors involving aliases, missing type bindings, type-only imports, framework
entry points, private declarations behind barrels, truncated detector output,
ignored directories and incomplete coverage locations. Measurement revision
`2026-09-08.1` was run from an isolated archive of CLI commit `596174b1`.

## Static distribution

| Cohort | Repositories | Observed burden: min / median / max | Evidence completeness: min / median / max |
| --- | ---: | --- | --- |
| Calibration | 18 | 0.02 / 13.13 / 26.12 | 42.11% / 52.63% / 68.42% |
| Held out | 6 | 6.38 / 16.21 / 32.38 | 52.63% / 52.63% / 63.16% |

All reports are provisional: **none has a complete composite ranking**. Observed
burden describes the measured part of the profile. Different missing evidence
prevents treating these values as complete repository rankings. Completeness is
the measured fraction of applicable scoring weight, not line coverage. The
Interlinked CLI corpus entry is a historical pin, not the current checkout.

The static corpus executed no target code, installed no target dependencies and
made no model calls. Missing coverage, mutation results, type dependencies and
supported parsers remain visible gaps. A larger sample alone cannot establish
universal quality percentiles without independent review labels, representative
selection and comparable measurement policies.

## Existing-test behavioral pilots

Two dependency-free libraries were also measured in disposable copies using their
existing tests, Vitest 4.1.8, V8 coverage and Stryker 9.6.1. The declared ES2022
transform avoids loading an unavailable shared tsconfig. These pilot environments
do not reproduce each project's CI configuration.

| Repository | Requested mutation scope | Killed | Survived | No coverage | Timed out |
| --- | --- | ---: | ---: | ---: | ---: |
| [mesqueeb/is-what](https://github.com/mesqueeb/is-what) | `src/**/*.ts` | 299 | 31 | 19 | 0 |
| [antfu/diff-match-patch-es](https://github.com/antfu/diff-match-patch-es) | `src/{match,options}.ts` | 95 | 40 | 1 | 7 |

Stryker generated **492 mutants**, with all operators enabled. Timeouts were not
counted as kills. Reported mutation-file counts were 42 and 1 respectively:
unreported files were not treated as proven zero-mutant files.

For diff-match-patch-es, measured line/branch/function coverage was approximately
99.29% / 97.35% / 100%. Surviving mutants were 29.63% of killed-or-surviving mutants
in the requested subset. High execution coverage therefore did not establish
strong assertion discrimination. Coverage evidence raised profile completeness
to 84.21%; missing mutation files, uncovered sites and timeouts still prevent ranking.

For is-what, reported coverage was 57/64 executable lines, 77/81 branch outcomes
and 40/43 functions. One eligible product file was absent, so these ratios remain
partial. Three eligible product files were absent from mutation evidence, and
19 mutants lacked coverage. Its full ranking also remains unavailable.

Coverage runs took about 3 seconds each; mutation runs took 17.4 and 10.3 seconds.
These timings include isolated execution and depend on machine load. There were
**zero LLM calls**; mutation generation and test execution still consume CPU time.
Survivors identify review candidates, not proof that the code can be deleted.

## Artifacts and reproduction

- [Portable manifest](../benchmarks/results/metrics-corpus-2026-09-08/manifest.json):
  clone each named GitHub repository into its manifest-relative `repositories/`
  path and check out its exact commit. Dirty or incorrectly pinned clones fail.
- [Summary and checksum](../benchmarks/results/metrics-corpus-2026-09-08/summary.json).
- [Compressed reports](../benchmarks/results/metrics-corpus-2026-09-08/reports.tar.gz):
  individual scores, corpus summary, reviewed catalog, behavioral receipts and
  original coverage/mutation artifacts. Receipts retain original runner paths
  and report roots; create a new receipt when rerunning elsewhere.

```bash
interlinked metrics corpus benchmarks/results/metrics-corpus-2026-09-08/manifest.json \
  --out scratch/corpus-rerun --json
node --import tsx scripts/metrics-corpus-behavior.mts <separate-library-copy> \
  <output-directory> coverage
node --import tsx scripts/metrics-corpus-behavior.mts <separate-library-copy> \
  <output-directory> mutation 'src/**/*.ts'
```

The pilot launcher copies the selected library into a disposable execution
workspace and uses the CLI checkout's installed test tools. It stores evidence in
the selected library copy; use separate copies to preserve clean corpus clones.

Held-out results did not tune weights or thresholds. Regression tests cover
comment padding, fake generated markers, missing imports, saturation, unsupported
source, stale receipts and overlapping penalties. These constrain specific
failure modes; ratio-based scoring is still susceptible to denominator padding
and role-policy abuse, so the complete scope and findings remain reviewable.

