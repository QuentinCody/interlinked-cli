import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactGraph } from "../artifact-graph.js";
import { checkPublicSymbolTestCase } from "./public-symbol-test-case.js";

function graphWith(label: string): ArtifactGraph {
	const graph = new ArtifactGraph();
	graph.addNode({ id: "public_symbol:s", kind: "public_symbol", label, file: "src/a.ts", provenance: "declared", determinism_ceiling: "fully_deterministic" });
	graph.addNode({ id: "test:t", kind: "test", label: "t", file: "src/a.test.ts", provenance: "declared", determinism_ceiling: "fully_deterministic" });
	graph.addEdge({ id: "edge:t", kind: "tests", from: "test:t", to: "public_symbol:s", provenance: "declared", confidence: 1.0 });
	return graph;
}

describe("checkPublicSymbolTestCase identifier boundaries", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pstest-case-kill-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});
	function writeTest(content: string): void {
		const abs = join(tmp, "src/a.test.ts");
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}

	// test-contract: boundary — an identifier that merely starts with the symbol name plus an underscore is not a reference
	it("flags the symbol when the test only mentions foo_x", () => {
		writeTest("expect(foo_x()).toBe(1);\n");
		const findings = checkPublicSymbolTestCase(graphWith("foo"), ["src/a.ts"], tmp);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.affected_files).toEqual(["src/a.test.ts"]);
	});

	// test-contract: boundary — a standalone mention of the symbol name is a reference
	it("accepts the symbol when the test calls foo itself", () => {
		writeTest("expect(foo()).toBe(1);\n");
		expect(checkPublicSymbolTestCase(graphWith("foo"), ["src/a.ts"], tmp)).toEqual([]);
	});
});
