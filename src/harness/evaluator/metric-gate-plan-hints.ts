// ===========================================
// Per-function metric gate — decomposition-plan hints on the block message
// ===========================================
// A block that says "CC 24 > cap 22" tells the agent WHAT failed; the plan
// line says WHICH arms to extract to get under the cap (decomposition-plan.ts).
// Kept out of per-function-metric-gate.ts for the line cap; the gate calls
// `appendPlanHints` once per file with the violations it already computed.

/** Produce one plan sentence for `fnName` in the post-edit `after` content, or
 *  null when nothing can be planned (non-TS, unknown function, no planner). */
export type PlanHintFn = (after: string, filePath: string, fnName: string, cap: number) => string | null;

/**
 * Append a `↳ plan:` sub-line to the FIRST violation that mentions each named
 * over-cap function. Anonymous units have no stable identity to plan against;
 * over-cap functions no violation names (held, grandfathered) are not planned —
 * the plan is remediation for what blocked, not a census. Never throws: a
 * planner failure leaves the violation untouched.
 */
export function appendPlanHints(
	violations: readonly string[],
	overCap: ReadonlyArray<{ name: string }>,
	anonName: string,
	planFor: PlanHintFn,
	after: string,
	filePath: string,
	cap: number,
): string[] {
	if (violations.length === 0) return [...violations];
	const out = [...violations];
	const planned = new Set<string>();
	for (const entry of overCap) {
		if (entry.name === anonName || planned.has(entry.name)) continue;
		const idx = out.findIndex((v) => v.includes(entry.name));
		if (idx === -1) continue;
		planned.add(entry.name);
		const hint = safePlan(planFor, after, filePath, entry.name, cap);
		if (hint) out[idx] = `${out[idx]}\n      ↳ plan: ${hint}`;
	}
	return out;
}

function safePlan(planFor: PlanHintFn, after: string, filePath: string, fnName: string, cap: number): string | null {
	try {
		return planFor(after, filePath, fnName, cap);
	} catch {
		return null;
	}
}
