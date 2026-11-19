import { describe, expect, it } from "vitest";
import { mapRepoView } from "../lib/import-resolution/repo-view.js";
import { nestedPackageEntries, reachabilityRoots } from "./deadcode-entries.js";

const FILES = new Map<string, string>([
	["package.json", '{"scripts":{"build":"tsup src/index.ts"}}'],
	["packages/db/package.json", '{"dependencies":{},"scripts":{"seed":"tsx src/scripts/seed.ts","reset":"node ./scripts/reset.js --force"},"bin":{"db":"./dist/cli.js"}}'],
	["apps/web/package.json", '{"dependencies":{"@sveltejs/kit":"2"}}'],
	["apps/broken/package.json", "{ nope"],
]);
const view = mapRepoView(FILES);
const known = new Set([
	"packages/db/src/scripts/seed.ts", "packages/db/scripts/reset.js", "packages/db/src/cli.ts", "packages/db/src/other.ts",
	"apps/web/vite.config.ts", "apps/web/src/routes/+page.server.ts", "apps/web/src/lib/a.ts", "packages/ui/.storybook/main.ts", "apps/web/postcss.config.js",
]);

describe("nestedPackageEntries", () => {
	it("P1: a script and a bin target of a nested package are entries, resolved from that package", () => {
		expect([...nestedPackageEntries(view, known)].sort()).toEqual(["packages/db/scripts/reset.js", "packages/db/src/cli.ts", "packages/db/src/scripts/seed.ts"]);
	});
	it("N1: a path that is not a known file is not an entry, and a broken package.json adds none", () => {
		expect(nestedPackageEntries(view, new Set(["packages/db/src/other.ts"]))).toEqual(new Set());
	});
});

describe("reachabilityRoots", () => {
	const roots = reachabilityRoots(view, [...known], ["apps/web/src/routes/+page.svelte"], new Set(["src/index.ts"]));
	it("P1: adds framework route files, nested scripts and tool configs to the given entries", () => {
		for (const path of ["src/index.ts", "apps/web/src/routes/+page.server.ts", "packages/db/src/scripts/seed.ts", "apps/web/vite.config.ts", "apps/web/postcss.config.js", "packages/ui/.storybook/main.ts"]) {
			expect(roots.entries.has(path)).toBe(true);
		}
	});
	it("P2: only framework entries lose their export scan", () => {
		expect(roots.frameworkEntries.has("apps/web/src/routes/+page.server.ts")).toBe(true);
		expect(roots.frameworkEntries.has("apps/web/vite.config.ts")).toBe(false);
	});
	it("N1: an ordinary module is not an entry", () => {
		expect(roots.entries.has("apps/web/src/lib/a.ts")).toBe(false);
		expect(roots.entries.has("packages/db/src/other.ts")).toBe(false);
	});
});
