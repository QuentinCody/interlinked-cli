# Kill-proof dogfood: the feature judged by its own proof

Run 2026-11-05 in a cloud session (branch `cloud/dogfood-kill-proof`, base
`origin/mutation-proof` at `681e705`), Node v22.23.4, vitest 4.1.11, linux-x64, 4 cores.
Every fault is an explicit `--file/--find/--replace` run from source:

```bash
npx tsx src/index.ts tests prove-kill --file <module> --find '<text>' --replace '<text>' --test <file>… --json
```

The target is the kill-proof feature itself: `src/harness/kill-proof/{run,receipt,resolve}.ts`,
`src/commands/tests-prove-kill.ts`, `src/harness/evaluator/post-tool-kill-proof.ts`,
`src/harness/mutation-kill-evidence-stop-check.ts`, `src/harness/fail-before-fix/{classify,snapshot}.ts`.
Sixty engine-shaped faults (flipped comparison, off-by-one, dropped guard, negated condition,
wrong default/constant, swapped return, verdict-string change, regex boundary change, dropped
binding) were authored blind to the companion tests, then proven in three stages:

1. **Unit stage** — the module's own unit test file(s) (`kill-proof.test.ts` for the engine,
   `tests-prove-kill.test.ts`, `post-tool-kill-proof.test.ts`, the Stop check's unit test plus
   its existing `mutation-kill-w27` file, `classify.test.ts`, `snapshot.test.ts`).
2. **Full-set stage** — every fault the unit stage did not kill, re-proven against the whole
   companion set: the unit file plus `kill-proof.story.test.ts` and
   `review-regressions-{git,round2,round3}.test.ts` (and the adapter encoding test for the
   nudge). These spawn the CLI and nested proofs, so one proof costs 6–9 minutes here.
3. **New-test stage** — every stage-1 non-kill re-proven against a new
   `<module>.mutation-kill.test.ts` written for it (each case under a `// test-contract:` line).

A fault counts as killed by the companion suite when EITHER of the first two stages killed it.

## The 60 faults

Columns: verdict (exit code, receipt id, wall time of the whole `prove-kill` invocation).

| # | Module:line | Kind | Fault (find → replace) | Unit verdict | Full-set verdict | New-test verdict | Final |
|---|---|---|---|---|---|---|---|
| R01 | `kill-proof/run.ts:94` | negated condition | `row.thrownInTest !== true);` → `row.thrownInTest === true);` | killed (0, `4fbf802c64b09633`, 17.2s) | — | — | killed (companion) |
| R02 | `kill-proof/run.ts:88` | regex boundary | `/^(?:Error: )?Snapshot .*mismatched/` → `/Snapshot .*mismatched/` | survived (1, `cbd538b1dae9d0a2`, 16.1s) | survived (1, `8bcb51b2fdaaa71b`, 506.8s) | killed (0, `bf2e025cfe2fffb8`, 20.0s) | killed (new test) |
| R03 | `kill-proof/run.ts:159` | off-by-one | `if (killed.length) return { verdict: "killed"` → `if (killed.length > 1) return { verdict…` | killed (0, `c091ec5a16be3c6c`, 23.4s) | — | — | killed (companion) |
| R04 | `kill-proof/run.ts:160` | negated condition | `if (inconclusive.length) return { verdict: "inconclusive"` → `if (!inconclusive.length) return { verd…` | killed (0, `244f954e7f9b1790`, 23.9s) | — | — | killed (companion) |
| R05 | `kill-proof/run.ts:151` | flipped comparison | `if (result?.status === "passed") return { test, verdict: "s…` → `if (result?.status !== "failed") return…` | survived (1, `5a3e0db63433efd1`, 16.5s) | killed (0, `9612ea2fadcf72e9`, 525.5s) | killed (0, `d260d37632761d9f`, 37.6s) | killed (full set) |
| R06 | `kill-proof/run.ts:149` | verdict literal change | `if (runnerFailure !== undefined) return { test, verdict: "i…` → `if (runnerFailure !== undefined) return…` | killed (0, `bdda973334308f5a`, 18.4s) | — | — | killed (companion) |
| R07 | `kill-proof/run.ts:289` | dropped guard | `if (again.error === undefined && !again.timedOut && repeat?…` → `if (again.error === undefined && !again…` | killed (0, `e159b49341443e5e`, 17.1s) | — | — | killed (companion) |
| R08 | `kill-proof/run.ts:298` | negated condition | `if (canary.error === undefined && !canary.timedOut && still…` → `if (canary.error === undefined && !cana…` | killed (0, `4464bb404dbce0d1`, 16.8s) | — | — | killed (companion) |
| R09 | `kill-proof/run.ts:112` | dropped guard | `if ((kind === ts.ScriptKind.JS \|\| kind === ts.ScriptKind.…` → `if (kind === ts.ScriptKind.TS && contai…` | survived (1, `27e4e649352bd145`, 14.9s) | killed (0, `3129d3811f37171f`, 557.6s) | killed (0, `c41c61a182b4a41a`, 37.5s) | killed (full set) |
| R10 | `kill-proof/run.ts:106` | wrong constant | `d.category === ts.DiagnosticCategory.Error` → `d.category === ts.DiagnosticCategory.Wa…` | killed (0, `9f00c7312b013957`, 16.2s) | — | — | killed (companion) |
| R11 | `kill-proof/run.ts:223` | dropped guard | `return inCopy !== null && !existsSync(join(copyDir, inCopy)…` → `return inCopy !== null && !existsSync(j…` | survived (1, `f5770a9bf036215a`, 15.0s) | survived (1, `7b1ea49dbadd1be7`, 540.9s) | killed (0, `bb0a5d194f782e3e`, 23.9s) | killed (new test) |
| R12 | `kill-proof/run.ts:131` | dropped guard | `if (run.error !== undefined \|\| run.timedOut) {` → `if (run.error !== undefined) {` | survived (1, `d44cd3b72bd04194`, 15.3s) | survived (1, `2fbede4febfee697`, 483.5s) | killed (0, `2124b19d3501321f`, 16.2s) | killed (new test) |
| R13 | `kill-proof/run.ts:203` | dropped guard | `→if (isTestPath(mutant.file)) return `${mutant.file} is a t…` → `` | survived (1, `c495340263173b91`, 15.6s) | survived (1, `523d1f435721b020`, 484.2s) | killed (0, `d9c0f518855eb4d3`, 22.8s) | killed (new test) |
| C01 | `kill-proof/receipt.ts:127` | dropped binding | `parts.mutant.originalLexeme, parts.mutant.replacement, part…` → `parts.mutant.originalLexeme, parts.muta…` | survived (1, `204d2d8ea3a5875d`, 15.6s) | survived (1, `31b870c7f9bff0ff`, 382.7s) | killed (0, `59ae41c650022658`, 18.5s) | killed (new test) |
| C02 | `kill-proof/receipt.ts:143` | dropped binding | `const { digest: _digest, ...rest } = receipt;` → `const { digest: _digest, verdict: _verd…` | survived (1, `55898c6cf8c5f3e7`, 17.2s) | survived (1, `73955df3fad2fdd4`, 382.2s) | killed (0, `b0c298652d4c48d4`, 17.5s) | killed (new test) |
| C03 | `kill-proof/receipt.ts:137` | dropped sort | `Object.keys(value).sort().map(` → `Object.keys(value).map(` | survived (1, `ed35a9851468f943`, 17.4s) | survived (1, `0b94efb0f0e511e6`, 396.7s) | killed (0, `26d4d5dc830b64ba`, 17.5s) | killed (new test) |
| C04 | `kill-proof/receipt.ts:328` | one-directional check | `if ((receipt.verdict === "killed") !== killed.length > 0) r…` → `if (receipt.verdict === "killed" && kil…` | survived (1, `74e22571aefecf4e`, 17.3s) | survived (1, `7f4e83f192e24056`, 395.3s) | killed (0, `a9f03e7306291e5b`, 16.4s) | killed (new test) |
| C05 | `kill-proof/receipt.ts:378` | boundary dropped | `return name === title \|\| name.endsWith(` ${title}`) \|\| …` → `return name === title \|\| name.endsWit…` | survived (1, `85ae065389c7e4f0`, 15.8s) | survived (1, `5a25cd97822d0b3c`, 401.9s) | killed (0, `7a8a3bcb2b50a172`, 16.8s) | killed (new test) |
| C06 | `kill-proof/receipt.ts:392` | dropped guard | `if (receipt.verdict !== "killed" \|\| !receipt.killedTests.…` → `if (receipt.verdict !== "killed") reaso…` | survived (1, `c986b73c8388f8fd`, 16.5s) | survived (1, `7cbd419c2f435e9c`, 401.8s) | killed (0, `56a8b6f44f40747a`, 15.6s) | killed (new test) |
| C07 | `kill-proof/receipt.ts:397` | off-by-one | `if (requireCases !== undefined && requireCases.length > 0) {` → `if (requireCases !== undefined && requi…` | killed (0, `35b9b97c286d4114`, 18.1s) | — | — | killed (companion) |
| C08 | `kill-proof/receipt.ts:307` | dropped check | `return [...hashMismatches(root, [row.source], "source"), ..…` → `return [...hashMismatches(root, [row.so…` | killed (0, `6f1fcf527aad60d0`, 17.5s) | — | — | killed (companion) |
| C09 | `kill-proof/receipt.ts:362` | string literal | `"--untracked-files=all"` → `"--untracked-files=no"` | survived (1, `8d797a775e49c7cf`, 16.0s) | killed (0, `1bb84f7cbd82fcd9`, 484.3s) | killed (0, `dedf00b061c70da0`, 17.4s) | killed (full set) |
| C10 | `kill-proof/receipt.ts:317` | dropped check | `if ((env.config?.sha256 ?? null) !== (recorded.config?.sha2…` → `` | survived (1, `c60776a9db4de79f`, 16.6s) | survived (1, `20c46937f19da6ba`, 387.0s) | killed (0, `91225b4bd3806cc4`, 15.5s) | killed (new test) |
| C11 | `kill-proof/receipt.ts:67` | regex alternative dropped | `(?:--config\|-c)(?:=\|\s+)` → `(?:--config)(?:=\|\s+)` | survived (1, `c77bf5d65a1565af`, 15.6s) | survived (1, `3b45749afe703a49`, 383.4s) | killed (0, `417214bc829c1df1`, 15.8s) | killed (new test) |
| C12 | `kill-proof/receipt.ts:86` | regex alternative dropped | `/\b(?:setupFiles\|globalSetup)\s*:` → `/\b(?:setupFiles)\s*:` | survived (1, `70d1a3b05860c427`, 15.7s) | survived (1, `5f65f231acdf08b5`, 393.4s) | killed (0, `b8115c0b90b68dce`, 17.4s) | killed (new test) |
| V01 | `kill-proof/resolve.ts:43` | off-by-one | `return content.slice(start, end === -1 ? content.length : e…` → `return content.slice(start, end === -1 …` | killed (0, `290d598f41838cca`, 17.0s) | — | — | killed (companion) |
| V02 | `kill-proof/resolve.ts:47` | wrong default | `let line = 1;` → `let line = 0;` | killed (0, `b39e046f852d1ecb`, 16.3s) | — | — | killed (companion) |
| V03 | `kill-proof/resolve.ts:112` | dropped guard | `if (occurrences !== 1) return` → `if (occurrences === 0) return` | killed (0, `0b3ec2613da676e7`, 14.6s) | — | — | killed (companion) |
| V04 | `kill-proof/resolve.ts:108` | dropped guard | `if (spec.find === spec.replace) return` → `if (spec.find !== spec.find) return` | survived (1, `87a0bbdc94b5f2e3`, 14.8s) | survived (1, `226faf140559545f`, 408.4s) | killed (0, `dcfa190b3f85021e`, 14.2s) | killed (new test) |
| V05 | `kill-proof/resolve.ts:30` | dropped guard | `if (file !== undefined && path !== file) continue;` → `if (path !== file) continue;` | survived (1, `a6d54c319f9214fa`, 15.2s) | survived (1, `5d1bde4a5f083552`, 408.4s) | killed (0, `53929dc49241f95a`, 15.0s) | killed (new test) |
| V06 | `kill-proof/resolve.ts:131` | negated condition | `if (mutant.source === "explicit") {` → `if (mutant.source !== "explicit") {` | killed (0, `80c7405d4142255c`, 17.6s) | — | — | killed (companion) |
| L01 | `commands/tests-prove-kill.ts:44` | swapped return | `return result.verdict === "not-passing-now" ? PROVE_KILL_EX…` → `return result.verdict === "not-passing-…` | killed (0, `ed5185a17bea133b`, 13.0s) | — | — | killed (companion) |
| L02 | `commands/tests-prove-kill.ts:29` | wrong constant | `export const PROVE_KILL_EXIT = { proven: 0, failed: 1, unde…` → `export const PROVE_KILL_EXIT = { proven…` | killed (0, `e417e76834e5a467`, 13.4s) | — | — | killed (companion) |
| L03 | `commands/tests-prove-kill.ts:35` | regex boundary | `if (!/^[0-9a-f]{16}$/.test(options.mutant))` → `if (!/^[0-9a-f]{16}/.test(options.mutan…` | survived (1, `ba0a8b60ad868e96`, 12.1s) | survived (1, `6bfb4167a9eb5f9b`, 461.7s) | killed (0, `7397bb74d29a718b`, 15.6s) | killed (new test) |
| L04 | `commands/tests-prove-kill.ts:142` | dropped guard | `(row.freshness === "stale" \|\| row.freshness === "unreadab…` → `(row.freshness === "stale")) ? 1 : 0;` | survived (1, `de68a7f0a63f0515`, 12.2s) | survived (1, `82ccccd1f408378c`, 451.6s) | killed (0, `b00f858a054f02b0`, 16.3s) | killed (new test) |
| L05 | `commands/tests-prove-kill.ts:116` | string literal (freshness) | `if (!freshness.fresh) return { ...base, freshness: "stale",…` → `if (!freshness.fresh) return { ...base,…` | survived (1, `f2977de1a9ac90d9`, 12.1s) | killed (0, `8793afadaf6713cf`, 456.2s) | killed (0, `8e9cb95c8fe3d33c`, 16.6s) | killed (full set) |
| L06 | `commands/tests-prove-kill.ts:119` | dropped branch | `return uncommitted.length ? { ...base, freshness: "uncommit…` → `return uncommitted.length < 0 ? { ...ba…` | survived (1, `599713df2a8c4b1c`, 13.4s) | killed (0, `dece50ca534ca3f6`, 452.7s) | killed (0, `2aad32737778d9ea`, 17.4s) | killed (full set) |
| L07 | `commands/tests-prove-kill.ts:128` | off-by-one | `const partial = row.tests.length > 1 && row.killedTests.len…` → `const partial = row.tests.length > 0 &&…` | survived (1, `2b7766045d2f6ca6`, 12.8s) | survived (1, `3a387969577a3f9e`, 442.5s) | killed (0, `f768d6f28d5a3b0f`, 16.7s) | killed (new test) |
| L08 | `commands/tests-prove-kill.ts:87` | off-by-one | `if (!Number.isFinite(budgetMs) \|\| budgetMs <= 0) {` → `if (!Number.isFinite(budgetMs) \|\| bud…` | survived (1, `63a1f81c02fa193c`, 12.9s) | survived (1, `76f677ca5511e2ed`, 448.1s) | killed (0, `0d7cd84410f11d27`, 16.5s) | killed (new test) |
| N01 | `evaluator/post-tool-kill-proof.ts:61` | some→every | `if (results.some(result => result.certified)) return null;` → `if (results.every(result => result.cert…` | killed (0, `a354ed50a3d297cf`, 23.0s) | — | — | killed (companion) |
| N02 | `evaluator/post-tool-kill-proof.ts:63` | dropped guard | `result.uncovered !== undefined && result.reasons.length ===…` → `result.uncovered !== undefined);` | survived (1, `6cb71d47645661d8`, 19.1s) | survived (1, `72ed3d8784941936`, 207.1s) | killed (0, `16408bb9ff44e7e2`, 23.8s) | killed (new test) |
| N03 | `evaluator/post-tool-kill-proof.ts:69` | dropped guard | `result.receipt?.verdict === "killed" && result.receipt.kill…` → `result.receipt?.verdict === "killed");` | survived (1, `c6426b13f829df2b`, 18.3s) | survived (1, `817c4197e4fb6b52`, 206.4s) | killed (0, `403002cc1a315915`, 23.5s) | killed (new test) |
| N04 | `evaluator/post-tool-kill-proof.ts:59` | dropped filter | `.receipts.filter(row => row.tests.some(test => test.path ==…` → `.receipts.filter(() => true);` | killed (0, `30aa21d08ef7f6ca`, 21.2s) | — | — | killed (companion) |
| N05 | `evaluator/post-tool-kill-proof.ts:58` | wrong default | `const newCases = input.newCases ?? newCasesSinceHead(input.…` → `const newCases = input.newCases ?? [];` | survived (1, `cc871cdddca89a27`, 17.3s) | killed (0, `933d6e1bd1f9ecff`, 292.7s) | killed (0, `44e6e287ace7bdec`, 27.3s) | killed (full set) |
| S01 | `mutation-kill-evidence-stop-check.ts:219` | negated condition | `return [...new Set(caseTitles(current).filter(title => !bef…` → `return [...new Set(caseTitles(current).…` | survived (1, `399c01563132fb9b`, 21.3s) | killed (0, `459ba979f5fdc7c3`, 81.6s) | killed (0, `a6609797c04b4633`, 26.7s) | killed (full set) |
| S02 | `mutation-kill-evidence-stop-check.ts:206` | regex alternative dropped | `/\b(?:it\|test)(?:\.(?:only\|skip\|todo\|concurrent\|each))*` → `/\b(?:it)(?:\.(?:only\|skip\|todo\|conc…` | survived (1, `c7273ffb40d86b36`, 21.6s) | survived (1, `eef4b61a280787fc`, 62.2s) | killed (0, `461b4b1e5787b985`, 25.6s) | killed (new test) |
| S03 | `mutation-kill-evidence-stop-check.ts:334` | ||→&& | `const newTitles = titleGrowth > 0 \|\| openerGrowth > 0 ? n…` → `const newTitles = titleGrowth > 0 && op…` | survived (1, `6a2bc030416b2481`, 22.0s) | survived (1, `7a1cc71568650937`, 59.8s) | killed (0, `69deb2f21fb8446c`, 25.9s) | killed (new test) |
| S04 | `mutation-kill-evidence-stop-check.ts:347` | dropped argument | `ctx.freshKillProofs(ctx.cwd, relPath, newTitles) === 0;` → `ctx.freshKillProofs(ctx.cwd, relPath, […` | survived (1, `3ebe767e5a42af3b`, 21.8s) | killed (0, `d2bc9282cf987feb`, 81.0s) | killed (0, `c364a0e9489ad135`, 26.2s) | killed (full set) |
| S05 | `mutation-kill-evidence-stop-check.ts:343` | flipped comparison | `: measurementMs === null \|\| measurementMs < writeMs;` → `: measurementMs === null \|\| measureme…` | killed (0, `cd1c202f849b3f2e`, 29.0s) | — | — | killed (companion) |
| F01 | `fail-before-fix/classify.ts:33` | dropped guard | `return kind === "assertion" \|\| (kind === "other" && outco…` → `return kind === "assertion" \|\| kind =…` | killed (0, `b1d9fd84d6d0168d`, 12.7s) | — | — | killed (companion) |
| F02 | `fail-before-fix/classify.ts:24` | startsWith→includes | `if (message.startsWith("AssertionError")) return "assertion…` → `if (message.includes("AssertionError"))…` | survived (1, `3222c5873bd2ca59`, 10.4s) | survived (1, `70e9b2fc85f9d187`, 246.7s) | killed (0, `c78cb48b01ce4539`, 13.9s) | killed (new test) |
| F03 | `fail-before-fix/classify.ts:20` | regex alternative dropped | `\|Cannot find module\|is not iterable/;` → `\|Cannot find module/;` | survived (1, `9e461003b419497d`, 11.0s) | survived (1, `1f9789fb2811c8ac`, 257.2s) | killed (0, `0c3056bff51ec5c2`, 13.4s) | killed (new test) |
| F04 | `fail-before-fix/classify.ts:48` | find→findLast | `const line = message.split("\n").find(row => /^\s*at /.test…` → `const line = message.split("\n").findLa…` | killed (0, `27c67d99317819fc`, 11.2s) | — | — | killed (companion) |
| F05 | `fail-before-fix/classify.ts:52` | boundary dropped | `return path === absolute \|\| path.endsWith(`/${file}`);` → `return path === absolute \|\| path.ends…` | survived (1, `e862778982594105`, 12.0s) | survived (1, `2e5dcb92b0392031`, 255.1s) | killed (0, `0f083b4d97edc58b`, 13.3s) | killed (new test) |
| F06 | `fail-before-fix/classify.ts:64` | dropped trim | `if (first) row.message = (first.trim().split("\n")[0] ?? ""…` → `if (first) row.message = (first.split("…` | survived (1, `55bc4d53c62764d2`, 12.1s) | survived (1, `3dddcdb2282182b8`, 250.9s) | killed (0, `f4cb555af3f8b68c`, 14.3s) | killed (new test) |
| F07 | `fail-before-fix/snapshot.ts:34` | dropped guard | `if (isLink(current)) throw new Error(`comparison write woul…` → `` | killed (0, `86d4e617f1805740`, 12.5s) | — | — | killed (companion) |
| F08 | `fail-before-fix/snapshot.ts:45` | swapped return | `if (real !== rootReal && !real.startsWith(rootReal + sep)) …` → `return raw;` | survived (1, `d8eabdf1ef643a1f`, 12.1s) | survived (1, `92b0a15c08312a3a`, 438.4s) | killed (0, `e12a1ae81d89bd35`, 13.1s) | killed (new test) |
| F09 | `fail-before-fix/snapshot.ts:51` | dropped guard | `if (!link && !existsSync(source)) return;` → `if (!existsSync(source)) return;` | survived (1, `b10b086f5f7a626a`, 12.6s) | survived (1, `d22135763b052510`, 432.5s) | killed (0, `219dc39852348a00`, 13.6s) | killed (new test) |
| F10 | `fail-before-fix/snapshot.ts:18` | flag dropped | `"ls-files", "-z", "-co", "--exclude-standard"` → `"ls-files", "-z", "-c", "--exclude-stan…` | killed (0, `9e2baf47267a53ef`, 13.0s) | — | — | killed (companion) |
| F11 | `fail-before-fix/snapshot.ts:62` | dropped continue | `if (content === null) { rmSync(target, { force: true }); co…` → `if (content === null) { rmSync(target, …` | inconclusive (2, `c615dd75ab2c38b0`, 7.9s) | inconclusive (2, `64d9019c4b8567d9`, 279.0s) | killed (0, `4528de9759b34e49`, 15.3s) | killed (new test) |

## Census

| Stage | Killed | Survived | Inconclusive | Unavailable |
|---|---|---|---|---|
| Unit files only (60 faults) | 22 | 37 | 1 (F11) | 0 |
| Full companion set (the 38 non-kills) | 8 (R05, R09, C09, L05, L06, N05, S01, S04) | 29 | 1 (F11) | 0 |
| **Companion suite, combined** | **30 / 60** | **29 / 60** | **1 / 60** | 0 |
| New mutation-kill tests (the 38 stage-1 non-kills) | 38 / 38 | 0 | 0 | 0 |
| **Final (companion + new)** | **60 / 60** | 0 | 0 | 0 |

**Survived the whole existing suite: 29/60. Equivalents excluded: 0.** The inconclusive F11 is
the product crash the rule describes (a dropped `continue` makes `writeFileSync(target, null)`
throw a `TypeError` from product code: the companion test noticed, but no assertion fired).

Equivalent mutants were screened out before authoring, not after: `uncommittedPaths`
`slice(3)`→`slice(2)` (the `.trim()` erases it), `mutantParses` `return null`→`return { ok: true }`
(both run the mutant), `copyWriteTarget` `includes("..")`→`startsWith("..")` (`resolve` normalizes
first), `verifyKillProof`'s relocate branches (reachable only when every hash already matches,
so the mutant cannot have moved). None of the 60 is equivalent: every one changed an observable
that a test in this change asserts.

What the full set added over the unit files, and what it could not see:
- The story test kills R05 (a skipped case read as survived: its N5 fault throws at module
  load), C09 and L05/L06 (`--verify` FRESH / STALE / UNCOMMITTED through the real CLI).
- Round 3 kills R09 (JSX in a `.js` file) and N05 (the nudge's HEAD-based new-case rule);
  rounds 2 and 3 kill S01 and S04 through the Stop detector's new-case rule.
- F08 (links copied raw, pointing at the live tree) survives the git edge-case tests
  `N1`/`N2` because those assert "not SURVIVED": under the fault the nested proof's canary
  still turns the live-file load into `unavailable`, so the assertion holds. The canary masks
  the link bug one level up; only a snapshot-level assertion on the copied link observes it.
- 22 faults survived every file: the id binding (C01), the digest's coverage and canonical
  order (C02, C03), one-directional verdict/case agreement (C04), the describe-boundary rule
  (C05), per-file certification (C06), the config water-line (C10), `-c` and `globalSetup`
  (C11, C12), the identical-fault and bare-manifest-id refusals (V04, V05), the id shape and
  `--run-timeout` floor (L03, L08), the unreadable-receipt exit (L04), the killed-through line
  (L07), the nudge's stale-vs-uncovered and killed-elsewhere messages (N02, N03), the `test(`
  opener and the wrapped-title path (S02, S03), the anchored failure grammar (F02, F03, F05,
  F06), dangling links (F09) and the crash in F11.

## Kills by the new tests

One receipt per fault, all `killed`, exit 0. Durations are `baseline.durationMs` /
`underMutant.durationMs` (the two vitest runs inside the proof). The receipts live under
`.interlinked/test-runs/kill-proofs/` (gitignored). `tests kill-proofs --verify` at the end of
the run: 140 receipts, exit 0; all 38 receipts in this table `killed` and `FRESH`; the only
STALE rows are the three superseded snapshot receipts written before the F09 fix
(`0b43d6e8639fe9b6`, `eb884c58daccce84`, `727e6a3de3310f54`), replaced by the ones listed here.

| # | New test file | Killed case(s) | Receipt | Baseline / mutant ms |
|---|---|---|---|---|
| R02 | `harness/kill-proof/run.mutation-kill.test.ts` | "killedByOwnCheck — boundary of the snapshot-mismatch rule a TypeError that mentions a snapshot mismatch mid-m…" | `bf2e025cfe2fffb8` | 2161 / 2402 |
| R05 | `harness/kill-proof/run.mutation-kill.test.ts` | "judgeCases — a case without a pass or a kill under the mutant a case reported skipped under the mutant is inc…"; "judgeCases — a case without a pass or a kill under the mutant a case absent from the mutant run is inconclusi…" | `d260d37632761d9f` | 3055 / 3828 |
| R09 | `harness/kill-proof/run.mutation-kill.test.ts` | "mutantParses — JSX in a non-JSX dialect refuses JSX written into a .js file and accepts it in .tsx" | `c41c61a182b4a41a` | 3565 / 2498 |
| R11 | `harness/kill-proof/run.mutation-kill.test.ts` | "baseline problems — the reason names the actual failure a baseline failure on a file the live tree also lacks…" | `bb0a5d194f782e3e` | 2470 / 2079 |
| R12 | `harness/kill-proof/run.mutation-kill.test.ts` | "baseline problems — the reason names the actual failure a timed-out baseline run is unavailable with the time…" | `2124b19d3501321f` | 1881 / 1717 |
| R13 | `harness/kill-proof/run.mutation-kill.test.ts` | "target problems — a test file is never a proof target naming a test file as the mutated source is unavailable…" | `d9c0f518855eb4d3` | 2660 / 2395 |
| C01 | `harness/kill-proof/receipt.mutation-kill.test.ts` | "receiptId — the binding covers the whole mutant a different replacement at the same site yields a different id" | `59ae41c650022658` | 2282 / 2636 |
| C02 | `harness/kill-proof/receipt.mutation-kill.test.ts` | "receiptDigest — covers the verdict and is key-order independent flipping the verdict alone changes the digest…" | `b0c298652d4c48d4` | 2352 / 2548 |
| C03 | `harness/kill-proof/receipt.mutation-kill.test.ts` | "receiptDigest — covers the verdict and is key-order independent the same receipt with every object's keys in …" | `26d4d5dc830b64ba` | 2030 / 2375 |
| C04 | `harness/kill-proof/receipt.mutation-kill.test.ts` | "integrityReasons — verdict/case agreement in both directions a sealed receipt claiming survived over a killed…" | `a9f03e7306291e5b` | 2125 / 2220 |
| C05 | `harness/kill-proof/receipt.mutation-kill.test.ts` | "caseNameMatches — a title matches at a describe boundary only a title that is only the tail of a longer title…" | `7a8a3bcb2b50a172` | 2191 / 2286 |
| C06 | `harness/kill-proof/receipt.mutation-kill.test.ts` | "receiptCertifies — per named file, only the files the receipt killed through a receipt is not evidence for a …" | `56a8b6f44f40747a` | 2106 / 2294 |
| C09 | `harness/kill-proof/receipt.mutation-kill.test.ts` | "uncommittedPaths — untracked files are uncommitted an untracked file is listed" | `dedf00b061c70da0` | 2295 / 2055 |
| C10 | `harness/kill-proof/receipt.mutation-kill.test.ts` | "environment freshness — the vitest config is bound a config edit after the proof is a named staleness reason" | `91225b4bd3806cc4` | 1964 / 2071 |
| C11 | `harness/kill-proof/receipt.mutation-kill.test.ts` | "declaredVitestConfig / configDeclaredInputs — the grammar the receipt binds `vitest run -c <file>` in scripts…" | `417214bc829c1df1` | 1971 / 2294 |
| C12 | `harness/kill-proof/receipt.mutation-kill.test.ts` | "declaredVitestConfig / configDeclaredInputs — the grammar the receipt binds a globalSetup literal is a declar…" | `b8115c0b90b68dce` | 2133 / 2469 |
| V04 | `harness/kill-proof/resolve.mutation-kill.test.ts` | "resolveMutant — explicit fault refusals an identical --find/--replace is refused with the reason" | `dcfa190b3f85021e` | 1482 / 1474 |
| V05 | `harness/kill-proof/resolve.mutation-kill.test.ts` | "resolveMutant — manifest lookup a manifest id resolves across files when no --file is given, to the same site…" | `53929dc49241f95a` | 1446 / 1663 |
| L03 | `commands/tests-prove-kill.mutation-kill.test.ts` | "specFromOptions — the mutant id shape a 16-hex id with trailing characters is refused" | `7397bb74d29a718b` | 1696 / 2126 |
| L04 | `commands/tests-prove-kill.mutation-kill.test.ts` | "tests kill-proofs --verify — exit code an unreadable killed receipt fails --verify" | `b00f858a054f02b0` | 1900 / 1669 |
| L05 | `commands/tests-prove-kill.mutation-kill.test.ts` | "listKillProofs --verify — freshness classes a source edit after the proof reads STALE with its reason" | `8e9cb95c8fe3d33c` | 2320 / 2063 |
| L06 | `commands/tests-prove-kill.mutation-kill.test.ts` | "listKillProofs --verify — freshness classes added-but-uncommitted bytes read UNCOMMITTED, committed bytes rea…" | `2aad32737778d9ea` | 2057 / 2358 |
| L07 | `commands/tests-prove-kill.mutation-kill.test.ts` | "renderKillProofs — the killed-through line a single-file survived row carries no killed-through line; a parti…" | `f768d6f28d5a3b0f` | 2490 / 2352 |
| L08 | `commands/tests-prove-kill.mutation-kill.test.ts` | "tests prove-kill — --run-timeout validation --run-timeout 0 is refused before any run" | `0d7cd84410f11d27` | 2179 / 2314 |
| N02 | `harness/evaluator/post-tool-kill-proof.mutation-kill.test.ts` | "killProofNudge — which message a receipt's state earns a stale receipt with uncovered new cases is reported a…" | `16408bb9ff44e7e2` | 4617 / 4950 |
| N03 | `harness/evaluator/post-tool-kill-proof.mutation-kill.test.ts` | "killProofNudge — which message a receipt's state earns a receipt that killed only through another named file …" | `403002cc1a315915` | 5114 / 4520 |
| N05 | `harness/evaluator/post-tool-kill-proof.mutation-kill.test.ts` | "killProofNudge — new cases are computed against HEAD by default a case added since HEAD is required of the ce…" | `44e6e287ace7bdec` | 5160 / 5224 |
| S01 | `harness/mutation-kill-evidence-stop-check.mutation-kill.test.ts` | "newCaseTitles / countCaseTitles — the literal-title grammar returns the added titles and not the retained ones"; "newCaseTitles / countCaseTitles — the literal-title grammar a `test(` opener's title is a literal case title"; "detectMutationKillEvidenceGaps — the titles the receipt must have killed asks the kill-proof reader for exact…"; "detectMutationKillEvidenceGaps — the titles the receipt must have killed a title on the line after `it(` is s…" | `a6609797c04b4633` | 5654 / 4811 |
| S02 | `harness/mutation-kill-evidence-stop-check.mutation-kill.test.ts` | "newCaseTitles / countCaseTitles — the literal-title grammar a `test(` opener's title is a literal case title" | `461b4b1e5787b985` | 5014 / 5683 |
| S03 | `harness/mutation-kill-evidence-stop-check.mutation-kill.test.ts` | "detectMutationKillEvidenceGaps — the titles the receipt must have killed a title on the line after `it(` is s…" | `69deb2f21fb8446c` | 5120 / 5194 |
| S04 | `harness/mutation-kill-evidence-stop-check.mutation-kill.test.ts` | "detectMutationKillEvidenceGaps — the titles the receipt must have killed asks the kill-proof reader for exact…"; "detectMutationKillEvidenceGaps — the titles the receipt must have killed a title on the line after `it(` is s…" | `c364a0e9489ad135` | 4861 / 5325 |
| F02 | `harness/fail-before-fix/classify.mutation-kill.test.ts` | "failureKind — the grammar is anchored a message that merely mentions AssertionError is not an assertion" | `c78cb48b01ce4539` | 1250 / 969 |
| F03 | `harness/fail-before-fix/classify.mutation-kill.test.ts` | "failureKind — the grammar is anchored an is-not-iterable error is a crash" | `0c3056bff51ec5c2` | 928 / 1074 |
| F05 | `harness/fail-before-fix/classify.mutation-kill.test.ts` | "parseVitestReport — the first failure line and the thrown-in-test frame a frame in a sibling file whose name …" | `0f083b4d97edc58b` | 1016 / 859 |
| F06 | `harness/fail-before-fix/classify.mutation-kill.test.ts` | "parseVitestReport — the first failure line and the thrown-in-test frame a failure text with a leading newline…" | `f4cb555af3f8b68c` | 993 / 1350 |
| F08 | `harness/fail-before-fix/snapshot.mutation-kill.test.ts` | "createProjectCopy — links an absolute in-repo symlink resolves inside the copy" | `e12a1ae81d89bd35` | 1064 / 1111 |
| F09 | `harness/fail-before-fix/snapshot.mutation-kill.test.ts` | "createProjectCopy — links a dangling tracked symlink is copied as a link" | `219dc39852348a00` | 1096 / 1051 |
| F11 | `harness/fail-before-fix/snapshot.mutation-kill.test.ts` | "createProjectCopy — overrides a null override removes the file and the copy is still created" | `4528de9759b34e49` | 1046 / 1235 |

One new case needed a second attempt: F09's first assertion read the copied link with
`lstatSync`, which under the fault threw ENOENT from node internals — not the test's own check,
so the proof said `inconclusive` (receipt `727e6a3de3310f54`). The assertion now reads the link
through a try/catch helper and fails by its own `expect` (`219dc39852348a00`). This is the
fail-before-fix rule doing its job on the dogfood itself: a test that crashes under the fault
has not asserted the behaviour.

## Timing

136 `prove-kill` invocations, 15,483 s of wall time in total (two in flight at a time).

| Stage | Runs | Min | Median | Max |
|---|---|---|---|---|
| Unit files | 60 | 7.9 s | 16.0 s | 29.0 s |
| Full companion set | 38 | 59.8 s | 401.8 s | 557.6 s |
| New mutation-kill files | 38 | 13.1 s | 16.8 s | 37.6 s |
| All | 136 | 7.9 s | 17.5 s | 557.6 s |

Inside a unit-stage proof the two vitest runs take 1–6 s each; the rest is tsx start-up and two
or three git-visible copies of this 5,991-file tree. The full-set proofs are dominated by the
story and git tests, which spawn the CLI (and nested proofs) for every case: ~155–180 s per
vitest run in the copy, three runs per proof.

## Real product defects revealed by survivors

None. Every survivor is a plausible-looking fault that the existing tests could not tell from
the shipped code, but in each case the shipped code is the correct one and the fault changes
an observable (a verdict, a reason string, an exit code, a receipt binding, a copied link) that
the new test now pins. Two observations worth recording, neither a defect:

- `verifyKillProof` (`receipt.ts:345-357`) only re-locates the mutant after every hash
  matched, so its "mutant moved" / "mutated line changed" reasons cannot fire for an honest
  receipt (identical bytes resolve to the identical offset) and an edited offset already fails
  the id re-derivation. The branch is defence in depth against a forged receipt, not a live
  path; no fault was authored there.
- The reachability canary turns a snapshot-level link bug into `unavailable` rather than a
  false `survived` (F08 above). That is the designed fail-safe, and it means a regression in
  `copiedLinkTarget` would surface as "the tests do not load the file from the copy" on every
  linked repository rather than as a wrong verdict.

## Verification

Commands run on the unmutated tree at the end of the campaign (this checkout):

- `npm run typecheck` — clean (tsgo, both projects).
- `npx vitest run src/harness/kill-proof src/commands/tests-prove-kill.test.ts src/harness/evaluator/post-tool-kill-proof.test.ts src/harness/mutation-kill-evidence-stop-check.test.ts`
  — 11 files, 151 passed, 4 todo (the three new engine files included).
- `npx vitest run` over the other five new files plus `classify.test.ts`, `snapshot.test.ts`,
  the `mutation-kill-w27` file and the adapter encoding test — 9 files, 85 passed.
- The eight new files alone: 39 passed, 0 failed.
- 60/60 faults killed; 38/38 new-test proofs `killed` with exit 0 and a receipt.
