// Tests for project-graph/mask-templates.ts (comment and template-literal text
// removal) and its effect on parseImports.

import { describe, expect, it } from "vitest";
import { maskCommentsAndTemplates } from "./mask-templates.js";
import { parseImports } from "./parser-imports.js";

function specifiers(src: string): string[] {
	return parseImports(src, "/p/a.ts").map((e) => e.specifier);
}

describe("maskCommentsAndTemplates — template text is removed", () => {
	it("P1: literal text goes, backticks and newlines stay", () => {
		expect(maskCommentsAndTemplates("const a = `x\ny\nz`;")).toBe("const a = `\n\n`;");
	});

	it("P2: a ${...} expression stays code; its literal siblings go", () => {
		expect(maskCommentsAndTemplates("f(`a${b + 1}c`);")).toBe("f(`${b + 1}`);");
	});

	it("P3: a template nested in an expression is masked too", () => {
		expect(maskCommentsAndTemplates("f(`a${g(`in${h}er`)}b`);")).toBe("f(`${g(`${h}`)}`);");
	});

	it("P4: an escaped backtick does not close the template", () => {
		expect(maskCommentsAndTemplates("f(`a\\`b`); g();")).toBe("f(``); g();");
	});
});

describe("maskCommentsAndTemplates — comments", () => {
	it("P7: a `//` line inside template text is text, not a comment that eats the closing backtick", () => {
		const src = "const t = `// SPDX\nsee https://x.test`;\nimport('./real');\n";
		expect(maskCommentsAndTemplates(src)).toBe("const t = `\n`;\nimport('./real');\n");
	});

	it("P8: comments in code are removed, and a backtick inside one opens no template", () => {
		const src = "a(); // the `tick\nb(); /* `x\n*/ c();\nconst t = `q`;\n";
		expect(maskCommentsAndTemplates(src)).toBe("a(); \nb(); \n c();\nconst t = ``;\n");
	});

	it("N8: an unterminated template still gets comment masking", () => {
		expect(maskCommentsAndTemplates("a(); // c\nconst t = `open")).toBe("a(); \nconst t = `open");
	});
});

describe("maskCommentsAndTemplates — code is kept", () => {
	it("N1: text with no backtick and no comment is returned as is", () => {
		const code = `import { a } from "./a";\nf('x');\n`;
		expect(maskCommentsAndTemplates(code)).toBe(code);
	});

	it("N2: a backtick inside a quoted string does not open a template", () => {
		const code = `const s = "a\`b"; const t = 'c\`d'; import("./x");`;
		expect(maskCommentsAndTemplates(code)).toBe(code);
	});

	it("N3: an unterminated template leaves the text unchanged (no verdict from a guess)", () => {
		const code = "const a = `open\nimport('./x');";
		expect(maskCommentsAndTemplates(code)).toBe(code);
	});

	it("N4: braces in code outside any template do not disturb a later template", () => {
		expect(maskCommentsAndTemplates("if (a) { b(); }\nconst t = `q${c}`;")).toBe(
			"if (a) { b(); }\nconst t = `${c}`;",
		);
	});
});

describe("parseImports — imports written inside template literals are not edges", () => {
	it("N5: require / import() inside a multi-line template are not edges", () => {
		const src =
			"const original = `Object.defineProperty(exports, 'x', {});\nconst m = require(\"./mastra.cjs\");\nconst {a} = await import('./guard.mjs');\n`;\nexports.a = 1;\n";
		expect(specifiers(src)).toEqual([]);
	});

	it("N6: a template that holds a path with ${...} is not an edge", () => {
		expect(specifiers("const t = `const g = await import('./${outDir}/guard.mjs');`;\n")).toEqual([]);
	});

	it("N7: a stray quote inside template text does not hide a later real import", () => {
		const src = 'const t = `it\'s a template`;\nimport { real } from "./real";\n';
		expect(specifiers(src)).toEqual(["./real"]);
	});

	it("N9: a template line that holds a URL does not hide the closing backtick", () => {
		const src = "const t = `see https://x.test\n// GENERATED\nawait import('./guard.mjs');\n`;\nimport { real } from './real';\n";
		expect(specifiers(src)).toEqual(["./real"]);
	});

	it("P5: a real require() and import() outside the template stay edges", () => {
		const src = "const t = `require('./fake')`;\nconst a = require('./a');\nconst b = await import('./b');\n";
		expect(specifiers(src)).toEqual(["./a", "./b"]);
	});

	it("P6: a real import() inside a ${...} expression stays in the masked text", () => {
		expect(maskCommentsAndTemplates("const t = `x${await import('./dyn')}y`;\n")).toBe(
			"const t = `${await import('./dyn')}`;\n",
		);
	});
});
