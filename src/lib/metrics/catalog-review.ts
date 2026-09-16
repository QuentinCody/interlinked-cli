/** Reviewed registry composition. New or reclassified checks require explicit profile review. */
// Reviewed removal of the enforcement-only no-op sequence sentinel and
// addition of lint_import as a supporting, partially deterministic tool check.
// html_duplicate_id is a heuristic PostToolUse warning. Its lexical scope is
// documented; it stays advisory in metrics and contributes no quality score.
// python_simplification adds bounded advisory evidence; it has no scoring authority.
export const REVIEWED_REGISTRY_HASH = "ceb07a838765e339c15427713b8cc0ad90581f26096370f8ff64219c67c4b4ba";
