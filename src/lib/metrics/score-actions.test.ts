import { describe, expect, it } from "vitest";
import type { MetricReading } from "./measurement-types.js";
import { compositeScoreActions, type CompositeActionInput } from "./score-actions.js";

function report(): CompositeActionInput {
	return { findings: [], metrics: [], deletionCandidates: [], evidenceIssues: [],
		sourceHash: "source", rulesHash: "policy", registryHash: "detectors",
		scope: { notMeasured: [], discoveryIssues: [] } };
}
function reading(id: string, state: MetricReading["state"], score: number | null): MetricReading {
	return { id, state, score, value: score, numerator: null, denominator: null,
		measuredEntities: state === "measured" ? 3 : 0, eligibleEntities: 3, evidenceIds: [], limitations: [] };
}

describe("score action export", () => {
	it("retains every finding as advisory evidence without turning severity into a defect", () => {
		const input = report();
		input.findings = Array.from({ length: 125 }, (_, i) => ({ id: `evidence-${i}`, metric: "types.unsafe",
			file: "src/app.ts", line: i + 1, endLine: i + 1, severity: "error", evidence: "proven",
			message: `Assertion at location ${i + 1}`, sourceSha256: "file-source", related: [] }));
		const before = JSON.stringify(input);
		const result = compositeScoreActions(input);
		expect(result.actions).toHaveLength(125);
		expect(result.actions.every(row => row.classification === "candidate" && row.enforcement === "report")).toBe(true);
		expect(result.actions[0]?.evidence[0]).toMatchObject({ sourceHash: "file-source", policyHash: "policy", detectorHash: "detectors" });
		expect(result.modelCalls).toBe(0);
		expect(JSON.stringify(input)).toBe(before);
		expect(compositeScoreActions({ ...input, findings: [...input.findings].reverse() })).toEqual(result);
	});

	it("keeps unrelated claims at the same location separate and binds changed source to fresh evidence", () => {
		const input = report();
		input.findings = ["Unverified assertion", "Explicit any"].map((message, i) => ({ id: `id${i}`, metric: "types.unsafe",
			file: "a.ts", line: 2, endLine: 2, severity: "warning", evidence: "heuristic", message, sourceSha256: "before", related: [] }));
		const before = compositeScoreActions(input);
		const after = compositeScoreActions({ ...input, findings: input.findings.map(row => ({ ...row, sourceSha256: "after" })) });
		expect(before.actions).toHaveLength(2);
		expect(after.actions.map(row => row.id)).toEqual(before.actions.map(row => row.id));
		expect(after.actions.map(row => row.evidenceId)).not.toEqual(before.actions.map(row => row.evidenceId));
	});

	it("distinguishes measured burden, unavailable evidence, and inapplicable measurements", () => {
		const input = report();
		input.metrics = [reading("coverage.lines", "missing", null), reading("mutation.survivors", "stale", null),
			reading("cyclomatic", "measured", 12), reading("tokens", "measured", 0), reading("architecture.cycles", "not-applicable", null)];
		input.scope.notMeasured = [{ path: "worker.py", role: "product", reason: "Adapter unavailable" }];
		input.scope.discoveryIssues = ["Unreadable directory"];
		input.evidenceIssues = ["Coverage source hash differs"];
		const result = compositeScoreActions(input);
		expect(result.actions.filter(row => row.classification === "measurement")).toHaveLength(1);
		expect(result.actions.filter(row => row.classification === "evidence_gap")).toHaveLength(5);
		expect(result.actions.flatMap(row => row.evidence).map(row => row.check)).not.toContain("architecture.cycles");
	});

	it("retains deletion blockers and never recommends unconditional removal", () => {
		const input = report();
		input.deletionCandidates = [{ id: "deletion", file: "api.ts", line: 1, endLine: 5, sourceSha256: "file-source",
			signals: ["Disconnected from known entries"], evidenceIds: ["finding"], blockers: ["Public consumers unknown"],
			priority: "inspect", verdict: "candidate", reviewRequired: true }];
		const result = compositeScoreActions(input);
		expect(result.actions[0]?.classification).toBe("candidate");
		expect(result.actions[0]?.evidence[0]?.message).toContain("Public consumers unknown");
		expect(result.actions[0]?.nextSteps.join(" ")).toContain("before proposing removal");
	});

	it("joins detector evidence only when the deletion review explicitly references the same source location", () => {
		const input = report();
		input.findings = [{ id: "finding", metric: "redundancy.unused", file: "api.ts", line: 1, endLine: 5,
			sourceSha256: "file-source", message: "No known consumers", severity: "warning", evidence: "heuristic", related: [] }];
		input.deletionCandidates = [{ id: "deletion", file: "api.ts", line: 1, endLine: 5, sourceSha256: "file-source",
			signals: ["No known consumers"], evidenceIds: ["finding"], blockers: ["External consumers unknown"],
			priority: "inspect", verdict: "candidate", reviewRequired: true }];
		const result = compositeScoreActions(input);
		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]?.evidence).toHaveLength(2);
		expect(compositeScoreActions({ ...input, deletionCandidates: input.deletionCandidates.map(row => ({ ...row, sourceSha256: "other-source" })) }).actions).toHaveLength(2);
	});
});
