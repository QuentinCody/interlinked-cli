// Tests for project-graph/mask-comments.ts.

import { describe, expect, it } from "vitest";
import { maskComments } from "./mask-comments.js";

describe("maskComments — positive (comment text is removed)", () => {
	it("P1: removes a multi-line block comment and keeps the line count", () => {
		const out = maskComments("a\n/**\n * import('./x')\n */\nb");
		expect(out.split("\n")).toHaveLength(5);
		expect(out).not.toContain("import");
		expect(out.startsWith("a\n")).toBe(true);
		expect(out.endsWith("\nb")).toBe(true);
	});

	it("P2: removes an inline block comment and keeps the code around it", () => {
		expect(maskComments("let x = /* import('./t') */ 1;")).toBe("let x =  1;");
	});

	it("P3: removes a line comment", () => {
		expect(maskComments("x(); // import('./t')\ny();")).toBe("x(); \ny();");
	});

	it("P4: a block comment that never closes masks to the end of the text", () => {
		expect(maskComments("a /* open\nimport('./t')")).toBe("a \n");
	});
});

describe("maskComments — negative (code and strings are kept)", () => {
	it("N1: keeps a '/*' inside a string literal", () => {
		const code = `const g = "src/**/*.ts"; import('./a');`;
		expect(maskComments(code)).toBe(code);
	});

	it("N2: keeps '//' inside a string literal", () => {
		const code = `const u = 'http://x.test'; f();`;
		expect(maskComments(code)).toBe(code);
	});

	it("N3: an escaped quote does not end a string early", () => {
		const code = `const s = "a\\"/*b"; f();`;
		expect(maskComments(code)).toBe(code);
	});

	it("N4: text without a comment is returned unchanged", () => {
		expect(maskComments("import { a } from './a.js';")).toBe("import { a } from './a.js';");
	});

	it("N5: a stray quote on one line does not change the next line", () => {
		const out = maskComments("it's fine\n/* gone */ keep");
		expect(out).toBe("it's fine\n keep");
	});
});
