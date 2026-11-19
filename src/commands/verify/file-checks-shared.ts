// ===========================================
// Per-file check battery — shared primitives
// ===========================================
// Holds the primitives needed by BOTH the orchestrator (`file-checks.ts`) and
// every per-group helper (`file-checks-<group>.ts`): the `toIssues` value
// converter, the `PiiOpts` alias, and the `FileCheckContext` interface. Kept in
// a sibling module that depends on NOTHING else in this family so the group
// files can import them directly without a runtime require cycle back through
// `file-checks.ts` — mirrors `harness/checks/test-hygiene-shared.ts`.

import type { CodeQualityIssue, CodeQualityResults } from "./tool-results-types.js";
import type { InlineMatch } from "../../harness/check-registry/types.js";
import { hasVerifyTimingContext, isVerifyCheckSelected, measureVerifyCheck, recordVerifyInputDeferral } from "./check-timing.js";
import { withCheckRoot } from "../../harness/checks/check-root.js";

/**
 * Public API — consumed by `file-checks.ts` and the `file-checks-<group>.ts`
 * helpers.
 *
 * Convert `InlineMatch[]` from generic-checks into `CodeQualityIssue[]`.
 */
export function toIssues<Args extends unknown[]>(
	check: string,
	file: string,
	matches: InlineMatch[] | ((...args: Args) => InlineMatch[]),
    ...args: Args
): CodeQualityIssue[] {
    if (!isVerifyCheckSelected(check)) return [];
    const measured = typeof matches === "function" ? measureVerifyCheck(check, () => matches(...args), () => []) : matches;
    return measured.map((match) => {
        const issue: CodeQualityIssue = { check, file, line: match.line, message: match.text };
        if (match.startOffset !== undefined) issue.startOffset = match.startOffset;
        if (match.endOffset !== undefined) issue.endOffset = match.endOffset;
        if (match.endLine !== undefined) issue.endLine = match.endLine;
		if (match.sourceEvidence !== undefined) issue.sourceEvidence = match.sourceEvidence.map(reference => ({ ...reference }));
        return issue;
    });
}

/** Opted-in adapters retain detector notices in structured coverage beside positive matches. */
export function captureVerifyCheckEvidence(check: string, file: string, root: string, work: () => InlineMatch[]): InlineMatch[] {
	const run = withCheckRoot(root, work);
	for (const reason of run.notMeasured) {
		recordVerifyInputDeferral(check, { file, reason });
		if (!hasVerifyTimingContext()) process.stderr.write(`${reason}\n`);
	}
	return run.result;
}

/** Public API — consumed by `file-checks.ts` and the `file-checks-<group>.ts` helpers. */
export type PiiOpts = Parameters<typeof import("../../harness/generic-checks.js").checkPiiInSource>[2];

/**
 * Public API — shared context threaded through every per-group helper. Bundles
 * the per-file locals the stateless detectors need (resolved path, content,
 * cwd for cross-file checks, the result accumulator, PII options).
 */
export interface FileCheckContext {
	file: string;
	content: string;
	relPath: string;
	cwd: string;
	r: CodeQualityResults;
	piiOpts: PiiOpts;
	/** Foreground precomputed result, retained within ordinary suppression handling. */
	repeatedImplementation?: InlineMatch[];
}
