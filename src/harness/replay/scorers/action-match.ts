// ===========================================
// T1 scorer — action match
// ===========================================
// The cheapest per-step comparison: did the candidate pick the same tool with
// the same arguments as the recorded reference? Input comparison is
// key-order-insensitive (property order is serialization noise) but value-
// and array-order-sensitive
// (docs/design/reproducibility/tier1-teacher-forced-eval.md).

interface ActionForMatch {
	tool: string | null;
	input: unknown;
}

export interface ActionMatchScore {
	same_tool: boolean;
	same_input: boolean;
	match: boolean;
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = sortValue((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

/** Stable, key-sorted serialization. `undefined` and `null` both canonicalize
 *  to "null" (an absent input and an explicit null are the same non-input). */
export function canonicalizeInput(value: unknown): string {
	if (value === undefined) return "null";
	return JSON.stringify(sortValue(value));
}

export function actionMatch(ref: ActionForMatch, cand: ActionForMatch): ActionMatchScore {
	const sameTool = (ref.tool ?? null) === (cand.tool ?? null);
	const sameInput = canonicalizeInput(ref.input) === canonicalizeInput(cand.input);
	return { same_tool: sameTool, same_input: sameInput, match: sameTool && sameInput };
}
