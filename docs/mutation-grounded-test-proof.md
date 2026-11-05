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
Commit first if you can: a proof of uncommitted bytes is reported `UNCOMMITTED`.

```console
$ interlinked tests prove-kill --test test/clamp.test.ts --file src/math.ts \
    --find 'if (value > max) return max;' --replace 'if (value > max) return value;'
mutant: explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
tests: test/clamp.test.ts (2 case(s) pass in the isolated copy, 615 ms)
verdict: KILLED (570 ms under the mutant)
  survived     test/clamp.test.ts › clamps below the range
  killed       test/clamp.test.ts › clamps above the range
receipt: /tmp/kp-demo/.interlinked/test-runs/kill-proofs/d9fa203ce7d2b6e8.json
Proof recorded. It holds while source, tests and runtime are unchanged; check with `interlinked tests kill-proofs --verify`.

$ interlinked tests kill-proofs --verify
d9fa203ce7d2b6e8 KILLED       2026-11-05T03:49:20.430Z explicit fault @ src/math.ts:3 "if (value > max) return max;" → "if (value > max) return value;"
  tests: test/clamp.test.ts
  FRESH
1 KILLED proof(s): 1 fresh, 0 uncommitted, 0 stale. Only KILLED proofs count as evidence.
```

A manifest survivor works the same way by id (list ids with
`interlinked mutation survivors --file <src>`):
`interlinked tests prove-kill --test src/harness/server/anti-stomp.test.ts --mutant 575ddae6cc2946f9`.

Reading the verdict (add `--json` for a machine-readable result). The last line
of the human output always says what to do next.

- `KILLED` (exit 0): a named test failed by its own check. A receipt is written.
- `SURVIVED` (exit 1): every test still passed. Assert the value the fault changes.
- `NOT-PASSING-NOW` (exit 1): a test fails before any mutation. Fix it first.
- `INCONCLUSIVE` (exit 2): the mutant did not parse, a test crashed or timed
  out, or the kill did not repeat on a clean copy. Nothing is proven.
- `UNAVAILABLE` (exit 2): the proof could not be set up. The reason names the
  cause, such as a missing test, an ignored fixture, a mock, or a workspace root.

Two flags fix most `UNAVAILABLE` runs. `--run-timeout <ms>` raises the budget
for each vitest run (default 300000). `--vitest-config <file>` picks the config
when the test is outside the default one's `include`.

Keeping the receipt fresh: `interlinked tests kill-proofs --verify` re-hashes the
source, tests, vitest config and setup files, and compares node and vitest. Any
change marks a `KILLED` receipt `STALE` and exits 1. Re-run the same
`prove-kill` command to renew it. The walkthrough of every outcome, verbatim,
is `docs/reviews/kill-proof-ux-walkthrough.md`.
The renewed receipt retires the stale one (see *Receipt retirement*), so the
check is green again as soon as the newest proof of that source × mutant × test
set holds.

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
copy, the mutant copy, then the repeat or canary copies; default 300000).
`--vitest-config <file>` passes a config to vitest; without it the `--config`
that `scripts.test` names is used, else vitest's own discovery. `--timeout <ms>`
is a different flag: the CLI's resource supervisor reads it as the whole
command's deadline (default and maximum 3600000), and a value below a few seconds
stops the CLI before any verdict (exit 75). `prove-kill` accepts the flag itself
too, so it never surfaces as a usage error; a usage error (an unknown option, a
non-numeric timeout) exits 2 like every other undecided run, never 1.

Every vitest run the proof makes is private: `--no-cache` (vitest's results
cache is never written — it would land in the live `node_modules` through the
copy's link and reorder test files between runs) and a fresh temp directory per
run (`TMPDIR`/`TMP`/`TEMP`, removed with the run), so `os.tmpdir()` state cannot
cross from one run to the next. Every vitest process runs in its own process
group; a run that passes `--run-timeout` is stopped as a group, worker included,
and the proof continues only once the group is gone. A copy over 256 MiB of
git-visible files adds a warning (`[interlinked:kill-proof] copy is N MiB; large
tracked files slow every proof`, `warnings` in `--json`); it changes no verdict.
=====

## What happens

1. **Resolve the mutant.** A manifest id is re-located in the *current* source
   through the manifest identity (symbol, operator, lexeme, ordinal). If the
   source drifted so the identity no longer resolves, the run is `unavailable`;
   so is a re-location the ordinal cannot settle (the symbol's body changed and
   the lexeme now occurs a different number of times in it — see Limits).
   An explicit `--find` must occur exactly once in `--file`.
2. **Baseline.** The named test files run UNMUTATED in a fresh disposable copy
   of the project as git sees it (tracked plus untracked-not-ignored files,
   `node_modules` linked). Every case must pass. A case that fails because the
   copy lacks a file the live tree has (an ignored fixture named in the failure)
   makes the run `unavailable`; any other failure is `not-passing-now`. Nothing
   ever runs on the live tree: a live run writes tool caches there. Each run
   gets `--no-cache` and its own temp directory (see Usage), so neither
   vitest's results cache nor `os.tmpdir()` carries anything between runs.
3. **Mutant.** A SECOND fresh copy receives the one mutated source file, so
   nothing the baseline run left behind (a marker file, a snapshot, a log) can
   fail the second run. A replacement that does not parse is `inconclusive`
   without running: a compile error is not behaviour. The same tests run in the
   copy with vitest's JSON reporter.
4. **Repeat baseline, twice** (only when a case was killed). Two more fresh,
   unmutated copies run the tests again, so a kill is the sequence pass, FAIL,
   pass, pass. A killed case must pass in both; one that fails again was
   broken by state a run left OUTSIDE the copies (`$HOME`, `/var`, a path
   beside the project — the copies' temp directory and vitest cache are
   already private) and is `inconclusive` ("not repeatable"), never a kill.
   One repeat accepted state that flips on every run (a counter that forbids
   its second reading, a marker the next run deletes): with the mutant always
   in run 2 of 3, period-2 state lined up with it. Two repeats reject every
   period-2 pattern; see Limits for what remains.
5. **Canary** (only when every case survived). A further copy holds a
   module-level `throw` in the mutated file's place, and the survivor stands
   only when three things hold. The canary run completed — a canary that times
   out or fails to launch is `unavailable` ("canary run did not complete;
   cannot show the tests load the copy"), never `survived`. Per named file,
   every baseline-passing case stopped passing — a case still passing never
   loaded the copy's file (a mock, an absolute import, an alias or a link into
   the live tree) or caught its own import error; the run is `unavailable` and
   names the cases. And the break is the tests' doing: a test whose static
   relative imports reach the mutated file is evidence by itself (a relative
   import resolves inside the copy); for any other named test a **control**
   copy — the canary plus every named test replaced by one trivial case — must
   pass. If the control breaks too, a `setupFiles` entry or the config loads
   the file, not the tests, and the run is `unavailable` with that reason.
6. **Verdict per case**, then overall:

| Verdict | Meaning | Exit |
|---|---|---|
| `killed` | at least one named case failed **by its own check** (an assertion, a snapshot mismatch, a plain error thrown from the test file, or a property-test report wrapping one of those) | 0 |
| `survived` | every case still passed with the mutant applied; these tests do not detect it | 1 |
| `not-passing-now` | a named case fails on the live tree; the proof cannot start | 1 |
| `inconclusive` | no case failed by its own check, and at least one crashed, failed to load, or the runner timed out — nothing is proven | 2 |
| `unavailable` | the mutant does not resolve, a test file is missing, not a git work tree, or the runner could not run | 2 |

A crash in product code under the mutant (`TypeError`, a stack overflow) is
`inconclusive`, not a kill. The tests noticed *something*, but no assertion
about the intended behaviour fired; this is the same rule `tests
fail-before-fix` and `tests faults run` apply. A property-based test
(fast-check) is judged by the error its counterexample report wraps — the
report's `cause`, captured by a sidecar reporter beside the JSON report, since
the report itself is thrown from `node_modules` whatever the predicate did —
so an `expect` or a predicate that returned false inside the property is the
test's own check while a product `TypeError` inside it stays `inconclusive`
(2026-11-05; before that no property test could earn a kill). Measured on two foreign
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
set. Every index rebuild (each write) marks every receipt that is not the
newest of its key with `supersededBy: <newest id>`. Superseded receipts stay on
disk as history, are never read as evidence (the Stop check, the nudge and
`freshKillsForTest` skip them even when their bytes come back), and
`kill-proofs` lists them with `SUPERSEDED by <id>`. `--verify` judges only the
newest receipt per key; a superseded receipt never fails it. Proving the same
bytes again rewrites the same id with a newer `provedAt`, which makes it the
current receipt once more. A different test set or a different fault is a
different proof and is never superseded by another.

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
- **`interlinked verify`** (default gate, streaming and `--json`): when
  `.interlinked/test-runs/kill-proofs/` holds at least one receipt, verify
  gains a `kill_proofs` section (JSON key `kill_proofs`) listing every receipt
  — verdict, source, test file(s), and the SAME freshness
  `interlinked tests kill-proofs --verify` reports (`fresh` / `uncommitted` /
  `stale` / `unreadable`, with reasons; one implementation, `listKillProofs`).
  A STALE or UNREADABLE **killed** receipt is a `kill_proof_stale` finding
  (`[proven]`: hashes and a parser decided it) that fails verify under its
  exit convention, with the fix `interlinked tests prove-kill --mutant <id>
  --test <file>`; `uncommitted` is reported, never a finding; `survived` and
  `inconclusive` receipts are listed, never findings. No receipt ⇒ no section
  and no git call (one directory probe). `--skip kill_proof_stale` keeps the
  listing and drops the finding.
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
- The copies link the live `node_modules`. vitest's own results cache is
  disabled for every run (`--no-cache`, accepted by vitest 2.1.9, 3.2.7 and
  4.1.11) and each run has a private temp directory, but any OTHER write a test
  or tool makes under `node_modules` still lands in the live tree.
- Repeats lower the odds of a false kill from state and flakiness; they do not
  end them. The kill sequence pass, FAIL, pass, pass rejects state that flips
  on every run (period 2); state that fails on exactly the second of every
  three runs (period 3) still passes, as does state kept where the proof does
  not look (`$HOME`, `/var`). A test with failure rate f gives a false kill
  with probability (1−f)³·f per proof (one repeat: (1−f)²·f, at most 14.8 %),
  and `sequence.shuffle` makes order-dependent tests exactly that. Run the
  proof twice when in doubt; a receipt is one measurement.
- A test that catches its own import of the mutated file (`try { await
  import("../src/x") } catch {}`) swallows the canary and is reported
  `unavailable` ("never load … or catch its import error"), by design: a
  survivor needs evidence that the tests observed the copy's file, and a
  swallowed import gives none. Assert on the import's result instead.
- A `setupFiles` entry or a vitest config that imports the mutated source makes
  the canary break every case without the tests' involvement. A test that also
  imports the source by a relative path is still attributed; one that reaches
  it only through an alias, a mock or a dynamic import is `unavailable`
  (the control copy breaks too). Import the source from the test.

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
- The copy is a git-visible copy
, not an OS sandbox: a test that writes
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
- **`--mutant` re-location is an ordinal rule.** A manifest mutant is the
  N-th occurrence (ascending offset) of its lexeme, under its operator, inside
  its symbol — never a line or an offset. The manifest records a `symbolHash`
  per symbol (identity.ts's normalized-token hash of the function body) and an
  ordinal per mutant, but no site count; the proof reads the measured count
  back off the symbol's own ordinals (highest ordinal + 1 over the records
  sharing operator and lexeme). Re-location then goes one of three ways:
  - symbol hash unchanged → the ordinal is trusted (an inserted comment, or an
    edit elsewhere in the file, lands here);
  - symbol hash changed, same count → the ordinal is still trusted (an
    unrelated statement added to the body); the ordinal rule cannot tell this
    from a rewrite that kept the count, so re-measure when the body changed
    around the site;
  - symbol hash changed AND the count changed → `unavailable` with
    `ambiguous re-location: <lexeme> now occurs N times in <symbol> (was M);
    re-measure the file`. No ordinal is picked. This is the C24 drift case
    (`docs/reviews/kill-proof-manifest-route.md` §3): an identical lexeme
    inserted earlier in the body took ordinal 0 — and with it the mutant id —
    so the proof mutated the new dead-code site and wrote `survived` under an
    id that had been killed. A lexeme that no longer occurs in the symbol is
    plain drift (`no site among …`), and a symbol that no longer exists is
    `source drift: symbol <name> not found (mutant <id>)`.
  `interlinked mutation measure <file>` re-measures; the ids then rank against
  the current body.
- A prefix family (`it.each`, template titles) also covers older cases that
  share the prefix; a case under `describe.each` or with a computed title can
  only be certified after it is given a literal title.
