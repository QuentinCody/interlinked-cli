import { describe, expect, it } from "vitest";
import { fileLike, discoverWorkspaceMembers, resolveMemberOutputPath, resolveMemberSubpath, resolveNodeModulesPath, resolvePackageImport } from "./workspace-packages.js";
import { mapRepoView } from "./repo-view.js";

function view(files: Record<string, string>) {
	return mapRepoView(new Map(Object.entries(files)));
}

const PNPM = {
	"pnpm-workspace.yaml": "packages:\n  - apps/*\n  - '!apps/skip'\n  - \"packages/*\"\n  - packages/nest/src/*\nonlyBuiltDependencies:\n  - esbuild\n",
	"apps/web/package.json": '{"name":"web"}',
	"apps/skip/package.json": '{"name":"skip"}',
	"packages/utils/package.json": JSON.stringify({
		name: "@cio/utils",
		main: "./dist/index.js",
		exports: {
			".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
			"./export": { types: "./dist/export/index.d.ts", default: "./dist/export/index.js" },
			"./constants/*": { default: "./dist/constants/*.js" },
		},
	}),
	"packages/utils/src/index.ts": "x",
	"packages/utils/src/export/index.ts": "x",
	"packages/utils/src/constants/limits.ts": "x",
	"packages/nest/src/inner/package.json": '{"name":"@cio/inner","main":"src/main.ts"}',
	"packages/nest/src/inner/src/main.ts": "x",
	"packages/legacy/package.json": '{"name":"legacy","main":"lib/entry.js"}',
	"packages/legacy/src/entry.ts": "x",
	"packages/legacy/src/deep/mod.ts": "x",
	"packages/ui/package.json": '{"name":"@cio/ui","svelte":"src/index.js"}',
	"packages/ui/src/index.ts": "x",
};

describe("discoverWorkspaceMembers", () => {
	it("P1: reads pnpm-workspace.yaml patterns and honors a negation", () => {
		const names = discoverWorkspaceMembers(view(PNPM)).map(member => member.name);
		expect(names).toEqual(["@cio/inner", "@cio/ui", "@cio/utils", "legacy", "web"]);
	});
	it("P2: reads the package.json workspaces array and the packages object form", () => {
		const base = { "a/x/package.json": '{"name":"ax"}', "b/y/package.json": '{"name":"by"}' };
		expect(discoverWorkspaceMembers(view({ ...base, "package.json": '{"workspaces":["a/*"]}' })).map(m => m.name)).toEqual(["ax"]);
		expect(discoverWorkspaceMembers(view({ ...base, "package.json": '{"workspaces":{"packages":["b/*"]}}' })).map(m => m.name)).toEqual(["by"]);
	});
	it("N1: a repo without workspace config has no members", () => {
		expect(discoverWorkspaceMembers(view({ "a/package.json": '{"name":"a"}' }))).toEqual([]);
	});
});

describe("resolveMemberSubpath", () => {
	const v = view(PNPM);
	const members = discoverWorkspaceMembers(v);
	const find = (name: string) => members.find(member => member.name === name) as (typeof members)[number];
	it("P1: maps the dist target of the exports root to its source file", () => {
		expect(resolveMemberSubpath(v, find("@cio/utils"), "")).toBe("packages/utils/src/index.ts");
	});
	it("P2: resolves an exported subpath", () => {
		expect(resolveMemberSubpath(v, find("@cio/utils"), "export")).toBe("packages/utils/src/export/index.ts");
	});
	it("P3: resolves a star pattern", () => {
		expect(resolveMemberSubpath(v, find("@cio/utils"), "constants/limits")).toBe("packages/utils/src/constants/limits.ts");
	});
	it("P4: follows main when there is no exports map, mapping lib to src", () => {
		expect(resolveMemberSubpath(v, find("legacy"), "")).toBe("packages/legacy/src/entry.ts");
		expect(resolveMemberSubpath(v, find("legacy"), "deep/mod")).toBe("packages/legacy/src/deep/mod.ts");
	});
	it("P5: follows the svelte field", () => {
		expect(resolveMemberSubpath(v, find("@cio/ui"), "")).toBe("packages/ui/src/index.ts");
	});
	it("N1: a subpath the exports map does not list stays unresolved", () => {
		expect(resolveMemberSubpath(v, find("@cio/utils"), "secret")).toBeNull();
	});
	it("N2: a missing entry file stays unresolved", () => {
		const dropped = new Map(Object.entries(PNPM));
		dropped.delete("packages/utils/src/export/index.ts");
		const w = mapRepoView(dropped);
		expect(resolveMemberSubpath(w, find("@cio/utils"), "export")).toBeNull();
	});
});

describe("resolveNodeModulesPath", () => {
	const v = view(PNPM);
	const members = discoverWorkspaceMembers(v);
	it("P1: remaps a node_modules path of a workspace member to the member source", () => {
		expect(resolveNodeModulesPath(v, members, "apps/web/node_modules/@cio/utils/dist/export")).toBe("packages/utils/src/export/index.ts");
	});
	it("P2: remaps a path with no rest to the member entry", () => {
		expect(resolveNodeModulesPath(v, members, "apps/web/node_modules/@cio/ui/src/index")).toBe("packages/ui/src/index.ts");
	});
	it("N1: a node_modules path of a package that is not a member stays unresolved", () => {
		expect(resolveNodeModulesPath(v, members, "node_modules/left-pad/index")).toBeNull();
	});
	it("N2: a path with no node_modules segment is not handled here", () => {
		expect(resolveNodeModulesPath(v, members, "apps/web/src/a")).toBeNull();
	});
});

describe("resolveMemberOutputPath", () => {
	const files = { ...PNPM, "packages/ui/src/hosted.ts": "x", "packages/utils/src/popup/index.ts": "x" };
	const v = view(files);
	const members = discoverWorkspaceMembers(v);
	it("P1: maps a build-output path inside a member to its source file", () => {
		expect(resolveMemberOutputPath(v, members, "packages/ui/dist/hosted.js")).toBe("packages/ui/src/hosted.ts");
	});
	it("P2: a .js output built from a directory index maps to that index", () => {
		expect(resolveMemberOutputPath(v, members, "packages/utils/dist/esm/popup.js")).toBe("packages/utils/src/popup/index.ts");
	});
	it("N1: a path in no member, or with no source behind it, stays unresolved", () => {
		expect(resolveMemberOutputPath(v, members, "tools/dist/x.js")).toBeNull();
		expect(resolveMemberOutputPath(v, members, "packages/ui/dist/none.js")).toBeNull();
	});
});

describe("fileLike", () => {
	const v = view({ "a/x.ts": "", "a/y/index.tsx": "", "a/z.d.ts": "", "a/w.svelte": "", "a/data.json": "", "a/popup/index.ts": "" });
	it("P2: a .js specifier built from a directory index resolves to the index", () => {
		expect(fileLike(v, "a/popup.js")).toBe("a/popup/index.ts");
	});
	it("P1: tries the extension, the index file, and the js to ts swap", () => {
		expect(fileLike(v, "a/x")).toBe("a/x.ts");
		expect(fileLike(v, "a/x.js")).toBe("a/x.ts");
		expect(fileLike(v, "a/y")).toBe("a/y/index.tsx");
		expect(fileLike(v, "a/w.svelte")).toBe("a/w.svelte");
		expect(fileLike(v, "a/data.json")).toBe("a/data.json");
	});
	it("N1: returns null when nothing matches", () => {
		expect(fileLike(v, "a/missing")).toBeNull();
	});
});

describe("resolvePackageImport", () => {
	const v = view({
		"pkg/package.json": JSON.stringify({ imports: { "#db": "./src/db.ts", "#u/*": "./src/utils/*.ts", "#ext": "left-pad" } }),
		"pkg/src/db.ts": "",
		"pkg/src/utils/a.ts": "",
	});
	it("P1: resolves an exact and a star subpath import", () => {
		expect(resolvePackageImport(v, "pkg", "#db")).toBe("pkg/src/db.ts");
		expect(resolvePackageImport(v, "pkg", "#u/a")).toBe("pkg/src/utils/a.ts");
	});
	it("N1: an import that maps to a package or to nothing stays unresolved", () => {
		expect(resolvePackageImport(v, "pkg", "#ext")).toBeNull();
		expect(resolvePackageImport(v, "pkg", "#none")).toBeNull();
	});
});
