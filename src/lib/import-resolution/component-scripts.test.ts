import { describe, expect, it } from "vitest";
import { componentKind, maskComponentScripts } from "./component-scripts.js";

function lineOf(text: string, needle: string): number {
	return text.slice(0, text.indexOf(needle)).split("\n").length;
}

describe("componentKind", () => {
	it("P1: names svelte, vue and astro files", () => {
		expect(componentKind("a/+page.svelte")).toBe("svelte");
		expect(componentKind("a/B.vue")).toBe("vue");
		expect(componentKind("a/C.astro")).toBe("astro");
	});
	it("N1: returns null for code and unknown files", () => {
		expect(componentKind("a/b.ts")).toBeNull();
		expect(componentKind("a/b.svelte.ts")).toBeNull();
		expect(componentKind("a/README.md")).toBeNull();
	});
});

describe("maskComponentScripts: svelte", () => {
	const source = [
		"<script lang=\"ts\">",
		"\timport { a } from '$lib/a';",
		"\timport B from './B.svelte';",
		"</script>",
		"",
		"<div>import nothing from 'markup-text'</div>",
		"<script module>",
		"\texport { c } from '../c';",
		"</script>",
		"<style>.x { color: red; } /* import z from 'css' */</style>",
	].join("\n");
	const masked = maskComponentScripts(source, "svelte");

	it("P1: keeps both script bodies at their original line numbers", () => {
		expect(lineOf(masked, "$lib/a")).toBe(lineOf(source, "$lib/a"));
		expect(lineOf(masked, "../c")).toBe(lineOf(source, "../c"));
	});
	it("P2: keeps the length and the line count", () => {
		expect(masked.length).toBe(source.length);
		expect(masked.split("\n").length).toBe(source.split("\n").length);
	});
	it("N1: drops markup and style text", () => {
		expect(masked).not.toContain("markup-text");
		expect(masked).not.toContain("css");
	});
	it("N2: ignores a script tag inside an HTML comment", () => {
		const text = "<!-- <script>import x from 'dead'</script> -->\n<script>import y from 'live'</script>";
		const out = maskComponentScripts(text, "svelte");
		expect(out).not.toContain("dead");
		expect(out).toContain("live");
	});
	it("N3: handles a generics attribute that holds a closing angle bracket", () => {
		const text = "<script lang=\"ts\" generics=\"T extends Array<string>\">\nimport q from './q';\n</script>";
		expect(maskComponentScripts(text, "svelte")).toContain("./q");
	});
	it("N4: skips a script in a language the parser cannot read", () => {
		const text = "<script lang=\"coffee\">\nimport x from './x'\n</script>";
		expect(maskComponentScripts(text, "svelte")).not.toContain("./x");
	});
	it("N5: ignores a self-closing script tag", () => {
		expect(maskComponentScripts("<script src=\"x.js\" />\n<p>import a from 'm'</p>", "svelte")).not.toContain("'m'");
	});
});

describe("maskComponentScripts: vue", () => {
	it("P1: reads script setup and plain script", () => {
		const text = "<template><p/></template>\n<script setup lang=\"ts\">\nimport { a } from '@/a';\n</script>\n<script>\nimport b from './b';\n</script>";
		const out = maskComponentScripts(text, "vue");
		expect(lineOf(out, "@/a")).toBe(3);
		expect(lineOf(out, "./b")).toBe(6);
	});
});

describe("maskComponentScripts: astro", () => {
	const text = "---\nimport Layout from '../layouts/Layout.astro';\nconst x = 1;\n---\n<Layout/>\n<script>\nimport './client';\n</script>";
	const out = maskComponentScripts(text, "astro");
	it("P1: reads the frontmatter between the two dash lines", () => {
		expect(lineOf(out, "../layouts/Layout.astro")).toBe(2);
	});
	it("P2: reads a body script too", () => {
		expect(lineOf(out, "./client")).toBe(7);
	});
	it("N1: reads nothing from a body when the file has no frontmatter and no script", () => {
		expect(maskComponentScripts("<p>import a from 'x'</p>", "astro")).not.toContain("import");
	});
	it("N2: treats an unclosed frontmatter fence as no frontmatter", () => {
		expect(maskComponentScripts("---\nimport a from 'x'\n", "astro")).not.toContain("import");
	});
});
