// ===========================================
// taste-smell-same-typed-params — mutation-hardening cases
// Each case pins behavior documented in the module's own header/doc comments
// (taste-smell-same-typed-params.ts) that the base test file leaves unpinned.
// ===========================================

import { describe, expect, it } from "vitest";
import { checkSameTypedPrimitiveParams } from "./taste-smell-same-typed-params.js";

const SRC = "src/lib/transfer.ts";

describe("checkSameTypedPrimitiveParams — exported-class scope closes with its class", () => {
	// Module doc: methods count only "inside an exported class". Scope tracking
	// must also work when the exported class is itself nested at brace depth > 0.
	it("does not flag a method of a non-exported class that follows a nested exported class", () => {
		const content = [
			"namespace N {",
			"\texport class C {",
			"\t\tok(n: number) {}",
			"\t}",
			"\tclass Hidden {",
			"\t\tm(from: string, to: string) {}",
			"\t}",
			"}",
			"",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC)).toEqual([]);
	});
});

describe("checkSameTypedPrimitiveParams — control-flow keywords are not methods", () => {
	// Source comment (line 105): "Avoid control-flow keywords with the same shape".
	it.each(["if", "while", "for", "switch", "return", "throw", "catch", "else", "do", "try", "new"])(
		"does not treat `%s (...)` inside an exported class as a public method",
		(kw) => {
			const content = [
				"export class Svc {",
				`\t${kw} (from: string, to: string) {}`,
				"}",
				"",
			].join("\n");
			expect(checkSameTypedPrimitiveParams(content, SRC)).toEqual([]);
		},
	);

	it("still flags a real public method of the same class (control: scope is active)", () => {
		const content = ["export class Svc {", "\tmove(from: string, to: string) {}", "}", ""].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC)).toHaveLength(1);
	});
});

describe("checkSameTypedPrimitiveParams — allowlist applies case-insensitively", () => {
	// Source lines 130-131 compare lower-cased names against the allowlist.
	it.each([
		["X", "y"],
		["x", "Y"],
	])("exempts (%s, %s) like the lower-case coordinate pair", (left, right) => {
		const content = `export function setPoint(${left}: number, ${right}: number) {}\n`;
		expect(checkSameTypedPrimitiveParams(content, SRC)).toEqual([]);
	});
});

describe("checkSameTypedPrimitiveParams — every documented allowlist name is exempt", () => {
	// Module doc (lines 157-160) lists: x/y/z, r/g/b/a, w/h/width/height,
	// lat/lng/lon/long/latitude/longitude, i/j/k, min/max.
	const documented = [
		"x", "y", "z", "r", "g", "b", "a", "w", "h", "width", "height", "i", "j", "k",
		"lat", "lng", "lon", "long", "latitude", "longitude", "min", "max",
	];
	it.each(documented)("exempts a pair of `%s` with another documented name", (name) => {
		const partner = name === "x" ? "y" : "x";
		const content = `export function f(${name}: number, ${partner}: number) {}\n`;
		expect(checkSameTypedPrimitiveParams(content, SRC)).toEqual([]);
	});

	it("still flags an allowlisted name paired with an ordinary name", () => {
		const content = "export function f(x: number, count: number) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC)).toHaveLength(1);
	});
});

describe("checkSameTypedPrimitiveParams — signature window", () => {
	// Doc comment on collectParamList: "Reads up to 20 subsequent lines".
	it("analyzes a signature whose closing paren is on the 20th line", () => {
		const lines = ["export function f(", "\tfrom: string,", "\tto: string,"];
		while (lines.length < 19) lines.push("");
		lines.push(") {}", "");
		expect(lines.indexOf(") {}")).toBe(19);
		expect(checkSameTypedPrimitiveParams(lines.join("\n"), SRC)).toHaveLength(1);
	});

	// Source comment (line 294): depths way off => the signature isn't well-formed.
	it("gives up on a signature with implausibly deep unclosed generics, even after an arrow type", () => {
		const content = [
			"export function f(from: string, to: string, cb: () => void, m: Map<Map<Map<Map<Map<",
			"string, string>, string>, string>, string>, string>) {}",
			"",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC)).toEqual([]);
	});
});

describe("checkSameTypedPrimitiveParams — parameter shapes", () => {
	// Source comment (line 364): `[modifiers ]?name[?]: <annotation>[= default]`.
	it("flags two adjacent optional same-typed params", () => {
		const content = "export function f(from?: string, to?: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC)).toHaveLength(1);
	});

	it("flags two adjacent same-typed params that carry default values", () => {
		const content = 'export function f(from: number = 1, to: number = 2) {}\n';
		expect(checkSameTypedPrimitiveParams(content, SRC)).toHaveLength(1);
	});

	// Module doc: primitive types are `string`, `number`, `boolean`.
	it("flags two adjacent boolean params", () => {
		const content = "export function f(isOn: boolean, isOff: boolean) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text).toContain("boolean");
	});

	it("does not pair a boolean with a number", () => {
		const content = "export function f(isOn: boolean, count: number) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC)).toEqual([]);
	});

	it("does not pair a string with a number", () => {
		const content = "export function f(name: string, count: number) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC)).toEqual([]);
	});
});

describe("checkSameTypedPrimitiveParams — extensions and test files", () => {
	// Module doc: "Only runs on .ts, .tsx, .mts, .cts".
	it.each([".ts", ".tsx", ".mts", ".cts"])("analyzes %s files", (ext) => {
		const content = "export function f(from: string, to: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, `src/lib/f${ext}`)).toHaveLength(1);
	});

	it.each([".js", ".mjs", ".py", ".md"])("ignores %s files", (ext) => {
		const content = "export function f(from: string, to: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, `src/lib/f${ext}`)).toEqual([]);
	});

	// Module doc: "Skip test files."
	it.each(["src/lib/f.test.ts", "src/lib/f.spec.tsx", "src/lib/__tests__/f.ts"])(
		"skips test file %s",
		(path) => {
			const content = "export function f(from: string, to: string) {}\n";
			expect(checkSameTypedPrimitiveParams(content, path)).toEqual([]);
		},
	);
});

describe("checkSameTypedPrimitiveParams — result limits and line numbers", () => {
	const fn = (n: number): string => `export function f${n}(from: string, to: string) {}`;

	it("reports the 1-based line of the signature", () => {
		const content = ["// header", "", fn(1), ""].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC).map((m) => m.line)).toEqual([3]);
	});

	// Source: `if (matches.length >= 10) break;` — at most 10 findings per file.
	it("caps findings at 10 per file", () => {
		const content = `${Array.from({ length: 12 }, (_, n) => fn(n)).join("\n")}\n`;
		expect(checkSameTypedPrimitiveParams(content, SRC)).toHaveLength(10);
	});

	it("reports all findings when there are fewer than the cap (9 and 10)", () => {
		for (const count of [9, 10]) {
			const content = `${Array.from({ length: count }, (_, n) => fn(n)).join("\n")}\n`;
			expect(checkSameTypedPrimitiveParams(content, SRC)).toHaveLength(count);
		}
	});

	// Source: the echoed signature is `.trim().slice(0, 100)`.
	it("echoes at most the first 100 characters of the signature line", () => {
		const pad = "x".repeat(150);
		const content = `export function f(from: string, to: string, ${pad}: number) {}\n`;
		const matches = checkSameTypedPrimitiveParams(content, SRC);
		expect(matches).toHaveLength(1);
		const echoed = (matches[0]?.text ?? "").split("] ").slice(1).join("] ");
		expect(echoed).toBe(content.trim().slice(0, 100));
	});
});
