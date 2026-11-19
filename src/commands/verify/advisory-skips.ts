// ===========================================
// Skip-set helpers — merge CLI --skip with the advisory defaults
// ===========================================
// Split out of advisory.ts (2026-07-24) so that file stays under the line cap
// while remaining the single home of the policy data. Import direction is
// one-way: this module reads the policy consts
// from advisory.js; advisory.js does not import back.

import { DEFAULT_ADVISORY_SKIPS } from "./advisory.js";
import { resolveVerifyToolIds } from "./tool-selection.js";
import type { ToolId } from "../../harness/check-engine/types.js";

/**
 * Public API — consumed by `verify.ts`.
 *
 * Resolve exclusions before tool discovery, execution and receipt generation.
 */
export function getEffectiveSkipChecks(
	skipArg: string | undefined,
	allChecks: boolean | undefined,
	only?: string,
): Set<string> {
	const merged = new Set(
		skipArg
			? skipArg
					.split(",")
					.map((s: string) => s.trim().toLowerCase())
					.filter(Boolean)
			: [],
	);
	if (only !== "semgrep") merged.add("semgrep");
	if (!allChecks && !only) {
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
export function getSkipTools(skipChecks: Set<string>): ToolId[] {
	return resolveVerifyToolIds(skipChecks);
}
