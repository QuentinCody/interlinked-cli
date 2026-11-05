# Kill-proof census: `src/harness/evaluator/` and `src/harness/mutation/`

Run 2026-11-05 in a cloud session (branch `cloud/census-evaluator`, base `origin/mutation-proof`
@ 1c05597), Node v22.23.4, vitest 4.1.11, linux-x64. Every fault is an explicit
`--file/--find/--replace`, run from source (`npx tsx src/index.ts tests prove-kill … --json`).
Modules covered by `kill-proof-real-kills.md` and `kill-proof-real-kills-2.md` were not repeated.
Every verdict, exit code, receipt id and duration below was produced by a command run in this
session; nothing is inferred.

## Step 1: 40 modules, one authored fault each, against the companion test

Selection: modules under the two directories with a same-basename `*.test.ts`, at most 300
lines, pure or near-pure (no network, no child processes, no fs writes). Four batch candidates
were excluded for ledger writes (`mutation-directed-guard`, `coverage-write-guard-redbar`,
`transient-debt-guard`, `edit-contract-phase`). Faults were authored to be
mutation-engine-shaped and PREDICTED to escape the companion; 40 of 40 were predicted
`survive` except `manifest-key` (predicted `kill`: the module's surviving candidates on
POSIX were all equivalent, so the one non-equivalent mutation was run knowing the companion pins it).

| # | Module | Kind | Fault (find → replace) | Companion cases | Verdict | Exit | Receipt | Wall ms | Observable under the fault |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `mutation/instability.ts` | dropped-branch | L47 `quarantined: prior.quarantined && consecutiveStableRuns < c…` → `quarantined: consecutiveStableRuns < change.threshold,` | 9 | survived | 1 | `4c392b336ab99ad2` | 15210 | a never-quarantined symbol becomes quarantined after its first stable run |
| 2 | `mutation/manifest-key.ts` | negated-condition | L52 `const abs = isAbsolute(posix) ? posix : resolve(cwd, posix);` → `const abs = !isAbsolute(posix) ? posix : resolve(cwd, posix…` | 5 | killed | 0 | `9e93d67b4d7b83c5` | 13774 | relative paths no longer resolved against cwd (killed by companion P1) |
| 3 | `mutation/stryker-evidence.ts` | flipped-comparison | L35 `.filter(([, count]) => count === 1)` → `.filter(([, count]) => count >= 1)` | 3 | survived | 1 | `33c8dd4cc7a6020b` | 16117 | a duplicated test id counts as resolved; unresolved kills under-reported |
| 4 | `mutation/gate-overlays.ts` | negated-condition | L74 `if (path === target) continue;` → `if (path !== target) continue;` | 1 | survived | 1 | `31375e880b6e2e7c` | 19948 | every co-edited non-target file is dropped from the runner overlays |
| 5 | `mutation/evaluate-census.ts` | dropped-branch | L29 `if (m.status === "uncovered" && changed.has(m.identity.symb…` → `if (changed.has(m.identity.symbolId)) sites.add(m.identity.…` | 9 | survived | 1 | `369070ebace9b317` | 17334 | killed/survived sites in a changed symbol are reported as uncovered |
| 6 | `mutation/pending-runs.ts` | flipped-comparison | L56 `return now - run.startedAt <= PENDING_TTL_MS;` → `return now - run.startedAt < PENDING_TTL_MS;` | 9 | survived | 1 | `58aa7d54bf82100e` | 14196 | a run exactly PENDING_TTL_MS old is treated as expired |
| 7 | `mutation/evaluate-evidence.ts` | dropped-branch | L63 `if (!Number.isSafeInteger(count) \|\| count <= 0) {` → `if (count <= 0) {` | 8 | survived | 1 | `9c1e38303a4a6d51` | 13565 | NaN / 2.5 executed-test count is no evidence gap; a malformed count certifies clean (gate stops blocking) |
| 8 | `mutation/gate-errors.ts` | off-by-one | L59 `if (pendingCount > 0) return "mutation still running past t…` → `if (pendingCount > 1) return "mutation still running past t…` | 12 | survived | 1 | `c668a08a6473f31f` | 13191 | a single recovered pending job is no longer reported as still running |
| 9 | `mutation/changeset.ts` | dropped-branch | L60 `if (oldString === null \|\| newString === null) return null;` → `if (newString === null) return null;` | 35 | survived | 1 | `f0bd92dee27d7261` | 13795 | MultiEdit entry without old_string is accepted with a null oldString |
| 10 | `evaluator/lint-baseline-integrity.ts` | wrong-default | L20 `oldCounts[fingerprint] : 0;` → `oldCounts[fingerprint] : Number.POSITIVE_INFINITY;` | 3 | survived | 1 | `f33eab0d79325f0f` | 24901 | new fingerprint in an adopted scope: no finding (gate stops blocking a reseeded allowance) |
| 11 | `evaluator/spans-quoted-operand.ts` | other | L13 `/^[^\s;\|&<>()`'"\\]+$/` → `/^[^\s;\|&<>()`'"]+$/` | 7 | survived | 1 | `db5ea65b966aa557` | 21470 | quoted body with a backslash and no nested quote renders as an operand instead of staying masked |
| 12 | `evaluator/wrapper-normalization.ts` | other | L10 `/^sudo(?:\s+(?:-[a-zA-Z]+\|--?[a-zA-Z][\w-]*(?:=\S+)?))*\s+/,` → `/^sudo(?:\s+(?:-[a-zA-Z]+\|--?[a-zA-Z][\w-]*(?:=\S+)))*\s+/,` | 12 | survived | 1 | `bf67ab9161868097` | 20538 | `sudo --login rm -rf /` keeps the flag; anchored destructive patterns miss (gate stops blocking) |
| 13 | `evaluator/keyword-quick-reject.ts` | other | L18 `const TOKEN_BOUNDARY = /[\s\|&;<>()`='"]+/;` → `const TOKEN_BOUNDARY = /[\s\|&;<>()='"]+/;` | 16 | survived | 1 | `a7f3612066cb1466` | 19286 | echo `rm -rf /`: token is `` `rm ``; a rule keyworded `rm` is quick-rejected (gate stops blocking) |
| 14 | `evaluator/rule-matching-guards.ts` | dropped-branch | L38 `if ((rule.requires_prior \|\| rule.forbids_after) && !session…` → `if (rule.requires_prior && !session) {` | 11 | survived | 1 | `094ca6d076ecab7c` | 17999 | forbids_after rule with no session fires as a plain content hit |
| 15 | `evaluator/coverage-scope.ts` | other | L29 `hash.update("\n");` → `hash.update("");` | 5 | survived | 1 | `bd8dc602ece89ebc` | 21185 | two different sorted test lists with equal concatenation share one scope id |
| 16 | `evaluator/network-hosts.ts` | other | L48 `/https?:\/\/([^/\s"'\|)]+)/gi` → `/https?:\/\/([^/\s'\|)]+)/gi` | 40 | survived | 1 | `a1fb155ed95f4de6` | 21599 | curl "http://127.0.0.1:8790" (quoted, no path) reads as a public host |
| 17 | `evaluator/water-line-files.ts` | other | L56 `(?:^\|/)\\.interlinked/` → `\\.interlinked/` | 13 | survived | 1 | `25f1bf6f8fa8fb36` | 21048 | /repo/foo.interlinked/metric-caps.json is treated as a water-line |
| 18 | `evaluator/manifest-package-version.ts` | dropped-branch | L42 `if (body.slice(cursor).trim()) return undefined;` → `body.slice(cursor).trim();` | 53 | survived | 1 | `5050790e69223cba` | 20607 | inline table with unparsable tail yields its version; `<unspecified>` block becomes accept (supply-chain gate stops blocking) |
| 19 | `evaluator/test-flake-guard.ts` | flipped-comparison | L21 `if (a.length !== b.length) return false;` → `if (a.length < b.length) return false;` | 11 | survived | 1 | `67a25db798a29b08` | 17190 | run2 failing set a strict subset of run1's: no flake warning |
| 20 | `evaluator/crap-violations.ts` | flipped-comparison | L92 `if (score < threshold) continue;` → `if (score <= threshold) continue;` | 10 | survived | 1 | `1939547a2c7c174b` | 17677 | function exactly at the CRAP cap is no longer reported (boundary shifts by one) |
| 21 | `evaluator/sequence-deferral.ts` | other | L40 `const TEXT_FIELDS = ["command", "content", "new_string"] as…` → `const TEXT_FIELDS = ["command", "content"] as const;` | 14 | survived | 1 | `9632f1ed864ce527` | 17627 | defer marker in an Edit's new_string is no longer honoured |
| 22 | `mutation/authenticated-zero-census.ts` | dropped-branch | L106 `const binding = mintedProofs.get(value);⏎→return binding !=…` → `const binding = mintedProofs.get(value);⏎→return binding !=…` | 14 | survived | 1 | `3c416b862c52be2c` | 14481 | a zero-census proof for one target authenticates for another target (binding weakened) |
| 23 | `mutation/kill-class.ts` | other | L54 `/\bAssertionError\b/,⏎→/^Snapshot .* mismatched/i,` → `/\bAssertionError\b/,` | 17 | survived | 1 | `4f17a03bd4c5ae82` | 14138 | a snapshot-mismatch kill is classified `unknown` instead of `assertion` |
| 24 | `mutation/survivor-fingerprint.ts` | dropped-branch | L110 `spans.push({ start: node.getStart(sf), end: node.getEnd() }…` → `spans.push({ start: node.getStart(sf), end: node.getEnd() }…` | 12 | survived | 1 | `934cd350c0ef5859` | 13638 | doubly nested blocks leak inner tail text into the fingerprint; a moved survivor is charged as new |
| 25 | `mutation/gate-decision.ts` | dropped-branch | L111 `if (persistWarning) decision.warnings` → `if (false) decision.warnings` | 18 | survived | 1 | `7c1e15e0e6798a5f` | 14693 | a measured-clean allow whose persist throws loses its `persistence failed partway` warning |
| 26 | `mutation/differential-fuzz-locate.ts` | other | L118 `stmt.moduleSpecifier !== undefined \|\| stmt.isTypeOnly) cont…` → `stmt.moduleSpecifier !== undefined && stmt.isTypeOnly) cont…` | 18 | survived | 1 | `6903d12a0deb1363` | 14357 | a type-only or re-exported alias is reported as a runtime export |
| 27 | `mutation/manifest-diff.ts` | dropped-branch | L180 `!sets.accepted.has(id.mutantId) &&⏎→→→!sets.quarantined.has…` → `!sets.accepted.has(id.mutantId);` | 5 | survived | 1 | `2db58d3d1c8c5ffd` | 13805 | a survivor in a quarantined symbol is returned as a new survivor and BLOCKS instead of WARN |
| 28 | `mutation/accept.ts` | other | L123 `...fileRecord,⏎→→→→[located.symbolId]: {` → `[located.symbolId]: {` | 31 | survived | 1 | `537cba06ef5ebe49` | 13908 | acceptMutant erases every other symbol record of the file |
| 29 | `mutation/harvest.ts` | other | L154 `if (got === null) continue;` → `if (got === null) break;` | 34 | survived | 1 | `0ce54614869c6ed5` | 13849 | a gone first shard silences every later shard's survivors (gate stops blocking) |
| 30 | `mutation/dead-code-signal.ts` | dropped-branch | L113 `mutantIds: ids,⏎→→→});⏎→→→continue;` → `mutantIds: ids,⏎→→→});` | 11 | survived | 1 | `5c8a90b39184804c` | 12525 | a polarity-pair line with ≥3 survivors is reported twice (high and medium) |
| 31 | `mutation/test-edit-effect.ts` | other | L130 `measured.filter((m) => isSurvivingStatus(m.status))` → `measured.filter((m) => m.status === "survived")` | 18 | survived | 1 | `b2ed857193b1ef6d` | 13352 | uncovered mutants in the measured run are not counted as surviving `after` |
| 32 | `evaluator/literal-context-gate.ts` | other | L28 `new Set(["block", "ask", "soft_block"])` → `new Set(["block", "ask"])` | 7 | survived | 1 | `2aea0e17d1491805` | 42029 | soft_block rule matching only inside a data literal keeps its refusal |
| 33 | `evaluator/vitest-coverage-glob-scope.ts` | dropped-branch | L41 `if (segments.some(segment => !segment \|\| segment.startsWith…` → `if (segments.some(segment => !segment)) return null;` | 40 | survived | 1 | `a9b4e232029b665e` | 14029 | src/.hidden/** parses as a plain glob and BLOCKS instead of abstaining |
| 34 | `evaluator/tsconfig-text-parse.ts` | dropped-branch | L133 `const message = beforeText ? unparseablePostImage(beforeTex…` → `const message = unparseablePostImage(beforeText, afterText);` | 8 | survived | 1 | `07d70ea3f87aadee` | 13900 | creating a tsconfig absent at HEAD with unparseable content yields a false loosening finding |
| 35 | `evaluator/lockfile-install-check.ts` | swapped-return | L143 `if (snapshot === null) return notMeasured(`${after.file} co…` → `if (snapshot === null) return null;` | 12 | survived | 1 | `2b6f1457c4b1c9d2` | 21862 | pre-install lockfile unparseable: silent clean instead of NOT MEASURED |
| 36 | `evaluator/coverage-edit-baseline-integrity.ts` | negated-condition | L83 `if (after !== null && after >= before) return null;` → `if (after === null \|\| after >= before) return null;` | 9 | survived | 1 | `b419365990e732ad` | 12787 | deleting `hw` from a kept entry is allowed silently (water-line gate stops blocking) |
| 37 | `evaluator/complexity-write-guard.ts` | other | L67 `const JS_TS_RE = /\.(?:ts\|tsx\|js\|jsx\|mjs\|cjs\|mts\|cts)$/;` → `const JS_TS_RE = /\.(?:ts\|tsx\|js\|jsx\|mjs\|cjs\|mts)$/;` | 97 | survived | 1 | `8d7b8d229ea9d277` | 16208 | .cts files skip the cyclomatic gate entirely (gate stops blocking) |
| 38 | `evaluator/heredoc-runtime-mask.ts` | other | L43 `node\|nodejs\|deno\|bun\|tsx` → `node\|nodejs\|bun\|tsx` | 61 | survived | 1 | `0548324999e173ad` | 13881 | a heredoc fed to `deno run -` is scanned as shell again |
| 39 | `evaluator/active-when.ts` | dropped-branch | L182 `(readOptionalToolString(event.tool_input?.path)) \|\|` → `"" \|\|` | 38 | survived | 1 | `6a780b5ab654472a` | 32463 | file_scope rule stays dormant for a runner that sends `path` instead of `file_path` |
| 40 | `evaluator/commit-parse-unwrap.ts` | other | L15 `"sh", "bash", "zsh", "dash"` → `"sh", "bash", "dash"` | 5 | survived | 1 | `9793d885a800d711` | 17304 | `zsh -c 'git commit'` is returned as the command itself; commit gates miss it (gate stops blocking) |

## Census

| | count |
|---|---|
| survived | **39/40** |
| killed | 1/40 (`mutation/manifest-key.ts`) |
| inconclusive | 0 |
| unavailable | 0 |
| not-passing-now | 0 |
| judged equivalent (excluded from the survivor rate) | 0 |

**Survivor rate: 39/40 (97.5%).** Per directory: evaluator 22/22 survived, mutation 17/18.

Two further probes were run on the same rules but kept OUT of the 40 because their faults
change only a message or a finding count, not a verdict:

| Module | Kind | Fault | Companion cases | Verdict | Exit | Receipt | Wall ms | Observable |
|---|---|---|---|---|---|---|---|---|
| `mutation/verdict.ts` | flipped-comparison | L21 `if (survivors.length > 0) parts.push(` → `if (survivors.length >= 0) parts.push(` | 19 | survived | 1 | `f8425fbd646e4bce` | 13092 | uncovered-only block reason reads `0 new surviving mutant(s) + …` (message only) |
| `evaluator/function-complexity-baseline-gate.ts` | flipped-comparison | L100 `return isNum(bCap) && isNum(aCap) && aCap < bCap ? bCap : n…` → `return isNum(bCap) && isNum(aCap) && aCap !== bCap ? bCap :…` | 25 | survived | 1 | `19332eb1afa28cc3` | 19740 | cap raise 16→20 plus a smuggled entry ≤16: the grandfather-new finding is lost (verdict still blocks on the cap finding) |

### Equivalence

No fault in the 40 is judged equivalent. Ten are PROVEN non-equivalent by a kill in step 2;
`manifest-key` is proven non-equivalent by the companion's kill. For the other 29 the
"Observable under the fault" column names a concrete exposing input that the companion does not
exercise; each was checked by reading the module and the companion, not by execution. The
proof itself cannot tell an equivalent mutant from a test gap (batch 2 control (d)), so these 29
carry reading-level confidence only.

Three faults were rejected during authoring as equivalent and replaced:
`manifest-key.ts` dropping the outer `normalizeFindingPath`, `isAbsolute(file)` vs
`isAbsolute(posix)`, and always-resolve (all identical on POSIX); `vitest-coverage-glob-scope.ts`
null-array faults (the only caller, `vitest-coverage-water-line.ts`, handles present-vs-absent
before the call).

## Step 2: new mutation-directed tests for the 10 most consequential survivors

Chosen by consequence: a gate that stops blocking (lint reseed, sudo long flag, backtick
keyword, supply-chain partial inline table, high-water deletion, `zsh -c git commit`, NaN
test count, dead first shard) or a boundary that shifts (CRAP at-cap, zero-census target
binding). `<module>.mutation-kill.test.ts` beside each module, every case preceded by a
`// test-contract:` line. All 20 cases pass on unmutated code (`Test Files 10 passed (10)`,
`Tests 20 passed (20)`); `npm run typecheck` exits 0.

| # | Module | New test | Verdict | Exit | Killed cases | Receipt | Baseline ms | Mutant ms | Wall ms |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `evaluator/lint-baseline-integrity.ts` | `lint-baseline-integrity.mutation-kill.test.ts` | killed | 0 | 2/2: ✓ "lint baseline integrity — new fingerprint inside an adopted scope reports a brand-new fingerprint added to an adopted scope as an allowance increase from 0"<br>✓ "lint baseline integrity — new fingerprint inside an adopted scope blocks the reseed through the shared detectBaselineGaming surface" | `fdc239a3f5cdec50` | 2304 | 2245 | 17515 |
| 2 | `evaluator/wrapper-normalization.ts` | `wrapper-normalization.mutation-kill.test.ts` | killed | 0 | 2/2: ✓ "normalizeCommandWrappers — value-less long flags strips sudo with a value-less long flag"<br>✓ "normalizeCommandWrappers — value-less long flags strips sudo with mixed short, value-less long and valued long flags" | `787d1120da04c22b` | 923 | 926 | 13013 |
| 3 | `evaluator/keyword-quick-reject.ts` | `keyword-quick-reject.mutation-kill.test.ts` | killed | 0 | 2/2: ✓ "commandKeywordTokens — backtick command substitution exposes the command word inside a backtick substitution as its own token"<br>✓ "commandKeywordTokens — backtick command substitution keeps a rule keyworded on the substituted command in evaluation" | `905c2436d47abfde` | 910 | 1011 | 13595 |
| 4 | `evaluator/crap-violations.ts` | `crap-violations.mutation-kill.test.ts` | killed | 0 | 1/2: ✓ "crapViolationsPerLine — the threshold is inclusive reports a function whose CRAP score equals the threshold exactly"<br>✗ (survived) "crapViolationsPerLine — the threshold is inclusive does not report a function one point under the threshold" | `ed3cace68152e380` | 1068 | 937 | 13530 |
| 5 | `evaluator/manifest-package-version.ts` | `manifest-package-version.mutation-kill.test.ts` | killed | 0 | 2/2: ✓ "manifestPackageVersion — partially parsed inline tables yields no version for an inline table whose tail the parser cannot consume"<br>✓ "manifest edit guard — partially parsed inline tables blocks a Poetry inline table with an unparsable trailing field even when the parsed version matches the approval" | `4129e4f875418203` | 1130 | 1077 | 13102 |
| 6 | `evaluator/coverage-edit-baseline-integrity.ts` | `coverage-edit-baseline-integrity.mutation-kill.test.ts` | killed | 0 | 2/2: ✓ "detectCoverageEdit — a removed high-water is a loosening fires when the explicit high-water is deleted from an otherwise unchanged scoped entry"<br>✓ "detectCoverageEdit — a removed high-water is a loosening fires the high-water removal alongside the re-key when a full-suite value becomes scoped at equal f" | `6fe34ffa742fcdf6` | 1153 | 1113 | 14193 |
| 7 | `evaluator/commit-parse-unwrap.ts` | `commit-parse-unwrap.mutation-kill.test.ts` | killed | 0 | 2/2: ✓ "unwrapCommand — zsh is a shell interpreter returns the inline program of zsh -c"<br>✓ "unwrapCommand — zsh is a shell interpreter recognizes zsh as a shell name" | `e5e7162e6500773c` | 1166 | 1059 | 13619 |
| 8 | `mutation/authenticated-zero-census.ts` | `authenticated-zero-census.mutation-kill.test.ts` | killed | 0 | 1/2: ✓ "isAuthenticatedZeroMutantCensus — the proof is bound to its target file refuses the minted proof for a different target file"<br>✗ (survived) "isAuthenticatedZeroMutantCensus — the proof is bound to its target file refuses the minted proof for a different target content hash" | `0a564b1232c0c55a` | 1463 | 1435 | 15686 |
| 9 | `mutation/harvest.ts` | `harvest.mutation-kill.test.ts` | killed | 0 | 2/2: ✓ "harvestPending — a gone shard does not silence the shards after it harvests a ready shard ordered after an unreachable one"<br>✓ "harvestPending — a gone shard does not silence the shards after it counts the later shard when the first answered with a non-404 error" | `8158bbdf1e45cd10` | 1096 | 1044 | 12987 |
| 10 | `mutation/evaluate-evidence.ts` | `evaluate-evidence.mutation-kill.test.ts` | killed | 0 | 2/2: ✓ "executedTestEvidenceGap — a non-integer count is not evidence reports NaN, fractional and infinite counts as gaps"<br>✓ "executedTestEvidenceGap — a non-integer count is not evidence keeps a green run with a NaN executed-test count from certifying clean" | `5321441e7514ac98` | 959 | 988 | 17093 |

10/10 killed. The two non-killing second cases pin the other side of the same boundary
(`crap-violations`: one point under the cap is let through; `authenticated-zero-census`: the
sibling content-hash conjunct) and are reported per case as `survived`, as in the earlier batches.

One rewrite during step 2, recorded because it is a classifier lesson: the first version of
the `evaluate-evidence` NaN case was `expect(executedTestEvidenceGap(NaN)).toMatch(/…/)`.
Under the mutant the helper returns `null`, vitest's `toMatch` throws
`TypeError: .toMatch() expects to receive a string, but got object` from inside `@vitest/expect`,
and the proof classified the case `inconclusive` (receipt `12f3409e75d51731`, 1 killed + 1
inconclusive, verdict still `killed` through the second case). Asserting `.not.toBeNull()`
first turns the same observation into an assertion failure: receipt `5321441e7514ac98`, 2/2 killed.
A mutation-directed test must fail by an ASSERTION on the value the fault changes, not by
handing the fault's output to a matcher that rejects its type.

## Timing

Wall time per `prove-kill` invocation (tsx start-up + two or three git-visible copies + vitest runs):

| set | n | min ms | median ms | max ms | total ms |
|---|---|---|---|---|---|
| step 1 (40 census + 2 extra) | 42 | 12525 | 16117 | 42029 | 734298 |
| step 1, the 40 | 40 | 12525 | 16117 | 42029 | 701466 |
| step 2 (10 new-test proofs, final runs) | 10 | 12987 | 13619 | 17515 | 144333 |
| all 52 | 52 | 12525 | 14693 | 42029 | 878631 |

The vitest runs themselves (`baseline.durationMs` / `underMutant.durationMs`) span
860–10281 ms, median 1091 ms; the 10 s max is
`literal-context-gate` (its companion loads the rule set). The ~12 s floor is the CLI start-up
plus copies, consistent with batches 1–2 on this container class (they measured 6–11 s on a
less loaded box). The two slow outliers are explained by their
companions, not by the proof: `literal-context-gate` (42 s wall) runs its suite in ~10.3 s per
copy (baseline 10281 ms, mutant 10228 ms, plus the canary copy), and `active-when` (32 s wall)
in ~5.5 s per copy (5546 / 5572 ms).

## The three worst gaps

1. `evaluator/manifest-package-version.ts:42` — one dropped `return` turns a fail-closed
   `<unspecified>` supply-chain block into an accept for any Poetry/Cargo inline table whose tail
   the parser cannot consume, and 53 companion cases did not notice.
2. `evaluator/coverage-edit-baseline-integrity.ts:83` — the high-water arm of the
   baseline-integrity gate had no case for the one hand move it documents as always a loosening
   (deleting `hw`), so negating its short-circuit silently un-guards the full-suite water-line.
3. `evaluator/commit-parse-unwrap.ts:15` / `wrapper-normalization.ts:10` /
   `keyword-quick-reject.ts:18` — three independent command-recognition seams each let one
   realistic launch shape (`zsh -c`, `sudo --login`, a backtick substitution) walk past the
   commit and destructive-command gates, and none of the three companions covers it.

## Product observations

- No product defect was hit: every one of the 42 faults is an authored mutation, and every
  companion passed unmutated in the isolated copy (0 `not-passing-now`, 0 `unavailable`).
- Kill-proof classifier (`src/harness/fail-before-fix/classify.ts failedByOwnCheck`): a
  vitest matcher TypeError on a null received value (`toMatch`, and by the same rule `toContain`
  on null) is filed as `inconclusive` because its first stack frame is in `@vitest/expect`, even
  though it is the test file's own line that handed the value over. The verdict is conservative
  rather than wrong; the guide's "assert on the mutated code's result" advice covers it, and the
  rewrite above is the fix on the test side.
- `npm ci` in this container fails in `prepare` (`npm run build`: the tsup DTS worker hits
  `ERR_WORKER_OUT_OF_MEMORY`). Dependencies install, `npm run typecheck` and vitest are
  unaffected, and every proof here ran from source. Not investigated further; it is an
  environment memory limit, not a source change on this branch.
