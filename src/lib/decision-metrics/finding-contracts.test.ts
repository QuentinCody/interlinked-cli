import { describe, expect, it } from "vitest";
import { findingContract, FINDING_CONTRACTS, dispositionDirection } from "./finding-contracts.js";

describe("finding review contracts", () => {
	it("provides explicit outcomes and keeps architectural policy requirements visible", () => {
		expect(Object.keys(FINDING_CONTRACTS)).toHaveLength(15);
		expect(findingContract("core_effect").requiresPolicy).toBe(true);
		expect(findingContract("brand_ownership").requiresPolicy).toBe(true);
		expect(findingContract("test_quality").requiresPolicy).toBe(false);
		expect(() => findingContract("toString")).toThrow("Unknown");
	});
	it("separates semantic direction from a precise rejection reason", () => {
		expect(dispositionDirection("premise_wrong")).toBe("clear");
		expect(dispositionDirection("explicit_exception")).toBe("clear");
		expect(dispositionDirection("violation")).toBe("concern");
		expect(dispositionDirection("insufficient_evidence")).toBe("unknown");
	});
});
