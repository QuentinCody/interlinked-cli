/** Reviewed registry composition. New or reclassified checks require explicit profile review. */
// Reviewed removal of the enforcement-only no-op sequence sentinel and
// addition of lint_import as a supporting, partially deterministic tool check.
// html_duplicate_id is a heuristic PostToolUse warning. Its lexical scope is
// documented; it stays advisory in metrics and contributes no quality score.
// python_simplification adds bounded advisory evidence; it has no scoring authority.
// repeated_implementation is heuristic, advisory, and excluded from quality scoring.
// Six expression-readability checks remain heuristic, advisory, and unscored.
// hand_rolled_lexer (H8, 2026-10-02) is heuristic, advisory, and unscored; removing its row restores the prior hash.
// Repeated warnings are heuristic session advice, never a repository quality score.
// Restoring only persistent_warning_escalation to fully_deterministic reproduces
// the prior 18176196 hash; no other catalog classification changed in this review.
// U4 (2026-10-09) adds three guard rules (builtin-file-truncate, builtin-chmod-000,
// builtin-chown-recursive): enforcement rows with no score authority; removing those
// three rows reproduces the prior 7d91c267 hash.
export const REVIEWED_REGISTRY_HASH = "827bd023ba29cc85054e8bbf3e7c4703f5b8c4a9d9f9d843d9b9f9ef962babc6";
