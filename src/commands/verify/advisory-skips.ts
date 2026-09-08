// ===========================================
// Skip-set helpers — merge CLI --skip with the advisory defaults
// ===========================================
// Split out of advisory.ts (2026-07-24) so that file stays under the line cap
// while remaining the single home of the policy data (DEFAULT_ADVISORY_SKIPS,
// TOOL_IDS). Import direction is one-way: this module reads the policy consts
// from advisory.js; advisory.js does not import back.

import { DEFAULT_ADVISORY_SKIPS, TOOL_IDS } from "./advisory.js";

/**
 * Public API — consumed by `verify.ts`.
 *
 * Merge CLI `--skip` list with the advisory defaults when `--all-checks` is not
 * set. Always returns a lowercased, trimmed set.
 */
export function getEffectiveSkipChecks(
	skipArg: string | undefined,
	allChecks: boolean | undefined,
): Set<string> {
	const merged = new Set(
		skipArg
			? skipArg
					.split(",")
					.map((s: string) => s.trim().toLowerCase())
					.filter(Boolean)
			: [],
	);
	if (!allChecks) {
		for (const check of DEFAULT_ADVISORY_SKIPS) merged.add(check);
	}
	return merged;
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Narrow a skip-check set to just the tool IDs that can be passed to the
 * CheckEngine's `skipTools` option.
 */
export function getSkipTools(skipChecks: Set<string>): Array<(typeof TOOL_IDS)[number]> {
	return [...skipChecks].filter((check): check is (typeof TOOL_IDS)[number] =>
		TOOL_IDS.some((id) => id === check),
	);
}
