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
// commander_option_attribute adds heuristic advisory evidence with no scoring
// dimension. Removing only that row reproduces the prior 827bd023 hash;
// all other catalog classifications and scoring authority remain unchanged.
// numeric_zero_default adds heuristic advisory evidence with no scoring dimension.
// Removing only that row reproduces the prior 37e4c9bf hash; existing scoring
// classifications, thresholds and enforcement authority remain unchanged.
// dead_literal_store warns before an edit and top_level_burden advises afterwards.
// Both are unscored. Removing their rows reproduces the prior 9be4c5f7 hash.
// omitted_private_parameter is advisory and unscored. Removing this row restores 872f29e4.
export const REVIEWED_REGISTRY_HASH = "ae3b65f27d70bd9799829cc452a5d7eba625ad3bf87a6cb3e1a3d6a37a33afb1";
