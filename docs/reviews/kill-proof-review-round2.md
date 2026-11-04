# Kill proof — adversarial review, round 2

Branch reviewed: `mutation-proof` (round-1 fixes R1–R14 applied). Reviewer: cloud session, 2026-11-04.
Method: throwaway git repos under `/tmp/kp/<name>` (own `vitest.config.ts`, `node_modules` symlinked to the
clone's), driven through the real command `npx tsx src/index.ts tests prove-kill --cwd <repo> …`.
Every REPRODUCED false-pass / wrong-verdict is a red case in
`src/harness/kill-proof/review-regressions-round2.test.ts` (7 cases, 7/7 fail on this branch). No product code
was changed.

## Findings

| id | severity | where | status | test |
|---|---|---|---|---|
| K1 | false-pass | `src/harness/kill-proof/run.ts:181-182` | REPRODUCED | N1 |
| K2 | false-pass | `src/harness/kill-proof/receipt.ts:298`, `src/harness/evaluator/post-tool-kill-proof.ts:43`, `src/commands/tests-prove-kill.ts:107` | REPRODUCED | N2 |
| K3 | false-pass | `src/harness/kill-proof/receipt.ts:78` (+ `:255`) | REPRODUCED | N3 |
| K4 | false-pass | `src/harness/mutation-kill-evidence-stop-check.ts:324`, `src/harness/kill-proof/receipt.ts:296` | REPRODUCED | N4 |
| K5 | wrong-verdict | `src/harness/kill-proof/run.ts:94` | REPRODUCED | N5 |
| K6 | wrong-verdict | `src/harness/kill-proof/run.ts:80-81`, `src/commands/tests-prove-kill.ts:51,73` | REPRODUCED | P1 |
| K7 | usability (contract) | `src/harness/resource-cli.ts:57-65` | REPRODUCED | none (CLI supervisor) |
| K8 | wrong-verdict (isolation) | `src/harness/fail-before-fix/snapshot.ts:62` | REPRODUCED | P2 (symlink half) |
| K9 | usability | `src/harness/kill-proof/receipt.ts:55` | REPRODUCED | none |
| K10 | usability | `src/harness/evaluator/post-tool-kill-proof.ts:49` | REPRODUCED | none |
| K11 | usability (doc) | `docs/mutation-grounded-test-proof.md:113`, `run.ts:78` | REPRODUCED | none |
| K12 | usability | `src/harness/kill-proof/receipt.ts:221-226` | ARGUED | none |
| K13 | usability | `src/harness/kill-proof/receipt.ts:270-273` (bytesFresh over all `tests`) | ARGUED | none |

## K1 — the shared baseline/mutant copy turns leftover state into a kill (false-pass)

R3 moved the baseline into the same copy the mutant then runs in. Anything the baseline run leaves behind
(a marker file, a snapshot, an appended log) is still there for the mutant run. A test that fails on its
SECOND run fails by its own assertion, and that counts as a kill. The mutant below only edits a comment:

```
./pk.sh --cwd /tmp/kp/f1 --test test/state.test.ts --file src/math.ts \
  --find "// helper: add two numbers" --replace "// helper: add 2 numbers"
verdict: KILLED (566 ms under the mutant)
  killed       test/state.test.ts › adds once
EXIT=0
tests kill-proofs --cwd /tmp/kp/f1 --verify   →  a884358252daab3f KILLED … FRESH   EXIT=0
```

The test writes `test/.ran` (gitignored, so it is not in the live tree or the copy at the start) and asserts the
marker was absent. This reproduces every time; timing flakes reach the same verdict without reproducing reliably. A
comment, string-literal or type-annotation anchor with no such state SURVIVES correctly (see "Tried").
Possible fix directions: a fresh copy per run, or a second baseline pass after the mutant run (pass → fail →
pass), or running the baseline twice and requiring both to pass.

## K2 — index rows are trusted for verdict and killedTests (false-pass)

R8 requires a readable receipt that passes integrity checks, but `freshKillsForTest` (Stop) and `killProofNudge` (PostToolUse) take
`verdict` and `killedTests` from the INDEX ROW. They never compare those fields with the receipt. A SURVIVED receipt plus a row
edited to `verdict: "killed", killedTests: [file]`:

```
-- before   test/weak.mutation-kill.test.ts | freshKills: 0 | nudge: [interlinked:kill-proof] … no executed kill proof
-- index row forged
            test/weak.mutation-kill.test.ts | freshKills: 1 | nudge: null
tests kill-proofs --verify  →  2620805720c6fd4c KILLED … FRESH   EXIT=0      (receipt file says "survived")
```

`kill-proofs` also shows the indexed verdict even under `--verify` (`tests-prove-kill.ts:107`). Its exit code
keys on that verdict as well. A row whose `killedTests` names a different file than the receipt passes the same way.

## K3 — receipt id binds no outcome field (false-pass)

`receiptId` hashes source, mutant, test and environment bytes. It does not hash `verdict`, `underMutant.cases`,
`killedTests`, `root`, `baseline` or `mutant.lineText`. `integrityReasons` only checks that the outcome fields
agree with each other. Editing a SURVIVED receipt consistently (case verdict, verdict and killedTests) keeps the id valid. After
the next `prove-kill` anywhere in the repo rebuilds the index, every surface reports it as a fresh kill:

```
-- after rebuild   test/weak.mutation-kill.test.ts | freshKills: 1 | nudge: null
2620805720c6fd4c KILLED … FRESH   EXIT=0
```

ARGUED, wider: the id is an unkeyed sha256, so a receipt written from scratch with recomputed hashes passes too.
No guard covers writes under `.interlinked/test-runs/kill-proofs/`: `grep -rln kill-proofs src` finds only the
command and the registrar. The gated agent can therefore write its own evidence, the Goodhart case
`baseline_integrity_gate` exists for. Because `lineText` is optional (`parseMutant`), deleting it silently turns
off the R10 line check. That is harmless only while the source sha is unchanged, which makes R10 redundant on the
fresh path anyway.

## K4 — any killing case discharges the file, including the old ones (false-pass)

The Stop check fires because a mutation-directed file gained NEW cases. It is discharged by any fresh killed
receipt that names the file, no matter which case killed or which fault was used. An old, strong case kills a
trivial explicit fault, and the new weak case is certified with it:

```
./pk.sh --cwd /tmp/kp/f2 --test test/math.mutation-kill.test.ts --file src/math.ts --find "return a + b;" --replace "return a - b;"
  killed       test/math.mutation-kill.test.ts › adds (old, strong)
  survived     test/math.mutation-kill.test.ts › kills survivor X (new, weak)
test/math.mutation-kill.test.ts | freshKills: 1 | nudge: null
```

N4 drives `detectMutationKillEvidenceGaps`. The gap fires with `freshKillProofs: () => 0` and is discharged by the
real receipt. The explicit fault also need not be the manifest survivor the file claims to kill.

## K5 — a syntax error turned into an assertion is a kill (wrong-verdict)

`--replace "return a + ;"`. A test that does `try { await import(...) } catch { loaded = false }; expect(loaded).toBe(true)`
reports `KILLED`. Mutation tools classify this as a compile error, not a kill. The direct dynamic import,
`resolves.toBeDefined()` and static-import variants are correctly INCONCLUSIVE (see "Tried").

## K6 — ignored fixtures: NOT-PASSING-NOW and "fails live" for a test that passes live (wrong-verdict)

The baseline runs in the git-visible copy, which has no gitignored fixtures. A test that passes in the live tree
(`npx vitest run` → `1 passed`) is reported as:

```
verdict: NOT-PASSING-NOW
  - test/fixture.test.ts › matches fixture: failed — Error: ENOENT … /tmp/interlinked-fail-before-fix-Rpflkb/test/fixtures/case.json
Fix the test so it passes on the current code first; a test that fails live proves nothing about the mutant.
EXIT=1
```

Exit 1 is the same code as `survived`. The renderer also prints "N case(s) pass on the live tree" (`tests-prove-kill.ts:73`)
on every run, and CLAUDE.md says the same, but no live-tree run happens anymore. A copy-only failure should say "fails in the
isolated copy (ignored files are not copied)", and it is not the test's fault.

## K7 — `--timeout` is also the whole-CLI deadline: exit 75, no JSON (usability, contract)

`resource-cli.ts commandDeadline` reads `--timeout` from any `tests` subcommand as the deadline for the
supervised child process. prove-kill documents the same flag as the budget for EACH vitest run, and makes at least two
runs plus startup. So the in-command timeout path is unreachable from the CLI:

```
--timeout 1 / 5 / 50 / 300   →  EXIT=75  "[resources] CLI interrupted; no verification verdict."  stdout empty under --json
--timeout 7000, each run ≈5 s (test/slow.test.ts)  →  EXIT=75 after ~10 s, no receipt
```

75 is outside the documented 0/1/2 contract. The killed child also leaked its copy: one `/tmp/interlinked-fail-before-fix-*`
directory was left behind. This cannot be written as a unit test without spawning the supervised CLI.

## K8 — the copy is not closed: links reach the live tree (wrong-verdict, isolation)

(a) `node_modules` is symlinked to the live one. A test's `appendFileSync(join(cwd, "node_modules", …))`
landed in `/home/user/interlinked-cli/node_modules/.kp-escape.log`, and vitest's own results cache
(`node_modules/.vite/vitest/<hash>/results.json`) is written there by every proof run. That is state shared between the
baseline run, the mutant run and the live tree (see K1). (b) A test file that is a symlink to a file outside the repo, importing the
source by absolute path, runs against the UNMUTATED live source and reports `SURVIVED` (exit 1) for a mutant its
assertion would kill (P2). `unavailable` ("test resolves outside the copy") would be honest.

## K9 — `--test <directory>` crashes with raw EISDIR (usability)

`--test test` → `Error: EISDIR: illegal operation on a directory, read`, exit 2 (the `--json` error goes to stderr).
`hashFile` calls `readFileSync` on a directory. A glob (`test/*.test.ts`) gets a clean "does not exist".

## K10 — nudge text "did not kill through this file (killed)" (usability)

With two named files where one kills and one survives, the receipt is `killed` with `killedTests: [test/math.test.ts]`. The
survivor file's nudge reads "1 recorded run(s) did not kill through this file (killed)". It lists the receipt's verdict, not the file's
outcome. The other surfaces are right: the killer file gets freshKills 1 / nudge null, the survivor gets freshKills 0.

## K11 — the documented helper workaround is refused (usability, doc)

The guide (line 113) says to name an imported helper as a `--test` file so its bytes are bound. Doing that gives
`UNAVAILABLE — test/helper.ts reported no executed test case in the baseline copy`, exit 2.

## K12 — index rebuild race (ARGUED)

`writeKillProof` lists the receipt files, then renames the index. If writer A lists, B writes its receipt and its index, and then A
renames, A's older index replaces B's, and B's row is missing until the next write. Stop and the nudge read only the index, so
for that window B's kill is refused. Not reproduced: 3 concurrent runs produced 3/3 receipts and 3/3 index rows.

## K13 — editing a survivor file stales the killer's certification (ARGUED)

`bytesFresh` hashes every named test. In a two-file receipt, editing the file that did not kill makes the killer file's proof
stale too, so it has to be re-run.

## Tried and did not break

- Comment / type-annotation anchors with stateless tests: SURVIVED, exit 1 (correct: no runtime effect).
- Syntax-invalid replacement with a static import, a direct dynamic import, or `expect(import()).resolves`: INCONCLUSIVE, exit 2.
- `--test` given as `test/../test/math.test.ts`, as `../f2/test/math.test.ts` relative to `--cwd`, or as an absolute path: normalized
  to `test/math.test.ts`, correct kill. A glob or a missing file: clean UNAVAILABLE.
- An in-repo symlinked test (`test/alias.test.ts → math.test.ts`): correct kill, receipt keyed on the alias.
- Edit a test, then revert it byte for byte: STALE, then FRESH again. Acceptable, since the bytes are identical.
- R10 relocation (insert an earlier same lexeme): any such insert changes the source sha first, so the receipt goes
  STALE before `lineText` is read. Defeating `lineText` needs receipt tampering (K3).
- Root tamper (another path): STALE. Tampering a bound field (source/test sha, environment, mutant) without recomputing the id: STALE.
- Three concurrent prove-kill runs in one repo: 3/3 receipts, 3/3 index rows, all `--json` outputs parse.
- `--json` on argument errors (`--timeout 0`, `--timeout abc`, a missing `--test`, a missing anchor, the mutated file also named as a
  test, a manifest id with no manifest): well-formed JSON, exit 2.
- `process.cwd()` / `__dirname` inside tests resolve into the copy (no escape found beyond K8).
- Not tried: manifest (`--mutant`) mutants. Building a real mutation manifest in a throwaway repo was out of
  budget, so `locateMutantOffset` relocation is untested here.
