import { describe, expect, it } from "vitest";
import { buildActionInventory, type ActionObservation } from "./action-inventory.js";

const observation: ActionObservation = {
	check: "complexity", file: "lib/index.ts", line: 3, subject: "parse",
	message: "Complexity exceeds the selected review threshold", classification: "measurement",
	evidence: "proven", sourceHash: "source-a", policyHash: null,
	nextStep: "Review the branches and decide whether decomposition helps.",
	validation: "Remeasure complexity and run the affected behavioral tests.",
};

describe("shared action inventory", () => {
	it("retains the full list, with stable identities and separate evidence versions", () => {
		const report = buildActionInventory(Array.from({ length: 60 }, (_, i) => ({ ...observation, subject: `function-${i}`, line: i + 1 })));
		expect(report.actions).toHaveLength(60);
		expect(report.modelCalls).toBe(0);
		expect(report.actions[0]?.classification).toBe("measurement");
		const a = buildActionInventory([observation]).actions[0]!;
		const changed = buildActionInventory([{ ...observation, sourceHash: "source-b" }]).actions[0]!;
		expect(a.id).toBe(changed.id);
		expect(a.evidenceId).not.toBe(changed.evidenceId);
		expect(a.inferenceCostUsd).toBe(0);
	});

	it("folds duplicate observations while retaining independent checks for an explicit action", () => {
		const report = buildActionInventory([
			{ ...observation, actionKey: "review-parse" },
			{ ...observation, actionKey: "review-parse" },
			{ ...observation, actionKey: "review-parse", check: "cognitive" },
		]);
		expect(report.observations).toBe(3);
		expect(report.actions).toHaveLength(1);
		expect(report.actions[0]?.evidence.map(row => row.check)).toEqual(["cognitive", "complexity"]);
	});

	it("does not promote a deterministic measurement or an unknown snapshot into a confirmed defect", () => {
		const report = buildActionInventory([{ ...observation, sourceHash: null }]);
		expect(report.actions[0]).toMatchObject({ classification: "measurement", freshness: "unknown", enforcement: "report" });
	});

	it("keeps separate findings at different anchors and policy identities", () => {
		const report = buildActionInventory([observation, { ...observation, subject: "serialize" }, { ...observation, line: 40 }]);
		expect(report.actions).toHaveLength(3);
		const changed = buildActionInventory([{ ...observation, policyHash: "adopted-policy" }]);
		expect(changed.actions[0]?.evidenceId).not.toBe(report.actions.find(row => row.subject === "parse")?.evidenceId);
	});

	it("does not describe merged historical versions or blank identities as one bound snapshot", () => {
		const report = buildActionInventory([observation, { ...observation, sourceHash: "source-b" }]);
		expect(report.actions).toHaveLength(1);
		expect(report.actions[0]?.evidence).toHaveLength(2);
		expect(report.actions[0]?.freshness).toBe("unknown");
		expect(buildActionInventory([{ ...observation, sourceHash: " " }]).actions[0]?.freshness).toBe("unknown");
		expect(buildActionInventory([observation, { ...observation, check: "other", actionKey: "same" }]).actions.every(row => row.freshness === "snapshot_bound")).toBe(true);
	});
	it("does not merge different dependency versions into one bound cross-file snapshot", () => {
		const first = { ...observation, sourceEvidence: [{ file: "lib/parser.ts", sha256: "a".repeat(64), line: 2, role: "producer" as const }] };
		const second = { ...first, sourceEvidence: [{ ...first.sourceEvidence[0]!, sha256: "b".repeat(64) }] };
		const report = buildActionInventory([first, second]);
		expect(report.actions).toHaveLength(1);
		expect(report.actions[0]?.evidence).toHaveLength(2);
		expect(report.actions[0]?.freshness).toBe("unknown");
		expect(buildActionInventory([first, { ...first, message: "Same dependency, another observation" }]).actions[0]?.freshness).toBe("snapshot_bound");
	});

	it("keeps distinct source sites on the same line and preserves suppression and producer references", () => {
		const first = { ...observation, column: 3, startOffset: 20, endOffset: 24,
			suppressed: true, suppression: "inline", producerRefs: ["occurrence:one"] };
		const second = { ...first, column: 11, startOffset: 28, endOffset: 32, producerRefs: ["occurrence:two"] };
		const report = buildActionInventory([first, second]);
		expect(report.actions).toHaveLength(2);
		expect(report.actions[0]?.evidence[0]).toMatchObject({ suppressed: true, suppression: "inline", producerRefs: ["occurrence:one"] });
		expect(report.actions.every(row => row.classification === "measurement" && row.enforcement === "report")).toBe(true);
		const changed = buildActionInventory([{ ...first, sourceHash: "changed" }]);
		expect(changed.actions[0]?.id).toBe(report.actions[0]?.id);
		expect(buildActionInventory([{ ...first, actionKey: "joined" }, { ...second, actionKey: "joined" }]).actions).toHaveLength(1);
	});
});
