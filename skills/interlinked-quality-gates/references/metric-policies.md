# Structural edit metric policies

The `metrics` map in `.interlinked/check-policy.json` configures cyclomatic,
cognitive and function-token edit comparisons independently. Personal entries in
`.interlinked/check-policy.local.json` merge field by field. Missing entries keep
the existing `harness.edit_metrics` posture and canonical metric caps.

```json
{
  "metrics": {
    "cyclomatic": {
      "mode": "warn",
      "threshold": 12,
      "scope": { "paths": ["src/**"], "roles": ["product"] }
    },
    "cognitive": { "mode": "report" },
    "function-tokens": { "mode": "block", "threshold": 400 }
  }
}
```

| Mode | Edit behavior |
|---|---|
| `report` | Retain a measured projected regression in `check-executions` without an agent warning |
| `warn` | Present an advisory and retain its projected comparison |
| `block` | Refuse a measured new over-cap function or over-cap growth under existing delta and grandfather rules |
| `off` | Omit this metric's policy findings while existing measurement observers continue |

Thresholds must be finite nonnegative numbers. In report and warn modes an
explicit threshold is labeled a reporting target. A blocking threshold uses the
tighter of the requested value and the existing canonical metric cap. Existing
cap adoption and ratchet commands remain the authority for changing those caps.
Holding or shrinking existing debt retains its established comparison behavior.

Scopes combine relative path globs and source roles. Both filters must match.
Supported roles are `product`, `test`, `configuration`, `generated`, `fixture`,
`vendor`, `documentation` and `asset`. An omitted filter retains the existing
population. An empty array selects no paths or roles. Selectors narrow the
existing eligible source population, and excluded files retain measurement
observers where the original gate analyzes them. Existing generated/test/code
eligibility rules still apply. Path globs use the shared dependency-free matcher
with `*`, `**`, `?`, character classes and brace alternatives.

Once an effective blocking policy is adopted, agent edits cannot lower its mode,
raise its effective cap or narrow its scope. Personal overrides cannot weaken
inherited or team blocking. An explicit entry with an inherited blocking mode
also protects the shared global posture it depends on. Scope changes whose
preservation cannot be proved retain an explicit unresolved result. Intent,
observed-effect restoration and staged-commit checks share this comparison.
Intentional adoption changes use the existing operator workflow.

Unavailable parsers, unsupported source and unreconstructable patches retain
their existing unmeasured behavior. A missing finding supplies no clean verdict.
Dry-run comparisons omit observation and restoration writes. Physical line count
retains its advisory behavior.

The `file.lines` entry controls physical-line advice with report/warn/off, an
optional reporting target, and the same path/role filters. A requested block
produces an explicit unsupported-block warning and advisory behavior. Existing
growth, shrink and comment-only exemptions remain. Source eligibility is
unchanged. Report mode retains measured advice in check-executions. Off omits
policy advice while source measurement remains available. Dry runs retain no
observation writes.

| Runtime phase | Physical-line policy coverage |
|---|---|
| Warm daemon pre-write, post-write and read | Target, scope and report/warn/off |
| Native cold pre-write | Same projected comparison and disposition |
| Native cold post-write/read | Unmeasured through this advice path |
| Standalone generated cold fallback | Explicit NOT MEASURED, targets and scopes unapplied |

Hook advice keeps its established newline-split count. The AST project's
`physicalLines` reading excludes a terminal empty segment. Inspection names both
contracts. A profile `file.lines` target remains unsupported against that AST
aggregate, so no one-line conversion or proposal equivalence is inferred.

The map governs the structural three and physical-line advice above. Other
configured metric IDs retain explicit structural-hook coverage warnings.
Coverage, CRAP, mutation, commit quality predicates and project reports retain
their existing policies. The map can hold data-only policy entries for sharing,
and it executes no repository plugins or expressions. Reusable custom metric
definitions and broader metric policy integration require their own measured
contracts and adapters.
