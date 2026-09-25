# Interlinked docs

Public documentation for the Interlinked CLI:

- `how-to-use.md` — the user guide (install → enable → daily flow)
- `architecture.md` — how the system fits together
- `harness.md` — the local guard daemon in depth
- `command-reference.md` — a hand-maintained command-family overview and router
- `project-e2e.md` — project e2e enforcement for a host repository: policy schema, commands, targets, gates, CI, proof limits, recovery
- `e2e-testing.md` — Interlinked's own self-test lane (not host-project policy)
- `generated/cli-reference.md` — the exact command/option surface, generated from the live CLI registry
- the other files under `generated/` — generated check, rule, configuration, and metric references
- `examples/` — worked policy examples
- `demo/` — the interactive onboarding demo

Design memos, plans, and intake notes are operator material and are not part
of the public tree. In-source spec citations (`docs/design/...`) refer to that
operator material; the code they annotate is self-contained without them.
