import { describe, expect, it } from "vitest";
import { governingTsconfig, loadTsconfig, matchTsPaths } from "./tsconfig-paths.js";
import { mapRepoView } from "./repo-view.js";
import { discoverWorkspaceMembers } from "./workspace-packages.js";

function setup(files: Record<string, string>) {
	const view = mapRepoView(new Map(Object.entries(files)));
	return { view, members: discoverWorkspaceMembers(view) };
}

describe("loadTsconfig", () => {
	it("P1: reads paths relative to the config that holds them when there is no baseUrl", () => {
		const { view, members } = setup({ "app/tsconfig.json": '{"compilerOptions":{"paths":{"@api/*":["src/*"]}}}' });
		const cfg = loadTsconfig(view, members, "app/tsconfig.json");
		expect(cfg?.paths).toEqual({ "@api/*": ["src/*"] });
		expect(cfg?.pathsBase).toBe("app");
	});
	it("P2: baseUrl moves the paths base and is inherited through extends", () => {
		const { view, members } = setup({
			"base/tsconfig.base.json": '{"compilerOptions":{"baseUrl":"./src","paths":{"~/*":["*"]}}}',
			"app/tsconfig.json": '{"extends":"../base/tsconfig.base","compilerOptions":{"strict":true}}',
		});
		const cfg = loadTsconfig(view, members, "app/tsconfig.json");
		expect(cfg?.paths).toEqual({ "~/*": ["*"] });
		expect(cfg?.baseUrl).toBe("base/src");
		expect(matchTsPaths(cfg as NonNullable<typeof cfg>, "~/x")).toEqual(["base/src/x"]);
	});
	it("P3: a child paths object replaces the parent paths", () => {
		const { view, members } = setup({
			"tsconfig.json": '{"compilerOptions":{"paths":{"@a/*":["a/*"]}}}',
			"app/tsconfig.json": '{"extends":"../tsconfig.json","compilerOptions":{"paths":{"@b/*":["b/*"]}}}',
		});
		expect(loadTsconfig(view, members, "app/tsconfig.json")?.paths).toEqual({ "@b/*": ["b/*"] });
	});
	it("P4: follows extends that names a workspace package", () => {
		const { view, members } = setup({
			"pnpm-workspace.yaml": "packages:\n  - packages/*\n",
			"packages/tsconfig/package.json": '{"name":"@cio/tsconfig"}',
			"packages/tsconfig/base.json": '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["lib/*"]}}}',
			"app/tsconfig.json": '{"extends":"@cio/tsconfig/base.json"}',
		});
		const cfg = loadTsconfig(view, members, "app/tsconfig.json");
		expect(cfg?.paths).toEqual({ "@lib/*": ["lib/*"] });
		expect(cfg?.pathsBase).toBe("packages/tsconfig");
	});
	it("N1: counts an extends target that is not in the repo", () => {
		const { view, members } = setup({ "app/tsconfig.json": '{"extends":"./.svelte-kit/tsconfig.json"}' });
		const cfg = loadTsconfig(view, members, "app/tsconfig.json");
		expect(cfg?.paths).toBeNull();
		expect(cfg?.unreadableExtends).toEqual(["./.svelte-kit/tsconfig.json"]);
	});
	it("N2: stops at an extends cycle", () => {
		const { view, members } = setup({ "a.json": '{"extends":"./b.json"}', "b.json": '{"extends":"./a.json"}' });
		expect(loadTsconfig(view, members, "a.json")?.paths).toBeNull();
	});
	it("N3: returns null for a file that is not JSON", () => {
		const { view, members } = setup({ "tsconfig.json": "{ nope" });
		expect(loadTsconfig(view, members, "tsconfig.json")).toBeNull();
	});
});

describe("governingTsconfig", () => {
	const { view, members } = setup({
		"tsconfig.json": '{"files":[]}',
		"apps/web/tsconfig.json": '{"compilerOptions":{"paths":{"@w/*":["src/*"]}}}',
		"apps/web/src/deep/a.ts": "",
		"apps/web/jsconfig.json": "{}",
		"lib/jsconfig.json": '{"compilerOptions":{"baseUrl":"."}}',
	});
	it("P1: picks the nearest config that carries paths or a baseUrl", () => {
		expect(governingTsconfig(view, members, "apps/web/src/deep/a.ts")?.pathsBase).toBe("apps/web");
		expect(governingTsconfig(view, members, "lib/x.ts")?.baseUrl).toBe("lib");
	});
	it("N1: returns null when no config on the way up has paths or a baseUrl", () => {
		expect(governingTsconfig(view, members, "other/x.ts")).toBeNull();
	});
});

describe("matchTsPaths", () => {
	const cfg = { paths: { "@db/types": ["./t.ts"], "@db/*": ["./db/*"], "@/*": ["./src/*", "./gen/*"], "@cio/utils": ["./u/index.ts"] }, pathsBase: "app", baseUrl: null, unreadableExtends: [] as string[] };
	it("P1: an exact key wins over a star pattern", () => {
		expect(matchTsPaths(cfg, "@db/types")).toEqual(["app/t.ts"]);
	});
	it("P2: fills the star and lists every target in order", () => {
		expect(matchTsPaths(cfg, "@/a/b")).toEqual(["app/src/a/b", "app/gen/a/b"]);
		expect(matchTsPaths(cfg, "@db/x")).toEqual(["app/db/x"]);
	});
	it("N1: returns null when no pattern fits", () => {
		expect(matchTsPaths(cfg, "react")).toBeNull();
		expect(matchTsPaths(cfg, "@cio/utils/extra")).toBeNull();
	});
});
