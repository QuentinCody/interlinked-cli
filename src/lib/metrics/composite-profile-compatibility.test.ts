import { describe, expect, it } from "vitest";
import { METRIC_CATALOG } from "./catalog-metrics.js";
import { COMPOSITE_GROUPS, COMPOSITE_PROFILE } from "./composite-profile.js";
import { hashBytes } from "./inventory.js";
import { compareScoreSnapshots } from "./score-compare.js";
import type { ScoreSnapshot } from "./score-snapshot.js";

describe("source eligibility and exact typed measurement revision", () => {
	it("changes measurement identity while retaining the existing profile weights and metric catalog", () => {
		expect(COMPOSITE_PROFILE.measurementRevision).toBe("2026-11-17.4");
		expect(COMPOSITE_PROFILE.hash).toBe(hashBytes(JSON.stringify(["2026-11-17.4", COMPOSITE_GROUPS, METRIC_CATALOG])));
		expect(COMPOSITE_PROFILE.hash).not.toBe(hashBytes(JSON.stringify(["2026-09-08.3", COMPOSITE_GROUPS, METRIC_CATALOG])));
	});

	it("withholds deltas between snapshots taken before and after the measurement repair", () => {
		const before: ScoreSnapshot = { schemaVersion: 2, profile: { id: COMPOSITE_PROFILE.id,
			hash: hashBytes(JSON.stringify(["2026-09-08.3", COMPOSITE_GROUPS, METRIC_CATALOG])) },
			registryHash: "same-registry", languages: ["typescript"], rankingEligible: true,
			slopScore: 1, observedScore: 1, sourceHash: "same-source", evidencePolicies: [], rolesVersion: "interlinked-source-roles-v5",
			metrics: [{ id: "types.unsafe", state: "measured", value: 1, score: 1 }] };
		const result = compareScoreSnapshots(before, { ...before,
			profile: { id: COMPOSITE_PROFILE.id, hash: COMPOSITE_PROFILE.hash }, slopScore: 0,
			metrics: [{ id: "types.unsafe", state: "measured", value: 0, score: 0 }] });
		expect(result.comparable).toBe(false);
		expect(result.reasons).toContain("Scoring profiles differ");
		expect(result.compositeDelta).toBeNull();
		expect(result.metrics[0]?.scoreDelta).toBeNull();
	});

	it("withholds deltas between a report made before the linter-exclude role evidence and one made after (2026-11-16.3 against 2026-11-17.1)", () => {
		const earlier: ScoreSnapshot = { schemaVersion: 2, profile: { id: COMPOSITE_PROFILE.id,
			hash: hashBytes(JSON.stringify(["2026-11-16.3", COMPOSITE_GROUPS, METRIC_CATALOG])) },
			registryHash: "same-registry", languages: ["python"], rankingEligible: true,
			slopScore: 1, observedScore: 1, sourceHash: "same-source", evidencePolicies: [], rolesVersion: "interlinked-source-roles-v5",
			metrics: [{ id: "redundancy.clones", state: "measured", value: 7, score: 1 }] };
		const result = compareScoreSnapshots(earlier, { ...earlier, profile: { id: COMPOSITE_PROFILE.id, hash: COMPOSITE_PROFILE.hash } });
		expect(result.comparable).toBe(false);
		expect(result.reasons).toContain("Scoring profiles differ");
		expect(result.compositeDelta).toBeNull();
	});

	it("withholds deltas between a report made before generator-config stopped claiming inputs and one made after (2026-11-17.3 against .4)", () => {
		const earlier: ScoreSnapshot = { schemaVersion: 2, profile: { id: COMPOSITE_PROFILE.id,
			hash: hashBytes(JSON.stringify(["2026-11-17.3", COMPOSITE_GROUPS, METRIC_CATALOG])) },
			registryHash: "same-registry", languages: ["python"], rankingEligible: true,
			slopScore: 1, observedScore: 1, sourceHash: "same-source", evidencePolicies: [], rolesVersion: "interlinked-source-roles-v5",
			metrics: [{ id: "redundancy.clones", state: "measured", value: 7, score: 1 }] };
		const result = compareScoreSnapshots(earlier, { ...earlier, profile: { id: COMPOSITE_PROFILE.id, hash: COMPOSITE_PROFILE.hash } });
		expect(result.comparable).toBe(false);
		expect(result.compositeDelta).toBeNull();
	});

	it("withholds deltas between a report made before header banners set files aside and one made after (2026-11-17.2 against .3)", () => {
		const earlier: ScoreSnapshot = { schemaVersion: 2, profile: { id: COMPOSITE_PROFILE.id,
			hash: hashBytes(JSON.stringify(["2026-11-17.2", COMPOSITE_GROUPS, METRIC_CATALOG])) },
			registryHash: "same-registry", languages: ["python"], rankingEligible: true,
			slopScore: 1, observedScore: 1, sourceHash: "same-source", evidencePolicies: [], rolesVersion: "interlinked-source-roles-v5",
			metrics: [{ id: "redundancy.clones", state: "measured", value: 7, score: 1 }] };
		const result = compareScoreSnapshots(earlier, { ...earlier, profile: { id: COMPOSITE_PROFILE.id, hash: COMPOSITE_PROFILE.hash } });
		expect(result.comparable).toBe(false);
		expect(result.compositeDelta).toBeNull();
	});

	it("withholds deltas between a report made before generator evidence and the role `unlinted` and one made after (2026-11-17.1 against .2)", () => {
		const earlier: ScoreSnapshot = { schemaVersion: 2, profile: { id: COMPOSITE_PROFILE.id,
			hash: hashBytes(JSON.stringify(["2026-11-17.1", COMPOSITE_GROUPS, METRIC_CATALOG])) },
			registryHash: "same-registry", languages: ["python"], rankingEligible: true,
			slopScore: 1, observedScore: 1, sourceHash: "same-source", evidencePolicies: [], rolesVersion: "interlinked-source-roles-v5",
			metrics: [{ id: "redundancy.clones", state: "measured", value: 7, score: 1 }] };
		const result = compareScoreSnapshots(earlier, { ...earlier, profile: { id: COMPOSITE_PROFILE.id, hash: COMPOSITE_PROFILE.hash } });
		expect(result.comparable).toBe(false);
		expect(result.compositeDelta).toBeNull();
	});

	it("withholds deltas between a report made before the shared source roles and the minified-shape rule and one made after (2026-11-16.2 against .3)", () => {
		const base: ScoreSnapshot = { schemaVersion: 2, profile: { id: COMPOSITE_PROFILE.id,
			hash: hashBytes(JSON.stringify(["2026-11-16.2", COMPOSITE_GROUPS, METRIC_CATALOG])) },
			registryHash: "same-registry", languages: ["typescript"], rankingEligible: true,
			slopScore: 1, observedScore: 1, sourceHash: "same-source", evidencePolicies: [], rolesVersion: "interlinked-source-roles-v5",
			metrics: [{ id: "correctness.findings", state: "measured", value: 13, score: 1 }] };
		const result = compareScoreSnapshots(base, { ...base, profile: { id: COMPOSITE_PROFILE.id, hash: COMPOSITE_PROFILE.hash } });
		expect(result.comparable).toBe(false);
		expect(result.reasons).toContain("Scoring profiles differ");
		expect(result.compositeDelta).toBeNull();
	});
});
