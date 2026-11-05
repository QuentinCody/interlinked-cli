# Mutation-grounded test proof

`interlinked tests prove-kill` answers one question with local execution:

> Does this test pass on the current implementation **and** fail, by its own
> check, when exactly one specified mutant or fault is applied — for the exact
> source bytes, test bytes and runtime being certified?

It writes a receipt when the answer was decided by running code. It never
infers a kill from coverage, from a `test-contract` marker, from a plausible
assertion, from an older receipt, or from a surviving-mutant count.

## Quick start

Nothing to install beyond interlinked: any git repository with vitest works.

```bash
# 1. Explicit fault: the test must pass now and fail with this one edit applied.
interlinked tests prove-kill --file src/math.ts \
  --find 'if (value > max) return max;' --replace 'if (value > max) return value;' \
  --test test/clamp.test.ts

# 2. Manifest survivor by id (list ids: interlinked mutation survivors --file <src>).
interlinked tests prove-kill --mutant 575ddae6cc2946f9 --test src/harness/server/anti-stomp.test.ts
```

Reading the verdict (add `--json` for a machine-readable result):

- `KILLED` (exit 0): a named test failed by its own check. A receipt is written.
- `SURVIVED` (exit 1): every test still passed. Assert the value the fault changes.
- `NOT-PASSING-NOW` (exit 1): a test fails on the live tree. Fix it first.
- `INCONCLUSIVE` (exit 2): a crash, load error or timeout. Nothing is proven.
- `UNAVAILABLE` (exit 2): the fault or a test could not be set up. Read the reason.

Keeping the receipt fresh: `interlinked tests kill-proofs --verify` re-hashes the
source and tests and compares the runtime. Any edit marks a `KILLED` receipt
`STALE` and exits 1; re-run the same `prove-kill` command to renew it.

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

`--test` is repeatable. `--run-timeout <ms>` bounds EACH vitest run (the baseline
copy, then the mutant copy, then the canary when needed; default 300000).
`--vitest-config <file>` passes a config to vitest; without it the `--config`
that `scripts.test` names is used, else vitest's own discovery. `--timeout <ms>` is a different flag:
the CLI's resource supervisor reads it as the whole command's deadline, and a value
below a few seconds stops the CLI before any verdict (exit 75).

## What happens

1. **Resolve the mutant.** A manifest id is re-located in the *current* source
   through the manifest identity (symbol, operator, lexeme, ordinal). If the
   source drifted so the identity no longer resolves, the run is `unavailable`.
   An explicit `--find` must occur exactly once in `--file`.
2. **Baseline.** The named test files run UNMUTATED in a fresh disposable copy
   of the project as git sees it (tracked plus untracked-not-ignored files,
   `node_modules` linked). Every case must pass. A case that fails because the
   copy lacks a file the live tree has (an ignored fixture named in the failure)
   makes the run `unavailable`; any other failure is `not-passing-now`. Nothing
   ever runs on the live tree: a live run writes tool caches there.
3. **Mutant.** A SECOND fresh copy receives the one mutated source file, so
   nothing the baseline run left behind (a marker file, a snapshot, a log) can
   fail the second run. A replacement that does not parse is `inconclusive`
   without running: a compile error is not behaviour. The same tests run in the
   copy with vitest's JSON reporter.
4. **Repeat baseline** (only when a case was killed). A third fresh,
   unmutated copy runs the tests again. A killed case must pass there; one
   that fails again was broken by state a run left OUTSIDE the copies (the
   shared `node_modules` link, the OS temp directory) and is `inconclusive`
   ("not repeatable"), never a kill.
5. **Canary** (only when every case survived). A third copy holds a
   module-level `throw` in the mutated file's place. If the named tests still
   pass, they never loaded the copy's file (a mock, an absolute import, an
   alias or a link into the live tree) and the run is `unavailable`, not
   `survived`.
6. **Verdict per case**, then overall:

| Verdict | Meaning | Exit |
|---|---|---|
| `killed` | at least one named case failed **by its own check** (an assertion, a snapshot mismatch, or a plain error thrown from the test file) | 0 |
| `survived` | every case still passed with the mutant applied; these tests do not detect it | 1 |
| `not-passing-now` | a named case fails on the live tree; the proof cannot start | 1 |
| `inconclusive` | no case failed by its own check, and at least one crashed, failed to load, or the runner timed out — nothing is proven | 2 |
| `unavailable` | the mutant does not resolve, a test file is missing, not a git work tree, or the runner could not run | 2 |

A crash in product code under the mutant (`TypeError`, a stack overflow) is
`inconclusive`, not a kill. The tests noticed *something*, but no assertion
about the intended behaviour fired; this is the same rule `tests
fail-before-fix` and `tests faults run` apply. Measured on two foreign
repositories (2026-11-04): 2 of 16 author-labelled "killed" faults fell into
this class; over ten repositories and 130 authored faults, 100 verdicts matched
the author's prediction, 11 predictions were wrong, 3 were library crashes, and
13 were a monorepo root reported `unavailable`.

## The receipt

`.interlinked/test-runs/kill-proofs/<id>.json`, with `index.json` beside it as
the small read model. A receipt binds:

- the mutated source path and sha256 of its bytes;
- the mutant: file, offset, line, lexeme, replacement, and for a manifest
  mutant its `mutantId`, `siteId`, `symbolId`, `qualifiedName`, `mutator`,
  `ordinalWithinSymbol`, manifest generation and recorded status;
- every named test file's path and sha256;
- node version, vitest version, platform, the sha256 of the vitest config in
  use, and the sha256 of every `setupFiles` / `globalSetup` file that config
  declares;
- the per-case outcomes on both sides, durations, the verdict, and
  `killedTests`: the named test files with at least one killed case, the only
  files the receipt certifies;
- a `digest` over every other field, so an edited outcome no longer matches.

The id is a hash of the inputs (bytes, mutant, runtime), so re-running the same
proof on the same bytes overwrites rather than duplicates. `kill-proofs --verify`
re-checks the digest, re-hashes the files, compares the runtime, and re-resolves
the mutant; any difference is `STALE` with the reasons named. A `survived` or
`inconclusive` receipt is kept (it records what was tried) but never counts as
evidence of a kill. Every decision (the Stop check, the nudge, the list) reads
the receipt FILE; `index.json` is only a locator. The harness refuses Write and
Edit tool calls under `.interlinked/test-runs/kill-proofs/` (a `protected_files`
rule): only the command writes there. `--verify` lists a receipt as
`UNCOMMITTED` (exit 0) when the bound source or test bytes differ from HEAD or
the index: the proof is about work-tree bytes, and a commit-time reader must
know they are not the committed ones. Receipts are tamper-evident,
not tamper-proof: the digest is unkeyed, so a receipt rewritten from scratch
with recomputed hashes passes. They are evidence of execution on this machine,
not a security boundary.

## Where the harness uses it

- **PostToolUse** (model-visible on Claude Code and Codex): writing a
  mutation-directed test file that no receipt certifies now prints
  `[interlinked:kill-proof] <file>: no executed kill proof covers this
  mutation-directed test file … prove it: interlinked tests prove-kill …`.
  A receipt certifies a file when it killed THROUGH that file and the source,
  that test file and the runtime are unchanged. Cost: one index read plus the
  hashes of the matching receipts.
- **Stop** (human-visible stderr): `[interlinked:mutation-kill-evidence]`
  accepts a receipt as measurement evidence only when EVERY newly added case
  (a literal title present now and absent at session start, in a file that
  grew) is among its killed cases; an old strong case, or one strong new case,
  never certifies another new case that killed nothing. The PostToolUse nudge
  applies the same rule against `HEAD`. A missing `test-contract` marker still
  fires. Titles that are not literals (`it.each`, template strings) never
  match, so such a file stays flagged until the proof names a literal case.
- `interlinked mutation survivors --file <src>` names the command.

Stop-time warnings reach no agent as context on any runner (Claude Code, Codex,
Factory Droid, Copilot, Gemini all put them on stderr with exit 0). The agent
sees the PostToolUse line; the human sees the Stop line.

## Limits (v1)

- vitest only. A jest or ava project gets `unavailable` with the reason
  `vitest is not installed in this project (this project declares jest) …`.
- The receipt binds the named test files and the mutated source, not the
  helpers, setup files or fixtures a test imports; an edited helper does not
  stale a receipt. (A helper cannot be named as a `--test` file: it reports no
  cases and the run is `unavailable`.)
- The two copies link the live `node_modules`, so tool caches under it (for
  example vitest's) are shared with the live tree; a test that writes into
  `node_modules` writes into the live tree.
- A test that reaches the source through an absolute path, an alias or a
  mock runs against the live, unmutated code; the canary turns that into
  `unavailable` (the tests do not load the file from the copy). A named test
  file whose real path is outside the project is refused; links that resolve
  inside the project are rewritten to the copy.
- Ignored data is never copied. A test that reads an ignored fixture fails in
  the copy and is reported `unavailable` (it passes live). A test that reads
  ignored data OPTIONALLY passes vacuously in the copy and can read as
  `survived`; nothing detects that case. Keep fixtures tracked.
- A monorepo root without its own `vitest` is `unavailable`; run with `--cwd
  <package>`.
- One run cannot detect flakiness. A flaky test that happens to pass live and
  fail under the mutant reads as a kill. Run the proof twice when in doubt.
- The copy is a git-visible copy, not an OS sandbox: a test that writes
  outside its project does so for real, as it does under `vitest run`.
- No model is involved anywhere. The differential-fuzz engine (which can
  propose a counterexample input) is a separate, manual tool and executes
  target code in-process; it is not on this path.
- Neither the proof nor vitest type-checks: a replacement that parses but
  fails the type check runs, and the tests judge it like any other mutant. A
  binder-level early error (a redeclared `let`) is not caught before the run
  either; a syntax error in the file's own dialect is.
- A receipt rewritten from scratch with a recomputed digest, through the shell
  rather than the edit tools, is not detectable from its bytes.
