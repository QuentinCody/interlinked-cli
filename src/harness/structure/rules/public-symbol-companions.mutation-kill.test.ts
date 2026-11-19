import { describe, expect, it } from "vitest";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode } from "../types.js";
import { checkPublicSymbolCompanions } from "./public-symbol-companions.js";

// Census fault: test companions were left out of `allCompanions` (docs/reviews/kill-proof-census-e2e-structure.md #22).
describe("checkPublicSymbolCompanions — a test companion counts", () => {
	// test-contract: invariant — a changed public symbol whose only companion is an untouched test is flagged, naming that test as a required update
	it("flags a symbol whose only companion is an untouched test", () => {
		const g = new ArtifactGraph();
		const sym: ArtifactNode = { id: makeGlobalRef("public_symbol", "foo"), kind: "public_symbol", label: "foo", file: "src/foo.ts", provenance: "declared", determinism_ceiling: "fully_deterministic" };
		const test: ArtifactNode = { id: makeGlobalRef("test", "foo-test"), kind: "test", label: "foo-test", file: "src/foo.test.ts", provenance: "declared", determinism_ceiling: "fully_deterministic" };
		g.addNode(sym);
		g.addNode(test);
		g.addEdge({ id: makeEdgeId(sym.id, test.id), kind: "tests", from: sym.id, to: test.id, provenance: "declared", confidence: 1 });
		const findings = checkPublicSymbolCompanions(g, ["src/foo.ts"]);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.affected_files).toEqual(["src/foo.test.ts"]);
		expect(findings[0]?.required_updates?.map(u => u.file)).toEqual(["src/foo.test.ts"]);
	});
	// test-contract: invariant — when the test companion is changed too, nothing is flagged
	it("stays silent when the test companion is in the changed files", () => {
		const g = new ArtifactGraph();
		const sym: ArtifactNode = { id: makeGlobalRef("public_symbol", "foo"), kind: "public_symbol", label: "foo", file: "src/foo.ts", provenance: "declared", determinism_ceiling: "fully_deterministic" };
		const test: ArtifactNode = { id: makeGlobalRef("test", "foo-test"), kind: "test", label: "foo-test", file: "src/foo.test.ts", provenance: "declared", determinism_ceiling: "fully_deterministic" };
		g.addNode(sym);
		g.addNode(test);
		g.addEdge({ id: makeEdgeId(sym.id, test.id), kind: "tests", from: sym.id, to: test.id, provenance: "declared", confidence: 1 });
		expect(checkPublicSymbolCompanions(g, ["src/foo.ts", "src/foo.test.ts"])).toEqual([]);
	});
});
