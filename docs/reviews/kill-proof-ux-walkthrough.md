# `prove-kill` / `kill-proofs` UX walkthrough, round 2 (2026-11-05)

Round 1 (2026-11-04) predates the current verdict flow, so it is replaced here.
The flow now uses a separate copy for the baseline and the mutant, a repeat
baseline after a kill, a reachability canary after a survivor, `--run-timeout`,
`--vitest-config`, and the `UNCOMMITTED` freshness state.

Every outcome below was run with the built CLI (`node dist/index.js`, shown as
`interlinked`) on branch `cloud/docs-ux-2`, after the wording fixes. The outputs
are verbatim. Only timings, timestamps and receipt ids vary between runs.

## The demo repositories

`/tmp/kp-demo` is a git repository with one commit, so receipts can read `FRESH`.
It has its own `vitest.config.ts` (`include: ["test/**/*.test.ts"]`,
`setupFiles: ["test/setup.ts"]`) and a `node_modules` symlink to the
interlinked-cli clone (vitest 4.1.11, node v22.23.4). `.gitignore` lists
`node_modules`, `.interlinked` and `test/fixtures/`.

| File | Role |
|---|---|
| `src/math.ts` | `clamp`, `lengthOf`: the mutated source |
| `src/greet.ts` | `greet`: mocked away by `test/mocked.test.ts` |
| `test/clamp.test.ts` | asserts both clamp edges; kills the `> max` fault |
| `test/weak.test.ts` | asserts only `typeof … === "number"`; survives it |
| `test/broken.test.ts` | expects the wrong value; fails on the live tree |
| `test/crash.test.ts` | asserts `lengthOf`; the fault makes product code throw `TypeError` |
| `test/marker.test.ts` | fails when `$TMPDIR/kp-demo-marker` exists, then writes it |
| `test/mocked.test.ts` | `vi.mock("../src/greet", …)`: never loads `src/greet.ts` |
| `test/fixture.test.ts` | reads the git-ignored `test/fixtures/data.json` |
| `test/outside.test.ts` | a symlink to `/tmp/kp-outside/outside.test.ts` |
| `checks/clamp.test.ts` | a real test that the config's `include` does not match |

`/tmp/kp-jest` declares only `jest`. `/tmp/kp-mono` is a workspace root
(`"workspaces": ["packages/*"]`) whose `packages/core` has vitest. The marker
file is deleted before each command.

## Wording changes (before → after)

Exit codes, verdict names, JSON field names and the verdict logic are unchanged.
JSON `reasons` carry the new strings.

| Where | Before | After |
|---|---|---|
| inconclusive next step | one line for every cause: `Nothing is proven: a crash, load error or timeout is not a kill. Assert on the mutated code's result, or raise --timeout.` (`--timeout` is the wrong flag) | one line per cause. Parse error: `Nothing is proven: the mutated file does not parse. Pick a replacement that compiles, then re-run.` Timeout: `… the mutant run timed out. Raise --run-timeout (default 300000), then re-run.` Not repeatable: `… the test fails on a second clean run. Make it clean up the state it leaves.` Crash: `… a crash or load error is not a kill. Assert on the mutated code's result instead.` |
| not repeatable (case reason) | `not repeatable: the case also fails on an unmutated copy after the mutant run (…); a run left state outside the copy` | `not repeatable: it also fails on a fresh unmutated copy (…). A run left state outside the copy` |
| canary | `the named tests do not load src/greet.ts from the copy (an absolute path, an alias or a link into the live tree): a module-level throw in its place left every case passing` (31 words; omits the mock, the most common cause) | `the named tests never load src/greet.ts from the copy: a module-level throw in its place left every case passing.` + `A mock, an alias, an absolute path or a link into the live tree bypasses the copy.` |
| ignored fixture | `the isolated git-visible copy lacks test/fixtures/data.json (ignored or untracked files are not copied), so the baseline cannot run there:` (wrong: untracked files ARE copied) | `the isolated copy lacks test/fixtures/data.json: ignored files are not copied. Track the file, then re-run.` |
| test not run | `checks/clamp.test.ts reported no executed test case in the baseline copy` (no next step) | `checks/clamp.test.ts ran no test case in the isolated copy` + `Check that the vitest config includes it (or pass --vitest-config <file>) and that it loads without ignored files.` |
| baseline timeout | `baseline run failed: timed out after 61 ms` (no hint) | `baseline run timed out after 65 ms; raise --run-timeout (default 300000)` |
| missing config | `vitest.other.ts does not exist` (which flag?) | `--vitest-config vitest.other.ts does not exist` |
| directory | `test is a directory; name test files` | `test is a directory; pass each test file with its own --test` |
| outside the project | `…; a test outside the copy would run against the live source` | `… (/tmp/kp-outside/outside.test.ts). It would test the live source, not the copy` |
| monorepo root | `vitest is not installed in this project (its test script is \`npm test --workspaces\`); v1 of prove-kill runs vitest only` (blames the project; no next step) | `vitest is not installed at this workspace root; pass --cwd <package> for a package that has vitest` |
| stale config | `vitest/vite config changed since the proof` | `vitest config vitest.config.ts changed since the proof` |
| uncommitted | `test/clamp.test.ts: work tree differs from HEAD or the index (the proven bytes are not committed)` | `test/clamp.test.ts differs from HEAD or the index; commit it so the proof covers committed bytes` |
| `kill-proofs --verify` | no summary: a `FRESH` survived receipt read like evidence, and nothing said why the exit was 1 | last line: `1 KILLED proof(s): 1 fresh, 0 uncommitted, 0 stale. Only KILLED proofs count as evidence.`, or `… Re-run the prove-kill command of each stale proof to renew it.` (human output only) |
| `prove-kill --help` | options in the order `--cwd, --test, --mutant, …`; no examples or exit codes | order `--test, --mutant, --file, --find, --replace, --run-timeout, --vitest-config, --cwd, --json`; shorter option text; examples, exit codes and the guide path after the options |
| `kill-proofs --help` | `--verify` text omitted config and setup files | names them; lists the three freshness states and the exit codes |

## Findings left for the owner (logic, not wording)

- **F1: a superseded receipt keeps `--verify` at exit 1 forever.** Re-proving
  after a test edit writes a NEW receipt (the id hashes the bytes). The old one
  stays `STALE` and still fails `--verify` (see "after the commit" below). No
  command prunes receipts, and the harness refuses Write/Edit under
  `.interlinked/test-runs/kill-proofs/`. Suggest: `--verify` ignores a stale
  receipt when a fresh one has the same mutant and test paths, or add `--prune`.
- **F2 (carried from round 1): a KILLED verdict lists other cases as
  `survived`.** Correct per case. The verdict line already says KILLED.
- **F3: a test outside the vitest config's `include` is `unavailable`**, though
  vitest would run it if named. The new hint names `--vitest-config`.
- Round 1's `--timeout` finding is resolved by `--run-timeout`; both help texts
  now say which is which.

## Outputs

### killed

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
tests: test/clamp.test.ts (2 case(s) pass in the isolated copy, 615 ms)
verdict: KILLED (570 ms under the mutant)
  survived     test/clamp.test.ts › clamps below the range
  killed       test/clamp.test.ts › clamps above the range
receipt: /tmp/kp-demo/.interlinked/test-runs/kill-proofs/d9fa203ce7d2b6e8.json
Proof recorded. It holds while source, tests and runtime are unchanged; check with `interlinked tests kill-proofs --verify`.
# exit 0
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --json
{
  "ok": true,
  "receipt": {
    "version": 1,
    "id": "d9fa203ce7d2b6e8",
    "digest": "e90013d7f75c3891544299d520a703e5f589b3c4971b82d7535be218784b1481",
    "verdict": "killed",
    "reasons": [
      "test/clamp.test.ts › clamps above the range failed by its own check under the mutant"
    ],
    "provedAt": "2026-11-05T03:48:11.106Z",
    "root": "/tmp/kp-demo",
    "source": {
      "path": "src/math.ts",
      "sha256": "52eeaf805250ab078aee354f2a681f05aebdc6b518ef4a81d13a01bebf0eb85f"
    },
    "mutant": {
      "file": "src/math.ts",
      "offset": 104,
      "originalLexeme": "if (value > max) return max;",
      "replacement": "if (value > max) return value;",
      "line": 3,
      "source": "explicit",
      "lineText": "\tif (value > max) return max;"
    },
    "tests": [
      {
        "path": "test/clamp.test.ts",
        "sha256": "ce542e33ca091058876dfde20de835796954df187c16a4139bd081ddc087e715"
      }
    ],
    "killedTests": [
      "test/clamp.test.ts"
    ],
    "baseline": {
      "cases": 2,
      "durationMs": 624
    },
    "underMutant": {
      "durationMs": 587,
      "timedOut": false,
      "cases": [
        {
          "test": "test/clamp.test.ts › clamps below the range",
          "verdict": "survived"
        },
        {
          "test": "test/clamp.test.ts › clamps above the range",
          "verdict": "killed"
        }
      ]
    },
    "environment": {
      "node": "v22.23.4",
      "vitest": "4.1.11",
      "platform": "linux-x64",
      "config": {
        "path": "vitest.config.ts",
        "sha256": "40f4ea0038ccd68f05096f55e2de404811883bfc81ce3caf4a59f90840fae8a9"
      },
      "setupFiles": [
        {
          "path": "test/setup.ts",
          "sha256": "632a8c7426a9b073896c380a48938407b51c9683792512e0953cb8add5414ec7"
        }
      ]
    }
  },
  "receiptPath": "/tmp/kp-demo/.interlinked/test-runs/kill-proofs/d9fa203ce7d2b6e8.json"
}
# exit 0
```

</details>

### survived

```console
$ interlinked tests prove-kill --test test/weak.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
tests: test/weak.test.ts (1 case(s) pass in the isolated copy, 546 ms)
verdict: SURVIVED (562 ms under the mutant)
  survived     test/weak.test.ts › returns a number
receipt: /tmp/kp-demo/.interlinked/test-runs/kill-proofs/66eec4006588d87b.json
These tests still pass with the mutant applied. Strengthen the assertion: check the value the mutant changes, then re-run.
# exit 1
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/weak.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --json
{
  "ok": true,
  "receipt": {
    "version": 1,
    "id": "66eec4006588d87b",
    "digest": "98430feaec0f052dc35ae731e18424c80e3f8f770a17c8195665b14ca44358e2",
    "verdict": "survived",
    "reasons": [
      "1 case(s) passed with the mutant applied — these tests do not detect it"
    ],
    "provedAt": "2026-11-05T03:48:16.369Z",
    "root": "/tmp/kp-demo",
    "source": {
      "path": "src/math.ts",
      "sha256": "52eeaf805250ab078aee354f2a681f05aebdc6b518ef4a81d13a01bebf0eb85f"
    },
    "mutant": {
      "file": "src/math.ts",
      "offset": 104,
      "originalLexeme": "if (value > max) return max;",
      "replacement": "if (value > max) return value;",
      "line": 3,
      "source": "explicit",
      "lineText": "\tif (value > max) return max;"
    },
    "tests": [
      {
        "path": "test/weak.test.ts",
        "sha256": "713981ea01d481f5e22f557b52af0601e02a681872494f1afc979eaa0bd8bd31"
      }
    ],
    "killedTests": [],
    "baseline": {
      "cases": 1,
      "durationMs": 587
    },
    "underMutant": {
      "durationMs": 578,
      "timedOut": false,
      "cases": [
        {
          "test": "test/weak.test.ts › returns a number",
          "verdict": "survived"
        }
      ]
    },
    "environment": {
      "node": "v22.23.4",
      "vitest": "4.1.11",
      "platform": "linux-x64",
      "config": {
        "path": "vitest.config.ts",
        "sha256": "40f4ea0038ccd68f05096f55e2de404811883bfc81ce3caf4a59f90840fae8a9"
      },
      "setupFiles": [
        {
          "path": "test/setup.ts",
          "sha256": "632a8c7426a9b073896c380a48938407b51c9683792512e0953cb8add5414ec7"
        }
      ]
    }
  },
  "receiptPath": "/tmp/kp-demo/.interlinked/test-runs/kill-proofs/66eec4006588d87b.json"
}
# exit 1
```

</details>

### not-passing-now

```console
$ interlinked tests prove-kill --test test/broken.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: NOT-PASSING-NOW
  - test/broken.test.ts › expects the wrong value: failed — AssertionError: expected 10 to be 11 // Object.is equality
Make the test pass on the current code first. A test that already fails proves nothing about the mutant.
# exit 1
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/broken.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --json
{
  "ok": false,
  "verdict": "not-passing-now",
  "reasons": [
    "test/broken.test.ts › expects the wrong value: failed — AssertionError: expected 10 to be 11 // Object.is equality"
  ],
  "mutant": {
    "file": "src/math.ts",
    "offset": 104,
    "originalLexeme": "if (value > max) return max;",
    "replacement": "if (value > max) return value;",
    "line": 3,
    "source": "explicit"
  }
}
# exit 1
```

</details>

### inconclusive: the replacement does not parse

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max return max;'
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max return max;"
tests: test/clamp.test.ts (2 case(s) pass in the isolated copy, 608 ms)
verdict: INCONCLUSIVE (0 ms under the mutant)
  inconclusive test/clamp.test.ts › clamps below the range — the mutated src/math.ts does not parse (')' expected.); a compile error is not a kill
  inconclusive test/clamp.test.ts › clamps above the range — the mutated src/math.ts does not parse (')' expected.); a compile error is not a kill
receipt: /tmp/kp-demo/.interlinked/test-runs/kill-proofs/59bee44e97db8ab8.json
Nothing is proven: the mutated file does not parse. Pick a replacement that compiles, then re-run.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max return max;' --json
{
  "ok": true,
  "receipt": {
    "version": 1,
    "id": "59bee44e97db8ab8",
    "digest": "8a7011a517668d992135f0bc3e56df8149b09e4a3585e891ed50838f58018093",
    "verdict": "inconclusive",
    "reasons": [
      "test/clamp.test.ts › clamps below the range: the mutated src/math.ts does not parse (')' expected.); a compile error is not a kill",
      "test/clamp.test.ts › clamps above the range: the mutated src/math.ts does not parse (')' expected.); a compile error is not a kill"
    ],
    "provedAt": "2026-11-05T03:48:22.539Z",
    "root": "/tmp/kp-demo",
    "source": {
      "path": "src/math.ts",
      "sha256": "52eeaf805250ab078aee354f2a681f05aebdc6b518ef4a81d13a01bebf0eb85f"
    },
    "mutant": {
      "file": "src/math.ts",
      "offset": 104,
      "originalLexeme": "if (value > max) return max;",
      "replacement": "if (value > max return max;",
      "line": 3,
      "source": "explicit",
      "lineText": "\tif (value > max) return max;"
    },
    "tests": [
      {
        "path": "test/clamp.test.ts",
        "sha256": "ce542e33ca091058876dfde20de835796954df187c16a4139bd081ddc087e715"
      }
    ],
    "killedTests": [],
    "baseline": {
      "cases": 2,
      "durationMs": 654
    },
    "underMutant": {
      "durationMs": 0,
      "timedOut": false,
      "cases": [
        {
          "test": "test/clamp.test.ts › clamps below the range",
          "verdict": "inconclusive",
          "reason": "the mutated src/math.ts does not parse (')' expected.); a compile error is not a kill"
        },
        {
          "test": "test/clamp.test.ts › clamps above the range",
          "verdict": "inconclusive",
          "reason": "the mutated src/math.ts does not parse (')' expected.); a compile error is not a kill"
        }
      ],
      "error": "the mutated src/math.ts does not parse (')' expected.); a compile error is not a kill"
    },
    "environment": {
      "node": "v22.23.4",
      "vitest": "4.1.11",
      "platform": "linux-x64",
      "config": {
        "path": "vitest.config.ts",
        "sha256": "40f4ea0038ccd68f05096f55e2de404811883bfc81ce3caf4a59f90840fae8a9"
      },
      "setupFiles": [
        {
          "path": "test/setup.ts",
          "sha256": "632a8c7426a9b073896c380a48938407b51c9683792512e0953cb8add5414ec7"
        }
      ]
    }
  },
  "receiptPath": "/tmp/kp-demo/.interlinked/test-runs/kill-proofs/59bee44e97db8ab8.json"
}
# exit 2
```

</details>

### inconclusive: product code crashes under the mutant

```console
$ interlinked tests prove-kill --test test/crash.test.ts --file src/math.ts --find 'return items.length;' --replace 'return (null as unknown as string[]).length;'
mutant: explicit fault @ src/math.ts:8 "return items.length;" → "return (null as unknown as string[]).l…
tests: test/crash.test.ts (1 case(s) pass in the isolated copy, 588 ms)
verdict: INCONCLUSIVE (558 ms under the mutant)
  inconclusive test/crash.test.ts › counts items — TypeError: Cannot read properties of null (reading 'length')
receipt: /tmp/kp-demo/.interlinked/test-runs/kill-proofs/5be386b284758b33.json
Nothing is proven: a crash or load error is not a kill. Assert on the mutated code's result instead.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/crash.test.ts --file src/math.ts --find 'return items.length;' --replace 'return (null as unknown as string[]).length;' --json
{
  "ok": true,
  "receipt": {
    "version": 1,
    "id": "5be386b284758b33",
    "digest": "df998b73f10462fa0e4fff7bef076717df1497243293540b70bc7bc2465eae6a",
    "verdict": "inconclusive",
    "reasons": [
      "test/crash.test.ts › counts items: TypeError: Cannot read properties of null (reading 'length')"
    ],
    "provedAt": "2026-11-05T03:48:26.415Z",
    "root": "/tmp/kp-demo",
    "source": {
      "path": "src/math.ts",
      "sha256": "52eeaf805250ab078aee354f2a681f05aebdc6b518ef4a81d13a01bebf0eb85f"
    },
    "mutant": {
      "file": "src/math.ts",
      "offset": 204,
      "originalLexeme": "return items.length;",
      "replacement": "return (null as unknown as string[]).length;",
      "line": 8,
      "source": "explicit",
      "lineText": "\treturn items.length;"
    },
    "tests": [
      {
        "path": "test/crash.test.ts",
        "sha256": "b3fac3f334680c54d6c08e2fe5cdf1fff29fc24a87c78969d1281f236a5aac58"
      }
    ],
    "killedTests": [],
    "baseline": {
      "cases": 1,
      "durationMs": 522
    },
    "underMutant": {
      "durationMs": 619,
      "timedOut": false,
      "cases": [
        {
          "test": "test/crash.test.ts › counts items",
          "verdict": "inconclusive",
          "reason": "TypeError: Cannot read properties of null (reading 'length')"
        }
      ]
    },
    "environment": {
      "node": "v22.23.4",
      "vitest": "4.1.11",
      "platform": "linux-x64",
      "config": {
        "path": "vitest.config.ts",
        "sha256": "40f4ea0038ccd68f05096f55e2de404811883bfc81ce3caf4a59f90840fae8a9"
      },
      "setupFiles": [
        {
          "path": "test/setup.ts",
          "sha256": "632a8c7426a9b073896c380a48938407b51c9683792512e0953cb8add5414ec7"
        }
      ]
    }
  },
  "receiptPath": "/tmp/kp-demo/.interlinked/test-runs/kill-proofs/5be386b284758b33.json"
}
# exit 2
```

</details>

### inconclusive: not repeatable (a marker left in the OS temp directory)

```console
$ interlinked tests prove-kill --test test/marker.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
tests: test/marker.test.ts (1 case(s) pass in the isolated copy, 562 ms)
verdict: INCONCLUSIVE (544 ms under the mutant)
  inconclusive test/marker.test.ts › runs once per machine — not repeatable: it also fails on a fresh unmutated copy (AssertionError: expected true to be false // Object.is equality). A run left state outside the copy
receipt: /tmp/kp-demo/.interlinked/test-runs/kill-proofs/ae2c6e4691de4bd2.json
Nothing is proven: the test fails on a second clean run. Make it clean up the state it leaves.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/marker.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --json
{
  "ok": true,
  "receipt": {
    "version": 1,
    "id": "ae2c6e4691de4bd2",
    "digest": "cc4a8b438df29c5c93b8ac0d65f015684b0f95a7e9672387ec2d2cc3e68e0cf3",
    "verdict": "inconclusive",
    "reasons": [
      "test/marker.test.ts › runs once per machine: not repeatable: it also fails on a fresh unmutated copy (AssertionError: expected true to be false // Object.is equality). A run left state outside the copy"
    ],
    "provedAt": "2026-11-05T03:48:31.453Z",
    "root": "/tmp/kp-demo",
    "source": {
      "path": "src/math.ts",
      "sha256": "52eeaf805250ab078aee354f2a681f05aebdc6b518ef4a81d13a01bebf0eb85f"
    },
    "mutant": {
      "file": "src/math.ts",
      "offset": 104,
      "originalLexeme": "if (value > max) return max;",
      "replacement": "if (value > max) return value;",
      "line": 3,
      "source": "explicit",
      "lineText": "\tif (value > max) return max;"
    },
    "tests": [
      {
        "path": "test/marker.test.ts",
        "sha256": "b740b8ced1b27a1947c81850f7bdda5d4fb4e1848bae8015c4f78d04a98a2d3d"
      }
    ],
    "killedTests": [],
    "baseline": {
      "cases": 1,
      "durationMs": 572
    },
    "underMutant": {
      "durationMs": 585,
      "timedOut": false,
      "cases": [
        {
          "test": "test/marker.test.ts › runs once per machine",
          "verdict": "inconclusive",
          "reason": "not repeatable: it also fails on a fresh unmutated copy (AssertionError: expected true to be false // Object.is equality). A run left state outside the copy"
        }
      ]
    },
    "environment": {
      "node": "v22.23.4",
      "vitest": "4.1.11",
      "platform": "linux-x64",
      "config": {
        "path": "vitest.config.ts",
        "sha256": "40f4ea0038ccd68f05096f55e2de404811883bfc81ce3caf4a59f90840fae8a9"
      },
      "setupFiles": [
        {
          "path": "test/setup.ts",
          "sha256": "632a8c7426a9b073896c380a48938407b51c9683792512e0953cb8add5414ec7"
        }
      ]
    }
  },
  "receiptPath": "/tmp/kp-demo/.interlinked/test-runs/kill-proofs/ae2c6e4691de4bd2.json"
}
# exit 2
```

</details>

### unavailable: a mutant id with no manifest

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --mutant 575ddae6cc2946f9
verdict: UNAVAILABLE
  - no mutation manifest yet: run `interlinked mutation measure <file>`, or pass an explicit fault with --file/--find/--replace
Fix the reason above and re-run. No receipt was written.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --mutant 575ddae6cc2946f9 --json
{
  "ok": false,
  "verdict": "unavailable",
  "reasons": [
    "no mutation manifest yet: run `interlinked mutation measure <file>`, or pass an explicit fault with --file/--find/--replace"
  ]
}
# exit 2
```

</details>

### argument error: a malformed mutant id

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --mutant xyz
Error: --mutant takes a 16-character hex mutant id; list them with `interlinked mutation survivors --file <path>`
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --mutant xyz --json
{
  "error": "--mutant takes a 16-character hex mutant id; list them with `interlinked mutation survivors --file <path>`"
}
# exit 2
```

</details>

### unavailable: the test file does not exist

```console
$ interlinked tests prove-kill --test test/nope.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: UNAVAILABLE
  - test/nope.test.ts does not exist
Fix the reason above and re-run. No receipt was written.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/nope.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --json
{
  "ok": false,
  "verdict": "unavailable",
  "reasons": [
    "test/nope.test.ts does not exist"
  ],
  "mutant": {
    "file": "src/math.ts",
    "offset": 104,
    "originalLexeme": "if (value > max) return max;",
    "replacement": "if (value > max) return value;",
    "line": 3,
    "source": "explicit"
  }
}
# exit 2
```

</details>

### unavailable: `--test` names a directory

```console
$ interlinked tests prove-kill --test test --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: UNAVAILABLE
  - test is a directory; pass each test file with its own --test
Fix the reason above and re-run. No receipt was written.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --json
{
  "ok": false,
  "verdict": "unavailable",
  "reasons": [
    "test is a directory; pass each test file with its own --test"
  ],
  "mutant": {
    "file": "src/math.ts",
    "offset": 104,
    "originalLexeme": "if (value > max) return max;",
    "replacement": "if (value > max) return value;",
    "line": 3,
    "source": "explicit"
  }
}
# exit 2
```

</details>

### unavailable: the test resolves outside the project

```console
$ interlinked tests prove-kill --test test/outside.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: UNAVAILABLE
  - test/outside.test.ts resolves outside the project (/tmp/kp-outside/outside.test.ts). It would test the live source, not the copy
Fix the reason above and re-run. No receipt was written.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/outside.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --json
{
  "ok": false,
  "verdict": "unavailable",
  "reasons": [
    "test/outside.test.ts resolves outside the project (/tmp/kp-outside/outside.test.ts). It would test the live source, not the copy"
  ],
  "mutant": {
    "file": "src/math.ts",
    "offset": 104,
    "originalLexeme": "if (value > max) return max;",
    "replacement": "if (value > max) return value;",
    "line": 3,
    "source": "explicit"
  }
}
# exit 2
```

</details>

### unavailable: the module is mocked away (canary)

```console
$ interlinked tests prove-kill --test test/mocked.test.ts --file src/greet.ts --find 'return `hello ${name}`;' --replace 'return `bye ${name}`;'
mutant: explicit fault @ src/greet.ts:2 "return `hello ${name}`;" → "return `bye ${name}`;"
verdict: UNAVAILABLE
  - the named tests never load src/greet.ts from the copy: a module-level throw in its place left every case passing.
  - A mock, an alias, an absolute path or a link into the live tree bypasses the copy.
Fix the reason above and re-run. No receipt was written.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/mocked.test.ts --file src/greet.ts --find 'return `hello ${name}`;' --replace 'return `bye ${name}`;' --json
{
  "ok": false,
  "verdict": "unavailable",
  "reasons": [
    "the named tests never load src/greet.ts from the copy: a module-level throw in its place left every case passing.",
    "A mock, an alias, an absolute path or a link into the live tree bypasses the copy."
  ],
  "mutant": {
    "file": "src/greet.ts",
    "offset": 47,
    "originalLexeme": "return `hello ${name}`;",
    "replacement": "return `bye ${name}`;",
    "line": 2,
    "source": "explicit"
  }
}
# exit 2
```

</details>

### unavailable: the copy lacks an ignored fixture

```console
$ interlinked tests prove-kill --test test/fixture.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: UNAVAILABLE
  - the isolated copy lacks test/fixtures/data.json: ignored files are not copied. Track the file, then re-run.
  - test/fixture.test.ts › clamps the fixture value: failed — Error: ENOENT: no such file or directory, open 'test/fixtures/data.json'
Fix the reason above and re-run. No receipt was written.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/fixture.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --json
{
  "ok": false,
  "verdict": "unavailable",
  "reasons": [
    "the isolated copy lacks test/fixtures/data.json: ignored files are not copied. Track the file, then re-run.",
    "test/fixture.test.ts › clamps the fixture value: failed — Error: ENOENT: no such file or directory, open 'test/fixtures/data.json'"
  ],
  "mutant": {
    "file": "src/math.ts",
    "offset": 104,
    "originalLexeme": "if (value > max) return max;",
    "replacement": "if (value > max) return value;",
    "line": 3,
    "source": "explicit"
  }
}
# exit 2
```

</details>

### unavailable: the vitest config does not include the test

```console
$ interlinked tests prove-kill --test checks/clamp.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: UNAVAILABLE
  - checks/clamp.test.ts ran no test case in the isolated copy
  - Check that the vitest config includes it (or pass --vitest-config <file>) and that it loads without ignored files.
Fix the reason above and re-run. No receipt was written.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test checks/clamp.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --json
{
  "ok": false,
  "verdict": "unavailable",
  "reasons": [
    "checks/clamp.test.ts ran no test case in the isolated copy",
    "Check that the vitest config includes it (or pass --vitest-config <file>) and that it loads without ignored files."
  ],
  "mutant": {
    "file": "src/math.ts",
    "offset": 104,
    "originalLexeme": "if (value > max) return max;",
    "replacement": "if (value > max) return value;",
    "line": 3,
    "source": "explicit"
  }
}
# exit 2
```

</details>

### unavailable: the baseline exceeds `--run-timeout`

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --run-timeout 50
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: UNAVAILABLE
  - baseline run timed out after 65 ms; raise --run-timeout (default 300000)
Fix the reason above and re-run. No receipt was written.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --run-timeout 50 --json
{
  "ok": false,
  "verdict": "unavailable",
  "reasons": [
    "baseline run timed out after 59 ms; raise --run-timeout (default 300000)"
  ],
  "mutant": {
    "file": "src/math.ts",
    "offset": 104,
    "originalLexeme": "if (value > max) return max;",
    "replacement": "if (value > max) return value;",
    "line": 3,
    "source": "explicit"
  }
}
# exit 2
```

</details>

### unavailable: `--vitest-config` names a missing file

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --vitest-config vitest.other.ts
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: UNAVAILABLE
  - --vitest-config vitest.other.ts does not exist
Fix the reason above and re-run. No receipt was written.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --vitest-config vitest.other.ts --json
{
  "ok": false,
  "verdict": "unavailable",
  "reasons": [
    "--vitest-config vitest.other.ts does not exist"
  ],
  "mutant": {
    "file": "src/math.ts",
    "offset": 104,
    "originalLexeme": "if (value > max) return max;",
    "replacement": "if (value > max) return value;",
    "line": 3,
    "source": "explicit"
  }
}
# exit 2
```

</details>

### unavailable: a jest-only project

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: UNAVAILABLE
  - vitest is not installed in this project (this project declares jest); v1 of prove-kill runs vitest only
Fix the reason above and re-run. No receipt was written.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --json
{
  "ok": false,
  "verdict": "unavailable",
  "reasons": [
    "vitest is not installed in this project (this project declares jest); v1 of prove-kill runs vitest only"
  ],
  "mutant": {
    "file": "src/math.ts",
    "offset": 104,
    "originalLexeme": "if (value > max) return max;",
    "replacement": "if (value > max) return value;",
    "line": 3,
    "source": "explicit"
  }
}
# exit 2
```

</details>

### unavailable: a monorepo root

```console
$ interlinked tests prove-kill --test packages/core/test/clamp.test.ts --file packages/core/src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
mutant: explicit fault @ packages/core/src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
verdict: UNAVAILABLE
  - vitest is not installed at this workspace root; pass --cwd <package> for a package that has vitest
Fix the reason above and re-run. No receipt was written.
# exit 2
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests prove-kill --test packages/core/test/clamp.test.ts --file packages/core/src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;' --json
{
  "ok": false,
  "verdict": "unavailable",
  "reasons": [
    "vitest is not installed at this workspace root; pass --cwd <package> for a package that has vitest"
  ],
  "mutant": {
    "file": "packages/core/src/math.ts",
    "offset": 104,
    "originalLexeme": "if (value > max) return max;",
    "replacement": "if (value > max) return value;",
    "line": 3,
    "source": "explicit"
  }
}
# exit 2
```

</details>

### `kill-proofs` (list)

```console
$ interlinked tests kill-proofs
59bee44e97db8ab8 INCONCLUSIVE 2026-11-05T03:48:22.539Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max return max;"
  tests: test/clamp.test.ts
5be386b284758b33 INCONCLUSIVE 2026-11-05T03:48:26.415Z explicit fault @ src/math.ts:8 "return items.length;" → "return (null as unknown as string[]).l…
  tests: test/crash.test.ts
66eec4006588d87b SURVIVED     2026-11-05T03:48:16.369Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/weak.test.ts
ae2c6e4691de4bd2 INCONCLUSIVE 2026-11-05T03:48:31.453Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/marker.test.ts
d9fa203ce7d2b6e8 KILLED       2026-11-05T03:48:11.106Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
# exit 0
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests kill-proofs --json
{
  "receipts": [
    {
      "id": "59bee44e97db8ab8",
      "verdict": "inconclusive",
      "provedAt": "2026-11-05T03:48:22.539Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max return max;\"",
      "tests": [
        "test/clamp.test.ts"
      ],
      "killedTests": []
    },
    {
      "id": "5be386b284758b33",
      "verdict": "inconclusive",
      "provedAt": "2026-11-05T03:48:26.415Z",
      "mutant": "explicit fault @ src/math.ts:8 \"return items.length;\" → \"return (null as unknown as string[]).l…",
      "tests": [
        "test/crash.test.ts"
      ],
      "killedTests": []
    },
    {
      "id": "66eec4006588d87b",
      "verdict": "survived",
      "provedAt": "2026-11-05T03:48:16.369Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max) return value;\"",
      "tests": [
        "test/weak.test.ts"
      ],
      "killedTests": []
    },
    {
      "id": "ae2c6e4691de4bd2",
      "verdict": "inconclusive",
      "provedAt": "2026-11-05T03:48:31.453Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max) return value;\"",
      "tests": [
        "test/marker.test.ts"
      ],
      "killedTests": []
    },
    {
      "id": "d9fa203ce7d2b6e8",
      "verdict": "killed",
      "provedAt": "2026-11-05T03:48:11.106Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max) return value;\"",
      "tests": [
        "test/clamp.test.ts"
      ],
      "killedTests": [
        "test/clamp.test.ts"
      ]
    }
  ]
}
# exit 0
```

</details>

### `kill-proofs --verify`: fresh

```console
$ interlinked tests kill-proofs --verify
59bee44e97db8ab8 INCONCLUSIVE 2026-11-05T03:48:22.539Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max return max;"
  tests: test/clamp.test.ts
  FRESH
5be386b284758b33 INCONCLUSIVE 2026-11-05T03:48:26.415Z explicit fault @ src/math.ts:8 "return items.length;" → "return (null as unknown as string[]).l…
  tests: test/crash.test.ts
  FRESH
66eec4006588d87b SURVIVED     2026-11-05T03:48:16.369Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/weak.test.ts
  FRESH
ae2c6e4691de4bd2 INCONCLUSIVE 2026-11-05T03:48:31.453Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/marker.test.ts
  FRESH
d9fa203ce7d2b6e8 KILLED       2026-11-05T03:48:11.106Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  FRESH
1 KILLED proof(s): 1 fresh, 0 uncommitted, 0 stale. Only KILLED proofs count as evidence.
# exit 0
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests kill-proofs --verify --json
{
  "receipts": [
    {
      "id": "59bee44e97db8ab8",
      "verdict": "inconclusive",
      "provedAt": "2026-11-05T03:48:22.539Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max return max;\"",
      "tests": [
        "test/clamp.test.ts"
      ],
      "killedTests": [],
      "freshness": "fresh"
    },
    {
      "id": "5be386b284758b33",
      "verdict": "inconclusive",
      "provedAt": "2026-11-05T03:48:26.415Z",
      "mutant": "explicit fault @ src/math.ts:8 \"return items.length;\" → \"return (null as unknown as string[]).l…",
      "tests": [
        "test/crash.test.ts"
      ],
      "killedTests": [],
      "freshness": "fresh"
    },
    {
      "id": "66eec4006588d87b",
      "verdict": "survived",
      "provedAt": "2026-11-05T03:48:16.369Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max) return value;\"",
      "tests": [
        "test/weak.test.ts"
      ],
      "killedTests": [],
      "freshness": "fresh"
    },
    {
      "id": "ae2c6e4691de4bd2",
      "verdict": "inconclusive",
      "provedAt": "2026-11-05T03:48:31.453Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max) return value;\"",
      "tests": [
        "test/marker.test.ts"
      ],
      "killedTests": [],
      "freshness": "fresh"
    },
    {
      "id": "d9fa203ce7d2b6e8",
      "verdict": "killed",
      "provedAt": "2026-11-05T03:48:11.106Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max) return value;\"",
      "tests": [
        "test/clamp.test.ts"
      ],
      "killedTests": [
        "test/clamp.test.ts"
      ],
      "freshness": "fresh"
    }
  ]
}
# exit 0
```

</details>

### `kill-proofs`: nothing recorded

```console
$ interlinked tests kill-proofs
No kill proofs recorded yet. Make one with `interlinked tests prove-kill --help`.
# exit 0
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests kill-proofs --json
{
  "receipts": []
}
# exit 0
```

</details>

### `kill-proofs --verify`: one fresh KILLED proof (committed bytes)

```console
$ interlinked tests kill-proofs --verify
d9fa203ce7d2b6e8 KILLED       2026-11-05T03:50:48.503Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  FRESH
1 KILLED proof(s): 1 fresh, 0 uncommitted, 0 stale. Only KILLED proofs count as evidence.
# exit 0
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests kill-proofs --verify --json
{
  "receipts": [
    {
      "id": "d9fa203ce7d2b6e8",
      "verdict": "killed",
      "provedAt": "2026-11-05T03:50:48.503Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max) return value;\"",
      "tests": [
        "test/clamp.test.ts"
      ],
      "killedTests": [
        "test/clamp.test.ts"
      ],
      "freshness": "fresh"
    }
  ]
}
# exit 0
```

</details>

### `kill-proofs --verify`: UNCOMMITTED (proved on uncommitted bytes)

```console
$ echo "// edge cases" >> test/clamp.test.ts   # not committed
$ interlinked tests prove-kill --test test/clamp.test.ts --file src/math.ts --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
tests: test/clamp.test.ts (2 case(s) pass in the isolated copy, 606 ms)
verdict: KILLED (566 ms under the mutant)
  survived     test/clamp.test.ts › clamps below the range
  killed       test/clamp.test.ts › clamps above the range
receipt: /tmp/kp-demo/.interlinked/test-runs/kill-proofs/e18fd17e7986f8ba.json
Proof recorded. It holds while source, tests and runtime are unchanged; check with `interlinked tests kill-proofs --verify`.
# exit 0
$ interlinked tests kill-proofs --verify
d9fa203ce7d2b6e8 KILLED       2026-11-05T03:50:48.503Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  STALE: test test/clamp.test.ts changed since the proof
e18fd17e7986f8ba KILLED       2026-11-05T03:50:52.387Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  UNCOMMITTED: test/clamp.test.ts differs from HEAD or the index; commit it so the proof covers committed bytes
2 KILLED proof(s): 0 fresh, 1 uncommitted, 1 stale. Re-run the prove-kill command of each stale proof to renew it.
# exit 1
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests kill-proofs --verify --json
{
  "receipts": [
    {
      "id": "d9fa203ce7d2b6e8",
      "verdict": "killed",
      "provedAt": "2026-11-05T03:50:48.503Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max) return value;\"",
      "tests": [
        "test/clamp.test.ts"
      ],
      "killedTests": [
        "test/clamp.test.ts"
      ],
      "freshness": "stale",
      "reasons": [
        "test test/clamp.test.ts changed since the proof"
      ]
    },
    {
      "id": "e18fd17e7986f8ba",
      "verdict": "killed",
      "provedAt": "2026-11-05T03:50:52.387Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max) return value;\"",
      "tests": [
        "test/clamp.test.ts"
      ],
      "killedTests": [
        "test/clamp.test.ts"
      ],
      "freshness": "uncommitted",
      "reasons": [
        "test/clamp.test.ts differs from HEAD or the index; commit it so the proof covers committed bytes"
      ]
    }
  ]
}
# exit 1
```

</details>

### `kill-proofs --verify` after the commit

```console
$ git commit -qam "test: note edge cases"
$ interlinked tests kill-proofs --verify
d9fa203ce7d2b6e8 KILLED       2026-11-05T03:50:48.503Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  STALE: test test/clamp.test.ts changed since the proof
e18fd17e7986f8ba KILLED       2026-11-05T03:50:52.387Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  FRESH
2 KILLED proof(s): 1 fresh, 0 uncommitted, 1 stale. Re-run the prove-kill command of each stale proof to renew it.
# exit 1
```

### `kill-proofs --verify`: STALE source

```console
$ echo '// touched' >> src/math.ts
$ interlinked tests kill-proofs --verify
e18fd17e7986f8ba KILLED       2026-11-05T03:50:56.818Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  STALE: source src/math.ts changed since the proof
1 KILLED proof(s): 0 fresh, 0 uncommitted, 1 stale. Re-run the prove-kill command of each stale proof to renew it.
# exit 1
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests kill-proofs --verify --json
{
  "receipts": [
    {
      "id": "e18fd17e7986f8ba",
      "verdict": "killed",
      "provedAt": "2026-11-05T03:50:56.818Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max) return value;\"",
      "tests": [
        "test/clamp.test.ts"
      ],
      "killedTests": [
        "test/clamp.test.ts"
      ],
      "freshness": "stale",
      "reasons": [
        "source src/math.ts changed since the proof"
      ]
    }
  ]
}
# exit 1
```

</details>

### `kill-proofs --verify`: STALE test

```console
$ echo '// touched' >> test/clamp.test.ts
$ interlinked tests kill-proofs --verify
e18fd17e7986f8ba KILLED       2026-11-05T03:50:56.818Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  STALE: test test/clamp.test.ts changed since the proof
1 KILLED proof(s): 0 fresh, 0 uncommitted, 1 stale. Re-run the prove-kill command of each stale proof to renew it.
# exit 1
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests kill-proofs --verify --json
{
  "receipts": [
    {
      "id": "e18fd17e7986f8ba",
      "verdict": "killed",
      "provedAt": "2026-11-05T03:50:56.818Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max) return value;\"",
      "tests": [
        "test/clamp.test.ts"
      ],
      "killedTests": [
        "test/clamp.test.ts"
      ],
      "freshness": "stale",
      "reasons": [
        "test test/clamp.test.ts changed since the proof"
      ]
    }
  ]
}
# exit 1
```

</details>

### `kill-proofs --verify`: STALE config

```console
$ echo '// touched' >> vitest.config.ts
$ interlinked tests kill-proofs --verify
e18fd17e7986f8ba KILLED       2026-11-05T03:50:56.818Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  STALE: vitest config vitest.config.ts changed since the proof
1 KILLED proof(s): 0 fresh, 0 uncommitted, 1 stale. Re-run the prove-kill command of each stale proof to renew it.
# exit 1
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests kill-proofs --verify --json
{
  "receipts": [
    {
      "id": "e18fd17e7986f8ba",
      "verdict": "killed",
      "provedAt": "2026-11-05T03:50:56.818Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max) return value;\"",
      "tests": [
        "test/clamp.test.ts"
      ],
      "killedTests": [
        "test/clamp.test.ts"
      ],
      "freshness": "stale",
      "reasons": [
        "vitest config vitest.config.ts changed since the proof"
      ]
    }
  ]
}
# exit 1
```

</details>

### `kill-proofs --verify`: STALE setup file

```console
$ echo '// touched' >> test/setup.ts
$ interlinked tests kill-proofs --verify
e18fd17e7986f8ba KILLED       2026-11-05T03:50:56.818Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  STALE: setup file test/setup.ts changed since the proof
1 KILLED proof(s): 0 fresh, 0 uncommitted, 1 stale. Re-run the prove-kill command of each stale proof to renew it.
# exit 1
```

<details><summary><code>--json</code></summary>

```console
$ interlinked tests kill-proofs --verify --json
{
  "receipts": [
    {
      "id": "e18fd17e7986f8ba",
      "verdict": "killed",
      "provedAt": "2026-11-05T03:50:56.818Z",
      "mutant": "explicit fault @ src/math.ts:3 \"if (value > max) return max;\" → \"if (value > max) return value;\"",
      "tests": [
        "test/clamp.test.ts"
      ],
      "killedTests": [
        "test/clamp.test.ts"
      ],
      "freshness": "stale",
      "reasons": [
        "setup file test/setup.ts changed since the proof"
      ]
    }
  ]
}
# exit 1
```

</details>

### `kill-proofs --verify` after reverting each edit

```console
$ interlinked tests kill-proofs --verify
e18fd17e7986f8ba KILLED       2026-11-05T03:50:56.818Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  FRESH
1 KILLED proof(s): 1 fresh, 0 uncommitted, 0 stale. Only KILLED proofs count as evidence.
# exit 0
```


### `--help`

```console
$ interlinked tests prove-kill --help
Usage: interlinked tests prove-kill [options]

Prove that the named tests pass now and fail under ONE mutant: a manifest
survivor (--mutant) or an explicit fault (--file/--find/--replace). A killed
proof writes a receipt bound to the source, test and runtime bytes.

Options:
  --test <file>           Test file that must catch the mutant; repeat for more
                          files
  --mutant <id>           16-hex mutant id from the mutation manifest (list:
                          interlinked mutation survivors --file <src>)
  --file <path>           Source file to mutate; required for an explicit
                          fault, narrows --mutant
  --find <text>           Explicit fault: text that occurs exactly once in
                          --file
  --replace <text>        Explicit fault: the text that replaces --find
  --run-timeout <ms>      Budget in ms for EACH vitest run (baseline, mutant,
                          then a repeat or canary copy); --timeout is the
                          whole-command deadline (default: "300000")
  --vitest-config <file>  vitest config to run with (default: the --config in
                          scripts.test, else vitest's own discovery)
  --cwd <path>            Project root (default: the current directory)
  --json                  Machine-readable result
  -h, --help              display help for command

Examples:
  interlinked tests prove-kill --test test/clamp.test.ts --file src/math.ts \
    --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
  interlinked tests prove-kill --test src/a.test.ts --mutant 575ddae6cc2946f9

Exit codes: 0 killed; 1 survived or not-passing-now; 2 inconclusive, unavailable or a bad argument.
Guide: docs/mutation-grounded-test-proof.md

$ interlinked tests kill-proofs --help
Usage: interlinked tests kill-proofs [options]

List recorded kill proofs. With --verify, check each against the bytes and
runtime on disk.

Options:
  --verify      Re-hash source, tests, config and setup files, re-locate the
                mutant, compare node and vitest
  --cwd <path>  Project root (default: the current directory)
  --json        Machine-readable list
  -h, --help    display help for command

Freshness (with --verify): FRESH, UNCOMMITTED (fresh, but the proven bytes differ from HEAD), STALE (re-run prove-kill).
Exit codes: 0, or 1 when --verify finds a KILLED proof stale or unreadable; 2 on an error.

```

Both help texts end with the program-wide "Interface boundaries / Quick start" trailer, omitted here.
