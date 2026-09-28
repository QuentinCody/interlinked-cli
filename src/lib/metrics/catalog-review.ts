/** Reviewed registry composition. New or reclassified checks require explicit profile review. */
// Reviewed removal of the enforcement-only no-op sequence sentinel and
// addition of lint_import as a supporting, partially deterministic tool check.
// html_duplicate_id is a heuristic PostToolUse warning. Its lexical scope is
// documented; it stays advisory in metrics and contributes no quality score.
// python_simplification adds bounded advisory evidence; it has no scoring authority.
// repeated_implementation is heuristic, advisory, and excluded from quality scoring.
// Six expression-readability checks remain heuristic, advisory, and unscored.
export const REVIEWED_REGISTRY_HASH = "c87a029ef9da4ebac196e304c3ca30dffaccc209e2a1e801b2b2694db7df6dbb";
