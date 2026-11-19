# interlinked-harness: permission proposals and unavailable checks

Reference for [SKILL.md](../SKILL.md). Read it for permission-learner proposals or NOT CHECKED detector evidence.

## Permission proposals and unavailable checks

The permission learner is suggestion-only. Crossing an observation threshold does not write Claude permissions or guard rules. Proposals retain the observed command and conservative pattern; observations do not prove approval or execution. Interpreter-wide and compound-command proposals are withheld. Cross-session `learned-rules.json` is observational proposal history, including its legacy `decision: allow` field; it is not effective authorization. Existing explicit permissions remain operator-owned.

Unknown `active_when` session predicates leave a distilled rule dormant with a diagnostic. The registered predicate is `active_agent_count_at_least` with `count`; do not substitute invented predicates or the legacy top-level `session_predicate` shape. See **enforce** for supported typed conditions.

Existing top-level `session_predicate` fields retain their historical unconditional matching and the operator's enabled setting, with a migration diagnostic. They are not evaluated conditions. Migrate them explicitly to supported `active_when` rather than silently disabling existing guards.

The baseline-effect guard compares bounded pre-call snapshots with the files after a tool
call and restores the WHOLE pre-call file when a protected water-line loosened. Reapply any
legitimate tightening that shared the same file. Restore audits live in
`.interlinked/baseline-undo/restored/`; a failed restore leaves recovery evidence and a warning.
Mutation-manifest changes and first-time seeding of an absent complexity metric are record-only:
review and restore inappropriate changes yourself. Intentional resets require the operator's
`INTERLINKED_DISABLE_BASELINE_GUARD=1` in the daemon environment; putting it in tool text
does not authorize a reset. Dry runs neither restore nor record.

Snapshots do not cover unbracketed background writes, oversized files, or an absent prior
water-line. A concurrent write inside another call's bracket may be attributed to that call.
Unresolvable Vitest denominator/config comparisons report NOT CHECKED, not a guessed restore.
This local guard is not an immutable security boundary. Explicit edit aliases, including
VS Code replacement arrays, are normalized per target file; shell wrappers retain their cwd
when checking commits and baseline writes. Read-only shell examples are not edits.

A thrown sequence detector or failed Stop scan records NOT CHECKED evidence while healthy detectors continue. Stop rescans are confined to the selected repository, including resolved symlink targets. External memory/config writes retained in session history are reported out of scope; they cannot launch another project's scan or receive repository check receipts. Project-aware detectors receive absolute paths in that repository. Endpoint checks build a project graph only when a finding requires reachability annotation. An instrumentation failure is not a source violation or a clean scan. LTL remains shadow-only: its event-clock.v1 counts PreToolUse and PostToolUse separately, including a paired tool-use ID. Open finite-trace obligations remain unknown at Stop; predicate exceptions taint that property and cannot manufacture violations. No local control-file guard is an immutable security boundary.

Each throwing trajectory rule produces unavailable shadow telemetry while peer rules and the LTL monitor continue. Adapter failures also retain unavailable telemetry without changing the enforcement decision.
