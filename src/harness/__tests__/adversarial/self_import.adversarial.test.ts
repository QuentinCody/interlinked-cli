// Independent adversarial review of the `self_import` pre_block check
// (2026-10-21). Probe: scratch/2026-10-21-adversarial/self_import.probe.mts
// (22 candidates). No legitimate code fired: the detector resolves every
// relative specifier with the importer's own compiler, so asset imports that
// share the component's stem, Vite query modules, type queries, augmentations
// and import.meta references all stay silent. These cases pin that silence
// against a future "cheaper" resolver. The five that fired are a module
// importing itself (type-only, namespace-for-spying, .js-of-self, .ts-of-self)
// — the check's own class, recorded in the probe as arguable or TP and NOT
// turned into negatives here. A third pass (self_import.round3.probe.mts) DID
// find legitimate code that fired: `Toast.svelte.ts` importing `./Toast.svelte`
// (N15, N16); the resolver now lets an existing non-script file answer first.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSelfImport } from "../../checks/agent-safety-deps.js";

const BUNDLER = { compilerOptions: { module: "ESNext", moduleResolution: "bundler" }, include: ["**/*"] };

let root: string | null = null;
afterEach(() => {
	if (root !== null) rmSync(root, { recursive: true, force: true });
	root = null;
});

/** A throwaway project claiming its whole root, with the sibling files a case
 *  needs on disk. The importer itself is never written. */
function project(siblings: Record<string, string> = {}, tsconfig: object = BUNDLER): (name: string) => string {
	// A test that builds two projects: paths from the first stay valid only
	// until the second is built, so no case reads an `at` across a rebuild.
	if (root !== null) rmSync(root, { recursive: true, force: true });
	root = mkdtempSync(join(tmpdir(), "self-import-adv-"));
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig));
	for (const [rel, body] of Object.entries(siblings)) {
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), body);
	}
	const base = root;
	return (name) => join(base, name);
}

describe("self_import — negative (must not fire)", () => {
	it("N1: a component's side-effect CSS import sharing its own stem", () => {
		const at = project({ "Button.css": ".btn{}" });
		const src = 'import "./Button.css";\nexport const Button = () => <button className="btn" />;\n';
		expect(checkSelfImport(src, at("Button.tsx"))).toEqual([]);
	});

	it("N2: a CSS-module and an SVG asset import sharing the component's stem", () => {
		const at = project({ "Button.module.css": ".btn{}", "Button.svg": "<svg/>" });
		const src = 'import styles from "./Button.module.css";\nimport icon from "./Button.svg";\nexport const Button = () => <img src={icon} className={styles.btn} />;\n';
		expect(checkSelfImport(src, at("Button.tsx"))).toEqual([]);
	});

	it("N3: Vite ?raw / ?worker / ?url query imports of the file's own path", () => {
		const at = project();
		const raw = 'import source from "./Example.tsx?raw";\nexport function Example() { return <pre>{source}</pre>; }\n';
		expect(checkSelfImport(raw, at("Example.tsx"))).toEqual([]);
		const worker = 'import SelfWorker from "./worker.ts?worker";\nimport me from "./worker.ts?url";\nexport function spawn() { return new SelfWorker(me); }\n';
		expect(checkSelfImport(worker, at("worker.ts"))).toEqual([]);
	});

	it("N4: a typeof import() type query and a module augmentation of itself", () => {
		const at = project();
		const src = [
			"export const api = { a: 1 };",
			'type Self = typeof import("./widget.js");',
			'export const keys: Array<keyof Self> = ["api"];',
			'declare module "./widget.js" { export const extra: number; }',
		].join("\n");
		expect(checkSelfImport(src, at("widget.ts"))).toEqual([]);
	});

	it("N5: import.meta.url / import.meta.resolve naming the file itself", () => {
		const at = project();
		const src = 'export const here = new URL("./widget.js", import.meta.url);\nexport const spec = import.meta.resolve("./widget.js");\n';
		expect(checkSelfImport(src, at("widget.ts"))).toEqual([]);
	});

	it("N6: a .tsx importing ./Button.js names the .ts sibling, not itself", () => {
		const at = project({ "Button.ts": "export const label = 'x';" });
		const src = 'import { label } from "./Button.js";\nexport const Button = () => <button>{label}</button>;\n';
		expect(checkSelfImport(src, at("Button.tsx"))).toEqual([]);
	});

	it("N7: a JSON sibling with the importer's stem under resolveJsonModule", () => {
		const at = project(
			{ "widget.json": '{"a":1}' },
			{ compilerOptions: { module: "ESNext", moduleResolution: "bundler", resolveJsonModule: true }, include: ["**/*"] },
		);
		expect(checkSelfImport('import data from "./widget.json";\nexport const a = data.a;\n', at("widget.ts"))).toEqual([]);
	});

	it("N8: strings, template literals and comments that merely mention the self path", () => {
		const at = project();
		const src = [
			'// import { x } from "./widget.js" would be a self-import',
			"export const doc = 'import { x } from \"./widget.js\"';",
			'export const tpl = `import { x } from "./widget.js"`;',
		].join("\n");
		expect(checkSelfImport(src, at("widget.ts"))).toEqual([]);
	});

	// Second pass (self_import.extra.probe.mts, 19 candidates): still no
	// legitimate code fired. These pin the JSDoc, dual-package, rootDirs,
	// Storybook, HMR and generated-twin shapes against a future resolver.
	it("N9: JSDoc @type {import('./self.js').T} and a JSDoc @import tag in a checkJs .js file", () => {
		const at = project(
			{},
			{ compilerOptions: { module: "ESNext", moduleResolution: "bundler", allowJs: true, checkJs: true }, include: ["**/*"] },
		);
		const typeTag =
			'// @ts-check\n/** @typedef {{ id: string }} Opts */\n/** @type {import("./widget.js").Opts} */\nexport const o = { id: "a" };\n';
		expect(checkSelfImport(typeTag, at("widget.js"))).toEqual([]);
		const importTag = '/** @import { Opts } from "./widget.js" */\n/** @type {Opts} */\nexport const o = { id: "a" };\n';
		expect(checkSelfImport(importTag, at("widget.js"))).toEqual([]);
	});

	it("N10: an ESM wrapper importing its own CJS twin (dual-package idiom), built or source-only", () => {
		const built = project(
			{ "widget.cjs": "module.exports = { a: 1 };" },
			{ compilerOptions: { module: "ESNext", moduleResolution: "bundler", allowJs: true }, include: ["**/*"] },
		);
		expect(checkSelfImport('import m from "./widget.cjs";\nexport const { a } = m;\n', built("widget.mjs"))).toEqual([]);
		const sourceOnly = project(
			{ "widget.cts": "export = { a: 1 };" },
			{ compilerOptions: { module: "NodeNext", moduleResolution: "nodenext", allowJs: true }, include: ["**/*"] },
		);
		expect(checkSelfImport('import m from "./widget.cjs";\nexport const { a } = m;\n', sourceOnly("widget.mjs"))).toEqual(
			[],
		);
	});

	it("N11: a rootDirs virtual sibling sharing the importer's stem", () => {
		const at = project(
			{ "generated/widget.gen.ts": "export const gen = 1;" },
			{ compilerOptions: { module: "ESNext", moduleResolution: "bundler", rootDirs: ["src", "generated"] }, include: ["**/*"] },
		);
		mkdirSync(at("src"), { recursive: true });
		expect(checkSelfImport('import { gen } from "./widget.gen.js";\nexport const g = gen;\n', at("src/widget.ts"))).toEqual(
			[],
		);
	});

	it("N12: Storybook / test companions importing the component they are named after", () => {
		const at = project({ "Button.tsx": "export const Button = () => null;" });
		const story = 'import { Button } from "./Button.js";\nexport default { component: Button };\n';
		expect(checkSelfImport(story, at("Button.stories.tsx"))).toEqual([]);
		// Exporter-first order: the component does not exist yet — unresolvable is not self.
		const orphan = project();
		expect(checkSelfImport('import { Button } from "./Button.js";\nexport const t = Button;\n', orphan("Button.test.tsx"))).toEqual(
			[],
		);
	});

	it("N13: Vite HMR self-accept and jest.requireActual / require.resolve naming the file", () => {
		const at = project();
		const hmr =
			'export let state = 0;\nif (import.meta.hot) import.meta.hot.accept("./widget.js", (m) => { state = m?.state ?? 0; });\n';
		expect(checkSelfImport(hmr, at("widget.ts"))).toEqual([]);
		const runtime = 'export const here = require.resolve("./widget.ts");\nexport const real = jest.requireActual("./widget.ts");\n';
		expect(checkSelfImport(runtime, at("widget.ts"))).toEqual([]);
	});

	it("N14: index.ts re-exporting a generated twin, and a substitution-template dynamic import", () => {
		const at = project({ "index.generated.ts": "export const g = 1;" });
		expect(checkSelfImport('export * from "./index.generated.js";\nexport const h = 2;\n', at("index.ts"))).toEqual([]);
		const dynamic = 'const name = "widget";\nexport const load = () => import(`./${name}.js`);\n';
		expect(checkSelfImport(dynamic, at("widget.ts"))).toEqual([]);
	});

	// Third pass (self_import.round3.probe.mts, 12 candidates): an importer named
	// `<stem>.<asset>.ts` importing the real `./<stem>.<asset>` file. TypeScript's
	// append pass resolves `./Toast.svelte` to `Toast.svelte.ts` (the importer);
	// every runtime loads the exact `Toast.svelte` file first.
	it("N15: a Svelte runes module Toast.svelte.ts mounting its own-named component ./Toast.svelte", () => {
		const at = project({ "Toast.svelte": "<script>let { msg } = $props();</script><p>{msg}</p>" });
		const src =
			'import { mount } from "svelte";\nimport Toast from "./Toast.svelte";\nexport const toast = (msg: string) => mount(Toast, { target: document.body, props: { msg } });\n';
		expect(checkSelfImport(src, at("Toast.svelte.ts"))).toEqual([]);
	});

	it("N16: Vue, vanilla-extract, GLSL and YAML wrappers importing their same-named asset", () => {
		const at = project({ "Comp.vue": "<template><div/></template>", "theme.css": ":root{}", "shader.glsl": "void main(){}", "messages.yaml": "a: b" });
		expect(checkSelfImport('import Comp from "./Comp.vue";\nexport default Comp;\n', at("Comp.vue.ts"))).toEqual([]);
		expect(checkSelfImport('import "./theme.css";\nexport const root = "r";\n', at("theme.css.ts"))).toEqual([]);
		expect(checkSelfImport('import src from "./shader.glsl";\nexport const s = src;\n', at("shader.glsl.ts"))).toEqual([]);
		expect(checkSelfImport('import raw from "./messages.yaml";\nexport const m = raw;\n', at("messages.yaml.ts"))).toEqual([]);
	});
});

describe("self_import — positive (must fire)", () => {
	it("P1: a value self-import with the .js spelling still fires", () => {
		const at = project();
		expect(checkSelfImport('import { x } from "./widget.js";\nexport const x = 1;\n', at("widget.ts"))).toHaveLength(1);
	});

	it("P2: a namespace self-import still fires", () => {
		const at = project();
		expect(checkSelfImport('import * as self from "./widget.js";\nexport const x = self;\n', at("widget.ts"))).toHaveLength(1);
	});

	it("P3: a barrel re-exporting itself still fires", () => {
		const at = project();
		expect(checkSelfImport('export * from "./index.js";\n', at("index.ts"))).toHaveLength(1);
	});

	it("P4: an asset-named module with NO such asset on disk still fires (bundlers append too)", () => {
		const at = project();
		expect(checkSelfImport('import Toast from "./Toast.svelte";\nexport const t = Toast;\n', at("Toast.svelte.ts"))).toHaveLength(1);
	});

	it("P5: a script-extension spelling of the importer still fires with a same-named file on disk", () => {
		const at = project({ "Toast.svelte": "<p/>", "widget.js": "export const a = 1;" });
		expect(checkSelfImport('import * as self from "./Toast.svelte.js";\nexport const s = self;\n', at("Toast.svelte.ts"))).toHaveLength(1);
		expect(checkSelfImport('export { a } from "./widget.js";\n', at("widget.ts"))).toHaveLength(1);
	});
});
