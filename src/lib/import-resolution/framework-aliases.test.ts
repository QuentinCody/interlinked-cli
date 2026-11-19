import { describe, expect, it } from "vitest";
import { loadFrameworkAliases, matchFrameworkAlias } from "./framework-aliases.js";
import { mapRepoView } from "./repo-view.js";

function load(dir: string, files: Record<string, string>) {
	return loadFrameworkAliases(mapRepoView(new Map(Object.entries(files))), dir);
}

const KIT = `
import path from 'path';
import { fileURLToPath } from 'node:url';
const config = {
  kit: {
    adapter: adapterNode(),
    alias: {
      $features: path.resolve('./src/lib/features'),
      '$src/base/*': path.resolve('./node_modules/@cio/ui/src/base/*'),
      '@cio/ui': path.resolve('./node_modules/@cio/ui/src'),
      $dyn: path.resolve(process.cwd(), computed()),
      $url: fileURLToPath(new URL('./src/url', import.meta.url)),
      $plain: './src/plain',
    },
  },
};
export default config;
`;

describe("loadFrameworkAliases: sveltekit", () => {
	const aliases = load("apps/web", { "apps/web/svelte.config.js": KIT });
	it("P1: adds the default $lib", () => {
		expect(matchFrameworkAlias(aliases, "$lib/utils/a")).toEqual({ bases: ["apps/web/src/lib/utils/a"] });
	});
	it("P2: reads literal kit.alias values written as path.resolve, a url, or a string", () => {
		expect(matchFrameworkAlias(aliases, "$features/x")).toEqual({ bases: ["apps/web/src/lib/features/x"] });
		expect(matchFrameworkAlias(aliases, "$url")).toEqual({ bases: ["apps/web/src/url"] });
		expect(matchFrameworkAlias(aliases, "$plain/z")).toEqual({ bases: ["apps/web/src/plain/z"] });
	});
	it("P3: a wildcard key fills the rest and the longest key wins", () => {
		expect(matchFrameworkAlias(aliases, "$src/base/button")).toEqual({ bases: ["apps/web/node_modules/@cio/ui/src/base/button"] });
		expect(matchFrameworkAlias(aliases, "@cio/ui/tools")).toEqual({ bases: ["apps/web/node_modules/@cio/ui/src/tools"] });
	});
	it("N1: a value that is not a literal reports a null base, never a guess", () => {
		expect(matchFrameworkAlias(aliases, "$dyn/a")).toEqual({ bases: null });
	});
	it("N2: a specifier that no key fits is not an alias", () => {
		expect(matchFrameworkAlias(aliases, "svelte/store")).toBeNull();
		expect(matchFrameworkAlias(aliases, "$library/x")).toBeNull();
	});
	it("N3: a directory with no framework config has no aliases", () => {
		expect(load("apps/other", { "apps/web/svelte.config.js": KIT })).toEqual([]);
	});
});

describe("loadFrameworkAliases: vite and nuxt", () => {
	it("P1: reads a literal resolve.alias object and an array form", () => {
		const object = load("a", { "a/vite.config.ts": "export default defineConfig({ resolve: { alias: { '@': path.resolve(__dirname, 'src'), '~lib': './lib' } } });" });
		expect(matchFrameworkAlias(object, "@/x")).toEqual({ bases: ["a/src/x"] });
		expect(matchFrameworkAlias(object, "~lib/y")).toEqual({ bases: ["a/lib/y"] });
		const array = load("a", { "a/vite.config.ts": "export default { resolve: { alias: [{ find: '@app', replacement: './app' }, { find: /re/, replacement: './x' }] } };" });
		expect(matchFrameworkAlias(array, "@app/m")).toEqual({ bases: ["a/app/m"] });
	});
	it("P2: nuxt maps ~ and @ to the root and to app/, and ~~ to the root", () => {
		const nuxt = load("n", { "n/nuxt.config.ts": "export default defineNuxtConfig({})" });
		expect(matchFrameworkAlias(nuxt, "~/components/A")).toEqual({ bases: ["n/components/A", "n/app/components/A"] });
		expect(matchFrameworkAlias(nuxt, "~~/server/x")).toEqual({ bases: ["n/server/x"] });
	});
	it("N1: an alias key in a vite config that is a regex is skipped", () => {
		const array = load("a", { "a/vite.config.ts": "export default { resolve: { alias: [{ find: /re/, replacement: './x' }] } };" });
		expect(matchFrameworkAlias(array, "re/x")).toBeNull();
	});
});
