import { describe, expect, it } from "vitest";
import { compareScoreSnapshots } from "./score-compare.js";
import { parseScoreSnapshot, type ScoreSnapshot } from "./score-snapshot.js";

const base: ScoreSnapshot = { schemaVersion: 2, profile: { id: "p", hash: "h" }, registryHash: "r", languages: ["typescript"], rankingEligible: true,
	slopScore: 10, observedScore: 10, sourceHash: "s", evidencePolicies: [], rolesVersion: "interlinked-source-roles-v5",
	metrics: [{ id: "cyclomatic", state: "measured", value: 3, score: 10 }] };
const raw = { schemaVersion: 2, profile: { id: "p", hash: "h" }, registryHash: "r", languages: ["typescript"], rankingEligible: true, slopScore: 10,
	observedScore: 10, sourceHash: "s", metrics: [{ id: "cyclomatic", state: "measured", value: 3, score: 10 }], evidence: [] };

describe("score snapshot carries the roles version", () => {
	it("reads rolesVersion from a v5 report", () => {
		expect(parseScoreSnapshot({ ...raw, rolesVersion: "interlinked-source-roles-v5" }).rolesVersion).toBe("interlinked-source-roles-v5");
	});
	it("reads a report that has none as null, never as a guess", () => {
		expect(parseScoreSnapshot(raw).rolesVersion).toBeNull();
		expect(parseScoreSnapshot({ ...raw, rolesVersion: 5 }).rolesVersion).toBeNull();
	});
});

describe("metrics compare refuses to compare scores made with different roles versions", () => {
	it("compares two scores with the same version", () => {
		const result = compareScoreSnapshots(base, { ...base, slopScore: 5 });
		expect(result.comparable).toBe(true);
		expect(result.reasons).toEqual([]);
	});
	it("is not comparable when the versions differ", () => {
		const result = compareScoreSnapshots({ ...base, rolesVersion: "interlinked-source-roles-v4" }, base);
		expect(result.comparable).toBe(false);
		expect(result.reasons).toContain("Not comparable: roles version differs (interlinked-source-roles-v4 → interlinked-source-roles-v5)");
		expect(result.compositeDelta).toBeNull();
	});
	it("is not comparable when either side has no roles version", () => {
		for (const [before, after] of [[null, base.rolesVersion], [base.rolesVersion, null], [null, null]] as const) {
			const result = compareScoreSnapshots({ ...base, rolesVersion: before }, { ...base, rolesVersion: after });
			expect(result.comparable).toBe(false);
			expect(result.reasons.some(reason => reason.startsWith("Not comparable: roles version"))).toBe(true);
		}
	});
	it("withholds per-metric score deltas too", () => {
		const result = compareScoreSnapshots({ ...base, rolesVersion: null }, { ...base, metrics: [{ id: "cyclomatic", state: "measured", value: 1, score: 2 }] });
		expect(result.metrics[0]?.scoreDelta).toBeNull();
	});
});
