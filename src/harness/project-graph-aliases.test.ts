import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectGraph } from "./project-graph.js";

const roots: string[] = [];
function build(files: Record<string, string>): { root: string; graph: ProjectGraph } {
	const root = mkdtempSync(join(tmpdir(), "pg-aliases-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	const graph = new ProjectGraph(root);
	graph.initialize();
	return { root, graph };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const MONOREPO = {
	"pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
	"packages/utils/package.json": '{"name":"@x/utils","exports":{"./export":"./dist/export/index.js"}}',
	"packages/utils/src/export/index.ts": "export function exp() { return 1; }\n",
	"apps/api/package.json": '{"name":"api"}',
	"apps/api/tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@api/*":["src/*"],"@x/utils/*":["./node_modules/@x/utils/dist/*"]}}}',
	"apps/api/src/util.ts": "export function util() { return 1; }\n",
	"apps/api/src/main.ts": "import { util } from '@api/util';\nimport { exp } from '@x/utils/export';\nexport const main = [util, exp];\n",
	"apps/web/package.json": '{"name":"web"}',
	"apps/web/svelte.config.js": "export default { kit: {} };\n",
	"apps/web/src/lib/helper.ts": "export function helper() { return 1; }\n",
	"apps/web/src/routes/+page.svelte": "<script lang=\"ts\">\n  import { helper } from '$lib/helper';\n  import { exp } from '@x/utils/export';\n</script>\n",
};

describe("ProjectGraph: alias and workspace imports, single-file components", () => {
	const { root, graph } = build(MONOREPO);
	const abs = (rel: string): string => join(root, rel);
	it("P1: a tsconfig paths alias and a workspace subpath resolve to source files", () => {
		const edges = graph.getDependencies(abs("apps/api/src/main.ts")).map(edge => edge.toFile);
		expect(edges).toEqual([abs("apps/api/src/util.ts"), abs("packages/utils/src/export/index.ts")]);
	});
	it("P2: a component imports through $lib and a workspace package", () => {
		const edges = graph.getDependencies(abs("apps/web/src/routes/+page.svelte")).map(edge => edge.toFile);
		expect(edges).toEqual([abs("apps/web/src/lib/helper.ts"), abs("packages/utils/src/export/index.ts")]);
		expect(graph.getDependents(abs("apps/web/src/lib/helper.ts"))).toEqual([abs("apps/web/src/routes/+page.svelte")]);
	});
	it("P3: components are nodes but not code files", () => {
		expect(graph.allFiles()).not.toContain(abs("apps/web/src/routes/+page.svelte"));
		expect(graph.allNodes()).toContain(abs("apps/web/src/routes/+page.svelte"));
		expect(graph.hasNode(abs("apps/web/src/routes/+page.svelte"))).toBe(true);
		expect(graph.hasFile(abs("apps/web/src/routes/+page.svelte"))).toBe(false);
	});
	it("P4: getDirectExports leaves out names that a barrel gains through export *", () => {
		const barrel = build({ "package.json": "{}", "src/index.ts": "export * from './a';\n", "src/a.ts": "export function one() {}\n" });
		expect(barrel.graph.getExports(join(barrel.root, "src/index.ts")).map(item => item.name)).toContain("one");
		expect(barrel.graph.getDirectExports(join(barrel.root, "src/index.ts")).map(item => item.name)).not.toContain("one");
	});
	it("P5: updating a component replaces its edges", () => {
		const local = build(MONOREPO);
		const page = join(local.root, "apps/web/src/routes/+page.svelte");
		local.graph.updateFile(page, "<script>\n  import { helper } from '$lib/helper';\n</script>\n");
		expect(local.graph.getDependencies(page).map(edge => edge.toFile)).toEqual([join(local.root, "apps/web/src/lib/helper.ts")]);
		expect(local.graph.getDependents(join(local.root, "packages/utils/src/export/index.ts"))).toEqual([join(local.root, "apps/api/src/main.ts")]);
	});
	it("N1: an alias with no target file leaves the edge unresolved", () => {
		const local = build({ ...MONOREPO, "apps/api/src/bad.ts": "import { x } from '@api/missing';\n" });
		expect(local.graph.getDependencies(join(local.root, "apps/api/src/bad.ts"))[0]?.toFile).toBe("");
	});
	it("N2: a bare package import stays unresolved", () => {
		const local = build({ "package.json": "{}", "src/a.ts": "import x from 'left-pad';\n" });
		expect(local.graph.getDependencies(join(local.root, "src/a.ts"))[0]?.toFile).toBe("");
	});
	it("N3: text outside the script block is not read as an import", () => {
		const local = build({ ...MONOREPO, "apps/web/src/routes/b.svelte": "<p>import { helper } from '$lib/helper'</p>\n" });
		expect(local.graph.getDependencies(join(local.root, "apps/web/src/routes/b.svelte"))).toEqual([]);
	});
});
