// Plan-and-render helper for the cognitive gate's `planFor` slot. Split out of
// cognitive-plan.ts (at the line cap) so the null-when-unlocatable contract is
// a directly testable public surface rather than a private wrapper branch.

import { cognitivePlanToMessage, planCognitiveFlattening } from "./cognitive-plan.js";

/** The fewest flattening moves that bring `fnName` under `cap`, rendered as one
 *  `↳ plan:` sentence — or null when the planner cannot locate `fnName` in
 *  `content` (nothing to say). The cyclomatic gate's twin is
 *  `decompositionPlanHint` in evaluator/complexity-write-guard.ts. */
export function cognitiveFlatteningMessage(
	content: string,
	filePath: string,
	fnName: string,
	cap: number,
): string | null {
	const plan = planCognitiveFlattening(content, filePath, fnName, cap);
	return plan ? cognitivePlanToMessage(plan) : null;
}
