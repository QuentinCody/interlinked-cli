# Kill-proof test-gap census: `src/lib/` and `src/commands/` (40 modules)

Run 2026-11-05 in a cloud session (branch `cloud/census-lib`, base `origin/mutation-proof` @ `1c05597`),
Node v22, vitest 4.1.11, linux-x64. Every fault is an explicit
`npx tsx src/index.ts tests prove-kill --file … --find … --replace … --test <companion> --json`,
one proof at a time (sequential). Modules from `kill-proof-real-kills.md` and
`kill-proof-real-kills-2.md` were skipped.

Selection: modules ≤ 300 lines under `src/lib/` or `src/commands/` with a companion
`*.test.ts` (beside the module or in `__tests__/`), no `node:fs`/`child_process`/`net`/`http`
import, no `fetch`/`spawn`/`writeFile`. Each fault is mutation-engine-shaped (relational
operator, boundary constant, dropped disjunct / array element, regex class) and was
authored against a reading of the module and the companion's test titles, predicted to escape.

## Census

| | count |
|---|---|
| Faults run | 40 |
| survived (exit 1) | 33 |
| killed (exit 0) | 7 (#22, #23, #29, #34, #37, #39, #40) |
| inconclusive (exit 2) | 0 |
| unavailable (exit 2) | 0 |
| judged equivalent (among survivors) | 1 (#32) |
| **Survivor rate, equivalents excluded** | **32/39 (82%)** |

Prediction accuracy: 33/40 predicted survivors survived; the 7 kills were wrong predictions
(the companion did pin the behaviour — e.g. #29: the shellcheck parse-error case uses code 1073,
which sits between my mutated 1000 and the real 2000 bound).

### Equivalent mutant

- **#32** `manual-debt-marker-record-parse.ts` `uniqueCanonical`: `entry >= prev` → `entry > prev`.
  The conjunct `new Set(values).size === values.length` already rejects any duplicate, so on every
  input that reaches the order check adjacent entries differ and `>=` ≡ `>`. Excluded from the rate.

No other survivor is equivalent: each changes an output for some concrete input
(e.g. #12 drops probability 1.0 from every reliability bin; #6 makes the glob `c++.ts` stop matching
the literal path; #9 treats `\\"` as an escaped quote; #21 orders sum-tied groups by key instead of count).

## Per-module table (companion tests)

| # | Module:line | Fault | Verdict | Exit | Receipt | Wall ms | Killing case (if killed) |
|---|---|---|---|---|---|---|---|
| 1 | `lib/metrics/inventory-roles.ts:40` | `role === "configuration" \|\| role === "documentation"` → `role === "configuration"` | survived | 1 | `7cf8470b371607d3` | 11989 | |
| 2 | `lib/metrics/score-profile.ts:44` | `entity.burden > 1)` → `entity.burden > 2)` | survived | 1 | `d84e108f6cc436ee` | 12026 | |
| 3 | `lib/value-validation.ts:7` | `typeof value === "number" && Number.isFinite(value)` → `typeof value === "number"` | survived | 1 | `84e8a3e371145bbc` | 15107 | |
| 4 | `lib/glob-overlap.ts:76` | `new RegExp(ˋ^${part1.replace(/\*/g, ".*")}$ˋ` → `new RegExp(ˋ^${part1.replace(/\*/g, ".+")}$ˋ` | survived | 1 | `0ea7b2d4ea330e6a` | 14049 | |
| 5 | `lib/auth-cred-match.ts:51` | `: value * 1000;` → `: value;` | survived | 1 | `bfd01827eb317039` | 15051 | |
| 6 | `lib/path-glob.ts:20` | `if (/[.+^$\|()\\]/.test(ch))` → `if (/[.^$\|()\\]/.test(ch))` | survived | 1 | `b3037bfce38944b2` | 14989 | |
| 7 | `lib/activity-utils.ts:81` | `if (total >= K_TOKEN_THRESHOLD)` → `if (total > K_TOKEN_THRESHOLD)` | survived | 1 | `aff154e01635ffb1` | 15481 | |
| 8 | `lib/output.ts:24` | `if (options.short) return "short";` → `if (options.short && !options.full) return "short";` | survived | 1 | `36dacaa0b70cd790` | 11897 | |
| 9 | `lib/manual-debt-markers-escaped-at.ts:13` | `return slashes % 2 === 1;` → `return slashes > 0;` | survived | 1 | `737575ea3ef6e74c` | 9041 | |
| 10 | `lib/manual-debt-marker-transition.ts:30` | `if (action !== "closed" \|\| after !== null \|\| before?.fingerprint !=…` → `if (action !== "closed" \|\| after !== null) return null;` | survived | 1 | `84faf8113d179d54` | 9400 | |
| 11 | `lib/decision-metrics/geometry.ts:63` | `.slice(0, 3);` → `.slice(0, 2);` | survived | 1 | `a6ae1ca2eb983b9e` | 9074 | |
| 12 | `lib/decision-metrics/statistics.ts:43` | `(row) => Math.min(9, Math.floor(row.probability * 10)) === i,` → `(row) => Math.floor(row.probability * 10) === i,` | survived | 1 | `28d561bc13ef61b5` | 8851 | |
| 13 | `lib/decision-metrics/answers.ts:37` | `Math.abs(sum - 1) > 0.01` → `Math.abs(sum - 1) > 0.1` | survived | 1 | `678784da42c60b16` | 8839 | |
| 14 | `lib/decision-metrics/retrieval.ts:78` | `Date.parse(doc.timestamp) < at &&` → `Date.parse(doc.timestamp) <= at &&` | survived | 1 | `d4faf10ce9f398cf` | 9059 | |
| 15 | `lib/decision-metrics/comparison-audit.ts:43` | `item.ruleProbability,` → `null,` | survived | 1 | `ba067c2b9e44fe14` | 9325 | |
| 16 | `lib/lint-import/sarif.ts:43` | `["pass", "notApplicable", "informational"]` → `["pass", "notApplicable"]` | survived | 1 | `d59d2f8b04e1bc74` | 9554 | |
| 17 | `lib/lint-import/invocation.ts:50` | `"--cap-lints=warn"` → `"--cap-lints=deny"` | survived | 1 | `4772efea8f98e272` | 9350 | |
| 18 | `lib/cowork/conformance.ts:29` | `effect("timeout") === "PRESENT"` → `effect("timeout") === "ABSENT"` | survived | 1 | `7065e1fed8d82e84` | 8917 | |
| 19 | `lib/cowork/capabilities.ts:31` | `timeout: 15,` → `timeout: 30,` | survived | 1 | `902a57defe0016d8` | 9585 | |
| 20 | `lib/cowork/policy.ts:43` | `timeoutMs > 10000` → `timeoutMs > 100000` | survived | 1 | `28538d0d267ad0db` | 9059 | |
| 21 | `commands/query/aggregate.ts:55` | ` \|\| b.count - a.count` → `(deleted)` | survived | 1 | `844452da4eafcfa5` | 14386 | |
| 22 | `commands/query/filters.ts:28` | `if (idx > 0) {` → `if (idx >= 0) {` | killed | 0 | `ea330e1beef5427e` | 14108 | parseWhereClause throws on an expression with no operator |
| 23 | `lib/config-resolve.ts:30` | `process.env.INTERLINKED_SYNC_MODE?.trim().toLowerCase()` → `process.env.INTERLINKED_SYNC_MODE?.trim()` | killed | 0 | `b412a30ec3e37e6b` | 12269 | resolveConfigEnvOverrides — positive (must fire) P1: reads and trim… |
| 24 | `lib/manual-debt-markers-default-excluded-segments.ts:59` | `rel.startsWith(ˋ${entry}/ˋ)` → `rel.startsWith(entry)` | survived | 1 | `296d74ca92e71547` | 12693 | |
| 25 | `lib/formatter.ts:136` | `if (days < 30)` → `if (days <= 30)` | survived | 1 | `8beff0ae2602266c` | 12623 | |
| 26 | `lib/write-tool-registry.ts:176` | `"save",` → `"",` | survived | 1 | `7006e19a1b279f66` | 12907 | |
| 27 | `lib/hook-template-chunks/package-install-cold-guard.ts:79` | `"shell", "run_command", "bash"` → `"shell", "bash"` | survived | 1 | `cb232486ded224d1` | 12427 | |
| 28 | `lib/hook-template-chunks/destructive-command-guard-git.ts:51` | `/\bgit\s+stash\s+(drop\|clear)/i` → `/\bgit\s+stash\s+(drop)/i` | survived | 1 | `c22decd539c9844e` | 12561 | |
| 29 | `lib/lint-import/parsers-extra.ts:18` | `if (code < 2000)` → `if (code < 1000)` | killed | 0 | `3daf28034a48e099` | 13172 | additional analyzer report contracts does not baseline 'shellcheck'… |
| 30 | `lib/decision-metrics/embedding-input.ts:9` | `/^embeddinggemma-2(?::\|@\|$)/` → `/^embeddinggemma-2(?::\|$)/` | survived | 1 | `d6301f140065b80f` | 11955 | |
| 31 | `commands/tests-output.ts:13` | `line.length <= DISPLAY_WIDTH` → `line.length < DISPLAY_WIDTH` | survived | 1 | `64581d816022bf31` | 12941 | |
| 32 | `lib/manual-debt-marker-record-parse.ts:49` | `entry >= (values[index - 1] ?? "")` → `entry > (values[index - 1] ?? "")` | survived (equivalent) | 1 | `c542cae9f9f44a7e` | 12610 | |
| 33 | `commands/query/render.ts:47` | `code < CONTROL_MAX \|\| code === DELETE_CODEPOINT` → `code < CONTROL_MAX` | survived | 1 | `60e6ce7706ac0ec4` | 12646 | |
| 34 | `lib/decision-metrics/relations.ts:72` | `forward === swap[reverse] ? forward` → `forward === reverse ? forward` | killed | 0 | `7b71d0150ab04777` | 12620 | never rewards edits when verification alone or no work is required |
| 35 | `lib/decision-metrics/serialization.ts:40` | `row.levels.length < 2` → `row.levels.length < 1` | survived | 1 | `9bc6b3db8a18fcd5` | 10541 | |
| 36 | `lib/metrics/deletion-evidence.ts:54` | `candidate.signals.length > 1` → `candidate.signals.length > 0` | survived | 1 | `b11f71fd840fd2a4` | 15564 | |
| 37 | `lib/metrics/catalog.ts:16` | `["guard", "sequence", "behavioral"]` → `["guard", "sequence"]` | killed | 0 | `40822ba8c7719d8d` | 18615 | complete metric catalog requires review when a check is added, remo… |
| 38 | `lib/metrics/coverage-span.ts:6` | `end.column === null ? Number.MAX_SAFE_INTEGER` → `end.column === null ? 0` | survived | 1 | `6aa8e6b67b7dd9a8` | 9192 | |
| 39 | `lib/hook-template-chunks/destructive-command-guard-mask-state.ts:82` | `return directRe.test(masked) \|\| quotedShellRe.test(cmdValue);` → `return directRe.test(masked);` | killed | 0 | `7ab07c7b5f7f0b6d` | 9263 | dcgMatchesShutdown — positive (must fire) P3: matches reboot inside… |
| 40 | `commands/verify/advisory-skips.ts:25` | `.map((s: string) => s.trim().toLowerCase())` → `.map((s: string) => s.trim())` | killed | 0 | `b7b1e0dbd2936ece` | 9247 | getEffectiveSkipChecks returns only the CLI list when --all-checks … |

(ˋ stands for a backtick inside a find/replace string.)

## Step 3: mutation-kill tests for the 10 most consequential survivors

Chosen for blast radius: three guard/gate paths (#26, #27, #28), two auth/config boundaries
(#5, #20), two parse/validation boundaries that feed every wire record (#3, #10), and three scoring
inputs (#1, #2, #16). Each file sits beside its module; every case is preceded by a
`// test-contract:` line. Unmutated: `npx vitest run <10 files>` → `Test Files 10 passed (10)`,
`Tests 14 passed (14)`. `npm run typecheck` exit 0.

| # | New test file | Verdict | Exit | Killed cases | Receipt | Baseline ms | Mutant ms | Wall ms |
|---|---|---|---|---|---|---|---|---|
| 1 | `lib/metrics/inventory-roles.mutation-kill.test.ts` | killed | 0 | 1/1 "counts documentation as a score input and excludes vendored files" | `4ef5c1a2188ff755` | 769 | 762 | 9009 |
| 2 | `lib/metrics/score-profile.mutation-kill.test.ts` | killed | 0 | 1/2 "rejects a normalized burden above one" | `0919d4babac7b3bd` | 842 | 764 | 8837 |
| 3 | `lib/value-validation.mutation-kill.test.ts` | killed | 0 | 1/1 "rejects non-finite numbers" | `8f3aff77f5b68434` | 841 | 777 | 8970 |
| 5 | `lib/auth-cred-match.mutation-kill.test.ts` | killed | 0 | 1/2 "accepts an unexpired token whose expiry is given in epoch seconds" | `72b4eb305b8312ff` | 829 | 758 | 8836 |
| 10 | `lib/manual-debt-marker-transition.mutation-kill.test.ts` | killed | 0 | 1/1 "rejects a closed transition whose before fingerprint mismatches" | `6df38ee983d23ad7` | 1091 | 867 | 9986 |
| 16 | `lib/lint-import/sarif.mutation-kill.test.ts` | killed | 0 | 1/1 "drops informational results and keeps failing ones" | `8f665d5d041a24ec` | 823 | 773 | 9030 |
| 20 | `lib/cowork/policy.mutation-kill.test.ts` | killed | 0 | 1/2 "refuses a bridge timeout above 10000 ms" | `d17f2dd4b8a98212` | 802 | 723 | 9274 |
| 26 | `lib/write-tool-registry.mutation-kill.test.ts` | killed | 0 | 1/1 "classifies an MCP save tool as write-capable" | `8d27927063d159ef` | 1034 | 823 | 9477 |
| 27 | `lib/hook-template-chunks/package-install-cold-guard.mutation-kill.test.ts` | killed | 0 | 1/1 "blocks an install issued through the run_command shell tool" | `1b7e705349f2e0b2` | 764 | 797 | 9317 |
| 28 | `lib/hook-template-chunks/destructive-command-guard-git.mutation-kill.test.ts` | killed | 0 | 1/2 "blocks git stash clear" | `f0e01063e80ec067` | 807 | 741 | 8440 |

10/10 killed. The four non-killing second cases (#2, #5, #20, #28) pin the other side of the
same boundary and are reported per case as `survived`, as expected.

## Timing (end-to-end wall time per `prove-kill` invocation)

| Set | n | min | median | max |
|---|---|---|---|---|
| Census (companion tests) | 40 | 8839 ms | 12148 ms | 18615 ms |
| Kill re-proofs (new tests) | 10 | 8440 ms | 9020 ms | 9986 ms |
| All proofs | 50 | 8440 ms | 10264 ms | 18615 ms |

The slowest proof (#37, 18.6 s) runs `catalog.test.ts`, which builds the whole check registry.
Per-run vitest time inside a proof was 0.7–1.1 s; the rest is copy creation, the third
unmutated re-run that confirms a kill, and the canary copy that confirms a survivor.

## The three worst gaps

1. **#27** — the daemon-down package-install guard (`package-install-cold-guard.ts`) has no test for its
   `run_command` shell alias, so deleting it would let any runner naming its shell `run_command`
   install unvetted packages exactly when the allowlist gate is offline.
2. **#28** — the destructive-git guard pins `git stash drop` but not `git stash clear`, so the
   one-command deletion of every stash could be un-blocked by a one-token regex edit with all tests green.
3. **#26** — `isWriteCapableToolName`'s write-verb list is untested by name, so dropping a verb such as
   `save` silently reclassifies third-party MCP save tools as non-writers and skips every write gate.

## Product defects

None hit. Every survivor is a test gap; no fault exposed wrong behaviour in the unmutated code.
