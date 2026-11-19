# Interlinked CLI: agent guide

Loaded every turn by every coding agent (Claude Code through `CLAUDE.md`, Codex
directly). Keep it under 200 lines: rules only, no dates, status labels, counts,
or history. Subtree rules live in `.claude/rules/*.md` (Claude loads them when a
matching file is touched; other runners: read the matching rule file before you
edit a subtree). Procedures live in `skills/*/SKILL.md`, history in `docs/`.

## What this is for

Interlinked is a portable, per-tool-call quality and security standard for
agent-written code. A local daemon (`src/harness/`) judges each tool call over a
Unix socket: PreToolUse returns block/allow, PostToolUse returns warnings, Stop
returns reflection nudges; every event is appended to JSONL under
`.interlinked/`. Offline-first, one required dependency (`commander`). Goals, in
priority order: judge code at the moment it is written in ANY codebase (this repo
is an unrepresentative fixture); ratchet the quality of whatever codebase it runs
in, diff-scoped by default; catch each problem at the earliest phase its evidence
exists; double as a step-level training signal for other agents.

Consequences that bind every change to a check, gate, or threshold:

- **Fire rate measures the AGENT, not the check.** A check that never fires here
  is the part of the standard this agent already clears. Never retire or demote a
  check for being quiet.
- **Never calibrate a threshold against this repo alone, nor against fixtures.**
  Calibrate against real trees.
- **Blocking and scoring have different precision bars.** `pre_block` is reserved
  for fully deterministic, zero-false-positive errors; everything else warns or
  scores, tagged `[proven]` or `[heuristic]`.
- **More checks are a cost**, and gates will be Goodharted once they are a
  training signal; the gated agent can write the water-lines it is judged by.
- **Checks are deterministic.** No model sits in the check pipeline or in
  `interlinked verify`. Jev / Haiku signals are opt-in, warn-only, fail-open, and
  only rank or propose.
- **Registry-wide rework waits** until the harness has run against a genuinely
  different codebase; the vision is validated at N=1.

The remote "Interlinked MCP Server" surface (`src/lib/api-client.ts`, server-backed
commands, event sync) is dormant and not the system of record; the local harness is
the product. Leave it alone unless the task is about it.

## Layout and commands

`src/commands/` (CLI, `commander`, shared logic in `src/lib/`), `src/harness/`
(daemon: `server.ts`, `evaluator/`, `checks/<family>.ts` + `check-registry/` +
`check-metadata.ts`, `quality-checks/`, `project-e2e/`, `kill-proof/`),
`skills/*/SKILL.md` (procedures; `interlinked/` is the router), `docs/harness.md`
and `docs/generated/` (reference), `.interlinked/` (runtime data and baselines;
`INDEX.md` is the catalog).

```bash
npm run build | typecheck | test     # tsup → dist/ · tsgo --noEmit · vitest (background the full suite)
npx vitest run <file>                # one file
npx tsx src/index.ts <cmd>           # CLI from source
interlinked harness status|restart   # daemon pid + rules; restart rebuilds a stale dist/
interlinked verify [--all-checks]    # default set must run clean; --all-checks adds advisory
interlinked query <source> --since 7d --where k=v   # bounded reads of .interlinked/
npm run docs && npm run docs:build   # regenerate reference docs + gen-markered counts (CI: docs:check)
```

## Working rules

**Edits.** Change code files only with Edit/Write (bash redirects into code files
are blocked); prefer Edit over Write; land a same-file change as one coherent
patch; several tool calls in one message are not a transaction. Write the
companion test before a new source file. Keep unfiltered `cat`/`head`/`tail`
reads bounded; the gate caps them. Verify after substantive edits (about one
typecheck/test/build run per code edit; the Stop nudge fires far below that).
Fix pre-existing issues in files you touch. Extract helpers for responsibility,
never to dodge a per-call metric.

**Git.** Never commit or push unless the user asks in the current turn. Commit
subjects are conventional (`feat:`, `fix:`, `refactor:`), short, imperative.
Background `git push`; its pre-push gates run for minutes.

**Scratch.** Temporary agent-authored code goes in `<repo>/scratch/`
(`interlinked scratch init`), never the host scratchpad; the guard blocks and
redirects. Secrets never go to any temp path. A hand-rolled patch applier is
blocked everywhere. Before long work, keep a numbered plan with a status column
in `scratch/CAMPAIGN-<topic>.md`.

**Data.** Query `.interlinked/` before raw transcripts. Never full-read
`collection.jsonl`, `activity.jsonl`, or `timeline.jsonl` (hundreds of MB);
use `interlinked query` or `tail -n`.

**A blocked edit is a stale-daemon suspect first.** The daemon serves the build
it started with; editing `src/` changes nothing until a rebuild. Check with
`interlinked harness status`; fix with `interlinked harness restart` (rebuilds a
stale `dist/`). Daemons also hand over to a newer settled build on their own
within about a minute. `npm run build:e2e` overwrites `dist/` with the e2e build:
run `npm run build` after the e2e lane. After editing an e2e boundary file, run
`npm run build:e2e && npm run test:e2e`; the Stop reminder for it reaches no model.
After a completed change to agent-facing daemon behavior passes its relevant tests,
rebuild/reload with `interlinked harness restart` and confirm a responding, current
build with `interlinked harness status`. Do this at each such milestone, not only
at the end of a campaign; untested intermediate edits are not reload milestones.

**Keep cwd at the repo root.** The hook resolves its project by walking up to
the nearest `.interlinked/` that holds a project marker; a stray `.interlinked/`
under `scratch/` or `src/` cold-allows every call made from below it. Delete
strays; `interlinked harness calls` lists unjudged calls.

**A dry run must not move the gate.** `interlinked harness test --write/--edit`
sets `dry_run: true`; every evaluator that persists must honor `event.dry_run`.

**Human-only actions.** Package approval (`interlinked allowlist add`, `--force`,
`INTERLINKED_DISABLE_PACKAGE_GUARD`), water-line resets
(`INTERLINKED_DISABLE_BASELINE_GUARD`), and `harness taint clear` are the
operator's calls; ask, do not run them.

**Skill impact.** A change to a CLI command, option, output, harness policy,
config schema or default, or baseline semantics updates every affected
`skills/*/SKILL.md` (and the router) in the same change, or states why none is
affected. `.claude/skills/` and `.agents/skills/` are installed copies.

**Privacy.** `docs/design`, `docs/plans`, `docs/external-pulse`,
`docs/codex-reviews`, marketing and upstream-bug notes are real files here but
gitignored from the public repo (operator overlay git-dir); `.ignore` negations
keep them searchable. Competitive, strategy, and unfixed-gap analyses never go in
tracked files. Before "what can we do with X?" about an external tool or paper,
fill `docs/external-pulse/INTAKE.md`.

**Style.** TypeScript ESM strict; tabs (the biome formatter is off); double
quotes, semicolons; kebab-case files, `camelCase` functions, `PascalCase` types.
Commands support `--json | --short | --full` via `getOutputMode` + `output(...)`,
degrade to local on server failure (`Promise.allSettled`), and take
`--dry-run` / `--force` when they mutate. The generated hook program stays
self-contained (no imports from the CLI package).

## Gates you will meet

Values live in `.interlinked/metric-caps.json`, the baselines beside it, and
`interlinked caps status`; never in prose. The block message names the fix.

- **Water-lines only tighten.** `evaluator/baseline-integrity-gate.ts` BLOCKS an
  edit that loosens any baseline JSON under `.interlinked/` (coverage, mutation,
  line cap, untested files, metric caps, complexity ledger, lint, skipped tests),
  a tsconfig strictness flag, or a vitest `coverage.include/exclude` array. Meet
  the bar instead. The ratchets' own raises use internal `fs` writes.
- **Cyclomatic, cognitive, coverage, CRAP.** A new over-cap function, over-cap
  growth, an uncovered added line, or a per-file coverage drop blocks; holding or
  shrinking existing debt never does (the ledger, written only by
  `interlinked caps ratchet`, records what may hold). The block carries a
  `↳ plan:` line. Unknown coverage is not 0%.
- **Line cap is advisory.** Growing a hand-written module past
  <!-- gen:line_cap -->500<!-- /gen:line_cap --> lines warns; it never blocks.
  `DEFAULT_MAX_LINES` and the baseline's `max_lines` are pinned equal, so ratchet
  both. Codegen data is exempt via a `@codegen-data` header; the grandfather list
  is empty. When a parent is over cap, helpers go to a NEW sibling module
  (companion test, module, then the parent import).
- **Checks.** `pre_block` findings are introduced-only (`pre-block-gate.ts`);
  pre-existing ones warn. Suppress with `// interlinked-ignore: <check> — reason`
  or `.interlinked/verify-suppressions.json`; a suppression comment without a
  reason is its own loud warning. Built-in guard rules cannot be modified, only
  disabled via `disabled_rules` in `.interlinked/guard-rules.local.json`.
- **Supply chain.** Package installs are default-deny across shell, manifest
  edits, and the cold path; grants live in `.interlinked/package-allowlist.json`.
  URL/tarball/`file:` specs and custom registries are blocked unconditionally.

## Adding or changing a check

Detector in `src/harness/checks/<family>.ts` (never the `generic-checks.ts`
barrel), registry entry in `check-registry/entries-*.ts`, metadata in
`check-metadata.ts`, labeled MUST-FIRE / MUST-NOT-FIRE cases per the Check
Evidence Contract (`src/harness/check-evidence/`; no grandfathering for new
checks). Low-FP and catches real bugs: default gate. Heuristic: add to
`DEFAULT_ADVISORY_SKIPS` in `src/commands/verify/advisory.ts` with a rationale
and update its regression test. Noisy in production: refine the detector before
demoting it; measure precision with an independent census, never the builder's
sample. Fix a review bug once, then ship the check that catches the class.
Procedure: `.claude/rules/checks.md`.

## Where the detail lives

| Topic | Read |
|---|---|
| guard blocks, verify, ratchets, setup, supply chain, data | `skills/interlinked-*/SKILL.md` (router: `skills/interlinked/SKILL.md`) |
| harness internals, file reference, guard flow | `docs/harness.md` |
| project e2e; mutation-grounded test proof | `docs/project-e2e.md`; `docs/mutation-grounded-test-proof.md` |
| review logs, campaigns, measured results | `docs/reviews/`, `docs/campaigns/`, `docs/design/` |
| instruction packets (`interlinked packets compile\|status\|calibrate\|budget\|release\|restore`; default OFF; release only at warn/cosign) | `docs/design/instruction-jev-evaluator.md`; `.claude/rules/packets.md` |
| subtree invariants (load on demand) | `.claude/rules/{checks,quality-checks,evaluator,project-e2e,kill-proof,shadow-protocol,viz,packets}.md` |
