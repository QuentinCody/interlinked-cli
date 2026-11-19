// CLASS: Numeric zero results replaced through a logical-or default.
// FIRES WHEN: a resolved numeric coercion, stable result alias or supported raw
// parser wrapper reaches the left operand of || with a different possible default.
// DOES NOT FIRE: same-zero defaults, ??, shadowed builtins or normalized outputs.
// CALIBRATION: advisory source facts, with original/fixed search and foreign controls.
// KNOWN GAPS: general dataflow, ambient monkey-patching and opaque numeric wrappers.
// HOW TO EXTEND: resolve additional source relations with independent controls.
import type { InlineMatch } from "../check-registry/types.js";
import { reportNotMeasured } from "./check-root.js";
import { NUMERIC_ZERO_CHECK, numericMatches, numericModel } from "./numeric-zero-default-model.js";
import { numericProjectView, scanNumericProject } from "./numeric-zero-default-project.js";

/** Shared registry predicate. Supplied project evidence adds supported helpers;
 * standalone evaluation never starts a repository inventory. */
export function detectNumericZeroDefault(content: string, filePath: string): InlineMatch[] {
	if (!/\.[cm]?[jt]sx?$/.test(filePath) || (!content.includes("||") && !/\b(?:Number|parseInt|parseFloat)\b/.test(content))) return [];
	const view = numericProjectView(content, filePath);
	const gap = (reason: string) => view ? view.gap(filePath, reason) : reportNotMeasured(NUMERIC_ZERO_CHECK, `${filePath}: ${reason}`);
	const cached = view?.models.get(view.target);
	const model = cached?.content === content ? cached.model : numericModel(content, view?.target ?? filePath, gap);
	if (!model) return [];
	return view ? scanNumericProject(view, model) : numericMatches(model, gap);
}
