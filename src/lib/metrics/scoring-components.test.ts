import { describe, expect, it } from "vitest";
import { componentImports } from "./scoring-components.js";

describe("componentImports", () => {
	it("P1: reads static imports from script blocks with the original line numbers", () => {
		const text = ["<script lang=\"ts\">", "\timport { a, type B } from '$lib/a';", "\timport C from './C.svelte';", "</script>", "<p>hi</p>", "<script module>", "export { d } from '../d';", "</script>"].join("\n");
		const found = componentImports("src/routes/+page.svelte", text);
		expect(found.map(item => [item.specifier, item.line])).toEqual([["$lib/a", 2], ["./C.svelte", 3], ["../d", 7]]);
		expect(found[0]?.names).toEqual(["a", "B"]);
	});
	it("P2: reads dynamic imports and require calls", () => {
		const found = componentImports("a.vue", "<script setup>\nconst m = await import('./m');\nconst r = require('./r');\n</script>");
		expect(found.map(item => [item.specifier, item.line])).toEqual([["./m", 2], ["./r", 3]]);
	});
	it("P3: reads Astro frontmatter", () => {
		const found = componentImports("p.astro", "---\nimport L from '../L.astro';\n---\n<L/>");
		expect(found.map(item => [item.specifier, item.line])).toEqual([["../L.astro", 2]]);
	});
	it("N1: reads nothing from markup text or a style block", () => {
		expect(componentImports("a.svelte", "<p>import x from 'nope'</p><style>@import 'x.css';</style>")).toEqual([]);
	});
	it("N2: a file that is not a component has no imports here", () => {
		expect(componentImports("a.ts", "import x from './x';")).toEqual([]);
	});
	it("N3: a script that does not parse still yields the imports before the error", () => {
		const found = componentImports("a.svelte", "<script>\nimport a from './a';\nconst = ;\n</script>");
		expect(found.map(item => item.specifier)).toEqual(["./a"]);
	});
});
