// ============================================================
// Interlinked Harness — Two-pass re-verification layer
// ============================================================
// Adapted from the Mythos AI security analysis (daniel.haxx.se,
// 2026-05-11): every candidate finding their pipeline produced was
// re-verified against the source before reporting. We generalize
// the same pattern for our deterministic checks — each candidate
// `InlineMatch` flows through a chain of registered "verify-pass"
// filters that can drop it based on stricter rules.
//
// Why this exists: several inline detectors produce noise on
// well-known shapes (typeof narrowing, case-arms, fixture data).
// Until now, each FP was patched inline in the detector itself
// (see commit aac4e2a — "exempt typeof narrowing from
// magic_literal_in_conditional"). This module makes those filters
// pluggable so a new FP class can be addressed without touching
// the detector's regex.
//
// Determinism: each pass is a pure (match, content, filePath) →
// boolean function. No LLM, no subprocess. Filters are AND-combined
// — a match must pass EVERY registered filter for its checkId to
// reach the reporting layer.

import type { InlineMatch } from "../checks/shared.js";

/** A registered second-pass filter for a specific check id. */
interface VerifyPass {
	/** Check id this pass filters (e.g. "magic_literal_in_conditional"). */
	checkId: string;
	/** Human-readable rationale — shown to maintainers tuning FPs. */
	rationale: string;
	/** Returns true to keep the finding, false to drop it. */
	verify: (match: InlineMatch, content: string, filePath: string) => boolean;
}

const passes: VerifyPass[] = [];

/** Register a verify-pass filter. Called at module-load time by the
 *  builtin-verify-passes module; external code can register additional
 *  passes for project-local rules. */
export function registerVerifyPass(pass: VerifyPass): void {
	passes.push(pass);
}

/** Reset the registry — TEST-ONLY entry point so test cases don't
 *  bleed registrations into each other. */
export function resetVerifyPassesForTesting(): void {
	passes.length = 0;
}

/** Apply all registered verify-passes for `checkId` to a candidate
 *  list. Returns the filtered list (matches that survived every
 *  registered filter). When no passes are registered for the id,
 *  returns the input unchanged. */
export function applyVerifyPasses(
	checkId: string,
	matches: InlineMatch[],
	content: string,
	filePath: string,
): InlineMatch[] {
	const applicable = passes.filter((p) => p.checkId === checkId);
	if (applicable.length === 0) return matches;
	return matches.filter((m) =>
		applicable.every((p) => {
			try {
				return p.verify(m, content, filePath);
			} catch {
				// A throwing verify-pass must not drop legitimate findings.
				// Fail-open: keep the match. The exception is logged
				// elsewhere by the daemon's general error path.
				return true;
			}
		}),
	);
}

/** Distinct check ids that have at least one registered verify pass. */
export function getRegisteredVerifyPassIds(): string[] {
	const ids = new Set<string>();
	for (const p of passes) ids.add(p.checkId);
	return [...ids];
}
