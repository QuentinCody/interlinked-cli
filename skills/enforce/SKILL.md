---
name: enforce
description: "Distill imperative guidance in AGENTS.md, CLAUDE.md, .clinerules/, GEMINI.md, or SKILL.md into deterministic Interlinked guard rules with verbatim source provenance. Invoke as /enforce [path | dir | owner/repo/path | URL], or with no argument to walk the project. Lifecycle: /enforce list|show|remove|disable|enable|modify|add|reset|--review|--accept. Use for: make my AGENTS.md enforced, distill rules from this file. Strength is binding: never/MUST NOT to block, should not/avoid to ask, should/prefer to advisory, hedged skipped. Output: .interlinked/distilled-rules.json. Manual invocation only."
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

**Execution order** (distill path; lifecycle verbs jump straight to [step 14]):

1. [Run the pre-flight checks][step 11]
2. [Parse arguments][step 1]
3. [Read overrides][step 9]
4. [Read the prior `distilled-rules.json`][step 3]
5. [Discover and resolve targets][step 2]
6. [Read each file once][step 3]
7. [Classify paragraphs][step 4]
8. [Apply the lexical strength ladder][step 5]
9. [Extract triggers][step 6]
10. [Build each rule object][step 7]
11. [Apply user modifications][step 9]
12. [Resolve conflicts][step 10]
13. [Run self-checks][step 12]
14. [Write the output][step 8]
15. [Print the summary][step 13]

---

## What this skill does

Agent-instruction markdown files (AGENTS.md, CLAUDE.md, .clinerules/, .windsurf/rules/, GEMINI.md, etc.) are loaded into the model's context window as hopeful prose. Today the model may or may not follow them. This skill walks the source tree (or just the targets the user named), extracts every concrete imperative from those files, and distills them into typed `GuardRule` entries that the Interlinked harness enforces deterministically at runtime — meaning the agent literally cannot bypass them, regardless of which underlying coding agent is running.

**Distillation, not strict compilation.** The [step 5] lexical ladder + [step 6] trigger inference + [step 12] validation are deterministic — typed inputs, typed outputs, no LLM calls. But [step 4] paragraph classification (is this prose a hard imperative, soft preference, hedged statement, descriptive context?) requires LLM judgment because there's no formal grammar for "is this an imperative." So the operation is honest extraction-and-codification with provenance, not parser-style mechanical translation. The earlier name "compile" was a generous shorthand; "distill" reflects what's actually happening. The lexical ladder is the deterministic gate: if a paragraph contains no [step 5] marker, the classifier MUST drop it. The distiller never invents a rule from unmarked prose, and every rule carries a verbatim `source.quote` so the entire pipeline is auditable.

The harness fans rules out across every configured runner via `src/harness/adapters/`. Your job is to produce one canonical artifact at `.interlinked/distilled-rules.json` plus an overrides file at `.interlinked/distilled-rules.overrides.json`. The harness handles distribution.

**Coupling and scope.** This skill produces an artifact whose schema (`GuardRule`, defined at `src/harness/types.ts` in `interlinked-cli`) is Interlinked's. Enforcement at runtime requires a hook engine that understands that schema — Interlinked is the canonical one, and currently the only one expressive enough to encode regex on `tool_input` fields, the six action types, severity, keyword quick-reject, role scoping, and exception patterns. The skill does NOT ship multi-backend adapters (Claude Code permissions, Cursor `.mdc`, Codex deny configs) because every alternative is strictly less expressive — lossy translation creates user confusion ("why doesn't my rule work in X?"). However, distillation itself does not require Interlinked installed: the artifact is a standalone JSON file you can audit, version-control, share, or wire into any compatible engine. See [step 11] for fallback-mode behavior when `.interlinked/` is missing.

## Invocation patterns (what `/enforce <args>` means)

| Form | Behavior |
|---|---|
| `/enforce` | Walk the whole project — discover all .md files per Step 1, extract from imperative-bearing ones |
| `/enforce AGENTS.md` | Distill only that file |
| `/enforce AGENTS.md CLAUDE.md` | Distill that exact set |
| `/enforce .claude/skills/tdd/` | Distill every .md under the directory |
| `/enforce mattpocock/skills/tdd` | Treat as `gh:mattpocock/skills/tdd` — fetch + distill (review-mode) |
| `/enforce https://raw.githubusercontent.com/.../SKILL.md` | Fetch + distill (review-mode) |
| `/enforce list` | Lifecycle: print rules grouped by source — see [step 13] |
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

If the first argument is one of `list`, `show`, `remove`, `disable`, `enable`, `modify`, `add`, `reset`, treat it as a lifecycle verb (jump to [step 14]). Otherwise treat arguments as distill targets.

## Operating principles (NON-NEGOTIABLE)

1. **Manual invocation only.** This skill runs only when the user (or an agent acting on the user's explicit request) types `/enforce ...`. Do not wire it into SessionStart, PreCompact, file watchers, hook events, scheduled jobs, or any other auto-trigger. Surprise enforcement — the model suddenly being unable to do something it could yesterday because a doc changed — is the failure mode this rule prevents.
2. **Verbatim source provenance is required.** Every distilled rule must carry the source file path, line range, and exact verbatim quote. A rule whose `source.quote` does not appear in `source.file` at `source.lines` is hallucination — drop it.
3. **Lexical strength is binding** (see [step 5] ladder). Don't soften, don't escalate.
4. **Deterministic at evaluation time; semi-deterministic at distill time.** The harness must remain deterministic at runtime — never generate rules that require LLM evaluation to check. The distill step itself is partly LLM-driven (paragraph classification in [step 4] needs a model to decide "is this prose a hard imperative, soft preference, hedged, or descriptive"), but the lexical ladder ([step 5]) is the deterministic gate: if a paragraph contains no [step 5] marker, the classifier must drop it. The distiller never invents a rule from unmarked prose. Provenance ([step 7] `source.quote` verbatim) is what makes the distill-time step auditable rather than opaque.
5. **Default-skip when uncertain.** Far better to skip a borderline imperative than to emit a wrong one.
6. **Never overwrite hand-curated rules.** Output goes only to `.interlinked/distilled-rules.json` and `.interlinked/distilled-rules.overrides.json`. The user's hand-curated rules live in `guard-rules.json` and `guard-rules.local.json`. Never touch those.
7. **Idempotent across runs.** Hash inputs; skip unchanged files; preserve user overrides.
8. **No invention.** If a rule isn't in the source verbatim, it does not exist.

---

## Step 1 — Argument parsing

Parse the invocation arguments. The first arg, if it's one of the lifecycle verbs (`list`, `show`, `remove`, `disable`, `enable`, `modify`, `add`, `reset`), routes to [step 14]. Otherwise:

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

Sections 2a (project tree), 2b (user home) and 2c (skills as scan-only sources) are in [references/discovery.md](references/discovery.md). Read that file before a no-argument run or a directory walk.

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
| `.agent.md`, `.prompt.md`, `*.prompt`, `.github/agents/*.agent.md`, `.github/prompts/*.prompt.md` | Capability bundles — same treatment as SKILL.md per [step 2c]. `*.prompt` covers bare-extension role/capability prompts (e.g. SwarmForge `<role>.prompt`). |
| Any `SKILL.md` whose frontmatter `name` is `enforce` | Self-reference. The distiller must not distill its own imperatives — they describe how to distill, not what the agent should do. Drop the file silently regardless of which install path it lives at (`skills/`, `.claude/skills/`, `.agents/skills/`, `.interlinked/skills/`, `.gemini/skills/`, `.github/skills/`, `.cursor/skills/`, etc.). |
| Any `SKILL.md` whose frontmatter `name` is `tdd`, starts with `tdd-`, or ends with `-tdd`; any path matching `**/tdd/SKILL.md` or `**/*-tdd/SKILL.md` | TDD enforcement is owned by the harness's native primitives — `tdd_new_file_gate`, `tdd_cycle_violation`, `tdd_regression`, `tdd_commit_gate`, `tdd_green_confirmation` — driven by the deterministic `tdd_cycles` state machine in `SessionTrajectory`. Distilling a competing TDD skill (Matt Pocock's, gstack's, anyone else's) would either over-fire (always-on rules duplicating our gates) or shadow (action downgraded to `ask`). Drop these files silently. If a project legitimately needs a different TDD policy, edit `structural_checks.test_first_mode` in `guard-rules.local.json`, not via /enforce. |

After discovery, **print the file inventory** before any extraction so the user can see the surface.

---

## Step 3 — Read each file once

Use the Read tool with the full path. Cache contents. SHA-256 each file.

If `.interlinked/distilled-rules.json` already exists, compare each file's hash to the previous run's `source_hashes` map. **Unchanged files: skip extraction; copy their previous distilled rules verbatim into the new output.** Only re-extract files whose hash changed or which are new.

**Subset distillation preserves other sources.** When the user runs `/enforce <single-target>` (a path, a directory, a remote URL), the distiller MUST merge with the prior `distilled-rules.json`: rules from sources NOT in the current invocation are copied through unchanged, with their original `source_hashes` entries preserved. This is the natural extension of the unchanged-files rule: out-of-scope sources are unchanged by definition. Only `/enforce` (no arg, project walk) is allowed to fully regenerate. If you need a hard rebuild from a subset invocation, the user must `rm .interlinked/distilled-rules.json` first — the [“Throw it all away and start fresh”][restart distillation] workflow.

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

Distilled rules ALSO carry a `source` sidecar field — see [step 7]. The harness ignores unknown fields; the CLI lifecycle ops use them.

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

‡ Sequential preconditions ("Always X before Y") are not directly representable in `GuardRule`. Emit a Pass 2 `policy.md` entry (see [step 15.2]) where `trigger_signal` describes the precondition in natural language; the Tier 2 LLM gate evaluates it from trajectory. Do NOT downgrade to `ask` in `distilled-rules.json` — `ask` is removed per [step 15.1] (PreToolUse user-prompts created fatigue; the Tier 2 gate handles the same job without interrupting).

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

## Steps 7 to 10: rule, schema, overrides, conflicts

Read [references/rule-schema.md](references/rule-schema.md) before you write output on a distill run. It holds Step 7 (build the distilled rule), Step 8 (output schema), Step 9 (overrides file) and Step 10 (conflict resolution).

## Step 11 — Pre-flight checks (run BEFORE writing anything)

- `.interlinked/` directory check.
  - **Preferred path** (Interlinked installed): `.interlinked/` exists. Output goes to `.interlinked/distilled-rules.json`; the harness watches the file and picks up changes within ~2s automatically.
  - **Fallback path** (Interlinked not installed): `.interlinked/` is missing. **Warn — do not abort.** Write the artifact to `./distilled-rules.json` next to the user's CWD (the same location for the overrides file: `./distilled-rules.overrides.json`). Print a clear message:

    > No `.interlinked/` directory found. Distilled rules written to `./distilled-rules.json`. To enforce them, install Interlinked (`npm install -g github:QuentinCody/interlinked-cli && interlinked enable`) — Interlinked's harness reads exactly this file from `.interlinked/`. Or wire the JSON into your own hook engine using the `GuardRule` schema in the enforce skill’s `references/rule-schema.md`. Distillation does NOT require Interlinked; enforcement does.

    This separates **producing the artifact** (this skill's scope, no runtime dependency) from **enforcing it** (Interlinked's scope, runtime dependency). Users without the harness still get a tangible, version-controllable, auditable file they can share or migrate later.
- The directory is a git repo. If not, warn but continue — treat CWD itself as the project root for both the [step 1] outside-CWD check and the [step 7] `local:<path>` relative-path computation.
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

Print the [distillation report](references/report-format.md) after every run, including review-only runs.

---

## Step 14: lifecycle operations

If the first argument is a lifecycle verb, read [references/lifecycle.md](references/lifecycle.md) and follow it. That file also holds the common workflows.

## Step 15: companion artifacts

On a distill run, read [references/companion-artifacts.md](references/companion-artifacts.md). It holds the three-pass routing, the policy, Cedar and prose formats, the skipped report and local-only mode. Its sections 15.7 to 15.10 add rules to Steps 6, 8, 11 and 13.

## Worked examples

[references/examples.md](references/examples.md) holds eight worked examples. Read them when a pattern is not clear.

## Failure modes to guard against

| Failure | Detection | Fix |
|---|---|---|
| Hallucinated rule | `source.quote` does not appear verbatim in `source.file` | Drop the rule; log to `extraction_errors[]`. |
| Hedged distilled to block | marker is `usually`/`prefer`/`try` but `action=block` | Re-classify per [step 5]. |
| Trigger too broad | regex is `.*` with no anchors | Reject; downgrade to advisory. |
| Trigger too narrow | matches only literal command without escaping | Add `\b` boundaries. |
| Persona file got distilled | source path matches [step 2d] skip list | Drop everything from that file. |
| Same imperative in two files | both distilled with same trigger | Merge per [step 10]. |
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
- Lexical strength is binding ([step 5] ladder).
- `never` / `MUST NOT` / `forbidden` / `shall not` → **block**, no exceptions.
- `active_when` population is binding ([step 7] source-location table). Skill-body rules ALWAYS carry `active_when.skill = "<skill-name>"`. Project-wide rules (CLAUDE.md, AGENTS.md, etc.) ALWAYS omit `active_when` (always-on). Skip is always safer than mis-scoping.
- TDD-themed skills are skipped ([step 2d]). Don't distill them — TDD enforcement is owned by harness primitives.
- Skip is always safer than mis-distill.
- Output goes only to `.interlinked/distilled-rules.json` (or `.review.json`) and `.interlinked/distilled-rules.overrides.json`.
- Read the overrides file BEFORE extracting; honor `removed_groups`, `removed_rule_ids`, `disabled_rule_ids`, and `modifications`.
- End every run with the [step 13] summary table.
- Every rule has provenance, or it doesn't exist.

## References

- [references/discovery.md](references/discovery.md): Steps 2a to 2c, where to look for sources.
- [references/rule-schema.md](references/rule-schema.md): Steps 7 to 10. Every distill run needs it.
- [references/companion-artifacts.md](references/companion-artifacts.md): Step 15. Every distill run needs it.
- [references/lifecycle.md](references/lifecycle.md): common workflows and the Step 14 lifecycle verbs.
- [references/examples.md](references/examples.md): eight worked examples.

[restart distillation]: references/lifecycle.md#throw-it-all-away-and-start-fresh
[step 1]: #step-1--argument-parsing
[step 2]: #step-2--discover-sources-no-arg-or-directory-walk
[step 2c]: references/discovery.md#2c--skills-as-scan-only-sources
[step 2d]: #2d--skip-list-do-not-extract-from-these--confirm-kind-then-skip
[step 3]: #step-3--read-each-file-once
[step 4]: #step-4--per-paragraph-classification
[step 5]: #step-5--lexical-strength--action-ladder-binding
[step 6]: #step-6--trigger-extraction-real-guardrule-schema
[step 7]: references/rule-schema.md#step-7--build-the-distilled-rule-one-entry-per-imperative
[step 8]: references/rule-schema.md#step-8--output-schema
[step 9]: references/rule-schema.md#step-9--overrides-file-the-users-mods
[step 10]: references/rule-schema.md#step-10--conflict-resolution
[step 11]: #step-11--pre-flight-checks-run-before-writing-anything
[step 12]: #step-12--self-checks-run-before-writing-output
[step 13]: #step-13--final-summary-required-print-to-user-at-end-of-run
[step 14]: #step-14-lifecycle-operations
[step 15.1]: references/companion-artifacts.md#151--three-pass-routing-binding
[step 15.2]: references/companion-artifacts.md#152--pass-2-policy-doc-format-groupidpolicymd
