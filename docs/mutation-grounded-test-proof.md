# Mutation-grounded test proof

`interlinked tests prove-kill` answers one question with local execution:

> Does this test pass on the current implementation **and** fail, by its own
> check, when exactly one specified mutant or fault is applied — for the exact
> source bytes, test bytes and runtime being certified?

It writes a receipt when the answer was decided by running code. It never
infers a kill from coverage, from a `test-contract` marker, from a plausible
assertion, from an older receipt, or from a surviving-mutant count.

## When to use it

- An agent or a developer says "I added a regression test for this bug" or
  "this test kills mutant `575ddae6cc2946f9`". Prove it before trusting it.
- `interlinked mutation survivors --file <src>` listed a survivor and someone
  wrote a test for it. The per-file measurement (`mutation measure`) takes
  minutes and needs a runner; a proof takes seconds and needs only vitest.
- A `[interlinked:kill-proof]` PostToolUse line appeared after editing a
  `*.mutation-kill.*`, `*.mutation-hardening.*` or `*.survivors?.*` test file.

## Usage

```bash
# A manifest survivor by stable id (ids: interlinked mutation survivors --file <src>)
interlinked tests prove-kill --mutant 575ddae6cc2946f9 --test src/harness/server/anti-stomp.test.ts

# An explicit fault — works in ANY git repository with vitest, no manifest needed
interlinked tests prove-kill --file src/defu.ts \
  --find 'if (value === null || value === undefined) {' \
  --replace 'if (value === undefined) {' \
  --test test/defu.test.ts

# Machine-readable
interlinked tests prove-kill ... --json

# Receipts and freshness
interlinked tests kill-proofs            # list
interlinked tests kill-proofs --verify   # re-hash, re-resolve, exit 1 if any receipt is stale
```

`--test` is repeatable. `--timeout <ms>` bounds EACH of the two test runs
(default 300000).

## What happens

1. **Resolve the mutant.** A manifest id is re-located in the *current* source
   through the manifest identity (symbol, operator, lexeme, ordinal). If the
   source drifted so the identity no longer resolves, the run is `unavailable`.
   An explicit `--find` must occur exactly once in `--file`.
2. **Baseline.** The named test files run on the live tree, read only. Every
   case must pass. A failing case stops the run: `not-passing-now`.
3. **Mutant.** A disposable copy of the project as git sees it (tracked plus
   untracked-not-ignored files, `node_modules` linked) receives the one mutated
   source file. The same tests run there with vitest's JSON reporter.
4. **Verdict per case**, then overall:

| Verdict | Meaning | Exit |
|---|---|---|
| `killed` | at least one named case failed **by its own check** (an assertion, or a plain error thrown from the test file) | 0 |
| `survived` | every case still passed with the mutant applied; these tests do not detect it | 1 |
| `not-passing-now` | a named case fails on the live tree; the proof cannot start | 1 |
| `inconclusive` | no case failed by its own check, and at least one crashed, failed to load, or the runner timed out — nothing is proven | 2 |
| `unavailable` | the mutant does not resolve, a test file is missing, not a git work tree, or the runner could not run | 2 |

A crash in product code under the mutant (`TypeError`, a stack overflow) is
`inconclusive`, not a kill. The tests noticed *something*, but no assertion
about the intended behaviour fired; this is the same rule `tests
fail-before-fix` and `tests faults run` apply. Measured on two foreign
repositories (2026-11-04): 2 of 16 author-labelled "killed" faults fell into
this class.

## The receipt

`.interlinked/test-runs/kill-proofs/<id>.json`, with `index.json` beside it as
the small read model. A receipt binds:

- the mutated source path and sha256 of its bytes;
- the mutant: file, offset, line, lexeme, replacement, and for a manifest
  mutant its `mutantId`, `siteId`, `symbolId`, `qualifiedName`, `mutator`,
  `ordinalWithinSymbol`, manifest generation and recorded status;
- every named test file's path and sha256;
- node version, vitest version, platform, and the sha256 of the
  `vitest.config.*` / `vite.config.*` in use;
- the per-case outcomes on both sides, durations, and the verdict.

The id is a hash of that binding, so re-running the same proof on the same
bytes overwrites rather than duplicates. `kill-proofs --verify` re-hashes the
files, compares the runtime, and re-resolves the mutant; any difference is
`STALE` with the reasons named. A `survived` or `inconclusive` receipt is kept
(it records what was tried) but never counts as evidence of a kill.

## Where the harness uses it

- **PostToolUse** (model-visible): writing a mutation-directed test file with
  no fresh `killed` receipt prints `[interlinked:kill-proof] <file>: no
  executed kill proof covers this mutation-directed test file … prove it:
  interlinked tests prove-kill …`. Cost: one index read plus two hashes.
- **Stop** (human-visible stderr): `[interlinked:mutation-kill-evidence]`
  accepts a fresh `killed` receipt naming the file as measurement evidence; a
  missing `test-contract` marker still fires.
- `interlinked mutation survivors --file <src>` names the command.

Stop-time warnings reach no agent as context on any runner (Claude Code, Codex,
Factory Droid, Copilot, Gemini all put them on stderr with exit 0). The agent
sees the PostToolUse line; the human sees the Stop line.

## Limits (v1)

- vitest only. A jest or ava project gets `unavailable: 'vitest' failed to launch`.
- The receipt binds the named test files and the mutated source, not the
  helpers a test imports; an edited helper does not stale a receipt. Name the
  helper as a `--test` file if that matters.
- One run cannot detect flakiness. A flaky test that happens to pass live and
  fail under the mutant reads as a kill. Run the proof twice when in doubt.
- The copy is a git-visible copy, not an OS sandbox: a test that writes
  outside its project does so for real, as it does under `vitest run`.
- No model is involved anywhere. The differential-fuzz engine (which can
  propose a counterexample input) is a separate, manual tool and executes
  target code in-process; it is not on this path.
