import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectGraph } from "../harness/project-graph.js";
import { scanDuplicates } from "./check.js";

const roots: string[] = [];
function duplicates(files: Record<string, string>): string[] {
	const root = mkdtempSync(join(tmpdir(), "check-dupes-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	const graph = new ProjectGraph(root);
	graph.initialize();
	return [...scanDuplicates(graph)].sort();
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("check --only duplicates: MUST-FIRE", () => {
	it("P1: the same named value export in two modules of one package fires", () => {
		expect(duplicates({ "package.json": "{}", "src/a.ts": "export function format() {}\n", "src/b.ts": "export function format() {}\n" })).toEqual(["src/a.ts", "src/b.ts"]);
	});
	it("P2: a barrel that declares its own export fires against the module that also declares it", () => {
		expect(duplicates({ "package.json": "{}", "src/index.ts": "export * from './a';\nexport function format() {}\n", "src/a.ts": "export function format() {}\n" })).toEqual(["src/a.ts", "src/index.ts"]);
	});
	it("P4: a declaration file does not hide a same-named export in a module that is not its implementation", () => {
		expect(duplicates({ "package.json": "{}", "src/types.d.ts": "export declare function format(): void;\n", "src/util.ts": "export function format() {}\n" })).toEqual(["src/types.d.ts", "src/util.ts"]);
	});
	it("P5: an index module that declares a name fires against an ordinary module that declares it", () => {
		expect(duplicates({ "package.json": "{}", "src/a/index.ts": "export const Root = 1;\n", "src/b/root.ts": "export const Root = 2;\n" })).toEqual(["src/a/index.ts", "src/b/root.ts"]);
	});
	it("P8: a module that declares a name another module also imports under a different export still fires", () => {
		const files = { "package.json": "{}", "src/a.ts": "export const Codes = {};\n", "src/b.ts": "export const Codes = { other: 1 };\n", "src/c.ts": "import { Codes } from './a';\nexport const use = Codes;\n" };
		expect(duplicates(files)).toEqual(["src/a.ts", "src/b.ts"]);
	});
	it("P6: two modules with the same file name that export one name still fire", () => {
		expect(duplicates({ "package.json": "{}", "src/a/utils.ts": "export function format() {}\n", "src/b/utils.ts": "export function format() {}\n" })).toEqual(["src/a/utils.ts", "src/b/utils.ts"]);
	});
	it("P7: a differently named module that also exports the name fires against a single file-name sibling", () => {
		expect(duplicates({ "package.json": "{}", "src/a/fields.ts": "export const FIELDS = [];\n", "src/b/row-fields.ts": "export const FIELDS = [];\n" })).toEqual(["src/a/fields.ts", "src/b/row-fields.ts"]);
	});
	it("P3: a convention name exported from two ordinary modules fires", () => {
		expect(duplicates({ "package.json": "{}", "src/lib/a.ts": "export const load = 1;\n", "src/lib/b.ts": "export const load = 2;\n" })).toEqual(["src/lib/a.ts", "src/lib/b.ts"]);
	});
});

describe("check --only duplicates: MUST-NOT-FIRE", () => {
	it("N1: a barrel that only re-exports with export * is not a duplicate of its source", () => {
		expect(duplicates({ "package.json": "{}", "src/index.ts": "export * from './a';\nexport * from './b';\n", "src/a.ts": "export function one() {}\n", "src/b.ts": "export function two() {}\n" })).toEqual([]);
	});
	it("N2: a barrel that names its re-exports is not a duplicate of its source", () => {
		expect(duplicates({ "package.json": "{}", "src/index.ts": "export { one } from './a';\n", "src/a.ts": "export function one() {}\n" })).toEqual([]);
	});
	it("N3: two nested barrels over the same module do not duplicate each other", () => {
		expect(duplicates({ "package.json": "{}", "src/a/index.ts": "export * from './x';\n", "src/b/index.ts": "export * from '../a/x';\n", "src/a/x.ts": "export function one() {}\n" })).toEqual([]);
	});
	it("N11: a module that imports a name and exports it again is re-publishing it, not declaring a second one", () => {
		const files = { "package.json": "{}", "src/a.ts": "export const Codes = {};\n", "src/b/index.ts": "import { Codes } from '../a';\nexport { Codes };\n" };
		expect(duplicates(files)).toEqual([]);
	});
	it("N9: three or more modules with one file name that export one name are a naming convention", () => {
		const files = { "package.json": "{}", "src/a/fields.ts": "export const FIELDS = [];\n", "src/b/fields.ts": "export const FIELDS = [];\n", "src/c/fields.ts": "export const FIELDS = [];\n" };
		expect(duplicates(files)).toEqual([]);
	});
	it("N10: a lone differently named module is not a duplicate of a convention family", () => {
		const files = { "package.json": "{}", "src/a/fields.ts": "export const FIELDS = [];\n", "src/b/fields.ts": "export const FIELDS = [];\n", "src/c/fields.ts": "export const FIELDS = [];\n", "src/d/row-fields.ts": "export const FIELDS = [];\n" };
		expect(duplicates(files)).toEqual([]);
	});
	it("N7: a declaration file beside its implementation is one symbol, not two", () => {
		expect(duplicates({ "package.json": "{}", "src/Badge.d.ts": "export declare function Badge(): void;\n", "src/Badge.jsx": "export function Badge() {}\n" })).toEqual([]);
	});
	it("N8: index modules in different directories that export the same name are not duplicates", () => {
		expect(duplicates({ "package.json": "{}", "src/a/index.ts": "export const Root = 1;\n", "src/b/index.ts": "export const Root = 2;\n" })).toEqual([]);
	});
	it("N4: SvelteKit load, actions and prerender in route files are conventions", () => {
		expect(duplicates({
			"package.json": "{}",
			"src/routes/a/+page.server.ts": "export const load = 1;\nexport const actions = {};\nexport const prerender = true;\n",
			"src/routes/b/+page.server.ts": "export const load = 2;\nexport const actions = {};\nexport const prerender = true;\n",
		})).toEqual([]);
	});
	it("N5: HTTP verb handlers in route modules are conventions", () => {
		expect(duplicates({
			"package.json": "{}",
			"src/routes/a/+server.ts": "export function GET() {}\nexport function POST() {}\n",
			"src/routes/b/+server.ts": "export function GET() {}\nexport function POST() {}\n",
			"app/api/x/route.ts": "export function GET() {}\n",
			"app/api/y/route.ts": "export function GET() {}\n",
		})).toEqual([]);
	});
	it("N6: a route file still fires for a name that is not a convention", () => {
		expect(duplicates({
			"package.json": "{}",
			"src/routes/a/+page.server.ts": "export const load = 1;\nexport function helper() {}\n",
			"src/routes/b/+page.server.ts": "export const load = 2;\nexport function helper() {}\n",
		})).toEqual(["src/routes/a/+page.server.ts", "src/routes/b/+page.server.ts"]);
	});
});
