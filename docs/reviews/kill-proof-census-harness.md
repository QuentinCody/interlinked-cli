# Kill-proof census: `src/harness/` and `src/harness/checks/` pure modules

Run 2026-11-05 in a cloud session (branch `cloud/census-harness`, base `origin/mutation-proof`),
Node v22.23.4, vitest 4.1.11, linux-x64. Every fault is an explicit `--file/--find/--replace`, run
from source: `npx tsx src/index.ts tests prove-kill … --test <companion> --json`. Modules from
`kill-proof-real-kills.md` / `-2.md` (and their batch-1 controls `finding-overflow`,
`compact-trigrams`, `resource-budget`) were skipped.

Selection: 40 distinct modules (23 under `checks/`, 17 elsewhere in `src/harness/`), each ≤ 300 lines,
no `fs`/`child_process`/network import, with a companion `<module>.test.ts` and no existing
`.mutation-kill.test.ts`. One fault per module, authored after a grep of the companion for the
behaviour (a prediction that it escapes), never after running it.

## Census

| | Count |
|---|---|
| survived | **24/40** |
| killed | 16/40 (all wrong predictions: the companion already pins the behaviour) |
| inconclusive | 0 |
| unavailable | 0 |
| strict equivalents among survivors | 0 → survivor rate stays 24/40 (60%) |

Equivalence review (each survivor was checked for an input that separates the two sides):
- Two suspected equivalents were disproved by probe. #12 `esm-cjs`: `JS_TS_EXTS` does contain
  `.mts`, so an `.mts` file without `import`/`export` changes verdict. #19 `eval-usage`:
  `stripCommentsAndStrings` keeps the quote characters (`setInterval("", 5)`), so the timer regex
  is live.
- #34 `fail-before-fix/classify` (`|is not iterable` dropped from `CRASH`) is **equivalent in
  practice, not strictly**. Vitest's first failure line is `TypeError: x is not iterable`, and the
  `^TypeError` alternative already classifies that as a crash. Only a message with no prefix
  separates the two sides. It is counted as a survivor. Excluding it gives 23/39.
- #15 `member-chain-scan` (`!` dropped from `isChainLink`) survives and is not equivalent. While
  analysing it I found the product defect described below.

Companion-scope caveat: #19's companion `eval-usage.test.ts` only pins the module boundary. The
behaviour suites (`agent-safety-js-correctness.test.ts` +
`__tests__/adversarial/eval_usage.adversarial.test.ts`) DO kill the same fault (receipt
`143ab220d3001ecb`, case "P7: fires on `setInterval` with a string argument"). #11 `array-for-each`
is likewise exercised mainly through `agent-safety-async.test.ts`, which was not run. The census
measures companion tests, as specified.

## Per-module table (companion test)

| # | Module | Line | Fault | Verdict | Exit | Killed/cases | Receipt | Wall ms |
|---|---|---|---|---|---|---|---|---|
| 01 | `harness/checks/error-handling-bare-catch.ts` | 28 | drop blank-line branch of comment-only catch | killed | 0 | 1/12 | `211780a56f81ab11` | 11774 |
| 02 | `harness/checks/snapshot-hygiene.ts` | 29 | drop /i flag | killed | 0 | 1/11 | `b55006fcb6dbca16` | 9523 |
| 03 | `harness/checks/test-commented-assertion.ts` | 52 | cap 10 -> 9 | survived | 1 | 0/8 | `cb025d9b46872c63` | 9788 |
| 04 | `harness/checks/archive-extract.ts` | 54 | drop .cjs from JS exts | survived | 1 | 0/7 | `4d174d661ca2de25` | 15540 |
| 05 | `harness/checks/github-actions.ts` | 54 | drop same-line dedupe | survived | 1 | 0/11 | `ccead2743d2589e6` | 16965 |
| 06 | `harness/checks/markdown.ts` | 27 | drop ~~~ fence | survived | 1 | 0/9 | `7d1f8fada6bb733c` | 13424 |
| 07 | `harness/checks/test-hygiene-masking-ast.ts` | 23 | regex literals not masked | killed | 0 | 2/6 | `9962261447f95ac7` | 13490 |
| 08 | `harness/checks/index-as-key.ts` | 12 | drop k from direct key | killed | 0 | 1/37 | `4964bb88530e2cee` | 9618 |
| 09 | `harness/checks/swift-concurrency.ts` | 36 | whitespace tolerance dropped | killed | 0 | 1/20 | `6a0259d2ae221b65` | 10059 |
| 10 | `harness/checks/env-access-scope.ts` | 26 | drop environment module name | survived | 1 | 0/10 | `8912019bc997025f` | 9671 |
| 11 | `harness/checks/array-for-each.ts` | 42 | satisfies not unwrapped | survived | 1 | 0/6 | `960dacab5e9fb337` | 10061 |
| 12 | `harness/checks/esm-cjs.ts` | 42 | drop .mts | survived | 1 | 0/11 | `d483c69fb3a708f7` | 9270 |
| 13 | `harness/checks/taste-arg-scan.ts` | 19 | [ not counted as opener | survived | 1 | 0/10 | `0ccab3741085c91d` | 9421 |
| 14 | `harness/checks/crypto-scan-exemptions.ts` | 54 | drop .jsx | survived | 1 | 0/7 | `2528dfefe50dde56` | 9328 |
| 15 | `harness/checks/member-chain-scan.ts` | 19 | ! not a chain link | survived | 1 | 0/6 | `65c5253e6e6b306a` | 9231 |
| 16 | `harness/checks/nan-comparison-scan.ts` | 23 | Number . NaN spacing | survived | 1 | 0/15 | `1476b2d416cac3ed` | 9303 |
| 17 | `harness/checks/anonymous-registration.ts` | 73 | window off-by-one | survived | 1 | 0/11 | `6abe60e73ad9a696` | 9307 |
| 18 | `harness/checks/payload-casing.ts` | 27 | drop input var | killed | 0 | 1/8 | `9898fb1576e92e04` | 8881 |
| 19 | `harness/checks/eval-usage.ts` | 83 | drop setInterval | survived | 1 | 0/2 | `c93ae1b0229ac9d8` | 10560 |
| 20 | `harness/checks/rust-test-determinism.ts` | 41 | attr window 4 -> 2 | survived | 1 | 0/32 | `8ae46e2bdacbdb9f` | 8797 |
| 21 | `harness/checks/sequential-awaits.ts` | 11 | drop var | killed | 0 | 1/27 | `f084d40f1877fdc9` | 9512 |
| 22 | `harness/checks/control-bytes.ts` | 135 | page-break exemption dropped | survived | 1 | 0/13 | `1e1d65a66dfe0121` | 9318 |
| 23 | `harness/checks/html-duplicate-id.ts` | 71 | stray </template> clamps dropped | survived | 1 | 0/38 | `daa391ef208eb22b` | 9289 |
| 24 | `harness/evaluator/keyword-quick-reject.ts` | 34 | path segments not tokenized | killed | 0 | 3/16 | `358fc6c7fc6de68c` | 9021 |
| 25 | `harness/mutation/instability.ts` | 47 | release boundary | killed | 0 | 1/9 | `66e111a61239ecc6` | 9007 |
| 26 | `harness/evaluator/network-hosts.ts` | 23 | 172.31 boundary | killed | 0 | 1/40 | `a8a0eca3f4236fd5` | 8996 |
| 27 | `harness/package-version-range.ts` | 74 | <= treated as floor | killed | 0 | 1/11 | `e13e68255e0bcddd` | 9221 |
| 28 | `harness/debt-evasion.ts` | 30 | drop perl -e | killed | 0 | 1/15 | `fc4a5a30007ad292` | 19019 |
| 29 | `harness/redos-validation.ts` | 68 | one-way prefix overlap | killed | 0 | 2/19 | `0ad246a18cf70047` | 9588 |
| 30 | `harness/recurrence-signature.ts` | 32 | cap boundary | survived | 1 | 0/9 | `1c9e16e925fc0abb` | 9909 |
| 31 | `harness/check-evidence/clauses.ts` | 30 | and not tidied | survived | 1 | 0/6 | `d8b32d3a5c696503` | 9220 |
| 32 | `harness/evaluator/coverage-scope.ts` | 27 | order-dependent scope id | killed | 0 | 1/5 | `fc509bcfb86ed5f7` | 8759 |
| 33 | `harness/coverage-pairing.ts` | 37 | __tests__ dir not folded | killed | 0 | 1/11 | `219d7c7b33fa81df` | 9140 |
| 34 | `harness/fail-before-fix/classify.ts` | 20 | is-not-iterable not a crash | survived | 1 | 0/13 | `c2ced01a92d26021` | 9182 |
| 35 | `harness/evaluator/rule-matching-guards.ts` | 38 | forbids_after without session | survived | 1 | 0/11 | `094ca6d076ecab7c` | 9075 |
| 36 | `harness/check-engine/output-parsers-biome.ts` | 33 | syntax not error | survived | 1 | 0/7 | `2e2fdeba030107f5` | 8980 |
| 37 | `harness/library-footguns/redis.ts` | 24 | drop PXAT | survived | 1 | 0/4 | `0a836a21d7fd427c` | 9661 |
| 38 | `harness/spec/count-census-scope.ts` | 13 | proximity off-by-one | survived | 1 | 0/8 | `1baa8f9857ffb558` | 9941 |
| 39 | `harness/trajectory/session-rework.ts` | 79 | floor boundary | survived | 1 | 0/7 | `1dc05b3f3a083498` | 9479 |
| 40 | `harness/replay/scorers/action-match.ts` | 23 | arrays not canonicalized | killed | 0 | 1/7 | `6af653681c88b785` | 8756 |

## The 10 new mutation-kill files (most consequential survivors)

Chosen for consequence: a security or correctness detector that stops firing (#4, #11, #12, #19, #23),
a fail-open/false block (#35 a `forbids_after` guard rule that fires with no session, #36 a biome
`syntax` header downgraded from error to warning), or a boundary that silently shifts (#17, #38, #39).
Every case is preceded by `// test-contract:`. All 18 cases pass on unmutated code
(`npx vitest run <10 files>`: `Test Files 10 passed (10)`, `Tests 18 passed (18)`), and `npm run typecheck` exits 0.

| Fault | New test file | Verdict | Exit | Killed cases | Receipt | Baseline ms | Mutant ms | Wall ms |
|---|---|---|---|---|---|---|---|---|
| 04 | `harness/checks/archive-extract.mutation-kill.test.ts` | killed | 0 | 2/2: "checkArchiveExtractTraversal — CommonJS sources fires on an unguarded tar.x in a .cjs file"; "checkArchiveExtractTraversal — CommonJS sources fires on extractAllTo in a .cjs file" | `30b3f315c98ebcd1` | 2000 | 1008 | 20635 |
| 11 | `harness/checks/array-for-each.mutation-kill.test.ts` | killed | 0 | 2/2: "arrayForEachOffsets — satisfies wrappers finds forEach on a const array declared with satisfies"; "arrayForEachOffsets — satisfies wrappers finds forEach on an inline satisfies receiver" | `093b1c2dc6a2364a` | 1515 | 959 | 20127 |
| 12 | `harness/checks/esm-cjs.mutation-kill.test.ts` | killed | 0 | 1/2: "detectCjsInEsm — .mts is ESM by extension flags require() in an .mts file that has no import or export" | `794d164b9f68db74` | 1148 | 887 | 9879 |
| 17 | `harness/checks/anonymous-registration.mutation-kill.test.ts` | killed | 0 | 1/2: "checkAnonymousRegistration — entry window boundary fires when the anonymous impl sits exactly 12 lines below the id" | `24a8ba9b18e7a964` | 873 | 979 | 9591 |
| 19 | `harness/checks/eval-usage.mutation-kill.test.ts` | killed | 0 | 2/2: "checkEvalUsage — string-evaluating timers reports setInterval called with a string body"; "checkEvalUsage — string-evaluating timers reports both setTimeout and setInterval string bodies in one file" | `7df7dd7ad99d0be3` | 1076 | 1234 | 10621 |
| 23 | `harness/checks/html-duplicate-id.mutation-kill.test.ts` | killed | 0 | 2/2: "checkHtmlDuplicateId — stray closing template still reports a duplicate id after a stray </template>"; "checkHtmlDuplicateId — stray closing template excludes a later real template's contents but keeps the body after it" | `fc1937da2bcd19fd` | 763 | 736 | 8844 |
| 35 | `harness/evaluator/rule-matching-guards.mutation-kill.test.ts` | killed | 0 | 1/2: "passesTemporalGating — no session keeps a forbids_after rule dormant when there is no session" | `82bbd63d9901f470` | 732 | 744 | 9293 |
| 36 | `harness/check-engine/output-parsers-biome.mutation-kill.test.ts` | killed | 0 | 1/1: "parseBiomeOutput — syntax diagnostics reports a syntax header as an error that says the file does not parse" | `3128c432007dd2c3` | 822 | 718 | 9117 |
| 38 | `harness/spec/count-census-scope.mutation-kill.test.ts` | killed | 0 | 1/2: "count claim scope — link proximity boundary compares a claim with a registry linked exactly three lines below" | `6b0465d5f15aea60` | 1140 | 988 | 10293 |
| 39 | `harness/trajectory/session-rework.mutation-kill.test.ts` | killed | 0 | 1/1: "formatSessionReworkNudge — ratio floor boundary nudges at exactly the rework floor" | `dcc863a99a864b81` | 807 | 733 | 9150 |

10/10 killed. Where a second case does not kill the fault (#12, #17, #35, #38), it pins the other
side of the same boundary on purpose and is reported per case as `survived`.

## Timing (50 proofs: 40 census + 10 new-test)

End-to-end wall time per `prove-kill` invocation: **min 8756 ms, median 9450 ms, max 20635 ms**,
total 526.6 s. Inside vitest, each run takes 0.7–2.0 s (`baseline`/`underMutant` above). Outliers: K04/K11 (~20 s) ran while `npm run typecheck` ran in parallel. #4–#7 (13–17 s) and #28 (19 s) have no identified cause.

## Product defect found

`src/harness/checks/member-chain-scan.ts:19` (`isChainLink` accepts a bare `?`; same at `:65`)
lets `memberChainStart` walk back across a ternary `?`. For `x = c ? a.b : 0` the chain start is `c`.
`agent-safety-async.ts:53 isAwaitedForEachReceiver` then sees `await ` before `c` and suppresses
`misused_promises`. Probe: `const r = ready ? items.forEach(async (x) => { await save(x); }) : null;`
is reported (1 finding), but the same line with `await ready ? …` yields `[]`. That is a false
negative: the `await` applies to `ready`, not to the forEach. A prefix `!` is absorbed the same way
(`!a.b` starts at `!`). Not fixed here (out of scope).

## Three worst gaps

1. `html-duplicate-id`: a single stray `</template>` drives the template depth negative under the mutant and silences the detector for the rest of the body, and no companion case contains an unmatched close tag.
2. `rule-matching-guards`: nothing pins that a `forbids_after` guard rule stays dormant without a session, so the mutant turns a dormant rule into a live block on every session-less evaluation.
3. `output-parsers-biome`: only `parse` headers are pinned as errors, so a `syntax` header can silently degrade to a warning — the exact fail-open the module's own header comment says was found once already.
