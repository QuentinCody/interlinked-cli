# Independent verification of `mutation-proof` @ af8b93d3

Verifier: cloud session (Linux 6.18, 4 CPU, 16 GB, Node v22.23.4, vitest 4.1.11, user `root`),
branch `cloud/verify-af8b93d3` from `origin/mutation-proof`. Head verified:

```
af8b93d3ca9ef4989761936a1fab3759e50394e6 merge cloud/own-check-property-tests: C38 property-based test failures count as the test own check (one shared rule)
```

Every result below is for a command this session ran. Nothing in the tree was changed except this file.
`origin/main` at the time was `1098556 ci: allow broad test comparisons to finish on slower runners`;
merge-base with the branch is `5b1b2d4d`. `origin/main` is NOT an ancestor of af8b93d3.

## 0. `npm ci` — exit 1 (environment, pre-existing)

`npm ci` installs cleanly but its `prepare` script (`npm run build && npm run setup-hooks`) fails in
tsup's DTS worker:

```
Error [ERR_WORKER_OUT_OF_MEMORY]: Worker terminated due to reaching memory limit: JS heap out of memory
Error: tsup failed (exit 1)
npm error command sh -c npm run build && npm run setup-hooks
```

Plain `npm run build` reproduces it on this box (exit 1, same OOM) **and on `origin/main` in a separate
worktree** (`main plain build exit=1`, 2 OOM lines), so it is not a branch regression. With
`NODE_OPTIONS=--max-old-space-size=8192` the build succeeds (`build exit=0`). Every build below used that
flag; nothing else was changed.

## 1. `npm run typecheck` — exit 0

```
> tsgo --noEmit && tsgo --noEmit -p landing/tsconfig.json
typecheck exit=0
```
No errors printed.

## 2. Build + CLI help — all exit 0

- `npm run build` (with the heap flag): `build exit=0`, `dist/index.js` and `dist/harness/server.js` present.
- `node dist/index.js --help | head -5` → `Usage: interlinked [options] [command]` … exit 0.
- `node dist/index.js tests prove-kill --help` → prints `--test/--mutant/--file/--find/--replace/--run-timeout/--timeout/--vitest-config/--cwd/--json`, the example commands, and
  `Exit codes: 0 killed; 1 survived or not-passing-now; 2 inconclusive, unavailable or a bad argument.` exit 0.
- `node dist/index.js tests kill-proofs --help` → `--verify`, `--cwd`, `--json`;
  `Freshness (with --verify): FRESH, UNCOMMITTED (…), STALE (re-run prove-kill).` exit 0.
- There is **no `--all-survivors` flag** on this head: `grep -rln -- "all-survivors" src scripts docs` is empty and
  `tests prove-kill --all-survivors --test test/clamp.test.ts` prints `error: unknown option '--all-survivors'`, exit 2.

## 3. Docs — clean

```
npm run docs        → 8 reference docs generated from code.            exit 0
npm run docs:check  → docs OK (124 rules · 7 runners · 3 modes · Node 22+ · 911 verified blocks / 3834 logged)   exit 0
git status --porcelain → (empty)
```
The only note was `[docs:warn] data_as_of is 65 days old (>30 day threshold)`, a hand-edited landing-page marker
that is not generated and not a failure.

## 4. Full suite — `npx vitest run --reporter=dot` — exit 1

```
 Test Files  32 failed | 3028 passed | 3 skipped (3063)
      Tests  51 failed | 66623 passed | 4 expected fail | 36 skipped | 5 todo (66719)
     Errors  2 errors
   Duration  781.83s
```

Classification method. (i) The 32 failing files were re-run in isolation on the branch: still
`32 failed (32)`, `53 failed | 768 passed`, so none is a load flake. (ii) The same 32 files were run in a
fresh `git worktree add /tmp/main origin/main` + `npm ci --ignore-scripts`: `31 failed | 1 passed`,
`61 failed | 761 passed`. (iii) `git diff --name-only <merge-base>..HEAD` touches **none** of the 32 test
files nor their subject modules.

**31 of 32 files fail identically on `origin/main` → class (a).** Of those, 24 files (all of
`src/lib/*`, `src/commands/doctest`, `managed-push`, `hooks-installation`, `project-compiler-gate`, and the
`unreadable`/`permission`/`read-only`/`EACCES`/`umask` titled tests in harness) are **also (b) root-only
fixtures**: they `chmodSync(…, 0o000|0o500)` and expect a read/write/unlink to fail, which never happens as
root. Representative first assertions:

- `src/commands/doctest.test.ts:91` — `expected [ 'README.md', 'blocked/hidden.md' ] to deeply equal [ 'README.md' ]`
- `src/lib/file-mutation-lock.test.ts:679` — `expected [Function] to throw an error … toThrow(/EACCES|EPERM/)`
- `src/harness/daemon-pid-ownership.test.ts:38` — `expected true to be false` after `chmodSync(dir, 0o500)`
- `src/harness/gate-reach-collect.test.ts:102` — `expected [ 'src/a.ts', 'src/locked.ts' ] to deeply equal [ 'src/a.ts' ]`
- `src/harness/managed-push.test.ts:78` — `expected null not to be null` (16 tests; `umask '0022'/'0002'` fixtures)

The 7 remaining (a)-only files have no permission fixture and fail the same way on main (process/timing
or environment shaped): `build-refresh.test.ts` (`expected [ 1, 1, 1, 1, 1 ] to deeply equal [ 1, 1, 2, 2, 3 ]`),
`project-compiler-gate.test.ts` (`compiler admission timed out while queued`, also the 2 unhandled errors),
`project-e2e/services.test.ts` N5 (SIGKILL escalation), `server/post-tool-pipeline.mutation-kill-luna-v3.test.ts:100`
(`the given combination of arguments (undefined and string) is invalid`), `server/post-tool-pipeline.mutation-kill-w50.test.ts`
(`expected [ …(2) ] to deeply equal []`), `trajectory/block-fingerprint-session.test.ts:186`
(`expected [ { …(2) } ] to have a length of +0 but got 1`), `session-paths.test.ts:241`.

**1 of 32 passes on `origin/main` but fails on the branch:** `src/harness/workspace-effects-shadow.test.ts`
N1 — `expected "attribution": "observed-in-window", received "shadow"` (5/5 runs fail on the branch, 5/5 pass on
main). This is **not a regression (class a)**: it fails identically at the merge-base `5b1b2d4d` (verified in a
third worktree), the branch does not touch the test or `workspace-effects.ts`, and `origin/main` commit
`efe5d8f 2026-11-04 test(harness): isolate CI permissions and filesystem clocks` fixed the test on main by
pinning the fixture mtime with `utimesSync` ("Linux filesystem timestamps can lag the JavaScript clock"). The
branch simply predates that fix. **Class (c) regressions found: 0.**

## 5. e2e nudge lane — pass (3/3)

First attempt: `npm run build:e2e` exit 1 (the same DTS OOM as §0; the atomic build left the previous `dist/`
in place, and `test:e2e -- kill-proof` passed 3/3 against it). Re-run with the heap flag:

```
build:e2e exit=0
 ✓ src/e2e/kill-proof-nudge.e2e.test.ts (3 tests) 4235ms
     ✓ P2: a fresh killed receipt silences the nudge; a source edit makes it stale again  3246ms
 Test Files  1 passed (1)   Tests  3 passed (3)
test:e2e exit=0
build exit=0        (regular build restored afterwards)
```

## 6. Built-CLI walkthrough on a throwaway repo (`/tmp/kp-demo`, own `vitest.config.ts`, `node_modules` symlinked, committed)

| step | decisive line | exit |
|---|---|---|
| killed | `verdict: KILLED (552 ms under the mutant)` / `killed test/clamp.test.ts › clamp clamps above the range` / `receipt: …/kill-proofs/e86b49c2b862c963.json` | 0 |
| survived (`test/weak.test.ts`) | `verdict: SURVIVED (559 ms under the mutant)` / `These tests still pass with the mutant applied. Strengthen the assertion…` | 1 |
| inconclusive (`return a + ;`) | `verdict: INCONCLUSIVE (0 ms under the mutant)` / `the mutated src/math.ts does not parse (Expression expected.); a compile error is not a kill` | 2 |
| `kill-proofs --verify` | all three `FRESH`; `1 KILLED proof(s): 1 fresh, 0 uncommitted, 0 stale.` | 0 |
| edit `src/math.ts` (comment line at top) → `--verify` | `STALE: source src/math.ts changed since the proof`; `1 KILLED proof(s): 0 fresh, 0 uncommitted, 1 stale.` | 1 |
| re-prove | `verdict: KILLED (577 ms under the mutant)` → `c461a72dce44b5f1` (offset moved to `src/math.ts:4`, same proof key) | 0 |
| `kill-proofs` list | old receipt reads `SUPERSEDED by c461a72dce44b5f1` | 0 |
| `kill-proofs --verify` after re-proof | new receipt `UNCOMMITTED`, old `SUPERSEDED … STALE`; `2 KILLED proof(s): 0 fresh, 1 uncommitted, 1 stale.` | **0** |
| `verify --json` | top-level key `kill_proofs` present, `receipts[]` lists all 4 with freshness | 1 (see caveat) |

**Caveat found here (real discrepancy, small):** in that same state `interlinked verify --json` reports
`kill_proofs.issues: 1` with a `kill_proof_stale` finding for **the superseded receipt `e86b49c2b862c963`**, while
`tests kill-proofs --verify` exits 0 for it. `src/commands/tests-prove-kill.ts:224` excludes
`supersededBy !== undefined` rows from the exit decision; `src/commands/verify/kill-proofs-section.ts:52`
(`staleKillFindings`) does not. The guide (`docs/mutation-grounded-test-proof.md`, *Receipt retirement*) says a
superseded receipt "never fails" `--verify` and that verify reports "the SAME freshness … one implementation", so
verify's gate is stricter than documented. The demo's verify exit 1 also includes unrelated sections
(`project_setup`, `untested_files`, `non_deterministic_test`), so the kill_proofs finding is not the sole cause.
Also a wording nit: the `--verify` summary counts the superseded receipt in "1 stale" while exiting 0.

## 7. Dogfood on the repo itself — both KILLED, exit 0

```
tests prove-kill --file src/harness/guard-tally.ts --find 'blocked: 0, warned: 0, asked: 0' --replace 'blocked: 1, warned: 0, asked: 0' --test src/harness/guard-tally.mutation-kill.test.ts --json
  → verdict "killed", receipt 0e55e771a41bfc5f, killed 1/2 cases (baseline 2 cases 624 ms; mutant 757 ms)
    killer: "guard tally starts at zero — … snapshots all-zero counters without a reset"
```

`src/harness/kill-proof/run.mutation-kill.test.ts` **does not exist** on this head. Substitute fault against the
module's main test file:

```
tests prove-kill --file src/harness/kill-proof/run.ts --find 'if (killed.length) return { verdict: "killed"' --replace 'if (killed.length > 1) return { verdict: "killed"' --test src/harness/kill-proof/kill-proof.test.ts --json
  → verdict "killed", receipt 900e8b2e0ce60073, killed 7/42 cases (baseline 42 cases 2674 ms; mutant 2852 ms)
    killers include proveKill P1/P2, N9, receipt-freshness P1/N1/N2/N10
```

Receipts landed under `.interlinked/test-runs/kill-proofs/` (gitignored); `git status --porcelain` stayed empty.

## Verdict

**Yes, af8b93d3 is releasable as a feature branch, with these caveats.** Typecheck, build (given enough heap),
generated docs, the e2e nudge lane (3/3), the full walkthrough (killed / survived / inconclusive / FRESH →
STALE exit 1 → re-prove → SUPERSEDED → verify exit 0), and both dogfood proofs (1/2 and 7/42 cases killed, both
`KILLED`) all behave as the guide describes. The 32 failing suite files are all pre-existing on `origin/main` or
at the merge-base: 24 are root-only permission fixtures, 7 are process/timing tests that fail on main too, and
the one main-green/branch-red file is a Linux mtime flake that main fixed on 2026-11-04 after the branch
forked — the branch should pick up `efe5d8f` when it merges. Two things to fix before calling it polished:
(1) `interlinked verify`'s `kill_proofs` section raises `kill_proof_stale` for a superseded receipt that
`tests kill-proofs --verify` correctly ignores (one missing `supersededBy` filter in `staleKillFindings`), and
(2) the default `npm run build` / `npm ci` prepare step runs tsup's DTS worker out of heap on a 16 GB 4-CPU
box on main and branch alike; not a branch regression, but it blocks a stock `npm ci`. No `--all-survivors`
flag exists on this head.
