# Kill proof — adversarial review, round 3

Branch reviewed: `mutation-proof` at the round-2 fix `20d02882` (K1–K13). Reviewer: cloud session, 2026-11-05,
branch `cloud/falsifier-round3`. Method: throwaway git repos under `/tmp/kp3/<name>` (own `vitest.config.ts`,
`node_modules` symlinked to the clone's), driven through the real command
`npx tsx src/index.ts tests prove-kill --cwd <repo> …`, plus the real Stop detector
(`detectMutationKillEvidenceGaps`) and nudge (`killProofNudge`) against real receipts. Every REPRODUCED
false-pass / wrong-verdict is a red case in `src/harness/kill-proof/review-regressions-round3.test.ts`
(17 cases, **17/17 fail** on this branch). No product code was changed. Round-2 red file:
`review-regressions-round2.test.ts` **7/7 pass** now.

## Round-2 findings re-run

| id | outcome | evidence |
|---|---|---|
| K1 | **PARTLY** | Round-2 repro (`test/.ran` marker): `verdict: SURVIVED … EXIT=1` — fixed. Bypassed through state outside the copy, see L1. |
| K2 | FIXED | Round-2 N2 green; decisions read the receipt file. |
| K3 | **PARTLY** | A consistent edit without re-sealing is now STALE (N3 round 2 green). A rewrite with a recomputed digest passes every surface, see L2. |
| K4 | **PARTLY** | The plain repro (old strong case + new weak literal `it("kills minus")`) now leaves the Stop gap open (`stale=true`). Defeated six ways, and the nudge never applies the rule (L3, L4, L5). |
| K5 | **PARTLY** | `return a + ;` → INCONCLUSIVE (round-2 N5 green). Early errors and dialect mismatches pass the transpile check (L6); type errors are kills (L7). |
| K6 | **PARTLY** | Round-2 P1 green (ignored fixture → UNAVAILABLE). The live re-run writes into the live tree and flips the next verdict (L8). |
| K7 | FIXED | `--run-timeout 1` → JSON `unavailable` "baseline run failed: timed out after 10 ms", exit 2. `--timeout 1` is the CLI deadline (exit 75), as now documented. No leaked `/tmp/interlinked-fail-before-fix-*` (0 before, 0 after). |
| K8 | **PARTLY** | (b) a test symlinked OUTSIDE the repo → UNAVAILABLE (round-2 P2 green). In-repo routes to the live source still SURVIVE (L9). (a) node_modules is still the live one (L1). |
| K9 | FIXED | `--test test/` → `UNAVAILABLE — test is a directory; name test files`, exit 2. |
| K10 | FIXED | Survivor file nudge now reads "…did not kill through this file (every case here survived or was inconclusive)". |
| K11 | NOT FIXED | `--test test/h.test.ts --test test/helper.ts` → `UNAVAILABLE — test/helper.ts reported no executed test case in the baseline copy`, exit 2. The guide's helper workaround is still refused. |
| K12 | NOT FIXED (ARGUED) | `writeKillProof` (`receipt.ts:250`) still lists the receipts and then renames the index. Not re-raced. |
| K13 | FIXED | Two-file receipt: editing the survivor file leaves the killer's `freshKillsForTest` at 3 → 3. |

## New findings

| id | severity | where | status | test |
|---|---|---|---|---|
| L1 | false-pass | `fail-before-fix/snapshot.ts:64` (node_modules link), `run.ts:218,233` | REPRODUCED | N1, N2 |
| L2 | false-pass (trust) | `receipt.ts:108` `sealReceipt`; no write guard on `.interlinked/test-runs/kill-proofs/` | REPRODUCED | N3 |
| L3 | false-pass | `mutation-kill-evidence-stop-check.ts:207`, `receipt.ts:338-340` | REPRODUCED | N4–N8 |
| L4 | false-pass (silent) | `check-evidence/case-parser.ts:167` (line-based opener count) | REPRODUCED | N9 |
| L5 | false-pass (model channel) | `evaluator/post-tool-kill-proof.ts:41` | REPRODUCED | N10 |
| L6 | wrong-verdict | `run.ts:86` `mutantParses` | REPRODUCED | N11, N12 |
| L7 | wrong-verdict (policy) | `run.ts:86` (no type check) | REPRODUCED | N13 |
| L8 | contract + wrong-verdict | `run.ts:180` (live re-run) | REPRODUCED | N14 |
| L9 | wrong-verdict | `run.ts:70` `testFileProblem`, `snapshot.ts:43` | REPRODUCED | P1–P3 |

### L1 — state outside the copy still turns a no-op mutant into a kill (false-pass)

Two copies fixed state inside the copy. Both copies symlink the SAME live `node_modules` and share `os.tmpdir()`.
So a marker written by the baseline is still there for the mutant run. The test is round 2's `state.test.ts`, with the marker
moved to `join(process.cwd(), "node_modules", ".kp3-marker")` or to `join(tmpdir(), "kp3-marker")`. The mutant only edits a comment:

```
== nm   verdict: KILLED (704 ms under the mutant)   killed test/state.test.ts › adds once   EXIT=0
        -rw-r--r-- 1 root root 1 … /home/user/interlinked-cli/node_modules/.kp3-marker      (live checkout written)
== tmp  verdict: KILLED (646 ms under the mutant)   killed test/state.test.ts › adds once   EXIT=0
```

vitest's own results cache (`node_modules/.vite/vitest/…`) is shared the same way (ARGUED: it only reorders files).
Env vars do not leak (fresh process per run). A global port only leaks through a detached child (ARGUED). Cheapest
complete fix: run the baseline once more AFTER the mutant run (pass → fail → pass). Any one-way state then shows as
"not repeatable" instead of a kill.

### L2 — a receipt rewritten from scratch passes every surface (false-pass, trust)

We took a real SURVIVED receipt (`test/weak.mutation-kill.test.ts`, `expect(typeof add)`), set the verdict, the cases and
`killedTests`, and re-sealed it with the exported `sealReceipt`. `id` was unchanged because the inputs were unchanged:

```
before { fresh: 0, nudge: true }  after { fresh: 1, nudge: null }
tests kill-proofs --verify → fedc43d3fa6e9a82 KILLED … FRESH  EXIT=0
```

The Stop check, the nudge and `--verify` all accept it. `grep -rln kill-proofs src` finds only `run.ts`/`receipt.ts`, so no
guard watches writes there. The header says "tamper-EVIDENT, not tamper-PROOF", but that only covers a casual edit. The gated
agent has the shell, the exported sealer and write access, which is the `baseline_integrity_gate` Goodhart case. Possible
directions: block Write/Edit/Bash writes under `kill-proofs/`, like the baseline gate does, or bind each receipt to a daemon-observed
`prove-kill` command row (`activity.jsonl` tool_use_id).

### L3 — the K4 new-case rule is defeated five ways (false-pass)

`newCaseTitles` is a regex over literal first arguments. `receiptCertifies` accepts when
`requireCases.some(title => killed.some(name => name.includes(title)))`. All of these were run with real vitest (`scratch/r3/k4.ts`). In each,
the HEAD bytes hold the old strong case `it("adds two numbers", …)`, the receipt is `killed` only by an old or renamed
assertion, and every NEW case survived:

```
each              newTitles=[]                                         stale=false   (it.each → no titles → no requirement)
substring         newTitles=["adds"]                                   stale=false   ("adds two numbers".includes("adds"))
one-strong-one-weak  newTitles=["kills minus (strong)","kills boundary (weak)"]  stale=false  (some(): weak rides on strong)
renamed-old       newTitles=["kills minus mutant","kills boundary"]    stale=false   (renamed old case counts as new)
describe-wrap     killed:"kills minus adds two numbers"                stale=false   (describe prefix matched by includes)
control-weak      newTitles=["kills minus"]                            stale=true    (the K4 fix, working)
template          newTitles=["kills ${m}"]                             stale=true    (safe: never matches)
```

The comment at `stop-check.ts:203` says generated titles "simply do not constrain the receipt". That is the false pass: `requireCases`
is empty, so ANY kill certifies. Fix directions: derive new cases from vitest's reported names (run the HEAD bytes, or diff the
baseline-copy case list of HEAD vs now), match full names exactly, and require EVERY new case to be killed (`every`, not `some`).

### L4 — a multi-line `it(` is not a new case, so the Stop check is silent (false-pass)

`it(\n\t"kills minus",\n\t() => …)` gives `newCaseCount=0` (`countTestCaseOpeners` is line-based), so no hit is produced at all
(`multiline … stale=no-hit newCases=0`). Pre-existing in the detector, but it is a direct way around K4. The same
holds for `test.each\`table\`` (count 0).

### L5 — the nudge never applies the new-case rule (false-pass on the model-visible channel)

`killProofNudge` calls `certify(root, id, relPath)` without `requireCases` (`post-tool-kill-proof.ts:41`). In all 8 K4 variants
above, including `control-weak`, the nudge was `silent`. CLAUDE.md calls this PostToolUse line the ONLY model-visible channel. It
tells the agent the new weak case is covered while the stderr-only Stop line disagrees.

### L6 — the parse check misses early errors and the file's real dialect (wrong-verdict)

`ts.transpileModule` reports syntactic diagnostics only. esbuild (vite) also rejects early errors, and it parses `.js` without
JSX. With round 2's try/catch import test:

```
let q = 1; let q = 2;   (.ts)    verdict: KILLED   EXIT=0
return await a + b;     (.ts, non-async fn)  verdict: KILLED   EXIT=0
return <b>{s}</b>;      (.js)    verdict: KILLED   EXIT=0      (mutantParses → {"ok":true})
```

Also accepted by `mutantParses`: `with` in a module, `delete x` in `.mjs`. Correctly refused: TS syntax in `.js`, JSX in `.ts`, `08`.
Fix direction: classify a mutant-run LOAD failure as compile error (vitest reports the file-level error), or run
esbuild's transform with the loader vite uses for that extension.

### L7 — a type-invalid mutant is a kill (wrong-verdict, policy)

`return a + b;` → `return String(a + b);` in `add(): number`. tsc says `TS2322: Type 'string' is not assignable to type 'number'`. prove-kill says
`verdict: KILLED`, exit 0. Stryker's TS checker classifies this as CompileError, because no type-checked program contains this mutant.
Severity is low (the assertion did detect a value change), but the receipt overstates what was proven. Fixing it costs a type check
per proof, so this may be ACCEPTED as a documented limit instead.

### L8 — the "read only" live re-run writes the live tree, and that flips the next verdict (contract, wrong-verdict)

A test that passes only when a gitignored cache from an earlier run exists, i.e. one that is broken on a fresh checkout:

```
1st prove-kill  verdict: NOT-PASSING-NOW  EXIT=1      → /tmp/kp3/k6/.cache-add.json now exists (written by the live re-run)
2nd prove-kill  verdict: UNAVAILABLE — 1 case(s) pass on the live tree but fail in the isolated git-visible copy
                (ignored or untracked files are not copied)   EXIT=2
```

The header (`run.ts:18`, "The live tree is only read") and `proveKill`'s doc comment are false whenever the K6 path runs. The
second verdict also blames the copy for what is the test's own state dependence. A flaky test hits the same path.

### L9 — in-repo routes to the live source still report SURVIVED (wrong-verdict)

K8b closed only "the test's real path is outside the root". Three routes stay open. Each runs the UNMUTATED live file from inside the copy:

```
test/abs.test.ts    import { add } from "/tmp/kp3/k8/src/math"       verdict: SURVIVED  EXIT=1
test/viadir.test.ts import "../lib/math", lib -> /tmp/kp3/k8/src      verdict: SURVIVED  EXIT=1
test/alias.test.ts  -> /tmp/kp3/k8/test/real.test.ts (absolute link)  verdict: SURVIVED  EXIT=1
test/real.test.ts   (the same assertion)                              verdict: KILLED    EXIT=0
```

Exit 1 tells the agent to strengthen a test that does kill. `snapshot.ts:43` copies absolute links verbatim. Fix direction: rewrite
absolute in-root links to copy-relative links, and make "the run imported a module under the live root" an `unavailable` reason.

### Path forms (K9/K14)

These normalize and kill correctly: `./test/real.test.ts`, a trailing slash on a file (`test/real.test.ts/`), duplicates in three spellings
(relative, `./`, absolute) collapsed to one, and a shell-expanded glob over four files (mixed verdicts per file). Only the absolute-symlink
alias misbehaves (L9).

## (d) Every way a certification is granted for a file whose NEW case killed nothing

1. New case via `it.each` / `test.each` / `it.for`: no literal title, so `requireCases = []` and any killed case certifies (L3, N4).
2. A new title that is a substring of an old killed case's full name (`includes`) (L3, N5).
3. One new case kills, so every other new case in the file is certified (`some`) (L3, N6).
4. An old strong case renamed in the same edit counts as "new" and certifies the weak one (L3, N7).
5. The old killing case is wrapped in a `describe` whose title contains the new title (L3, N8).
6. A multi-line `it(` opener means no new case is counted, so no gap is ever raised (L4, N9).
7. The nudge applies no new-case rule at all (L5, N10).
8. Leaked state (node_modules, /tmp): the "new case" fails on its second run, which records a kill the mutant did not cause (L1, N1/N2).
9. A load-failure mutant the parse check accepts, plus a new import-check case (L6, N11/N12).
10. A receipt re-sealed by the agent (L2, N3).
11. ARGUED: the explicit fault is free. A trivially killable fault (`a + b → a - b`) certifies a case that claims to kill a different manifest
    survivor, because nothing ties `--find/--replace` to the survivor the file is "mutation-directed" at.
12. ARGUED: the receipt binds the mutated source and the named test files only. Weakening an imported helper or a `setupFiles` module after
    the proof keeps the receipt fresh (documented limit, still a certification path).

## (c) Timing — two copies (this repo, 5,978 git-visible files)

`--test src/harness/guard-tally.mutation-kill.test.ts --file src/harness/guard-tally.ts --find 'decision.warnings?.length ?? 0' --replace 'decision.warnings?.length ?? 1'`
(verdict SURVIVED, exit 1, in all 5 runs):

| | min | median | max |
|---|---|---|---|
| `baseline.durationMs` | 766 | 800 | 849 |
| `underMutant.durationMs` | 730 | 761 | 828 |
| total wall (CLI) | 7,022 | 7,168 | 7,842 |

Breakdown, measured separately: `createProjectCopy` 1,290 / 1,594 / 2,091 ms per copy, `cleanup` ≈ 500 ms per copy, CLI startup
(`--version`) 1,734 ms. So the two copies cost about 3.5–5 s of the ~7 s wall time, and vitest runs only ~1.6 s. Adding the L1 fix (a
third run) would reuse the baseline copy and cost about one more vitest run (~0.8 s), not a third copy.

## Tried and did not break

- K1 inside the copy (marker next to the test, gitignored): SURVIVED. Env vars do not carry between runs.
- K3 consistent edit without re-sealing: STALE. Forged index row: ignored.
- K4 plain literal weak new case: Stop gap stays open. Template-literal title `\`kills ${m}\``: never matches, so the gap stays open (safe).
- K5 `return a + ;`, TS syntax in `.js`, JSX in `.ts`, `08`: refused as not parsing.
- K6 ignored fixture: UNAVAILABLE with the correct explanation (round-2 P1).
- K7 `--run-timeout 1`: clean JSON `unavailable`. No copy leaked.
- K8b test symlinked outside the repo: UNAVAILABLE. K9 directory: clean UNAVAILABLE. K10 wording, K13 per-file freshness: correct.
- Path forms: `./`, trailing slash, duplicates in three spellings, a shell-expanded glob: normalized.
- Not tried: manifest (`--mutant`) mutants (no manifest in a throwaway repo, as in round 2), and a detached-child port squat.
