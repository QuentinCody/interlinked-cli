// Real-filesystem tests for check-import-edges.ts (broken-imports scan) and the
// import-cycle scan over a real ProjectGraph. Every MUST-NOT-FIRE case below is
// a false finding measured on real foreign TypeScript repos; each has a MUST-FIRE
// twin beside it. No mocks: resolution, the export scan and `git check-ignore`
// all run for real.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectGraph } from "../harness/project-graph.js";
import {
	gitIgnoredPaths,
	listBrokenImportEdges,
	scanBrokenImports,
	unresolvedRelativeTarget,
} from "./check-import-edges.js";

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Project {
	root: string;
	graph: ProjectGraph;
}

function project(files: Record<string, string>, opts: { git?: boolean } = {}): Project {
	const root = mkdtempSync(join(tmpdir(), "check-edges-"));
	roots.push(root);
	if (opts.git) execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	const graph = new ProjectGraph(root);
	graph.initialize();
	return { root, graph };
}

function broken(p: Project): string[] {
	return [...scanBrokenImports(p.graph)].sort();
}

describe("A1 broken-imports — default imports", () => {
	it("N1: `import App from './App'` with `export default App;` is not flagged", () => {
		const p = project({
			"src/main.tsx": `import App from "./App";\nApp();\n`,
			"src/App.tsx": `const App = () => 1;\nexport default App;\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("N2: a local name that differs from `export default function Wrapper()` is not flagged", () => {
		const p = project({
			"src/a.tsx": `import CallbacksPage from "./page";\nCallbacksPage();\n`,
			"src/page.tsx": `export default function CallbacksPageWrapper() { return 1; }\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("N3: `import translationsDe from` an object default export is not flagged", () => {
		const p = project({
			"src/i18n.ts": `import translationsDe from "./locales/de/translations";\nvoid translationsDe;\n`,
			"src/locales/de/translations.ts": `export default { hello: "Hallo" };\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("N4: `import * as ns` checks no names", () => {
		const p = project({
			"src/a.ts": `import * as ns from "./b";\nvoid ns;\n`,
			"src/b.ts": `export const x = 1;\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("P1: `import X, { gone } from` still checks the named part", () => {
		const p = project({
			"src/a.ts": `import X, { gone } from "./b";\nvoid X; void gone;\n`,
			"src/b.ts": `export default 1;\nexport const other = 2;\n`,
		});
		expect(broken(p)).toEqual(["src/a.ts"]);
	});
});

describe("A2 broken-imports — relative imports that do not resolve", () => {
	it("P2: a relative import into a folder that does not exist is flagged", () => {
		const p = project({
			"src/__tests__/a.test.ts": `import type { AppVariables } from "../services/context";\n`,
			"src/context.ts": `export interface AppVariables { a: 1 }\n`,
		});
		expect(broken(p)).toEqual(["src/__tests__/a.test.ts"]);
	});

	it("P3: a relative `./missing` file is flagged", () => {
		const p = project({ "src/a.ts": `import { x } from "./missing";\nvoid x;\n` });
		expect(broken(p)).toEqual(["src/a.ts"]);
	});

	it("N5: asset and non-JS targets that exist are not flagged", () => {
		const p = project({
			"src/a.ts": [
				`import logo from "./logo.svg";`,
				`import "./x.css";`,
				`import Comp from "./Comp.vue";`,
				`import notes from "./a.md";`,
				`import raw from "./data.txt?raw";`,
				`import url from "./logo.svg?url";`,
				"void logo; void Comp; void notes; void raw; void url;",
			].join("\n"),
			"src/logo.svg": "<svg/>",
			"src/x.css": "a{}",
			"src/Comp.vue": "<template/>",
			"src/a.md": "# a",
			"src/data.txt": "t",
		});
		expect(broken(p)).toEqual([]);
	});

	it("N6: a `.js` specifier that resolves to a .ts source is not flagged", () => {
		const p = project({
			"src/a.ts": `import { b } from "./b.js";\nvoid b;\n`,
			"src/b.ts": `export const b = 1;\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("N7: a directory with an index file, and a directory with none, are not flagged", () => {
		const p = project({
			"src/a.ts": `import { i } from "./withIndex";\nimport "./plainDir";\nvoid i;\n`,
			"src/withIndex/index.ts": `export const i = 1;\n`,
			"src/plainDir/data.bin": "x",
		});
		expect(broken(p)).toEqual([]);
	});

	it("N8: a bare package specifier is not flagged", () => {
		const p = project({ "src/a.ts": `import { z } from "zod";\nvoid z;\n` });
		expect(broken(p)).toEqual([]);
	});

	it("N9: targets that git ignores (build output, generated clients) are not flagged", () => {
		const p = project(
			{
				".gitignore": "lib/\n/out/\ndist/\nsrc/generated/\n",
				"src/a.ts": [
					`import { l } from "../lib";`,
					`import { d } from "./dist/x";`,
					`import { o } from "../out/y";`,
					`import { g } from "./generated/client";`,
					"void l; void d; void o; void g;",
				].join("\n"),
			},
			{ git: true },
		);
		expect(broken(p)).toEqual([]);
	});

	it("P4: the same shapes are flagged when git does not ignore them", () => {
		const p = project(
			{
				".gitignore": "lib/\n",
				"src/a.ts": `import { d } from "./dist/x";\nvoid d;\n`,
			},
			{ git: true },
		);
		expect(broken(p)).toEqual(["src/a.ts"]);
	});

	it("P5: outside a git repository nothing counts as ignored", () => {
		const p = project({ "src/a.ts": `import { l } from "../lib";\nvoid l;\n` });
		expect(broken(p)).toEqual(["src/a.ts"]);
	});
});

describe("gitIgnoredPaths / unresolvedRelativeTarget", () => {
	it("P6: one batch call answers many paths, with and without a trailing slash trap", () => {
		const p = project({ ".gitignore": "lib/\n/out/\n", "src/keep.ts": "export {}\n" }, { git: true });
		const ignored = gitIgnoredPaths([join(p.root, "lib"), join(p.root, "out"), join(p.root, "src/nope")]);
		expect(ignored.has(join(p.root, "lib"))).toBe(true);
		expect(ignored.has(join(p.root, "out"))).toBe(true);
		expect(ignored.has(join(p.root, "src/nope"))).toBe(false);
	});

	it("N10: an empty batch and a non-repo batch are both empty", () => {
		expect(gitIgnoredPaths([]).size).toBe(0);
		const p = project({ "src/a.ts": "export {}\n" });
		expect(gitIgnoredPaths([join(p.root, "lib")]).size).toBe(0);
	});

	it("N11: unresolvedRelativeTarget is null for resolved, bare and existing-asset edges", () => {
		const base = { fromFile: "/r/a.ts", symbols: [], isTypeOnly: false };
		expect(unresolvedRelativeTarget({ ...base, toFile: "/r/b.ts", specifier: "./b" })).toBeNull();
		expect(unresolvedRelativeTarget({ ...base, toFile: "", specifier: "zod" })).toBeNull();
	});
});

describe("A3 broken-imports — export scan gaps", () => {
	it("N12: `export type * from` and `export * as ns` chains satisfy named imports", () => {
		const p = project({
			"src/a.ts": `import { Clause, ns } from "./index";\nvoid Clause; void ns;\n`,
			"src/index.ts": `export type * from "./clause/index.js";\nexport * as ns from "./other.js";\n`,
			"src/clause/index.ts": `export type Clause = string;\n`,
			"src/other.ts": `export const o = 1;\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("N13: destructured exports satisfy named imports", () => {
		const p = project({
			"src/a.ts": `import { forceLogout, second } from "./slice";\nvoid forceLogout; void second;\n`,
			"src/slice.ts": `export const { forceLogout } = authSlice.actions;\nexport const [first, second] = pair;\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("N14: `export *` chains into a type alias with the `=` on the next line", () => {
		const p = project({
			"src/a.ts": `import type { LayoutMode } from "./barrel";\n`,
			"src/barrel.ts": `export * from "./layout-contract";\n`,
			"src/layout-contract.ts": `export type LayoutMode\n\t= "a" | "b";\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("N15: a target in a skipped directory is not indexed, so no symbol verdict", () => {
		const p = project({
			"vite.config.mjs": `import { hostModules } from "./build/vite-plugin-host-modules.mjs";\nvoid hostModules;\n`,
			"build/vite-plugin-host-modules.mjs": `export function hostModules(processName) { return processName; }\n`,
			"src/scene.ts": `import { loadScene } from "./vendor/loadScene";\nvoid loadScene;\n`,
			"src/vendor/loadScene.ts": `export const loadScene = async (a: string) => a;\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("N16: an `export *` from a target the graph cannot index gives no verdict", () => {
		const p = project({
			"src/a.ts": `import { anything } from "./api";\nvoid anything;\n`,
			"src/api.ts": `export * from "./generated/api";\n`,
			"build/api.ts": "export const unrelated = 1;\n",
		});
		// ./generated/api does not exist: the star chain is unresolved.
		expect(broken(p)).toEqual([]);
	});

	it("N17: CommonJS and .d.ts targets give no verdict", () => {
		const p = project({
			"src/a.ts": [
				`import { one } from "./cjs1";`,
				`import { two } from "./cjs2";`,
				`import { three } from "./cjs3";`,
				`import { four } from "./types";`,
				"void one; void two; void three; void four;",
			].join("\n"),
			"src/cjs1.js": `module.exports = { one: 1 };\n`,
			"src/cjs2.js": `exports.two = 2;\n`,
			"src/cjs3.ts": `const t = 3;\nexport = t;\n`,
			"src/types.d.ts": `declare module "x" {}\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("P7: a named import the target really does not export is flagged", () => {
		const p = project({
			"src/a.ts": `import { nope } from "./real";\nvoid nope;\n`,
			"src/real.ts": `export const there = 1;\n`,
		});
		expect(broken(p)).toEqual(["src/a.ts"]);
	});

	it("P8: a name missing behind a fully resolved `export *` chain is flagged", () => {
		const p = project({
			"src/a.ts": `import { nope } from "./barrel";\nvoid nope;\n`,
			"src/barrel.ts": `export * from "./leaf";\n`,
			"src/leaf.ts": `export const there = 1;\n`,
		});
		expect(broken(p)).toEqual(["src/a.ts"]);
	});
});

describe("A4 import cycles over a real graph", () => {
	function cyclesThrough(p: Project, rel: string): string[][] {
		return p.graph.findCyclesThrough(join(p.root, rel));
	}

	it("P9: a real two-file runtime cycle is reported", () => {
		const p = project({
			"src/a.ts": `import { b } from "./b.js";\nexport const a = b;\n`,
			"src/b.ts": `import { a } from "./a.js";\nexport const b = a;\n`,
		});
		expect(cyclesThrough(p, "src/a.ts")).toHaveLength(1);
	});

	it("N18: JSDoc import() types in comments do not create a cycle", () => {
		const p = project({
			"src/plot.js": `/** @param {import('./other.js').Other} o */\nexport function plot(o) {}\n`,
			"src/other.js": `import { plot } from "./plot.js";\nexport const Other = plot;\n`,
		});
		expect(cyclesThrough(p, "src/plot.js")).toEqual([]);
		expect(p.graph.getDependencies(join(p.root, "src/plot.js"))).toEqual([]);
	});

	it("N19: an all-inline-type import does not close a cycle; a mixed clause does", () => {
		const typeOnly = project({
			"src/a.ts": `import { type B } from "./b.js";\nexport type A = B;\n`,
			"src/b.ts": `import { a } from "./a.js";\nexport const b = a;\nexport type B = 1;\n`,
		});
		expect(cyclesThrough(typeOnly, "src/a.ts")).toEqual([]);
		const mixed = project({
			"src/a.ts": `import { type B, b } from "./b.js";\nexport const a = b;\n`,
			"src/b.ts": `import { a } from "./a.js";\nexport const b = a;\nexport type B = 1;\n`,
		});
		expect(cyclesThrough(mixed, "src/a.ts")).toHaveLength(1);
	});

	it("N20: a lazy dynamic import() back-edge is not a load-time cycle but stays in the graph", () => {
		const p = project({
			"src/a.ts": `import { b } from "./b.js";\nexport const a = b;\n`,
			"src/b.ts": `export async function b() { const m = await import("./a.js"); return m; }\n`,
		});
		expect(cyclesThrough(p, "src/a.ts")).toEqual([]);
		expect(p.graph.getDependents(join(p.root, "src/a.ts"))).toEqual([join(p.root, "src/b.ts")]);
	});
});

describe("A2 replay regressions — extension-shaped specifiers and ignore rules", () => {
	it("N21: a `.jsx` specifier whose source is a .tsx file is not flagged", () => {
		const p = project({
			"src/index.tsx": `import { App } from "./App.jsx";\nApp();\n`,
			"src/App.tsx": `export function App() { return 1; }\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("P10: a `.jsx` specifier with no source under any extension is flagged", () => {
		const p = project({
			"src/index.tsx": `import { Gone } from "./Gone.jsx";\nGone();\n`,
			"src/App.tsx": `export function App() { return 1; }\n`,
		});
		expect(broken(p)).toEqual(["src/index.tsx"]);
	});

	it("N22: an extensionless specifier whose generated source is ignored BY EXTENSION is not flagged", () => {
		const p = project(
			{
				".gitignore": "/src/schema.ts\n",
				"packages/protocol/.gitignore": "src/protocol.*\n",
				"src/load.ts": `import { JsonSchema } from "./schema";\nexport type S = JsonSchema;\n`,
				"packages/protocol/src/index.ts": `import { protocol } from "./protocol";\nexport const p = protocol;\n`,
			},
			{ git: true },
		);
		expect(broken(p)).toEqual([]);
	});

	it("P11: the same extensionless specifiers are flagged when no rule ignores them", () => {
		const p = project(
			{
				".gitignore": "/src/other.ts\n",
				"src/load.ts": `import { JsonSchema } from "./schema";\nexport type S = JsonSchema;\n`,
				"packages/protocol/src/index.ts": `import { protocol } from "./protocol";\nexport const p = protocol;\n`,
			},
			{ git: true },
		);
		expect(broken(p)).toEqual(["packages/protocol/src/index.ts", "src/load.ts"]);
	});
});

describe("A5 per-edge output", () => {
	it("P12: listBrokenImportEdges names file, specifier, verdict, target and symbols", () => {
		const p = project({
			"src/a.ts": `import { gone } from "./b";\nimport { x } from "./missing";\nvoid gone; void x;\n`,
			"src/b.ts": `export const other = 1;\n`,
		});
		expect(listBrokenImportEdges(p.graph)).toEqual([
			{ file: "src/a.ts", specifier: "./b", verdict: "missing-symbol", target: "src/b.ts", missingSymbols: ["gone"] },
			{ file: "src/a.ts", specifier: "./missing", verdict: "missing-file", target: "src/missing", missingSymbols: [] },
		]);
		expect(broken(p)).toEqual(["src/a.ts"]);
	});

	it("N23: a project with only sound imports lists nothing", () => {
		const p = project({
			"src/a.ts": `import { x } from "./b";\nvoid x;\n`,
			"src/b.ts": `export const x = 1;\n`,
		});
		expect(listBrokenImportEdges(p.graph)).toEqual([]);
	});
});

describe("A6 node_modules path and git submodule targets", () => {
	it("N24: a relative specifier with a node_modules segment is not flagged", () => {
		const p = project({
			"src/a.ts": `import { f } from "./circuits/node_modules/@scope/pkg";\nvoid f;\n`,
			"src/b.ts": `import { g } from "../../x/node_modules/y/dist/z";\nvoid g;\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("P13: a similar path without a node_modules segment is flagged", () => {
		const p = project({
			"src/a.ts": `import { f } from "./circuits/my_node_modules/pkg";\nvoid f;\n`,
		});
		expect(broken(p)).toEqual(["src/a.ts"]);
	});

	it("N25: a target inside a .gitmodules path is not flagged", () => {
		const p = project({
			".gitmodules": `[submodule "circuits"]\n\tpath = src/circuits\n\turl = https://example.test/c.git\n`,
			"src/a.ts": `import { C } from "./circuits/src/ts/circuits";\nvoid C;\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("P14: a target outside every .gitmodules path is flagged", () => {
		const p = project({
			".gitmodules": `[submodule "circuits"]\n\tpath = src/circuits\n\turl = https://example.test/c.git\n`,
			"src/a.ts": `import { C } from "./circuits-other/x";\nimport { D } from "./other/y";\nvoid C; void D;\n`,
		});
		expect(broken(p)).toEqual(["src/a.ts"]);
	});
});

describe("A7 fixture and template importers", () => {
	it("N26: importers under fixture, testdata and template directories get no verdict", () => {
		const bad = `import { x } from "./nonexistent-file";\nimport { y } from "./b";\nvoid x; void y;\n`;
		const p = project({
			"tests/fixtures/case/entry.js": bad,
			"tests/__fixtures__/entry.js": bad,
			"pkg/__tests__/check-parser-fixtures/entry.mjs": bad,
			"e2e/scenarios/s/template/scenario.ts": bad,
			"testdata/entry.ts": bad,
			"tests/fixtures/case/b.ts": `export const z = 1;\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("P17: a fixtures-directory module that another file imports is a real module and is judged", () => {
		const p = project({
			"src/__fixtures__/helpers.ts": `import { gone } from "./nope";\nexport const h = gone;\n`,
			"src/a.test.ts": `import { h } from "./__fixtures__/helpers";\nvoid h;\n`,
		});
		expect(broken(p)).toEqual(["src/__fixtures__/helpers.ts"]);
	});

	it("P15: a test or script file outside those directories is still judged", () => {
		const bad = `import { x } from "./nonexistent-file";\nvoid x;\n`;
		const p = project({
			"tests/entry.test.ts": bad,
			"scripts/entry.js": bad,
			"src/fixturesque/entry.ts": bad,
		});
		expect(broken(p)).toEqual(["scripts/entry.js", "src/fixturesque/entry.ts", "tests/entry.test.ts"]);
	});
});

describe("A10 benchmark and eval task trees", () => {
	const bad = `import { x } from "./nonexistent-file";\nvoid x;\n`;

	it("N30: importers under evals, bench, benchmarks and scratch trees get no verdict", () => {
		const p = project({
			"evals/tasks/bench/files/t1/src/a.test.ts": bad,
			"packages/x/bench/run.ts": bad,
			"benchmarks/case/a.ts": bad,
			"scratch/probe/a.ts": bad,
			".scratch/a.ts": bad,
		});
		expect(broken(p)).toEqual([]);
	});

	it("P19: an eval module that live code imports is judged like any other", () => {
		const p = project({
			"evals/helpers.ts": `import { gone } from "./nope";\nexport const h = gone;\n`,
			"src/a.ts": `import { h } from "../evals/helpers";\nvoid h;\n`,
		});
		expect(broken(p)).toEqual(["evals/helpers.ts"]);
	});

	it("P20: lookalike directory names and ordinary test files are still judged", () => {
		const p = project({
			"src/evalsish/a.ts": bad,
			"src/benches/a.ts": bad,
			"tests/a.test.ts": bad,
		});
		expect(broken(p)).toEqual(["src/benches/a.ts", "src/evalsish/a.ts", "tests/a.test.ts"]);
	});
});

describe("A11 JavaScript module typed by a sibling declaration file", () => {
	it("N31: a name that `x.d.ts` exports, beside `x.js`, is not flagged", () => {
		const p = project({
			"src/lib/a.ts": `import { Gate } from "../bindings.js";\nvoid Gate;\n`,
			"src/bindings.js": `export const other = 1;\n`,
			"src/bindings.d.ts": `declare const Gate: unknown;\nexport { Gate };\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("P21: a `.d.ts` that belongs to another module does not cover the `.js` target", () => {
		const p = project({
			"src/lib/a.ts": `import { Gate } from "../bindings.js";\nvoid Gate;\n`,
			"src/bindings.js": `export const other = 1;\n`,
			"src/unrelated.d.ts": `export declare const Gate: unknown;\n`,
		});
		expect(broken(p)).toEqual(["src/lib/a.ts"]);
	});
});

describe("A9 module augmentation", () => {
	it("N29: a name added by `declare module './index.js'` elsewhere is not flagged", () => {
		const p = project({
			"src/index.ts": `export const a = 1;\n`,
			"src/config.ts": `declare module './index.js' {\n\texport interface Region { r: 1 }\n}\n`,
			"src/use.ts": `import type { Region } from "./index.js";\nexport type R = Region;\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("P18: the same import with no augmentation is flagged", () => {
		const p = project({
			"src/index.ts": `export const a = 1;\n`,
			"src/config.ts": `declare module 'express' { interface Region { r: 1 } }\n`,
			"src/use.ts": `import type { Region } from "./index.js";\nexport type R = Region;\n`,
		});
		expect(broken(p)).toEqual(["src/use.ts"]);
	});
});

describe("A8 TypeScript source behind a JavaScript specifier", () => {
	it("N27: a compiled sibling that exports nothing does not hide the .mts/.ts exports", () => {
		const p = project({
			"src/a.mts": `import type { Result } from "./types.mjs";\nimport { run } from "./lib.js";\nvoid run;\nexport const r: Result | null = null;\n`,
			"src/types.mts": `export type Result = { ok: boolean };\n`,
			"src/types.mjs": `export {};\n`,
			"src/lib.ts": `export function run() { return 1; }\n`,
			"src/lib.js": `export {};\n`,
		});
		expect(broken(p)).toEqual([]);
	});

	it("P16: a name that the TypeScript source does not export is flagged", () => {
		const p = project({
			"src/a.mts": `import type { Gone } from "./types.mjs";\nexport const r: Gone | null = null;\n`,
			"src/types.mts": `export type Result = { ok: boolean };\n`,
			"src/types.mjs": `export {};\n`,
		});
		expect(
			listBrokenImportEdges(p.graph).map((e) => [e.specifier, e.verdict, e.target, e.missingSymbols]),
		).toEqual([["./types.mjs", "missing-symbol", "src/types.mts", ["Gone"]]]);
	});

	it("N28: a .js file with no TypeScript sibling is still judged as before", () => {
		const p = project({
			"src/a.ts": `import { gone } from "./b.js";\nvoid gone;\n`,
			"src/b.js": `export const other = 1;\n`,
		});
		expect(broken(p)).toEqual(["src/a.ts"]);
	});
});
