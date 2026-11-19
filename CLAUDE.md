# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Skills load from `.claude/skills/` (installed copy of `skills/`); path-scoped
  rules in `.claude/rules/*.md` load when you read or edit a matching file.
- Subagents receive this file and the rules, not your conversation. Brief them
  with the goal, what is ruled out, and the files to read; forbid git state
  mutations in every subagent prompt. Keep parallel agents to about six, and run
  deterministic scans before any agent wave.
- Separate **Verified** (ran this session, output shown) from **Assumed** in every
  summary. Report times in America/New_York and counts as numerator / denominator.
