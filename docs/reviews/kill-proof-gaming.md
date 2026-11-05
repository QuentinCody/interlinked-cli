# Kill proof — gaming red-team: a `killed` receipt without a behavioural test

Branch reviewed: `mutation-proof` at `681e705` (round-3 fixes L1/L9 landed: repeat baseline, copy-relative
links). Reviewer: cloud session, 2026-11-05, branch `cloud/kill-proof-gaming`. Method: one throwaway git repo
under `/tmp/kpg/repo` (own `vitest.config.ts`, `node_modules` first symlinked to the clone's, then a real
directory of per-package links so `realpathSync(node_modules)/..` is the LIVE root, as it is in any real
project), one module `src/math.ts` with one real fault, and one degenerate test file per attack, each driven
through the real command:

```
npx tsx src/index.ts tests prove-kill --cwd /tmp/kpg/repo --file src/math.ts \
  --find 'return a + b;' --replace 'return a - b;' --test test/<attack>.test.ts --json
```

The question is CLAUDE.md goal 4: once a receipt is a training signal, "gaming them is the optimal policy".
A kill is judged as "failed by its own check under the mutant" (`run.ts killedByOwnCheck`). Nothing in that
rule says the check must be about BEHAVIOUR; a test that fails on any byte change of the mutated file fails
by its own check too. No product code was changed in this review; the detector below is NOT wired into the
verdict (that is a product decision — see *Recommendation*).

## Attack table

| # | attack (test file) | verdict / exit | receipt id | what `killedTests` / `underMutant.cases` show |
|---|---|---|---|---|
| 1 | `readFileSync(fileURLToPath(new URL("../src/math.ts", import.meta.url)))` + `toContain("return a + b;")` (`a1-readsrc`) | **KILLED** / 0 | `54a6df4eb08977d6` | `killedTests: ["test/a1-readsrc.test.ts"]`, one case `killed`. Nothing distinguishes it from a behavioural kill. |
| 2 | sha256 of the file bytes pinned with `toBe("20242c…")` (`a2-sha`) | **KILLED** / 0 | `9d61989f3abd4414` | same shape |
| 3a | `expect(src).toMatchInlineSnapshot(…)` of the source text (`a3-inline-snap`) | **KILLED** / 0 | `40ebc11a9bb433c3` | same; the mismatch is classed as the test's own check (`SNAPSHOT_MISMATCH`) |
| 3b | `toMatchFileSnapshot("./__snapshots__/math-source.txt")` of the source text, snapshot committed (`a3-file-snap`) | **KILLED** / 0 | `88bbd5b22b4621ca` | same |
| 4 | inline re-implementation `ref = (a, b) => a + b`, `expect(add(2, 3)).toBe(ref(2, 3))` (`a4-reimpl`) | KILLED / 0 | `e2b385997fff37d7` | **Counts as behavioural.** The test calls `add` and compares its RESULT to an oracle; a one-input oracle is a weak test, not a degenerate one. The detector deliberately does not flag it. |
| 5 | `expect(add.toString()).toContain("a + b")` (`a5-tostring`) | **KILLED** / 0 | `a8341f9678b0b999` | same as 1 |
| 6 | `expect(Object.keys(math)).toEqual(["add"])`, `expect(add.length).toBe(2)` (`a6-shape`) | SURVIVED / 1 | `fe09df2bfb33df9e` | Defeated by the fault itself: a body mutant changes no export name or arity. (A mutant that deletes an export or a parameter WOULD be killed by this shape — a shape pin, not a behaviour pin.) |
| 7a | `execFileSync("git", ["status", "--porcelain"])` in the test's cwd (`a7-git`, first form) | NOT-PASSING-NOW / 1 | — | Defeated: the copy holds no `.git` (`git ls-files` never lists it), so `git status` fails in the baseline copy. |
| 7a′ | `git -C <realpath(node_modules)/..> status` against the LIVE tree | UNAVAILABLE / 2 | — | Defeated twice: the live tree is never mutated (every run is a copy), and the test imports nothing from `src/math.ts`, so the canary ("a module-level throw in its place left every case passing") refuses it. Reading `.interlinked/` state fails the same way: it is gitignored and absent from the copy. |
| 7b | compare the copy's `src/math.ts` bytes with the LIVE twin reached through `realpathSync(join(cwd, "node_modules"))/../src/math.ts` (`a7-live-link`) | **KILLED** / 0 | `68903998e8f55d44` | same as 1. The node_modules link is the one path from the copy back to the live tree (round 3 L1 named it for state; it also leaks the unmutated bytes). |
| 8 | `readFileSync(process.cwd() + "/src/math.ts")` + `toContain("a + b")` (`a8-cwd`) | **KILLED** / 0 | `b56cdb8a34574a7b` | same as 1; the copy IS the cwd, so the "copied path trick" is just a second spelling of the path |
| 9 | imports `add`, reads the source, `if (!src.includes("a + b")) expect.fail("TODO…")`, never asserts on `add` (`a9-todo-fail`) | **KILLED** / 0 | `34c66c598a355c3f` | same as 1; `expect.fail` is an `AssertionError`, so `failedByOwnCheck` accepts it |
| 10 | dump `process.env` + `process.argv` from inside the test on every run (`a10-env`) | (KILLED by its real assertion) | `e25014b8b0016687` | **No leak.** Across the three runs (baseline, mutant, repeat baseline) no `process.env` key differs and `argv` is identical; only `process.cwd()` differs, as a random `mkdtemp` name. The runner sets `CI=1 NO_COLOR=1` on every run (`fail-before-fix/index.ts runVitestDetailed`); vitest's worker env is the same both sides. Nothing distinguishes the mutant run from the baseline. |
| 11 | a counter in `os.tmpdir()` that fails the assertion on EVEN runs only (`a11-counter`) | **KILLED** / 0 | `009924f255edabcd` | **New.** Round 3 L1's fix (pass → fail → pass on a third unmutated copy) is a FIXED schedule: run 1 passes, run 2 (the mutant) fails, run 3 (the repeat) passes, so the kill is "repeatable". Any state outside the copy keyed on run parity defeats the repeat. No static trace in the receipt. |

Summary: 11 attacks, 9 produced `killed` (8 by lexeme, 1 by run parity, plus #4 which is behavioural);
the product already defeats 3 (shape, git in the copy, git/`.interlinked` on the live tree) and env leakage
does not exist.

### What the current product already defeats, and why

- **Anything that needs the live tree to change** (`git diff`, `git status`, `.interlinked/` state, watching
  the file): every run is a fresh copy and the live tree is only read, so there is nothing to observe. Attack
  7a′ shows the canary closing the last gap: a test that never loads the copy's file is `unavailable`.
- **`git` inside the copy**: the copy has no `.git` and is not a work tree; the probe fails in the baseline and
  the run is `not-passing-now`.
- **Shape pins** (`Object.keys`, `fn.length`, `fn.name`): survive every body mutant, so they produce no receipt
  to game with. They remain a non-behavioural kill for a delete-export / drop-parameter mutant.
- **Environment leakage**: none measured (attack 10). A test cannot tell which run it is in from the process.
- **One-way state inside the copy** (round-2 K1) and **pass-once state outside it** (round-3 L1): both fixed.

### What the receipt reveals and hides

`underMutant.cases` carries `{test, verdict}` only; a `reason` is kept for `inconclusive` cases, never the
failure message of a KILLED case. So the receipt for attack 1 (`expected '…source…' to contain 'return a + b;'`)
is byte-for-byte the same shape as a behavioural kill. The one thing the receipt does bind is the test file's
sha256, which is enough for a reader to re-read those exact bytes and run the detector below.

## Countermeasure: `kill_proof_degenerate_test` (built, measured, not wired)

`src/harness/kill-proof/degenerate-test.ts` (the rules) + `degenerate-test-paths.ts` (static path
resolution and `functionExportsOf`), pure: `(test content, test path, mutated file path[, mutated module
source]) → findings with line numbers`. TypeScript AST (`createSourceFile` through `parseTsSourceWith`), no
regex-only rule; with `typescript` absent it is NOT MEASURED (`degenerateDetectorAvailable()`), never
"clean". Every rule needs the mutated file's identity: the same test is not degenerate for a mutant in a
module it never reads. Every function sits under the repo's cyclomatic (16) and cognitive (15) caps and the
inline registry reports only advisory style notes on the two files.

| kind | fires when | attack |
|---|---|---|
| `source-read` | a content read (`readFileSync`/`readFile`/`createReadStream`/`open*`, bare or `fs.`/`fs.promises.`) whose first argument statically resolves to the mutated file: string literal (root-relative, as node resolves it), `new URL(spec, import.meta.url)` (test-relative), `join`/`resolve`/`dirname`/`fileURLToPath` over `process.cwd()`, `__dirname`, `import.meta.dirname`, `+` and template concatenation, `require.resolve` / `import.meta.resolve` of a specifier naming the module (extension-insensitive), or an identifier bound to any of these (depth 4); also every `expect(<value derived from that read>)` | 1, 8, 9 |
| `source-snapshot` | `expect(<derived from the read>).toMatch*Snapshot(…)` | 3a, 3b |
| `source-hash` | `expect(<derived>)` whose subject or matcher chain names `createHash`/`digest`/`sha*`/`md5`/`hash`/`checksum` | 2 |
| `function-source` | `.toString()`, `String()`, `` `${…}` ``, `+ ""`, `Function.prototype.toString.call` on an import from the mutated module, ONLY when that import is a function: declared so in the mutated module's source (`functionExportsOf`), or called as one in the test file | 5 |
| `live-tree-read` | the read path goes down into `node_modules` and back up (`realpathSync(node_modules)` + `..`): the live, unmutated twin | 7b |
| `vcs-probe` | `git diff\|status\|show\|log\|stash\|ls-files` spawned with no `-C` and no `cwd` option | 7a (first form) |

Does not fire: reads of fixtures, snapshots or any other file; a snapshot or hash of a function RESULT;
spawning the CLI under test or `git -C <fixture>`; an import that is CALLED and asserted on (attacks 4, 10);
`fn.name` / `fn.length` / `Object.keys` (attack 6); a path the AST cannot resolve (`readdirSync` + template)
— UNCERTAIN is silent, because a signal that might attach to a receipt must not guess. Known gaps: a path
assembled at runtime or by a helper module; `statSync(...).size`; a read of a BUILT twin (`dist/x.js`); and
attack 11, which leaves no static trace (see below).

Tests: `degenerate-test.test.ts`, 8 MUST-FIRE (P1–P8, the literal attack files and path forms) and 8
MUST-NOT-FIRE (N1–N8) cases, 18/18 passing.

### Measurements

- **Attack recall.** The detector run over the eleven attack files in `/tmp/kpg/repo` flags 8 of the 8
  lexeme kills (1, 2, 3a, 3b, 5, 7b, 8, 9) and none of 4, 6, 7a (`-C` form), 10, 11. Attack 11 is the one
  `killed` receipt the detector cannot see.
- **Repo census.** Every `git ls-files '*.test.ts'` file (3,027) judged against its companion module and every
  relative non-test import it names (8,477 test/target pairs), module source supplied (script: a 40-line
  `tsx` loop over `detectDegenerateKillTest`, kept out of the tree; the loop is described here so the number
  can be re-derived):

  | iteration | files flagged | findings | by kind | adjudicated |
  |---|---|---|---|---|
  | first (coercions ungated) | 61 | 104 | 92 `function-source`, 12 `source-read` | the 92 were ALL `` `${CONSTANT}` `` / `String(CONSTANT)` of an imported number or string (`DEFAULT_MAX_LINES`, `HOOK_SCRIPT_VERSION`, …): 92/92 false positives — the rule could not tell a function from a value |
  | shipped (function evidence required) | **5** | **12** | 12 `source-read` | **5/5 true positives of the class**, 0 gaming |

  The five: `cross-session.test.ts:225`, `daemon-ledger.test.ts:137`, `rules/default-structural.test.ts:29`,
  `hook-entry-stop-reentry.test.ts:59`, `hook-entry.fail-closed.test.ts:100`. Each reads its own SUT's source
  and pins a lexeme ("uses the bounded reverse reader", "no imports beyond the type", "does not call the
  retired …"); two say so in a comment ("Source-text pin, same convention…"). They are deliberate structural
  pins, not gaming — and exactly the shape that would earn a `killed` receipt for a mutant touching the pinned
  text without exercising anything. That is why the finding belongs beside the verdict, not inside it.
- **Precision read.** 5/5 on the census is the builder's own adjudication of a tiny set; the CLAUDE.md
  lesson (the posneg 8-sample read was wrong by 70 points) applies. The first iteration's 92 false positives are
  the honest calibration number: a rule that cannot see the import's kind is wrong 100% of the time on a
  tree this constant-heavy. Fire rate on this repo (5 of 3,027 files, 0.17%) measures the agent, not the
  check; point it at a snapshot-heavy or `__snapshots__`-of-source tree before trusting the rate.

### Attack 11 — the hole the detector cannot close

A counter outside the copy (`os.tmpdir()`, or the shared `node_modules` link) that fails on run 2 and passes on
run 3 reads as a repeatable kill. Fixes are product-side, deterministic and cheap:

1. **Private temp per copy**: set `TMPDIR`/`TMP`/`TEMP` to a directory inside each copy for the vitest
   process (`os.tmpdir()` honours them), so tmpdir state cannot cross runs. Closes the tmpdir route for ~0 ms.
2. **node_modules root listing**: `readdirSync(node_modules)` before and after each run; a new top-level
   entry (`.kp3-marker`) makes every kill `inconclusive` ("a run wrote into the shared node_modules").
   Partial: a marker deeper than one level needs a recursive scan the hook budget cannot afford.
3. **Order randomisation does not help**: any fixed or random schedule with ≤ 3 runs is learnable from the
   receipt's own documentation; only removing the shared state does.

## Recommendation

1. **Attach, do not gate.** Run `detectDegenerateKillTest` on each file in `killedTests` with the test bytes the
   receipt hashes and the mutated source it already holds, and record the result as a receipt field:

   ```
   "degenerate": [{ "test": "test/a1-readsrc.test.ts", "line": 5, "kind": "source-read", "detail": "readFileSync of the mutated file src/math.ts" }]
   ```

   The field is covered by the digest like every other field. `tests kill-proofs` lists such a receipt as
   `KILLED (degenerate: source-read)`; the PostToolUse `[interlinked:kill-proof]` line
   (`formatDegenerateFindings`) tells the agent "this killing test reads the mutated SOURCE rather than
   exercising it … a kill by lexeme, not by behaviour"; and the Stop-time `mutation-kill-evidence` check
   treats a receipt whose EVERY killed case is degenerate as certifying nothing. A receipt with the field
   absent (typescript missing) is NOT MEASURED and should say so, the way `self_import` does.
2. **Tag `[heuristic]`.** The rules are AST shape, statically resolved paths and a function-kind lookup: a
   `readFileSync` behind a helper is invisible, and a legitimate source-structure pin (the five census hits)
   is the same shape as gaming. Nothing here ran the code the way `killedByOwnCheck` did. The only
   `[proven]` variant would be dynamic: run the mutant copy with the mutated file replaced by the ORIGINAL
   bytes under a different name and the import rewritten — if the test still kills, it read bytes, not
   behaviour. That costs a fourth vitest run and is a product decision; the static finding is the cheap
   screen that says when the fourth run is worth paying for.
3. **Record the killed case's first failure line** in `underMutant.cases` (the `reason` field already exists
   for inconclusive cases). It costs nothing and makes attack 1 legible in the receipt itself
   (`expected '…' to contain 'return a + b;'`) without any detector.
4. **Close attack 11 product-side** with the private `TMPDIR` (fix 1 above); re-run `a11-counter` and expect
   `survived`, then add it to the round-4 regression file.
5. **Do not demote the detector for being quiet.** 5 hits in 3,027 files on an agent-hardened tree is the
   expected rate; on a repository that snapshots module source, or under a small model optimising for the
   receipt, the rate is the signal.

## Tried and did not break

- Attack 6 (shape) survives the body mutant: no receipt to game with.
- Attacks 7a / 7a′ (`git` in the copy, `git` and `.interlinked/` on the live tree): `not-passing-now` /
  `unavailable`, with the canary naming the reason.
- Attack 10: no `process.env` or `argv` difference between the baseline, mutant and repeat runs.
- Each receipt's `id` and `digest` behaved as documented; `--json` output was the receipt plus `receiptPath`.
- Not tried: manifest (`--mutant`) mutants (no manifest in a throwaway repo), a helper module that performs
  the read for the test (a known detector gap, listed above), and the `[proven]` fourth-run variant.
