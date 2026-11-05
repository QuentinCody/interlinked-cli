# `prove-kill` / `kill-proofs` UX walkthrough (2026-11-04)

Every outcome of `interlinked tests prove-kill` and `interlinked tests kill-proofs`,
run from source (`npx tsx src/index.ts tests …`) against a throwaway git repository.
Outputs below are pasted exactly as printed **after** the wording fixes on branch
`cloud/docs-ux`; the table records what each line said before.

## The demo repository

`/tmp/kp-demo`: `src/math.ts` (`clamp`, `head`, `lengthOf`), its own
`vitest.config.ts` (`include: ["test/**/*.test.ts"]`), `node_modules` symlinked to
the interlinked-cli clone, `.interlinked` git-ignored, one commit. Tests:

| File | Purpose |
|---|---|
| `test/clamp.test.ts` | asserts both clamp edges — kills the `> max` fault |
| `test/weak.test.ts` | asserts only `typeof … === "number"` — survives it |
| `test/broken.test.ts` | expects the wrong value — fails on the live tree |
| `test/crash.test.ts` | asserts `lengthOf`; the fault makes product code throw `TypeError` |

`/tmp/kp-nogit` is a copy with `.git` removed. `/tmp/kp-jest` is a git repo whose
`package.json` declares only `jest`. `/tmp/kp-empty` is an empty git repo.

## Wording changes

| Where | Before | After |
|---|---|---|
| killed next step | Proof recorded. It stays valid while the source, the test files and the runtime are unchanged (`interlinked tests kill-proofs --verify`). | Proof recorded. It holds while source, tests and runtime are unchanged; check with `interlinked tests kill-proofs --verify`. |
| survived next step | Strengthen the assertion so the mutated behaviour is observed (assert the value the mutant changes), then re-run. A test that passes under the mutant is not a regression test for it. | These tests still pass with the mutant applied. Strengthen the assertion: check the value the mutant changes, then re-run. |
| inconclusive next step | No test failed by its own check. A crash, a load error or a timeout under the mutant is not a kill: make the test reach the mutated code and assert on its result. | Nothing is proven: a crash, load error or timeout is not a kill. Assert on the mutated code's result, or raise --timeout. |
| not-passing-now next step | Fix the test so it passes on the current code first; a test that fails live proves nothing about the mutant. | Make the test pass on the current code first. A test that already fails proves nothing about the mutant. |
| unavailable next step | Resolve the reasons above and re-run; no receipt was written. | Fix the reason above and re-run. No receipt was written. |
| no manifest | no mutation manifest at .interlinked/mutation-manifest.json — measure the file first (`interlinked mutation measure <file>`) or pass an explicit fault (--file/--find/--replace) | no mutation manifest yet: run `interlinked mutation measure <file>`, or pass an explicit fault with --file/--find/--replace |
| ambiguous find | anchor occurs 5 times in src/math.ts (exactly one is required) | the --find text occurs 5 times in src/math.ts; it must occur exactly once |
| bad `--mutant` | --mutant must be a 16-hex stable mutant id (see `interlinked mutation survivors --file <path>`) | --mutant takes a 16-character hex mutant id; list them with `interlinked mutation survivors --file <path>` |
| no mutant | name the mutant: --mutant <id>, or --file <src> --find <text> --replace <text> | … --replace <text>; see --help |
| empty list | no kill proofs recorded (run `interlinked tests prove-kill`) | No kill proofs recorded yet. Make one with `interlinked tests prove-kill --help`. |
| clipped mutant label | `"return (null as unknown as string[]).le` (cut mid-word, no closing mark) | `"return (null as unknown as string[]).l…` (ellipsis marks the cut) |
| `--timeout` help | Budget for each test run | Budget in ms for each of the two test runs (live, then mutant) |
| guide, Limits | A jest or ava project gets `unavailable: 'vitest' failed to launch`. | quotes the real reason: `vitest is not installed in this project (this project declares jest) …` |

## Findings left for the owner (not wording; out of this task's scope)

- **F1 — `--timeout` is read twice with different meanings.** The CLI's resource
  supervisor (`src/harness/resource-cli.ts`, the `--timeout` scan near line 60)
  treats `--timeout` as the deadline for the WHOLE command, while `prove-kill`
  uses it per test run. A small value kills the CLI before any verdict (exit 75,
  shown below), and the default 300000 caps both runs together at 300 s, not
  300 s each. Not changed here: it is logic, and the fix belongs to the supervisor.
- **F2 — a KILLED verdict lists the other cases as `survived`.** Correct per case,
  but a reader may think the proof is partial. Left as is: case verdict names are
  part of the receipt contract.

## Outputs

### killed

```console
$ interlinked tests prove-kill --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --test test/clamp.test.ts
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
tests: test/clamp.test.ts (2 case(s) pass on the live tree, 593 ms)
verdict: KILLED (603 ms under the mutant)
  survived     test/clamp.test.ts › clamps below the range
  killed       test/clamp.test.ts › clamps above the range
receipt: /tmp/kp-demo/.interlinked/test-runs/kill-proofs/7113042096864a76.json
Proof recorded. It holds while source, tests and runtime are unchanged; check with `interlinked tests kill-proofs --verify`.
# exit 0
```

### survived

```console
$ interlinked tests prove-kill --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --test test/weak.test.ts
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
tests: test/weak.test.ts (1 case(s) pass on the live tree, 596 ms)
verdict: SURVIVED (607 ms under the mutant)
  survived     test/weak.test.ts › returns a number
receipt: /tmp/kp-demo/.interlinked/test-runs/kill-proofs/34349c1032778c89.json
These tests still pass with the mutant applied. Strengthen the assertion: check the value the mutant changes, then re-run.
# exit 1
```

### not-passing-now

```console
$ interlinked tests prove-kill --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --test test/broken.test.ts
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: NOT-PASSING-NOW
  - test/broken.test.ts › expects the wrong value: failed — AssertionError: expected 10 to be 11 // Object.is equality
Make the test pass on the current code first. A test that already fails proves nothing about the mutant.
# exit 1
```

### inconclusive (product code crashes under the mutant)

```console
$ interlinked tests prove-kill --file src/math.ts --find 'return items.length;' --replace 'return (null as unknown as string[]).length;' --test test/crash.test.ts
mutant: explicit fault @ src/math.ts:10 "return items.length;" → "return (null as unknown as string[]).l…
tests: test/crash.test.ts (1 case(s) pass on the live tree, 609 ms)
verdict: INCONCLUSIVE (593 ms under the mutant)
  inconclusive test/crash.test.ts › counts items — TypeError: Cannot read properties of null (reading 'length')
receipt: /tmp/kp-demo/.interlinked/test-runs/kill-proofs/9ba1b2145875e6da.json
Nothing is proven: a crash, load error or timeout is not a kill. Assert on the mutated code's result, or raise --timeout.
# exit 2
```

### unavailable: manifest id with no manifest

```console
$ interlinked tests prove-kill --mutant 575ddae6cc2946f9 --test test/clamp.test.ts
verdict: UNAVAILABLE
  - no mutation manifest yet: run `interlinked mutation measure <file>`, or pass an explicit fault with --file/--find/--replace
Fix the reason above and re-run. No receipt was written.
# exit 2
```

### argument error: malformed mutant id

```console
$ interlinked tests prove-kill --mutant xyz --test test/clamp.test.ts
Error: --mutant takes a 16-character hex mutant id; list them with `interlinked mutation survivors --file <path>`
# exit 2
```

### unavailable: missing test file

```console
$ interlinked tests prove-kill --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --test test/nope.test.ts
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: UNAVAILABLE
  - test/nope.test.ts does not exist
Fix the reason above and re-run. No receipt was written.
# exit 2
```

### unavailable: no test named

```console
$ interlinked tests prove-kill --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
verdict: UNAVAILABLE
  - name at least one test file (--test <file>)
Fix the reason above and re-run. No receipt was written.
# exit 2
```

### unavailable: ambiguous --find

```console
$ interlinked tests prove-kill --file src/math.ts --find 'return' --replace 'throw' --test test/clamp.test.ts
verdict: UNAVAILABLE
  - the --find text occurs 5 times in src/math.ts; it must occur exactly once
Fix the reason above and re-run. No receipt was written.
# exit 2
```

### argument error: no mutant

```console
$ interlinked tests prove-kill --test test/clamp.test.ts
Error: name the mutant: --mutant <id>, or --file <src> --find <text> --replace <text>; see --help
# exit 2
```

### argument error: incomplete explicit fault

```console
$ interlinked tests prove-kill --file src/math.ts --find 'x' --test test/clamp.test.ts
Error: an explicit fault needs all three of --file, --find and --replace
# exit 2
```

### argument error: bad --timeout

```console
$ interlinked tests prove-kill --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --test test/clamp.test.ts --timeout abc
Error: --timeout must be a positive number of milliseconds
# exit 2
```

### unavailable: not a git work tree (copy of the demo without .git)

```console
$ interlinked tests prove-kill --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --test test/clamp.test.ts
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: UNAVAILABLE
  - /tmp/kp-nogit is not a git work tree; the mutant cannot be isolated in a copy
Fix the reason above and re-run. No receipt was written.
# exit 2
```

### unavailable: jest-only project

```console
$ interlinked tests prove-kill --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --test test/clamp.test.ts
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: UNAVAILABLE
  - vitest is not installed in this project (this project declares jest); v1 of prove-kill runs vitest only
Fix the reason above and re-run. No receipt was written.
# exit 2
```

### small --timeout (see finding F1)

```console
$ interlinked tests prove-kill --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --test test/clamp.test.ts --timeout 2500
[resources] CLI interrupted; no verification verdict.
[resources] MEMORY: peak_rss_bytes=295976960 rss_budget_bytes=3584325632 reserve_bytes=1792162816 heap_limit_mb=1536.
# exit 75
```

### kill-proofs: nothing recorded

```console
$ interlinked tests kill-proofs
No kill proofs recorded yet. Make one with `interlinked tests prove-kill --help`.
# exit 0
```

### kill-proofs: list

```console
$ interlinked tests kill-proofs
34349c1032778c89 SURVIVED     2026-11-04T23:55:13.602Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/weak.test.ts
7113042096864a76 KILLED       2026-11-04T23:55:09.472Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
9ba1b2145875e6da INCONCLUSIVE 2026-11-04T23:55:21.347Z explicit fault @ src/math.ts:10 "return items.length;" → "return (null as unknown as string[]).l…
  tests: test/crash.test.ts
# exit 0
```

### kill-proofs --verify: fresh

```console
$ interlinked tests kill-proofs --verify
34349c1032778c89 SURVIVED     2026-11-04T23:55:13.602Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/weak.test.ts
  FRESH
7113042096864a76 KILLED       2026-11-04T23:55:09.472Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  FRESH
9ba1b2145875e6da INCONCLUSIVE 2026-11-04T23:55:21.347Z explicit fault @ src/math.ts:10 "return items.length;" → "return (null as unknown as string[]).l…
  tests: test/crash.test.ts
  FRESH
# exit 0
```

### kill-proofs --verify: stale (test/clamp.test.ts edited after the proof)

```console
$ interlinked tests kill-proofs --verify
34349c1032778c89 SURVIVED     2026-11-04T23:55:13.602Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/weak.test.ts
  FRESH
7113042096864a76 KILLED       2026-11-04T23:55:09.472Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  STALE: test test/clamp.test.ts changed since the proof
9ba1b2145875e6da INCONCLUSIVE 2026-11-04T23:55:21.347Z explicit fault @ src/math.ts:10 "return items.length;" → "return (null as unknown as string[]).l…
  tests: test/crash.test.ts
  FRESH
# exit 1
```

