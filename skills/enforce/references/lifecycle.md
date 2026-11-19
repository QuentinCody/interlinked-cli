# enforce: common workflows and lifecycle operations (Step 14)

Reference for [SKILL.md](../SKILL.md). Read it when the first argument is a lifecycle verb.
A § number names a step of /enforce: Steps 1 to 6.5 and 11 to 13 are in SKILL.md, and the
other steps are in the sibling files of this directory.

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
