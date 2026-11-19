# Distillation report

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
