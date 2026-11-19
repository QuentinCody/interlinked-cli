import { describe, expect, it } from "vitest";
import { formatStructureWarnings } from "./structure-formatter.js";
import type { StructureFinding } from "./types.js";

function finding(required_updates: StructureFinding["required_updates"]): StructureFinding {
	return {
		name: "layer_boundary_violation",
		severity: "warning",
		message: "example",
		file: "src/a.ts",
		determinism: "fully_deterministic",
		provenance: "declared",
		artifact_kind: "module",
		artifact_id: "module:a",
		required_updates,
		confidence: 1,
	};
}

describe("formatStructureWarnings — mutation-directed", () => {
	// test-contract: boundary — a finding with no required updates prints no follow-ups header
	it("omits the follow-ups header when there are no required updates", () => {
		const [warning] = formatStructureWarnings([finding([])]);
		expect(warning).toContain("provenance: declared");
		expect(warning).not.toContain("required follow-ups");
	});
	// test-contract: public-api — a finding with one required update prints the header and the entry
	it("prints the follow-ups header with the entry when updates exist", () => {
		const [warning] = formatStructureWarnings([finding([{ file: "docs/a.md", kind: "doc", reason: "r" }])]);
		expect(warning).toContain("required follow-ups:\n    - docs/a.md (doc)");
	});
});
