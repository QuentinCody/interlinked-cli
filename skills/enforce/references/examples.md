# enforce: worked examples

Reference for [SKILL.md](../SKILL.md). Read it when a classification or trigger pattern is not clear.
A § number names a step of /enforce: Steps 1 to 6.5 and 11 to 13 are in SKILL.md, and the
other steps are in the sibling files of this directory.

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
