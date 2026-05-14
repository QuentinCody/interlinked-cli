# interlinked-cli

**The harness for your harness.** A local guard layer for AI coding agents —
hooks into Claude Code, Codex, Cursor, Copilot CLI, and Gemini CLI; evaluates
every tool call against deterministic rules; blocks the dangerous ones in
milliseconds; keeps a local activity log you can grep.

> **Receipts from 2 weeks of dogfooding on the author's machine.** The
> activity log captured <!-- gen:receipts_logged -->446<!-- /gen:receipts_logged -->
> `guard_block` events; **<!-- gen:receipts_verified -->195<!-- /gen:receipts_verified -->
> of them survived a per-event audit** against Claude Code session
> transcripts to confirm the agent's actual `tool_input`. The audited
> breakdown:
>
> - <!-- gen:row_tsc_diff_overlay -->84<!-- /gen:row_tsc_diff_overlay -->×
>   edits that introduced a *new* TypeScript error — blocked before the
>   write landed (`tsc-diff-overlay`)
> - <!-- gen:row_bash_redirect_bypass -->35<!-- /gen:row_bash_redirect_bypass -->×
>   shell-redirect bypass attempts (`cat > file.ts` to dodge the
>   content-quality gate)
> - <!-- gen:row_tdd_new_file -->29<!-- /gen:row_tdd_new_file -->× new
>   source file with no companion test (TDD gate)
> - <!-- gen:row_empty_catch -->25<!-- /gen:row_empty_catch -->× empty
>   `catch {}` blocks
> - <!-- gen:row_repo_confinement -->18<!-- /gen:row_repo_confinement -->×
>   writes outside the repo root
> - <!-- gen:row_self_kill -->4<!-- /gen:row_self_kill -->× `kill <pid>`
>   where the PID was the harness/session process
>
> Full breakdown on the [landing page](./landing/) or in
> [What you get](#what-you-get) below.

Local-first by design. The harness, activity log, and checks run on your
machine; server-backed collaboration commands are optional and require an
Interlinked MCP Server URL. No cloud, no telemetry, no LLM in the hot path.

## Install From Source

The CLI is currently intended to run from the GitHub repo rather than a
formal npm package. Requires Node.js 22+. Supported on macOS and Linux
(including WSL on Windows — native Windows is not supported).

```bash
git clone https://github.com/QuentinCody/interlinked-cli.git
cd interlinked-cli
npm ci
npm run build          # produces dist/index.js + dist/hook-entry.js
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

## What you get

- **Guard harness.** A local Unix-socket server evaluates every agent
  action against <!-- gen:builtin_rule_count -->106<!-- /gen:builtin_rule_count -->
  deterministic safety rules (destructive commands, secrets in writes,
  sensitive-file reads, lockfile drift, etc.) and returns block/allow
  decisions in about 1–5 ms for cheap rules; content-checking rules
  (`tsc`/`biome` diff-overlay) take whatever the compiler takes.
- **Content-quality gate.** `tsc` and `biome` run over the *proposed*
  file content before a write lands. The gate blocks only on net-new
  findings, never on pre-existing issues. Works for `Edit`/`Write`
  tools and — via `interlinked write` — for Bash-mediated writes like
  `sed -i` or `cat > file`.
- **Auto file reservation.** Every file write takes a lease-based
  reservation with a 5-minute TTL and a 30-second idle auto-release.
  When an Interlinked MCP Server is configured, a write that targets
  a file already reserved by another developer's agent is blocked with
  a pointer to coordinate via MCP messages; otherwise the reservation
  is local-only.
- **Post-edit checks.** 27 quality checks across 8+ languages (tsc,
  biome, cargo, mypy, …) and 25 structural checks (export surface,
  import resolution, cycles, blast radius) run after each edit.
- **Offline activity log.** Every hook event appends to
  `.interlinked/activity.jsonl` synchronously (~0.1 ms).
  `interlinked status`, `activity`, `explain`, and `doctor` read from
  this log.
- **Trigram grep.** Grep calls route through a cached trigram index,
  narrowing candidate files before `rg` runs.

## Quick start

```bash
# In the repo you want to instrument:
interlinked install-hooks --runner claude-code   # or omit --runner to auto-detect
interlinked harness start                        # start the local guard server
interlinked status                               # show what's configured
```

That's it for local use. Run your agent of choice and tool-use events flow
through the harness. Server commands such as `login`, `sync`, `tasks`, and
`inbox` are available when you point the CLI at an Interlinked MCP Server.

### Optional: `/enforce` — turn AGENTS.md prose into deterministic rules

`install-hooks` wires the harness; `interlinked enable` does that *plus* installs
the `/enforce` skill across every detected agent runner (Claude Code, Codex,
Gemini, Copilot, Cursor). Use it when you want the imperatives in your
`AGENTS.md` / `CLAUDE.md` / `.clinerules/` to become rules the harness actually
enforces, instead of prose the model may or may not follow.

```bash
# In the repo you want to instrument:
interlinked enable                                    # installs hooks + /enforce
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
| `interlinked verify` | Run the full quality + structural gate over the current tree |
| `interlinked verify --all-checks` | Deep-audit mode: add advisory smell/taste checks |
| `interlinked mode` | Show or switch enforcement mode |
| `interlinked coverage` | Per-file coverage ratchet (needs a `coverage-summary.json`) |
| `interlinked mutation` | Per-file mutation-score ratchet (needs a Stryker report) |
| `interlinked structure` | Generic artifact structure management (manifests, adoption) |
| `interlinked harness start/stop/status/test` | Manage the harness daemon |
| `interlinked daemons` | List all active harness daemons and their health |
| `interlinked uninstall-hooks` | Remove hooks this CLI installed (manifest-driven) |

Run `interlinked --help` for the full command list, or `interlinked
<command> --help` for per-command flags.

## How it fits together

```
agent (Claude/Copilot/Gemini/Cursor/Codex) ──► interlinked-hook
                                        │
                                        ├─► harness Unix socket
                                        │     └─► guard eval (block/allow) in ~1–5 ms
                                        │     └─► post-edit quality + structural checks
                                        │
                                        └─► .interlinked/activity.jsonl (append, ~0.1 ms)
                                              └─► interlinked {status,activity,explain,doctor}
```

The installed hook invokes the packaged `interlinked-hook` binary. If you
uninstall the CLI, previously installed hook entries fail open until you run
`interlinked uninstall-hooks` or reinstall the package.

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

## Metacoder (per-prompt overlay)

On every `UserPromptSubmit`, the **metacoder** runs a peer of the coding
agent — **Opus 4.7 max-effort** for Claude Code sessions, **GPT-5.5
xhigh** for Codex sessions — that reads your prompt + project
`AGENTS.md` / `CLAUDE.md` and emits a session-scoped overlay of guard
rules. The overlay merges on top of the floor for the lifetime of the
prompt: prompt-specific blocks the floor rules don't know about (e.g.
"this prompt is about payments, so don't touch `src/auth/`"), enforced
the same hard-block way the built-in rules are.

Both transports use **your existing Claude Code / Codex CLI
subscription** (`claude -p` / `codex exec`). No `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` needed.

**Trade-off:** 5–30 s of added latency on every UserPromptSubmit
before the coding agent starts, and ~$0.05–$0.30 of subscription credit
per prompt at the maximum reasoning tier. Fail-open everywhere — if the
subprocess can't reach the subscription (quota hit, CLI not installed,
timeout), the overlay is skipped and the prompt reaches the agent
against floor rules only.

```bash
interlinked metacoder status                          # current state + recent audit
interlinked metacoder disable --reason "burn rate"    # off, audited
interlinked metacoder enable                          # back on
```

Or hand-edit `.interlinked/guard-rules.local.json`:

```json
{ "metacoder": { "enabled": false } }
```

The harness hot-reloads on the next file-watcher tick (~2 s) — no
restart needed. Full design and operational notes:
[docs/design/metacoding-agent-plan.md](./docs/design/metacoding-agent-plan.md).
Per-field config reference:
[docs/generated/configuration.md § Metacoder](./docs/generated/configuration.md#metacoder-per-prompt-overlay).

## Privacy

- Harness decisions and activity capture are local by default. Data leaves
  your machine only when you run server-backed commands such as `login` or
  `sync`, or when you explicitly opt into another remote workflow.
- No telemetry, no analytics, no "phone home" — not even an anonymous
  version-check ping. The CLI makes no outbound network calls on its own.
- Hook events, guard decisions, and quality findings stay in
  `.interlinked/` under the repo root.

## Contributing and reporting issues

- Contribution guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security policy: [SECURITY.md](./SECURITY.md)
- Bug reports and feature requests:
  <https://github.com/QuentinCody/interlinked-cli/issues>

## License

MIT. See [LICENSE](./LICENSE).
