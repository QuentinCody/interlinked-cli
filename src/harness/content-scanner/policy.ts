// ===========================================
// Content Scanner — Policy
// ===========================================
//
// Binary decision layer on top of ScanFinding[]. v1 policy is deliberately
// simple: if ANY span survives the `min_score` floor, block. Multiple
// categories are enumerated in the block reason with per-category counts,
// sorted alphabetically by label for deterministic test assertions.

import type { ContentScannerConfig, ScanFinding } from "./types.js";

export interface ContentScanVerdict {
	decision: "allow" | "ask";
	reason?: string;
	warnings?: string[];
}

/** Apply the configured confidence floor. Undefined score counts as 1.0
 * because the local OPF backend emits deterministic spans without scores. */
export function filterFindingsByScore(
	findings: ScanFinding[],
	config: ContentScannerConfig,
): ScanFinding[] {
	const minScore = config.min_score;
	return findings.filter((f) => (f.score ?? 1) >= minScore);
}

/**
 * Decide allow vs ask-for-confirmation from scanner findings.
 *
 * We return `"ask"` (not `"block"`) because OPF is probabilistic: it has FPs
 * on legitimate test fixtures, example.com addresses, variable names, etc.
 * A hard block would trap agents on content they need to write. `"ask"`
 * surfaces Claude Code's built-in confirmation UI so the human decides per
 * call while still carrying the detected-category summary as context.
 *
 * Reason-format contract (asserted by `policy.test.ts`):
 *   1. Bracketed list contains exactly the detected categories, alphabetical by label.
 *   2. Each entry is `<label>(<count>)` with label echoed verbatim.
 *   3. Single-category detections still render as a list (e.g., `[secret(1)]`).
 *   4. Matched substrings are NEVER included — only categories and counts.
 */
export function decideFromFindings(
	findings: ScanFinding[],
	config: ContentScannerConfig,
): ContentScanVerdict {
	if (findings.length === 0) return { decision: "allow" };

	const kept = filterFindingsByScore(findings, config);
	if (kept.length === 0) return { decision: "allow" };

	const counts = new Map<string, number>();
	for (const f of kept) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);

	const summary = [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([label, n]) => `${label}(${n})`)
		.join(", ");

	return {
		decision: "ask",
		reason:
			`privacy-filter detected sensitive content [${summary}]. ` +
			`Review the tool call before approving — the filter can false-positive on ` +
			`test fixtures, example.com addresses, and variable names.`,
	};
}
