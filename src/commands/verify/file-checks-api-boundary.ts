import { checkPublicApiLeaksInternalType } from "../../harness/checks/api-surface.js";
import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { detectJsdocParamDrift } from "../../harness/checks/jsdoc-param-drift.js";
import { getExtension, JS_TS_ALL_EXTS, type InlineMatch } from "../../harness/checks/shared.js";
import { detectUnvalidatedInputBoundary } from "../../harness/checks/unvalidated-input-boundary.js";
import { hasExactSyntax } from "../../harness/function-tokens/ast-tokens.js";
import { recordVerifyInputDeferral } from "./check-timing.js";
import { captureVerifyCheckEvidence, toIssues, type FileCheckContext } from "./file-checks-shared.js";

/** Exact parser coverage is separate from the detector's optional-parser fallback. */
function jsdocMatches(content: string, file: string, relPath: string): InlineMatch[] {
	if (!JS_TS_ALL_EXTS.includes(getExtension(file)) || !content.includes("@param")) return [];
	const parsed = parseTsSource(content, file);
	if (!parsed || !hasExactSyntax(parsed)) {
		recordVerifyInputDeferral("jsdoc_param_drift", { file: relPath, reason: parsed
			? "Source requires parser recovery; JSDoc parameter agreement unavailable"
			: "TypeScript parser unavailable; JSDoc parameter agreement unavailable" });
		return [];
	}
	return detectJsdocParamDrift(content, file);
}

/** Reuse the advisory API and input-boundary predicates with ordinary verify selection. */
export function runApiBoundaryChecks({ content, file, relPath, cwd, r }: FileCheckContext): void {
	for (const issue of toIssues("public_api_leaks_internal_type", relPath, checkPublicApiLeaksInternalType, content, file)) {
		r.publicApiLeaksInternalType.push(issue);
	}
	for (const issue of toIssues("jsdoc_param_drift", relPath, jsdocMatches, content, file, relPath)) {
		r.jsdocParamDrift.push(issue);
	}
	for (const issue of toIssues("unvalidated_input_boundary", relPath, () => captureVerifyCheckEvidence(
		"unvalidated_input_boundary", relPath, cwd, () => detectUnvalidatedInputBoundary(content, file)))) {
		r.unvalidatedInputBoundary.push(issue);
	}
}
