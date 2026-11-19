import { detectNumericZeroDefault } from "../../harness/checks/numeric-zero-default.js";
import { captureVerifyCheckEvidence, toIssues, type FileCheckContext } from "./file-checks-shared.js";

/** Numeric dataflow evidence retains selected project dependencies and unavailable scopes. */
export function runNumericZeroDefaultCheck({ content, file, relPath, cwd, r }: FileCheckContext): void {
	for (const issue of toIssues("numeric_zero_default", relPath, () => captureVerifyCheckEvidence(
		"numeric_zero_default", relPath, cwd, () => detectNumericZeroDefault(content, file)))) {
		r.numericZeroDefault.push(issue);
	}
}
