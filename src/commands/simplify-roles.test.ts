import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { partitionDiscovered } from "./simplify-roles.js";

const BUNDLE = `${"var f=function(a,b){return a+b},x=f(1,2),y=f(x,3);".repeat(600)}\n`;
const roots: string[] = [];
function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "simplify-roles-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("partitionDiscovered", () => {
	it("sets a minified bundle and a vendored file aside and keeps product source and other files", () => {
		const root = tree({ "src/a.ts": "export const a = 1;\n", "site/academy.js": BUNDLE, "libs/x.min.js": "x", "README.md": "# x\n", "src/b.test.ts": "x" });
		const discovered = ["src/a.ts", "site/academy.js", "libs/x.min.js", "README.md", "src/b.test.ts"].map(path => join(root, path));
		const result = partitionDiscovered(root, discovered);
		expect(result.kept.map(path => path.slice(root.length + 1))).toEqual(["src/a.ts", "README.md", "src/b.test.ts"]);
		expect(result.setAside).toEqual(["site/academy.js", "libs/x.min.js"]);
		expect(result.population.setAside.byRole).toMatchObject({ generated: 1, vendor: 1 });
		expect(result.population.files).toBe(5);
		expect(result.population.rolesVersion).toBe("interlinked-source-roles-v5");
	});
	it("does not set a non-source file aside, so coverage still reports it as unsupported", () => {
		const root = tree({ "data/big.json": `{"k":"${"x".repeat(20000)}"}\n` });
		const result = partitionDiscovered(root, [join(root, "data/big.json")]);
		expect(result.kept).toHaveLength(1);
		expect(result.setAside).toEqual([]);
	});
});
