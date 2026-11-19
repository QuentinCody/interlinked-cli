// broken-imports on imports that the alias layer resolves (tsconfig paths, workspace packages, $lib).
// Resolving an alias makes more edges judgeable, so each MUST-FIRE case has a MUST-NOT-FIRE twin.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectGraph } from "../harness/project-graph.js";
import { scanBrokenImports } from "./check-import-edges.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function broken(files: Record<string, string>): string[] {
	const root = mkdtempSync(join(tmpdir(), "check-edges-alias-"));
	roots.push(root);
	for (const [rel, content] of Object.entries({ "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["src/lib/*"]}}}', ...files })) {
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), content);
	}
	const graph = new ProjectGraph(root);
	graph.initialize();
	return [...scanBrokenImports(graph)].sort();
}

describe("broken-imports through aliases: MUST-FIRE", () => {
	it("P1: a named import that an alias-resolved module does not export fires", () => {
		expect(broken({ "src/lib/a.ts": "export const present = 1;\n", "src/main.ts": "import { absent } from '@lib/a';\nexport const m = absent;\n" })).toEqual(["src/main.ts"]);
	});
	it("P3: a missing name behind an export * barrel with ordinary exports still fires", () => {
		const files = { "src/lib/env/index.ts": "export * from './env';\n", "src/lib/env/env.ts": "export const A = 1;\n", "src/main.ts": "import { B } from '@lib/env';\nexport const m = B;\n" };
		expect(broken(files)).toEqual(["src/main.ts"]);
	});
	it("P2: a single-line export const with one name still reports a missing sibling name", () => {
		expect(broken({ "src/lib/a.ts": "export const one = 1;\nexport const two = 2;\n", "src/main.ts": "import { three } from '@lib/a';\nexport const m = three;\n" })).toEqual(["src/main.ts"]);
	});
});

describe("broken-imports through aliases: MUST-NOT-FIRE", () => {
	it("N1: names from a multi-line `export const A = x,\\n B = y` statement are not missing", () => {
		const files = { "src/lib/env.ts": "export const A = process.env.A,\n  B = process.env.B,\n  C = process.env.C\n", "src/main.ts": "import { A, B, C } from '@lib/env';\nexport const m = [A, B, C];\n" };
		expect(broken(files)).toEqual([]);
	});
	it("N2: names from a same-line `export const A = 1, B = 2;` statement are not missing", () => {
		const files = { "src/lib/env.ts": "export const A = 1, B = 2;\n", "src/main.ts": "import { A, B } from '@lib/env';\nexport const m = [A, B];\n" };
		expect(broken(files)).toEqual([]);
	});
	it("N5: a multi-declarator export reached through an export * barrel is not missing either", () => {
		const files = {
			"src/lib/env/index.ts": "export * from './env';\n",
			"src/lib/env/env.ts": "export const A = process.env.A,\n  B = process.env.B;\n",
			"src/main.ts": "import { A, B } from '@lib/env';\nexport const m = [A, B];\n",
		};
		expect(broken(files)).toEqual([]);
	});
	it("N3: an alias whose target file does not exist is not judged (only relative imports are)", () => {
		expect(broken({ "src/main.ts": "import { x } from '@lib/missing';\nexport const m = x;\n" })).toEqual([]);
	});
	it("N4: a named import that the alias-resolved module exports is not flagged", () => {
		expect(broken({ "src/lib/a.ts": "export const present = 1;\n", "src/main.ts": "import { present } from '@lib/a';\nexport const m = present;\n" })).toEqual([]);
	});
});
