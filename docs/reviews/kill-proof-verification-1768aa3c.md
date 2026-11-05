# Kill-proof branch verification (`mutation-proof`, task id 1768aa3c)

Independent cloud verification run, 2026-11-05. No product changes were made; this file is the only commit.

## Target and environment

| | |
|---|---|
| Branch verified | `origin/mutation-proof` at **`50bfdbc23cc437c7433aa252edb4ecaae6015be2`** (a merge of `origin/cloud/real-kills-2`). The task id names `1768aa3` (the kill-proof docs commit), which is 2 commits below the head; the head is what was verified. |
| Compared against | `origin/main` at `efe5d8f` |
| Node | v22.23.4 |
| vitest | 4.1.11 (linux-x64) |
| Platform | Linux 6.18.44 x86_64, running as **root (uid 0)**, which matters for the failures below |
| Install | `npm ci` (clean) |

## Results

| # | Command | Result | Summary line |
|---|---|---|---|
| 1 | `npm run typecheck` | **PASS** | `tsgo --noEmit && tsgo --noEmit -p landing/tsconfig.json`, exit 0, no diagnostics |
| 2 | `npx vitest run --reporter=dot` | **FAIL** | `Test Files  33 failed \| 2984 passed \| 3 skipped (3020)` / `Tests  52 failed \| 66384 passed \| 4 expected fail \| 36 skipped \| 1 todo (66477)`, Duration 850.51s, exit 1 |
| 3 | `npm run docs:check` | **PASS** | `docs OK (124 rules · 7 runners · 3 modes · Node 22+ · 911 verified blocks / 3834 logged)` (one warning: `data_as_of is 65 days old`) |
| 4 | `npm run build` + both `--help` | **PASS** | build exit 0; both help commands exit 0 (text below) |
| 5 | `npm run build:e2e && npm run test:e2e -- kill-proof-nudge` | **PASS** | `Test Files  1 passed (1)` / `Tests  3 passed (3)`, Duration 5.01s; `npm run build` re-run afterwards, exit 0 |
| 6 | built-CLI walkthrough in `/tmp/kp-verify-repo` | **PASS** | killed exit 0 · survived exit 1 · inconclusive exit 2 · unavailable exit 2 · `--verify` FRESH (exit 0) then STALE (exit 1) |
| 7 | branch size | **PASS** (info) | `git log --oneline origin/main..HEAD \| wc -l` = **27**; `git diff --stat origin/main...HEAD \| tail -1` = ` 63 files changed, 5487 insertions(+), 22 deletions(-)` |

## Step 2 failures, classified

I re-ran all 33 failing files once (`npx vitest run --reporter=dot <33 files>`): `Test Files  33 failed (33)`, `Tests  54 failed | 771 passed (825)`. All 52 failures from the full run reproduced, so none of them is a flake. Two more `block-fingerprint-session.test.ts` cases failed in the isolated re-run (`arms a fingerprint from the command when the event is blocked`, `fast-exits (no arming) on an allowed event when nothing is armed`), so that file depends on test order.

None of the 33 failing test files is modified by the branch (`git diff --name-only origin/main...HEAD`). To separate causes, I ran two more checks:

* **As non-root** (`setpriv --reuid 65534`, the 31 non-CLI files): `Test Files  5 failed | 26 passed (31)`. So 26 files fail **only because the container runs as uid 0**: their "unreadable / permission denied" fixtures use `chmod`, which does not restrict root.
* **On `origin/main` (`efe5d8f`) as root** (the remaining 5 files plus the 2 CLI-parity files): `Test Files  5 failed | 2 passed (7)`. The 5 files fail on main too, so they are **not caused by the branch**. The two CLI-parity files **pass on main and fail on the branch**.

### A. Regressions introduced by the branch (2 tests, fail on branch, pass on main)

| Test | First assertion line |
|---|---|
| src/cli-program.test.ts > printed-command parity over product source > every printed 'interlinked …' command exists in the commander tree | `AssertionError: expected [ Array(1) ] to deeply equal []` |
| src/commands/__tests__/cli-spec-surface.test.ts > CLI spec surface — every registered option is exercised by a test > no UNPINNED option is test-silent, and the pinned list only shrinks | `AssertionError: new CLI options with no test mention — add a behavior-pinning test (or, exceptionally, pin here with a comment): expected [ '--vitest-config' ] to deeply equal []` |

Details:

* `src/cli-program.test.ts:177`: the printed-command parity scan finds `"src/harness/kill-proof/run.ts:50 interlinked kill-proof canary — unknown command \`kill-proof\`"`. The canary string `throw new Error("interlinked kill-proof canary: …")` reads like a printed `interlinked <command>`. Either the message wording or the scanner needs a change.
* `src/commands/__tests__/cli-spec-surface.test.ts:95`: `new CLI options with no test mention … expected [ '--vitest-config' ] to deeply equal []`. Commit `7362d63` added `prove-kill --vitest-config`, and no test mentions it.

### B. Already failing on `origin/main` (5 files, 14 tests, independent of root)

| Test | First assertion line |
|---|---|
| src/harness/managed-push.test.ts > managed native push handoff > executes one frozen gate, preserves logging, and updates the receiver under umask '0022' | (vitest grouped this with an identical error; see the managed-push row with `expected null not to be null`) |
| src/harness/managed-push.test.ts > managed native push handoff > executes one frozen gate, preserves logging, and updates the receiver under umask '0002' | `AssertionError: expected null not to be null` |
| src/harness/managed-push.test.ts > managed native push handoff > refuses the actual pushed revision when syntax fails | (vitest grouped this with an identical error; see the managed-push row with `expected null not to be null`) |
| src/harness/managed-push.test.ts > managed native push handoff > refuses the actual pushed revision when coverage fails | `AssertionError: expected null not to be null` |
| src/harness/managed-push.test.ts > managed native push handoff > waits for the owned hook controller to reap its detached child after interruption | `Error: Expected native rewrite` |
| src/harness/managed-push.test.ts > managed native push handoff > refuses a changed runtime at execution and cleans its original snapshot | (vitest grouped this with an identical error; see the managed-push row with `expected null not to be null`) |
| src/harness/managed-push.test.ts > managed native push handoff > refuses a changed git-environment at execution and cleans its original snapshot | (vitest grouped this with an identical error; see the managed-push row with `expected null not to be null`) |
| src/harness/managed-push.test.ts > managed native push handoff > refuses a changed node-loader at execution and cleans its original snapshot | `Error: Expected native rewrite` |
| src/harness/project-compiler-gate.test.ts > project compiler admission > holds admission until a timed-out wrapper and its TERM-resistant child are gone | `ProjectCompilerUnavailableError: compiler admission timed out while queued` |
| src/harness/evaluator/commit-gate.defaults.test.ts > checkCommitGate — production DEFAULT_DEPS > degrades the readFile default to null on a real EACCES, and on a real missing file, without spawning a suite | `AssertionError: expected { decision: 'block', …(5) } to be null` |
| src/harness/project-e2e/services.test.ts > managed services — negative (never ready, never clean) > N5 (review D5): a worker in the OWNED group that ignores SIGTERM is escalated to SIGKILL after the leader exits; shutdown is ok only once the whole group is gone | `AssertionError: expected { ok: false, exitCode: null, …(4) } to match object { ok: true, timedOut: true, …(1) }` |
| src/harness/trajectory/block-fingerprint-session.test.ts > observeBlockWorkaround (choke-point glue) > a still-blocked retry arms but never self-counts as a workaround | `AssertionError: expected [ { …(2) } ] to have a length of +0 but got 1` |
| src/harness/trajectory/block-fingerprint-session.test.ts > observeBlockWorkaround (choke-point glue) > arms a fingerprint from a blocked Write, extracting content + target via strField | `AssertionError: expected [ …(7) ] to have a length of 1 but got 7` |
| src/harness/trajectory/block-fingerprint-session.test.ts > observeBlockWorkaround (choke-point glue) > arms with a null target when a blocked Write carries no file_path/path | `AssertionError: expected [ …(9) ] to have a length of 1 but got 9` |

### C. Fail only as root (26 files, 36 tests; pass as uid 65534)

| Test | First assertion line |
|---|---|
| src/commands/doctest.test.ts > findMarkdownFiles > keeps collecting siblings when a subdirectory cannot be listed | `AssertionError: expected [ 'README.md', 'blocked/hidden.md' ] to deeply equal [ 'README.md' ]` |
| src/commands/doctest.test.ts > findMarkdownFiles > skips an entry it cannot stat instead of collecting it as markdown | `AssertionError: expected [ 'README.md', …(1) ] to deeply equal [ 'README.md' ]` |
| src/lib/file-mutation-lock.test.ts > file mutation lock > propagates a non-ENOENT release failure instead of masking it as a clean release | `AssertionError: expected [Function] to throw an error` |
| src/lib/file-mutation-lock.test.ts > file mutation lock > propagates a non-EEXIST failure when the lock directory cannot be created | `AssertionError: expected [Function] to throw an error` |
| src/lib/local-session-reader.test.ts > bounded local session reader > skips an unreadable legacy file without hiding a readable session | `AssertionError: expected [ 'valid', 'unreadable' ] to deeply equal [ 'valid' ]` |
| src/lib/local-session-reader.test.ts > bounded local session reader > returns an empty list rather than throwing when the directory itself cannot be opened | `AssertionError: expected [ { session_id: 'valid', …(8) } ] to deeply equal []` |
| src/lib/manual-debt-markers.test.ts > manual debt marker source scanning > skips a directory whose listing cannot be read and marks it unreadable | `AssertionError: expected +0 to be 1 // Object.is equality` |
| src/lib/manual-debt-markers.test.ts > manual debt marker source scanning > skips a file whose stat cannot be read after its directory was listed | `AssertionError: expected +0 to be 1 // Object.is equality` |
| src/lib/manual-debt-markers.test.ts > manual debt marker source scanning > skips a file that passes the size check but cannot be read | `AssertionError: expected +0 to be 1 // Object.is equality` |
| src/lib/skill-install-ownership.test.ts > writeManagedSkillFiles — duplicate targets and rollback > rolls back a newly-created file when a later spec in the batch fails | `AssertionError: expected [Function] to throw an error` |
| src/lib/skill-install-ownership.test.ts > writeManagedSkillFiles — duplicate targets and rollback > restores previous content and manifest entry when a later spec fails after an update | `AssertionError: expected [Function] to throw an error` |
| src/lib/skill-install-ownership.test.ts > writeManagedSkillFiles — rollback re-throws the original failure, not a corrupted-bookkeeping crash > propagates the underlying EACCES failure verbatim after rolling back an earlier write | `AssertionError: expected undefined to be an instance of Error` |
| src/lib/skill-install-ownership.test.ts > writeManagedSkillFiles — rollback manifest bookkeeping removes the key, not just its value > deletes the manifest key entirely for a rolled-back new file, rather than leaving it set to undefined | `AssertionError: expected [Function] to throw an error` |
| src/lib/sponsor-spinner.test.ts > sponsor spinner verb management > reports the write failure instead of throwing when the file is read-only | `AssertionError: expected true to be false // Object.is equality` |
| src/harness/build-refresh.test.ts > startBuildRefreshWatcher > re-spawn throttle boundary (real ticks, exact counts) > re-attempts only once the pending window has fully elapsed — spawns on ticks 1,3,5, not 2,4 | `AssertionError: expected [ 1, 1, 1, 1, 1 ] to deeply equal [ 1, 1, 2, 2, 3 ]` |
| src/harness/codex-collect.test.ts > collectCodexSessions > skips an unreadable rollout file instead of throwing | `AssertionError: expected 3 to be 2 // Object.is equality` |
| src/harness/daemon-pid-ownership.test.ts > daemon pid-file ownership > reports a failed unlink instead of claiming the owned pid file was removed | `AssertionError: expected true to be false // Object.is equality` |
| src/harness/gate-reach-collect.mutation-kill-luna-v3.test.ts > gate reach survivor contracts > fails soft for an unreadable candidate | `AssertionError: expected [ 'src/a.ts', 'src/locked.ts' ] to deeply equal [ 'src/a.ts' ]` |
| src/harness/gate-reach-collect.test.ts > enumerateEligibleFiles > excludes a candidate file that cannot be opened (unreadable permissions) rather than throwing | `AssertionError: expected [ 'src/a.ts', 'src/locked.ts' ] to deeply equal [ 'src/a.ts' ]` |
| src/harness/scratchpad-archive.test.ts > archiveScratchpadDir > skips a file it cannot read due to permissions (statSync ok, readFileSync fails) | `AssertionError: expected false to be true // Object.is equality` |
| src/harness/session-daemon.test.ts > startSessionDaemon > claimSessionPid: a non-EEXIST wx-write failure (permission denied) is rethrown, not swallowed (branch 88 true side) | `AssertionError: expected [Function] to throw an error` |
| src/harness/session-paths.test.ts > isDaemonSocketServing > resolves true (fail-safe) on an unexpected connect error code (EACCES, not the three known-safe codes) | `AssertionError: expected false to be true // Object.is equality` |
| src/lib/__tests__/hooks-installation.test.ts > uninstallAllHooks — unknown client and uninstall failure > catches an uninstall-time exception and reports it as an error result | `AssertionError: expected [ 'SessionStart', 'SessionEnd', …(6) ] to deeply equal []` |
| src/harness/__tests__/entry-points.test.ts > collectEntryPoints — extra branch coverage > continues past an unreadable directory during the test scan | `AssertionError: expected [ { kind: 'test', …(2) }, …(1) ] to have a length of 1 but got 2` |
| src/harness/__tests__/supermodel-graph.test.ts > loadGraphForFile > returns null on an I/O error reading an unreadable shard file | `AssertionError: expected { …(5) } to be null` |
| src/harness/check-evidence/corpus-scan.test.ts > scanCorpus — negative (must NOT count) > N5: a file the scanner cannot read is skipped, not crashed on or counted | `AssertionError: expected [ …(2) ] to have a length of 1 but got 2` |
| src/harness/checks/cross-file.test.ts > checkMigrationParity > returns [] when readdirSync throws (e.g. permission denied reading the migrations dir) | `AssertionError: expected [ { line: 1, …(1) } ] to deeply equal []` |
| src/harness/checks/dead-interface-fields.test.ts > findDeadInterfaceFields > skips an unreadable declaring file instead of throwing (extractInterfaceFields readFileSync catch) | `AssertionError: expected [ 'isolatedField' ] to not include 'isolatedField'` |
| src/harness/checks/dead-interface-fields.test.ts > findDeadInterfaceFields > skips an unreadable corpus file while searching for reads instead of throwing (fieldIsReadElsewhere readFileSync catch) | `AssertionError: expected [] to include 'isolatedField'` |
| src/harness/checks/project-setup.test.ts > checkProjectSetup > skips unreadable first-party files during the node:-import scan instead of throwing | `AssertionError: expected true to be false // Object.is equality` |
| src/harness/checks/project-setup.test.ts > checkProjectSetup > skips an unreadable directory during the project walk instead of throwing | `AssertionError: expected [ { check: 'project_setup', …(4) } ] to deeply equal []` |
| src/harness/server/fuzz-targets.test.ts > detectFuzzTargets > skips an unreadable candidate and keeps the readable fast-check target | `AssertionError: expected [ 'src/a.test.ts', …(1) ] to deeply equal [ 'src/a.test.ts' ]` |
| src/harness/server/post-tool-pipeline.mutation-kill-luna-v3.test.ts > post-tool pipeline contracts > uses compact labels for every supported check family | `AssertionError: the given combination of arguments (undefined and string) is invalid for this assertion. You can use an array, a map, an object, a set, a string, or a weakset instead of a string` |
| src/harness/server/post-tool-pipeline.mutation-kill-w50.test.ts > empty-warnings conditions do not push anything > never pushes WARNING content when both channel and scan output are empty | `AssertionError: expected [ …(2) ] to deeply equal []` |
| src/harness/content-scanner/__tests__/redact-preview.test.ts > writePendingPrompt — filesystem failure paths > returns undefined and does not throw when writeFileSync fails (dir not writable) | `AssertionError: expected '.interlinked/scanner/pending/2026-11-…' to be undefined` |
| src/harness/structure/extractors/config-extractor.test.ts > config-extractor > skips a file it cannot read (permission denied) but still finds keys in siblings | `AssertionError: expected [ 'locked.key', 'open.key' ] to not include 'locked.key'` |

## Step 4: help text (built CLI)

```
$ node dist/index.js tests prove-kill --help
Usage: interlinked tests prove-kill [options]

Prove that the named tests pass on the live tree and fail under ONE mutant (a
manifest survivor by id, or an explicit --find/--replace fault); writes a
receipt bound to source, test and runtime bytes. Exit 0 killed; 1 survived or
not passing now; 2 undecided

Options:
  --cwd <path>            Project root
  --test <file>           Test file that must notice the mutant (repeatable)
  --mutant <id>           Stable mutant id from
                          .interlinked/mutation-manifest.json (see `interlinked
                          mutation survivors --file <path>`)
  --file <path>           Source file: narrows --mutant, required for an
                          explicit fault
  --find <text>           Explicit fault: source text that occurs exactly once
                          in --file
  --replace <text>        Explicit fault: the replacement text
  --run-timeout <ms>      Budget for EACH vitest run (the baseline copy, then
                          the mutant copy); `--timeout` is the whole-command
                          deadline (default: "300000")
  --vitest-config <file>  vitest config to pass as --config (default: the one
                          `scripts.test` declares, else vitest's own discovery)
  --json                  Machine-readable result
  -h, --help              display help for command

```

```
$ node dist/index.js tests kill-proofs --help
Usage: interlinked tests kill-proofs [options]

List recorded kill proofs; --verify re-checks each against the bytes and
runtime on disk (exit 1 when any is stale)

Options:
  --cwd <path>  Project root
  --verify      Re-hash source and tests, re-resolve the mutant, compare the
                runtime
  --json        Machine-readable list
  -h, --help    display help for command

```

(Both are followed by the CLI's standard "Interface boundaries / Zero-arg behavior / Quick start" footer, omitted here.)

## Step 5: e2e lane

```
 ✓ src/e2e/kill-proof-nudge.e2e.test.ts (3 tests) 3523ms
     ✓ P2: a fresh killed receipt silences the nudge; a source edit makes it stale again  2422ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  5.01s (transform 1.07s, setup 28ms, import 1.29s, tests 3.52s, environment 0ms)
```

## Step 6: walkthrough with the built CLI

Fixture: a git repo at `/tmp/kp-verify-repo` with `package.json` (`"type": "module"`), `vitest.config.ts` (`include: ["test/**/*.test.ts"]`), `node_modules` symlinked to the clone's, `src/math.ts` (`return a + b;`), and three test files: `strong` (`expect(add(2, 3)).toBe(5)`), `weak` (`expect(typeof add).toBe("function")`) and `mocked` (`vi.mock("../src/math.js", () => ({ add: () => 5 }))`). One commit.

```
$ interlinked tests prove-kill --test test/strong.test.ts --file src/math.ts --find a + b --replace a - b
mutant: explicit fault @ src/math.ts:2 "a + b" → "a - b"
tests: test/strong.test.ts (1 case(s) pass in the isolated copy, 622 ms)
verdict: KILLED (597 ms under the mutant)
  killed       test/strong.test.ts › adds two numbers
receipt: /tmp/kp-verify-repo/.interlinked/test-runs/kill-proofs/ee9cd441c5f6bbfa.json
Proof recorded. It holds while source, tests and runtime are unchanged; check with `interlinked tests kill-proofs --verify`.
[exit 0]

$ interlinked tests prove-kill --test test/weak.test.ts --file src/math.ts --find a + b --replace a - b
mutant: explicit fault @ src/math.ts:2 "a + b" → "a - b"
tests: test/weak.test.ts (1 case(s) pass in the isolated copy, 704 ms)
verdict: SURVIVED (648 ms under the mutant)
  survived     test/weak.test.ts › add is a function
receipt: /tmp/kp-verify-repo/.interlinked/test-runs/kill-proofs/93dd4c31a19bffbe.json
These tests still pass with the mutant applied. Strengthen the assertion: check the value the mutant changes, then re-run.
[exit 1]

$ interlinked tests prove-kill --test test/strong.test.ts --file src/math.ts --find a + b --replace a + (b
mutant: explicit fault @ src/math.ts:2 "a + b" → "a + (b"
tests: test/strong.test.ts (1 case(s) pass in the isolated copy, 610 ms)
verdict: INCONCLUSIVE (0 ms under the mutant)
  inconclusive test/strong.test.ts › adds two numbers — the mutated src/math.ts does not parse (')' expected.); a compile error is not a kill
receipt: /tmp/kp-verify-repo/.interlinked/test-runs/kill-proofs/0afff6aef2f52c82.json
Nothing is proven: a crash, load error or timeout is not a kill. Assert on the mutated code's result, or raise --timeout.
[exit 2]

$ interlinked tests prove-kill --test test/mocked.test.ts --file src/math.ts --find a + b --replace a - b
mutant: explicit fault @ src/math.ts:2 "a + b" → "a - b"
verdict: UNAVAILABLE
  - the named tests do not load src/math.ts from the copy (an absolute path, an alias or a link into the live tree): a module-level throw in its place left every case passing
Fix the reason above and re-run. No receipt was written.
[exit 2]

$ interlinked tests kill-proofs --verify   (before edit)
0afff6aef2f52c82 INCONCLUSIVE 2026-11-05T00:46:30.260Z explicit fault @ src/math.ts:2 "a + b" → "a + (b"
  tests: test/strong.test.ts
  FRESH
93dd4c31a19bffbe SURVIVED     2026-11-05T00:46:28.749Z explicit fault @ src/math.ts:2 "a + b" → "a - b"
  tests: test/weak.test.ts
  FRESH
ee9cd441c5f6bbfa KILLED       2026-11-05T00:46:25.858Z explicit fault @ src/math.ts:2 "a + b" → "a - b"
  tests: test/strong.test.ts
  FRESH
[exit 0]

$ interlinked tests kill-proofs --verify   (after appending a comment to src/math.ts)
0afff6aef2f52c82 INCONCLUSIVE 2026-11-05T00:46:30.260Z explicit fault @ src/math.ts:2 "a + b" → "a + (b"
  tests: test/strong.test.ts
  STALE: source src/math.ts changed since the proof
93dd4c31a19bffbe SURVIVED     2026-11-05T00:46:28.749Z explicit fault @ src/math.ts:2 "a + b" → "a - b"
  tests: test/weak.test.ts
  STALE: source src/math.ts changed since the proof
ee9cd441c5f6bbfa KILLED       2026-11-05T00:46:25.858Z explicit fault @ src/math.ts:2 "a + b" → "a - b"
  tests: test/strong.test.ts
  STALE: source src/math.ts changed since the proof
[exit 1]
```

Every expectation held. Two observations, neither a failure:

* The `vi.mock` case is refused correctly as UNAVAILABLE, and the reason mentions the copy. But the reason names the wrong likely cause ("an absolute path, an alias or a link into the live tree"). The real cause is that the module was mocked away, so naming `vi.mock` as a possibility would help the user.
* Before the edit, the KILLED row says **FRESH** even though `.interlinked/` is untracked in the fixture. The commit under test was clean, so this is the expected result.

## Judgement

**Not mergeable as-is, but the fix is small.** The feature works from the built CLI: typecheck, docs check, build, the kill-proof e2e lane and the walkthrough all pass. Every verdict and exit code is as documented, and `--verify` goes from FRESH to STALE on a one-line source edit. However, the branch introduces **two deterministic unit-test regressions** that pass on `main` and would turn CI red. First, `cli-program.test.ts` reads the kill-proof canary error message as an unknown `interlinked kill-proof` command. Second, `cli-spec-surface.test.ts` reports that the new `--vitest-config` option has no test. Both are a few lines to fix: reword the canary message or exempt it from the scanner, and add a test that pins `--vitest-config`. The other 50 failures are not caused by this branch. 36 come from running as root in this container, and 14 (in `managed-push`, `project-compiler-gate`, `project-e2e/services`, `block-fingerprint-session` and `commit-gate.defaults`) fail on `origin/main` too and should be fixed separately. After the two fixes and a green CI run as non-root, I would consider the branch mergeable.
