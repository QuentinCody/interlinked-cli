// Diff-line extraction shared by `behavioral-checks-tdd.ts` (added lines,
// used by the TPP-leapfrog commit gate) and `behavioral-diff-checks.ts`
// (removed lines, used by the no-op-commit detector). Both are the same
// operation on opposite sides of a unified git diff — split out here so
// neither call site carries its own copy.

/**
 * Collect the diff lines on one side (`+` additions or `-` removals), with
 * their marker stripped. The matching file-header line (`+++`/`---`) never
 * counts as content.
 */
function extractDiffLines(diff: string, sign: "+" | "-"): string {
	const header = sign === "+" ? "+++" : "---";
	const out: string[] = [];
	for (const line of diff.split("\n")) {
		if (!line.startsWith(sign) || line.startsWith(header)) continue;
		out.push(line.slice(1));
	}
	return out.join("\n");
}

export function extractAddedLines(diff: string): string {
	return extractDiffLines(diff, "+");
}

export function extractRemovedLines(diff: string): string {
	return extractDiffLines(diff, "-");
}
