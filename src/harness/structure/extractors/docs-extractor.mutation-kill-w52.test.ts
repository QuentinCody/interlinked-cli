import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyFile, extract, metadata } from "./docs-extractor.js";

describe("docs-extractor — metadata literals (must fire)", () => {
	it("supported_patterns is the exact four-pattern array", () => {
		expect(metadata.supported_patterns).toEqual(["*.md", "*.mdx", "*.rst", "README*"]);
	});

	it("provenance is exactly 'inferred'", () => {
		expect(metadata.provenance).toBe("inferred");
	});

	it("max_determinism is exactly 'heuristic'", () => {
		expect(metadata.max_determinism).toBe("heuristic");
	});
});

describe("docs-extractor — classifyFile (must fire)", () => {
	it("rejects a non-doc file whose name merely CONTAINS 'README' but does not start with it", () => {
		// name doesn't start with README (anchor matters) and extension isn't a doc extension.
		const result = classifyFile("root", "folder/xREADME.txt");
		expect(result.nodes.length).toBe(0);
		expect(result.edges.length).toBe(0);
	});

	it("builds a dash-joined, extension-stripped localId with no injected literal and no leftover extension", () => {
		const result = classifyFile("root", "sub/notes.v2.md");
		expect(result.nodes.length).toBe(1);
		const node = result.nodes[0];
		if (!node) throw new Error("expected a node");
		const id = node.id;
		// Correct behavior: slash -> "-", then exactly the trailing ".v2.md"-style
		// extension removed via a $-anchored regex whose replacement is "".
		expect(id).toContain("sub-notes.v2");
		expect(id).not.toContain("sub-notes.v2.md");
		expect(id).not.toContain("sub-notes.md");
	});

	it("sets kind, provenance, determinism_ceiling and an empty edges array on a classified doc", () => {
		const result = classifyFile("root", "guide/plan.md");
		expect(result.nodes.length).toBe(1);
		const node = result.nodes[0];
		if (!node) throw new Error("expected a node");
		expect(node.kind).toBe("doc");
		expect(node.provenance).toBe("inferred");
		expect(node.determinism_ceiling).toBe("heuristic");
		expect(result.edges).toEqual([]);
		// The "doc" kind string is also used as the global-ref namespace argument;
		// losing it changes the id's shape away from containing "doc".
		expect(node.id).toContain("doc");
	});

	it("classifies a name starting with README (case-insensitive) as readme, not merely containing it", () => {
		expect(classifyFile("root", "MyREADMEFile.md").nodes[0]?.metadata).toEqual({ doc_kind: "guide" });
		// a name that actually starts with README should get doc_kind "readme"
		expect(classifyFile("root", "README.md").nodes[0]?.metadata).toEqual({ doc_kind: "readme" });
	});
});

describe("docs-extractor — walkDir via extract (must fire)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-extractor-w52-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("does not treat a broken symlink as a file (entry.isFile() must be evaluated, not forced true)", () => {
		const target = path.join(tmpDir, "does-not-exist-target");
		const link = path.join(tmpDir, "ghost.md");
		fs.symlinkSync(target, link);
		const result = extract(tmpDir);
		expect(result.nodes.length).toBe(0);
	});

	it("walks into a subdirectory using the real ignoredDirs set without throwing (no .gitignore present)", () => {
		const subDir = path.join(tmpDir, "nested");
		fs.mkdirSync(subDir);
		fs.writeFileSync(path.join(subDir, "guide.md"), "# hello");
		let result: ReturnType<typeof extract> | undefined;
		expect(() => {
			result = extract(tmpDir);
		}).not.toThrow();
		expect(result?.nodes.length).toBe(1);
	});
});

describe("docs-extractor — extract() top-level output (must fire)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-extractor-w52-extract-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns an empty edges array alongside discovered doc nodes", () => {
		fs.writeFileSync(path.join(tmpDir, "readme.md"), "# hi");
		const result = extract(tmpDir);
		expect(result.nodes.length).toBe(1);
		expect(result.edges).toEqual([]);
	});
});
