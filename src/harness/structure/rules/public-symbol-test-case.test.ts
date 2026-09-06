import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { ArtifactGraph } from "../artifact-graph.js";
import type { ArtifactNode, Provenance } from "../types.js";
import { checkPublicSymbolTestCase } from "./public-symbol-test-case.js";

function addSymbolNode(
	graph: ArtifactGraph,
	id: string,
	label: string,
	file: string,
	provenance: Provenance = "declared",
): void {
	const node: ArtifactNode = {
		id: `public_symbol:${id}`,
		kind: "public_symbol",
		label,
		file,
		provenance,
		determinism_ceiling: "fully_deterministic",
	};
	graph.addNode(node);
}

function addTestNode(
	graph: ArtifactGraph,
	id: string,
	label: string,
	file: string,
	provenance: Provenance = "declared",
): void {
	const node: ArtifactNode = {
		id: `test:${id}`,
		kind: "test",
		label,
		file,
		provenance,
		determinism_ceiling: "fully_deterministic",
	};
	graph.addNode(node);
}

function linkCompanion(graph: ArtifactGraph, symbolId: string, testId: string): void {
	graph.addEdge({
		id: `edge:${symbolId}->${testId}`,
		kind: "tests",
		from: `test:${testId}`,
		to: `public_symbol:${symbolId}`,
		provenance: "declared",
		confidence: 1.0,
	});
}

describe("checkPublicSymbolTestCase", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pstest-case-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function writeFile(relPath: string, content: string): void {
		const abs = join(tmp, relPath);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content, "utf-8");
	}

	it("returns no findings when the source file is not in changedFiles", () => {
		const graph = new ArtifactGraph();
		addSymbolNode(graph, "foo", "Foo", "src/foo.ts");
		addTestNode(graph, "foo", "foo.test", "src/foo.test.ts");
		linkCompanion(graph, "foo", "foo");
		writeFile("src/foo.test.ts", "describe('Bar', () => {});");

		const findings = checkPublicSymbolTestCase(graph, ["src/other.ts"], tmp);
		expect(findings).toEqual([]);
	});

	it("returns no findings when a test file references the symbol by name", () => {
		const graph = new ArtifactGraph();
		addSymbolNode(graph, "foo", "Foo", "src/foo.ts");
		addTestNode(graph, "foo", "foo.test", "src/foo.test.ts");
		linkCompanion(graph, "foo", "foo");
		writeFile("src/foo.test.ts", "import { Foo } from './foo';\ndescribe('Foo', () => {});");

		const findings = checkPublicSymbolTestCase(graph, ["src/foo.ts"], tmp);
		expect(findings).toEqual([]);
	});

	it("flags a changed symbol whose companion test file has no reference", () => {
		const graph = new ArtifactGraph();
		addSymbolNode(graph, "foo", "Foo", "src/foo.ts");
		addTestNode(graph, "foo", "foo.test", "src/foo.test.ts");
		linkCompanion(graph, "foo", "foo");
		writeFile("src/foo.test.ts", "describe('Baz', () => { expect(1).toBe(1); });");

		const findings = checkPublicSymbolTestCase(graph, ["src/foo.ts"], tmp);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).name).toBe("public_symbol_test_case_missing");
		expect(nonNull(findings[0]).severity).toBe("warning");
		expect(nonNull(findings[0]).message).toContain("Foo");
	});

	it("flags when the test file is missing from disk", () => {
		const graph = new ArtifactGraph();
		addSymbolNode(graph, "foo", "Foo", "src/foo.ts");
		addTestNode(graph, "foo", "foo.test", "src/foo.test.ts");
		linkCompanion(graph, "foo", "foo");
		// Note: no writeFile — the test file is not on disk.

		const findings = checkPublicSymbolTestCase(graph, ["src/foo.ts"], tmp);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).affected_files).toEqual(["src/foo.test.ts"]);
	});

	it("treats an unreadable companion test path (a directory, not a file) as non-referencing", () => {
		const graph = new ArtifactGraph();
		addSymbolNode(graph, "foo", "Foo", "src/foo.ts");
		addTestNode(graph, "foo", "foo.test", "src/foo.test.ts");
		linkCompanion(graph, "foo", "foo");
		// existsSync() is true (it's a real directory) but readFileSync() throws
		// EISDIR — exercising the catch branch in readCompanionTestContent,
		// distinct from the "missing from disk" case above.
		mkdirSync(join(tmp, "src", "foo.test.ts"), { recursive: true });

		const findings = checkPublicSymbolTestCase(graph, ["src/foo.ts"], tmp);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).affected_files).toEqual(["src/foo.test.ts"]);
	});

	it("skips the rule entirely when the symbol has no companion tests", () => {
		const graph = new ArtifactGraph();
		addSymbolNode(graph, "foo", "Foo", "src/foo.ts");
		// No test node / edge

		const findings = checkPublicSymbolTestCase(graph, ["src/foo.ts"], tmp);
		expect(findings).toEqual([]);
	});

	it("passes when at least one of multiple companion tests references the symbol", () => {
		const graph = new ArtifactGraph();
		addSymbolNode(graph, "foo", "Foo", "src/foo.ts");
		addTestNode(graph, "foo-a", "foo.test.a", "src/foo.test.ts");
		addTestNode(graph, "foo-b", "foo.integration", "src/foo.integration.test.ts");
		linkCompanion(graph, "foo", "foo-a");
		linkCompanion(graph, "foo", "foo-b");
		writeFile("src/foo.test.ts", "describe('unrelated', () => { expect(1).toBe(1); });");
		writeFile(
			"src/foo.integration.test.ts",
			"import { Foo } from '../foo'; test('x', () => { new Foo(); });",
		);

		const findings = checkPublicSymbolTestCase(graph, ["src/foo.ts"], tmp);
		expect(findings).toEqual([]);
	});

	it("escapes regex metacharacters in symbol names before matching", () => {
		const graph = new ArtifactGraph();
		// A symbol label containing a dollar sign — legal identifier, but regex-meaningful.
		addSymbolNode(graph, "weird", "$foo", "src/weird.ts");
		addTestNode(graph, "weird", "weird.test", "src/weird.test.ts");
		linkCompanion(graph, "weird", "weird");
		writeFile("src/weird.test.ts", "// references $foo here\nexpect($foo).toBe(1);");

		const findings = checkPublicSymbolTestCase(graph, ["src/weird.ts"], tmp);
		expect(findings).toEqual([]);
	});

	it("requires a word-boundary match (prefix-substring doesn't count)", () => {
		const graph = new ArtifactGraph();
		addSymbolNode(graph, "bar", "Bar", "src/bar.ts");
		addTestNode(graph, "bar", "bar.test", "src/bar.test.ts");
		linkCompanion(graph, "bar", "bar");
		// "Barricade" contains "Bar" as a substring but not as a word.
		writeFile("src/bar.test.ts", "describe('Barricade', () => {});");

		const findings = checkPublicSymbolTestCase(graph, ["src/bar.ts"], tmp);
		expect(findings).toHaveLength(1);
	});

	it("marks determinism fully_deterministic when both symbol and tests are declared", () => {
		const graph = new ArtifactGraph();
		addSymbolNode(graph, "foo", "Foo", "src/foo.ts", "declared");
		addTestNode(graph, "foo", "foo.test", "src/foo.test.ts", "declared");
		linkCompanion(graph, "foo", "foo");
		writeFile("src/foo.test.ts", "describe('unrelated-declared', () => {});");

		const findings = checkPublicSymbolTestCase(graph, ["src/foo.ts"], tmp);
		expect(nonNull(findings[0]).determinism).toBe("fully_deterministic");
		expect(nonNull(findings[0]).confidence).toBe(1.0);
	});

	it("marks determinism partially_deterministic when any side is inferred", () => {
		const graph = new ArtifactGraph();
		addSymbolNode(graph, "foo", "Foo", "src/foo.ts", "inferred");
		addTestNode(graph, "foo", "foo.test", "src/foo.test.ts", "declared");
		linkCompanion(graph, "foo", "foo");
		writeFile("src/foo.test.ts", "describe('unrelated-inferred', () => {});");

		const findings = checkPublicSymbolTestCase(graph, ["src/foo.ts"], tmp);
		expect(nonNull(findings[0]).determinism).toBe("partially_deterministic");
		expect(nonNull(findings[0]).confidence).toBe(0.75);
	});
});
