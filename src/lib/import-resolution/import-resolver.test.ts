import { describe, expect, it } from "vitest";
import { createImportResolver } from "./import-resolver.js";
import { mapRepoView } from "./repo-view.js";

const FILES: Record<string, string> = {
	"pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
	"package.json": "{}",
	"packages/tsconfig/package.json": '{"name":"@cio/tsconfig"}',
	"packages/tsconfig/base.json": '{"compilerOptions":{"strict":true}}',
	"packages/utils/package.json": JSON.stringify({ name: "@cio/utils", exports: { ".": "./dist/index.js", "./export": "./dist/export/index.js" } }),
	"packages/utils/src/index.ts": "",
	"packages/utils/src/export/index.ts": "",
	"packages/ui/package.json": '{"name":"@cio/ui","svelte":"./src/index.ts"}',
	"packages/ui/src/index.ts": "",
	"packages/ui/src/tools/index.ts": "",
	"apps/api/package.json": '{"name":"@cio/api"}',
	"apps/api/tsconfig.json": JSON.stringify({ extends: "@cio/tsconfig/base.json", compilerOptions: { baseUrl: ".", paths: { "@api/*": ["src/*"], "@cio/utils/*": ["./node_modules/@cio/utils/dist/*"], "@cio/utils": ["./node_modules/@cio/utils/dist/index.ts"] } } }),
	"apps/api/src/routes/hls.ts": "",
	"apps/api/src/utils/log.ts": "",
	"apps/web/package.json": JSON.stringify({ name: "web", imports: { "#db": "./src/db.ts" } }),
	"apps/web/svelte.config.js": "export default { kit: { alias: { '@cio/ui': path.resolve('./node_modules/@cio/ui/src'), '@cio/ui/*': path.resolve('./node_modules/@cio/ui/src/*'), $dyn: compute() } } };",
	"apps/web/tsconfig.json": '{"extends":"./.svelte-kit/tsconfig.json","compilerOptions":{"baseUrl":"."}}',
	"apps/web/src/lib/utils/a.ts": "",
	"apps/web/src/lib/index.ts": "",
	"apps/web/src/db.ts": "",
	"apps/web/src/routes/+page.svelte": "",
	"apps/nuxt/nuxt.config.ts": "export default {}",
	"apps/nuxt/components/A.vue": "",
};
const resolver = () => createImportResolver(mapRepoView(new Map(Object.entries(FILES))));

describe("createImportResolver", () => {
	const r = resolver();
	it("P1: resolves a tsconfig paths alias with a star", () => {
		expect(r.resolve("apps/api/src/index.ts", "@api/utils/log")).toEqual({ kind: "local", target: "apps/api/src/utils/log.ts" });
	});
	it("P2: resolves a workspace subpath through a paths entry that points into node_modules", () => {
		expect(r.resolve("apps/api/src/index.ts", "@cio/utils/export")).toEqual({ kind: "local", target: "packages/utils/src/export/index.ts" });
		expect(r.resolve("apps/api/src/index.ts", "@cio/utils")).toEqual({ kind: "local", target: "packages/utils/src/index.ts" });
	});
	it("P3: resolves a workspace package by name when no alias names it", () => {
		expect(r.resolve("apps/web/src/lib/utils/a.ts", "@cio/utils/export")).toEqual({ kind: "local", target: "packages/utils/src/export/index.ts" });
	});
	it("P4: resolves the SvelteKit default $lib and a kit.alias into a workspace member", () => {
		expect(r.resolve("apps/web/src/routes/+page.svelte", "$lib/utils/a")).toEqual({ kind: "local", target: "apps/web/src/lib/utils/a.ts" });
		expect(r.resolve("apps/web/src/routes/+page.svelte", "$lib")).toEqual({ kind: "local", target: "apps/web/src/lib/index.ts" });
		expect(r.resolve("apps/web/src/routes/+page.svelte", "@cio/ui/tools")).toEqual({ kind: "local", target: "packages/ui/src/tools/index.ts" });
	});
	it("P5: treats SvelteKit virtual modules as virtual", () => {
		expect(r.resolve("apps/web/src/routes/+page.svelte", "$app/navigation")).toEqual({ kind: "virtual" });
		expect(r.resolve("apps/web/src/routes/+page.svelte", "$env/static/public")).toEqual({ kind: "virtual" });
	});
	it("P6: resolves a package.json imports entry", () => {
		expect(r.resolve("apps/web/src/lib/utils/a.ts", "#db")).toEqual({ kind: "local", target: "apps/web/src/db.ts" });
	});
	it("P7: resolves a Nuxt ~ alias by existence", () => {
		expect(r.resolve("apps/nuxt/pages/index.vue", "~/components/A.vue")).toEqual({ kind: "local", target: "apps/nuxt/components/A.vue" });
	});
	it("N1: an alias whose target file is missing is unresolved with a reason", () => {
		expect(r.resolve("apps/api/src/index.ts", "@api/nope")).toEqual({ kind: "unresolved", reason: "alias-target-missing" });
		expect(r.resolve("apps/web/src/lib/utils/a.ts", "$lib/nope")).toEqual({ kind: "unresolved", reason: "alias-target-missing" });
	});
	it("N2: an alias with a non-literal value is unresolved, never guessed", () => {
		expect(r.resolve("apps/web/src/lib/utils/a.ts", "$dyn/x")).toEqual({ kind: "unresolved", reason: "alias-not-literal" });
	});
	it("N3: a workspace subpath the exports map omits is unresolved", () => {
		expect(r.resolve("apps/web/src/lib/utils/a.ts", "@cio/utils/secret")).toEqual({ kind: "unresolved", reason: "workspace-entry-missing" });
	});
	it("N4: relative, node: and ordinary package specifiers are not handled here", () => {
		expect(r.resolve("apps/api/src/index.ts", "./x")).toBeNull();
		expect(r.resolve("apps/api/src/index.ts", "node:fs")).toBeNull();
		expect(r.resolve("apps/api/src/index.ts", "react")).toBeNull();
		expect(r.resolve("apps/api/src/index.ts", "#none")).toBeNull();
	});
	it("N5: reports an extends link that is not in the repo", () => {
		r.resolve("apps/web/src/lib/utils/a.ts", "$lib/utils/a");
		expect(r.notes().some((note: string) => note.includes(".svelte-kit/tsconfig.json"))).toBe(true);
	});
	it("N6: a repo with no config resolves nothing", () => {
		const empty = createImportResolver(mapRepoView(new Map([["a.ts", ""]])));
		expect(empty.resolve("a.ts", "@x/y")).toBeNull();
	});
});
