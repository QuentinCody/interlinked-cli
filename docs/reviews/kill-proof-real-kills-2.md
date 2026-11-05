# Kill-proof on this repository, batch 2: `src/lib/` and `src/commands/`

Run 2026-11-05 in a cloud session (branch `cloud/real-kills-2`, base `origin/mutation-proof`),
Node v22.23.4, vitest 4.1.11, linux-x64. Every fault is an explicit `--file/--find/--replace`,
run from source: `npx tsx src/index.ts tests prove-kill … --json`. Batch 1 modules
(`docs/reviews/kill-proof-real-kills.md`) were not repeated.

## Step 1: faults against the existing companion tests (10 modules)

| # | Module | Fault | Companion verdict | Exit | Receipt |
|---|---|---|---|---|---|
| 1 | `src/commands/verify/input-budget.ts:6` | `byteLength > MAX` → `>= MAX` | survived (2/2 pass) | 1 | `86570cc128138944` |
| 2 | `src/lib/test-lane.ts:8` | `return "integration"` → `return "unknown"` for `vitest.integration.config.ts` | survived | 1 | `e6b432a049330e74` |
| 3 | `src/lib/metrics/diagnostic-compare.ts:24` | `before.hash === after.hash` → `!==` (unchanged/changed swapped) | survived | 1 | `6bf343380804b9a3` |
| 4 | `src/lib/metrics/score-snapshot.ts:22` | `score < 0 \|\| score > 100` → `false \|\| score > 100` (lower bound dropped) | survived | 1 | `21a5d1eefbcd8877` |
| 5 | `src/lib/metrics/composite.ts:49` | `"complete" : "provisional"` swapped | survived | 1 | `061599a4f0a37e8e` |
| 6 | `src/lib/data-search/query.ts:13` | `limit > 1000` → `limit >= 1000` | survived | 1 | `291ae558782a3eba` |
| 7 | `src/lib/decision-metrics/outcome.ts:47` | `\|\| outcomes.includes("insufficient_evidence")` → `\|\| false` | survived | 1 | `f1aab4254d315d94` |
| 8 | `src/lib/activity-response.ts:19` | `wireLiteral(2, 3, 4, 5)` → `wireLiteral(2, 3, 4)` | survived | 1 | `810cd3e312e25eb7` |
| 9 | `src/lib/hook-timeouts.ts:22` | `PostToolUse: 120` → `60` | killed | 0 | `61d3c2745014b43d` |
| 10 | `src/lib/changed-files-option.ts:13` | `.filter(Boolean)` → `.filter((s) => s !== undefined)` | killed | 0 | `9534870123532e95` |

8/10 survived. #9 and #10 were predicted survivors that the companion tests already kill.
#6 and #8 survive but were not pursued (6 were enough).

Equivalent mutants identified and not pursued:
- `src/lib/data-search/query.ts:39` `(Number.isNaN(date) ? 0 : date)` → `(date)`: `NaN || x` already
  evaluates to `x`, so the id tie-break runs on both sides. Used as control (d) below.
- `src/lib/non-null.ts:27` `value === null || value === undefined` → `value == null`: identical
  semantics for every input.

## Step 2: new mutation-directed tests (6 surviving faults)

`<module>.mutation-kill.test.ts` beside each module, every case preceded by a
`// test-contract:` line. All 12 cases pass on unmutated code (`Test Files 6 passed (6)`,
`Tests 12 passed (12)`); `npm run typecheck` exits 0.

| # | New-test verdict | Exit | Killed cases | Receipt | Baseline ms | Mutant ms | Companion + new: `killedTests` (receipt) |
|---|---|---|---|---|---|---|---|
| 1 | killed | 0 | 1/2: "keeps an input of exactly VERIFY_INLINE_MAX_BYTES bytes in scope" | `1c455174a6d961c7` | 972 | 819 | `[input-budget.mutation-kill.test.ts]` (`b6c8056d038244f8`, 1/4 cases) |
| 2 | killed | 0 | 2/2: "labels the integration vitest config…", "records a vitest run with --config vitest.integration.config.ts…" | `5c84a7e5a31e0e07` | 675 | 724 | `[test-lane.mutation-kill.test.ts]` (`f07542f4809304b5`, 2/13) |
| 3 | killed | 0 | 2/2: "…same content on both sides as unchanged", "…content differs as changed" | `396692436ee721a1` | 1097 | 1043 | `[diagnostic-compare.mutation-kill.test.ts]` (`926f43213ec4092c`, 2/6) |
| 4 | killed | 0 | 1/2: "rejects a negative metric score" | `83d010bbd02b76d0` | 735 | 772 | `[score-snapshot.mutation-kill.test.ts]` (`97b4bbb0e316d4e7`, 1/3) |
| 5 | killed | 0 | 2/2: "reports status complete…", "reports status provisional…" | `8deeeb037576eecc` | 844 | 839 | `[composite.mutation-kill.test.ts]` (`d6ae6c563021eb2a`, 2/7) |
| 6 | killed | 0 | 2/2: "exits 3 when a measurement has insufficient evidence", "exits 3 for answered plus insufficient-evidence…" | `a908abae5e6a05de` | 689 | 682 | `[outcome.mutation-kill.test.ts]` (`faa507565425ae81`, 2/3) |

6/6 killed. The non-killing second cases in #1 (MAX+1 is oversized) and #4 (0 is accepted)
pin the other side of the same boundary and are reported per case as `survived`.

End-to-end wall time per `prove-kill` invocation: 6.0–10.1 s (the 6 new-test proofs:
8021, 7920, 8998, 8417, 8639, 6750 ms).

## Negative controls

**(a) Type-only assertion.** `composite.typeof-control.test.ts` (deleted after the run),
one case `expect(typeof composeScore([]).status).toBe("string")` against fault #5:
`survived`, exit 1, receipt `00dfbba97588faac`, reason
"1 case(s) passed with the mutant applied — these tests do not detect it".

**(b) Import-time throw.** `outcome.ts` line 1 gets ` throw new Error("import-time fault");`
appended, run with `outcome.mutation-kill.test.ts`: `inconclusive`, exit 2, receipt
`198d54aa6e029f22`; both cases "no result under the mutant".

**(c) Staleness.** `tests kill-proofs --verify` after step 2: 25 receipts, 24 FRESH, exit 0.
The one STALE is the control (a) receipt, because its test file was deleted:
`STALE: test src/lib/metrics/composite.typeof-control.test.ts no longer exists`. Exit stays 0
because only a stale `killed` receipt fails `--verify` (`src/commands/tests-prove-kill.ts:137`).
Then `// kill-proof staleness probe` was appended to `src/lib/decision-metrics/outcome.ts`:
exit 1, 5/25 STALE (`00dfbba97588faac` from before, plus all four outcome receipts:
`a908abae5e6a05de` KILLED, `faa507565425ae81` KILLED, `f1aab4254d315d94` SURVIVED,
`198d54aa6e029f22` INCONCLUSIVE); the other 20 stayed FRESH. Exact reason text:

```
STALE: source src/lib/decision-metrics/outcome.ts changed since the proof
```

The comment was reverted afterwards.

**(d) Equivalent mutant.** `query.ts:39` `(Number.isNaN(date) ? 0 : date)` → `(date)` against
the companion `query.test.ts`, which does exercise the NaN path (both times `null`):
`survived`, exit 1, receipt `020ebc31bbdd58c9`, 9/9 cases pass. The proof cannot tell an
equivalent mutant from a test gap; it reports `survived`, the same as a real gap.

## Observations on the feature

1. `kill-proofs --verify` reports a stale `survived` receipt (deleted test file) but exits 0.
   This matches `tests-prove-kill.ts:137` (only stale killed receipts count), and survived
   receipts never count as evidence.
2. Same as batch 1: a load failure under the mutant is reported as the generic
   "no result under the mutant" (the `import-time fault` message is not in the receipt).
3. Vitest `%j` titles render `Infinity`/`NaN` as `null` in case names
   (`{"since":null}`), so two different `it.each` rows can be indistinguishable in a receipt.
   This comes from vitest, not from the proof.
