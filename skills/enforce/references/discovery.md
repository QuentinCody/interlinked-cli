# enforce: source discovery (Steps 2a to 2c)

Reference for [SKILL.md](../SKILL.md). Read it before a no-argument run or a directory walk. Step 2d, the skip list, stays in SKILL.md.
A § number names a step of /enforce: Steps 1 to 6.5 and 11 to 13 are in SKILL.md, and the
other steps are in the sibling files of this directory.

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
