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
`STALE` and exits 1; re-run the same `prove-kill` command to renew it. The
renewed receipt retires the stale one (see *Receipt retirement*), so the check
is green again as soon as the newest proof of that source × mutant × test set
holds.

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
interlinked tests kill-proofs            # list, newest first (200 rows; --json lists every receipt)
interlinked tests kill-proofs --verify   # re-hash, re-resolve, exit 1 if the newest receipt of any proof is stale
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
- `boundImports`: every file in the named tests' local STATIC import closure
  (helpers, shared fixture modules, re-export barrels), each with its sha256
  and `importedBy`, the named tests whose closure reaches it. The walk follows
  `import … from`, side-effect `import "…"` and `export … from` with relative
  specifiers, transitively, inside the project; it skips type-only imports,
  bare specifiers (packages and tsconfig aliases), anything under
  `node_modules` or outside the root, and the mutated source itself (bound as
  the source; its imports are not walked). A changed helper stales the
  certification of every test that imports it, and only those; `--verify` names
  it as `helper <path> changed since the proof`;
- node version, vitest version, platform, the sha256 of the vitest config in
  use, and the sha256 of every `setupFiles` / `globalSetup` file that config
  declares;
- the per-case outcomes on both sides, durations, the verdict, and
  `killedTests`: the named test files with at least one killed case, the only
  files the receipt certifies. A case is recorded under vitest's full name
  (`<file> › <describe titles and title, space-joined>`); two cases that share a
  full name (a duplicated `it("…")`, an `it.each` title without a placeholder)
  are judged one by one, paired by their position among the same-named rows in
  report order, so a weak duplicate of a strong case records `survived` beside
  the strong case's `killed`;
- a `digest` over every other field, so an edited outcome no longer matches.

The id is a hash of the inputs (bytes, bound helpers, mutant, runtime), so re-running the same
proof on the same bytes overwrites rather than duplicates. `kill-proofs --verify`
re-checks the digest, re-hashes the files, compares the runtime, and re-resolves
the mutant; any difference is `STALE` with the reasons named. A `survived` or
`inconclusive` receipt is kept (it records what was tried) but never counts as
evidence of a kill. Every decision (the Stop check, the nudge, the list) reads
the receipt FILE; `index.json` is only a locator. It is rebuilt from the receipt
files under a short exclusive lock, so concurrent writers cannot drop each
other's rows; a writer that cannot take the lock still writes its receipt and
leaves the index to the next writer's rebuild. The harness refuses Write, Edit and
NotebookEdit tool calls under `.interlinked/test-runs/kill-proofs/` (a
`protected_files` rule matched against the write's REAL path, so a symlinked
receipts folder does not slip past): only the command writes there. A receipt
file is only the receipt whose `id` it names: a copy under another valid name
is unreadable, never a second receipt. `--verify` lists a receipt as
`UNCOMMITTED` (exit 0) when the sha256 a bound source, test or helper was
proven at is not the sha256 of that path's blob in HEAD and in the index: the
proof is about work-tree bytes, and a commit-time reader must know they are not
the committed ones. The comparison reads git's blobs, never `git status`, so an
index flag (`--skip-worktree`, `--assume-unchanged`) cannot hide modified bytes.
Receipts are tamper-evident, not tamper-proof: the digest is unkeyed, so a
receipt rewritten from scratch with recomputed hashes passes. They are evidence
of execution on this machine, not a security boundary.

### Receipt retirement

A receipt's id binds the exact bytes, so every re-proof after an edit writes a
NEW receipt. The proof it renews is identified by its *proof key*: the source
path, the mutant's identity (a manifest id, or for an explicit fault its file,
`--find` lexeme and `--replace` text — the offset is not part of it, so a proof
renewed after an edit above the fault is the same proof) and the named test
set. On every write, older receipts with the same key are moved to
`.interlinked/test-runs/kill-proofs/superseded/`: they are kept as history, are
never read as evidence (not in `index.json`, not by the Stop check or the
nudge), and `kill-proofs` lists them with `SUPERSEDED by <id>`. `--verify`
judges only the newest receipt per key; a superseded receipt never fails it. A
receipt an older build left unretired is still ranked newest-per-key by the
listing. Proving the same bytes again revives the retired receipt (same id).
A different test set or a different fault is a different proof and is never
retired by another.

## Where the harness uses it

- **PostToolUse** (model-visible on Claude Code and Codex): writing a
  mutation-directed test file that no receipt certifies now prints
  `[interlinked:kill-proof] <file>: no executed kill proof covers this
  mutation-directed test file … prove it: interlinked tests prove-kill …`.
  A receipt certifies a file when it killed THROUGH that file and the source,
  that test file, the helpers it imports and the runtime are unchanged. Cost: one index read plus the
  hashes of the matching receipts.
- **Stop** (human-visible stderr): `[interlinked:mutation-kill-evidence]`
  accepts a receipt as measurement evidence only when EVERY newly added case is
  covered by its killed cases; an old strong case, one strong new case, or the
  strong twin of a weak duplicate never certifies a case that killed nothing.
  The PostToolUse nudge applies the same rule against `HEAD`. A missing
  `test-contract` marker still fires.
- `interlinked mutation survivors --file <src>` names the command.

### How a new case is derived and matched

Both surfaces read the cases from the TypeScript AST of the test file
(`kill-proof/source-cases.ts`), before (the git baseline) and after the edit:

- A case is a call whose callee chain starts at a bare `it` or `test` (so
  `/re/.test("…")` or `obj.test(…)` is never one), optionally through `.only`,
  `.skip`, `.todo`, `.concurrent`, `.sequential`, `.fails` and the configuring
  calls `.each(...)`, `` .each`…` ``, `.for(...)`, `.skipIf(...)`, `.runIf(...)`;
  `const t = test.extend(...)` makes `t(...)` a case. `describe` / `suite`
  ancestors contribute their titles, space-joined, exactly as vitest's full name.
- A string title is its cooked value (`"says \"max\""` is matched as
  `says "max"`); an identifier bound once to a string literal in the file
  resolves to it. Matching is EXACT on the full name — never a suffix: a new
  `it("max")` is not certified by an old `describe("caps") it("at max")`.
- An `.each` / `.for` title with a `%i` / `%s` / `%d` / `%j` / `%o` / `%#` /
  `$prop` placeholder, or a template literal with substitutions, is a *prefix
  family*: the literal text before the first placeholder (a `%%` before it is
  a literal percent). The family is certified when EVERY recorded case of that
  file whose name starts with the prefix killed, and at least one exists.
  Residual limit: an old case that happens to share the prefix is part of the
  family, so a surviving old `caps at max` blocks a fully killed
  `it.each([5, 6])("caps %i")`; name the family distinctly.
- A computed title (a call, an ambiguous identifier, an empty prefix, a case
  under `describe.each` or under a non-literal `describe`) is *unresolvable*:
  it counts as a new case and can never be certified by name, so the file stays
  flagged until the title is literal.
- Identity is a MULTISET: a weak duplicate of an existing title is one more
  case, and it is certified only when every recorded case of that name killed.
- A case whose title is new but whose body (its `.each` table and callback
  text, whitespace collapsed) equals a removed case's is a RENAME and makes no
  claim. A new title with a new body is a new case whether or not the file
  grew: swapping a strong case for a weak one opens the gap on both surfaces.
- Without `typescript` installed the walk degrades to a literal-title regex
  (bare `it`/`test` head, no ancestors, no renames) and matches titles exactly.

Stop-time warnings reach no agent as context on any runner (Claude Code, Codex,
Factory Droid, Copilot, Gemini all put them on stderr with exit 0). The agent
sees the PostToolUse line; the human sees the Stop line.

## Limits (v1)

- vitest only. A jest or ava project gets `unavailable` with the reason
  `vitest is not installed in this project (this project declares jest) …`.
- Helper binding follows static relative imports only, and stops after 200
  files (the closure beyond the cap is not bound). Dynamic `import()`,
  `require()` and `vi.mock` targets are not followed, nor are aliased (bare)
  specifiers; an edit to a module reached only that way does not stale a
  receipt. Data files a test reads (JSON fixtures, snapshots) are not bound.
  (A helper still cannot be named as a `--test` file: it reports no cases and
  the run is `unavailable`.)
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
- A prefix family (`it.each`, template titles) also covers older cases that
  share the prefix; a case under `describe.each` or with a computed title can
  only be certified after it is given a literal title.
