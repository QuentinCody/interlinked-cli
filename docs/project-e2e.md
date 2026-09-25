# Project e2e enforcement

Interlinked can hold an agent to **behavioral evidence** for a host project:
a policy declares which scenarios protect which files, edits open
obligations, and only a supervised run of the project's own contracts clears
them. A unit test, a green console line, a copied report or a receipt from
another machine never does. This guide is for the operator of a host
repository. The engine's design record is private; everything below is
observable from the CLI.

Interlinked's own hook/daemon boundary lane (`npm run test:e2e`,
`interlinked e2e scaffold`, `coverage check --lane e2e`) is a **self-test of
Interlinked** and is documented in [`e2e-testing.md`](./e2e-testing.md). It
applies only inside the Interlinked checkout. Nothing here requires a host
project to adopt Interlinked's layout, build system or dev dependencies.

## Files

| File | Tracked? | Purpose |
|---|---|---|
| `.interlinked/e2e-policy.json` | yes | projects → suites → scenarios; gates; scheduling; expectation records |
| `.interlinked/behavioral-contracts.json` | yes | portable contract cases (argv or http runner, declared observables, cited requirement) |
| `.interlinked/contract-policy.json` | yes | which contract cases are **accepted** (an unaccepted case is `review-required`, never a pass) |
| `.interlinked/e2e-policy-changes.jsonl` | **yes — carve it out of `.gitignore`** | reviewed §13 replacement records; read from the judged target, so a record must be committed to discharge a committed weakening |
| `.interlinked/e2e-obligations.jsonl` | no | append-only ledger: pending / attempt / cohort transactions |
| `.interlinked/e2e-requests.jsonl` | no | one durable request per open obligation per session |
| `.interlinked/e2e-quarantine.jsonl` | no | mixed stability cohorts, keyed by generation |
| `.interlinked/test-runs/e2e/<runId>/` | no | `attempt.json`, `receipt.json`, coverage, comparison sides; `cohorts/<id>.json`; `ci/<commit>/` retained CI evidence |

## Policy schema (version 1)

```jsonc
{
  "version": 1,
  "sharedInputs": ["schema/**"],                 // optional: inputs every project depends on
  "scheduling": { "autoRun": false, "quietMs": 5000, "minIntervalMs": 60000, "budgetMs": 120000 },
  "expectations": [],                            // managed by `tests e2e expectations …`
  "projects": [{
    "id": "orders", "root": ".", "mode": "required",   // advisory | required
    "protectedInputs": ["src/**"],                 // every protected input needs a scenario (needs-mapping otherwise)
    "gates": { "stop": "warn", "commit": "require", "ci": "require", "review": "advisory" },
    "observations": { "runtimeCoverage": "off" },  // off | node | node-required
    "surfaces": [{ "id": "cli:orders", "kind": "cli", "address": "node dist/cli.js" }],
    "suites": [{
      "id": "cli", "adapter": "managed-contracts",   // managed-contracts | structured-runner | playwright
      "prepare": [{ "argv": ["node", "build.mjs"] }], "artifacts": ["dist/**"],
      "services": [{ "id": "web", "argv": ["node", "dist/server.js", "--port", "{port}"], "env": { "DATA_DIR": "{fixture-directory}" }, "ready": { "kind": "http", "path": "/health", "status": 200 } }]
    }],
    "scenarios": [{
      "id": "order-persists", "suite": "cli", "required": true,
      "affects": ["src/**"], "contractIds": ["orders.add", "orders.list"],
      "boundary": { "entry": "process", "real": ["application"] },   // process | http (service) | browser (service + requests)
      "proof": { "mode": "execution" },                               // old-new | controlled-fault | characterization need designated cases
      "stability": { "qualificationRuns": 2 }
    }]
  }]
}
```

Gate defaults when omitted: `commit` and `ci` **require** on a required
project, `stop` warn, `review` advisory. An advisory project never blocks.
Changing a gate is a policy change the base comparison sees (below).

## Commands

| Command | Does | Exit |
|---|---|---|
| `tests e2e discover [--out f]` | read-only inventory: projects, build/test commands, contract cases, proposed scenarios, gaps | 0 |
| `tests e2e surfaces [--write]` | bins / scripts / OpenAPI operations mapped to `surfaceIds` | 0; 2 unconfigured |
| `tests e2e adopt --from f [--project] [--scenario] [--mode required] [--replace]` | writes the selected policy; advisory unless `--mode required`; inferred expectations are never adopted | 0; 1 refused; 2 usage |
| `tests e2e doctor` | prerequisites without running | 0 ok; 1 fail; 2 invalid policy |
| `tests e2e status` / `plan` | inspect obligations / next commands | 0 |
| `tests e2e run [--project] [--scenario] [--timeout]` | supervised execution in a disposable snapshot; writes a receipt | 0 / 1 / 2 |
| `tests e2e qualify --scenario s [--runs n]` | stability cohort: N independent attempts, every attempt published | 0 qualified; 1 mixed/failed; 2 deferred |
| `tests e2e check [--staged \| --revision r] [--base r] [--gate commit\|ci]` | the verdict for the working tree, the staged bytes or an exact commit | 0 satisfied; 1 open or weakened; 2 unconfigured/unavailable |
| `tests e2e ci [--base r] [--revision r]` | exports the candidate commit, runs every adopted profile there, checks it | 0 / 1 / 2 |
| `tests e2e gate install\|status\|uninstall` | pre-commit + pre-push hooks that CHECK (chained with existing hooks) | 0; 2 refused |
| `tests e2e policy replace --base r --project p [--scenario s] --rationale "…"` | records a reviewed requirement change (§13) | 0; 2 refused |
| `tests e2e scaffold <name> [--suite] [--write]` | proposes a scenario + a skeleton whose only assertion fails deliberately; never edits the policy | 0 |
| `tests e2e expectations propose\|review\|accept\|replace\|dispute` | expectation lifecycle bound to exact revision digests | 0 / 2 |

`interlinked verify` prints the same verdict as `tests e2e check` in an
`e2e` section (JSON key `project_e2e`) and fails under its own exit
convention. No policy ⇒ no section.

## What clears an obligation

A receipt satisfies a scenario only for its exact **generation**: the policy
digest, the affected files, the contract manifest and acceptance file, each
case's cited requirement document, declared inputs (with mode bits), the
bytes of every path-shaped executable in argv, the proof comparison commit
and, for a browser boundary, the declared requests. Any other state is a
named reason code:

| Status | Codes | Meaning |
|---|---|---|
| pending | `NO_EVIDENCE` | no qualifying run for this generation |
| stale | `STALE_GENERATION`, `STALE_POLICY` | a relevant input or the policy changed since the receipt |
| failed | `CASE_FAILED`, `STABILITY_MIXED`, `STABILITY_FAILED`, `STABILITY_QUARANTINED` | the application failed, or the cohort disagreed |
| unavailable | `CASE_UNAVAILABLE`, `CASE_STALE`, `SCOPE_INCOMPLETE`, `CONTRACT_MISSING`, `PREPARE_FAILED`, `INPUTS_CHANGED_DURING_RUN`, `RUN_INCOMPLETE`, `BOUNDARY_UNSUPPORTED`, `SENSITIVITY_*`, `STABILITY_DEFERRED`, `STABILITY_UNAVAILABLE`, `OBSERVATIONS_INCOMPLETE` | no verdict exists; hand off, do not loop |
| review-required | `EXPECTATION_PROPOSED` (with `gates.review: require`), `EXPECTATION_DISPUTED`, `EXPECTATION_SUPERSEDED` | a configured decision is missing |
| rejected | `RECEIPT_INVALID`, `RECEIPT_MISMATCH` | a receipt from another worktree, another run id or one that does not parse |

CI adds `CI_RECEIPT_NOT_FRESH` for a satisfied verdict whose receipt this
invocation did not produce.

## Targets: working tree, index, commit

`check` judges the working tree by default. `--staged` judges the exact index
(an unstaged fix never certifies broken staged bytes); `--revision <rev>`
judges an exact commit. Both are materialized straight from git's object
store: membership, bytes and modes as committed. Neither `git archive`
attributes (`export-ignore`) nor checkout conversions (smudge filters) can
change the judged bytes. A committed symlink is exported as a link.

## Policy changes and the trusted base

`check --base <rev>` (and every gate and CI run) compares the judged policy
with the policy at a **trusted base** — the previous commit at pre-commit,
the remote's sha at pre-push, the pull-request base or push `before` sha in
CI. Removing or demoting a required scenario or project, loosening a gate
(including from an omitted default), narrowing `affects`, unbinding a
contract, dropping a proof, request or stability profile is
`POLICY_WEAKENED` (exit 1). Refactors, reorders and additions are silent. A
base without a policy is a bootstrap. An unresolvable base is UNAVAILABLE,
never a fallback to HEAD.

The reviewed path is `tests e2e policy replace`, which records the exact base
and head digests, the project or scenario and a rationale. The record is read
from the **judged target**: commit it, or the staged / pushed / CI check does
not see it. The base is independent of a scenario's `proof.revision`.

## Git hooks and CI

`tests e2e gate install` writes a pre-commit hook (`check --gate commit
--staged --base HEAD`) and a pre-push hook (one `check --gate ci --revision
<sha> --base <remote sha>` per pushed ref; a deleted ref is skipped, a new ref
is a bootstrap). An existing hook is backed up and chained; the original runs
first and its failure wins. The hook bakes the built CLI it was installed
from; without it, `interlinked` on PATH; without either, exit 2 UNAVAILABLE.
Hooks CHECK; they never run a suite.

`tests e2e ci` exports the candidate commit (`--revision`, else `GITHUB_SHA`
or `CI_COMMIT_SHA`, else HEAD) into a disposable directory with **empty
execution state**, runs every plain scenario and every stability cohort the
policy adopts there, and checks the same export against the event base. The
working tree, untracked files, workstation receipts, cohorts and local
replacement records cannot reach the verdict; preparation steps must
provision dependencies. Evidence is copied to
`.interlinked/test-runs/e2e/ci/<commit>/`. Every result prints the §13 trust
limits: which receipts count, which base was used, which checker ran (pin the
Interlinked version in CI so a candidate change cannot supply its own).

## Proof modes and their limits

| Mode | Comparison side | Passes when | Cannot be demonstrated when |
|---|---|---|---|
| execution (default) | none | every bound case passes | — |
| old-new | export of `proof.revision` | designated cases fail there **at their declared outcome** with their action evidence established, and pass on the candidate | both pass; setup fails before the action; evidence undeclared |
| controlled-fault | the candidate with exactly one recorded fault | as above | the fault anchor is absent or ambiguous |
| characterization | export of `proof.revision` | every designated observation holds on both sides | the comparison cannot be built |

`designated: [{ id, outcome?, action? }]` names the observables that ARE the
outcome and the cases that must run first; output presence, exit codes and
status classes are recorded but never decisive. An inconclusive comparison is
`unavailable`, never a pass.

## Stability and quarantine

`stability { qualificationRuns 1–5, seed?, clock? }` requires N independent
attempts (own snapshot, derived seed, recorded clock) at qualification. A
mixed cohort quarantines the generation: rerunning the unchanged profile
cannot erase it; a repair is a new generation. A deferred cohort resumes.

## Stop reminders

With a policy present, Stop prints at most one line: the open required
scenarios with the exact `run` command, the `qualify` path for a quarantine,
or a **handoff** when nothing in this environment can clear the obligation.
The same unchanged set is reminded three times, then paused until it changes.
With the daemon down the reminder says NOT CHECKED; silence is never a pass.

## Recovery

| Symptom | Do |
|---|---|
| `needs-mapping — <path>` | add the path to a scenario's `affects`; never delete the protected glob |
| `stale` after an edit | `tests e2e run --project p --scenario s` |
| `unavailable: … not installed` | provision the toolchain or hand off; the obligation stays open |
| `POLICY_WEAKENED` | either restore the requirement or `tests e2e policy replace … --rationale`, then commit the record |
| `RECEIPT_MISMATCH` | the receipt is from another worktree or run; run again here |
| a hook blocks a commit or push | run the printed command; `tests e2e gate uninstall` removes the hooks and restores the originals |
| CI `UNAVAILABLE: no trusted base` | pass `--base <rev>` or run under a recognized CI event |
| a run crashed | the next run or SessionStart records it as `unavailable`; nothing is lost |

## Supported languages

The policy, discovery report and qualification rules carry no
language-specific field. TypeScript, Python and Rust are the pilot stacks;
the release matrix (`docs/e2e-release-matrix.md`, produced by `npm run
e2e:matrix`; the `e2e-release-matrix` workflow runs it with every toolchain
provisioned and fails on gaps) records, per language fixture, whether the
common route accepted a valid run, rejected an injected fault and rejected a
stale input with the installed toolchain. A missing toolchain is an explicit
gap row, never a silent skip.
