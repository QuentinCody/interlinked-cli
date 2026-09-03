// Comment-vs-behavior drift detectors (Mythos blog adaptation).
// "Spotting contradictions between code comments and actual behavior"
// was Mythos's strongest signal. Five narrow per-function detectors
// here; all advisory (heuristic by nature — comments rot independently
// of code, and the regex shape can't perfectly recognize every guard).
// Extracted from agent-clarity.ts — spread back into
// AGENT_CLARITY_ENTRIES there.

import {
	checkCommentClaimsIdempotentMutates,
	checkCommentClaimsLimitNoGuard,
	checkCommentClaimsNullThrowsInstead,
	checkCommentClaimsThrowsDoesnt,
	checkCommentClaimsValidationMissing,
} from "../../generic-checks.js";
import type { CheckRegistration } from "../types.js";

export const COMMENT_DRIFT_ENTRIES: CheckRegistration[] = [
	{
		id: "comment_claims_limit_no_guard",
		phase: "post",
		name: "Comment Claims Limit With No Guard",
		description:
			'Detects functions whose comment says "max N" / "at most N" / "limited to N" but whose body has no `< N` / `<= N` guard for that number.',
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The comment promises a numeric limit but no guard in the body enforces it. Either remove the limit claim from the comment (if no limit is actually enforced) or add the missing `if (n > N) ...` / `slice(0, N)` / `Math.min(n, N)` guard so the comment and code agree.",
		fn: checkCommentClaimsLimitNoGuard,
		resultsPropName: "commentClaimsLimitNoGuard",
	},
	{
		id: "comment_claims_null_throws_instead",
		phase: "post",
		name: "Comment Claims Null Return But Body Throws",
		description:
			'Detects functions whose comment says "returns null on failure" / "may return undefined" but whose body contains an unhandled `throw`.',
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The comment promises null/undefined on failure but the body throws. Either wrap the failure path in try/catch and return null, or rewrite the comment to reflect that the function throws. Cold callers will write `if (result === null)` and miss the exception.",
		fn: checkCommentClaimsNullThrowsInstead,
		resultsPropName: "commentClaimsNullThrowsInstead",
	},
	{
		id: "comment_claims_validation_missing",
		phase: "post",
		name: "Comment Claims Validation But No Check Present",
		description:
			'Detects functions whose comment says "validates X" / "sanitizes Y" / "escapes Z" but whose body contains no conditional, regex, or encode call.',
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The comment claims validation/sanitization/escaping but the body has none — no conditional, regex test, or encode call. Either implement the validation or remove the claim. Cold callers (and downstream agents) will treat the output as safe.",
		fn: checkCommentClaimsValidationMissing,
		resultsPropName: "commentClaimsValidationMissing",
	},
	{
		id: "comment_claims_idempotent_mutates",
		phase: "post",
		name: "Comment Claims Idempotent But Body Mutates",
		description:
			'Detects functions whose comment says "idempotent" but whose body contains an unconditional mutation (++=, push, set, etc.) with no guard.',
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The comment promises idempotency but the body unconditionally mutates state. Either guard the mutation (`if (!set.has(x)) set.add(x)`) or remove the idempotency claim. Retry-safe callers will assume calling twice is safe and will be wrong.",
		fn: checkCommentClaimsIdempotentMutates,
		resultsPropName: "commentClaimsIdempotentMutates",
	},
	{
		id: "comment_claims_throws_doesnt",
		phase: "post",
		name: "Declared @throws Never Thrown",
		description:
			"Detects JSDoc @throws {ErrorX} declarations where the body never throws that error class.",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The function declares `@throws {ErrorX}` but never throws `new ErrorX(...)`. Either remove the declaration or add the missing throw. Documented exception contracts that don't match behavior produce useless catch sites downstream.",
		fn: checkCommentClaimsThrowsDoesnt,
		resultsPropName: "commentClaimsThrowsDoesnt",
	},
];
