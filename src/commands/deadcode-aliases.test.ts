import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanDeadCode, type DeadCodeReport } from "./deadcode.js";

const roots: string[] = [];
function scan(files: Record<string, string>): DeadCodeReport {
	const root = mkdtempSync(join(tmpdir(), "deadcode-aliases-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
	return scanDeadCode(root);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const KIT = {
	"package.json": '{"name":"web","dependencies":{"@sveltejs/kit":"2"}}',
	"svelte.config.js": "export default { kit: {} };\n",
	"src/lib/helpers.ts": "export function usedBySvelte() { return 1; }\nexport function reallyDead() { return 2; }\n",
	"src/lib/viaAlias.ts": "export const viaAlias = 1;\n",
	"src/lib/orphan.ts": "export const orphan = 1;\n",
	"src/routes/+page.svelte": "<script lang=\"ts\">\n\timport { usedBySvelte } from '$lib/helpers';\n\timport { viaAlias } from '$lib/viaAlias';\n</script>\n<p>{usedBySvelte()}{viaAlias}</p>\n",
	"src/routes/+page.server.ts": "export const load = () => ({});\n",
	"src/routes/api/+server.ts": "export function GET() { return new Response(); }\n",
};

describe("deadcode: aliases, single-file components, framework roots", () => {
	const report = scan(KIT);
	it("P1: a module that only a component imports through $lib is reachable", () => {
		expect(report.unreachableFiles).not.toContain("src/lib/helpers.ts");
		expect(report.unreachableFiles).not.toContain("src/lib/viaAlias.ts");
	});
	it("P2: a module that nothing imports still fires", () => {
		expect(report.unreachableFiles).toEqual(["src/lib/orphan.ts"]);
	});
	it("P3: an export that a component imports is used; an export nobody imports still fires", () => {
		const details = report.deadExports.filter(item => item.file === "src/lib/helpers.ts").map(item => item.detail).join("\n");
		expect(details).toContain("reallyDead");
		expect(details).not.toContain("usedBySvelte");
	});
	it("N1: SvelteKit route modules are roots, never unreachable", () => {
		expect(report.unreachableFiles).not.toContain("src/routes/+page.server.ts");
		expect(report.unreachableFiles).not.toContain("src/routes/api/+server.ts");
	});
	it("N2: the load and GET exports of route modules are not dead exports", () => {
		expect(report.deadExports.filter(item => item.file.startsWith("src/routes/"))).toEqual([]);
	});
	it("N4: a script that an HTML page loads by path is referenced; one no page names still fires", () => {
		const html = scan({ ...KIT, "src/lib/loaded.js": "export const loaded = 1;\n", "src/lib/unloaded.js": "export const unloaded = 1;\n", "static/index.html": '<script src="../src/lib/loaded.js"></script>\n' });
		expect(html.unreachableFiles).not.toContain("src/lib/loaded.js");
		expect(html.unreachableFiles).toContain("src/lib/unloaded.js");
	});
	it("N3: an import that sits outside the script block does not make a module used", () => {
		const text = scan({ ...KIT, "src/routes/+page.svelte": "<p>import { viaAlias } from '$lib/viaAlias'</p>\n" });
		expect(text.unreachableFiles).toContain("src/lib/viaAlias.ts");
	});
});
