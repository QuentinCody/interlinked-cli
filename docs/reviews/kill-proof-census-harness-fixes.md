# Kill-proof census: fixes for the product defect and the three worst gaps

Follow-up to `kill-proof-census-harness.md` ("Product defect found", "Three worst gaps"). Run
2026-11-05 in a cloud session on `cloud/member-chain-ternary` (base `origin/mutation-proof`),
Node v22.23.4, vitest 4.1.11, linux-x64. Every proof is an explicit `--file/--find/--replace`
run from source: `npx tsx src/index.ts tests prove-kill … --json`. The `--find` text is the
FIXED code and `--replace` the pre-fix code, so each receipt certifies that the named tests
fail by their own check on the old behaviour and pass on the new. Receipts live under
`.interlinked/test-runs/kill-proofs/` (not committed); ids are recorded in each commit message.

| Item | Product / test | Fix (file:line) | Kill case (`// test-contract:`) | Receipt | Verdict |
|---|---|---|---|---|---|
| A. member-chain ternary false negative | **product** + test | `src/harness/checks/member-chain-scan.ts:41` (`isChainLink`: `?` only as `?.`, `!` only postfix after an operand and never before an identifier; one predicate for both former sites) | `src/harness/checks/member-chain-scan.test.ts:59` (N1 ternary; also N2–N4 killed) and `src/harness/checks/agent-safety-async.test.ts:63` (P5, the census probe `await ready ? items.forEach(async …) : null`) | `43499e5684062927` | **killed** (5 cases, both files) |
| 1. html-duplicate-id stray `</template>` | test | clamp already present at `src/harness/checks/html-duplicate-id.ts:71`; companion gains the unmatched-close-tag case | `src/harness/checks/html-duplicate-id.test.ts:20` | `2fcfb21a5ca0403d` | **killed** (3 cases: companion + the census `.mutation-kill` file) |
| 2. rule-matching-guards `forbids_after` without a session | test | code correct at `src/harness/evaluator/rule-matching-guards.ts:38`; companion gains N4 | `src/harness/evaluator/rule-matching-guards.test.ts:114` | `8a87cf9497daebdc` | **killed** (2 cases: companion + `.mutation-kill` file) |
| 3a. biome `syntax/<group>/<rule>` headers dropped | **product** + test | `src/harness/check-engine/output-parsers-biome.ts:35` (`syntax\S*`) + `classifyRule` (`:26`) | `src/harness/check-engine/output-parsers-biome.test.ts:93` | `6bcb76e133658cc3` | **killed** (1 case) |
| 3b. biome bare `syntax` header demoted to warning (the census fault) | test | `output-parsers-biome.ts:26` unchanged in meaning; companion pins bare `syntax` as an error | `src/harness/check-engine/output-parsers-biome.test.ts:85` | `8d500a78bc7fc6bd` | **killed** (2 cases: companion + `.mutation-kill` file) |

## Notes per item

**A.** The old predicate accepted any `?`/`!` character (`member-chain-scan.ts:19`, duplicated
in the main loop at `:65`). The head of `x = c ? a.b : 0` was therefore `c`, and
`isAwaitedForEachReceiver` saw `await ` before the ternary CONDITION. A prefix `!` was absorbed
the same way (`!a.b` started at `!`). Now `?` links only as the optional-chaining token `?.`
(before an identifier, `(` or `[`), and `!` only as a postfix non-null assertion: the previous
non-space character must end an operand (identifier, `)`, `]`) and the character to its right
must not start an identifier (`if (c) !a.b` is a prefix). Optional chaining and non-null
assertions still form a chain (`a?.b!.c[0]`, `f()!`, `s?.(x)`, `s?.[0]`). Every suite that
reaches `memberChainStart` (the only product importer is `agent-safety-async.ts`) was run:
member-chain-scan, agent-safety-async, agent-safety, array-for-each,
detector-boundary-regressions, misused_promises.adversarial, verify/file-checks-agent-safety —
7 files, 251 tests, all green.

**1.** `kill-proof-census-harness.md` already landed
`html-duplicate-id.mutation-kill.test.ts`, which kills the fault. The gap as stated was
companion-scoped ("no companion case contains an unmatched close tag"), so the companion now
holds the case too; the clamp itself needed no change. Product change: none.

**2.** Same shape: the `.mutation-kill` file from the census kills the fault; the companion's
negative block gains N4 so the companion pins it as well. `passesTemporalGating` is correct —
without a session the gate cannot observe the forbidden state, so the rule must stay dormant.

**3.** Pinning the bare `syntax` header led to checking what biome actually prints. Biome 2.4.13
(the installed binary) emits its syntax rule group as
`dup.ts:3:3 syntax/correctness/noDuplicatePrivateClassMembers ━━━`, which the alternation
`…|format|parse|syntax)\s` did not match: the diagnostic was dropped, the parser returned `[]`,
and the runner read a biome exit 1 as "no diagnostics parsed — lint NOT validated". That is the
exact fail-open class the module header records for `parse`/`syntax` and `assist/*`. The
alternation is now `syntax\S*`, and `classifyRule` makes the parse family and the `syntax/*`
group errors (biome treats the group as non-configurable errors). The 3a receipt proves the
regex change; the 3b receipt proves the census fault against the companion.

## Verification

- `npm run typecheck` and `npx vitest run src/harness/checks src/harness/check-evidence
  src/harness/__tests__/generic-checks-extended.test.ts`: see the session's final report for
  the pasted results.
- Each receipt was produced once, after its tests were written; none was re-run to force a
  verdict. Receipts bind the work-tree bytes; the commits carry the same bytes.
