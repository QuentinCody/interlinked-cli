# interlinked-quality-gates: live per-edit survivor gate detail

Reference for [SKILL.md](../SKILL.md). Read it when a live mutation outcome needs explanation.

## Measurement and outcomes

Every v1 run measures the WHOLE FILE (the runner receives no line range; the
incremental cache is explicitly off on the wire); the evaluator still judges
only changed symbols. Scope is deliberately narrow: JS/TS product source
(`.ts/.tsx/.js/.jsx/.mjs/.cjs`) only; test and root `scratch/` paths are
excluded. A change set with MORE THAN ONE eligible source file returns
not-measured (MUT-AC-26) — today's tool adapters are single-file, so
multi-file shapes (apply_patch, CLI batch) are simply NOT measured yet;
adapters are open work. A **NEW file** (no on-disk baseline) is likewise
reported as not-measured naming the file, rather than passing silently
(2026-08-27): with no prior manifest entry every mutant is first-sighting,
which is baseline ADOPTION, not evidence this edit is safe — and the silent
version made brand-new untested code the one edit that skipped the gate with
no trace. It ships the full proposed change set, companion
test, and local dependencies as
overlays; the runner measures that primary file, while the ratchet judges mutants in changed
symbols. There is no sharding in v1: the range-split prototype was retired because a mutant
whose span crossed a shard boundary vanished from both sides. A future partial-scope design
lives dormant in plan 27 Appendix B and would need sharded-vs-whole-file census equality
proven before it can return.

The first measured sighting of a file is a distinct **`baseline_adopted`** outcome (2026-08-28):
it records the accepted floor so brownfield survivors do not make adoption impossible, persists
the manifest, and appends a receipt whose `outcome` field says "baseline_adopted" — it is an
allow with a visible "baseline adopted … NOT certified clean" warning, never a clean verdict
(nothing was compared, because that run created the baseline; "adopted" is declared only after
the persistence callback completes — but the current file-based state (manifest → receipt →
index → ledger, no transaction) can still be PARTIAL after a crash, and a failed persist
downgrades to "measured but NOT fully adopted"; true atomicity waits on the SQLite journal). A
red affected suite still blocks in `block` mode even on first sighting. Later runs flag new
changed-region survivors and uncovered sites, plus killed→survived regressions in unchanged
symbols (the accepted floor never grows from a routine run). Beyond adoption, only a FULL-scope,
fully-conclusive clean run refreshes the manifest and appends a receipt (its receipt says
"measured_clean"). A partial (line-range) run can block on
positive evidence but never certifies clean, never creates a first-sighting baseline, and never
touches the manifest; changed-region timeout/indeterminate results are likewise not-measured.
A report with zero mutants for the target — or no entry for it at all — is not-measured, never
clean: an empty report is not proof of a mutant-free scope.
Certifying clean also requires an explicit **engine exit 0** from the runner (strict since
2026-08-28): a response whose `engine.exitCode` is absent, `null`, or non-zero is not-measured —
a crashed engine's partial report is indistinguishable from a complete one, and its unreached
survivors are exactly what a forged clean pass would hide. A red suite still blocks WITHOUT
engine evidence (the engine legitimately never ran; adverse evidence outranks missing evidence).
It also requires a positive **executed-test count**. A green boolean with an absent, malformed,
or zero count is not-measured: it does not prove that any test oracle actually ran. The live
protocol-v2 gate and `mutation measure [--record]` share this evidence floor; neither may persist
or certify from a zero-test run. The sole v3 exception is an authenticated `not_mutatable`
result with an exact zero-mutant report and a `no_test_policy` approved by the signed acceptance
receipt. That exception reaches the evaluator through an opaque verifier-minted capability, not
a caller-controlled flag, and cannot be used by v2 runners. Proven adverse evidence still wins
first, so a survivor or red suite is reported even when the executed-test count is missing.
Note: Stryker exits non-zero when its score is under `thresholds.break`, so a runner that does
not disable that threshold will produce not-measured runs on valid reports — fail-safe, but
configure the runner's Stryker with `thresholds.break: null`.
Every "could not measure" exit — no runner, runner failure, missing shards, inconclusive
evidence — obeys `unavailable_behavior`. Warn-mode findings never launder the manifest clean.

## Live per-edit survivor gate: config and findings

The shipped default is off. Opt in under `.interlinked/guard-rules.json` for team policy or
`.interlinked/guard-rules.local.json` for machine-local runner topology/credentials:

```json
{
  "per_edit_mutation": {
    "enabled": true,
    "mode": "warn",
    "unavailable_behavior": "allow_unmeasured",
    "site_count_threshold": 25,
    "budget_ms": 10000,
    "harvest_budget_ms": 15000,
    "runner_url": "https://mutation-runner.example"
  }
}
```

| Knob | Effect |
|---|---|
| `enabled` | Master opt-in. `false` does no live mutation work. |
| `mode` | `block` rejects measured findings; `warn` runs the same measurement but allows with warnings; `off` is a no-op. |
| `unavailable_behavior` | `allow_unmeasured` preserves continuity with `[mutation:not-measured]`; `block` fails closed when no verdict is available. |
| `site_count_threshold` | Maximum distinct changed-symbol mutation sites in one established file before "split this patch"; default 50. |
| `budget_ms` | Initial runner round-trip ceiling; default 25,000 ms. Expiry is not a pass. Harvest of an expired run works only when the configured runner implements the durable job protocol; the current experimental Cloud Worker does not, so its expired runs are simply not-measured. |
| `harvest_budget_ms` | PostToolUse wait for an over-budget pending run; default 25,000 ms. A harvest that comes back with nothing is reported as **survivor-only evidence, NOT clean** (2026-08-27): the late path carries back survivors and nothing else — no test-run, engine-exit or mutant-census evidence, and it does not go through the evaluator the synchronous path uses — so "no survivors" is equally consistent with a run that executed no tests. Read that message as "nothing adverse was reported", never as a pass. |
| `runner_url` | THE mutation-runner endpoint (exactly one). No endpoint means unavailable, not clean. |
| `runner_urls` | OBSOLETE (2026-08-27): line-range sharding is retired from v1 — a mutant spanning a range split vanished from both sides. Extra entries are NOT used (no partition, no failover) and the daemon logs a deprecation warning. Remove them. |
| `token` | Optional bearer credential. Keep it in the gitignored local rules file, never committed policy. |

When the live gate reports:

- **New survivor:** strengthen the assertion, fix the source behavior, or remove dead/over-specific code.
- **Uncovered site:** add a test that executes the changed behavior.
- **Affected suite red:** restore green before interpreting mutation results.
- **Over site limit:** split the patch into smaller behavioral changes with their tests.
- **Not measured:** check runner configuration/reachability, test selection, budget, and the target repo's Stryker setup. Do not describe it as a pass.
