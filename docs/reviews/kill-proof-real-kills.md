# Kill-proof on this repository: real surviving faults, real kills

Run 2026-11-04 in a cloud session (branch `cloud/real-kills`, base `origin/mutation-proof`),
Node v22.23.4, vitest 4.1.11, linux-x64. No mutation manifest was available, so every
fault is an explicit `--file/--find/--replace`, which is how a foreign repository uses
the feature. All commands were run from source: `npx tsx src/index.ts tests prove-kill … --json`.

## Step 1: faults against the existing companion tests (8 modules)

| # | Module | Fault | Companion verdict | Exit | Receipt |
|---|---|---|---|---|---|
| 1 | `src/harness/percentile-rank.ts:22` | `Math.round` → `Math.floor` in `percentileOf` | survived (5/5 cases pass) | 1 | `2058dddb8bae47e7` |
| 2 | `src/harness/license-policy.ts:58` | `split(/\s+OR\s+/i)` → `split(/\s+OR\s+/)` (regex flag dropped) | survived (15/15) | 1 | `cf40b6dc66a2356b` |
| 3 | `src/harness/recurrence-time.ts:12` | `DAYS_PER_WEEK = 7` → `8` | survived (6/6) | 1 | `e4cc7d37880e634b` |
| 4 | `src/harness/guard-tally.ts:49-50` | `return;` dropped after the block branch | survived (10/10) | 1 | `07fe430ceacb43ca` |
| 5 | `src/harness/project-graph-cycles.ts:42` | `visited.delete(current);` dropped (DFS backtrack) | survived (7/7) | 1 | `2a6ce54e55c20565` |
| 6 | `src/harness/compact-trigrams.ts:20` | `low <= high` → `low < high` | killed | 0 | `adfe3d9863dee07c` |
| 7 | `src/harness/finding-overflow.ts:55` | `items.length <= cap` → `< cap` | killed | 0 | `59c3f11ae03f1d97` |
| 8 | `src/harness/resource-budget.ts:25` | `availableBytes >= 0` → `> 0` | survived (14/14) | 1 | `f72a30dc8b6d9f2f` |

6/8 survived. #8 is an **equivalent mutant**, not a test gap: with 0 available bytes,
`maxRssBytes = 0 − reserve < required`, so the budget is refused on both sides. It was not
pursued. #6 and #7 were predicted survivors that the companion tests already kill.

## Step 2: new mutation-directed tests (5 surviving faults)

`<module>.mutation-kill.test.ts` beside each module, every case preceded by a
`// test-contract:` line. All 8 cases pass on unmutated code.

| # | New-test verdict | Exit | Killed cases | Receipt | Baseline ms | Mutant ms | Companion + new: `killedTests` (receipt) |
|---|---|---|---|---|---|---|---|
| 1 | killed | 0 | 1/2: "rounds a fractional share to the nearest integer, not down" | `6328b24d28a6d2d2` | 1124 | 1071 | `[percentile-rank.mutation-kill.test.ts]` (`73056326ba3b1e62`) |
| 2 | killed | 0 | 1/2: "treats a lowercase `or` as the SPDX OR operator" | `f9e18156706c567b` | 1089 | 1163 | `[license-policy.mutation-kill.test.ts]` (`227fba0b7bbf6663`) |
| 3 | killed | 0 | 2/2: "parses one week as seven days…", "resolves a week-relative cutoff…" | `9a03f8ec8fa7e67a` | 1182 | 1209 | `[recurrence-time.mutation-kill.test.ts]` (`b3a46745d82e49cb`) |
| 4 | killed | 0 | 1/1: "does not count warnings attached to a block" | `bc9d1e9336014ca6` | 1114 | 1066 | `[guard-tally.mutation-kill.test.ts]` (`64a67da9147858fa`) |
| 5 | killed | 0 | 1/1: "reports both cycles of a diamond that reconverges before closing" | `9b30f58a6ab46316` | 1081 | 1129 | `[project-graph-cycles.mutation-kill.test.ts]` (`aeb53c19f0b92e16`) |

The second case in #1 (round-down side) and #2 (lowercase `and`) do not kill their fault.
They were kept on purpose: they pin the other side of the same boundary, and the
proof reports them as `survived` per case, not as kills.

## Timing

- Per proof, the two vitest runs take ~1.0–1.5 s each (`baseline.durationMs`,
  `underMutant.durationMs` above).
- End-to-end wall time per `prove-kill` invocation: 10.0–11.3 s (5 proofs: 11164, 11328,
  10996, 10038, 11280 ms). **5 proofs total: 55118 ms.** About 8–9 s of each run is spent
  outside vitest (tsx CLI start-up, git-visible project copy).
- The 5 combined (companion + new) proofs: 9304–11464 ms each.

## Negative controls

**(a) Type-only assertion.** `percentile-rank.typeof-control.test.ts` (not committed),
one case `expect(typeof percentileOf(5, [1, 2, 9])).toBe("number")` against fault #1:
`survived`, exit 1, receipt `d4167e6217bea888`, reason
"1 case(s) passed with the mutant applied — these tests do not detect it".

**(b) Import-time throw.** `recurrence-time.ts` `const MS_PER_SECOND = 1_000;` →
`const MS_PER_SECOND: number = (() => { throw new Error("import-time fault"); })();`
with the new recurrence-time test: `inconclusive`, exit 2, receipt `5dc30b7a1edd1d27`;
both cases "no result under the mutant".

**(c) Staleness.** `tests kill-proofs --verify` after step 2: 20 receipts, all `FRESH`,
exit 0. Then `// kill-proof staleness probe` was appended to `src/harness/guard-tally.ts`:
exit 1, 3/20 receipts STALE (`07fe430ceacb43ca`, `64a67da9147858fa`, `bc9d1e9336014ca6`,
which are all guard-tally receipts), and the other 17/20 stayed FRESH. Exact reason text:

```
STALE: source src/harness/guard-tally.ts changed since the proof
```

The comment was reverted afterwards.

## Observations on the feature

1. `src/harness/kill-proof/run.ts:95`: when a test file fails to load under the mutant,
   the case reason is the generic "no result under the mutant". The actual load error
   (here `import-time fault`) is not carried into the receipt. The verdict is correct,
   but the reader cannot tell a load failure from a lost result.
2. `src/harness/kill-proof/receipt.ts:74`: the list view runs `.slice(0, 40)` / `.slice(0, 60)`
   on `JSON.stringify(...)`, so a truncated lexeme loses its closing quote, e.g.
   `→ "tally.lastBlockRule = decision.rule_id;`. This is cosmetic.
3. A comment-only change makes a receipt stale even though the fault still resolves at
   the same text. This is conservative and matches the documented byte binding.
4. `kill-proofs --verify` exits 0 even when the index holds `survived` and `inconclusive`
   receipts, because it only judges freshness. This matches the guide.
