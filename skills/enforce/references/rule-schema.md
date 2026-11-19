# enforce: rule build, output schema, overrides, conflicts (Steps 7 to 10)

Reference for [SKILL.md](../SKILL.md). Read it before you write output on a distill run.
A § number names a step of /enforce: Steps 1 to 6.5 and 11 to 13 are in SKILL.md, and the
other steps are in the sibling files of this directory.

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
