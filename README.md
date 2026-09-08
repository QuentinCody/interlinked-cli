# interlinked-cli

**The harness for your harness.** A local guard layer for AI coding agents —
integrates with Claude Code and Codex (supported), plus experimental Cursor,
Copilot CLI, Gemini CLI, OpenCode, and Pi adapters; evaluates delivered tool
hooks against deterministic rules; blocks the dangerous ones in
milliseconds; keeps a local activity log you can grep.

**The exit ramp, up front:** `interlinked disable` non-destructively stands the guard down.
`interlinked disable --uninstall` removes an `enable`/wizard installation; the narrower
`interlinked uninstall-hooks` removes only hooks installed through `install-hooks` —
both preserve a managed bridge if somebody changed its bytes.
The local guard requires no remote service. Runtime state lives under
`.interlinked/`; installation also writes the selected providers' settings,
managed bridges, and skill directories. Removal is explicit. Try it on a
throwaway repo first if you like; the
whole setup is `interlinked` (the wizard), and its matching teardown is
`interlinked disable --uninstall`.

## Why this matters for responsible AI at scale

Once an AI agent can write code, run shell commands, and install dependencies
on its own, the question for any organization stops being *"can it help?"* and
becomes *"how do we prove every controllable action a configured runner exposed
was checked against policy **before** it ran — and reconstruct the events the
runner delivered afterward?"*

Interlinked is a control plane for exactly that. It sits at the boundary between
the agent and the system. On each tool call delivered through a configured
provider's hook or managed-bridge surface, it:

- **Enforces policy deterministically** — a block-or-allow decision in
  milliseconds, with no model in the decision path, so every verdict is
  explainable and reproducible rather than a probabilistic guess.
- **Fails closed on what causes incidents** — on provider pre-tool gates,
  destructive commands, secrets written into source, and unvetted dependencies
  are stopped *before* they touch disk. If the daemon is unreachable, the
  self-contained deterministic fallback remains active; checks that require the
  full evaluator are reported unavailable rather than clean.
- **Produces an audit trail for delivered events** — events that reach the
  running harness are written to a replayable log, attributable to an agent and
  session. A provider that never invoked its integration, or a missing runtime
  that could not reach the harness, cannot be reconstructed from that log.

That is the triad every responsible-AI program is built on — **evaluation,
observability, and enforceable guardrails** — implemented at the provider
integration layer where a delivered agent intent becomes a real-world action.
Policy is shared through version control and normalized
across <!-- gen:runner_count -->7<!-- /gen:runner_count --> agent runners and a
fleet of agents working in parallel. Claude Code and Codex are the supported
pair; the other adapters are experimental, and each can enforce only the
controls its native API exposes. None of this requires a cloud dependency or
remote telemetry. Optional authenticated sync is explicit.

This isn't only an architecture diagram. The receipts below are
**<!-- gen:receipts_verified -->911<!-- /gen:receipts_verified --> per-event-audited
blocks** captured over **<!-- gen:receipts_window_days -->109<!-- /gen:receipts_window_days -->
days** of daily use on a single developer's machine — and the pattern is the
point: a deterministic, audit-first enforcement boundary that works the same
way for one agent or a thousand.

> **Receipts from <!-- gen:receipts_window_days -->109<!-- /gen:receipts_window_days --> days of dogfooding on the author's machine.** The
> activity log captured <!-- gen:receipts_logged -->3834<!-- /gen:receipts_logged -->
> distinct `guard_block` events (over-registration duplicates collapsed,
> grep-accelerator answers excluded); **<!-- gen:receipts_verified -->911<!-- /gen:receipts_verified -->
> of them survived a per-event audit** against Claude Code session
> transcripts to confirm the agent's actual `tool_input`. The audited
> breakdown:
>
> - <!-- gen:row_tsc_diff_overlay -->580<!-- /gen:row_tsc_diff_overlay -->×
>   historical edits that introduced a *new* TypeScript error and were blocked
>   before the write landed (`tsc-diff-overlay`). Current ordinary hooks run
>   external compiler checks asynchronously after the write; the transactional
>   CLI paths retain fail-closed proposed-content overlays.
> - <!-- gen:row_tdd_new_file -->93<!-- /gen:row_tdd_new_file -->× new
>   source file with no companion test (TDD gate)
> - <!-- gen:row_bash_redirect_bypass -->128<!-- /gen:row_bash_redirect_bypass -->×
>   shell-redirect bypass attempts (`cat > file.ts` to dodge the
>   content-quality gate)
> - <!-- gen:row_repo_confinement -->20<!-- /gen:row_repo_confinement -->×
>   writes outside the repo root
> - <!-- gen:row_empty_catch -->23<!-- /gen:row_empty_catch -->× empty
>   `catch {}` blocks
> - <!-- gen:row_process_kill -->24<!-- /gen:row_process_kill -->×
>   `kill` / `pkill` / `killall` at running processes — four aimed at the
>   harness or session itself
> - <!-- gen:row_reservation_conflict -->26<!-- /gen:row_reservation_conflict -->×
>   edits to files another agent held the reservation on
> - <!-- gen:row_git_destructive -->10<!-- /gen:row_git_destructive -->×
>   destructive git (`reset --hard`, `branch -D`, `stash drop`)
> - <!-- gen:row_secrets_in_source -->2<!-- /gen:row_secrets_in_source -->×
>   secrets detected in proposed write content
> - <!-- gen:row_supply_chain -->5<!-- /gen:row_supply_chain -->×
>   package installs not on the team allowlist (fail-closed supply-chain gate)
>
> Full breakdown on the [landing page](./landing/) or in
> [What you get](#what-you-get) below.

Local-first by design. The harness, activity log, and checks run on your
machine; server-backed collaboration commands are optional and require an
Interlinked MCP Server URL. No required cloud or remote telemetry, and no LLM in the hot path;
optional authenticated coordination/sync is explicit.

## Install From Source

The CLI is currently intended to run from the GitHub repo rather than a
formal npm package. Requires Node.js 22+. Supported on macOS and Linux
(including WSL on Windows — native Windows is not supported).

```bash
npm install -g github:QuentinCody/interlinked-cli   # one step: clone+build+link
```

Prefer a working checkout you can read and update in place? The long form is
equivalent (`prepare` builds `dist/` during `npm ci` automatically):

```bash
git clone https://github.com/QuentinCody/interlinked-cli.git
cd interlinked-cli
npm ci                 # builds dist/index.js + dist/hook-entry.js via prepare
npm link               # exposes `interlinked` and `interlinked-hook` on PATH
```

After that, `interlinked update` pulls the latest repo changes, rebuilds,
and refreshes the linked binaries.

`interlinked install-hooks` from a cloned checkout records an absolute path
to `dist/hook-entry.js` in your agent's settings, so hooks will keep firing
as long as the clone stays put. If you move or delete the clone, rerun
`interlinked install-hooks` from the new location (or `interlinked
uninstall-hooks` first). The tarball-install smoke test in `.github/workflows/ci.yml`
exercises the same end-to-end path.

## Which onboarding command do I run?

Four commands can start you off, and they do different amounts of work.
For a person configuring a new repo, the short answer is bare `interlinked`;
for automation or an explicitly chosen configuration, use `enable`.

| Command | What it does | When to use it |
|---|---|---|
| `interlinked` (no args) | Local-first harness wizard: chooses runners, strict/lenient/balanced posture, diff/whole-file scope, cap overrides, brownfield baseline adoption, and dead-code posture, then composes `enable` + the owning configuration commands. Outside a TTY it uses environment-driven local defaults without prompting | **Recommended human first run.** A new repo where you want to see and confirm the enforcement posture |
| `interlinked enable` | Installs hooks + skills, writes `.interlinked/` config, starts the harness; flags select the explicit configuration | **Canonical install primitive.** Automation, CI, or a configuration you already chose |
| `interlinked setup` | `enable`, then handles login/auth in one step | You also want to authenticate against an Interlinked MCP Server right away |
| `interlinked init` | A heavier, interactive onboarding flow: detects clients, installs hooks directly (no skills), logs in, attaches a workspace, and verifies the result | You're connecting to a team's Interlinked MCP Server and want guided workspace setup |

**Use bare `interlinked` for a normal first run.** It shows the actual local
enforcement decisions before applying them, then calls `enable` internally.
Use `enable` directly for scripted or already-decided installs. `init` is the
exception: it installs hooks on its own path and installs **no** skills, so
your agent gets the gates without the instructions for reading them. Reach
for `setup` or `init` only when you need the login and workspace steps they add.

## What you get

- **Guard harness.** A local Unix-socket server evaluates each delivered hook
  event against <!-- gen:builtin_rule_count -->121<!-- /gen:builtin_rule_count -->
  deterministic safety rules (destructive commands, secrets in writes,
  sensitive-file reads, lockfile drift, etc.) and returns block/allow
  or ask decisions in about 1–5 ms for cheap rules. External project checks
  take whatever their compiler or scanner takes and run after the edit.
- **Content-quality gate.** Ordinary agent `Edit`/`Write` calls run the
  deterministic, introduced-only `pre_block` registry over proposed content
  before the write lands. External TypeScript/Biome checks run asynchronously
  on the resulting file at PostToolUse. If compiler capacity is busy or a tool
  is unavailable, Interlinked prints `NOT CHECKED`; that is a no-verdict state,
  never a clean result. For fail-closed proposed-content TypeScript/Biome
  checking and an actual write, use transactional `interlinked write`;
  `verify-changeset` previews that gate without writing. `interlinked
  multi-edit` is transactional but runs Biome + TypeScript, not the
  `pre_block` registry.
- **Auto file reservation.** With the harness running, each delivered
  write-class event takes a lease-based
  reservation with a 5-minute TTL and a 30-second idle auto-release.
  When an Interlinked MCP Server is configured, a write that targets
  a file already reserved by another developer's agent is blocked with
  a pointer to coordinate via MCP messages; otherwise the reservation
  is local-only.
- **Post-edit checks.** <!-- gen:quality_check_count -->34<!-- /gen:quality_check_count --> quality checks across 8+ languages (tsc,
  biome, cargo, mypy, …) and <!-- gen:structural_check_count -->26<!-- /gen:structural_check_count --> structural checks (export surface,
  import resolution, cycles, blast radius) are eligible after mutating events;
  capacity-bounded external work can explicitly defer with `NOT CHECKED`.
- **Offline activity log.** Delivered events handled by the running harness
  append to `.interlinked/activity.jsonl`; this is local evidence, not proof
  that an unavailable integration observed an event.
  `interlinked status`, `activity`, `explain`, and `doctor` read from
  this log.
- **Trigram grep.** Eligible delivered Grep/Bash-search events can route through
  a cached trigram index, narrowing candidate files before `rg` runs; other
  searches pass through normally.

## Quick start

```bash
# In the repo you want to instrument:
interlinked                   # review posture, then install hooks + skills and start the daemon
interlinked status            # show what's configured
```

Then restart or reload your agent so it picks up the new skills. Run it as
usual and tool-use events flow through the harness.

OpenCode and Pi use managed source bridges instead of hook arrays. Project installs write
`.opencode/plugins/interlinked.ts` and `.pi/extensions/interlinked.js`; their native skill copies
live under `.opencode/skills/` and `.pi/skills/`. Interlinked refuses to overwrite a foreign file
at either bridge path, and uninstall preserves a bridge modified after install. Restart OpenCode
after installation. In Pi, run `/reload` (or restart) and approve the project-extension trust
prompt.

The supported runner list does not imply identical upstream APIs. OpenCode's stable plugin surface gates
generic tool execution and observes session lifecycle, but cannot open native confirmation from
`tool.execute.before`; an Interlinked `ask` therefore denies with a retry explanation. Its
`session.idle` signal cannot continue or veto Stop, and the stable surface has no dedicated MCP,
subagent, or worktree lifecycle hook. Pi gates `tool_call` and the separate `user_bash` path;
interactive sessions use `ctx.ui.confirm` for `ask`, while headless sessions deny. Pi's
`agent_settled` is observation-only and Pi likewise exposes no dedicated MCP, subagent, or worktree
hook. The shared shell rule still blocks `git worktree add` for every runner.

**Use `enable`, not `install-hooks`, unless you know you want the adapter
path.** Both wire the hooks, but `enable` also installs the skills that teach
your agent *how to work with the harness* — how to read a `BLOCKED: …
Suggestion: …` message, how to run `interlinked verify`, what the quality
ratchets expect, and how to legitimately suppress a false positive. Without
them, the first block your agent hits is a message it has to guess at, and the
most likely guess is to work around the gate. `install-hooks` is the precise,
manifest-tracked adapter path (see *Day-to-day commands*); it installs no
skills.

Server commands such as `login`, `sync`, `tasks`, and `inbox` are available
when you point the CLI at an Interlinked MCP Server.

### `/enforce` — turn AGENTS.md prose into deterministic rules

`interlinked enable` also installs the `/enforce` skill across every detected
agent runner (Claude Code, Codex, Gemini, Copilot, Cursor, OpenCode, Pi). Use it when you want
the imperatives in your `AGENTS.md` / `CLAUDE.md` / `.clinerules/` to become
rules the harness actually enforces, instead of prose the model may or may not
follow.

```bash
# In the repo you want to instrument:
interlinked enable                                    # hooks + skills (incl. /enforce)
# Restart or reload your agent so it picks up the new skill, then in-agent:
/enforce                                              # walk the project, distill imperatives
/enforce AGENTS.md                                    # or target a single file
/enforce list                                         # see what got distilled, grouped by source
```

Some runners surface skills via description match instead of `/`-prefix
(`$enforce`, `@enforce`, etc.). The slash form is canonical; description match
is a fallback for surfaces that don't expose slash-skills. Output lands at
`.interlinked/distilled-rules.json`; the harness reloads automatically within
~2s. Full reference: `skills/enforce/SKILL.md` in this repo.

## Day-to-day commands

| Command | What it does |
|---|---|
| `interlinked status` | Summary of configured agents, active harness, recent events |
| `interlinked activity --since 1h` | Recent hook events (filterable by agent, tool, since) |
| `interlinked explain --since 1h` | Per-event explanation including guard decisions |
| `interlinked doctor` | Diagnostics: hook registration, harness liveness, config sanity |
| `interlinked write <path> --stdin` | Write a file through the content-quality gate |
| `interlinked multi-edit <path>` | Apply N edits to one file atomically (all or none) |
| `interlinked verify` | Run the default high-signal quality audit over the current tree; artifact-structure checks are opt-in with `--structure` |
| `interlinked verify --all-checks` | Deep-audit mode: add advisory smell/taste checks |
| `interlinked simplify scan\|review\|audit` | Read-only local simplification evidence at repository or diff scope; add `--record` to persist findings |
| `interlinked simplify status` | Inspect explicitly recorded simplification runs and their common-corpus findings |
| `interlinked debt markers` | Scan explicit source-owned debt ceilings/triggers; add `--record` for lifecycle snapshots |
| `interlinked impact` | Report potential, Sandbox-validated, observed, and manifest-gated causal evidence without savings claims |
| `interlinked mode` | Show or switch enforcement mode |
| `interlinked coverage` | Per-file coverage ratchet (needs a `coverage-summary.json`) |
| `interlinked mutation` | Mutation subcommands: check/baseline consume a Stryker report; measure/sweep use a configured runner; survivors/disposition inspect local state; experimental cloud verbs operate the opt-in protocol-v3 journal |
| `interlinked structure` | Generic artifact structure management (manifests, adoption) |
| `interlinked harness start/stop/status/test` | Manage the harness daemon |
| `interlinked daemons` | List all active harness daemons and their health |
| `interlinked uninstall-hooks` | Remove hooks this CLI installed (manifest-driven) |

Run `interlinked --help` for the full command list, or `interlinked
<command> --help` for per-command flags.

## How it fits together

```
Claude/Codex/Copilot/Gemini/Cursor ──► packaged interlinked-hook
OpenCode/Pi ──► managed plugin/extension bridge ──► packaged interlinked-hook
                                        │
                                        ├─► harness Unix socket
                                        │     └─► guard eval (block/allow) in ~1–5 ms
                                        │     └─► post-edit checks (or explicit NOT CHECKED)
                                        │
                                        └─► .interlinked/activity.jsonl (when harness receives event)
                                              └─► interlinked {status,activity,explain,doctor}
```

Hook-array integrations invoke the packaged `interlinked-hook` binary;
OpenCode and Pi use their managed bridge files. Removing the CLI package does
not remove installed integration entries: use `interlinked disable --uninstall`
for an `enable`/wizard install, or `interlinked uninstall-hooks` for a
manifest-tracked `install-hooks` install.

## Enforcement modes

Guard evaluation has two layers:

1. **Guard rules** — destructive shell commands, secrets in writes,
   recursive deletes, force-pushes to protected branches. These block
   by default and are not downgraded by mode selection. Individual
   rules can still be disabled via `disabled_rules` in
   `.interlinked/guard-rules.local.json` if you have a specific reason.
2. **Taste rules** — style, complexity, coverage, test quality. Mode
   selection governs these.

Switch modes with `interlinked mode <name>`:

- `balanced` (default): destructive commands are blocked; quality findings warn.
- `lenient`: findings surface as warnings, writes proceed.
- `strict`: findings block the write until the agent fixes them.

Team-shared policy lives in `.interlinked/guard-rules.json`. Personal
overrides go in `.interlinked/guard-rules.local.json` (gitignored).

## Privacy

- Harness decisions and activity capture are local by default. Data leaves
  your machine only when you run server-backed commands such as `login` or
  `sync`, or when you explicitly opt into another remote workflow.
- No telemetry, no analytics, no "phone home" — not even an anonymous
  version-check ping. The CLI makes no outbound network calls on its own.
- Hook events, guard decisions, and quality findings stay in
  `.interlinked/` under the repo root.

## Further documentation

This README covers the essentials. For more detail:

| Doc | Covers |
|---|---|
| [`docs/harness.md`](./docs/harness.md) | Harness architecture: guard evaluation, reservations, quality checks |
| [`docs/command-reference.md`](./docs/command-reference.md) | Command-family overview and links to exact generated help |
| [`docs/generated/cli-reference.md`](./docs/generated/cli-reference.md) | Exact command and option surface, generated from the live CLI registry |
| [`docs/generated/`](./docs/generated/) | Auto-generated guard, quality, structural, configuration, and metric references |

`docs/generated/` is regenerated from the live registries by `npm run docs`,
and `npm run docs:check` fails CI when the committed prose drifts from the
source it was derived from. Read those files rather than trusting counts
quoted elsewhere.

## Contributing and reporting issues

- Contribution guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security policy: [SECURITY.md](./SECURITY.md)
- Bug reports and feature requests:
  <https://github.com/QuentinCody/interlinked-cli/issues>

## License

MIT. See [LICENSE](./LICENSE).
