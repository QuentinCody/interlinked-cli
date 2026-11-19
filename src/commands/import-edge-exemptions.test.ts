// Tests for import-edge-exemptions.ts: pure path rules that give a broken-imports
// edge "no verdict". Real filesystem for the submodule rule; no mocks.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	augmentedModuleTargets,
	declarationFileOf,
	hasNodeModulesSegment,
	isFixtureOrTemplatePath,
	isInsideGitSubmodule,
	isNonProductImporter,
	typeScriptSourceOf,
} from "./import-edge-exemptions.js";

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "edge-exempt-"));
	roots.push(root);
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(join(root, rel, ".."), { recursive: true });
		writeFileSync(join(root, rel), content, "utf-8");
	}
	return root;
}

describe("hasNodeModulesSegment", () => {
	it("P1: a node_modules path segment anywhere in the specifier matches", () => {
		expect(hasNodeModulesSegment("./a/node_modules/b")).toBe(true);
		expect(hasNodeModulesSegment("../node_modules")).toBe(true);
	});

	it("N1: a name that merely contains the words does not match", () => {
		expect(hasNodeModulesSegment("./my_node_modules/x")).toBe(false);
		expect(hasNodeModulesSegment("./node_modules_x")).toBe(false);
	});
});

describe("isFixtureOrTemplatePath", () => {
	it("P2: fixture, testdata and template directories match, including a `-fixtures` suffix", () => {
		for (const path of [
			"a/fixtures/x.js",
			"a/__fixtures__/x.js",
			"a/fixture/x.js",
			"a/testdata/x.js",
			"a/test-data/x.js",
			"a/template/x.ts",
			"a/templates/x.ts",
			"a/__tests__/check-parser-fixtures/x.mjs",
		]) {
			expect(isFixtureOrTemplatePath(path)).toBe(true);
		}
	});

	it("N2: tests, scripts, and a fixture-like FILE name do not match", () => {
		for (const path of ["a/tests/x.test.ts", "scripts/x.js", "a/fixtures.ts", "a/fixturesque/x.ts", "a/mytemplate/x.ts"]) {
			expect(isFixtureOrTemplatePath(path)).toBe(false);
		}
	});
});

describe("isInsideGitSubmodule", () => {
	it("P3: a path under a .gitmodules `path =` entry matches, at any ancestor level", () => {
		const root = tree({ ".gitmodules": `[submodule "c"]\n\tpath = libs/c\n\turl = x\n`, "libs/keep.txt": "" });
		expect(isInsideGitSubmodule(join(root, "libs/c/src/x"))).toBe(true);
		expect(isInsideGitSubmodule(join(root, "libs/c"))).toBe(true);
	});

	it("N3: a sibling directory with the same prefix, and a tree with no .gitmodules, do not match", () => {
		const root = tree({ ".gitmodules": `[submodule "c"]\n\tpath = libs/c\n`, "libs/keep.txt": "" });
		expect(isInsideGitSubmodule(join(root, "libs/cc/x"))).toBe(false);
		const bare = tree({ "libs/keep.txt": "" });
		expect(isInsideGitSubmodule(join(bare, "libs/c/x"))).toBe(false);
	});
});

describe("augmentedModuleTargets", () => {
	it("P5: a relative `declare module` resolves to its target, a .js specifier to the .ts source", () => {
		const root = tree({
			"src/index.ts": "export const a = 1;\n",
			"src/config.ts": `declare module './index.js' {\n\texport interface Region {}\n}\n`,
			"src/other.ts": `declare module "./lib" { }\n`,
			"src/lib.ts": "export const l = 1;\n",
		});
		const found = augmentedModuleTargets([join(root, "src/config.ts"), join(root, "src/other.ts")]);
		expect([...found].sort()).toEqual([join(root, "src/index.ts"), join(root, "src/lib.ts")]);
	});

	it("N5: a bare-package augmentation and a file without one give nothing", () => {
		const root = tree({
			"src/a.ts": `declare module 'express' { interface X {} }\n`,
			"src/b.ts": "export const b = 1;\n",
		});
		expect(augmentedModuleTargets([join(root, "src/a.ts"), join(root, "src/b.ts"), join(root, "gone.ts")]).size).toBe(0);
	});
});

describe("typeScriptSourceOf", () => {
	it("P4: a compiled file with a TypeScript sibling maps to that sibling", () => {
		const root = tree({ "a.js": "", "a.ts": "", "b.mjs": "", "b.mts": "", "c.cjs": "", "c.cts": "", "d.jsx": "", "d.tsx": "" });
		expect(typeScriptSourceOf(join(root, "a.js"))).toBe(join(root, "a.ts"));
		expect(typeScriptSourceOf(join(root, "b.mjs"))).toBe(join(root, "b.mts"));
		expect(typeScriptSourceOf(join(root, "c.cjs"))).toBe(join(root, "c.cts"));
		expect(typeScriptSourceOf(join(root, "d.jsx"))).toBe(join(root, "d.tsx"));
	});

	it("N4: no sibling, or a non-compiled extension, maps to null", () => {
		const root = tree({ "a.js": "", "b.ts": "", "c.json": "" });
		expect(typeScriptSourceOf(join(root, "a.js"))).toBeNull();
		expect(typeScriptSourceOf(join(root, "b.ts"))).toBeNull();
		expect(typeScriptSourceOf(join(root, "c.json"))).toBeNull();
	});
});

describe("isNonProductImporter", () => {
	it("P6: eval, bench, scratch, fixture, vendor and generated-source importers match", () => {
		for (const path of [
			"evals/tasks/bench/files/t1/src/a.test.ts",
			"bench/run.ts",
			"packages/x/benchmarks/a.ts",
			".scratch/a.ts",
			"scratch/a.ts",
			"a/fixtures/x.js",
			"a/template/x.ts",
			"vendor/lib/x.ts",
			"src/api/generated/client.ts",
			"src/api.gen.ts",
		]) {
			expect(isNonProductImporter(path), path).toBe(true);
		}
	});

	it("N6: product, test, script and declaration-file importers do not match", () => {
		for (const path of [
			"src/a.ts",
			"tests/a.test.ts",
			"src/a.test.ts",
			"scripts/a.js",
			"src/evalsish/a.ts",
			"src/types/api.d.ts",
			"src/fixturesque/a.ts",
		]) {
			expect(isNonProductImporter(path), path).toBe(false);
		}
	});
});

describe("declarationFileOf", () => {
	it("P7: a compiled file with a declaration sibling maps to that declaration file", () => {
		const root = tree({ "a.js": "", "a.d.ts": "", "b.mjs": "", "b.d.mts": "", "c.cjs": "", "c.d.cts": "" });
		expect(declarationFileOf(join(root, "a.js"))).toBe(join(root, "a.d.ts"));
		expect(declarationFileOf(join(root, "b.mjs"))).toBe(join(root, "b.d.mts"));
		expect(declarationFileOf(join(root, "c.cjs"))).toBe(join(root, "c.d.cts"));
	});

	it("N7: no declaration sibling, a mismatched stem, or a non-JavaScript file maps to null", () => {
		const root = tree({ "a.js": "", "other.d.ts": "", "b.ts": "", "b.d.ts": "", "c.json": "" });
		expect(declarationFileOf(join(root, "a.js"))).toBeNull();
		expect(declarationFileOf(join(root, "b.ts"))).toBeNull();
		expect(declarationFileOf(join(root, "c.json"))).toBeNull();
	});
});
