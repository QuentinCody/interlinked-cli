import { describe, expect, it } from "vitest";
import { compareFindingDecision, parseFindingLabels } from "./finding-adjudication.js";

describe("directional reference review", () => {
	it("accepts directional agreement without comparing confidence percentages", () => {
		expect(compareFindingDecision("violation", ["violation"])).toBe("aligned");
		expect(compareFindingDecision("premise_wrong", ["explicit_exception"])).toBe("aligned_direction_different_reason");
		expect(compareFindingDecision("violation", ["premise_wrong"])).toBe("disagreement");
		expect(compareFindingDecision("insufficient_evidence", ["violation"])).toBe("uncertain");
	});
	it("requires provenance, complete unique labels and a source-backed rationale", () => {
		const value = { bundleId: "hash", reviewer: "Astra", labels: [{ caseId: "one", acceptable: ["violation"], rationale: "The first handle lacks cleanup when the next open throws.", evidenceIds: ["source"] }] };
		expect(parseFindingLabels(value).reviewer).toBe("Astra");
		expect(() => parseFindingLabels({ ...value, labels: [...value.labels, ...value.labels] })).toThrow();
		expect(() => parseFindingLabels({ ...value, labels: [{ ...value.labels[0], acceptable: [] }] })).toThrow();
	});
});
