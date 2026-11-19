# Shareable data-only policy profiles

Use `interlinked metrics policies export --id team-typescript --json` to emit the
current configured metric entries as a versioned profile. The command writes its
result to standard output. Share the resulting JSON as an ordinary file.

```json
{
  "schemaVersion": 1,
  "id": "team-typescript",
  "metrics": {
    "difficulty": { "mode": "warn", "threshold": 40 },
    "tokens": { "mode": "report", "threshold": 400 }
  },
  "rules": {
    "numeric-comparisons": {
      "check": "nan_comparison",
      "mode": "warn",
      "scope": { "paths": ["src/**"], "roles": ["product"] }
    }
  }
}
```

Inspect references with `interlinked metrics policies inspect team.json --json`.
Evaluate them with `interlinked metrics policies evaluate team.json --cwd /repo
--json`. Omit the profile argument to evaluate configured metric entries. Profile
paths resolve relative to the selected root. Absolute local profile paths also
work. All three commands support `--short` and `--full`.

Profiles reference installed metric and registry detector IDs. `tokens` names the
project AST function-token reading under `interlinked-ts-ast-v1`.
`function-tokens` separately names the canonical `interlinked-code-v2` edit
contract. Canonical measurement remains unavailable in this project adapter, and
its explicit target can appear in a structural proposal. An AST token target
stays in the project report. Named rule selections support report/warn/off. Their current
explicit evaluator covers JavaScript and TypeScript inputs from the existing
source-role inventory. Other languages and detector missing-evidence notices
remain explicit. Each detector retains its own applicability and finding limits.

`file.lines` targets use the hook's established newline-split count. The retained
AST physical-line reading excludes the final empty segment. Inspection identifies
both conventions, and profile assessment records unsupported comparison for a
configured `file.lines` target. It preserves the raw AST reading. Actual physical
line advice settings are described in [metric policies](metric-policies.md),
including the standalone generated cold-runtime limitation.

Evaluation retains all 23 existing project readings, their states, denominators,
evidence IDs and limitations. Report and warn targets are advisory numeric
comparisons. Off mode retains raw metric measurements. A requested block appears
as an advisory report disposition. Physical lines remain advisory. Missing,
stale, unsupported and inconclusive evidence supplies no target verdict. A scope
that selects a subset of an existing aggregate remains `scope-unmeasured` until
an adapter measures that population. Shared ActionInventory exports retain the
resulting measurements, candidates and evidence gaps.
Not-applicable readings retain their own status and produce no missing-evidence action.

Inspection/evaluation can emit a reviewable structural-three proposal for
`.interlinked/check-policy.json`. The existing policy-integrity detector compares
the proposal against adopted effective enforcement. The result records
`would-weaken` when required. Applying configuration continues through the
existing operator workflow. The daemon reads its established configuration files.
Profile files serve explicit inspection and evaluation.

Cyclomatic and cognitive numeric readings contain the maximum raw per-function
value from the shared AST counters. Their burden scores use separate
exposure-weighted aggregation. Explicit proposals use raw-unit targets. The
project product inventory and edit-hook eligible population differ, and a
project report supplies no edit-by-edit gate verdict.

The profile schema accepts versioned data references, selectors and targets.
Unknown fields and references fail validation. The commands run fixed local
adapters, and the target's package scripts and configuration code stay outside
this evaluation. Custom formulas, executable plugins and automatic profile
adoption require separate contracts.
