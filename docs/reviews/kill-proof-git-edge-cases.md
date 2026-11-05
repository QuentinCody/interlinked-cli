# Kill proof under real git and platform conditions

Branch `cloud/git-edge-cases`, based on `mutation-proof`. Linux x64, node 22,
vitest 4.1.11, run on 2026-11-05. Every scenario ran the real command,
`npx tsx src/index.ts tests prove-kill … --json --cwd <repo>`, against a
throwaway git repository under `/tmp/kpge/` with its own `vitest.config.ts` and
the clone's `node_modules` symlinked in. The fault is `src/clamp.ts`
`n > max` → `n < max`, and the strong test kills it on the live tree. The
baseline repository gives `killed`, exit 0, and `--verify` reports FRESH.

The wrong verdicts are pinned as failing tests in
`src/harness/kill-proof/review-regressions-git.test.ts` (N1–N9). Product code
is not changed on this branch.

## Results

| # | Scenario | Verdict | Exit | Judgement | Cause |
|---|---|---|---|---|---|
| 1a | source is a symlink to a file **outside** the repo | raw `{"error":"comparison write would follow a symlink"}` | 2 | unhelpful: safe (the outside file is untouched), but not a structured `unavailable`, and the whole baseline ran first | `run.ts:181` `copyWriteTarget` throws after the baseline at `run.ts:176` |
| 1b | source is a relative symlink inside the repo | same raw error | 2 | unhelpful (same). Naming the link **target** (`--file lib/clamp.ts`) gives `killed` | same |
| 1d | source is an **absolute** symlink into the same repo; mutate the target | `survived` | 1 | **wrong** (N1): the copy's link points back at the live target, so the tests never load the mutant | `fail-before-fix/snapshot.ts:43` copies `readlinkSync` verbatim |
| 2a | test file is a relative symlink inside the repo | `killed`; editing the link target makes `--verify` STALE | 0 / 1 | correct | — |
| 2c | test is a symlink to a file outside the repo whose import resolves outside | `survived` | 1 | correct: that test really does not exercise `src/clamp.ts` | — |
| 2d | test file is an **absolute** symlink into the same repo | `survived` | 1 | **wrong** (N2) | `snapshot.ts:43` |
| 3a | CRLF source, no `core.autocrlf` | `killed`, FRESH. A `--find` holding `\n` gives "anchor occurs 0 times"; `\r\n` works | 0 / 2 | correct. The anchor message does not mention CRLF, which is unhelpful | `resolve.ts:110` |
| 3b | `core.autocrlf=true` (index LF, work tree CRLF) | `killed`, FRESH. An LF re-checkout makes it STALE "source changed" | 0 | correct: the receipt binds bytes, and the doc says so | — |
| 3c | `.gitattributes eol=crlf` | `killed` | 0 | correct | — |
| 4 | `git mv` the source after the proof | `--verify` STALE "source src/clamp.ts no longer exists". An explicit fault at the new path gives `killed` and a new FRESH receipt. The old path gives `unavailable` "does not exist" | 1 / 0 / 2 | correct. Unhelpful: the stale receipt keeps `--verify` at exit 1 forever, even with a fresh replacement, and there is no prune | `tests-prove-kill.ts:131` |
| 5a | untracked, not-ignored helper imported by the test | `killed` | 0 | correct (`-co` includes it) | — |
| 5b | untracked mutated source and untracked test | `killed` | 0 | correct | — |
| 5c | **ignored** helper imported by the test | `unavailable` "reported no executed test case in the baseline copy" | 2 | unhelpful: the verdict is acceptable, but the message names neither the ignored file nor the load error | `run.ts:78` |
| 5d | **ignored** fixture read with `readFileSync` | `not-passing-now` "ENOENT … fixtures/cases.json" | 1 | **wrong** (N3): says the test fails on the live tree, where it passes. The guide says the baseline runs on the live tree, but the code runs it in the copy | `run.ts:176`, `run.ts:4-7`; doc step 2 |
| 5e | ignored fixture read optionally (`existsSync ? … : []`) | `survived` | 1 | **wrong** (N4): passes vacuously in the copy | `snapshot.ts:18` (ignored files are never copied) |
| 5f | ignored mutated source | `unavailable` "not visible to git" | 2 | correct | `run.ts:174` |
| 6a | submodule; the parent test imports a submodule helper | `unavailable` "no executed test case" | 2 | unhelpful: a gitlink is listed as a directory, which `copyEntry` skips, so the submodule is empty in the copy and the message does not say so | `snapshot.ts:41-44` |
| 6b | mutate a file inside the submodule | `unavailable` "not visible to git (ignored or outside the work tree)" | 2 | acceptable; the message is misleading because the file is in a submodule | `run.ts:174` |
| 6c/d | untracked nested git repo (not a submodule) | `unavailable` for both a mutation inside it and an import from it | 2 | acceptable / unhelpful (as 6a/6b) | `snapshot.ts:41-44` |
| 6e | project is a subdirectory of a git repo (`--cwd pkg/`) | `killed` | 0 | correct | — |
| 7 | index ≠ work tree: weak test staged, strong test in the work tree | `killed` (work-tree bytes certified, `tests[].sha256` = work tree). After `git commit` of the weak staged version, `--verify` reports FRESH, exit 0. Proving the committed bytes gives `survived` | 0 / 0 | **wrong for any commit-time reader** (N8): the receipt records no index or HEAD identity, and `--verify` hashes only the work tree | `receipt.ts:52-56`, `receipt.ts:241` |
| 8a | `.gitignore` ignores the test directory (test untracked) | `unavailable` "baseline run failed: missing test file(s)" | 2 | acceptable; unhelpful (it does not say the file is ignored) | `snapshot.ts:18`, `fail-before-fix/index.ts:71` |
| 8b | the same, with the test force-added | `killed` | 0 | correct | — |
| 8c | force-added test importing an ignored sibling helper | `unavailable` "no executed test case" | 2 | acceptable / unhelpful (as 5c) | `run.ts:78` |
| 9a | `test.root: "app"` | `killed` | 0 | correct | — |
| 9b | `test.dir: "src"` | `killed` | 0 | correct | — |
| 9c | `include` does not match the named test | `unavailable` "no executed test case" | 2 | acceptable; unhelpful (it does not say "not matched by include") | `run.ts:78` |
| 9d | tracked `setupFiles` defines a value the test uses; edited after the proof so the test **fails live** | `killed`, then `--verify` FRESH, exit 0 | 0 / 0 | **wrong** (N9): the config's bytes are bound, but the files it declares are not | `receipt.ts:68` |
| 9e | ignored `setupFiles` | `unavailable` "no executed test case" | 2 | acceptable / unhelpful | `run.ts:78` |
| 9f | non-default config (`vitest --config vitest.unit.config.ts` in `scripts.test`) | `not-passing-now`, "expected 5 to be 3" | 1 | **wrong** (N5): `npm test` passes; `prove-kill` has no `--config` and runs default discovery | `fail-before-fix/index.ts:75`, `receipt.ts:29` |
| 9g | `vitest.config.mts` | `killed`; config bound | 0 | correct | — |
| 10a | `vi.mock` factory reads a fixture by absolute path in the live tree | `killed`; after the live fixture changed (test fails live) `--verify` is FRESH | 0 / 0 | correct verdict. The staleness gap is the documented "helpers are not bound" limit | doc "Limits (v1)" |
| 10b | `vi.mock` factory `import()`s the source by its absolute live path | `survived` | 1 | **wrong** (N6) | no reachability check; `run.ts:181-182` |
| 10c | `resolve.alias` hardcoded to the live `src/` | `survived` | 1 | **wrong** (N7) | same |
| 11 | `kill-proof.story.test.ts` + `kill-proof.test.ts` on Linux | 2 files, 41/41 passed (85 s) | 0 | correct | — |

## Acceptable as documented

- Any `unavailable` / `inconclusive` that the copy causes: ignored helpers or
  setup files (5c, 8c, 9e), an ignored test (8a), `include` mismatches (9c), and
  submodules or nested repositories (6a–d). The proof decides nothing in these
  cases and says so, with exit 2.
- Line-ending and `autocrlf` flips stale a receipt (3b). It binds bytes, and the
  guide says so.
- A rename stales a receipt, and a fresh proof at the new path works (4).
- Unbound imported helpers and fixtures read by path (10a) are the "Limits (v1)"
  item.

## What must change

1. **Absolute symlinks escape the copy (N1, N2).** `snapshot.ts:43` recreates
   a link to its recorded target, so a link to `<root>/…` points the copy back
   at the live tree. Rewrite a target under the root to the same relative
   location inside the copy. Otherwise refuse (`unavailable`) when a link the
   run depends on resolves into the live root.
2. **Live-tree reachability (N6, N7, and N1/N2 as a backstop).** A `survived`
   is only meaningful if the tests loaded the copy's mutated file. Before
   recording `survived`, run a canary: put a module-level `throw` in the copy's
   mutated file. If the named tests still pass, the file was never loaded, so
   the result is `unavailable` "the tests do not load <file> from the copy
   (absolute path, alias or symlink into the live tree)".
3. **Baseline location and verdict wording (N3, N5).** The guide (step 2) says
   the baseline runs on the live tree. `run.ts` runs it in the copy, and a
   failure there is labelled `not-passing-now` ("fails on the live tree",
   exit 1, "fix the test"). Either run the baseline on the live tree as well,
   so that "passes live, fails in the copy" becomes `unavailable` (the copy
   differs: ignored files, config), or rename the reason, keep exit 2, and fix
   the guide.
4. **Non-default config (N5).** Accept `--config <file>`, or read it from
   `scripts.test`. Pass it to vitest and bind its hash. Add `.cts`/`.cjs` to
   `CONFIG_NAMES` (`receipt.ts:29`).
5. **Config-declared inputs (N9).** Hash the `setupFiles` / `globalSetup` the
   bound config names, or say in the guide that only the config file's own
   bytes are bound.
6. **Index vs work tree (N8).** Record the index and HEAD blob ids of the
   source and tests. Make `--verify` report "work tree differs from the
   index / HEAD" (as project-e2e's `--staged` target does, PE-35), or add a
   `--staged` mode that proves the index bytes.
7. **Vacuous pass from ignored fixtures (N4).** Neither the copy nor a second
   baseline detects this. At minimum, list in the receipt the ignored files
   under the test's directories, and warn that the copy lacks them.
   Alternatively, copy the ignored non-bulk files the live baseline opened.
   This is the hardest item; until it is done, the guide must say a `survived`
   can be vacuous when tests read ignored data.

Unhelpful but not wrong, worth a small fix: 1a/1b should return a structured
`unavailable` before the baseline runs. "No executed test case" (5c, 6a, 8c,
9c, 9e) should carry vitest's load error or "not matched by include". A
`--find` containing `\n` should mention that the file has CRLF line endings.
`kill-proofs --verify` should offer a prune, or ignore a stale receipt whose
mutant has a fresh successor (4).
