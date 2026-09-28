// Builder functions that derive legacy data structures (agentSafetyChecks
// array, check instructions map, GENERIC_CHECK_META) from CHECK_REGISTRY.

import { applyVerifyPasses } from "../check-pipeline/verify-pass.js";
import { classifyDiff } from "../diff-classifier.js";
import { introducedReadability, READABILITY_CHECK_IDS } from "../checks/expression-readability.js";
import type { Determinism } from "../types.js";
import { CHECK_REGISTRY } from "./registry.js";
import type { CheckPhase, InlineMatch } from "./types.js";

/**
 * Build the agentSafetyChecks array for a given phase.
 *
 * @param content file contents to check
 * @param filePath path of the file being checked
 * @param phase optional phase filter — pass "pre_block", "pre_warn", or "post"
 *   to run only checks registered for that phase. Omit to run all phases
 *   (used by `interlinked verify` for full audit).
 * @param oldContent optional pre-edit content for diff-class skip (Phase B.4).
 *   When provided AND the diff between `oldContent` and `content` is
 *   non-semantic (only whitespace, comments, or quoted-string bodies
 *   changed), warning-severity detectors are skipped — they have nothing
 *   to fire on a comment-only edit and skipping saves the regex pass.
 *   Error-severity detectors STILL run because security checks must fire
 *   on a quoted-string change in case it leaked a credential.
 */
export function buildAgentSafetyChecks(
	content: string,
	filePath: string,
	phase?: CheckPhase,
	oldContent?: string,
	/** Mythos Phase 4 — when true, run ONLY fully-deterministic
	 *  detectors. Cold files (unchanged 180+ days) have been
	 *  re-checked by prior pipeline runs many times already; the
	 *  heuristic / partially-deterministic detectors don't pay
	 *  their per-edit cost on that code. Untracked and recent
	 *  files always pass false here — the recency gate is
	 *  fail-open for new code per `shouldRunAdvisoryChecks`. */
	coldFileMode?: boolean,
): Array<{
	name: string;
	severity: "error" | "warning";
	fn: () => InlineMatch[];
}> {
	// Lowercase content ONCE for the keyword pre-filter — amortized across
	// every check we test below. Plan B.1 / `content_keywords` field on
	// CheckRegistration. The check function itself still runs case-correctly;
	// this is purely the gate.
	const lcContent = content.toLowerCase();
	// Phase B.4 — diff-class skip. When the caller passes `oldContent`, we
	// classify the diff and skip warning-severity detectors on edits that
	// genuinely cannot fire any check. `oldContent === undefined` preserves
	// the legacy run-everything behavior for callers that haven't been
	// wired (e.g. `interlinked verify` in full-audit mode where there is
	// no "before" state).
	//
	// Only `whitespace_only` is safe to skip wholesale. `comment_only` per
	// `diff-classifier.ts` covers diffs landing inside *any* masked region
	// — comments AND quoted strings. Several warning detectors specifically
	// inspect quoted values (JSX `target="_blank"` audits, hardcoded-
	// localhost strings, weak-hash literals like `"md5"`, prompt-injection
	// scanners on quoted content, …). Skipping on `comment_only` would
	// silently drop those — the very pattern the reviewer flagged. Pure
	// whitespace edits cannot affect string contents OR semantic spans, so
	// dropping warnings there is safe.
	const diffClass =
		oldContent !== undefined ? classifyDiff(oldContent, content).diff_class : "semantic";
	const skipWarnings = diffClass === "whitespace_only";
	return CHECK_REGISTRY.filter((c) => c.pipeline === "agent_safety")
		.filter((c) => !phase || c.phase === phase)
		.filter((c) => !(skipWarnings && c.severity === "warning" && !READABILITY_CHECK_IDS.has(c.id)))
		.filter((c) => !coldFileMode || c.determinism === "fully_deterministic")
		.filter((c) => matchesContentKeywords(c.content_keywords, lcContent))
		.map((c) => ({
			name: c.id,
			severity: c.severity,
			// Each detector's candidate findings flow through the
			// `applyVerifyPasses` second-pass filter chain. When no
			// passes are registered for this check id, the helper is
			// effectively a passthrough (one Map lookup, no allocation).
            fn: () => applyVerifyPasses(c.id,
                oldContent !== undefined && READABILITY_CHECK_IDS.has(c.id) && c.id !== "expression_measurement"
                    ? introducedReadability(oldContent, content, filePath).filter(finding => finding.check === c.id)
                    : c.fn(content, filePath), content, filePath),
		}));
}

/**
 * Return `true` iff the detector should run against the file. A detector
 * with no `content_keywords` (or an empty list) always runs — preserves
 * legacy behavior. Otherwise, at least ONE keyword must appear (case-
 * insensitively) in the file content.
 *
 * Mirror of `evaluator/keyword-quick-reject.ts:shouldEvaluateByKeywords`,
 * adapted to file content rather than command tokens.
 */
function matchesContentKeywords(
	keywords: string[] | undefined,
	lcContent: string,
): boolean {
	if (!keywords?.length) return true;
	for (const kw of keywords) {
		if (lcContent.includes(kw.toLowerCase())) return true;
	}
	return false;
}

/** Build check instructions map (id → fix_instruction) */
export function buildCheckInstructions(): Record<string, string> {
	const instructions: Record<string, string> = {};
	for (const c of CHECK_REGISTRY) {
		instructions[c.id] = c.fix_instruction;
	}
	return instructions;
}

/** Build GENERIC_CHECK_META from registry (id → name/description/tier/determinism) */
export function buildGenericCheckMeta(): Record<
	string,
	{
		name: string;
		description: string;
		tier: 1 | 2 | 3;
		determinism: Determinism;
	}
> {
	const meta: Record<
		string,
		{
			name: string;
			description: string;
			tier: 1 | 2 | 3;
			determinism: Determinism;
		}
	> = {};
	for (const c of CHECK_REGISTRY) {
		meta[c.id] = {
			name: c.name,
			description: c.description,
			tier: c.tier,
			determinism: c.determinism,
		};
	}
	return meta;
}
