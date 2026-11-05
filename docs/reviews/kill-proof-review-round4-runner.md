# Kill proof — adversarial review, round 4 (runner and copy semantics)

Branch reviewed: `mutation-proof` at `6f470b5` (round-3 fixes `c6ab785`, `ae38a6f`, `6f470b5`). Reviewer: cloud
session, 2026-11-05, branch `cloud/falsifier-round4-runner`. Method: throwaway git repos under `/tmp/kp4/<name>`
(own `vitest.config.ts`, `node_modules` symlinked to the clone's, or a real local install for vitest 2/3), driven
through the real command `npx tsx src/index.ts tests prove-kill --cwd <repo> … --json`. Every REPRODUCED
false-pass / wrong-verdict / contract break is a red case in
`src/harness/kill-proof/review-regressions-round4-runner.test.ts` (**9/9 fail** on this branch:
`Tests  9 failed (9)`). No product code was changed. Environment: node v22.23.4, vitest 4.1.11 (clone), 2.1.9 and
3.2.7 (fixture-local), linux-x64, no reflink support on `/tmp` (`cp --reflink=always` → "Operation not supported").

## Findings

| id | severity | kind | file:line | status | red test |
|---|---|---|---|---|---|
| M1 | high | false-pass (kill) | `kill-proof/run.ts:285-290` (one repeat, fixed order) | REPRODUCED | N1, N2 |
| M2 | high | false-pass (kill) + contract | `fail-before-fix/snapshot.ts:75` (node_modules link) + vitest results cache | REPRODUCED | N3, N4 |
| M3 | medium | wrong-verdict (false SURVIVED) | `kill-proof/run.ts:296-298` (canary asks "any case broke") | REPRODUCED | N5 |
| M4 | medium | wrong-verdict (false SURVIVED) | `kill-proof/run.ts:298` (a timed-out / errored canary accepts the survivor) | REPRODUCED | N6 |
| M5 | medium | wrong-verdict (false SURVIVED) | `kill-proof/run.ts:145` (`new Map` over `file › name`) | REPRODUCED | N7 |
| M6 | medium | contract (state escapes the proof) | `overlay-command-runner.ts:104` (`child.kill` on the direct child only) | REPRODUCED | N8 |
| M7 | medium | CLI contract (documented flag unusable; exit 1 = "survived") | `harness/resource-cli.ts:57-66` vs `registrars/tests.ts:143` | REPRODUCED | N9 |
| M8 | low–medium | false-pass (kill), probabilistic | `run.ts:285` (one repeat vs flaky / shuffled order) | REPRODUCED (2/12) | — (flaky by nature) |
| M9 | low | diagnostics | `fail-before-fix/classify.ts:69` (first line of `failureMessages`) | REPRODUCED | — |
| M10 | low | cost | `fail-before-fix/snapshot.ts:51-56` (no copy size budget) | REPRODUCED (timing) | — |
| M11 | low | conservative wrong-verdict | `run.ts:296-300` canary vs a test that catches its import | REPRODUCED | — |

### M1 — the repeat baseline is one run in a fixed slot, so period-2 state passes it (false-pass)

The round-3 L1 fix runs baseline → mutant → unmutated repeat. That defeats "passes once, fails every later run"
(round-3 N2 is green), but not state that flips only on the SECOND run. Comment-only mutant
(`// helper: add two numbers` → `// helper: add 2 numbers`), test reads a counter in `os.tmpdir()`, increments it,
and asserts `n !== 1`:

```
$ ./pk.sh once --test test/once.test.ts --file src/math.ts --find "// helper: add two numbers" --replace "// helper: add 2 numbers"
"verdict": "killed" … "test/once.test.ts › adds failed by its own check under the mutant" … EXIT=0
$ cat /tmp/kp4-once-counter
3
```

The toggle form (a marker the first run creates and the second deletes — a lock or cache file cleaned up on the
next run) is the same period-2 pattern (N2, red). Because the mutant always runs in slot 2 of 3, any state with
period 2 lines up with it. A sandwich of one does not distinguish "the mutant failed the test" from "run 2 fails".

### M2 — vitest's results cache lives in the SHARED node_modules and reorders files between the three runs (false-pass, contract)

Every copy symlinks the live `node_modules`, so vitest 3/4 writes
`node_modules/.vite/vitest/da39a3ee…/results.json` there (`da39a3ee…` = sha1 of the empty project name; keys are
project-relative `":test/x.test.ts"`). All copies — and the user's own live runs — share one entry per test path.
vitest's sequencer orders files by that cache: no entry → by size, entry → by duration, `failed: true` → first.
So the three runs see three different orders, and the mutant run's order is the odd one:

- run 1 (no entry): larger `x` first → passes;
- run 2 (durations cached): slower `y` first → `x` sees `y`'s state → fails (assertion) → "kill";
- run 3 (`x` cached as failed): `x` first → passes → the repeat accepts the kill.

With `isolate: false, fileParallelism: false` (or `pool: "threads"`, also tried) and a comment-only mutant:

```
"test": "test/x15556109.test.ts › runs before the slow file", "verdict": "killed"   EXIT=0
":test/x15556109.test.ts",{"duration":2.57,"failed":false}   ← in /home/user/interlinked-cli/node_modules/.vite/vitest/…/results.json
```

vitest 3.2.7: same false kill. vitest 2.1.9 (cache at `node_modules/.vite/vitest/results.json`, no hash dir):
`survived` (no false kill in this layout). The cache write is also a live-tree write ("the live tree is only
read", `run.ts` header): each proof adds rows for every named file to the live `node_modules` (N4) and can reorder
the user's next ordinary `vitest run`. Fix direction (not applied): `--no-cache` / a per-copy `cacheDir`
(`--cache.dir` / `test.cache`) for all three runs, or `sequence.sequencer` pinned.

### M3 — the canary accepts a survivor when SOMETHING loads the copy's file, not the tests (false SURVIVED)

The round-3 N6/N7 canary replaces the file with a module-level throw and accepts the survivor if any case then
fails. A setup file (`setupFiles: ["./test/setup.ts"]`, `import "../src/math"`) loads the copy's file, so the
canary breaks every case, while the test itself imports the LIVE file by absolute path:

```
can1 (setup file + absolute import): "verdict": "survived" … EXIT=1
can0 (absolute import, no setup):    "verdict": "unavailable" … "the named tests do not load src/math.ts from the copy" EXIT=2
```

The same hole: two cases, one trivially importing the copy and one testing the live file, or a vitest config that
imports the source (config load error → no report → `canary.error` set → accepted; ARGUED). The canary proves
"the run breaks when this file throws", which is weaker than "the assertions observed this file".

### M4 — a canary run that times out (or errors for any reason) accepts the survivor (false SURVIVED)

`run.ts:298` returns `unavailable` only when the canary ran cleanly AND every case passed. A timed-out canary
falls through to `survived`. Same absolute-live test as can0, plus a delay that makes only the third run outlive
`--run-timeout 3500`: `"verdict": "survived"`, EXIT=1 (control without the delay: `unavailable`). A canary that
produced no evidence is not evidence that the tests loaded the copy.

### M5 — duplicate full names collapse in `judgeCases` (false SURVIVED)

Two `it("adds")` in one file, the first `expect(add(1, 2)).toBe(3)`, the second `typeof add`. Under `a - b` the
first fails by assertion; the Map keeps the last row (passed), so both baseline rows are judged against it:

```
"verdict": "survived" … "test/dup.test.ts › adds" survived ×2 … EXIT=1
```

The repeat-baseline lookup (`again.cases.find`, `run.ts:288`) and the canary lookup have the same first/last
asymmetry. Duplicate titles are common after copy-paste (the 2026-09-02 deletion wave found one true duplicate in this repo).

### M6 — a timed-out run leaves vitest's worker running test code after the proof returns (contract)

`runArgvInOverlay` SIGTERMs/SIGKILLs the direct child only (no process group). With `--run-timeout 2000` and a
test that sleeps 8 s then writes a marker: proof returns `unavailable … timed out after 2016 ms` at 03:51:52;
`/tmp/kp4-orphan-mark` appears at 03:52:02 containing `/tmp/interlinked-fail-before-fix-5vxfFQ` (the deleted
copy). An orphaned worker writes into `os.tmpdir()` / the shared `node_modules` while the NEXT proof runs — the
same state channel as M1/M2, now across proofs.

### M7 — the documented whole-command `--timeout` is rejected by `prove-kill` (CLI contract)

The guide and CLAUDE.md say `--timeout <ms>` is the supervisor's whole-command deadline. The supervisor reads it,
then runs the child with the same argv, and commander rejects it:

```
--timeout 1      → EXIT=75  "[resources] NOT RUN …"            (deadline hits before parsing; round-3 K7 saw only this)
--timeout 600000 → EXIT=1   "error: unknown option '--timeout'"
```

Exit 1 is also prove-kill's "survived / not passing now" code, so a script that branches on the exit code reads a
usage error as "these tests do not detect the mutant".

### M8 — one repeat against flaky order (false-pass, probabilistic)

`sequence.shuffle: true`, `isolate: false`, two files where `a` fails if `b` ran first; comment-only mutant; 12
independent proofs: `8 not-passing-now`, `2 inconclusive` (repeat caught it), **`2 killed`**. Expected rate with a
fair shuffle: ½·½·½ = 12.5 %; observed 2/12. Any test with failure rate f gives a false kill with probability
(1−f)²·f per proof (max 14.8 % at f = ⅓). Not pinned as a red test (it is flaky by construction).

### M9 — vitest 3/4 report a timeout as `Error: STACK_TRACE_ERROR`

Reporter shapes for 2.1.9 / 3.2.7 / 4.1.11 are otherwise identical for our use (statuses `passed|failed|skipped|
todo`, `fullName` = ancestors + title, absolute `name`, assertion frames on the test file; 4.x adds `tags`). The
per-case first line of `failureMessages` differs for a test timeout: v2 `Error: Test timed out in 100ms.`, v3/v4
`Error: STACK_TRACE_ERROR` (the stack placeholder). The verdict is still `inconclusive` (correct), but the reason
shown to the user is `"reason": "Error: STACK_TRACE_ERROR"`, which names nothing. Snapshot mismatch is
`Error: Snapshot \`math > snap 1\` mismatched` on all three, and `SNAPSHOT_MISMATCH` kills it on all three.

### M10 — no copy budget

There is no size cap on the git-visible copy. A tracked 400 MB file: proof 7.9 s vs 5.1 s control (+2.8 s), three
non-reflinked 400 MB copies written sequentially (each removed). A multi-GB tracked dataset multiplies that and
can exhaust a session disk allowance; nothing warns. ARGUED for the GB case.

### M11 — a test that catches its own import reads as "does not load the copy"

`try { ({ add } = await import("../src/math")) } catch {}` + an equivalent mutant: `unavailable` with "the named
tests do not load src/math.ts from the copy". The tests DO load it; the canary throw was swallowed. Conservative
(no false claim), but the message is wrong. A real mutant on the same test: `killed` (correct).

## Attack (7) — an export rename

`export function add(` → `export function sum(`:
- `import { add }` + `add(1, 2)` → `inconclusive`, `TypeError: (0 , __vite_ssr_import_1__.add) is not a function`
  (a crash by rule). Right call: the mutant changes the module's API, not its behaviour; Stryker would count it as
  killed, but this tool's rule (a load/crash failure proves nothing about behaviour) is applied consistently.
- `import * as m` + `expect(m.add?.(1, 2)).toBe(3)` → `killed` (`undefined` vs 3 is the test's own assertion).
  Defensible: the test observed the missing behaviour through its check. The same mutant gets two verdicts by test
  style; documented, not a defect.

## Tried and did not break

- Canary routes: lazy `await import()` inside a case, computed dynamic `import(\`../src/${name}.ts\`)`, child
  process (`node --experimental-strip-types -e "import('./src/math.ts')"`) — real mutant `killed`, equivalent mutant
  `survived` with the canary accepting; a type-only import → `unavailable` both ways (correct).
- Paths: spaces + unicode (`src/dír with space/ünï/m ath.ts`, `test/sp ace ü.test.ts`), a leading-dot test dir
  (`.hidden/tests/h.test.ts`, included by config), 16-level nesting, regex/glob characters (`test/[id].test.ts`,
  `test/(g)+.test.ts`) — all `killed` as expected.
- Mode bits: executable source + an executed tracked `run.sh` + a test asserting the source's x-bit — `killed`
  for `a - b`, `survived` for whitespace (copy and override keep the mode).
- `.gitattributes` `* text eol=crlf` + `ident` (`$Id: …$` expanded on checkout) — `killed`; the copy takes
  working-tree bytes, so filters do not reach it.
- Sparse checkout (`!/other/`): absent tracked files are skipped by `copyEntry`; proof `killed`.
- `--run-timeout` just over the test: baseline `unavailable` "timed out after 2016 ms", no leaked copy dirs
  (M6 is the process, not the directory). `--run-timeout` below the mutant run only: `inconclusive` (correct).
- vitest 2/3/4 on the same fixture (`adds`, own-thrown `Error`, skip, todo, inline snapshot) under `a - b`: three
  `killed` cases each, skip/todo excluded, environment records the right version.
- `pool: "threads"` vs default forks: M2 reproduces on both.
