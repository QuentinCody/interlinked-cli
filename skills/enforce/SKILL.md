---
name: enforce
description: "Distill imperative markdown guidance (AGENTS.md, CLAUDE.md, .clinerules/, GEMINI.md, SKILL.md with hard imperatives) into deterministic Interlinked harness hook rules with verbatim source provenance. Invoke as /enforce followed by a local path, directory, GitHub shorthand, or URL — or with no arguments to walk the project. Lexical strength is binding: never/MUST NOT/forbidden distill to block; should not/avoid to ask; should/prefer to advisory; hedged language is skipped. Output goes to .interlinked/distilled-rules.json plus .interlinked/distilled-rules.overrides.json. Lifecycle ops: /enforce list, show, remove, disable, enable, modify, add, reset, --review, --accept. Description-match invocation: make my AGENTS.md enforced, distill rules from this file. Manual invocation only — never auto-fires."
---

# /enforce — Make markdown guidance into enforced harness rules

## Quick start

```
/enforce                              # distill every imperative .md in the project
/enforce AGENTS.md                    # distill just one file
/enforce .claude/skills/tdd/          # distill every .md under a directory
/enforce mattpocock/skills/tdd        # fetch from GitHub (review-mode by default)
/enforce list                         # show what's distilled, grouped by source
/enforce show <id>                    # full detail for one rule
/enforce remove --source <group_id>   # bulk-remove rules from a source
/enforce disable <id>                 # keep on disk but don't enforce
/enforce modify <id> --action ask     # change a single rule's action/severity
/enforce --review                     # distill to a review file; nothing activates yet
/enforce --accept                     # promote a review file to live rules
```

**Manual invocation only.** This skill never auto-fires — not on SessionStart, not on a file-watcher event, not from any hook. The user (or an agent acting on the user's explicit request) types `/enforce ...`. If you are wiring this skill into automation, stop — that violates the design.

**Where output goes.** Live rules: `.interlinked/distilled-rules.json` (pristine, regenerated each run). User mods: `.interlinked/distilled-rules.overrides.json` (removals, disables, modifications — survives re-distillation). The harness watches both files via `watchFile` and reloads automatically within ~2s — there is no `interlinked harness reload` command. If a daemon is in a degraded state and not picking up changes, `interlinked harness restart` is the only recourse.

**Execution order** (distill path; lifecycle verbs jump straight to §14):

1. Pre-flight (§11) → 2. Parse args (§1) → 3. Read overrides (§9) → 4. Read prior `distilled-rules.json` (§3) → 5. Discover / resolve targets (§2) → 6. Read each file once (§3) → 7. Classify paragraphs (§4) → 8. Lexical ladder (§5) → 9. Triggers (§6) → 10. Build rule object (§7) → 11. Apply user modifications (§9) → 12. Resolve conflicts (§10) → 13. Self-checks (§12) → 14. Write output (§8) → 15. Print summary (§13).

---

## Common workflows

### First-time setup on a project

```
/enforce                       # walk the tree, distill what's there, print a report
/enforce list                  # confirm the rule set looks right
                               # harness reloads automatically within ~2s (watchFile)
```

### Adopt a remote skill (review-first)

```
/enforce gh:mattpocock/skills/tdd   # fetched, distilled to review-mode by default
/enforce list                       # inspect what would activate
/enforce --accept                   # promote review → live
```

### A rule is too noisy

```
/enforce show <id>                                       # see what fired and why
/enforce modify <id> --action ask --severity medium      # downgrade
# or, to keep it on disk but stop enforcing entirely:
/enforce disable <id>
```

### Reject a whole source forever

```
/enforce remove --source gh:someone/skills/qa
```

Adds the group to `removed_groups[]`; stays gone across re-distillation. Undo with `/enforce add --source <group_id>`.

### A .md file changed; re-distill

```
/enforce                       # unchanged files skipped via hash; user mods preserved
                               # harness reloads automatically within ~2s
```

### Throw it all away and start fresh

```
rm .interlinked/distilled-rules.json .interlinked/distilled-rules.overrides.json
/enforce
```

---

## What this skill does

Agent-instruction markdown files (AGENTS.md, CLAUDE.md, .clinerules/, .windsurf/rules/, GEMINI.md, etc.) are loaded into the model's context window as hopeful prose. Today the model may or may not follow them. This skill walks the source tree (or just the targets the user named), extracts every concrete imperative from those files, and distills them into typed `GuardRule` entries that the Interlinked harness enforces deterministically at runtime — meaning the agent literally cannot bypass them, regardless of which underlying coding agent is running.

**Distillation, not strict compilation.** The §5 lexical ladder + §6 trigger inference + §12 validation are deterministic — typed inputs, typed outputs, no LLM calls. But §4 paragraph classification (is this prose a hard imperative, soft preference, hedged statement, descriptive context?) requires LLM judgment because there's no formal grammar for "is this an imperative." So the operation is honest extraction-and-codification with provenance, not parser-style mechanical translation. The earlier name "compile" was a generous shorthand; "distill" reflects what's actually happening. The lexical ladder is the deterministic gate: if a paragraph contains no §5 marker, the classifier MUST drop it. The distiller never invents a rule from unmarked prose, and every rule carries a verbatim `source.quote` so the entire pipeline is auditable.

The harness fans rules out across every configured runner via `src/harness/adapters/`. Your job is to produce one canonical artifact at `.interlinked/distilled-rules.json` plus an overrides file at `.interlinked/distilled-rules.overrides.json`. The harness handles distribution.

**Coupling and scope.** This skill produces an artifact whose schema (`GuardRule`, defined at `src/harness/types.ts` in `interlinked-cli`) is Interlinked's. Enforcement at runtime requires a hook engine that understands that schema — Interlinked is the canonical one, and currently the only one expressive enough to encode regex on `tool_input` fields, the six action types, severity, keyword quick-reject, role scoping, and exception patterns. The skill does NOT ship multi-backend adapters (Claude Code permissions, Cursor `.mdc`, Codex deny configs) because every alternative is strictly less expressive — lossy translation creates user confusion ("why doesn't my rule work in X?"). However, distillation itself does not require Interlinked installed: the artifact is a standalone JSON file you can audit, version-control, share, or wire into any compatible engine. See §11 for fallback-mode behavior when `.interlinked/` is missing.

## Invocation patterns (what `/enforce <args>` means)

| Form | Behavior |
|---|---|
| `/enforce` | Walk the whole project — discover all .md files per Step 1, extract from imperative-bearing ones |
| `/enforce AGENTS.md` | Distill only that file |
| `/enforce AGENTS.md CLAUDE.md` | Distill that exact set |
| `/enforce .claude/skills/tdd/` | Distill every .md under the directory |
| `/enforce mattpocock/skills/tdd` | Treat as `gh:mattpocock/skills/tdd` — fetch + distill (review-mode) |
| `/enforce https://raw.githubusercontent.com/.../SKILL.md` | Fetch + distill (review-mode) |
| `/enforce list` | Lifecycle: print rules grouped by source — see §13 |
| `/enforce show <id>` | Lifecycle: full detail for one rule |
| `/enforce remove --source <group_id>` | Lifecycle: bulk-remove from one source |
| `/enforce remove <id>` | Lifecycle: remove a single rule |
| `/enforce disable <id>` | Lifecycle: keep but don't enforce |
| `/enforce enable <id>` | Lifecycle: re-enable |
| `/enforce modify <id> --action ask --severity medium` | Lifecycle: change action/severity |
| `/enforce add --source <group_id>` | Lifecycle: undo a removed group; re-distill to add back |
| `/enforce reset <id>` | Lifecycle: clear all overrides for this rule |
| `/enforce --review` | Distill-then-pause: write to `.interlinked/distilled-rules.review.json`, no activation until accepted |
| `/enforce --accept` | Activate review-mode output |

If the first argument is one of `list`, `show`, `remove`, `disable`, `enable`, `modify`, `add`, `reset`, treat it as a lifecycle verb (jump to §14). Otherwise treat arguments as distill targets.

## Operating principles (NON-NEGOTIABLE)

1. **Manual invocation only.** This skill runs only when the user (or an agent acting on the user's explicit request) types `/enforce ...`. Do not wire it into SessionStart, PreCompact, file watchers, hook events, scheduled jobs, or any other auto-trigger. Surprise enforcement — the model suddenly being unable to do something it could yesterday because a doc changed — is the failure mode this rule prevents.
2. **Verbatim source provenance is required.** Every distilled rule must carry the source file path, line range, and exact verbatim quote. A rule whose `source.quote` does not appear in `source.file` at `source.lines` is hallucination — drop it.
3. **Lexical strength is binding** (see §5 ladder). Don't soften, don't escalate.
4. **Deterministic at evaluation time; semi-deterministic at distill time.** The harness must remain deterministic at runtime — never generate rules that require LLM evaluation to check. The distill step itself is partly LLM-driven (paragraph classification in §4 needs a model to decide "is this prose a hard imperative, soft preference, hedged, or descriptive"), but the lexical ladder (§5) is the deterministic gate: if a paragraph contains no §5 marker, the classifier must drop it. The distiller never invents a rule from unmarked prose. Provenance (§7 `source.quote` verbatim) is what makes the distill-time step auditable rather than opaque.
5. **Default-skip when uncertain.** Far better to skip a borderline imperative than to emit a wrong one.
6. **Never overwrite hand-curated rules.** Output goes only to `.interlinked/distilled-rules.json` and `.interlinked/distilled-rules.overrides.json`. The user's hand-curated rules live in `guard-rules.json` and `guard-rules.local.json`. Never touch those.
7. **Idempotent across runs.** Hash inputs; skip unchanged files; preserve user overrides.
8. **No invention.** If a rule isn't in the source verbatim, it does not exist.

---

## Step 1 — Argument parsing

Parse the invocation arguments. The first arg, if it's one of the lifecycle verbs (`list`, `show`, `remove`, `disable`, `enable`, `modify`, `add`, `reset`), routes to §14. Otherwise:

For each remaining argument, classify it:

| Form | Detection | Resolved as |
|---|---|---|
| Bare name like `AGENTS.md` | exists as file relative to CWD | local file |
| Path with `/` like `.claude/skills/tdd/SKILL.md` | exists as file | local file |
| Directory path like `.claude/skills/tdd/` | exists as dir | walk the dir for `.md` and `.prompt` files |
| Glob like `docs/**/*.md` | contains `*` or `?` | glob expand |
| `<owner>/<repo>` or `<owner>/<repo>/<subpath>` | matches `^[\w.-]+/[\w.-]+(/.+)?$` and not a local path | github shorthand → fetch from `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/<subpath or SKILL.md>` |
| `https://...` or `http://...` | URL prefix | fetch directly |
| `--review`, `--accept`, `--source <x>`, `--action <x>`, `--severity <x>` | flag | parse separately |

Resolution rules:

- For GitHub shorthand: try `<subpath>/SKILL.md`, then `<subpath>` directly, then `<subpath>/AGENTS.md`, in that order.
- For URL or shorthand: only allow hosts in the default allowlist — `github.com`, `raw.githubusercontent.com`, `gitlab.com`. Refuse any other host with a clear error.
- For URL or shorthand: default to `--review` mode (write to `distilled-rules.review.json` instead of `distilled-rules.json`); local paths can distill straight through unless `--review` was passed.
- **For local paths (file or directory): refuse if the resolved absolute path is outside the current repo / project root.** Find the project root by walking CWD upward to the nearest `.git/` (or treat CWD itself as the root if there is no git repo). If the target's resolved absolute path doesn't have that root as a prefix, abort with a clear message: `"<target> is outside the current project (<root>). cd into that project and re-run /enforce."` Reasoning: the artifact + overrides files live under the *target's* `.interlinked/`, the harness running in this session only watches the current project's `.interlinked/`, and writing into a sibling project from this session is the kind of cross-project surprise the skill exists to prevent.
- If no targets resolve, fall back to project walk per Step 2.

Print the resolved target list before doing any work. Form: `Distilling: AGENTS.md, CLAUDE.md, gh:mattpocock/skills/tdd (fetched sha256:abc…)`

---

## Step 2 — Discover sources (no-arg or directory walk)

When no argument is given, walk these locations and record each file's absolute path, kind, and SHA-256 hash.

### 2a — Project tree (CWD upward to git root)

For each ancestor directory from CWD up to the repo root (the directory containing `.git/`), look for:

| Filename / pattern | Kind | Notes |
|---|---|---|
| `AGENTS.override.md` | imperative | Highest project precedence |
| `*.local.md` (e.g. `CLAUDE.local.md`) | imperative | Personal, gitignored, beats shared |
| `AGENTS.md` | imperative | Cross-tool source of truth |
| `AGENT.md` | imperative | Singular variant (Amp/community) |
| `CLAUDE.md` | imperative | Claude Code |
| `GEMINI.md` | imperative | Gemini CLI |
| `WARP.md` | imperative | Warp legacy |
| `.github/copilot-instructions.md` | imperative | Repo-wide Copilot |
| `.github/instructions/*.instructions.md` | imperative | Path-scoped via frontmatter `applyTo` |
| `.cursor/rules/*.mdc` | imperative | Cursor; frontmatter `globs`/`description` is machine-readable |
| `.cursorrules` | imperative | Cursor legacy |
| `.clinerules` | imperative | Cline single-file legacy |
| `.clinerules/*.md` | imperative | Cline modular |
| `.windsurfrules` | imperative | Windsurf legacy |
| `.windsurf/rules/*.md` | imperative | Windsurf modular |
| `.continue/rules/*.md` | imperative | Continue.dev — frontmatter `globs`/`alwaysApply` |
| `.augment/rules/*.md` | imperative | Augment |
| `.tabnine/guidelines/*.md` | imperative | Tabnine |
| `.tabnine/guidelines.md` | imperative | Tabnine single-file |
| `.kilocoderules` | imperative | Kilo Code |
| `.claude/skills/*/SKILL.md` | scan-only | See §2c |
| `.agents/skills/*/SKILL.md` | scan-only | Shared native skill location used by Codex and other runners; see §2c |
| `~/.claude/skills/*/SKILL.md` | scan-only | See §2c |
| `CONVENTIONS.md` | imperative-likely | Aider-style |
| `code_review.md` | imperative-likely | Often referenced from AGENTS.md |
| `CONTRIBUTING.md` | mixed (scan only) | Pull only paragraphs with hard imperatives |
| `SECURITY.md` | mixed (scan only) | Pull only paragraphs with hard imperatives |
| `STYLEGUIDE.md` | mixed (scan only) | Pull only paragraphs with hard imperatives |
| `PLANS.md` | scan only | Mostly procedural |

### 2b — User home (global rules)

Look in `~/.claude/`, `~/.codex/`, `~/.gemini/`, `~/.config/copilot/`, `~/.continue/`, `~/.windsurf/` for the same patterns. Treat global rules as **lower precedence** than project rules unless they appear in `*.override.md` form.

### 2c — Skills as scan-only sources

SKILL.md files are mostly procedural (capability bundles). They are scan-only: extract paragraphs that hit the §4a/§4b lexical markers (`MUST NOT`, `bans`, `forbids`, `never`, `MUST`, `always`); ignore the rest. Every rule from a skill body has its `group_id` formed as `skill:<skill-name>` (extracted from the SKILL.md frontmatter `name` field) instead of `local:` or `gh:`.

**Skill rules ARE scope-gated at runtime** via `active_when.skill`. The harness's `SessionTrajectory.active_skills` map is populated by `interlinked skill enter <name>` (called from a slash-command preamble) and read by the active-when evaluator. A distilled skill rule with `active_when.skill = "<skill-name>"` is **dormant** unless that skill is currently active in the session. This means:

- **Distill at full strength** — a skill imperative phrased `Never X` distills to `action: "block"` per §5a, not the previous safety-downgrade to `ask`. The runtime scope makes the strength safe.
- **Composes with §10 conflict resolution** — scope-disjoint rules don't conflict; importing N skill rules without scope used to yield O(N²) collisions, with `active_when.skill` populated they only collide within the same skill or with always-on rules.
- **Skill-author opt-in cost is one line** — the slash-command preamble adds `interlinked skill enter <skill-name>` (and a matching `leave` on completion). Skills that don't opt in still distill correctly but their rules are always-on (`active_when` omitted), which is the pre-active_when behavior.

See `docs/design/harness-active-when-scoping.md` for the full design and §7 below for distiller population rules.

The `skill:` group_id is also used for lifecycle ops (`/enforce remove --source skill:migrate-to-shoehorn`).

### 2d — Skip list (DO NOT extract from these — confirm kind, then skip)

| File | Why skipped |
|---|---|
| `SOUL.md`, `IDENTITY.md`, `STYLE.md`, `USER.md`, `HERMES.md` | Persona/voice. Not enforceable as hooks. |
| `MEMORY.md` | Memory index; agent's concern, not the harness's. |
| `HEARTBEAT.md`, `BOOTSTRAP.md` | Lifecycle/initialization, not gating. |
| `ARCHITECTURE.md`, `DESIGN.md`, `RUNBOOK.md`, `TESTING.md`, `BUILD.md`, `DEPLOYMENT.md`, `RELEASE.md`, `TROUBLESHOOTING.md`, `CONTEXT.md` | Descriptive context, not imperative. |
| `PRD.md`, `SPEC.md`, `ROADMAP.md`, `TASKS.md`, `TODO.md` | Forward-looking. |
| `README.md` | Human-facing overview. |
| `TOOLS.md` | Tool inventory. |
| `.agent.md`, `.prompt.md`, `*.prompt`, `.github/agents/*.agent.md`, `.github/prompts/*.prompt.md` | Capability bundles — same treatment as SKILL.md per §2c. `*.prompt` covers bare-extension role/capability prompts (e.g. SwarmForge `<role>.prompt`). |
| Any `SKILL.md` whose frontmatter `name` is `enforce` | Self-reference. The distiller must not distill its own imperatives — they describe how to distill, not what the agent should do. Drop the file silently regardless of which install path it lives at (`skills/`, `.claude/skills/`, `.agents/skills/`, `.interlinked/skills/`, `.gemini/skills/`, `.github/skills/`, `.cursor/skills/`, etc.). |
| Any `SKILL.md` whose frontmatter `name` is `tdd`, starts with `tdd-`, or ends with `-tdd`; any path matching `**/tdd/SKILL.md` or `**/*-tdd/SKILL.md` | TDD enforcement is owned by the harness's native primitives — `tdd_new_file_gate`, `tdd_cycle_violation`, `tdd_regression`, `tdd_commit_gate`, `tdd_green_confirmation` — driven by the deterministic `tdd_cycles` state machine in `SessionTrajectory`. Distilling a competing TDD skill (Matt Pocock's, gstack's, anyone else's) would either over-fire (always-on rules duplicating our gates) or shadow (action downgraded to `ask`). Drop these files silently. If a project legitimately needs a different TDD policy, edit `structural_checks.test_first_mode` in `guard-rules.local.json`, not via /enforce. |

After discovery, **print the file inventory** before any extraction so the user can see the surface.

---

## Step 3 — Read each file once

Use the Read tool with the full path. Cache contents. SHA-256 each file.

If `.interlinked/distilled-rules.json` already exists, compare each file's hash to the previous run's `source_hashes` map. **Unchanged files: skip extraction; copy their previous distilled rules verbatim into the new output.** Only re-extract files whose hash changed or which are new.

**Subset distillation preserves other sources.** When the user runs `/enforce <single-target>` (a path, a directory, a remote URL), the distiller MUST merge with the prior `distilled-rules.json`: rules from sources NOT in the current invocation are copied through unchanged, with their original `source_hashes` entries preserved. This is the natural extension of the unchanged-files rule: out-of-scope sources are unchanged by definition. Only `/enforce` (no arg, project walk) is allowed to fully regenerate. If you need a hard rebuild from a subset invocation, the user must `rm .interlinked/distilled-rules.json` first — the §"Throw it all away and start fresh" workflow.

For files with frontmatter, parse it and use machine-readable fields directly:

- **Cursor `.mdc`**: `globs` / `description`
- **Continue `.continue/rules/*.md`**: `globs` / `alwaysApply` / `description`
- **Copilot `.github/instructions/*.instructions.md`**: `applyTo`
- **SKILL.md**: `name` (becomes part of `group_id`), `description`

Frontmatter scope is machine-readable — do not re-extract it from the prose.

---

## Step 4 — Per-paragraph classification

Iterate paragraph-by-paragraph (split on blank lines and heading boundaries). For each paragraph:

| Paragraph kind | Action |
|---|---|
| **Hard imperative** with concrete trigger | extract |
| **Soft preference** (`should`, `prefer`, `usually`) | extract as advisory |
| **Hedged statement** (`we usually try to`, `ideally`, `if possible`) | skip → log to `skipped[]` |
| **Description / context** | skip silently (not imperative) |
| **Narrative / persona** | skip silently (not enforceable) |
| **Procedure / step-by-step** | skip — agent guidance, not gates. Exception: a single step phrased as `you MUST run tests first` extracts as one rule. |
| **Architecture / dependency-graph fact** | skip silently |
| **Forbidden tool / command list** | extract per item |
| **Required tool / command list** | extract as block-on-inverse |

---

## Step 5 — Lexical strength → action ladder (BINDING)

Apply mechanically. Do not adjust. If multiple markers appear in one paragraph, use the strongest.

### 5a — `block` (severity: critical or high)

Lexical markers (case-insensitive unless explicitly ALL CAPS, which strengthens):

- `MUST NOT`, `must never`, `never`, `forbidden`, `prohibited`, `not allowed`, `do not ever`, `may not`, `shall not`, `banned`, `outlawed`, `under no circumstances`, `at no time`, `bans`
- Headers: `CRITICAL:`, `BLOCKING:`, `FATAL:`, `DO NOT:`

**Severity:** `critical` if marker is `CRITICAL`, `MUST NOT`, `never`, `forbidden`, `prohibited`, `shall not`, `under no circumstances`. Otherwise `high`.

### 5b — `block` via positive form (block on inverse trigger)

Positive imperatives with concrete trigger:

- `must`, `MUST`, `required`, `is required`, `is mandatory`, `has to`, `shall`, `always`, `every time`, `before X you must Y`

For these, the trigger fires when the **missing precondition** is detected. Severity: `high`.

If you cannot model the precondition (no observable session state), downgrade to `ask` and note the gap in `distilled_action_reason`.

### 5c — `ask` (severity: medium)

- `should not`, `avoid`, `don't`, `prefer not to`, `try not to`, `discouraged`

The `ask` primitive prompts the user before allowing. It collapses to `deny` on runners that lack confirmation (Copilot CLI, Codex). The harness handles that translation.

### 5d — `advisory` (severity: low; surfaces only under `verify --all-checks`)

- `should`, `prefer`, `usually`, `consider`, `recommend`, `ideally`, `try to`, `encourage`, `we like to`, `aim to`

Distilled as `action: "warn"` with `enabled: true`. The verify pipeline gates these per its own advisory list.

### 5e — SKIP (do not extract)

- `we may`, `we might`, `we sometimes`, `possibly`, `feel free to`, `if you want`, `optionally`, `maybe`
- Any imperative with no concrete trigger (no tool, no file glob, no command regex, no session-state predicate)
- Aspirational language without an observable signal
- Anything where you cannot construct a verbatim source quote

### 5f — Action × trigger compatibility (binding)

`block` and `ask` are decisions made *before* the tool call runs — they require `trigger: "PreToolUse"`. The harness has no post-rule evaluation: a PostToolUse rule cannot block, undo, or ask permission for a write that already happened. So:

| Action | Allowed triggers |
|---|---|
| `block`, `ask`, `soft_block`, `rewrite` | `PreToolUse` only |
| `warn` | `PreToolUse` or `PostToolUse` |

When the imperative's signal is only observable post-write (e.g., scanning produced file content for a pattern), the rule MUST distill as `warn`, not `ask`. Use `PostToolUse` + `warn` for advisories about content that just landed; reserve `ask` for `PreToolUse` checks where the agent can still back out. The trigger cookbook below routes `Don't commit secret Z to source` through PostToolUse + content regex precisely because that's the one place ask-vs-warn doesn't matter — content scanning IS warning, not blocking.

---

## Step 6 — Trigger extraction (real GuardRule schema)

For each imperative, produce the trigger fields. **If you cannot, downgrade to `advisory`** — never emit a `block` or `ask` rule with no observable trigger.

The harness's `GuardRule` shape (from `src/harness/types.ts`):

```ts
interface GuardRule {
  id: string;
  enabled: boolean;
  trigger: "PreToolUse" | "PostToolUse" | "both";
  tool_match: string[];                      // tool names; "*" for all
  action: "block" | "warn" | "rewrite" | "soft_block" | "ask";
  patterns: RulePattern[];                   // see semantics below
  reason: string;                            // shown to the agent
  suggestion?: string;
  severity: "critical" | "high" | "medium" | "low";
  category?: string;
  applies_to_roles?: AgentRole[];
  keywords?: string[];                       // PreToolUse quick-reject tokens
}

interface RulePattern {
  field: string;                             // dot-path into tool_input
  regex: string;
  flags?: string;                            // default "i"
  negate?: boolean;                          // exception when true
}
```

Distilled rules ALSO carry a `source` sidecar field — see §7. The harness ignores unknown fields; the CLI lifecycle ops use them.

### Pattern semantics (binding)

The runtime evaluator splits `patterns[]` by `negate`:

- **Positive patterns (`negate` absent or `false`) — OR.** ANY one positive pattern matching makes the rule fire. With zero positive patterns, the OR is vacuously true: the rule fires whenever its `tool_match` matches.
- **Negated patterns (`negate: true`) — exceptions.** If ANY negated pattern matches, the rule is suppressed for that call.

The combined contract: a rule fires when (at least one positive matches OR there are no positive patterns) AND no negated pattern matches.

Practical consequence: **you cannot AND two positive patterns together.** If your imperative needs both "this file path" AND "this content", encode it as one positive pattern (a regex that captures both signals on one field) plus optional negated exceptions. Don't write the rule as two positive patterns and assume they intersect — that gives you a strict OR. The trigger cookbook below picks the smallest field that captures intent; when in doubt, single-pattern rules are easier to reason about than multi-pattern ones.

### Trigger inference cookbook

| Imperative shape | Distilled fields |
|---|---|
| "Never run X" / "Don't use X" | `trigger: "PreToolUse"`, `tool_match: ["Bash"]`, `patterns: [{ field: "command", regex: "<X>" }]`, `keywords: ["<token>"]` |
| "Don't edit files in path/" | `trigger: "PreToolUse"`, `tool_match: ["Edit","Write","MultiEdit","apply_patch"]`, `patterns: [{ field: "file_path", regex: "<glob-as-regex>" }]` |
| "Always do X before Y" | trigger fires on Y; harness session state required (see ‡) |
| "Use X instead of Y" | `tool_match: ["Bash"]`, `patterns: [{ field: "command", regex: "<Y>" }]`, `suggestion: "use X"` |
| "Don't commit secret Z to source" | `trigger: "PostToolUse"`, `tool_match: ["Edit","Write","MultiEdit","apply_patch"]`, `patterns: [{ field: "content", regex: "<Z>" }]` |
| MCP tool prohibition | `trigger: "PreToolUse"`, `tool_match: ["<exact-mcp-tool-name>"]`, `patterns: []` (exact `tool_match` alone fires the rule via the vacuous-OR; `field: "*"` + `.*` would fail self-check #3) |
| Tool-class prohibition | `tool_match: ["Bash"]`, `keywords: [<token>]`, `patterns: [{ field: "command", regex: "<pattern>" }]` |

‡ Sequential preconditions ("Always X before Y") are not directly representable in `GuardRule`. Emit a Pass 2 `policy.md` entry (see §15.2) where `trigger_signal` describes the precondition in natural language; the Tier 2 LLM gate evaluates it from trajectory. Do NOT downgrade to `ask` in `distilled-rules.json` — `ask` is removed per §15.1 (PreToolUse user-prompts created fatigue; the Tier 2 gate handles the same job without interrupting).

### Pattern hygiene (mandatory)

- Use `\b` word boundaries — never bare `git` (matches `gitlab`, `git-credential`).
- Anchor where it makes sense: `^git\s+push\b`.
- Case-insensitive for SQL keywords: `flags: "i"` on patterns matching `DROP\s+TABLE`.
- Reject any pattern that matches the empty string (`new RegExp(p).test("")`).
- Reject catastrophic-backtracking constructs: `(.*)*`, `(.+)+`, nested unbounded quantifiers.
- For multi-tool rules, list every tool: `tool_match: ["Edit", "Write", "MultiEdit", "apply_patch"]` (`apply_patch` is Codex CLI's edit tool — include it for cross-runner coverage).
- Glob → regex translation: `db/migrations/**` becomes `^db/migrations/.*` (anchored at field start).

---

## Step 6.5 — Use only registered predicates and scope axes

Typed `active_when` axes are conjunctive conditions: a rule applies only when
every declared axis holds. Supported axes are `skill`, `after_command`
(`pattern`, `window_steps`), `file_scope`, `agent_source`, and `overlay`.
Keep the imperative's action; a satisfied precondition does not reverse it.

The runtime registry in `src/harness/evaluator/active-when.ts` currently exposes
one session predicate: `active_agent_count_at_least`, with `args.count`.
Check the current registry before emitting a predicate.

```json
"active_when": {
  "predicate": { "name": "active_agent_count_at_least", "args": { "count": 2 } }
}
```

Do not emit a top-level `session_predicate`. The loader diagnoses that obsolete
field while preserving historical unconditional matching and the operator's enabled
setting. Migrate explicitly to supported typed conditions. Unknown
`active_when.predicate` names remain dormant with a `rule-unavailable` diagnostic;
they do not enforce prose.
In particular, `tests_passed_recently`, `tests_run_in_session`,
`last_command_was`, `file_read_in_session`, `consecutive_failures`, and
`last_event` are not registered predicates.

When no implemented primitive expresses the instruction, retain it as manual
guidance with the missing capability stated explicitly. Do not claim that a
policy entry, an `ask` action, or a dormant rule supplies runtime enforcement.
TDD state remains owned by the harness's native test-first policy.

---

## Step 7 — Build the distilled rule (one entry per imperative)

The distilled rule object is a real `GuardRule` with a `source` sidecar field added. The harness ignores `source`; the CLI uses it for lifecycle operations.

```json
{
  "id": "enforce-<group-stem>-<short-kebab-summary>",
  "enabled": true,
  "trigger": "PreToolUse",
  "tool_match": ["Bash"],
  "action": "block",
  "patterns": [
    { "field": "command", "regex": "^git\\s+push\\b.*\\bmain\\b" }
  ],
  "reason": "BLOCKED by AGENTS.md:42 — \"Never push to main without code review.\"",
  "suggestion": "Open a PR and request review, then merge through the standard flow.",
  "severity": "critical",
  "category": "distilled-from-md",
  "keywords": ["git"],
  "source": {
    "group_id":     "local:AGENTS.md",
    "group_label":  "AGENTS.md",
    "file":         "AGENTS.md",
    "lines":        [42, 42],
    "quote":        "Never push to main without code review.",
    "lexical_marker": "Never",
    "marker_class": "block-direct"
  },
  "distilled_action_reason": "lexical 'Never' → action=block per §5a",
  "confidence": 0.95
}
```

**ID slug rule:** `enforce-<group-stem>-<short-kebab-summary>`. Group-stem is derived from `group_id` (drop scheme prefix, replace `/`/`.`/`:` with `-`, lowercase). Summary is ≤6 words from the imperative's intent, kebab-case.

**`group_id` schemes:**

| Scheme | Format | Example |
|---|---|---|
| `local:` | `local:<path>` — repo-relative when a git root exists, otherwise CWD-relative | `local:AGENTS.md`, `local:.clinerules/style.md` |
| `home:` | `home:<home-relative-path>` | `home:.claude/CLAUDE.md` |
| `gh:` | `gh:<owner>/<repo>/<subpath>` | `gh:mattpocock/skills/tdd` |
| `url:` | `url:<host><path>` | `url:example.com/foo.md` |
| `skill:` | `skill:<skill-name>` (from SKILL.md frontmatter) | `skill:tdd`, `skill:grill-me` |

Skill-sourced rules ALWAYS use the `skill:` scheme; they carry their physical install path in `source.file` but are grouped by skill-name so cross-install moves don't fragment the group.

**`confidence`:** 0.95 for clean direct-prohibition. 0.85 for positive-form. 0.7 for cases where the trigger required interpretation. Below 0.7 → downgrade to advisory.

**`active_when` population (binding):** every distilled rule with a known scope MUST carry an `active_when` field per the table below. Rules from project-wide imperative sources (root CLAUDE.md, AGENTS.md, etc.) omit `active_when` (always-on). Rules from skill bodies, model-overlay files, or path-scoped sources populate it deterministically. Population is purely structural — no LLM judgment.

| Source location | `active_when` populated as |
|---|---|
| `<path>/AGENTS.md`, `<path>/CLAUDE.md`, `<path>/AGENTS.override.md`, `*.local.md`, `.clinerules/`, `.cursor/rules/`, `.continue/rules/`, `.windsurf/rules/`, `.augment/rules/`, `.tabnine/`, `.kilocoderules` | omitted (always-on) — these are the project-wide gates |
| `<skill-name>/SKILL.md` body (any install path) | `{ skill: "<skill-name>" }` — skill-name from frontmatter |
| `model-overlays/<runner>.md` (or any sibling persona-by-runner directory) | `{ overlay: "<runner>" }` |
| `.github/instructions/<file>.instructions.md` with frontmatter `applyTo: "<glob>"` | `{ file_scope: "<glob-as-regex>" }` |
| `.cursor/rules/*.mdc` with frontmatter `globs: [...]` | `{ file_scope: "<joined-globs-as-regex>" }` |
| `.continue/rules/*.md` with frontmatter `alwaysApply: false` + `globs: [...]` | `{ file_scope: "<joined-globs-as-regex>" }` |
| Skill body imperative referencing "after running /<X>" or "after the user invoked X" | merge `{ after_command: { pattern: "^/<X>\\b", window_steps: 20 } }` into the existing scope |
| Skill body imperative referencing TDD state | **not emitted** — TDD is owned by harness primitives; rule is dropped per §2d skip list |

When multiple axes are inferred from one source (e.g., a skill body that also mentions "after /ship"), all axes are AND-ed in `active_when`. The distiller emits the union; `confidence` drops by 0.05 per inferred axis beyond the first.

**`applies_to_roles` population (binding).** A source file is *role-scoped* when its basename is `<role>.prompt` / `<role>.agent.md`, or its body opens with `You are the <role>.`. The harness `AgentRole` type (`src/harness/types.ts`) is exactly `"lead" | "worker" | "subagent" | "unknown"`:

- If `<role>` is one of those four, set `applies_to_roles: ["<role>"]` on every rule distilled from that file.
- If `<role>` is NOT — e.g. a bespoke multi-agent cohort such as SwarmForge's `architect` / `coder` / `refactorer` / `reviewer` / `specifier` — the harness has no axis to scope the rule, so a Pass 1 rule from one role's prompt applies to *every* agent. That is a correctness bug, not noise: `refactorer.prompt`'s "Do not run mutation tests" emitted globally directly contradicts `reviewer.prompt`'s "Run … mutation tests." Such imperatives MUST NOT be written to `distilled-rules.json`. Route them to Pass 2 (`policy.md`) with the role named in `trigger_signal` ("…when the acting agent's role is `refactorer`"); the Tier-2 gate resolves role from trajectory. If Pass 2 is unavailable (local-only mode), log to `skipped.report.md` with skip class `skip-role-unmodellable`. §10 conflict resolution does NOT catch this — only the prohibition carries a lexical marker, so the contradicting permission never distills and no conflict pair forms.

**Schema attribution.** The shape above is the Interlinked harness's `GuardRule`, defined at `src/harness/types.ts` in the `interlinked-cli` package. The four sidecar fields (`source`, `distilled_action_reason`, `confidence`, `user_modified`) are the only additions this skill makes; the harness ignores them at evaluation. The `active_when` field is a real `GuardRule` field (added 2026-04 alongside the active-when scoping work) — the harness reads and evaluates it at runtime via `evaluator/active-when.ts`. Other hook engines that want to consume the same artifact must implement matching evaluation semantics — regex on `tool_input` fields, the six action types (`block` / `warn` / `rewrite` / `soft_block` / `ask` / advisory), severity, keyword quick-reject, role scoping, exception patterns, AND active_when scope evaluation. The skill targets `GuardRule` because it's the most expressive open enforcement primitive today; downgrading to a less-expressive runtime (Claude Code's `permissions.deny[]`, Cursor `.mdc` globs, Codex deny configs) would lose the regex/PostToolUse/severity/active_when dimensions, so this skill does not ship multi-backend adapters. If you want to use the artifact outside Interlinked, write your own evaluator against this schema.

---

## Step 8 — Output schema

Write `.interlinked/distilled-rules.json`:

```json
{
  "version": 1,
  "distilled_at": "2026-04-27T18:30:00Z",
  "distiller": "skill:enforce@1",
  "source_hashes": {
    "AGENTS.md": "sha256:abc123…",
    "CLAUDE.md": "sha256:def456…",
    ".clinerules/style.md": "sha256:789abc…"
  },
  "rules": [ /* distilled rule objects per §7 */ ],
  "skipped": [
    {
      "file": "CLAUDE.md",
      "lines": [78, 80],
      "quote": "We usually try to write tests before code.",
      "reason": "hedged: 'usually try to'",
      "marker_class": "skip-hedged"
    }
  ],
  "conflicts": [
    {
      "id": "enforce-agents-no-force-push",
      "winning_source": "AGENTS.override.md:12",
      "overridden_sources": ["AGENTS.md:42"],
      "resolution": "AGENTS.override.md > AGENTS.md per precedence stack"
    }
  ],
  "removed": [
    {
      "id": "enforce-claude-no-cypress",
      "reason": "source quote no longer present in CLAUDE.md as of 2026-04-27"
    }
  ],
  "stats": {
    "files_scanned": 9,
    "imperatives_found": 28,
    "distilled_block": 12,
    "distilled_ask": 4,
    "distilled_advisory": 7,
    "skipped_hedged": 5,
    "conflicts": 1,
    "removed": 0
  }
}
```

The harness's `rules-loader.ts` reads this file alongside `guard-rules.json` and `guard-rules.local.json` and applies the overrides file (next section). The harness's `watchRulesFiles()` polls both distilled paths every ~2s, so changes are picked up automatically — no manual reload command exists. If the daemon appears stuck, confirm with `interlinked harness status` before guessing: it round-trips the socket and reports `ZOMBIE` when a live PID is answering nothing (the state that looks exactly like "rules stopped reloading"). `.interlinked/daemon-events.jsonl` records why the last daemon left — a pre-listen startup failure exits 78 with `reason: "startup-failed"` — and `.interlinked/logs/daemon.log` holds any crash output. Either way the fix is `interlinked harness restart`.

For `--review` mode: write to `.interlinked/distilled-rules.review.json` instead. The harness does not load `.review.json`; the user must run `/enforce --accept` to promote it.

---

## Step 9 — Overrides file (the user's mods)

`.interlinked/distilled-rules.overrides.json` survives re-distillation:

```json
{
  "version": 1,
  "removed_groups":   ["gh:mattpocock/skills/qa"],
  "removed_rule_ids": ["enforce-claude-no-cypress"],
  "disabled_rule_ids": ["enforce-agents-prefer-named-exports"],
  "modifications": {
    "enforce-skill-tdd-no-bulk-tests": {
      "action":   "ask",
      "severity": "medium",
      "note":     "downgraded — too noisy on legacy tests/ dir"
    }
  }
}
```

The harness applies these on every load. Removed groups stay removed across re-distillation (so deleted things don't whack-a-mole back). Modifications layer on top of the pristine distilled rule.

**On distill, the skill MUST read this file before extracting** and:
- Skip any source whose `group_id` is in `removed_groups[]`. Never even fetch a removed group.
- Skip any rule whose `id` is in `removed_rule_ids[]`. The pristine rule still appears in the output but with `enabled: false` and a note.
- Apply `modifications{}` after distillation and mark those rules with `user_modified: true` for the report.

---

## Step 10 — Conflict resolution

Precedence stack (highest to lowest):

1. `AGENTS.override.md`
2. `*.local.md` (CLAUDE.local.md, etc.)
3. Project rule-folder files (`.claude/rules/`, `.continue/rules/`, `.windsurf/rules/`, `.augment/rules/`, `.clinerules/`, `.cursor/rules/`)
4. `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / `WARP.md`
5. Path-scoped frontmatter files (`.github/instructions/*.instructions.md`)
6. SKILL.md bodies (group_id `skill:<name>`; no runtime scope — collisions are real but resolved by precedence here)
7. `CONTRIBUTING.md` / `SECURITY.md` / `STYLEGUIDE.md` / `CONVENTIONS.md`
8. `~/` global counterparts of any of the above

When two distilled rules collide on `(trigger, tool_match, patterns[].regex)`:

- If actions differ: take the strictest (`block` > `ask` > `soft_block` > `warn`).
- Always merge: keep the higher-precedence source as `winning_source`; record the lower-precedence ones in `overridden_sources[]`.
- Never silently drop the loser — surface in `conflicts[]`.

---

## Step 11 — Pre-flight checks (run BEFORE writing anything)

- `.interlinked/` directory check.
  - **Preferred path** (Interlinked installed): `.interlinked/` exists. Output goes to `.interlinked/distilled-rules.json`; the harness watches the file and picks up changes within ~2s automatically.
  - **Fallback path** (Interlinked not installed): `.interlinked/` is missing. **Warn — do not abort.** Write the artifact to `./distilled-rules.json` next to the user's CWD (the same location for the overrides file: `./distilled-rules.overrides.json`). Print a clear message:

    > No `.interlinked/` directory found. Distilled rules written to `./distilled-rules.json`. To enforce them, install Interlinked (`npm i -g interlinked-cli && interlinked enable`) — Interlinked's harness reads exactly this file from `.interlinked/`. Or wire the JSON into your own hook engine using the `GuardRule` schema documented in §7. Distillation does NOT require Interlinked; enforcement does.

    This separates **producing the artifact** (this skill's scope, no runtime dependency) from **enforcing it** (Interlinked's scope, runtime dependency). Users without the harness still get a tangible, version-controllable, auditable file they can share or migrate later.
- The directory is a git repo. If not, warn but continue — treat CWD itself as the project root for both the §1 outside-CWD check and the §7 `local:<path>` relative-path computation.
- Read `.interlinked/config.json` if present; warn if `version < 2` (distilled rules may not load on older harness builds).
- **Never** write to `.interlinked/guard-rules.json` or `.interlinked/guard-rules.local.json`.
- **Never** modify any source `.md` file. Read-only.
- Output exclusively to `.interlinked/distilled-rules.json` (or `.review.json` in review mode) and `.interlinked/distilled-rules.overrides.json`. In fallback mode, the same names land at `./distilled-rules.json` and `./distilled-rules.overrides.json` at the user's CWD.

---

## Step 12 — Self-checks (run BEFORE writing output)

Run all of these. Abort the write if any fail.

1. Every rule has a non-empty `source.quote` that, when grepped against the source file content (case-sensitive, whitespace-normalized), returns at least one match.
2. Every `block` or `ask` rule has at least one of: a regex on `command`, a regex on `file_path`, a regex on `content`, or an exact `tool_match`.
3. No rule's regex matches the empty string. Test with `new RegExp(pattern).test("")`.
4. No rule's regex contains catastrophic-backtracking constructs.
5. Counts in `stats` match the actual array lengths.
6. JSON validates (no trailing commas, no comments).
7. Total file size <2 MB.
8. Every `id` is unique within the file.
9. Every `id` matches `^enforce-[a-z0-9-]+$`.
10. Every `tool_match` array is non-empty (`["*"]` is OK as catch-all).

If any check fails, abort and report the specific failure with the offending rule ID.

---

## Step 13 — Final summary (REQUIRED, print to user at end of run)

End every run with this tabular summary:

```
Distilled-rules report

Sources scanned     9 files
  imperative-bearing  6
  scan-only           2
  persona/skipped     1

Imperatives found  28

Distilled to:
  block        12 (criticals from MUST NOT / never / forbidden / shall not)
  ask           4 (should not / avoid)
  advisory      7 (should / prefer / consider)

Skipped:
  hedged        5 (we usually try / ideally)
  no trigger    0
  out-of-scope  0

Conflicts        1 (AGENTS.override.md beat AGENTS.md on git-push-main)
Removed          0
User-disabled    0
User-modified    1

Output: .interlinked/distilled-rules.json
Run `/enforce list` to inspect. The harness picks up the new rules within ~2s automatically.

Top distilled rules:
  ✗ enforce-agents-override-no-push-this-week  AGENTS.override.md:12  block
  ✗ enforce-claude-no-prod-deletes              CLAUDE.md:88           block
  ✗ enforce-clinerules-no-cypress               .clinerules/style.md:5 block
  ⚠ enforce-claude-prefer-named-exports         CLAUDE.md:152          advisory
  …
```

For `--review` mode: replace "Output:" with "Review-mode output:" and add: "Run `/enforce --accept` to activate, or edit `.interlinked/distilled-rules.review.json` first."

---

## Step 14 — Lifecycle operations (`/enforce <verb>`)

When the first argument is a lifecycle verb, run that operation instead of distilling.

### `/enforce list`

Read `.interlinked/distilled-rules.json` + `.interlinked/distilled-rules.overrides.json`. Print:

```
Source                                              Rules  Block  Ask  Advisory  Disabled
──────────────────────────────────────────────── ──── ───── ──── ─────── ────────
local:AGENTS.md                                       8      5     1        2          0
local:AGENTS.override.md                              2      2     0        0          0
local:CLAUDE.md                                       5      2     1        2          1
local:.clinerules/style.md                            3      2     0        1          0
gh:mattpocock/skills/tdd                              2      2     0        0          0
skill:tdd                                             2      2     0        0          0
──────────────────────────────────────────────── ──── ───── ──── ─────── ────────
Total                                                22     14     2        6          1

Removed groups: gh:mattpocock/skills/qa  (3 rules suppressed)

Run `/enforce list <group_id>` to drill in.
Run `/enforce remove --source <group_id>` to bulk-remove from a source.
```

### `/enforce list <group_id>`

Drill into a single source:

```
Source: gh:mattpocock/skills/tdd

✗ enforce-skill-tdd-no-bulk-tests              block    high
   Source: gh:mattpocock/skills/tdd:23-25
   Quote : "explicitly bans the horizontal anti-pattern"
   Rule  : trigger=PreToolUse, tool_match=[Edit,Write], patterns=[command~/^...$/]
   Lexical: bans → block-direct

✗ enforce-skill-tdd-test-before-source         block    high
   Source: gh:mattpocock/skills/tdd:30-31
   …
```

### `/enforce show <id>`

Print one rule's full JSON, plus its source-file context (3 lines before, the quote, 3 lines after).

### `/enforce remove --source <group_id>`

Read overrides; add `<group_id>` to `removed_groups[]`. Save. Print: `Removed group <group_id> (N rules suppressed). Run /enforce add --source <group_id> to undo.`

### `/enforce remove <id>`

Read overrides; add `<id>` to `removed_rule_ids[]`. Save. Print confirmation.

### `/enforce disable <id>`

Read overrides; add `<id>` to `disabled_rule_ids[]`. Save. Rule stays in distilled-rules.json but loads with `enabled: false`.

### `/enforce enable <id>`

Read overrides; remove `<id>` from `disabled_rule_ids[]`. Save.

### `/enforce modify <id> --action ask --severity medium`

Read overrides; set `modifications[<id>] = { action: "ask", severity: "medium", note: <user-provided or auto> }`. Save.

Allowed flags: `--action <block|warn|ask|soft_block|rewrite>`, `--severity <critical|high|medium|low>`, `--note <text>`.

### `/enforce add --source <group_id>`

Read overrides; remove `<group_id>` from `removed_groups[]`. Save. Print: `Group restored. Run /enforce <group_id> to re-distill and pull rules from it.`

### `/enforce reset <id>`

Read overrides; clear all entries for `<id>`: remove from `removed_rule_ids`, `disabled_rule_ids`, and `modifications{}`. Save.

### `/enforce --review`

Distill-with-pause: write to `.interlinked/distilled-rules.review.json` instead of `distilled-rules.json`. The harness does not load `.review.json`. Default mode for remote sources.

### `/enforce --accept`

Promote `distilled-rules.review.json` → `distilled-rules.json`. Validate first; abort if validation fails.

---

## Step 15 — Companion artifacts: policy gate + cloud review

Added 2026-05. The single-pass model (every imperative → one GuardRule in
`distilled-rules.json`) was too lossy. Imperatives whose triggers couldn't
be expressed as `tool_input` regex were either downgraded to `ask` (noisy)
or skipped (lost). Skills that are mostly methodology (Matt Pocock's
`improve-codebase-architecture`, most audit-style cybersecurity skills, etc.)
yielded ~5-15% coverage at best.

`/enforce` now runs **three passes** over the same source markdown and emits
artifacts for the three enforcement tiers of the Interlinked architecture:

| Tier | Layer | Consumer | Artifact | Cadence |
|---|---|---|---|---|
| 1 | Local deterministic | Interlinked harness (~sub-10ms) | `distilled-rules.json` | Every tool call |
| 2 | Cloud LLM policy gate | gpt-oss-safeguard-120b (~3-6s) | `policies/<group_id>.policy.md` + Cedar companions | Most tool calls (post-filter) |
| 3 | Cloud architectural review | Sonnet/Opus on staged commits (~30-120s) | `policies/<group_id>.prose.md` | Pre-push / on-demand `/review` / `/security-review` |
| — | Audit | Humans tightening source markdown | `policies/skipped.report.md` | After /enforce runs |

### 15.1 — Three-pass routing (binding)

For each imperative extracted under §4-§6, the distiller routes it to ONE or
MORE of the four artifact families based on trigger shape and FP risk:

| Imperative shape | Pass 1 (deterministic) | Pass 2 (LLM gate) | Pass 3 (prose) | Skipped |
|---|---|---|---|---|
| Concrete regex-shape trigger, low FP | ✓ block/warn | (mirror, for trajectory context) | — | — |
| Concrete trigger + skill-scoped | ✓ block/warn | (mirror) | — | — |
| Concrete trigger + sequential precondition | — | ✓ warn (LLM evaluates trajectory) | — | — |
| Abstract / intent / semantic trigger | — | ✓ block/warn | — | — |
| Quality-of-output rule (vocabulary, required fields) | (optional content regex, FP-prone) | ✓ warn | rationale → prose | — |
| Definition / methodology / principle | — | — | ✓ | — |
| §5e SKIP (hedged, no signal, no imperative) | — | — | — | ✓ |

A single source imperative can route to multiple passes. Example: the
`disk-forensics` "Never modify source evidence" imperative routes to Pass 1
(file_path regex on `*.E01`/etc.) AND Pass 2 (LLM-side mirror for trajectory
context AND the residual intent rule "Never suggest evidence tampering").

**Critical: §6 ‡ ask-downgrade is removed.** Previously, sequential
preconditions ("Always X before Y") downgraded to `action: "ask"` because the
harness couldn't model the precondition. With Tier 2, the LLM evaluates the
precondition from trajectory. Emit a Pass 2 entry instead — no `ask`.

### 15.2 — Pass 2: Policy doc format (`<group_id>.policy.md`)

Markdown with structured per-imperative entries. The Tier 2 LLM loads this
file as system-prompt context when its `active_when` scope matches.

```markdown
# Policy: <group_id>

**Source:** <source file path>
**Active when:** <scope condition>
**Generated by:** `/enforce` Pass 2, <iso date>

## P<n> — <short title>

- **id**: `enforce-<group-stem>-<short-kebab-summary>`
- **severity**: critical | high | medium | low
- **active_when**: <scope axes>
- **action_on_violation**: block | warn
- **trigger_signal**: <natural-language description of what the LLM
   should look for in the current tool call + recent trajectory>
- **source**: <file>:<line range> — "<verbatim quote>"
- **lexical_marker**: <which §5 marker fired>
- **rationale**: <one line — why this lives at Pass 2, not Pass 1>
- **deterministic_companion**: <rule id in distilled-rules.json, or "none">
- **cedar_companion**: <cedar file + clause id, or "none">
- **suggested_remediation**: "<what the agent should do instead>"
```

Per-entry id format matches GuardRule ids: `enforce-<group-stem>-<summary>`.
Action vocabulary is `block` or `warn` only — `ask` is removed (15.1).
PostToolUse warns and PreToolUse blocks are the only two states.

### 15.3 — Pass 2: Cedar transpilation

Two flavors of Cedar emitted per group, both derived from the policy entries
in `<group>.policy.md`:

**`<group>.cedar` — Sondera-compatible** (default; drops into Sondera's
`policies/` directory without modification). Uses only fields in Sondera's
`base.cedarschema`:

- Actions: `ShellCommand`, `ShellCommandOutput`, `FileRead/Write/Edit/Delete`,
   `WebFetch`, `WebFetchOutput`, `Prompt`, `ToolOutput`
- Context fields: `command`, `path`, `operation`, `url`, `signature.*`,
   `policy.*`, `label`, `workspace.*`
- Resource fields: `Trajectory.step_count`, `Trajectory.label`,
   `Trajectory.taints`, `File.label`

**`<group>.interlinked.cedar` — Interlinked-extended** (only emitted when at
least one policy entry needs extensions). Adds:

- `context.skill_active: String` — current skill scope
- `Trajectory.commands_run: Set<String>` — accumulated shell commands
- `Trajectory.files_read: Set<String>` — accumulated file reads
- `@action_on_violation("warn"|"block")` annotation (extends Cedar's
   binary permit/forbid)
- `@requires_extension("<feature>")` annotation (engines without the
   extension must reject the file)

See `docs/design/interlinked-cedar-extensions.cedarschema` for the full
schema delta.

**Regex → `like` translation.** Cedar `like` is glob-only, not regex. The
distiller best-effort expands:

- `^pattern$` → `pattern` (Cedar `like` is implicitly anchored if no `*`)
- `\bword\b` → `* word *` and `word *` and `* word` (drops boundary precision)
- Negative lookahead → ANDed `like` exclusions (loses some precision)
- Character classes → enumerated alternations (e.g., `[ab]` → `*a*` || `*b*`)
- `+` / `?` quantifiers → drop (covered by `*`)

When translation is lossy, emit the policy with `@confidence("approximate")`
and rely on `distilled-rules.json`'s actual-regex GuardRule as the precise
floor. The Cedar version is for portability + Sondera compatibility.

When translation is impossible (e.g., trajectory state references on Sondera
side), emit a comment block in the `.cedar` file explaining why and pointing
to the `.interlinked.cedar` or `.policy.md` companion.

### 15.4 — Pass 3: Prose artifact format (`<group_id>.prose.md`)

Pass 3 captures imperatives that aren't gates at all — definitions,
methodologies, principles — but that should inform the **after-the-fact
review** of staged commits by the Tier 3 cloud agent.

Tier 3 has wider scope than Tier 2: it sees the full repo, the staged
commits, the agent's session log, and the prose artifacts for every skill
that was active during the session. It evaluates the staged work against
the principles in `prose.md` using full context.

```markdown
# Prose policies: <group_id>

This file is consumed by the Tier 3 cloud review agent (pre-push, /review,
/security-review). The agent evaluates staged commits against these
principles using full repo context — NOT single-tool-call trajectory.

## Definitions (canonical vocabulary)

<verbatim definitions from the source markdown, e.g. LANGUAGE.md "Terms"
section. Used so the Tier 3 agent uses consistent vocabulary in its review.>

## Principles

### <principle name>

<verbatim principle text from source>

**Tier 3 evaluation:** <natural-language guidance for the cloud agent on
how to evaluate the staged work against this principle. E.g., "For each
new or significantly-modified module in the staged commits, apply the
deletion test. Flag any module where deletion would not concentrate
complexity.">

## Methodology checkpoints

<numbered list of per-commit / per-session questions the Tier 3 agent asks.
E.g., "Did the agent follow the Explore → Present → Grilling flow? Look
for evidence of subagent_type=Explore invocations in the session log.">

## Source

<full verbatim source markdown for traceability>
```

Pass 3 entries are **not enforced at edit time**. They're context for
the cloud reviewer. The distiller never blocks or warns on Pass 3 content.

### 15.5 — Skipped report (`skipped.report.md`)

Anything that didn't route to any of Passes 1-3. One file shared across
all groups distilled in a run. Format per existing §8 `skipped[]` array,
serialized as Markdown:

```markdown
# Skipped imperatives — <iso date>

## <group_id>

### L<n> — "<quote>"

- **Lexical marker:** <marker or "none">
- **Skip class:** `skip-hedged` | `skip-no-trigger` | `skip-abstract-trigger`
   | `skip-no-imperative` | `skip-out-of-scope` | `skip-role-unmodellable`
- **Skip reason:** <one line>
- **Could be enforced if:** <suggested rewrite of source for the user>
```

Use this report to tighten source markdown — adding a concrete trigger or
stronger lexical marker would move an entry into one of the enforced passes.

### 15.6 — Local-only mode (no cloud Tier 2 or Tier 3)

For users who never touch our cloud or self-host Sondera:

| Artifact | Local-only role |
|---|---|
| `distilled-rules.json` | Tier 1 floor — works as today, deterministic enforcement |
| `policy.md` | Loaded into agent context (advisory, not enforced) |
| `.cedar` (Sondera-compatible) | Drop into self-hosted Sondera installation |
| `.interlinked.cedar` | Inactive unless the Interlinked harness adds Cedar evaluation in v1.1+ |
| `prose.md` | Loaded into agent context (definitions, principles) |
| `skipped.report.md` | Human audit, identical to cloud mode |

The deterministic floor + advisory loading covers ~30-40% of what cloud
adds. Cloud unlocks the LLM-evaluable trajectory rules (Pass 2) and the
wide-scope after-the-fact review (Pass 3).

### 15.7 — Updated §6 ‡ (binding)

§6 ‡ previously read: *"Sequential preconditions (Always X before Y) are
not directly representable in `GuardRule`. Distill to a single PreToolUse
rule on Y with `severity: "medium"` and `action: "ask"`."*

This is **removed**. New rule:

- Sequential preconditions distill to a Pass 2 `policy.md` entry, not a
   Pass 1 `ask` rule.
- The policy entry's `trigger_signal` describes the precondition in
   natural language; the Tier 2 LLM evaluates from trajectory.
- For local-only users (no Tier 2), the policy entry loads as agent
   context — advisory, not enforced. This is strictly weaker than `ask`
   was, but the FP cost of `ask` (user fatigue) outweighed the benefit.

The trigger cookbook in §6 stays. Just the ‡ footnote is rewritten:

> ‡ Sequential preconditions ("Always X before Y") are not directly
> representable in `GuardRule`. Emit a Pass 2 `policy.md` entry where
> `trigger_signal` describes the precondition. The Tier 2 LLM gate
> evaluates from trajectory.

### 15.8 — Stats update for §13 summary

The §13 final-summary table grows by one section to reflect three-pass
routing:

```
Distilled to:
  Pass 1 — deterministic   12  (block/warn in distilled-rules.json)
  Pass 2 — LLM policy gate  8  (block/warn in <group>.policy.md)
   ├── Sondera-compat .cedar  5  (translates to vanilla Cedar)
   └── Interlinked .cedar      3  (requires schema extensions)
  Pass 3 — prose for review  4  (definitions / principles for Tier 3)
  Skipped                     5  (hedged / no trigger / not imperative)
```

### 15.9 — Output schema additions

The existing `distilled-rules.json` v1 schema (§8) gains an optional
`companions` sidecar on each rule, naming its Pass 2 / Pass 3 siblings:

```json
"companions": {
   "policy_md": ".interlinked/policies/<group_id>.policy.md#<entry_id>",
   "cedar":     ".interlinked/policies/<group_id>.cedar#<clause_id>",
   "interlinked_cedar": ".interlinked/policies/<group_id>.interlinked.cedar#<clause_id>",
   "prose_md":  ".interlinked/policies/<group_id>.prose.md#<section_anchor>"
}
```

And new top-level keys:

```json
"policies_emitted": [".interlinked/policies/<group_id>.policy.md", ...],
"prose_emitted":    [".interlinked/policies/<group_id>.prose.md", ...],
```

Schema version stays at 1 — additions are backward-compatible (existing
consumers ignore unknown fields).

### 15.10 — Pre-flight additions for §11

When emitting Pass 2 or Pass 3 artifacts, ensure `.interlinked/policies/`
exists. Create it on first emission. Never overwrite a `.local.cedar`
file the user has hand-authored — these are the user's extension layer
and live alongside generated `.cedar` files.

In fallback mode (no `.interlinked/` directory), Pass 2/3 artifacts land
at `./policies/<group_id>.{policy.md,cedar,interlinked.cedar,prose.md}` at
the user's CWD. Same fallback message as §11 for `distilled-rules.json`.

### 15.11 — Worked example

See `docs/examples/policies/disk-forensics/` for a complete worked
example: one source SKILL.md, three deterministic rules, five policy
entries (3 mirror + 2 LLM-only), 2 Cedar files (Sondera + Interlinked),
and a skipped report. The example also demonstrates the Pass 3 prose
output for the skill's "Evidence Handling Principles" methodology
section.

---

## Worked examples (apply these patterns mechanically)

### Example 1 — Direct prohibition

**Source (AGENTS.md:42):** "Never push to main without code review."

```json
{
  "id": "enforce-local-agents-md-no-push-main",
  "enabled": true,
  "trigger": "PreToolUse",
  "tool_match": ["Bash"],
  "action": "block",
  "patterns": [{ "field": "command", "regex": "^git\\s+push\\b.*\\bmain\\b" }],
  "reason": "BLOCKED by AGENTS.md:42 — \"Never push to main without code review.\"",
  "severity": "critical",
  "category": "distilled-from-md",
  "keywords": ["git"],
  "source": {
    "group_id": "local:AGENTS.md",
    "group_label": "AGENTS.md",
    "file": "AGENTS.md",
    "lines": [42, 42],
    "quote": "Never push to main without code review.",
    "lexical_marker": "Never",
    "marker_class": "block-direct"
  }
}
```

### Example 2 — Positive imperative downgraded to ask (no session-state primitive)

**Source (CLAUDE.md:88):** "Always run `npm test` before committing."

```json
{
  "id": "enforce-local-claude-md-test-before-commit",
  "enabled": true,
  "trigger": "PreToolUse",
  "tool_match": ["Bash"],
  "action": "ask",
  "patterns": [{ "field": "command", "regex": "^git\\s+commit\\b" }],
  "reason": "CLAUDE.md:88 — \"Always run `npm test` before committing.\" The harness can't verify a recent test run; please confirm.",
  "severity": "medium",
  "category": "distilled-from-md",
  "keywords": ["git"],
  "source": { ... "lexical_marker": "Always", "marker_class": "block-positive" },
  "distilled_action_reason": "positive imperative, no session-state primitive → downgraded block→ask"
}
```

### Example 3 — Path-scoped block

**Source (.clinerules/style.md:5):** "MUST NOT edit files under `db/migrations/` directly."

```json
{
  "id": "enforce-local-clinerules-style-md-no-direct-migrations",
  "enabled": true,
  "trigger": "PreToolUse",
  "tool_match": ["Edit", "Write", "MultiEdit", "apply_patch"],
  "action": "block",
  "patterns": [{ "field": "file_path", "regex": "(^|/)db/migrations/" }],
  "reason": "BLOCKED by .clinerules/style.md:5 — \"MUST NOT edit files under db/migrations/ directly.\"",
  "suggestion": "Use `npm run migrate:create` instead.",
  "severity": "critical",
  "category": "distilled-from-md",
  "source": { ... "lexical_marker": "MUST NOT", "marker_class": "block-direct" }
}
```

### Example 4 — Soft preference → advisory (`warn`)

**Source (CLAUDE.md:152):** "Prefer named exports over default exports for new modules."

```json
{
  "id": "enforce-local-claude-md-prefer-named-exports",
  "enabled": true,
  "trigger": "PostToolUse",
  "tool_match": ["Edit", "Write", "MultiEdit", "apply_patch"],
  "action": "warn",
  "patterns": [
    { "field": "content", "regex": "^export\\s+default\\b", "flags": "m" }
  ],
  "reason": "CLAUDE.md:152 prefers named exports over default exports.",
  "severity": "low",
  "category": "distilled-from-md",
  "source": { ... "lexical_marker": "Prefer", "marker_class": "advisory" }
}
```

Note: an earlier draft of this example carried a second positive pattern on `file_path` (`\.tsx?$`) intended as an AND-style scope filter. Per §6 "Pattern semantics", positive patterns OR — that filter would have made the rule fire on every `.tsx` edit regardless of content. Single-pattern advisory rules are usually right; the verify pipeline gates noisy advisories at the report layer, not the rule layer.

### Example 5 — Hedged → SKIP

**Source (CLAUDE.md:201):** "We usually try to keep PRs small."

→ Skipped entry only:
```json
{ "file": "CLAUDE.md", "lines": [201, 201], "quote": "We usually try to keep PRs small.", "reason": "hedged: 'usually try to'", "marker_class": "skip-hedged" }
```

### Example 6 — MCP tool prohibition

**Source (AGENTS.md:71):** "Never use the `railway-mcp__volumeDelete` tool from agent sessions."

```json
{
  "id": "enforce-local-agents-md-no-railway-volume-delete",
  "enabled": true,
  "trigger": "PreToolUse",
  "tool_match": ["railway-mcp__volumeDelete"],
  "action": "block",
  "patterns": [],
  "reason": "BLOCKED by AGENTS.md:71 — \"Never use railway-mcp__volumeDelete from agent sessions.\"",
  "severity": "critical",
  "category": "distilled-from-md",
  "source": { ... "marker_class": "block-direct" }
}
```

### Example 7 — Skill-sourced rule with active_when scope

**Source (`.claude/skills/migrate-to-shoehorn/SKILL.md:12`):** "**Test code only.** Never use shoehorn in production code."

```json
{
  "id": "enforce-skill-migrate-to-shoehorn-no-prod-shoehorn",
  "enabled": true,
  "trigger": "PreToolUse",
  "tool_match": ["Edit", "Write", "MultiEdit", "apply_patch"],
  "action": "block",
  "patterns": [
    { "field": "content", "regex": "from\\s+[\"']@total-typescript/shoehorn[\"']" },
    { "field": "file_path", "regex": "\\.test\\.|\\.spec\\.|/__tests__/|/__fixtures__/", "negate": true }
  ],
  "reason": "BLOCKED by migrate-to-shoehorn skill: shoehorn is a test-only library — never import it from production code paths.",
  "severity": "high",
  "category": "distilled-from-md",
  "active_when": {
    "skill": "migrate-to-shoehorn"
  },
  "source": {
    "group_id": "skill:migrate-to-shoehorn",
    "group_label": "skill:migrate-to-shoehorn",
    "file": ".claude/skills/migrate-to-shoehorn/SKILL.md",
    "lines": [12, 12],
    "quote": "Never use shoehorn in production code.",
    "lexical_marker": "Never",
    "marker_class": "block-direct"
  },
  "distilled_action_reason": "lexical 'Never' + concrete content+file_path triggers (positive on import line, negate on test paths) → action=block per §5a; scope-gated to skill:migrate-to-shoehorn per §7 active_when population — rule is dormant until `interlinked skill enter migrate-to-shoehorn` fires"
}
```

Three things to notice about this example:

1. **`active_when.skill` is populated automatically** because the source is `<skill-name>/SKILL.md`. The distiller doesn't ask; per §7's source-location table, every skill body rule gets `active_when.skill = "<skill-name>"`.
2. **Action stays `block`, not downgraded to `ask`**. With pre-active-when distillation, skill rules had to soften because they were always-on and would over-fire outside their domain. With scope, full-strength enforcement is safe — the rule simply doesn't fire when the skill isn't active.
3. **The skill author still has to opt in.** A user running this skill must include `interlinked skill enter migrate-to-shoehorn` in the slash-command preamble (and `leave` on completion). Skills that don't opt in distill correctly but their `active_when.skill` marker is never set, so the rule stays dormant. This is intentional — it makes activation explicit.

Note: TDD-themed skills (Matt Pocock's `tdd/SKILL.md`, gstack's TDD prose, etc.) are **not** distilled by /enforce — see §2d skip list. TDD enforcement is owned by the harness's native primitives. This example uses a non-TDD skill so the worked example doesn't conflict with that policy.

### Example 8 — Conflict between AGENTS.override.md and AGENTS.md

**`AGENTS.md:42`:** "Never push to main without code review."
**`AGENTS.override.md:12`:** "MUST NOT push to ANY remote branch this week — release freeze."

The override is strictly broader. Output:
- `rules[]` contains the override-derived rule with `tool_match=["Bash"]` + `command~/^git\s+push\b/`.
- The narrower AGENTS.md rule is suppressed.
- `conflicts[]` records `winning_source: "AGENTS.override.md:12"`, `overridden_sources: ["AGENTS.md:42"]`.

---

## Failure modes to guard against

| Failure | Detection | Fix |
|---|---|---|
| Hallucinated rule | `source.quote` does not appear verbatim in `source.file` | Drop the rule; log to `extraction_errors[]`. |
| Hedged distilled to block | marker is `usually`/`prefer`/`try` but `action=block` | Re-classify per §5. |
| Trigger too broad | regex is `.*` with no anchors | Reject; downgrade to advisory. |
| Trigger too narrow | matches only literal command without escaping | Add `\b` boundaries. |
| Persona file got distilled | source path matches §2d skip list | Drop everything from that file. |
| Same imperative in two files | both distilled with same trigger | Merge per §10. |
| Out-of-date previous distillation | source hash mismatch | Re-extract that file; preserve unchanged. |
| User-removed group reappeared | overrides not applied | Always read overrides BEFORE extracting. |
| Catastrophic-backtracking regex | nested unbounded quantifiers | Reject; rewrite. |
| Empty-matching regex | `new RegExp(p).test("")` is true | Reject; rewrite. |
| Remote URL not on allowlist | host not github.com / raw.githubusercontent.com / gitlab.com | Refuse with clear error. |

---

## What this skill does NOT do

- Does not distill from `IDENTITY.md`, `SOUL.md`, `STYLE.md`, `MEMORY.md`, `HEARTBEAT.md`, or any other persona/memory/architecture file.
- Does not write to `.interlinked/guard-rules.json` or `.interlinked/guard-rules.local.json`.
- Does not modify any source `.md` file. Reading only.
- Does not call out to a network LLM at runtime — extraction happens in this skill invocation only.
- Does not generate trajectory checks for vague preconditions.
- Does not invent rules.
- Does not write per-runner hook config files. The harness fans rules across runners via `src/harness/adapters/`.

---

## Cross-runner applicability

The harness fans rules out across every configured coding agent (Claude Code, Codex, Copilot CLI, Cursor, Gemini CLI) through `src/harness/adapters/`. One `distilled-rules.json` produces enforcement across all of them. Do not write per-runner variants. The runner-specific decision primitives (`ask` vs `deny` vs `block` vs `ctx` vs `stderr`) are translated by the adapter layer.

If the user wants per-runner overrides ("only enforce this in Codex, not Claude"), use the optional `applies_to_runners` field on the distilled rule. Otherwise, omit it (applies to all).

---

## Final reminders (read before writing output)

- Verbatim source quotes are non-negotiable.
- Lexical strength is binding (§5 ladder).
- `never` / `MUST NOT` / `forbidden` / `shall not` → **block**, no exceptions.
- `active_when` population is binding (§7 source-location table). Skill-body rules ALWAYS carry `active_when.skill = "<skill-name>"`. Project-wide rules (CLAUDE.md, AGENTS.md, etc.) ALWAYS omit `active_when` (always-on). Skip is always safer than mis-scoping.
- TDD-themed skills are skipped (§2d). Don't distill them — TDD enforcement is owned by harness primitives.
- Skip is always safer than mis-distill.
- Output goes only to `.interlinked/distilled-rules.json` (or `.review.json`) and `.interlinked/distilled-rules.overrides.json`.
- Read the overrides file BEFORE extracting; honor `removed_groups`, `removed_rule_ids`, `disabled_rule_ids`, and `modifications`.
- End every run with the §13 summary table.
- Every rule has provenance, or it doesn't exist.
