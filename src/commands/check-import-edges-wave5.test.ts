// Filesystem fixtures exercise import resolution with both valid and broken imports.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectGraph } from "../harness/project-graph.js";
import { listBrokenImportEdges, scanBrokenImports } from "./check-import-edges.js";

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function project(files: Record<string, string>): ProjectGraph {
	const root = mkdtempSync(join(tmpdir(), "check-edges5-"));
	roots.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	const graph = new ProjectGraph(root);
	graph.initialize();
	return graph;
}

const broken = (graph: ProjectGraph): string[] => [...scanBrokenImports(graph)].sort();

describe("X1 an export that follows a comment closing on the same line", () => {
	it("N32: `*/ export function` and `/** doc */ export const` are exports", () => {
		const graph = project({
			"src/use.ts": `import { applyIt, limit } from "./lib";\nvoid applyIt;\nvoid limit;\n`,
			"src/lib.ts": `/**\n * doc\n */ export function applyIt(\n\tx: number,\n) {\n\treturn x;\n}\n\n/** the cap */ export const limit = 1;\n`,
		});
		expect(broken(graph)).toEqual([]);
	});

	it("P22: a name that appears only inside the comment is still missing", () => {
		const graph = project({
			"src/use.ts": `import { gone } from "./lib";\nvoid gone;\n`,
			"src/lib.ts": `/** was: export function gone() {} */ export const kept = 1;\n`,
		});
		expect(listBrokenImportEdges(graph).map((e) => [e.file, e.missingSymbols])).toEqual([["src/use.ts", ["gone"]]]);
	});
});

describe("X2 a dollar sign in an identifier or a file name", () => {
	it("N33: `export function replace$Refs` is found, directly and through `export *`", () => {
		const graph = project({
			"src/index.ts": `import { replace$Refs } from "./utils/index.js";\nimport { replace$Refs as direct } from "./utils/replace-$-refs.js";\nvoid replace$Refs;\nvoid direct;\n`,
			"src/utils/index.ts": `export * from "./replace-$-refs.js";\nexport * from "./other.js";\n`,
			"src/utils/replace-$-refs.ts": `export function replace$Refs(obj: unknown) {\n\treturn obj;\n}\n`,
			"src/utils/other.ts": `export const other = 1;\n`,
		});
		expect(broken(graph)).toEqual([]);
	});

	it("N34: `$` names in const, class, type, enum and default-import forms are found", () => {
		const graph = project({
			"src/use.ts": `import $dollar from "./dollar";\nimport { a$, B$, C$, D$, E$, f$ } from "./dollar";\nvoid [$dollar, a$, B$, C$, D$, E$, f$];\n`,
			"src/dollar.ts": [
				"export default function $dollar() {}",
				"export const a$ = 1;",
				"export class B$ {}",
				"export interface C$ {}",
				"export type D$ = 1;",
				"export enum E$ { X }",
				"export function* f$() {}",
			].join("\n"),
		});
		expect(broken(graph)).toEqual([]);
	});

	it("P23: a `$` name that the target does not export is still missing", () => {
		const graph = project({
			"src/index.ts": `import { replace$Gone } from "./utils/replace-$-refs.js";\nvoid replace$Gone;\n`,
			"src/utils/replace-$-refs.ts": `export function replace$Refs() {}\n`,
		});
		expect(listBrokenImportEdges(graph).map((e) => e.missingSymbols)).toEqual([["replace$Gone"]]);
	});

	it("P24: a `$` file that does not exist is still a missing file", () => {
		const graph = project({
			"src/index.ts": `import { x } from "./replace-$-gone.js";\nvoid x;\n`,
		});
		expect(listBrokenImportEdges(graph).map((e) => e.verdict)).toEqual(["missing-file"]);
	});
});

describe("X3 SvelteKit generated `./$types`", () => {
	const routes = {
		"src/routes/a/+page.ts": `import type { PageLoad } from "./$types";\nexport const load: PageLoad = () => ({});\n`,
		"src/routes/b/+server.ts": `import type { RequestHandler } from "./$types.js";\nexport const GET: RequestHandler = () => new Response();\n`,
		"src/routes/c/+layout.server.ts": `import type { LayoutServerLoad } from "./$types.d.ts";\nexport const load: LayoutServerLoad = () => ({});\n`,
	};

	it("N35: `./$types`, `./$types.js` and `./$types.d.ts` from a route module get no verdict", () => {
		expect(broken(project(routes))).toEqual([]);
	});

	it("P25: the same specifier from a file that is not a route module is flagged", () => {
		const graph = project({ "src/lib/util.ts": `import type { T } from "./$types";\nexport type U = T;\n` });
		expect(listBrokenImportEdges(graph).map((e) => [e.file, e.verdict])).toEqual([["src/lib/util.ts", "missing-file"]]);
	});

	it("P26: other `$` specifiers from a route module are flagged", () => {
		const graph = project({
			"src/routes/a/+page.ts": `import type { A } from "./$typesX";\nimport type { B } from "../$types";\nimport type { C } from "./$other";\nexport type D = [A, B, C];\n`,
		});
		expect(listBrokenImportEdges(graph).map((e) => e.specifier)).toEqual(["./$typesX", "../$types", "./$other"]);
	});

	it("P27: a `./$types` file that exists is still judged for its names", () => {
		const graph = project({
			"src/routes/a/+page.ts": `import type { Missing } from "./$types";\nexport type M = Missing;\n`,
			"src/routes/a/$types.ts": `export type PageLoad = () => void;\n`,
		});
		expect(listBrokenImportEdges(graph).map((e) => e.missingSymbols)).toEqual([["Missing"]]);
	});
});

describe("X4 a sibling declaration file beside a non-.js target", () => {
	it("N36: `./Button` with Button.jsx and Button.d.ts is judged against the declaration file", () => {
		const graph = project({
			"ui/IconButton.d.ts": `import type { ButtonProps } from "./Button";\nexport interface IconButtonProps extends ButtonProps {}\n`,
			"ui/Button.jsx": `export function Button() { return null; }\n`,
			"ui/Button.d.ts": `export interface ButtonProps { loading?: boolean }\nexport declare function Button(): null;\n`,
		});
		expect(broken(graph)).toEqual([]);
	});

	it("P28: with no sibling declaration file, a name the .jsx lacks is flagged", () => {
		const graph = project({
			"ui/IconButton.d.ts": `import type { ButtonProps } from "./Button";\nexport interface IconButtonProps extends ButtonProps {}\n`,
			"ui/Button.jsx": `export function Button() { return null; }\n`,
		});
		expect(listBrokenImportEdges(graph).map((e) => [e.file, e.missingSymbols])).toEqual([["ui/IconButton.d.ts", ["ButtonProps"]]]);
	});

	it("P29: a declaration file that belongs to another module does not cover the .jsx", () => {
		const graph = project({
			"ui/use.ts": `import type { ButtonProps } from "./Button";\nexport type P = ButtonProps;\n`,
			"ui/Button.jsx": `export function Button() { return null; }\n`,
			"ui/Other.d.ts": `export interface ButtonProps {}\n`,
		});
		expect(broken(graph)).toEqual(["ui/use.ts"]);
	});
});
