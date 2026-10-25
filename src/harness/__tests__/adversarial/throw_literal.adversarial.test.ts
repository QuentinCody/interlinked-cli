// Independent adversarial review of the `throw_literal` pre_block check
// (2026-10-21). Probe: `scratch/2026-10-21-adversarial/throw_literal.probe.mts`.
// A pre_block check blocks an agent's edit, so each negative here is a
// legitimate edit the gate must not refuse. N1–N3 fired before
// `blankJsxText` covered the `.js` / `.mjs` / `.cjs` JSX-capable extensions.

import { describe, expect, it } from "vitest";
import { checkThrowLiteral } from "../../checks/agent-safety-advanced-style.js";

describe("throw_literal — negative (must not fire)", () => {
	it("N1: JSX text in a .js React page (CRA / Next.js keep JSX in .js)", () => {
		const code = [
			"export default function Errors() {",
			"\treturn (",
			"\t\t<pre>",
			'\t\t\tthrow "boom";',
			"\t\t</pre>",
			"\t);",
			"}",
		].join("\n");
		expect(checkThrowLiteral(code, "src/pages/errors.js")).toEqual([]);
	});

	it("N2: JSX text `throw null` in a .mjs docs component", () => {
		const code = ["export const Doc = () => (", "\t<p>", "\t\tthrow null", "\t</p>", ");"].join("\n");
		expect(checkThrowLiteral(code, "src/docs/null-throw.mjs")).toEqual([]);
	});

	it("N3: JSX text in a Flow-annotated .js component", () => {
		const code = [
			"// @flow",
			"type Props = { title: ?string };",
			"export const Explain = (props: Props) => (",
			"\t<pre>",
			"\t\tthrow 'oops'",
			"\t</pre>",
			");",
		].join("\n");
		expect(checkThrowLiteral(code, "src/components/Explain.js")).toEqual([]);
	});

	it("N4: JSX text in a .tsx docs component", () => {
		const code = ["export function T() {", "\treturn (", "\t\t<pre>", '\t\t\tthrow "boom";', "\t\t</pre>", "\t);", "}"].join(
			"\n",
		);
		expect(checkThrowLiteral(code, "src/docs/ThrowExplainer.tsx")).toEqual([]);
	});

	it("N5: a multi-line JSX attribute string that carries a code sample", () => {
		const code = ["export const S = () => <Code", '\tsource="function f() {', "throw 'boom';", '}"', "/>;"].join("\n");
		expect(checkThrowLiteral(code, "src/docs/Snippet.tsx")).toEqual([]);
	});

	it("N6: a multi-line template literal that carries a code sample", () => {
		const code = ["export const BAD_EXAMPLE = `", '\tthrow "boom";', "`;"].join("\n");
		expect(checkThrowLiteral(code, "src/docs/examples.ts")).toEqual([]);
	});
});

describe("throw_literal — positive (must fire)", () => {
	it("P1: a string throw in a .js file that also renders JSX", () => {
		const code = ["export default function Errors() {", '\tthrow "boom";', "\treturn <pre>x</pre>;", "}"].join("\n");
		expect(checkThrowLiteral(code, "src/pages/errors.js")).toEqual([{ line: 2, text: 'throw "boom";' }]);
	});

	it("P2: `throw null` in a .mjs module", () => {
		const code = ["export function f() {", "\tthrow null;", "}"].join("\n");
		expect(checkThrowLiteral(code, "src/lib/f.mjs")).toEqual([{ line: 2, text: "throw null;" }]);
	});

	it("P3: a template-literal throw", () => {
		const code = ["function f(x: string) {", "\tthrow `bad ${x}`;", "}"].join("\n");
		expect(checkThrowLiteral(code, "src/lib/errors.ts")).toEqual([{ line: 2, text: "throw `bad ${x}`;" }]);
	});
});
