# interlinked-verify: project e2e scenarios

Reference for [SKILL.md](../SKILL.md). Read it when a repository has `.interlinked/e2e-policy.json` or you run `interlinked tests e2e`.

### Project e2e scenarios in any host repository

A repository with `.interlinked/e2e-policy.json` declares projects, suites
(`managed-contracts`: argv `prepare` steps, build `artifacts`), scenarios
(`affects` globs, `contractIds` from `.interlinked/behavioral-contracts.json`,
`required`, `boundary`) and expectation records. Only that policy creates
obligations; a repository without it pays nothing.

- `[interlinked:e2e] <project>: <scenario> needs current e2e evidence after
  <path> changed` fires on any observed edit to a mapped input (Edit, Write,
  Bash, patch). Run the exact command it prints:
  `interlinked tests e2e run --project <p> --scenario <s>`.
- `needs-mapping` means a protected input has no scenario. Add it to a
  scenario's `affects`; do not delete the protected glob.
- `tests e2e status` / `plan` inspect (exit 0). `tests e2e check` verifies the
  working tree (exit 0 satisfied, 1 open requirement or measured failure, 2
  UNCONFIGURED / unavailable). `tests e2e run` prepares, drives the public
  executable in a disposable workspace, writes
  `.interlinked/test-runs/e2e/<runId>/receipt.json` and appends to
  `.interlinked/e2e-obligations.jsonl`.
- A receipt satisfies only its exact generation: policy digest, affected
  files, the contract manifest and acceptance file, each case's cited
  requirement document, declared inputs and the bytes of any path-shaped
  executable the case invokes. Another relevant edit makes it `stale`; a
  failed case is `failed`; a missing toolchain, a failed prepare step, an
  input the collector could not capture (over 8 MiB, a symlink) or a receipt
  that does not parse strictly is `unavailable`; an unaccepted contract is
  `review-required` even when execution passed. A receipt from another
  worktree or with a runId the ledger never recorded is `RECEIPT_MISMATCH`.
- Every run copies the project into a disposable snapshot first; prepare
  steps and cases execute there with a private HOME. The live tree is only
  read. Compiled executables are copied byte-for-byte with their mode.
- Boundaries: `entry: "process"` (`real: ["application"]`), `entry: "http"`
  driven through a suite-OWNED `services` entry (the supervisor allocates the
  port, proves readiness and clean shutdown; a port that still answers after
  stop belonged to something else and the run cannot qualify), and `entry:
  "browser"` for a `playwright` suite (the app is owned, fronted by the
  supervisor's recording proxy, and every declared `requests` entry must be
  observed through it — a health check or an intercepted API earns nothing).
  A literal-URL case is never a boundary.
- A bound PROPOSED expectation is visible as an advisory (`~` line) and does
  not block completion unless the project sets `gates.review: "require"`.
  Disputed and superseded bindings always block.
- The loop for a new behavior: `tests e2e scaffold <name> [--suite <id>]
  [--write]` prints a proposed scenario (required: false, empty affects,
  a placeholder contract id) and a skeleton whose only assertion FAILS
  deliberately with every assumption marked `ASSUMPTION` / `REPLACE`. Replace
  the assumptions with the observed outcome, add the scenario to the policy
  yourself (the command never edits it), `tests e2e run`, then `tests e2e
  qualify --scenario <id>` for a stability cohort, then `tests e2e check`.
  A deliberate failure is CASE_FAILED, never a pass.
- A `qualified` cohort is a sample, not a flake-free claim. Its reason states
  the one-sided 95% upper bound on the per-run failure rate, 1 − 0.05^(1/n):
  the default 3/3 bounds it only to ≤ 63.2%, 5/5 to ≤ 45.1%. The bound
  assumes independent attempts; each attempt declares its own seed, but
  whether a run consumed it is not checked. A `mixed` cohort states its
  observed failure rate. Quote the bound, never "qualified" alone, when you
  report stability.
- Completion gates judge EXACT bytes, never "the repository": `tests e2e
  check --staged` judges the index (an unstaged fix does not count),
  `--revision <rev>` an exact commit; both are materialized from git's object
  store (no archive attributes, no smudge filters). `--base <rev>` compares
  the judged policy with the trusted base's: a removed/demoted requirement,
  a loosened gate (an omitted gate is its default: commit/ci require), a
  narrowed `affects`, an unbound contract, a dropped proof/request/stability
  profile is `POLICY_WEAKENED` (exit 1). The reviewed path is `tests e2e
  policy replace --base <rev> --project <p> [--scenario <s>] --rationale
  "<why>"`; the record is read from the judged target, so COMMIT
  `.interlinked/e2e-policy-changes.jsonl` (carve it out of `.gitignore`).
  Never "fix" a weakening by editing gates in the candidate: the candidate's
  own gate setting cannot waive `POLICY_WEAKENED`.
- `tests e2e gate install` writes pre-commit (`check --gate commit --staged
  --base HEAD`) and pre-push (one `check --gate ci --revision <sha> --base
  <remote sha>` per ref) hooks that CHAIN with existing hooks and only CHECK;
  `gate uninstall` restores the originals. A blocked commit or push prints
  the exact recovery command: run it, do not bypass the hook.
- `tests e2e ci [--base <rev>] [--revision <rev>]` exports the candidate
  COMMIT into a disposable directory with empty execution state, runs every
  plain scenario and every stability cohort there and checks the export
  against the event base. Workstation receipts, cohorts, untracked fixes and
  local records never count (`CI_RECEIPT_NOT_FRESH`); preparation steps must
  provision dependencies. Evidence lands in `.interlinked/test-runs/e2e/ci/<commit>/`.
- The Stop reminder is bounded: three identical reminders, one pause note,
  silence until the open set changes; an all-`unavailable` set is a HANDOFF
  (do not retry in a loop); with the daemon down it says NOT CHECKED.
  `interlinked verify` prints the same verdict in its `e2e` section.
- The operator guide is `docs/project-e2e.md` (schema, codes, targets,
  gates, CI, proof limits, recovery table).
- `[interlinked:e2e-quality] <project>/<scenario>: <rule> at <path>:<line>`
  is advice attached to the scenario a test edit affects (§12.3): a removed
  assertion or test block, an added `.only`/`.skip`, a specific matcher
  replaced by truthiness, a raised timeout/retry budget, `force: true`, a
  fixed timing wait, a CSS/XPath locator, an intercepted application
  endpoint, or a new test with no assertion. Net-new only (a moved line is
  not a signal); it never changes the verdict — the scenario still clears
  only through a supervised run.
- A `playwright` suite owns its application as a `services` entry; the run
  fronts it with a recording proxy (`INTERLINKED_E2E_BASE_URL` is the proxy)
  and forces `--reporter=json --workers=1`. A browser case earns the
  `browser-driver` boundary only when the proxy saw its requests inside the
  case's first attempt; `@playwright/test` absent in the project is
  `unavailable` with install guidance (`tests e2e doctor` names it too), never
  an install.
- Expectations: `tests e2e expectations propose --from draft.json` records an
  agent-authored statement with sources, assumptions and questions as
  `proposed`. `accept --from decision.json` binds the exact `revision`
  digest and records the linked contract digests as configured acceptance
  (a local decision, never authenticated human approval). `replace` supersedes
  with rationale and invalidates affected receipts; `review` lists questions,
  source provenance (`matched` / `stale` / `unavailable`) and diffs. Keep
  unresolved product questions in `questions`; do not turn an inference into
  a hard requirement.

- Adoption workflow for a repository with no policy yet (all read-only until
  `adopt`): `tests e2e discover --out report.json` inspects manifests, build
  and test commands, executables and existing contract cases, proposes an
  ADVISORY policy with one scenario per process-runner case, and lists gaps
  (no contract cases, ambiguous nested manifests, unsupported runners).
  Review the report, then `tests e2e adopt --from report.json [--project
  <id>] [--scenario <id>]` writes only the selected configuration; `--mode
  required` must be explicit and expectations in a proposal are always
  dropped. `--replace` is required to overwrite a policy (discarded, not
  merged). `tests e2e surfaces [--write]` inventories bins, scripts and
  OpenAPI JSON operations and shows which scenario `surfaceIds` bind them
  (`explicit` / `unresolved` / `dangling`); YAML documents, routes
  registered in code and unresolved `$ref`s are reported as limits, never as
  an empty complete inventory. An interface no extractor knows is declared in
  the project's `surfaces` list (`{"id": "cli:custom", "kind": "other",
  "address": "…"}`) and bound through a scenario's `surfaceIds`; that is the
  language-independent path. Discovery protects the real layout (`src/**`,
  python packages, top-level source files, the executable's file) and binds
  build scripts as shared inputs; a build whose outputs it cannot infer is a
  `suites[].artifacts` gap to resolve before `--mode required`, which refuses
  a project with no scenarios or with protected globs that match nothing.
  Depth-omitted subtrees are listed in the report's `limits.omittedSubtrees`.
  `tests e2e doctor` diagnoses policy, manifest, contracts,
  acceptance, toolchain, mapping, ledger and receipts without running anything
  (exit 1 on a failed prerequisite, 2 on an invalid policy). Configuration
  alone never produces a pass; the next step is always `tests e2e run`.

Shipped: managed process contracts for any language with a build/run argv
(TypeScript and Python validated locally; the Rust fixture's compiled route
waits for a Cargo-equipped runner), the discover / surfaces / adopt /
doctor adoption workflow, structured-runner suites (JSON protocol / JUnit
report import), owned loopback HTTP services with service-bound contracts,
and per-scenario proof modes (`proof {mode: old-new | controlled-fault |
characterization}`). A controlled-fault proof may record several violations
of the same requirement with `faults: [...]`; it is demonstrated only when the
designated cases fail under every one, because a case often notices one
violation and misses another. A counterfactual proof names its `designated` cases as
`{id, outcome?, action?}`: `outcome` lists the observables that ARE the
designated outcome (the case's other declared observables must hold on the
comparison side), `action` lists cases that must pass there first. Without
that declared evidence the supervisor cannot tell a setup failure from a
behavioral red, so it reports INCONCLUSIVE; output presence, exit codes
and status classes never count as evidence. Scaffolding, browser runs,
repetition cohorts and git/CI gates are implemented as described above.
Automatic conversion of existing tests into proposed contracts remains planned;
the MCP/Worker profile remains an explicit release gap.
