# interlinked-quality-gates: mutation research and campaigns

Reference for [SKILL.md](../SKILL.md). Read it for research helpers, a full-manifest census or survivor rounds.

## Source-only mutation research helpers

The source-only mutation research helpers support differential fuzzing, test-side
mutant enumeration and test-double candidates. They do not enable a new automatic
gate. Differential fuzzing calls original and mutated functions in-process; use it
only for suitable side-effect-free targets. A minimized divergence is a candidate
regression input, while no divergence is bounded search evidence, not equivalence.
Missing optional dependencies and unsupported targets remain explicitly unavailable.

### Full-manifest census and survivor rounds

Use `mutation measure <file> --record` for one source file. Use `mutation sweep` for a ranked
survivor batch. For a genuinely current whole-repo manifest, take one cutoff after proving the
exact working tree green, then reuse it across every restart:

```bash
cutoff="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
interlinked mutation sweep --all-eligible --measured-before "$cutoff" --dry-run
interlinked mutation sweep --all-eligible --measured-before "$cutoff" --limit 20 \
  --runner-url http://runner-a:8790 --runner-url http://runner-b:8790 \
  --budget-ms 1200000 --skip-preflight
```

Repeat the second command with the **same cutoff**. Each successful record gets newer provenance
and drops out of the next batch. `--all-eligible` inventories JS/TS product source under `src/`,
including absent and previously measured-clean files; it excludes test/spec paths and `.d.ts`.
Repeated runner URLs create worker lanes pulling from one queue, so one CLI process owns manifest
writes. Use `--skip-preflight` only after this exact overlay/tree passed its suite; otherwise a red
suite can falsely report mutants killed. Keep `not_measurable` and errors as explicit census residue.

After the census, rank work with `interlinked mutation survivors`. Add or strengthen tests in
small file/symbol batches, remeasure each target with `mutation measure --record`, and run an
independent final census from a new cutoff. A baseline is fully current only when every eligible
file has qualifying provenance from that final round; a high score alone does not prove that.

For a file-scoped survivor report, the CLI also prints the mutation-test grounding form. Put one
receipt immediately before every new case in a mutation-directed JS/TS test:

```ts
// test-contract: <public-api|invariant|bug|security|boundary> — <specific reference or rationale>
```

Mutation-directed filenames are dotted policy segments. Canonical forms are
`foo.mutation-kill.test.ts`, `foo.mutation-hardening.test.ts`, and `foo.survivors.test.ts`.
Model/wave qualifiers are allowed directly on the semantic token — for example
`foo.mutation-kill-luna.test.ts` — and remain inside the same strict class. A repo opts into the
blocking profile with `{"mutation_directed_strict_profile":{"enabled":true}}` in
`.interlinked/guard-rules.json` (team policy) or the local rules file. Under that profile,
introduced missing receipts, broad truthiness, missing SUT grounding, and assertion removal are
pre-execution blocks; pre-existing findings remain warnings. Do not rename a file to evade this
classification.

The write hook now surfaces `test_legitimacy` before a mutation-directed test edit lands; then run
`interlinked verify --all-checks --details` for the full audit. The advisory check reviews
missing/generic receipts, broad truthiness, incidental call order, and explicitly private/internal
imports (including multiline named imports); a companion warning catches cast-based private-member
access. Exact CLI/help/policy strings can be the public contract. “Kills mutant X” cannot: a
mutation kill proves sensitivity to an injected fault, not that the asserted distinction is a
supported behavior. The wider branch/partition, property/model, hermetic-repeat,
refactor-resistance, and blinded-review protocol is currently a design workflow, not a shipped
single command; see `docs/design/session-2026-08-11-synthesis.md` Part 6. Do not claim those
evidence layers ran merely because `mutation measure` succeeded.

For survivor repair, first reproduce against current source, tests, fixtures and runner
configuration. A live worker or HTTP health response is not proof of measurement. Retain
the initial green test execution, full report and input identities; match the same mutant
before/after, and keep timeouts, uncovered sites and changed-scope results separate from
kills. A fixture missing from a runner checkout is a delivery failure: preserve and ship
the fixture rather than excluding its test. Dispatch agents from the freshly reproduced
survivor set; historical logs can contain mutants already killed by existing tests. Keep
realistic failing application examples intact while investigating a source defect; do not
remove surrounding context merely to get green tests. Document equivalent mutations with
their supported-input reasoning instead of inventing impossible private-helper inputs.
A collected-test inventory is not an executed
test count. Do not add malformed inputs or private-state assertions solely to kill an
equivalent mutant; derive the observable obligation first. Where a behavior crosses a CLI
or hook boundary, share concrete input/expected-outcome examples between unit and e2e
tests, with independent assertions at each boundary. Local personal runner automation
does not establish a supported local-mutation product feature or autonomous repair service.

**Baseline-integrity** — a PreToolUse block on any edit that loosens a water-line file (below).
Pure disk-vs-proposed numeric diff, near-zero FP. Reset an intentional baseline change with
`INTERLINKED_DISABLE_BASELINE_GUARD=1` (logged). A commit-gate backstop closes the
`apply_patch`/subagent hole for the git-tracked baselines.
