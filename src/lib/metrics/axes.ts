// ===========================================
// Evidence axes — stability vs correctness
// ===========================================
// Saturation testing separates two questions that one score blurs:
//   Stability   — does a change to the code fail a test? (coverage, mutation
//                 kills, test integrity). A saturated suite scores well here.
//   Correctness — is the code free of known defect classes, and does it meet
//                 the contracts the project declared? (correctness detectors,
//                 executable contracts).
// Neither axis shows that the behaviour is the one the requirement asks for;
// that stays with people (spec-audit, project e2e scenarios, manual tests).
// This is a DISPLAY grouping over the existing composite groups: it changes no
// score and no profile hash.

import type { CompositeGroupReading } from "./composite.js";

export type AxisId = "stability" | "correctness";

export interface AxisReading {
	id: AxisId;
	groups: Array<{ id: string; weight: number; score: number | null }>;
	/** Weighted mean of the measured groups (lower is better), or null when none is measured. */
	burden: number | null;
	meaning: string;
}

const AXES: ReadonlyArray<{ id: AxisId; groups: readonly string[]; meaning: string }> = [
	{ id: "stability", groups: ["coverage", "mutation", "test_integrity"], meaning: "a change to the code fails a test" },
	{ id: "correctness", groups: ["correctness", "contracts"], meaning: "no known defect class; declared contracts hold" },
];

export function evidenceAxes(groups: readonly CompositeGroupReading[]): AxisReading[] {
	return AXES.map(axis => {
		const members = groups.filter(g => axis.groups.includes(g.id)).map(g => ({ id: g.id, weight: g.weight, score: g.score }));
		const measured = members.filter((g): g is { id: string; weight: number; score: number } => g.score !== null);
		const weight = measured.reduce((sum, g) => sum + g.weight, 0);
		const burden = weight > 0 ? measured.reduce((sum, g) => sum + g.weight * g.score, 0) / weight : null;
		return { id: axis.id, groups: members, burden, meaning: axis.meaning };
	});
}

export function renderAxes(axes: readonly AxisReading[]): string {
	const lines = axes.map(axis => {
		const label = axis.id === "stability" ? "Stability" : "Correctness";
		const value = axis.burden === null ? "unavailable" : `${axis.burden.toFixed(1)}/100`;
		return `  ${label.padEnd(12)} ${value.padStart(12)}  ${axis.meaning} (${axis.groups.map(g => g.id).join(", ") || "no group"})`;
	});
	return ["Evidence axes (lower is better; a grouping, not a second score):", ...lines, "  Requirements: neither axis shows the behaviour is the required one; use spec-audit, e2e scenarios or manual tests."].join("\n");
}
