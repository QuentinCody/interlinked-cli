# Offline metrics scoring and repository corpus

Measured 2026-09-05. This is an experimental structural profile, not an authorship detector or a validated ranking of software quality.

## Run the CLI

```bash
interlinked metrics score --cwd /path/to/repository
interlinked metrics score --cwd /path/to/repository --json
interlinked metrics score --cwd /path/to/repository --short
```

From this checkout, use `npm run dev -- metrics score ...`, or `node dist/index.js metrics score ...` after building.

The command performs local static analysis. It requires no model calls, embeddings, credentials, network access, dependency installation in the target, or target-code execution. Git discovery disables executable filesystem-monitor hooks. Syntax tokens are code units, not billed LLM tokens.

JSON reports individual scores, raw per-function measurements, physical file lengths, type-annotation diagnostics, measured and excluded paths, explicit measurement gaps, and source/profile hashes. The score is advisory; existing metric gates and baselines retain their existing contracts.

## Structural profile

The frozen definition is [score-profile.ts](../src/lib/metrics/score-profile.ts). This run uses `interlinked-structure-js-ts-v1`, TypeScript 5.9.3, and profile hash `e83ef9c1b2ac6a216b32e4815c509c37890597c05b673a59d721da25954e6e56`.

| Metric | Share | Raw value → normalized burden knots |
|---|---:|---|
| Cyclomatic complexity | 25% | 1→0, 5→0, 15→.25, 25→.60, 50→1 |
| Cognitive complexity | 25% | 0→0, 5→0, 15→.25, 30→.65, 60→1 |
| AST function tokens | 5/18 | 0→0, 150→0, 300→.20, 500→.50, 1000→1 |
| Halstead difficulty | 2/9 | 0→0, 20→0, 40→.25, 80→.65, 160→1 |

Interpolate between knots and clamp at the ends. Successfully measured functions with Halstead volume below 200 have zero difficulty burden. These are provisional policy choices, not coefficients fitted to the corpus or validated against expert assessments.

For each component, weight functions by exclusively owned syntax tokens. Combine 75% of the exposure-weighted mean burden with 25% of the worst-decile exposure-weighted burden, then multiply by 100. Include a fractional final function at the decile boundary. The structural composite uses the shares above. Lower means less measured structural burden.

Function size includes nested implementations; ownership assigns each token to its innermost implementation so aggregation does not double-count exposure. Parser-resolved tokenization handles templates, regexes and JSX. JSDoc is excluded from token and Halstead tallies. Ordinary comments and identifier length do not increase syntax-token counts. These units differ from the existing scanner-based edit-gate tokenizer; historical pilot scores are not directly comparable.

## Corpus results

The original pilot was expanded with projects selected before measurement from a GitHub search for nonarchived, nonfork TypeScript repositories with 100–180 stars, sorted by stars ascending. The added projects were chosen to vary application role. Star counts were captured on 2026-09-05; this is a purposive sample, not a representative estimate of GitHub.

All snapshots were clean, pinned to complete commit SHAs, and checked before and after measurement. The maintained corpus runner performed zero model calls and no target-code execution. Every row uses the same profile hash. The Interlinked row measures the public pinned repository, not the concurrently edited local checkout.

Component columns and the composite are on a 0–100 burden scale. Files/functions count successfully measured JS/TS source. Gaps are source paths without a supported structural measurement; any gap makes the result partial.

| Repository at measured commit | Stars | Cyclomatic | Cognitive | Size | Difficulty | Structural | Files/functions | Gaps |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| [mesqueeb/is-what](https://github.com/mesqueeb/is-what/tree/dadd235f03d201ffbd8fd73dcc5d1891d754fcd4) | 200 | 2.7 | 4.5 | 0.0 | 4.0 | **2.7** | 45/43 | 0 |
| [antfu/diff-match-patch-es](https://github.com/antfu/diff-match-patch-es/tree/4f35fb7fd57df68d69068cdee0780bb779f5497f) | 199 | 37.0 | 58.1 | 44.8 | 62.9 | **50.2** | 8/42 | 0 |
| [caderek/aocrunner](https://github.com/caderek/aocrunner/tree/7eaba95faa8708b4b0b9c79b0b3eaf13347ead57) | 199 | 10.2 | 14.2 | 22.9 | 15.4 | **15.9** | 36/83 | 0 |
| [sergiodxa/remix-auth-oauth2](https://github.com/sergiodxa/remix-auth-oauth2/tree/6e7bfd2a5741f5b04dafd4f9f57c83775936a39a) | 200 | 5.8 | 12.8 | 17.3 | 8.3 | **11.3** | 4/24 | 0 |
| [JNKKKK/pianochord.io](https://github.com/JNKKKK/pianochord.io/tree/568efa33124a034d131e787fd20c28b298780433) | 200 | 4.0 | 7.0 | 33.6 | 28.6 | **18.4** | 50/239 | 16 |
| [QuentinCody/interlinked-cli](https://github.com/QuentinCody/interlinked-cli/tree/a2d4e41fb1ccb0a6514e9e177170f0386e399f06) | 171 | 8.0 | 9.4 | 14.9 | 14.1 | **11.6** | 1519/15593 | 12 |
| [figma/vite-plugin-yaml](https://github.com/figma/vite-plugin-yaml/tree/2273c3f46fdfdb4de2dc9a273e8ee062e54dff35) | 100 | 0.0 | 3.3 | 0.3 | 2.3 | **1.4** | 6/7 | 2 |
| [jokull/python-ts-graphql-demo](https://github.com/jokull/python-ts-graphql-demo/tree/52d4fb5a9bf2143c7585fadc43bbaa574e59e3db) | 100 | 0.0 | 0.0 | 5.1 | 0.9 | **1.6** | 6/21 | 5 |
| [dcodesdev/LetterSpace](https://github.com/dcodesdev/LetterSpace/tree/5e9b3391bcae33ab9069b0821c3fce85a57c0e47) | 100 | 15.7 | 21.1 | 51.4 | 32.3 | **30.6** | 247/925 | 24 |
| [wobsoriano/solid-sonner](https://github.com/wobsoriano/solid-sonner/tree/4082d5e52074a846d5e139fcbeccb75addb6871b) | 100 | 20.3 | 27.5 | 41.4 | 28.3 | **29.8** | 19/254 | 7 |
| [mk12/vscode-better-git-line-blame](https://github.com/mk12/vscode-better-git-line-blame/tree/20528d8fadb681b5598cefc7b84b891583dc4643) | 100 | 27.0 | 35.4 | 28.6 | 16.3 | **27.2** | 1/67 | 0 |
| [gmickel/turborepo-shadcn-nextjs](https://github.com/gmickel/turborepo-shadcn-nextjs/tree/c1f19e41b36f84cd731d8a3a62b9ca5a7436b3d0) | 100 | 0.0 | 0.0 | 14.0 | 12.1 | **6.6** | 39/32 | 2 |

The range is 1.4–50.2. Four samples fall below 10, four in 10–20, two in 20–30, and two at 30 or above. Those are descriptive bins, not quality grades. Samples differ substantially in role and size, and partial rows describe only their measured functions.

The low score of the mixed Python/TypeScript demo applies to its measured JS/TS portion; it says nothing about its Python implementation. CSS/SCSS, GraphQL, shell and other unsupported source extensions remain explicit gaps. Current source classification also includes some executable configuration, examples and fixture trees. Classifying those roles consistently is further work before a cross-repository quality ranking.

[Machine-readable summary](metrics-score-corpus-2026-09-05.json) preserves unrounded component scores, distribution terms, source hashes, commit pins and measurement status. Full per-file/per-function reports from this session are in `scratch/2026-09-05-metrics-automation/results/`.

## Mutation testing uses computation, not LLM tokens

The earlier pilot used StrykerJS 9.6.1 to generate mutations mechanically and run existing tests under Node 22.22.0 with the Vitest runner. No LLM generated mutants or judged test outcomes. Agent setup and interpretation used model tokens; the measurement pipeline itself did not.

| Repository | Generated | Killed | Survived | No coverage | Timeout | Native mutation score |
|---|---:|---:|---:|---:|---:|---:|
| mesqueeb/is-what | 349 | 299 | 31 | 19 | 0 | 85.67% |
| antfu/diff-match-patch-es | 1,984 | 1,508 | 348 | 19 | 109 | 81.50% |

These are completed runs from the earlier pilot, not new mutation runs on the expanded corpus. Native Stryker scoring treats timeouts as detected. The experiment did not adjudicate every timeout or equivalent mutant, so it does not convert this native score into a qualified verification burden.

Coverage and mutation testing can be automated without an LLM, but require executing tests and consume CPU time. A static scan cannot infer those results. Deterministic test-smell and dead-code checks can emit candidates; general semantic claims such as “this test is useless” or “this abstraction is unnecessary” need a specified evidence contract.

## What the experiment improved

- Fixed a dead-import false positive caused by a tree-shaking comment inside a named import. The actual `is-what` scan now reports no dead import bindings. The broader dead-code census still includes tracked build output and must not be treated as a qualified redundancy score.
- Added isolated modules to `metrics arch`. The live scans now include all 44 source modules plus one executable configuration file for `is-what`, and six source modules plus two configuration files for the diff library. The JSON reports `graphVersion: 2`, retains the N² propagation-cost definition and adds `normalizedReach` with the N(N−1) denominator.
- Corrected token ownership around nested functions and parser-sensitive syntax in the new scoring adapter.
- Excluded JSDoc from code-size and Halstead measurements after the corpus exposed documentation-sensitive tallies.
- Preserved missing and unsupported evidence instead of converting it into a clean or worst-case score.

## Reproduce and extend

Clone the linked repositories and check out their pinned commits. Create a JSON manifest with this shape; paths resolve relative to the manifest file:

```json
{"repositories":[{"name":"owner/repo","path":"./repositories/owner__repo","commit":"FULL_40_CHARACTER_COMMIT_SHA","stars":100}]}
```

Then run the maintained source-repository utility:

```bash
node --import tsx scripts/metrics-corpus.ts --manifest corpus-manifest.json --out corpus-results
```

The runner refuses a mismatched commit or dirty snapshot, writes a report for each successful repository plus `corpus.json`, and exits nonzero if any repository fails. It does not clone repositories or install their dependencies. Add pinned rows to extend the corpus without model usage.

## Limits and next measurement work

`slopScore` remains null and `rankEligible` remains false. Behavioral verification, test integrity, architecture burden, correctness/security, type soundness, qualified redundancy and contract consistency still need complete scoring adapters. Physical lines, `any`, `unknown` and assertions are available as diagnostics; raw counts are not interchangeable with established defects. Normalized file size and top-level executable burden are also unscored.

Next work is to standardize source roles across collectors; ingest coverage/mutation reports with matching source and runner receipts; define finding denominators and duplicate ownership; and validate fixed scoring profiles against independent maintenance outcomes. None requires an LLM in the measurement path. Arbitrary software architecture cannot be fully judged from a deterministic warning count.

Validation for this iteration includes 97 passing focused tests, clean pinned corpus execution, an atomic CLI build, equality of built-CLI and source-runner JSON on the diff library, identical repeated corpus summaries, and rejection of a mismatched commit. Biome and both affected skill validators pass. The repository-wide typecheck currently reports errors in concurrently edited files outside this change; no clean whole-workspace typecheck is claimed.
