# Kill proof — adversarial review, round 4 (receipts / Stop / nudge / CLI)

Branch reviewed: `mutation-proof` at `1c05597`. Reviewer: cloud session, 2026-11-05, branch
`cloud/falsifier-round4-receipts`. Method: throwaway git repos under `/tmp/kp4-*` (own `vitest.config.ts`,
`node_modules` symlinked to this clone's, a COMMITTED HEAD so the Stop check and the nudge read real
`git show`), driven through the real `proveKill` (real vitest), the real CLI
(`npx tsx src/index.ts tests prove-kill|kill-proofs --cwd <repo>`), the real Stop detector
(`detectMutationKillEvidenceGaps`), the real nudge (`killProofNudge`) and the real PreToolUse evaluator.
Probe scripts lived in `scratch/r4/` (gitignored). Every REPRODUCED false-pass / wrong-verdict is a red case
in `src/harness/kill-proof/review-regressions-round4-receipts.test.ts`: **17 cases, 17/17 fail** on this
branch, each on its decisive assertion (no fixture error). No product code was changed.

## Findings

| id | severity | where | status | test |
|---|---|---|---|---|
| M1 | **critical** (the L2 guard is inert) | `rules/default-config-resolvers.ts:80`, `evaluator/tool-classifiers.ts:132` | REPRODUCED | N1–N3 |
| M2 | false-pass | `kill-proof/receipt.ts:377` `caseNameMatches` (suffix) | REPRODUCED | N4 |
| M3 | false-pass + wrong-verdict | `kill-proof/run.ts:145` (`Map` by full name), `mutation-kill-evidence-stop-check.ts:334` | REPRODUCED | N5, N6, P4 |
| M4 | false-pass (Stop AND nudge silent) | `mutation-kill-evidence-stop-check.ts:206` `CASE_TITLE_RE`, `check-evidence/case-parser.ts:164` | REPRODUCED | N7–N9 |
| M5 | false-pass + wrong-verdict | `CASE_TITLE_RE` matches `.test(` | REPRODUCED | N10, P3 |
| M6 | false-pass (policy) | `mutation-kill-evidence-stop-check.ts:332-334` growth rule vs nudge | REPRODUCED | N11 |
| M7 | wrong-verdict (a real kill never certifies) | `CASE_TITLE_RE` raw source text vs vitest names | REPRODUCED | P1, P2 |
| M8 | wrong-verdict (CI) | `commands/tests-prove-kill.ts:142`; receipts never retired | REPRODUCED | P5 |
| M9 | wrong-verdict (FRESH for uncommitted bytes) | `kill-proof/receipt.ts:362` `uncommittedPaths` | REPRODUCED | N12 |
| M10 | performance | `receipt.ts:406` `freshKillsForTest`; `post-tool-kill-proof.ts:59` | REPRODUCED (measured) | — |
| M11 | low | `receipt.ts:259` (file name ≠ `id`), `receipt.ts:362` (octal-quoted names) | REPRODUCED | — |

### M1 — `protected_files` never matches a receipt path (critical)

The round-3 L2 fix is a `protected_files` entry `**/.interlinked/test-runs/kill-proofs/**`. `globMatch` sends any
`**/` pattern to `matchesRecursivePattern`, which tests `filePath.endsWith("/.interlinked/test-runs/kill-proofs/**")`,
with the `**` taken literally. The `dir/**` branch is never reached, so the rule matches no real path:

```
Write      {"file_path":"<root>/.interlinked/test-runs/kill-proofs/0123456789abcd…  allow
Edit       …                                                                        allow
MultiEdit  …                                                                        allow
Bash       printf '{}' > <root>/.interlinked/test-runs/kill-proofs/…                allow
Bash       cp /tmp/forged.json <root>/.interlinked/test-runs/kill-proofs/…          allow
Write      {"file_path":"<root>/secret.pem","content":"x"}                          block protected-file   (control)
```

(full `evaluatePreToolUse` with `getDefaultConfig()`, `scratch/r4/pretool.ts`). Tool coverage, assuming the glob
worked: Write / Edit / MultiEdit read `file_path`. NotebookEdit is mapped to `Write`, but its path is in
`notebook_path`, which the guard never reads (ARGUED). `apply_patch` has no `file_path`, so it is not covered.
Bash is out of scope by the rule's own comment ("the redirect/tee guards' job"), but no guard blocks either the
redirect or the `cp`. A forged, re-sealed receipt (round 3 L2) can therefore be written with every edit tool. A
symlinked `kill-proofs/` directory would also slip past a working glob, because the path is not realpath'd (ARGUED).

### M2 — suffix match certifies a case that killed nothing

`caseNameMatches(name, title)` accepts `name.endsWith(" " + title)`. HEAD has `describe("caps") it("at max")` (strong).
The new top-level `it("max")` is weak. Real vitest gives `killed:caps at max, survived:max`, then `newTitles=["max"]`,
Stop `staleMeasurement=false`, nudge `SILENT`. vitest's `fullName` joins with spaces, so any trailing words of a
killing case name certify a new case. Matching should be exact on the full name, or on `(file, ancestorTitles, title)`.

### M3 — duplicate full names: kills are copied between cases

`judgeCases` builds `new Map(under.cases.map(row => [caseKey(row), row]))`, and the last row per name wins.
Real vitest results:

```
strong "caps at max" then weak "caps at max"   verdict=survived  cases=[survived, survived]   (a real kill → SURVIVED, exit 1)
weak "caps at max" then strong "caps at max"   verdict=killed    cases=[killed, killed]       (the weak case recorded killed)
```

On the Stop and nudge side, the duplicated title is already in the baseline title set. `newTitles=[]`, so
`requireCases` is empty and any kill certifies: an inserted weak duplicate leaves `stale=false`, nudge `SILENT`.

### M4 — titles the regex cannot see: Stop and nudge both silent

The receipt killed only through the old strong case, and every new case survived (real vitest):

```
identifier-title   const T = "boundary"; it(T, weak)              newTitles=[]  stop=NO-HIT  nudge=SILENT
tagged-each        it.each`\n n\n ${5}\n`("weak $n", weak)       newTitles=[]  stop=NO-HIT  nudge=SILENT
each-paren-table   it.each([[String(5)]])("weak %s", weak)        newTitles=[]  stop=NO-HIT  nudge=SILENT
```

`(?:\([^)]*\))?` stops at the first `)` inside an `.each` table. A tagged template has no `(`. An identifier is not a
literal. `countTestCaseOpeners` counts none of the three, so `newCaseCount=0` and the Stop check returns no hit at
all. The round-3 L4 class is still open by these routes. The underlying limit is unchanged: a regex over source
cannot enumerate cases. The case list vitest reports for the HEAD bytes against the current bytes is the reliable
source.

### M5 — `.test(` is read as a case

`\b(?:it|test)…\(` also matches `/re/.test("…")`. Two consequences:
- Masking (N10): HEAD holds `expect(/w/.test("weak boundary"))`. The edit drops it and adds `it("weak boundary", weak)`.
  The title is "not new", the counts are unchanged, and the result is `stop=NO-HIT nudge=SILENT`.
- Phantom case (P3): adding `expect(/a/.test("abc"))` inside an existing case gives `newTitles=["abc"]`. The nudge then
  demands that a case named `abc` be killed: `a fresh kill proof covers this file, but not the newly added case(s): abc`.
  No proof can satisfy that.

### M6 — same-count swap: the Stop check and the nudge disagree (policy)

The edit deletes old strong `it("old")` and adds weak `it("new weak")`. Real vitest gives `killed:caps at max,
survived:new weak`. The Stop check returns **NO-HIT**, because the growth rule reads a swap as a rename. The nudge says
`…not the newly added case(s): new weak`. CLAUDE.md documents the rename silence as deliberate, but the two surfaces
judge the same bytes differently, and the Stop check lets a strong case be replaced with a weak one.

### M7 — real kills that can never certify

`CASE_TITLE_RE` returns the SOURCE text of the title, while vitest reports formatted names:
- `it("says \"max\"")` is killed, but the required title is `says \"max\"` and vitest reports `says "max"`. Result: Stop
  stale, nudge fires forever.
- `it.each([5, 6])("caps %i")` has both rows killed, but the required title is `caps %i` and vitest reports `caps 5`
  and `caps 6`. Same result.
- `` it(`caps at ${m}`) `` is never matchable either (template). Only safe-by-accident.

The agent is told to prove a case it has already proven.

### M8 — `kill-proofs --verify` exits 1 forever after any test edit

Receipt ids bind the test bytes, so a re-proof writes a NEW receipt and the old one is never retired. Real CLI run:

```
prove (committed) → verify: FRESH                                     exit=0
edit test, re-prove, commit → 42023698… KILLED STALE: test … changed
                               c96aa3d7… KILLED FRESH                 exit=1
```

Any killed receipt that has gone stale fails the check, even when a fresh committed proof covers the same
source × mutant × test file. Used as a gate, `--verify` goes red after the first iteration and stays red. Directions:
judge per (source, mutant, test file) by the newest receipt, or retire superseded receipts on write.

### M9 — `uncommittedPaths` trusts `git status`

`git update-index --skip-worktree <test>` (or `--assume-unchanged`) hides a modified file from `git status --porcelain`.
After a proof on modified bytes, `kill-proofs --verify` printed `FRESH` (exit 0), and once the flag was cleared the
same file showed ` M`. The N8 claim ("FRESH = the proven bytes are committed") is false here. Comparing sha256 of
`git show HEAD:<path>` and of the index blob (`git ls-files -s`) to the receipt's hash does not depend on index flags.

### M10 — Stop cost grows with every receipt ever written (measured)

10,000 receipts naming one test file (`scratch/r4/perf.ts`):

```
rebuildKillProofIndex                 324 ms
Stop: freshKillsForTest              1255 ms
Stop: freshKillsForTest(other file)  1106 ms   ← no path filter: every receipt read, digested, env captured
PostToolUse nudge                    1193 ms   (all 10k rows name the file)
writeKillProof (one more)             278 ms   (re-reads all receipts to rebuild the index)
```

At 1,000 receipts the numbers are 116–176 ms. `freshKillsForTest` should filter index rows by `tests[].path`, as the
nudge does. `environmentReasons` re-runs `captureEnvironment` (createRequire + config hash) for every receipt and
could be computed once per call. Receipts are never garbage-collected (M8), so the count only grows.

### M11 — low

- A receipt copied to another valid name (`aaaaaaaaaaaaaaaa.json` holding id `42023698…`) is listed under the file
  name and is FRESH. The index then holds two rows with the same id, and `freshKillsForTest` counts the copy twice.
  `readKillProof` does not check `receipt.id === id`.
- `uncommittedPaths` strips quotes but not git's C-quoting: `test dir/clamp \303\251.mutation-kill.test.ts` is printed
  with octal escapes. Display only, but `-z` would give the real path. Spaces and staged renames still report
  UNCOMMITTED (non-empty line).
- Listing order is by id (a hash), not by `provedAt`, and there is no limit: 10k receipts print 30k lines.

## Held (attacked, no defect found)

- `receiptCertifies` per file: a receipt whose `killedTests` disagrees with its cases fails `integrityReasons`. With one
  fresh-but-survived and one stale-but-killed receipt, the nudge says "went stale" and the Stop check stays open. A
  duplicate `--test` is deduped by `normalizeTestPaths`.
- Two receipts with one id and different digests mean identical inputs, and the last atomic rename wins (ARGUED).
- `--verify` exit codes: `uncommitted` alone exits 0, and a stale killed receipt exits 1 (as documented; see M8 for
  the consequence).
- `--json`: every path parses (killed, inconclusive product crash, unavailable load error). The only absolute paths
  are `receipt.root` and `receiptPath`, with no temp-copy paths, env or secrets. A product crash records only
  `Error: boom`.
- `describe.each` / `test.concurrent.each([...])` with literal inner `it` titles and no `)` in the table parse as
  expected.

## Suggested order

M1 (one glob, critical: it re-opens round-3 L2 entirely), M3 (wrong receipt verdicts), M2/M4/M5 (derive new cases
from vitest's reported case list for HEAD vs now, and match full names exactly), M8 (a gate that is always red is
not read), M9, M10.
