import {
	detectCatchRewrapLosesCause,
	detectJsonStringifyError,
	detectResourceHandleLeak,
} from "../../harness/checks/error-context.js";
import { toIssues, type FileCheckContext } from "./file-checks-shared.js";

/** Reuse the hook's error-context and ownership heuristics in selected verification. */
export function runErrorContextChecks({ content, file, relPath, r }: FileCheckContext): void {
	for (const issue of toIssues("json_stringify_error", relPath, detectJsonStringifyError, content, file)) {
		r.jsonStringifyError.push(issue);
	}
	for (const issue of toIssues("catch_rewrap_loses_cause", relPath, detectCatchRewrapLosesCause, content, file)) {
		r.catchRewrapLosesCause.push(issue);
	}
	for (const issue of toIssues("resource_handle_leak", relPath, detectResourceHandleLeak, content, file)) {
		r.resourceHandleLeak.push(issue);
	}
}
