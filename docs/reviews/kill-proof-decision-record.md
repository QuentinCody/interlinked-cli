# Kill proof — decision record

Branch `mutation-proof` at `816cbdc` (52 commits over `origin/main`), recorded 2026-11-05
on `cloud/decision-record`. Every file:line below was checked against that tree with `rg`.
A resolution without a file:line is marked UNVERIFIED. Commit shas are from
`git log origin/main..HEAD`.

## 1. The question and the verdict vocabulary

Does the named test pass on the current implementation and fail, by its own check, when
exactly one specified mutant is applied, for the exact source, test and runtime bytes
being certified? (`docs/mutation-grounded-test-proof.md:5-8`.)

| Verdict | Meaning | Exit | Where |
|---|---|---|---|
| `killed` | a named case failed by its own check; receipt written | 0 | `src/commands/tests-prove-kill.ts:29,45` |
| `survived` | every case still passed under the mutant | 1 | `tests-prove-kill.ts:46` |
| `not-passing-now` | a named case fails before any mutation | 1 | `tests-prove-kill.ts:44` |
| `inconclusive` | no parse, crash, load error, timeout, or kill not repeatable | 2 | `tests-prove-kill.ts:46` |
| `unavailable` | the proof could not be set up (mutant, test file, canary, vitest) | 2 | `tests-prove-kill.ts:44` |

`--run-timeout` bounds each vitest run (`tests-prove-kill.ts:96`); `--timeout` is the CLI
supervisor's deadline (exit 75). `kill-proofs --verify` exits 1 only for a stale or
unreadable KILLED receipt (`tests-prove-kill.ts:161-163`).

## 2. Every finding

Pin = `file › case title`. Test files: `R2` = `src/harness/kill-proof/review-regressions-round2.test.ts`,
`R3` = `…/review-regressions-round3.test.ts`, `G` = `…/review-regressions-git.test.ts`,
`KP` = `src/harness/kill-proof/kill-proof.test.ts`, `BI` = `…/bound-imports.test.ts`,
`PT` = `src/harness/evaluator/post-tool-kill-proof.test.ts`, `AD` =
`src/harness/adapters/kill-proof-nudge-encoding.test.ts`.

Round 1 (R1–R14) has no review document in the tree. The ids survive only as code comments
and test titles from the first commit (`978ec50`); R6 and R11 appear nowhere and are UNVERIFIED.

| # | id | defect | sev | resolution | pin |
|---|---|---|---|---|---|
| 1 | R1 | vitest positional filters are substrings: cases from unnamed files counted | false-pass | FIXED `978ec50`, `src/harness/kill-proof/run.ts:13-14` | `KP › N7: cases from files NOT named by --test are ignored…` (`KP:235`) |
| 2 | R2 | a receipt certified every named file, not only the killing ones | false-pass | FIXED `978ec50`, `run.ts:169` (`killedTests`), `receipt.ts:11` | `KP › P1: … the receipt binds … the killing file` (`KP:87`) |
| 3 | R3 | baseline ran on the live tree (ignored fixture/cache could read as a kill) | wrong-verdict | SUPERSEDED: the one-copy design (`978ec50`) caused K1; now two fresh copies, `run.ts:9-11` | see K1 |
| 4 | R4 | a `node:assert` raised from product code counted as the test's check | false-pass | FIXED `978ec50`, `run.ts:57` | `KP › N8: a node:assert raised by PRODUCT code…` (`KP:242`) |
| 5 | R5 | a fixture / data file accepted as the mutation target | wrong-verdict | FIXED `978ec50`, `run.ts:209` | `KP › N10: a fixture or data file is not a proof target` (`KP:253`) |
| 6 | R6 | not recorded in the tree | — | UNVERIFIED | — |
| 7 | R7 | a hand-flipped or copied receipt read as fresh | false-pass | FIXED `978ec50`, id re-derived `receipt.ts:133-136` | `KP › N5: a hand-flipped verdict is stale…` (`KP:310`), `N6: … copied from another checkout` (`KP:338`) |
| 8 | R8 | an index row with no readable receipt counted | false-pass | FIXED `978ec50` | `KP › N7: an index row with no receipt file is nothing` (`KP:342`); `PT › P5` (`PT:41`) |
| 9 | R9 | a changed runtime (node/vitest/platform) kept a receipt fresh | false-pass | FIXED `978ec50`, `receipt.ts:112` | `KP › N8: a receipt whose runtime changed is stale for the Stop reader too` (`KP:348`) |
| 10 | R10 | re-located mutant not checked against the proof-time line text | false-pass | FIXED `978ec50`, `types.ts:26`, `receipt.ts:383` | `KP:97` (`lineText` bound in P1) |
| 11 | R11 | not recorded in the tree | — | UNVERIFIED | — |
| 12 | R12 | index read-modify-write could drop rows | usability | FIXED `978ec50`, rebuilt from files `receipt.ts:5-6` | `KP › P2: the index is rebuilt from the receipt files…` (`KP:280`) |
| 13 | R13 | nudge paths resolved against the tool call's cwd, not the project root | wrong-verdict | FIXED `978ec50`, `post-tool-kill-proof.ts:14-15` | UNVERIFIED (no cwd case in `PT`) |
| 14 | R14 | skipped/todo cases counted as passing | false-pass | FIXED `978ec50`, `run.ts:55` | `KP › N9: a skipped case in the baseline is neither passing nor failing` (`KP:247`) |
| 15 | K1 | baseline state left in the shared copy failed the mutant run as a "kill" | false-pass | FIXED `20d0288`: second fresh copy `run.ts:9-11,270` | `R2 › N1: a test that fails on its second run…` |
| 16 | K2 | Stop/nudge/`--verify` trusted index-row verdict and `killedTests` | false-pass | FIXED `20d0288`, `receipt.ts:416-420` | `R2 › N2: a forged index row … does not silence the nudge` |
| 17 | K3 | receipt id bound no outcome field; consistent edit passed | false-pass | FIXED `20d0288`: digest `receipt.ts:145-152` | `R2 › N3`; `KP › N9: … caught by the digest` (`KP:323`) |
| 18 | K4 | any old killing case discharged a file with a new weak case | false-pass | FIXED `20d0288`, `mutation-kill-evidence-stop-check.ts:203-217` | `R2 › N4`; `KP › N10` (`KP:333`) |
| 19 | K5 | a syntax error caught by a try/catch import read as a kill | wrong-verdict | FIXED `20d0288`, `run.ts:98-99` | `R2 › N5: a syntax-invalid replacement…` |
| 20 | K6 | copy-only failure (ignored fixture) reported NOT-PASSING-NOW | wrong-verdict | FIXED `20d0288`, then L8 rewrote it: `run.ts:221-233` | `R2 › P1: … needs an ignored fixture is not reported NOT-PASSING-NOW` |
| 21 | K7 | `--timeout` was both per-run budget and CLI deadline (exit 75, no JSON) | contract | FIXED `20d0288`: `--run-timeout` `tests-prove-kill.ts:96` | `src/commands/tests-prove-kill.test.ts › P4: an inconclusive timeout names --run-timeout` |
| 22 | K8a | shared `node_modules` link and OS tmp leak state | false-pass | FIXED as L1 (repeat baseline) | see L1 |
| 23 | K8b | test symlinked outside the repo ran the live source: SURVIVED | wrong-verdict | FIXED `20d0288`, `run.ts:77-83` | `R2 › P2`; `KP › N15` (`KP:213`) |
| 24 | K9 | `--test <dir>` crashed with raw EISDIR | usability | FIXED `20d0288`, `run.ts:81` | `KP › N15: a --test directory … is unavailable` |
| 25 | K10 | nudge echoed the receipt verdict for a non-killing file | usability | FIXED `20d0288`/`fce119b`, `tests-prove-kill.ts:136` | `PT › P3: survived receipts count as runs that did not kill through this file` (`PT:33`) |
| 26 | K11 | helpers imported by a test were not bound; the guide's workaround was refused | false-pass | FIXED `56cafa0`: `bound-imports.ts`, `receipt.ts:13-14` | `BI › P2: a helper edit stales the certification of the test that imports it` (`BI:66`) |
| 27 | K12 | index rebuild race between writers | usability | FIXED `56cafa0`: lock `receipt.ts:305-312` | `BI › P6: 20 concurrent writeKillProof calls leave an index with 20 rows` (`BI:153`) |
| 28 | K13 | editing a survivor file staled the killer file's certification | usability | FIXED `56cafa0`, per-file `receipt.ts:12` | `BI › P3: a helper edit stales ONLY the tests that import it (K13)` (`BI:78`) |
| 29 | L1 | state outside the copies (node_modules link, tmpdir) still made a kill | false-pass | FIXED `c6ab785`: repeat baseline `run.ts:288-296` | `R3 › N1`, `R3 › N2` |
| 30 | L2 | a receipt re-sealed with the exported sealer passes every reader | trust | PARTLY: edit tools refused, `src/harness/rules/default-config-resolvers.ts:80-82`; byte-level rewrite is POLICY (`docs/mutation-grounded-test-proof.md:252-253`) | `R3 › N3 (policy)` is `it.todo` (`R3:145`); no pin for the rule |
| 31 | L3 | new-case rule defeated by `it.each`, substring, `some()`, rename, describe prefix | false-pass | FIXED `c6ab785`: exact suffix match `receipt.ts:409-411`, every new case `receipt.ts:430-432` | `R3 › N4`–`N8` |
| 32 | L4 | multi-line `it(` not counted as a new case | false-pass | FIXED `c6ab785`, title count `mutation-kill-evidence-stop-check.ts:329-334` | `R3 › N9: a new case whose title sits on the line after it(…` |
| 33 | L5 | the model-visible nudge applied no new-case rule | false-pass | FIXED `c6ab785`, `post-tool-kill-proof.ts:35,58` | `R3 › N10: the PostToolUse nudge is not silenced…` |
| 34 | L6 | parse check missed JSX in `.js` and binder early errors | wrong-verdict | PARTLY: own dialect + JSX refusal `run.ts:102-114` (`c6ab785`); early errors POLICY (`guide:250-251`) | `R3 › N12: JSX written into a .js file is not a kill`; `N11 (policy)` todo |
| 35 | L7 | a type-invalid mutant is a kill | policy | POLICY: no type check per proof, `docs/mutation-grounded-test-proof.md:248-251` | `R3 › N13 (policy)` todo (`R3:230`) |
| 36 | L8 | the "read-only" live re-run wrote the live tree and flipped the next verdict | contract | FIXED `c6ab785`: no live run, `run.ts:221-223` | `R3 › N14: a baseline failure re-checked on the live tree does not write into the live tree` |
| 37 | L9 | in-repo absolute import / symlinked dir / absolute link still SURVIVED | wrong-verdict | FIXED `7362d63`: canary `run.ts:51-52,301-307`; links `snapshot.ts:39-47` | `R3 › P1`–`P3` |
| 38 | git N1 | absolute in-repo source symlink pointed the copy at the live file | wrong-verdict | FIXED `7362d63`, `src/harness/fail-before-fix/snapshot.ts:39-47` | `G › N1: an absolute in-repo source symlink…` |
| 39 | git N2 | absolute in-repo test symlink, same | wrong-verdict | FIXED `7362d63`, same | `G › N2` |
| 40 | git N3 | ignored fixture missing from the copy labelled "fails on the live tree" | wrong-verdict | FIXED `7362d63`/`c6ab785`, `run.ts:221-233` | `G › N3` |
| 41 | git N4 | ignored fixture read optionally passes vacuously: SURVIVED | wrong-verdict | OPEN unassigned; documented `guide:235-240` | `G › N4 (known gap)` is `it.todo` (`G:115`) |
| 42 | git N5 | non-default vitest config in `scripts.test` ignored | wrong-verdict | FIXED `7362d63`: `receipt.ts:64-70`, `--vitest-config` | `G › N5`; `KP › P6: --vitest-config … is passed to every vitest run` (`KP:123`) |
| 43 | git N6 | `vi.mock` factory importing the live source: SURVIVED | wrong-verdict | FIXED `7362d63`: canary `run.ts:301-307` | `G › N6` |
| 44 | git N7 | `resolve.alias` into the live tree: SURVIVED | wrong-verdict | FIXED `7362d63`: canary | `G › N7` |
| 45 | git N8 | receipt silent about index/HEAD ≠ work tree | contract | FIXED `7362d63`: `UNCOMMITTED`, `receipt.ts:391-393`, `tests-prove-kill.ts:126-128` | `G › N8` |
| 46 | git N9 | `setupFiles` / `globalSetup` not bound | false-pass | FIXED `7362d63`, `receipt.ts:84-90` | `G › N9: editing a config-declared setupFile stales the receipt` |
| 47 | git 1a/1b | a symlinked source throws a raw error after the baseline ran | usability | OPEN unassigned: `snapshot.ts:34` still throws; no pre-check in `run.ts` | none |
| 48 | git 5c/6a/8c/9c/9e | "no executed test case" carried no cause | usability | FIXED `4e8c047`: hint `run.ts:139` | UX walkthrough "test not run" row |
| 49 | git 3a | `--find` with `\n` on a CRLF file says "0 times" without naming CRLF | usability | OPEN unassigned (no `\r` handling in `resolve.ts`) | none |
| 50 | git 4 / UX F1 | a superseded stale receipt keeps `--verify` at exit 1; no prune | usability | OPEN unassigned (no `prune` in `tests-prove-kill.ts` or `registrars/tests.ts`) | none |
| 51 | UX F2 | a KILLED verdict lists other cases as `survived` | wording | POLICY: per-case truth, verdict line decides | `tests-prove-kill.test.ts › P1: killed lists cases…` |
| 52 | UX F3 | a test outside `include` is `unavailable` though vitest would run it by name | usability | POLICY with hint `run.ts:139` | — |
| 53 | round 4 M-series | runner / receipt findings named by the task | — | NOT IN TREE: no round-4 document, no `M<n>` id in `docs/` or `src/` | — |
| 54 | MR §3 (C24) | manifest re-location after a body edit mutated a new dead-code site and wrote `survived` under a killed id | false-pass | FIXED `3c29429`, `src/harness/mutation/differential-fuzz-locate.ts:96-99` | `src/harness/kill-proof/resolve.test.ts › P1: the C24 scenario … is refused as ambiguous` (`:76`); `differential-fuzz-locate.test.ts › P9` (`:133`) |
| 55 | MR §4 | rename reported "1 candidate token(s)" instead of "symbol not found" | usability | FIXED `3c29429`, `differential-fuzz-locate.ts:118` | `resolve.test.ts › P3` (`:92`) |
| 56 | MR §1 | `seedFileBaseline` stamps no measurement provenance | usability | OPEN unassigned (`src/harness/mutation/adopt.ts:99`; no `provenance` in file) | none |
| 57 | MR gotcha | `npx tsx src/index.ts` crashes on a renamed/deleted module the CLI imports | environment | OPEN unassigned; use `node dist/index.js` | none |
| 58 | RK obs 1 | load failure under the mutant recorded as generic "no result under the mutant" | usability | OPEN unassigned, `run.ts:158` | none |
| 59 | RK obs 2 | lexeme truncation lost its closing quote | cosmetic | FIXED `c2113cc`, `receipt.ts:118` | none |
| 60 | RK obs 3/4, RK2 obs 1 | comment-only edits stale; `--verify` exits 0 with stale survived receipts | policy | POLICY: byte binding; only KILLED is evidence (`tests-prove-kill.ts:161-163`) | `tests-prove-kill.test.ts › P1: a verified stale row names its reasons` |
| 61 | RK2 obs 3 | vitest `%j` renders `NaN`/`Infinity` as `null` in case names | external | POLICY (vitest) | — |
| 62 | CH defect | `member-chain-scan.ts isChainLink` accepts a bare `?`, so `await c ? a.forEach(async…) : 0` is suppressed | product false-negative | OPEN unassigned: `src/harness/checks/member-chain-scan.ts:19` still `c === "?" \|\| c === "!"` | none |
| 63 | CH gaps 1–3 | html-duplicate-id stray `</template>`, `forbids_after` without session, biome `syntax` header | test gap | FIXED `069aec9`: 10 `*.mutation-kill.test.ts` files | e.g. `src/harness/checks/html-duplicate-id.mutation-kill.test.ts` |
| 64 | CL gaps 1–3 | cold package guard `run_command`, `git stash clear`, write verb `save` | test gap | FIXED `b947e21`: 10 files | e.g. `src/lib/hook-template-chunks/package-install-cold-guard.mutation-kill.test.ts` |
| 65 | V-A1 | canary string read as a printed `interlinked kill-proof` command | test regression | FIXED `6f470b5`, `run.ts:51-52` | `src/cli-program.test.ts › every printed interlinked … command exists in the commander tree` (`:167`) |
| 66 | V-A2 | `--vitest-config` had no behaviour-pinning test | test regression | FIXED `ae38a6f` | `KP › P6` (`KP:123`) |
| 67 | V-B/C | 5 files fail on `main`; 26 fail only as root | environment | not this feature; recorded in `kill-proof-verification-1768aa3c.md` | — |
| 68 | AD-1 | Stop declared `modelContext: true` on Claude Code / Codex | over-claim | FIXED `9bbd0f8`, `provider-capabilities.ts:69,124` | `AD › N9: %s Stop declares no model context` (`AD:145`) |
| 69 | AD-2 | PostToolUse warnings hidden from the model on Factory, Copilot, Gemini | channel | FIXED `24a505e`, `provider-decisions.ts postToolContextText` | `AD › P7`–`P9` (`AD:64-78`) |
| 70 | AD-3 | `SubagentStop` still declares `modelContext: true` with a `continue`-only catalog | over-claim | OPEN unassigned, `provider-capabilities.ts:90,138` | none |
| 71 | SH #1 | sidecar `exit` handler of a replaced child fails the new child's requests | product bug (TRUE) | FIXED `f52dc98`, `src/harness/content-scanner/sidecar-manager.ts` | `src/harness/jev/stale-handle-live.test.ts › P1` (`:28`) |
| 72 | SH #2 | same for the `error` handler | UNSURE | OPEN unassigned | `stale-handle-live.test.ts › it.todo UNSURE` (`:77`) |
| 73 | EV | foreign suites cannot execute in the cloud environment | environment | OPEN: `evals/mutation-proof-validation/CLOUD-RUN.md` | — |
| 74 | R3 arg 11 | the explicit fault is free: a trivial fault certifies a file claiming another survivor | policy | OPEN unassigned; documented (`kill-proof-review-round3.md` §d.11) | none |
| 75 | R3 arg 12 | `vi.mock` / dynamic / aliased helper edits do not stale a receipt | policy | POLICY, `guide:220-226` | `BI › N4` (`BI:122`) |

## 3. Design invariants that survived, and the finding that forced each

| Invariant | Forced by | Where |
|---|---|---|
| Baseline and mutant run in two fresh git-visible copies; the live tree is never run | K1, L8 | `run.ts:9-11,221-223` |
| A kill must repeat: a third unmutated copy passes again, else `inconclusive` | L1 (K8a) | `run.ts:288-296` |
| A survivor needs a canary: a module-level throw must break the tests, else `unavailable` | L9, git N6/N7 | `run.ts:51-52,301-307` |
| Own-check rule: killed only by assertion/snapshot/test-file throw; crash, load error, timeout, `node:assert` from product code are not kills | R4, K5, R14 | `run.ts:55-57,98-99` |
| Per-file certification: `killedTests` is the only certified set; per test file bytes | R2, K13 | `run.ts:169`, `receipt.ts:11-12` |
| Bound helpers: the static local import closure, ≤200 files, with `importedBy` | K11, K13 | `bound-imports.ts:2`, `receipt.ts:13-14` |
| Tamper-evident receipts: digest over every field, decisions read the file, edit tools refused | K2, K3, L2, R7, R8 | `receipt.ts:5-16,145-152,416`, `default-config-resolvers.ts:80` |
| Every new literal case must itself be killed; exact suffix match; nudge applies the same rule | K4, L3, L4, L5 | `receipt.ts:409-432`, `stop-check.ts:329-334`, `post-tool-kill-proof.ts:35` |
| Identity re-location refusal: changed symbol hash and changed site count is `unavailable` | MR §3 (C24) | `differential-fuzz-locate.ts:96-99` |
| Links into the root are rewritten to the copy; a test outside the root is refused | git N1/N2, K8b | `snapshot.ts:39-47`, `run.ts:83` |
| Runtime and config inputs are bound: node, vitest, platform, config hash, setup files | R9, git N5, git N9 | `receipt.ts:84-90,112` |
| Work-tree proofs are labelled `UNCOMMITTED` for commit-time readers | git N8 | `receipt.ts:391`, `tests-prove-kill.ts:126` |

## 4. Measured numbers, with denominators

Receipt ids were counted as distinct 16-hex strings in each report.

| Measurement | Value | Source |
|---|---|---|
| This repo, batch 1: faults vs companion tests | 6/8 survived (1 equivalent) | `kill-proof-real-kills.md` |
| Batch 1: new mutation-kill files proven | 5/5 killed; 20 receipt ids in the report | same |
| Batch 2 (`src/lib`, `src/commands`): companion | 8/10 survived | `kill-proof-real-kills-2.md` |
| Batch 2: new files proven | 6/6 killed; 25 receipt ids | same |
| Census `src/harness`: survivor rate | 24/40 (60%); 0 strict equivalents; 51 receipt ids | `kill-proof-census-harness.md` |
| Census harness: new files | 10/10 killed | same |
| Census `src/lib` + `src/commands`: survivor rate | 32/39 (82%) after 1 equivalent; 51 receipt ids | `kill-proof-census-lib.md` |
| Census lib: new files | 10/10 killed | same |
| Manifest route (`--mutant`): survivors killed by new cases | 4/5 (1 equivalent); 12 receipts of 22 ids (10 are mutant ids) | `kill-proof-manifest-route.md` |
| Mutation-kill test files added on the branch | 31 (`git diff --name-only origin/main...HEAD`) | tree |
| Foreign corpora, 10 repos × 13 faults = 130 | CLAUDE.md:1833 says 104 as predicted / 11 wrong / 3 crash / 13 unavailable (sums to 131); the guide (`:142-144`) says 100 / 11 / 3 / 13 (sums to 127). UNVERIFIED: no round-1 results file is in the tree | `CLAUDE.md`, guide |
| Foreign round 2, in-tree per-repo "local k/n" | zimmerframe 11/13, esrap 12/13, is-what 12/13, ultrahtml 8/13, entities 12/13, clack 0/13 (root cwd) = 55/78 | `evals/mutation-proof-validation/CLOUD-RUN.md` |
| Foreign cloud execution | 0/78 executed (refused by the environment) | same |
| Stale-handle detector precision (side review) | 1 TRUE, 1 UNSURE, 0 FALSE on 423,792 + 34,081 lines | `stale-handle-live-precision.md` |

Proof wall time per `prove-kill` invocation (this repo, 5,975 git-visible files):

| Environment / state | Wall time | Source |
|---|---|---|
| Round 3, two copies, before the repeat baseline | 7.0–7.8 s (vitest ≈ 1.6 s of it) | `kill-proof-review-round3.md` §c |
| Batch 1, `npx tsx` from source | 10.0–11.3 s | real-kills |
| Batch 2 | 6.0–10.1 s | real-kills-2 |
| Census harness (50 proofs) | 8.8 s min, 9.5 s median, 20.6 s max | census-harness |
| Census lib (50 proofs) | 8.4 s min, 10.3 s median, 18.6 s max | census-lib |
| Copy-on-write clone (`70207e4`) | whole proof 4.35 s → 3.56 s | commit body |
| Demo repo, built CLI | ≈ 0.6 s per vitest run | UX walkthrough |

Adapter channel matrix (`kill-proof-adapter-matrix.md`; all unit-encoded, none runtime-verified):

| Runner | PostToolUse nudge reaches the model | Stop warning |
|---|---|---|
| Claude Code | yes, `hookSpecificOutput.additionalContext` (P1) | stderr only (N4) |
| Codex | yes (P2) | stderr only (N5) |
| Factory Droid | yes since `24a505e` (P7) | stderr only (N6, N10) |
| Copilot CLI | yes, top-level `additionalContext` (P8) | stderr only (N7, N11) |
| Gemini CLI | yes (P9) | stderr only (N8, N12) |

## 5. Known limits still open, ranked by the harm of a wrong verdict

1. **A receipt rewritten from scratch passes every reader** (L2, policy). Attack: load a
   SURVIVED receipt, set `verdict`/`killedTests`, call the exported `sealReceipt`, write it
   through the shell. The edit-tool rule (`default-config-resolvers.ts:80`) does not see a
   shell write. Harm: a forged kill certifies a weak test.
2. **A vacuous survivor from optional ignored data** (git N4). Attack: a test that reads an
   ignored fixture with `existsSync ? … : []` passes in the copy and reads `survived`;
   the real test may kill. Harm: an agent is told to strengthen a test that works.
3. **The explicit fault is free** (round 3 §d.11). Attack: prove a `*.mutation-kill` file
   against `a + b → a - b` while it claims to kill a different survivor. Harm: the Stop
   check and nudge are discharged for a claim nothing tied to the fault.
4. **Unbound reach**: `vi.mock`, dynamic `import()`, `require()`, aliased specifiers and data
   fixtures are not bound (`guide:220-226`). Attack: weaken a helper reached only through
   `vi.mock` after the proof; `--verify` stays FRESH.
5. **Type-invalid and early-error mutants run** (L6 partly, L7). Attack: `return String(a+b)`
   in a `number` function reads as a kill although no type-checked program holds it.
   Harm: low; the receipt overstates what was proven.
6. **One run cannot see flakiness** (`guide:241-243`). Attack: a test that passes live and
   fails under the mutant by chance reads as a kill; the repeat baseline catches only
   one-way state, not randomness.
7. **Identity re-location with an unchanged site count** (C30 residue). Attack: rewrite the
   symbol body keeping the lexeme count; the ordinal is trusted
   (`differential-fuzz-locate.ts:97`). Harm: the wrong site is mutated silently.
8. **Superseded receipts never prune** (UX F1). Harm: `--verify` exits 1 forever after a
   test edit, so a CI reader learns to ignore it.
9. **`member-chain-scan` `?` defect** (census). Not a kill-proof verdict, but a live
   false negative in `misused_promises` found by the census and still in the tree.

## 6. Re-verify in under ten minutes

```bash
git fetch origin mutation-proof && git checkout origin/mutation-proof && npm install --ignore-scripts
```

```bash
npx vitest run src/harness/kill-proof src/commands/tests-prove-kill.test.ts src/harness/evaluator/post-tool-kill-proof.test.ts src/harness/mutation-kill-evidence-stop-check.test.ts src/harness/adapters/kill-proof-nudge-encoding.test.ts src/harness/mutation/differential-fuzz-locate.test.ts src/harness/jev/stale-handle-live.test.ts --reporter=dot
```

```bash
npm run typecheck && npm run docs:check
```

```bash
npx tsx src/index.ts tests prove-kill --test src/harness/guard-tally.mutation-kill.test.ts --file src/harness/guard-tally.ts --find 'return;' --replace '' --json
```

```bash
npx tsx src/index.ts tests kill-proofs --verify
```

Expected: the regression files report every non-todo case green (todos: round 3 N3,
N11, N13; git N4; stale-handle UNSURE), `docs:check` prints `docs OK`, the explicit
fault above is `killed` with exit 0, and `--verify` lists it `FRESH` or `UNCOMMITTED`.
The e2e nudge test (`npm run build:e2e && npm run test:e2e -- kill-proof-nudge`, then
`npm run build`) adds about one minute.

## Related reports

`kill-proof-review-round2.md`, `kill-proof-review-round3.md`, `kill-proof-git-edge-cases.md`,
`kill-proof-adapter-matrix.md`, `kill-proof-real-kills.md`, `kill-proof-real-kills-2.md`,
`kill-proof-census-harness.md`, `kill-proof-census-lib.md`, `kill-proof-manifest-route.md`,
`kill-proof-ux-walkthrough.md`, `kill-proof-verification-1768aa3c.md`,
`stale-handle-live-precision.md`, `evals/mutation-proof-validation/README.md`, `CLOUD-RUN.md`.
