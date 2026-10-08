// Stale-suppression report for `interlinked verify` (antithesis intake backlog
// #16). A suppression that matches nothing hides the next real finding at that
// spot, so verify lists them in the `suppression hygiene` row. Report only:
// the row does not change verify's exit code.
//
// Two signals, with different strength:
//   - stale_file_suppression [proven]: a `verify-suppressions.json` entry whose
//     literal file path does not exist. Glob keys are not judged.
//   - unused_inline_suppression [heuristic]: an inline `interlinked-ignore`
//     directive that suppressed no finding in this verify run. verify does not
//     record which checks ran on each file, so "nothing suppressed" can also
//     mean "verify does not run that check here" (hook-only checks, advisory
//     checks without --all-checks). The message says so.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type InlineSuppressions, loadSuppressionFile } from "../../harness/suppressions.js";
import type { CodeQualityIssue } from "./tool-results-types.js";

export interface SuppressionHygieneFinding {
	name: string;
	file: string;
	message: string;
}

const GLOB_CHARS = /[*?[\]{}]/;
/** `isSuppressed` honors a directive for findings on its target line and one line either side. */
const DIRECTIVE_REACH = 1;

/** File entries in `<interlinkedDir>/verify-suppressions.json` whose literal path no longer exists. */
export function staleFileSuppressions(interlinkedDir: string): SuppressionHygieneFinding[] {
	const root = dirname(interlinkedDir);
	const missing = Object.entries(loadSuppressionFile(interlinkedDir)).filter(
		([file]) => !GLOB_CHARS.test(file) && !existsSync(join(root, file)),
	);
	return missing.map(([file, checks]) => staleFileFinding(file, Object.keys(checks)));
}

function staleFileFinding(file: string, checks: string[]): SuppressionHygieneFinding {
	const names = [...checks].sort().join(", ");
	const message = `verify-suppressions.json suppresses ${names} for a file that does not exist; the entry matches nothing`;
	return { name: "stale_file_suppression", file, message };
}

/** The target line of the inline directive that suppresses `check` at `line`, or null. Same reach as `isSuppressed`. */
export function directiveLineFor(check: string, line: number, inline: InlineSuppressions): number | null {
	for (let offset = -DIRECTIVE_REACH; offset <= DIRECTIVE_REACH; offset++) {
		if (inline.get(line + offset)?.has(check)) return line + offset;
	}
	return null;
}

export function directiveKey(line: number, check: string): string {
	return `${line}\0${check}`;
}

/** One finding per (directive target line, check) pair that suppressed nothing in this run. */
export function unusedInlineDirectives(relPath: string, inline: InlineSuppressions, used: ReadonlySet<string>): CodeQualityIssue[] {
	const pairs = [...inline].flatMap(([line, checks]) => [...checks].map((check) => ({ line, check })));
	const unused = pairs.filter(({ line, check }) => !used.has(directiveKey(line, check)));
	return unused.map(({ line, check }) => unusedDirectiveIssue(relPath, line, check));
}

function unusedDirectiveIssue(relPath: string, line: number, check: string): CodeQualityIssue {
	const message =
		`\`interlinked-ignore: ${check}\` suppressed nothing in this verify run: ${check} found nothing within ±1 line here, ` +
		"or verify does not run it on this file. Remove the directive if the finding is gone.";
	return { check: "unused_inline_suppression", file: relPath, line, message };
}
