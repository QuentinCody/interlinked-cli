import { describe, expect, it } from "vitest";
import { measureStructure } from "./structure.js";
import { STRUCTURE_PROFILE } from "./score-profile.js";
import { compositeScoreActions, structuralScoreActions, type CompositeActionInput } from "./score-actions.js";

describe("score actions preserve captured locations", () => {
	it("keeps same-line anonymous implementations distinct using their measured spans", () => {
		const callback = "[1].map(v => v ? v ? v ? v ? v ? 1 : 2 : 3 : 4 : 5 : 6);";
		const measured = measureStructure(`${callback} ${callback}`, "example.ts");
		expect(measured.state).toBe("measured");
		if (measured.state !== "measured") throw new Error(measured.reason);
		expect(measured.functions).toHaveLength(2);
		expect(measured.functions[0]?.name).toBe(measured.functions[1]?.name);
		const result = structuralScoreActions({
			schemaVersion: 1, profile: STRUCTURE_PROFILE, profileHash: "profile", rulesHash: "rules", sourceHash: "repository",
			status: "measured", structuralScore: 1, slopScore: null, rankEligible: false, unavailable: [],
			measurement: { modelCalls: 0, repositoryCodeExecuted: false, typescriptVersion: measured.typescriptVersion },
			scope: { discovery: "filesystem", measuredFiles: 1, functions: 2, moduleTokensOutsideFunctions: 0,
				notMeasured: [], discoveryIssues: [], excluded: [], setAside: [] },
			metrics: [{ id: "cyclomatic", weight: 1, aggregate: null, rawMax: 6 }],
			files: [{ ...measured, file: "example.ts", sha256: "captured-source" }],
		});
		expect(result.actions).toHaveLength(2);
		expect(result.actions.map(action => action.evidence[0]?.startOffset))
			.toEqual(measured.functions.map(fn => fn.startOffset));
		expect(result.actions.map(action => action.evidence[0]?.endOffset))
			.toEqual(measured.functions.map(fn => fn.endOffset));
	});

	it("preserves finding and deletion spans without breaking explicitly linked evidence", () => {
		const input: CompositeActionInput = { sourceHash: "repository", rulesHash: "rules", registryHash: "registry",
			metrics: [], evidenceIssues: [], scope: { notMeasured: [], discoveryIssues: [] },
			findings: [{ id: "finding", metric: "redundancy.unused", file: "api.ts", line: 3, endLine: 18,
				severity: "warning", evidence: "heuristic", message: "No known consumers", sourceSha256: "source", related: [] }],
			deletionCandidates: [{ id: "deletion", file: "api.ts", line: 3, endLine: 18, sourceSha256: "source",
				signals: ["No known consumers"], evidenceIds: ["finding"], blockers: ["Public consumers unknown"],
				priority: "inspect", verdict: "candidate", reviewRequired: true }] };
		const result = compositeScoreActions(input);
		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]?.evidence).toHaveLength(2);
		expect(result.actions[0]?.evidence.map(row => row.endLine)).toEqual([18, 18]);
	});
});
