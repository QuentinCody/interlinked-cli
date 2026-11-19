import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCORE_ROLES_VERSION } from "./inventory-refine.js";
import { addFileAt, classifyFileAt, createPopulation, decideRole, partitionSources, POPULATION_LISTED_CAP, summarizeInventoryPopulation } from "./role-population.js";
import type { RepositoryInventory } from "./measurement-types.js";

const BUNDLE = `${"var f=function(a,b){return a+b},x=f(1,2),y=f(x,3);".repeat(600)}\n`;
const roots: string[] = [];
function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "role-population-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("decideRole", () => {
	it("applies the v5 path evidence", () => {
		expect(decideRole("libs/x.min.js", "x")).toMatchObject({ role: "vendor", evidence: { kind: "tool-path" } });
		expect(decideRole("src/api_pb.ts", "x")).toMatchObject({ role: "generated" });
	});
	it("applies the v5 shape evidence to a product file", () => {
		expect(decideRole("src/app.js", BUNDLE)).toMatchObject({ role: "generated", evidence: { kind: "shape" } });
	});
	it("keeps hand-written product code", () => {
		expect(decideRole("src/app.ts", "export const a = 1;\n")).toMatchObject({ role: "product", evidence: null });
	});
});

describe("linter excludes (tool-config evidence)", () => {
	const files = { "pyproject.toml": '[tool.ruff]\nextend-exclude = ["src/_api"]\n', "src/_api/client.py": "x = 1\n", "src/app.py": "y = 2\n", "tests/test_a.py": "z = 3\n" };
	it("P1: classifyFileAt, decideRole with a root and partitionSources move the excluded path and list it with its rule", () => {
		const root = tree(files);
		expect(classifyFileAt(root, "src/_api/client.py").decision).toMatchObject({ role: "unlinted", evidence: { kind: "tool-config", detail: "ruff extend-exclude `src/_api` (pyproject.toml:2)" } });
		expect(decideRole("src/_api/client.py", "x = 1\n", root).role).toBe("unlinted");
		expect(decideRole("src/_api/client.py", "x = 1\n").role).toBe("product");
		const sources = ["src/_api/client.py", "src/app.py", "tests/test_a.py"].map((file) => ({ file, content: "x = 1\n" }));
		const { kept, population } = partitionSources(sources, root);
		expect(kept.map((s) => s.file)).toEqual(["src/app.py", "tests/test_a.py"]);
		expect(population.setAside.byEvidence["tool-config"]).toBe(1);
		expect(population.setAside.toolConfig).toEqual([{ rule: "ruff extend-exclude `src/_api` (pyproject.toml:2)", files: 1 }]);
		expect(population.setAside.byRole).toEqual({ unlinted: 1 });
		expect(population.setAside.listed).toEqual([]);
	});
	it("N1: without a linter exclude (tsconfig exclude only) nothing moves and the rule list is empty", () => {
		const root = tree({ "tsconfig.json": '{ "exclude": ["src/gen"] }', "src/gen/a.ts": "export const a = 1;\n" });
		const population = createPopulation();
		expect(addFileAt(population, root, "src/gen/a.ts").kept).toBe(true);
		expect(population.summary().setAside.toolConfig).toEqual([]);
	});
});

describe("classifyFileAt", () => {
	it("reads only large product files and sets a bundle aside", () => {
		const root = tree({ "site/academy.js": BUNDLE, "src/a.ts": "export const a = 1;\n" });
		expect(classifyFileAt(root, "site/academy.js")).toMatchObject({ decision: { role: "generated", evidence: { kind: "shape" } }, bytes: BUNDLE.length });
		expect(classifyFileAt(root, "src/a.ts")).toMatchObject({ decision: { role: "product" }, bytes: 20 });
	});
	it("keeps a file that is missing, so the caller reports it instead of hiding it", () => {
		expect(classifyFileAt(tree({}), "src/gone.ts")).toMatchObject({ decision: { role: "product" }, bytes: null });
	});
	it("does not follow a symbolic link", () => {
		const root = tree({ "real.js": BUNDLE });
		symlinkSync(join(root, "real.js"), join(root, "link.js"));
		expect(classifyFileAt(root, "real.js").decision.role).toBe("generated");
		expect(classifyFileAt(root, "link.js").decision.role).toBe("product");
	});
	it("counts a file on disk through the population", () => {
		const root = tree({ "site/academy.js": BUNDLE, "src/a.ts": "export const a = 1;\n" });
		const population = createPopulation();
		expect(addFileAt(population, root, "site/academy.js").kept).toBe(false);
		expect(addFileAt(population, root, "src/a.ts")).toMatchObject({ kept: true, decision: { role: "product" } });
		expect(population.summary().setAside.listed[0]).toMatchObject({ file: "site/academy.js", bytes: BUNDLE.length });
	});
});

describe("population summary", () => {
	it("counts every role seen, set-aside files by role and evidence, and the measured remainder", () => {
		const population = createPopulation();
		expect(population.add("src/a.ts", decideRole("src/a.ts", "export const a = 1;\n"), 20)).toBe(true);
		expect(population.add("src/a.test.ts", decideRole("src/a.test.ts", "x"), 1)).toBe(true);
		expect(population.add("site/academy.js", decideRole("site/academy.js", BUNDLE), BUNDLE.length)).toBe(false);
		expect(population.add("libs/x.min.js", decideRole("libs/x.min.js", "x"), 5)).toBe(false);
		expect(population.add("README.md", decideRole("README.md", "x"), 5)).toBe(false);
		const summary = population.summary();
		expect(summary.rolesVersion).toBe(SCORE_ROLES_VERSION);
		expect(summary.files).toBe(5);
		expect(summary.measured).toBe(2);
		expect(summary.roles).toEqual({ documentation: 1, generated: 1, product: 1, test: 1, vendor: 1 });
		expect(summary.setAside.files).toBe(3);
		expect(summary.setAside.byRole).toEqual({ documentation: 1, generated: 1, vendor: 1 });
		expect(summary.setAside.byEvidence).toEqual({ marker: 0, path: 0, shape: 1, "tool-config": 0, "tool-path": 1, attributes: 0, "generator-config": 0, "generator-command": 0, "uniform-structure": 0 });
		expect(summary.setAside.listed.map(entry => entry.file)).toEqual(["site/academy.js", "libs/x.min.js"]);
		expect(summary.setAside.listed[0]).toMatchObject({ role: "generated", evidence: "shape", bytes: BUNDLE.length });
		expect(summary.setAside.omitted).toBe(0);
	});
	it("lists at most the cap and counts the rest as omitted", () => {
		const population = createPopulation();
		for (let i = 0; i < POPULATION_LISTED_CAP + 7; i++) population.add(`vendor/x${i}.js`, decideRole(`vendor/x${i}.js`, "x"), i);
		const summary = population.summary();
		expect(summary.setAside.files).toBe(POPULATION_LISTED_CAP + 7);
		expect(summary.setAside.listed).toHaveLength(POPULATION_LISTED_CAP);
		expect(summary.setAside.omitted).toBe(7);
		expect(summary.setAside.listed[0]?.bytes).toBe(POPULATION_LISTED_CAP + 6);
	});
});

describe("partitionSources", () => {
	it("returns the measured sources in order and the census of all of them", () => {
		const sources = [
			{ file: "a.ts", content: "export const a = 1;\n" },
			{ file: "site/academy.js", content: BUNDLE },
			{ file: "b.test.ts", content: "x" },
			{ file: "vendor/lib/c.js", content: "x" },
		];
		const { kept, population } = partitionSources(sources);
		expect(kept.map(source => source.file)).toEqual(["a.ts", "b.test.ts"]);
		expect(population).toMatchObject({ files: 4, measured: 2, roles: { generated: 1, product: 1, test: 1, vendor: 1 } });
		expect(population.setAside.listed.map(entry => entry.file)).toEqual(["site/academy.js", "vendor/lib/c.js"]);
	});
	it("keeps a source that has no evidence, whatever its size", () => {
		const big = { file: "src/big.ts", content: `${"export const a = 1;\n".repeat(5000)}` };
		expect(partitionSources([big]).kept).toEqual([big]);
	});
});

describe("summarizeInventoryPopulation", () => {
	it("derives the same summary from a refined inventory", () => {
		const inventory: RepositoryInventory = {
			version: SCORE_ROLES_VERSION, root: "/r", discovery: "git", gaps: [], issues: [], inputHash: "", sourceHash: "",
			files: [
				{ path: "src/a.ts", role: "product", language: "typescript", sha256: "", content: "export const a = 1;\n" },
				{ path: "src/a.test.ts", role: "test", language: "typescript", sha256: "", content: "x" },
			],
			excluded: [
				{ path: "site/academy.js", role: "generated", reason: "r", evidence: { kind: "shape", detail: "d" }, lines: 9 },
				{ path: "docs/x.md", role: "documentation", reason: "r" },
			],
		};
		const summary = summarizeInventoryPopulation(inventory);
		expect(summary).toMatchObject({ rolesVersion: SCORE_ROLES_VERSION, files: 4, measured: 2 });
		expect(summary.setAside.byRole).toEqual({ documentation: 1, generated: 1 });
		expect(summary.setAside.listed.map(entry => entry.file)).toEqual(["site/academy.js"]);
	});
});
