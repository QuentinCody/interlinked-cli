import type { InlineMatch } from "../../harness/check-registry/types.js";
import { toIssues, type FileCheckContext } from "./file-checks-shared.js";
import type { CodeQualityIssue } from "./tool-results-types.js";

type ContentDetector = (content: string, path: string) => InlineMatch[];
type RunContentCheck = (check: string, destination: CodeQualityIssue[], detector: ContentDetector) => void;

/** Apply the normal selection and measurement budgets, then append without a spread argument limit. */
export function contentCheckRunner({ content, file, relPath }: Pick<FileCheckContext, "content" | "file" | "relPath">): RunContentCheck {
	return (check: string, destination: CodeQualityIssue[], detector: ContentDetector): void => {
		for (const issue of toIssues(check, relPath, detector, content, file)) destination.push(issue);
	};
}
