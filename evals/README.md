# Harness-compat evals

Real-agent behavioral evals proving the interlinked harness still **permits
normal agent work**. The vitest suite pins what the gates *block*; nothing
pins what they still *allow* — a harness change can pass every unit test and
still make everyday tasks (write a module + test, fix a failing test, scaffold
three files) impossible or miserable for a live agent. This suite catches that
regression class by driving real headless agents through small fixture repos
with the harness **on** vs **off** and comparing outcomes.

Everything runs manually and costs real model tokens — it is not part of
`npm test` or CI.

## Quick start

For an explicit baseline/candidate comparison, preserve each distribution (including its
chunks, optional dependencies and `package.json`) before rebuilding. Then run:

```sh
node --test evals/compare-builds.test.mjs
node evals/compare-builds.mjs --dry-run
node evals/compare-builds.mjs --run --baseline /path/baseline/dist/index.js --candidate /path/candidate/dist/index.js --model claude-fable-5 --output /path/evidence
```

This defaults to six tasks × five repetitions × two counterbalanced arms. Use
`--tasks read,probe --repeat 1` for infrastructure qualification. It verifies selected
hook paths, uses separate fixture daemons, excludes inherited user/local hook settings,
and retains invocation, native stream/transcript, usage, daemon status, fixture hashes,
final diffs and evaluator-owned functional assertions. macOS fixtures use short `/tmp`
paths to fit Unix socket limits. `--run` is required to spend model tokens.

After a run, generate a scorecard from one or more evidence directories:

```sh
node evals/report-comparison.mjs /path/report /path/evidence
node evals/fixed-feedback.mjs /path/candidate-package /path/fixed-evidence
node --test evals/compare-builds.test.mjs evals/report-comparison.test.mjs evals/fixed-feedback.test.mjs evals/lib/native-hook-metrics.test.mjs
```

The report measures native Interlinked hook attachments preceding a later assistant
response, including provider wrappers and deduplicating transcript UUIDs. This is a byte
proxy for rendered model context, not tokenizer counts or billing. Missing transcripts
remain unknown; terminal-only records and the unconsumed transcript tail are excluded.
The fixed runner exercises native hooks without model calls, retaining transport receipts
and unchanged blocking controls. Activity warnings are ledger strings, not delivery counts.
The legacy `block_retry_success` metric now means a completed call
correlated by session, tool and canonical target; unknown targets get no credit, and one
completion satisfies only the latest pending attempt. A completed call interrupts a block
loop. Edit counts derive from the shared tool registry, including `apply_patch`.

The comparison is a pilot. Review candidate-only failures before making performance claims.
Compare identical policy/fixture hashes and actual resolved model IDs. Changes elsewhere
in either build confound causal attribution. Preserve failures and report correctness with
cost; do not infer billed savings from command length or successful sessions alone.

```sh
node evals/run-evals.mjs --dry-run          # print the plan + exact commands, run nothing
node evals/run-evals.mjs --tasks docs-edit --runners claude   # smallest real run (2 cells)
node evals/run-evals.mjs --runners claude               # full claude sweep (8 tasks x 2 arms)
node evals/run-evals.mjs --repeat 2 --json > report.json  # FAIL-confirming sweep, machine-readable
```

Prerequisites:

- `claude` CLI on PATH (runner 1); `codex` CLI optional (runner 2 — skipped
  when absent, like any missing runner binary).
- `interlinked` on PATH (only for the harness-on arm; `--arms off` runs without it).
- This repo's `node_modules` present (fixtures borrow its `vitest` via a
  symlink — no `npm install` happens inside fixtures).
- Metric extraction loads `src/harness/eval-metrics.ts` through the repo's
  `tsx` devDependency (or `dist/harness/eval-metrics.js` when a future build
  emits it).

## What one cell does

For each (task × arm × runner × rep) the driver:

1. Copies `evals/fixtures/<repo_shape>/` to a throwaway tmp dir
   (`EVALS_TMPDIR` overrides the base; `--keep` preserves the dirs).
   JS shapes get a `node_modules` symlink to this repo's tree so `npm test`
   works offline.
2. Harness-on arm only: `interlinked enable --clients <runner> --sync-mode
   local` + `interlinked harness start` inside the fixture (its own daemon +
   socket; events stay local).
3. Invokes the agent headless with cwd = fixture:
   - claude: `claude -p "<prompt>" --model haiku --dangerously-skip-permissions --max-turns 30`
   - codex: `codex exec --model $EVALS_CODEX_MODEL --skip-git-repo-check --sandbox workspace-write "<prompt>"`
     (default model `gpt-5.1-codex-mini`)
4. Enforces the task's `timeout_s` (SIGKILL on overrun).
5. Evaluates the task's `success_check` against the fixture.
6. Harvests metrics from the fixture's `.interlinked/activity.jsonl`
   (plus `rules-stats.json` when present) via `src/harness/eval-metrics.ts`.
7. Stops that fixture's daemon and deletes the tmp dir (unless `--keep`).

## Cost and time expectations

Rule of thumb per agent run: 30–120 s wall clock, ≤30 turns of haiku /
codex-mini — roughly $0.05–0.25 per run at mid-2026 pricing. A full sweep of
8 tasks × 2 arms × 1 runner × 1 rep = 16 runs ≈ **$1–4 and 15–45 minutes**
(sequential). `--repeat 2` doubles it; adding the codex runner doubles it
again. Use `--tasks`/`--runners` to scope while iterating, and always
`--dry-run` first.

## Scorecard and verdicts

Per-cell table: task, runner, arm, rep, success, blocks, loops, noise
(warnings per tool call), warns, secs, note (TIMEOUT / setup errors). Then an
on-vs-off comparison per (task, runner) (reps aggregated), then verdicts:

- **FAIL** — the task succeeds harness-off but failed harness-on **twice in a
  row** (needs `--repeat 2+`; a single on-arm failure is only a candidate).
  Exit code 1.
- **WARN** — single on-arm failure while off succeeds, any **block loop**
  (same rule blocked ≥3× consecutively — the stuck-agent signal), or
  **noise ratio > 0.5** (more than one warning per two tool calls).
- **PASS** — none of the above. **SKIP** — an arm is missing (e.g. `--arms on`).

Exit codes: 0 = no FAIL, 1 = at least one FAIL, 2 = usage/infra error.

Metrics glossary (all from `extractEvalMetrics` in
`src/harness/eval-metrics.ts`, unit-tested there): `blocks` (per rule id),
`block_retry_success` (blocks later followed by a completed call of the same
tool — the healthy block→comply path), `block_loops`, `warnings`,
`noise_ratio`, `edits` (completed edit-tool calls), `verifier_runs`
(test/typecheck/lint/build commands), `turns` (attempted tool calls).

## Tasks (v1)

| slug | shape | exercises |
|---|---|---|
| new-module-with-test | colocated-tdd | new-file TDD flow (tdd gate, per-edit coverage) |
| fix-failing-test | separate-tests | red-state editing, edit→verify loop |
| cross-file-rename | colocated-tdd | multi-file coordinated edits |
| three-file-scaffold | no-tests | new-file burst (wander-rule stressor) |
| scratchpad-script | no-tests | ad-hoc script write + execute |
| run-tests-and-report | colocated-tdd | verification + report writing |
| docs-edit | no-tests | docs-only edit stays friction-free |
| read-heavy-question | python | read/grep-heavy exploration |

## Adding a task

1. Create `evals/tasks/<slug>/task.json`:

```json
{
	"slug": "<slug>",
	"prompt": "imperative, self-contained instructions the agent sees verbatim",
	"repo_shape": "colocated-tdd | separate-tests | no-tests | python",
	"success_check": { "type": "file_exists | file_contains | command_exits_zero", "...": "..." },
	"timeout_s": 600,
	"stresses": "free-text note: which harness surface this exercises"
}
```

`success_check` variants: `file_exists` takes `path` or `paths` (all must
exist); `file_contains` takes `path` + `pattern` (regex) + optional `flags`;
`command_exits_zero` takes `command` (run via `/bin/sh -c` in the fixture)
+ optional `timeout_s`. The slug must equal the directory name.

2. Pick success checks that only pass when the agent did the work (e.g.
   `file_contains` on a *new* symbol, not `command_exits_zero` on a suite
   that already passes).
3. Reuse a fixture shape when possible. A new shape = new directory under
   `evals/fixtures/` + add it to `REPO_SHAPES` in `run-evals.mjs`; keep it
   minimal and dependency-free (declared deps would hit the supply-chain
   allowlist gate and require an install step).
4. Preview with `--dry-run`, then trial with
   `node evals/run-evals.mjs --tasks <slug> --runners claude`.

## Caveats

- **Global hook contamination**: if `~/.claude/settings.json` registers
  interlinked hooks user-wide, the harness-off arm is not a clean control
  (the driver warns). Temporarily remove the global hooks for honest off-arm
  numbers.
- Fixture copies are **not git repos** (codex gets `--skip-git-repo-check`);
  git-dependent harness features (commit gates, cadence nudges) are out of
  scope for v1.
- The off-arm writes no `.interlinked/activity.jsonl`, so its metrics are
  legitimately all zero; the interesting off-arm signal is success + seconds.
- `interlinked enable` in a fixture initializes a default localhost config;
  `--sync-mode local` + `INTERLINKED_SYNC_MODE=local` keep all events local.
- Runners evolve: pin the codex model via `EVALS_CODEX_MODEL`, and re-check
  the flag spellings in `RUNNERS` when CLIs update.
