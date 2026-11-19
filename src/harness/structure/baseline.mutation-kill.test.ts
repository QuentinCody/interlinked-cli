import { describe, expect, it } from "vitest";
import { addToBaseline } from "./baseline.js";
import type { BaselineFile, StructureFinding } from "./types.js";

function finding(determinism: StructureFinding["determinism"]): StructureFinding {
	return {
		name: "public_symbol_companion_untouched",
		severity: "warning",
		message: "example",
		file: "src/foo.ts",
		determinism,
		provenance: "declared",
		artifact_kind: "public_symbol",
		artifact_id: "public_symbol:foo",
		required_updates: [{ file: "docs/foo.md", kind: "doc", reason: "needs update" }],
		confidence: 1,
	};
}

describe("addToBaseline — mutation-directed", () => {
	// test-contract: invariant — a finding that differs only by determinism is a distinct baseline entry, not a duplicate
	it("adds an entry that differs only in determinism", () => {
		const empty: BaselineFile = { schema_version: 1, entries: [] };
		const first = addToBaseline(empty, [finding("fully_deterministic")]);
		const second = addToBaseline(first, [finding("heuristic")]);
		expect(second.entries.map((e) => e.determinism)).toEqual(["fully_deterministic", "heuristic"]);
	});
});
