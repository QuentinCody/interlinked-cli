import { describe, expect, it } from "vitest";
import { frameworkEntryFiles, isConventionExport } from "./framework-entries.js";
import { mapRepoView } from "./repo-view.js";

const FILES: Record<string, string> = {
	"apps/kit/package.json": '{"devDependencies":{"@sveltejs/kit":"2"}}',
	"apps/next/package.json": '{"dependencies":{"next":"15"}}',
	"apps/nuxt/package.json": '{"dependencies":{"nuxt":"3"}}',
	"apps/astro/package.json": '{"dependencies":{"astro":"5"}}',
	"apps/plain/package.json": '{"dependencies":{"left-pad":"1"}}',
};
const view = mapRepoView(new Map(Object.entries(FILES)));
const entries = (paths: string[]) => [...frameworkEntryFiles(view, paths)].sort();

describe("frameworkEntryFiles", () => {
	it("P1: SvelteKit route files, hooks, params and the service worker are roots", () => {
		const paths = [
			"apps/kit/src/routes/+page.svelte", "apps/kit/src/routes/a/b/+page.server.ts", "apps/kit/src/routes/+layout.ts",
			"apps/kit/src/routes/api/+server.ts", "apps/kit/src/routes/+error.svelte", "apps/kit/src/hooks.server.ts",
			"apps/kit/src/params/slug.ts", "apps/kit/src/service-worker.ts", "apps/kit/src/app.d.ts",
		];
		expect(entries(paths)).toEqual([...paths].sort());
	});
	it("P2: Next app and pages files and middleware are roots", () => {
		const paths = ["apps/next/app/page.tsx", "apps/next/src/app/x/route.ts", "apps/next/pages/api/y.ts", "apps/next/middleware.ts"];
		expect(entries(paths)).toEqual([...paths].sort());
	});
	it("P3: Nuxt pages, server api and auto-imported directories are roots", () => {
		const paths = ["apps/nuxt/pages/index.vue", "apps/nuxt/server/api/x.ts", "apps/nuxt/composables/useX.ts", "apps/nuxt/app.vue"];
		expect(entries(paths)).toEqual([...paths].sort());
	});
	it("P4: Astro pages are roots", () => {
		expect(entries(["apps/astro/src/pages/index.astro", "apps/astro/src/middleware.ts"])).toHaveLength(2);
	});
	it("N1: ordinary modules are not roots", () => {
		expect(entries(["apps/kit/src/lib/a.ts", "apps/next/lib/a.ts", "apps/kit/src/routes/helper.ts", "apps/astro/src/lib/a.ts"])).toEqual([]);
	});
	it("N2: a file under a package with no framework dependency is not a root", () => {
		expect(entries(["apps/plain/src/routes/+page.svelte", "apps/plain/pages/a.ts"])).toEqual([]);
	});
	it("N3: a SvelteKit file in a Next package is not a root", () => {
		expect(entries(["apps/next/src/routes/+page.svelte"])).toEqual([]);
	});
});

describe("isConventionExport", () => {
	it("P1: names a framework reads from a route file", () => {
		expect(isConventionExport("src/routes/a/+page.server.ts", "load")).toBe(true);
		expect(isConventionExport("src/routes/a/+page.server.ts", "actions")).toBe(true);
		expect(isConventionExport("src/routes/api/+server.ts", "GET")).toBe(true);
		expect(isConventionExport("app/api/x/route.ts", "POST")).toBe(true);
		expect(isConventionExport("src/pages/index.astro", "getStaticPaths")).toBe(true);
		expect(isConventionExport("apps/web/src/hooks.server.ts", "handleError")).toBe(true);
		expect(isConventionExport("src/hooks.client.ts", "handleError")).toBe(true);
	});
	it("N1: an ordinary export of a route file is not a convention name", () => {
		expect(isConventionExport("src/routes/a/+page.server.ts", "formatDate")).toBe(false);
	});
	it("N2: a convention name in an ordinary module is not exempt", () => {
		expect(isConventionExport("src/lib/load.ts", "load")).toBe(false);
		expect(isConventionExport("src/lib/api.ts", "GET")).toBe(false);
		expect(isConventionExport("src/lib/hooks.ts", "handleError")).toBe(false);
	});
});
