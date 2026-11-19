import { describe, expect, it } from "vitest";
import { METRIC_CATALOG } from "./catalog-metrics.js";
import { COMPOSITE_PROFILE } from "./composite-profile.js";
import { compareScoreSnapshots } from "./score-compare.js";
import type { ScoreSnapshot } from "./score-snapshot.js";

/** The profile hash a report carried before the Python adapters (measurementRevision 2026-09-08.4). */
const PRE_PYTHON_PROFILE_HASH = "7c3fc152d5165ac1820172252ddcd23525e68374d46754bf1bc7d049984ec6d3";

function snapshot(hash: string): ScoreSnapshot {
	return { schemaVersion: 2, profile: { id: COMPOSITE_PROFILE.id, hash }, registryHash: "r", languages: ["typescript"], rankingEligible: true,
		slopScore: 10, observedScore: 10, sourceHash: "s", evidencePolicies: [], rolesVersion: "interlinked-source-roles-v5",
		metrics: [{ id: "cyclomatic", state: "measured", value: 3, score: 10 }] };
}

describe("measurement identity after the Python adapters", () => {
	it("moves the measurement revision and the profile hash", () => {
		expect(COMPOSITE_PROFILE.measurementRevision).toBe("2026-11-17.4");
		expect(COMPOSITE_PROFILE.hash).not.toBe(PRE_PYTHON_PROFILE_HASH);
	});

	it("makes metrics compare refuse a report made before Python support against one made after", () => {
		const result = compareScoreSnapshots(snapshot(PRE_PYTHON_PROFILE_HASH), snapshot(COMPOSITE_PROFILE.hash));
		expect(result.comparable).toBe(false);
		expect(result.reasons).toContain("Scoring profiles differ");
		expect(result.compositeDelta).toBeNull();
		expect(result.metrics[0]?.scoreDelta).toBeNull();
	});

	it("declares Python only for the metrics that have a Python adapter", () => {
		const python = METRIC_CATALOG.filter(metric => metric.languages.includes("python")).map(metric => metric.id).sort();
		expect(python).toEqual(["architecture.boundaries", "architecture.cycles", "architecture.reach", "cognitive", "contracts.findings", "cyclomatic", "difficulty",
			"file.lines", "file.top_level", "redundancy.clones", "redundancy.dead_stores", "redundancy.disconnected", "redundancy.unused", "tokens", "types.unsafe"]);
	});
});
