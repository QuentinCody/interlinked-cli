import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectStaticMeasurements } from "./static-measurements.js";

const roots: string[] = [];
function fixture(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "scoring-aliases-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const WORKSPACE = {
	"package.json": '{"name":"root","private":true,"workspaces":["apps/*","packages/*"]}',
	"packages/utils/package.json": '{"name":"@x/utils","exports":{".":"./dist/index.js","./export":"./dist/export/index.js"}}',
	"packages/utils/src/index.ts": "export function top() { return 1; }\n",
	"packages/utils/src/export/index.ts": "export function exp() { return 2; }\n",
	"packages/utils/src/dead.ts": "export function lonely() { return 3; }\n",
	"apps/web/package.json": '{"name":"web","dependencies":{"@sveltejs/kit":"2","@x/utils":"workspace:*"}}',
	"apps/web/svelte.config.js": "export default { kit: {} };\n",
	"apps/web/src/lib/helper.ts": "export function helper() { return 1; }\n",
	"apps/web/src/lib/unused.ts": "export function unused() { return 1; }\n",
	"apps/web/src/routes/+page.svelte": "<script lang=\"ts\">\n\timport { helper } from '$lib/helper';\n\timport { exp } from '@x/utils/export';\n\timport { missing } from '$lib/absent';\n</script>\n<p>{helper()}{exp()}</p>\n",
	"apps/web/src/routes/+page.server.ts": "export const load = () => ({});\n",
};

describe("scoring graph: aliases, workspace packages and single-file components", () => {
	const result = collectStaticMeasurements(fixture(WORKSPACE));
	const edges = result.graph.edges.map(edge => `${edge.from} -> ${edge.to}:${edge.line}`);
	it("P1: a component imports through $lib and through a workspace package, with the script line numbers", () => {
		expect(edges).toContain("apps/web/src/routes/+page.svelte -> apps/web/src/lib/helper.ts:2");
		expect(edges).toContain("apps/web/src/routes/+page.svelte -> packages/utils/src/export/index.ts:3");
	});
	it("P2: framework route files are roots, the component included", () => {
		expect(result.graph.entries).toEqual(expect.arrayContaining(["apps/web/src/routes/+page.svelte", "apps/web/src/routes/+page.server.ts"]));
	});
	it("P3: modules that only a component imports are reachable; unimported modules are not", () => {
		const disconnected = result.findings.filter(row => row.metric === "redundancy.disconnected").map(row => row.file);
		expect(disconnected).toEqual(expect.arrayContaining(["apps/web/src/lib/unused.ts", "packages/utils/src/dead.ts"]));
		expect(disconnected).not.toContain("apps/web/src/lib/helper.ts");
		expect(disconnected).not.toContain("packages/utils/src/export/index.ts");
	});
	it("P4: an alias whose file is absent is counted with its reason", () => {
		expect(result.graph.unresolved).toEqual([{ file: "apps/web/src/routes/+page.svelte", line: 4, specifier: "$lib/absent", reason: "alias-target-missing" }]);
	});
	it("N1: a repo with no components and no aliases gets the same graph as before", () => {
		const plain = collectStaticMeasurements(fixture({ "index.js": 'import { b } from "./b.js";\nexport const a = b;\n', "b.js": "export const b = 1;\n" }));
		expect(plain.graph.edges.map(edge => `${edge.from}->${edge.to}`)).toEqual(["index.js->b.js"]);
		expect(plain.graph.unresolved).toEqual([]);
		expect(plain.graph.components).toEqual([]);
	});
	it("N3: node built-ins, style files and the generated $types module carry no code edge", () => {
		const generated = collectStaticMeasurements(fixture({ "index.js": 'import "node:test";\nimport "bun:test";\nimport "../node_modules/pkg/index.js";\nimport "./style.css";\nimport data from "../data.json";\nimport t from "./$types";\nexport default [t, data];\n' }));
		expect(generated.graph.unresolved).toEqual([]);
	});
	it("N2: a bare package that is declared is external, not unresolved", () => {
		const declared = collectStaticMeasurements(fixture({ "package.json": '{"dependencies":{"left-pad":"1"}}', "index.js": 'import pad from "left-pad";\nexport default pad;\n' }));
		expect(declared.graph.unresolved).toEqual([]);
	});
});
