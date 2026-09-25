# Interlinked CLI command overview

The exact current command and option surface is generated directly from the
live Commander registry:

- [`generated/cli-reference.md`](./generated/cli-reference.md) — authoritative
  command names, arguments, options, defaults, and help text.

Regenerate that reference with `npm run docs`. Do not copy exact flag lists
into this hand-maintained overview; use `interlinked <command> --help` when
working from a locally built checkout.

## Entry points

| Goal | Start here |
|---|---|
| Guided first run for a person | bare `interlinked` |
| Scripted or already-decided installation | `interlinked enable` |
| Installation plus optional server login | `interlinked setup` |
| Team/workspace onboarding | `interlinked init` |
| Inspect local health and recent activity | `interlinked status` / `interlinked doctor` |
| Run the on-demand quality audit | `interlinked verify` |
| Hold edits to behavioral e2e evidence (policy, supervised runs, git hooks, CI) | `interlinked tests e2e …` — see [`project-e2e.md`](./project-e2e.md) |
| Inspect or operate the local daemon | `interlinked harness` |

Bare `interlinked` is the recommended human first run: it presents the local
enforcement posture, then composes the underlying install/configuration
commands. `enable` is the explicit install primitive and is preferable for
automation. Both install hooks and skills and start the daemon.

## Command families

- Local setup and health: `enable`, `disable`, `doctor`, `context`, `env`,
  `harness`, `reload`, `reset`.
- Quality and policy: `verify`, `check`, `caps`, `coverage`, `mutation`,
  `deadcode`, `debt`, `allowlist`, `structure`, `simplify`, `spec`, `doctest`.
- Local observability: `status`, `activity`, `logs`, `explain`, `impact`,
  `telemetry`, `trace`, `collect`, `compact`, `recurrence`, `viz`.
- Local editing and recovery: `write`, `multi-edit`, `verify-changeset`,
  `checkpoint`, `rewind`, `resume`, `scratch`.
- Optional server-backed coordination: `login`, `workspace`, `tasks`, `inbox`,
  `send`, `handoff`, `watch`, `sync`.

Most guard, quality, activity, and maintenance commands work locally. The
coordination commands require a configured Interlinked MCP Server; consult the
generated reference for the exact connectivity and option contract of a
specific command.
