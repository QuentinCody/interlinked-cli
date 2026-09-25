# How to use the Interlinked CLI

This page is a short router, not a manual. For the full picture, start with
the [README](../README.md) — this page only points you at the deeper docs.

The local harness (hooks, guard rules, activity log) is the product. An
Interlinked MCP Server is optional, for teams that want shared coordination.
You do not need one to use the CLI.

## Quickstart

The package is not published to npm. Install from source (Node.js 22+, macOS
or Linux):

```bash
git clone https://github.com/QuentinCody/interlinked-cli.git
cd interlinked-cli
npm ci
npm run build          # produces dist/index.js + dist/hook-entry.js
npm link               # exposes `interlinked` and `interlinked-hook` on PATH
```

Then, in the project you want to guard:

```bash
interlinked                   # review posture, then install hooks + skills and start the daemon
interlinked status            # show what is configured
```

Restart or reload your agent so it picks up the new skills. Bare `interlinked`
is the recommended human first run because its guided wizard shows the local
enforcement posture before applying it. Use `interlinked enable` directly for
automation or when you have already chosen the configuration; it auto-starts
the daemon, so a second `harness start` is unnecessary. See the README's
*Which onboarding command do I run?* section for the `setup` and `init`
server/workspace variants.

## Where to go next

| Doc | Read this for |
|---|---|
| [`../README.md`](../README.md) | Value proposition, full quick start, day-to-day commands |
| [`harness.md`](./harness.md) | Harness architecture: guard evaluation, reservations, quality checks |
| [`command-reference.md`](./command-reference.md) | Command-family overview and links to the exact reference |
| [`project-e2e.md`](./project-e2e.md) | Behavioral e2e enforcement for your project: policy, `tests e2e …`, git hooks, CI, recovery |
| [`generated/cli-reference.md`](./generated/cli-reference.md) | Exact command and option surface, generated from the live CLI registry |
| [`generated/`](./generated/) | Auto-generated guard, quality, structural, configuration, and metric references |

Server-backed commands (`login`, `sync`, `tasks`, `inbox`) need an Interlinked
MCP Server URL. Point the CLI at one with `interlinked enable --server <url>`
or `interlinked login --server <url>`.
