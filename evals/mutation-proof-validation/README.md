# prove-kill foreign validation — round 2 (BLOCKED before execution)

Run date: 2026-11-04 (scheduled cloud run, branch `cloud/foreign-validation`, base `origin/mutation-proof`).

## Status: corpora authored and statically verified; NOTHING executed

Installing the foreign repositories' dependencies was refused by this
environment's permission classifier ("Code from External"), both
`corepack pnpm install --frozen-lockfile` and the `--ignore-scripts` variant.
Without `node_modules` no suite and no `prove-kill` run can execute, so:

- **suite green / n/N tests / suite wall time: NOT MEASURED** for every repo
- **results.json: none** — there are no verdicts, matches, DIFFs or timings
- **No claim below is "Verified" except the static corpus checks.**

What *was* done and verified:

- 6 repositories (6 distinct owners, none unjs/antfu/tinylibs) cloned at
  pinned shas, licence and vitest presence checked from `package.json`/`LICENSE`.
- 78 faults authored (13 per repo: 8 expected-killed, 3 expected-survived,
  2 expected-inconclusive) from source + README only; test bodies were NOT read
  (only test file *names* were listed to fill `tests`).
- `authoring/build.py` checked every fault: `find` occurs exactly once
  (Python `str.count`), `find != replace`, every `tests` path exists. 78/78 pass.

## Repositories

| repo | sha | lang | licence | vitest (declared) | lockfile | src lines | status |
|---|---|---|---|---|---|---|---|
| sveltejs/zimmerframe | 89c2d8dd | JS (ESM) | MIT | ^3.2.4 | pnpm | 190 | corpus ready, not run |
| sveltejs/esrap | 6c01c1ad | JS (ESM) | MIT | ^2.1.1 | pnpm | ~3.6k | corpus ready, not run |
| mesqueeb/is-what | 864e944a | TS | MIT | ^5.0.3 | pnpm | 521 | corpus ready, not run |
| natemoo-re/ultrahtml | 815c67cb | TS | MIT | ^4.1.10 | pnpm | 1,436 | corpus ready, not run |
| fb55/entities | 962c9f73 | TS | BSD-2 | ^5.0.5 | npm | 2,276 | corpus ready, not run |
| bombshell-dev/clack | 90536254 | TS, pnpm workspace (no root vitest config; per-package `vitest run`) | MIT | per package | pnpm | 5,741 | monorepo candidate; corpus targets `packages/core`; may come back `unavailable` |

Note: zimmerframe and esrap are both owned by `sveltejs`; if strict
one-owner-per-repo is required, swap one for `mswjs/headers-polyfill`
(b02d043, vitest, 512 src lines, cloned, no corpus yet).

Dropped / not selected (static reasons, no execution):

| repo | reason |
|---|---|
| Rich-Harris/magic-string | `pretest: pnpm run build` — needs a build before tests |
| molefrog/wouter | `bun test`, not vitest |
| nanostores/nanostores | test script is not vitest |
| kentcdodds/match-sorter | `kcd-scripts test` (jest) |
| pmndrs/zustand | vitest but not chosen (backup) |
| tsconfck/tsconfck, dominikg/tsconfck | clone failed (repo path not public / moved) |

## Expected-class totals (predictions only)

| class | per repo | total |
|---|---|---|
| killed | 8 | 48 |
| survived | 3 | 18 |
| inconclusive | 2 | 12 |

## Observation to test first when execution is allowed

The six repos declare **vitest 2, 3, 4 and 5**. Round 1 covered fewer
majors; prove-kill parses vitest's JSON reporter and records the vitest
version, so a reporter-shape difference across majors (esrap on v2, is-what /
entities on v5) is the most likely source of a prove-kill defect (class c) or a
blanket `unavailable`. The clack corpus additionally tests the monorepo path
(`--cwd` = workspace root, tests under `packages/core`).

## How to run (once dependency installation is permitted)

```
cd /tmp/foreign/<owner>-<repo> && corepack pnpm install --frozen-lockfile   # npm ci for fb55-entities
npx vitest run            # record n/N + wall time (clack: cd packages/core first)
cd <interlinked clone> && npx tsx evals/mutation-proof-validation/run-corpus.mts \
  "$PWD" /tmp/foreign/<owner>-<repo> evals/mutation-proof-validation/<owner>-<repo>/corpus.json \
  evals/mutation-proof-validation/<owner>-<repo>/results.json
```

Then classify every DIFF as (a) wrong prediction, (b) product-code crash
classified `inconclusive` by rule, (c) prove-kill defect.
