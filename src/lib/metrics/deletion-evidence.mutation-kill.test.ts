import { expect, it } from "vitest";
import type { BehavioralObservations } from "./behavioral-types.js";
import { joinDeletionEvidence } from "./deletion-evidence.js";
import type { StaticMeasurements } from "./static-measurements.js";

function finding(id: string, message: string) {
	return { id, metric: "redundancy.clone", file: "a.ts", line: 2, endLine: 3, sourceSha256: "s", message };
}

function measurements(findings: unknown[]): StaticMeasurements {
	return {
		analysis: { files: [], gaps: [] },
		graph: { dynamic: false, unresolved: [], entries: ["main.ts"], publicEntries: [] },
		metrics: [],
		findings,
	} as unknown as StaticMeasurements;
}

const coverage = {
	kind: "coverage",
	state: "measured",
	evidenceId: "cov",
	issues: [],
	mutants: [],
	coveredFiles: ["a.ts"],
	coverage: [
		{
			path: "a.ts",
			lines: { covered: 3, total: 3 },
			branches: { covered: 0, total: 0 },
			functions: { covered: 1, total: 1 },
			spans: [],
			uncoveredLines: [],
		},
	],
} as unknown as BehavioralObservations;

// test-contract: boundary — one signal and no blockers stays at "inspect"; a second signal promotes it
it("promotes to validate-removal only with more than one signal", () => {
	const [single] = joinDeletionEvidence(measurements([finding("f1", "dup")]), coverage);
	expect(single?.signals).toHaveLength(1);
	expect(single?.blockers).toEqual([]);
	expect(single?.priority).toBe("inspect");

	const [double] = joinDeletionEvidence(
		measurements([finding("f1", "dup"), finding("f2", "dup2")]),
		coverage,
	);
	expect(double?.signals).toHaveLength(2);
	expect(double?.priority).toBe("validate-removal");
});
