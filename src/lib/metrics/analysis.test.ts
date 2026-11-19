import { describe, expect, it, vi } from "vitest";
import * as parser from "../../harness/checks/cyclomatic-ast.js";
import { analyzeRepository } from "./analysis.js";
import { sourceLanguage, sourceRole } from "./inventory-roles.js";
import { hashBytes, inventoryHash } from "./inventory.js";
import type { RepositoryInventory } from "./measurement-types.js";

function inventory(sources: Record<string, string>): RepositoryInventory {
	const files = Object.entries(sources).map(([path, content]) => ({ path, content,
		language: sourceLanguage(path), role: sourceRole(path), sha256: hashBytes(content) }));
	return { version: "interlinked-source-roles-v4", root: process.cwd(), discovery: "filesystem",
		files, gaps: [], excluded: [], issues: [], sourceHash: inventoryHash(files), inputHash: inventoryHash(files) };
}

describe("source language eligibility independent of location role", () => {
	it("retains test documentation and metadata identities with explicit analysis exclusions", () => {
		const input = inventory({ "test/README.md": "# Test procedures", "test/reports/.gitkeep": "",
			"test/scenario.json": "{}", "test/case.test.ts": 'it("case", () => {});' });
		const before = inventoryHash(input.files), analysis = analyzeRepository(input);
		expect(analysis.gaps).toEqual([]);
		expect(analysis.files.map(file => file.input.path)).toEqual(["test/case.test.ts"]);
		expect(analysis.exclusions).toEqual([
			expect.objectContaining({ path: "test/README.md", role: "test", reason: expect.stringContaining("documentation") }),
			expect.objectContaining({ path: "test/reports/.gitkeep", role: "test", reason: expect.stringContaining("metadata") }),
			expect.objectContaining({ path: "test/scenario.json", role: "test", reason: expect.stringContaining("configuration") }),
		]);
		expect(input.files.every(file => file.role === "test")).toBe(true);
		expect(inventoryHash(input.files)).toBe(before);
	});

	it("keeps genuine unsupported source and unknown formats as named gaps", () => {
		const analysis = analyzeRepository(inventory({ "src/main.rb": "def main; 1; end\n",
			"test/smoke.sh": "#!/bin/sh\nprintf ok\n", "test/custom.dsl": "run workflow",
			"test/runner": "#!/usr/bin/env python3\nprint(1)\n",
			"test/runner.txt": "#!/usr/bin/env node\nconsole.log(1)\n" }));
		expect(analysis.files).toEqual([]);
		expect(analysis.exclusions).toEqual([]);
		expect(analysis.gaps.map(gap => gap.path)).toEqual(["src/main.rb", "test/smoke.sh", "test/custom.dsl", "test/runner", "test/runner.txt"]);
		expect(analysis.gaps.every(gap => gap.reason.startsWith("No scoring adapter"))).toBe(true);
	});

	it("retains test-role MDX with executable import, export and JSX as an unsupported source gap", () => {
		const input = inventory({ "test/fixture.mdx": "import Widget from './widget.js';\nexport const title = 'fixture';\n\n<Widget />\n" });
		expect(input.files[0]?.role).toBe("test");
		const analysis = analyzeRepository(input);
		expect(analysis.files).toEqual([]);
		expect(analysis.exclusions).toEqual([]);
		expect(analysis.gaps).toEqual([expect.objectContaining({ path: "test/fixture.mdx", role: "test", reason: expect.stringContaining("No scoring adapter") })]);
	});

	it("retains real source parse recovery as a named measurement gap", () => {
		const analysis = analyzeRepository(inventory({ "src/broken.ts": "export function broken( {",
			"test/good.test.ts": 'it("case", () => {});' }));
		expect(analysis.gaps).toEqual([expect.objectContaining({ path: "src/broken.ts", reason: expect.stringContaining("recovery") })]);
		expect(analysis.files.map(file => file.input.path)).toEqual(["test/good.test.ts"]);
	});

	it("retains missing optional parser coverage for every eligible source", () => {
		const parse = vi.spyOn(parser, "parseTsSource").mockReturnValue(null);
		try {
			const analysis = analyzeRepository(inventory({ "index.ts": "export const value = 1;",
				"test/unit.test.js": 'it("case", () => {});', "test/README.md": "# Read me" }));
			expect(analysis.files).toEqual([]);
			expect(analysis.gaps.map(gap => gap.path)).toEqual(["index.ts", "test/unit.test.js"]);
			expect(analysis.gaps.every(gap => gap.reason.includes("Parser unavailable"))).toBe(true);
			expect(analysis.exclusions).toHaveLength(1);
		} finally { parse.mockRestore(); }
	});
});
