# Kill proof — adversarial review, round 5 (breaking the round-4 fixes and the new mechanisms)

Branch reviewed: `mutation-proof` at `8cde4ff` (round-4 runner fixes merged). Reviewer: cloud session,
2026-11-05, branch `cloud/falsifier-round5`. Method: throwaway git repos under `/tmp/kp5/<name>` (own
`vitest.config.ts`, `node_modules` symlinked to the clone's; vitest 2.1.9 and 3.2.7 installed locally for the
cache attack), driven through the real command `npx tsx src/index.ts tests prove-kill --cwd <repo> … --json`.
Manifest mutants were built the honest way (identity.ts + `applyMeasuredRun` + `saveManifest`, the convention of
`resolve.test.ts`). Every REPRODUCED wrong verdict / false FRESH / contract break is a red case in
`src/harness/kill-proof/review-regressions-round5.test.ts` (**10/10 fail** on this branch, 1 control passes:
`Tests  10 failed | 1 passed (11)`). No product code was changed. Environment: node v22.23.4, vitest 4.1.11
(clone), 2.1.9 and 3.2.7 (fixture-local), linux-x64. `npm run build` does not complete in this container (the DTS
worker runs out of heap), so every reproduction ran the tsx source entry; the two CLI findings (R5-1, R5-7) are
Node behaviour, not a loader artefact.

## Findings

| id | severity | kind | file:line | status | red test |
|---|---|---|---|---|---|
| R5-1 | high | CLI contract (no verdict, exit 13) + state leak | `overlay-command-runner.ts:81` (`sleep().unref()`), `:108-120` (`terminateGroup` polls with unref'd timers), `:182` (`killTimer.unref()`), `:191-205` (`close` waits on `groupGone`) | REPRODUCED | N8 |
| R5-2 | high | wrong verdict (false SURVIVED under a killed id) | `mutation/differential-fuzz-locate.ts:97-101` (`ambiguousRelocation` trusts an equal hash), `mutation/identity.ts:417-423` (`computeSymbolHashes` keeps one entry per symbolId — last wins) | REPRODUCED | N6, N7 |
| R5-3 | medium | false FRESH | `kill-proof/bound-imports.ts:119` (`importers.size >= cap` drops the rest silently; nothing in the receipt says so) | REPRODUCED | N1 |
| R5-4 | medium | false FRESH | `kill-proof/bound-imports.ts:12-15` (vi.mock targets not followed) — the `__mocks__/` twin vitest substitutes is never bound | REPRODUCED | N2 |
| R5-5 | medium | false FRESH | `kill-proof/receipt.ts:85-110` (`configDeclaredInputs` binds `setupFiles` / `globalSetup` bytes only; their import closure is not walked) | REPRODUCED | N3, N4 |
| R5-6 | low–medium | false FRESH (documented limit) | `kill-proof/bound-imports.ts:12` (aliases not followed) | REPRODUCED | N5 |
| R5-7 | low | state leak | `commands/tests-prove-kill.ts` ↔ `harness/resource-cli.ts:76-84` (supervisor `--timeout` SIGTERMs the child; `proveKill`'s `finally` never runs) | REPRODUCED | — |
| R5-8 | medium (policy) | false-pass (kill), deterministic, repeat-proof | `kill-proof/run.ts:196-210` (`confirmKills`: state keyed on the mutant's bytes) | REPRODUCED | N9 |
| R5-9 | low (documented) | false-pass (kill) | `kill-proof/run.ts:196-210` (period-3 state; also through a custom `sequence.sequencer`) | REPRODUCED | N10 |
| R5-10 | low | conservative wrong reason | `kill-proof/run.ts:237-240` (control case filtered by `testNamePattern` ⇒ "setup file or the config") | REPRODUCED | — |
| R5-11 | low | state escapes the group | `overlay-command-runner.ts:76` (a `setsid` grandchild starts a new session) | REPRODUCED | — (by construction) |
| R5-12 | low | cosmetic | `kill-proof/run.ts:72-76` (`copySizeWarning` by apparent size: a sparse file warns) | REPRODUCED | — |

### R5-1 — a timed-out vitest run kills the whole CLI with exit 13 and leaks the copy and the private TMPDIR

`terminateGroup` (round-4 M6) SIGTERMs the group and then polls `groupAlive` with `sleep()`s that are `unref()`'d;
the kill timer is `unref()`'d too. When the direct vitest child closes before the rest of its group is reaped —
every forks-pool run does, the wrapper exits on SIGTERM and the worker follows a few ms later — the `close` handler
parks on `groupGone.then(settle)`, nothing referenced is left in the event loop, and Node exits **13** ("Detected
unsettled top-level await at src/index.ts:33") before `proveKill` resolves. A plain slow test, no signal handler:

```
$ pk pg-plain --test test/slow.test.ts --file src/math.ts --find "return a + b;" --replace "return a - b;" --run-timeout 2000
Warning: Detected unsettled top-level await at /home/user/interlinked-cli/src/index.ts:33
EXIT=13                                   (3/3 tries; vitest 3.2.7 fixture: same)
copies before=3 after=6  report dirs before=3 after=6     ← one copy + one report dir leaked per run
```

No verdict, no JSON, an exit code outside the documented 0/1/2/75 set, and the `finally` blocks never run: the
git-visible copy and the private TMPDIR survive — with whatever the test wrote there (`tmpbig` + a 6 s sleep left a
100 MB `kp5-blob.bin` in `/tmp/interlinked-fbf-report-*/tmp/`). The group itself IS killed (the `exit` handler
SIGKILLs it; `pgrep vitest` is empty afterwards), so the round-4 N8 marker test stays green: in-process, vitest keeps
the worker's loop alive and the unref'd polling completes. The same runner serves `tests fail-before-fix` and
`tests faults run`, so their timeouts end the same way (ARGUED). A SIGTERM-ignoring test is handled as designed —
SIGKILL after the 5 s grace, 0 processes left — and then exits 13 too. Fix direction: keep the poll referenced
(or `ref()` the timer while a group is being reaped), or await `groupGone` from a referenced timer.

### R5-2 — a verbatim duplicate with the same qualified name is ranked, not refused

`ambiguousRelocation` returns null when the symbol hash is unchanged. `computeSymbolHashes` keys its map by
`symbolId` (file, qualified name, arity), so two declarations with the same name and arity collapse to one entry
whose hash is the LAST one's. Insert an identical copy of a method (or of a function nested in a function body —
legal JavaScript, the later declaration wins at runtime) BEFORE the live one: hash equal ⇒ the check is skipped
although the lexeme now occurs twice; `deriveIdentities` groups both copies under one symbolId, the earlier copy
takes ordinal 0 and the mutant id; the proof mutates dead code.

```
$ mkmanifest amb-method src/calc.ts "a + b" "a - b"   → {"mutantId":"707242648254d97d","qualifiedName":"Calc.add","ordinal":0}
unchanged:                    "verdict": "killed"  "line": 3  EXIT=0
duplicate method inserted earlier (lines 2-4 copy of 5-7):
                              "verdict": "survived" "line": 3  EXIT=1      (vitest on the live tree: 1 passed)
amb-nested (function add duplicated inside calc): "verdict": "survived" "line": 3  EXIT=1
```

Same shape as C24 (`kill-proof-manifest-route.md` §3), through the hash shortcut instead of the count. The count
check alone would have refused it (2 sites, was 1): the fix is to not let an equal hash bypass the count, or to
make `computeSymbolHashes` fail (or hash all duplicates together) when a symbolId occurs twice.

### R5-3 — the 200-file cap drops helpers silently; the receipt stays FRESH after editing one

Test → `chain/c0` → … → `chain/c204` (`export * from` each), `c204` exports the `DEEP = 3` the test asserts.
The receipt binds exactly 200 files (`c0…c199`) and records nothing about the cut.

```
edit chain/c204.ts (3→4): fresh        ← `vitest run test/k.test.ts` on the live tree: 1 failed
edit chain/c0.ts (touched): stale helper chain/c0.ts changed since the proof      (control)
```

The guide's Limits mention the cap; the receipt and `--verify` do not, and the Stop check's `receiptCertifies`
reads the same closure. A cut closure should either mark the receipt (`boundImportsTruncated`, verify ⇒ stale) or
refuse to certify.

### R5-4 / R5-5 / R5-6 — files that change the test's behaviour and are never bound

One fixture (`/tmp/kp5/bound`), one killed receipt, then one edit at a time and `tests kill-proofs --verify`:

| edited file | reaches the test through | `--verify` |
|---|---|---|
| `test/helpers/__mocks__/check.ts` | `vi.mock("./helpers/check")` (adjacent `__mocks__` twin) | **fresh** |
| `test/helpers/matchers.ts` | `setupFiles: ["./test/setup.ts"]` → `import "./helpers/matchers"` (installs the matcher the test calls) | **fresh** |
| `test/global-setup-helper.ts` | `globalSetup` → static import | **fresh** |
| `test/helpers/aliased.ts` | `resolve.alias` `@helpers/*` (documented limit) | **fresh** |
| `test/setup.ts`, `test/global-setup.ts` | config-declared inputs | stale (correct) |
| `test/helpers/data.mjs`, `test/helpers/data.json` | relative static import | bound (correct) |

### R5-7 — the supervisor's `--timeout` leaks the copy

`--timeout 3000` against a 6 s baseline: `[resources] CLI interrupted`, EXIT=75, the test's marker is never written
and no vitest process survives (the SIGTERM handler SIGKILLs the group before re-raising — correct). The CLI child
dies on the re-raised SIGTERM without running `proveKill`'s `finally`: one `interlinked-fail-before-fix-*` directory
and its report dir are left per interrupted run.

### R5-8 — state keyed on the mutant's bytes defeats any number of repeats

Store of seen source hashes beside the project (`$HOME` in the fixture); the case fails only when the hash is NEW
and the store is non-empty. Baseline records the original (pass), the mutant run sees a new hash (FAIL), both
repeats see the original again (pass, pass): the exact kill sequence, for a comment-only mutant.

```
hashkey, first proof:   "verdict": "killed"     EXIT=0
hashkey, second proof:  "verdict": "survived"   EXIT=1      (the hash is old now — the verdict depends on history)
```

This is the limit of the repeat design rather than a wrong count: a repeat can only catch state that misbehaves
on an UNMUTATED run. The test does read the mutated file, so a mutation tool would call it a kill; the proof's
claim is "failed by its own check" and that holds. Worth stating in Limits as its own class (adaptive state), and
it argues for a private `HOME`/XDG per run alongside TMPDIR (the fixture used `os.homedir()`), which would at least
confine it to the project tree.

### R5-9 — period-3 state (documented residual) and the sequencer form

`n % 3 !== 1` counter in `$HOME`: `killed`, counter 4 (as the guide's Limits predict). The same through
`sequence.sequencer` (a `BaseSequencer` subclass reading a `$HOME` counter, reversing the order on run 2,
`isolate: false`, `a` fails if `b` ran first): `killed`, counter 4. Not new; recorded because the brief asked.

### R5-10 — `testNamePattern` makes the control case vanish

Config `testNamePattern: "adds"` plus an alias import: the canary breaks the case, the test is not "reaching", the
control copy's stand-in case `kill-proof control (prove-kill): …` is filtered out, so `control.cases.some(passed)`
is false and the run is `unavailable` with "the canary breaks the run through a setup file or the config" — there is
no setup file. Conservative direction, wrong explanation (`vitest --testNamePattern` on the CLI would do the same).

### R5-11 — a `setsid` grandchild escapes the group

Test spawns `setsid sh -c 'sleep 6; echo escaped > /tmp/kp5-escape-marker'` detached and outlives
`--run-timeout 2000`: the marker appears 8 s after the proof returned (`marker right after: none`, `8 s later:
escaped`). A new session is outside any process group by definition; only a cgroup/namespace sandbox stops it.
Windows: no process groups at all (`OWN_PROCESS_GROUP` false), so the direct child is the only thing killed — not
testable here, ARGUED.

### R5-12 — the copy budget reads apparent size

A 300 MiB `truncate`d sparse file (`du` 0): `copy is 300 MiB; large tracked files slow every proof`, proof 9 s vs
5 s control. A symlink to a 300 MiB file outside the repo: kept as a link, no bytes, no warning, 6 s. Cosmetic.

## Attack (7) notes — ambiguity refusal

- Arity change (`c = 0` added) + an inserted earlier `a + b` (count 1 → 2): `unavailable`, `ambiguous re-location:
  a + b now occurs 2 times in total (was 1); re-measure the file` — the qualifiedName fallback plus the count
  refuse it correctly.
- Arity change + inserted earlier dead lexeme + the live site rewritten (`c + a + b`) so the count STAYS 1:
  `survived`, line 2 (the dead site). This is the documented "same count ⇒ trusted" case; the id is now pinned to
  dead code. Not new, listed as a reproduced documented limit.
- A comment containing the lexeme: `lexemeCandidates` walks AST nodes, comments are trivia — not a candidate
  (ARGUED; `resolve.test.ts` N2 pins the hash side).

## Tried and did not break

- `--no-cache`: vitest 2.1.9, 3.2.7 (fixture-local installs) and 4.1.11 — no `node_modules/.vite` and no
  `results.json` anywhere after a proof; the environment records the right version.
- Private TMPDIR: a test writing 100 MB to `os.tmpdir()` and a marker to `$TMPDIR/..` (the report dir): both gone
  with the run (report dirs before = after); a period-2 toggle in `/dev/shm` is caught by repeat 2 ("not
  repeatable … repeat 2 of 2"). `/var/tmp` and `os.homedir()` only matter for period ≥ 3 (R5-9). A test that
  points TMPDIR under the copy writes into the copy, which is removed.
- Canary / control: reaching through a barrel (`import { add } from "../src"` → `src/index.ts` `export * from`)
  counts as reaching ⇒ `survived` (correct); an alias resolving INSIDE the copy ⇒ control passes ⇒ `survived`
  (correct: the test did load the copy's file); setup file imports the source AND the test imports it relatively ⇒
  `survived` (relative rule wins, correct); a fake relative import in a line comment or inside a template literal
  plus a setup-file import plus an absolute import of the LIVE file, real mutant ⇒ `unavailable` (the fake import
  does NOT count); two named files, one relative, one alias, setup imports the source ⇒ `unavailable` naming
  `test/alias.test.ts` only; a named test importing another named test (only the latter reaches the source) ⇒
  `survived` with `b.test.ts` reached through the closure.
- Process group: a test that installs a SIGTERM handler is SIGKILLed after the 5 s grace, 0 vitest processes
  remain (then R5-1 applies). Supervisor `--timeout 3000` vs a 6 s baseline: the proof's vitest group is killed
  before the CLI re-raises SIGTERM — the marker the test would write never appears, `pgrep vitest` empty.
- Bound imports: `.json` and `.mjs` helpers are bound; an in-cap helper edit stales through both readers (C1).
- Copy budget: a symlink to a huge file is kept as a link and costs nothing.

## Red tests

`src/harness/kill-proof/review-regressions-round5.test.ts`: N1–N5 (receipts, scripted runner — fast), N6–N7
(resolution, honest manifest), N8 (real CLI through tsx, ~12 s), N9–N10 (real vitest, documented residuals — kept
red so the policy decision is explicit: fix, or delete the case and keep the Limits text), C1 control (green).

## Resolution (branch `cloud/fix-round5`, 2026-11-05)

Fixes are pinned by `src/harness/kill-proof/round5-fixes.test.ts` (mechanism) and the red cases above in
`review-regressions-round5.test.ts` (re-aimed at the merged `mutation-proof`: the freshness readers now live in
`receipt-freshness.ts`). POLICY rows keep their red case as an `it.todo` with the reason in the title and the body
intact, so turning one green is a deliberate product change. The verification caveat
(`kill-proof-verification-af8b93d3.md` §6) is resolved in the same branch.

| id | status | fix | pin |
|---|---|---|---|
| R5-1 | FIXED | `overlay-command-runner.ts`: the group-reap poll and the grace wait are REFERENCED timers, so `close` awaits the whole group and the run settles; a `--run-timeout` below the test's duration ends in a verdict (`unavailable` / `inconclusive`, exit 2) with the copy and the report directory removed, never Node's exit 13. The kill timer stays unref'd (the child handle holds the loop while it runs). | N8; fixes R5-1 P1 (no `interlinked-fbf-report-*` left, exit ∈ {0,1,2,75}) |
| R5-2 | FIXED | `identity.ts computeSymbolHashes` counts `declarations` per symbolId; `differential-fuzz-locate.ts ambiguousRelocation` refuses BEFORE any hash comparison when the qualified name is declared more than once in the current file (every arity): `ambiguous re-location: Calc.add is declared 2 times in src/calc.ts; re-measure the file`. The manifest records no new field. | N6, N7 |
| R5-3 | FIXED | `bound-imports.ts boundImportClosureDetailed` reports the cut; the receipt carries `boundImportsTruncated: true` (in the id; parsed as absent-or-exactly-true) and `integrityReasons` — shared by `--verify`, the cheap hook check and `receiptCertifies` — refuses it: `bound-import closure truncated at 200 files; helpers beyond the cap are unbound, so the receipt cannot certify these tests`. | N1; fixes R5-3 P1–P3, N1 |
| R5-4 | FIXED (cheap exact rule) | a factory-less `vi.mock("./x")` / `vi.doMock("./x")` binds and walks the `__mocks__/x` twin beside the resolved target; a bare specifier's twin is `<root>/__mocks__/<name>`. A mock with a factory binds nothing extra (the factory lives in the bound caller). Guide: Receipt + Limits. | N2; fixes R5-4 P1/P2/N1 |
| R5-5 | FIXED | the config's `setupFiles` / `globalSetup` are walked as global roots (same cap, same walk), every reached file bound with `importedBy` = every named test; the roots themselves stay bound by `environment.setupFiles`. | N3, N4; fixes R5-5 P1/P2 |
| R5-6 | POLICY | aliases (`resolve.alias`, tsconfig `paths`) need the vite/vitest config evaluated — no static rule follows them. Limits now call this out as a false-FRESH class, not just "not followed". | N5 → `it.todo` |
| R5-7 | FIXED | `tests prove-kill` handles SIGTERM: the proof's `signal` aborts it (`ProveKillOptions.signal`, `ProofInterrupted`), the overlay guard's SIGKILL of the vitest group stands and it does not re-raise while the command's listener exists, every copy's `finally` runs, the command prints `[interlinked:kill-proof] interrupted by SIGTERM: copies removed, no verdict, no receipt written` and exits 75. Residual (guide, Usage): the supervisor SIGKILLs one second after its SIGTERM, so a copy whose removal outlasts that grace can still leak. | fixes R5-7 P1 (real `--timeout 3000`, marker never written, no copy or report directory left, exit 75) |
| R5-8 | POLICY | adaptive state (keyed on the mutant's bytes) is the limit of the repeat design: a repeat only catches state that misbehaves on an unmutated run; the test did read the mutated file and fail by its own check. Named in Limits as its own class, with the second-proof `survived` symptom. | N9 → `it.todo` |
| R5-9 | POLICY | period-3 state, including through a custom `sequence.sequencer`, is the residual Limits already state; the sequencer form is now named there. | N10 → `it.todo` |
| R5-10 | FIXED | `run.ts canaryProblem`: a stand-in case the control copy never RAN (filtered by `testNamePattern`) yields `the control copy's stand-in case for <test> did not run (a test-name filter — vitest's testNamePattern in the config or on the command line — excludes it) …`; the setup-file wording is kept for a stand-in that ran and failed. Verdict unchanged (`unavailable`). | fixes R5-10 P1 |
| R5-11 | POLICY | a `setsid` grandchild starts a new session and is outside any process group by definition; only a cgroup/namespace sandbox stops it, and Windows has no groups at all. Documented in Limits. | — (by construction) |
| R5-12 | FIXED | `snapshot.ts allocatedBytes`: the copy budget sums `st_blocks * 512` (apparent size where no block count exists, i.e. Windows); a sparse file truncated past 256 MiB no longer warns. | fixes R5-12 P1/P2 |
| af8b93d3 §6 | FIXED | `verify/kill-proofs-section.ts staleKillFindings` skips `supersededBy` rows (the rule `tests kill-proofs --verify` applies to its exit); `killProofsTally` keeps superseded receipts out of the freshness buckets and appends `, N superseded`. | `kill-proofs-section.test.ts` N7, `tests-prove-kill.test.ts` tally P1/P2, `kill-proofs-section.cli.test.ts` N3 (built CLI: verify exits 0 after a re-proof, `--verify` says `1 superseded`) |
