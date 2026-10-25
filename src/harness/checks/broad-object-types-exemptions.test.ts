// Companion unit tests for the `broad_object_types` bare-`object` exemption
// classes. The foreign-repo adjudicated cases (real zod / zustand snippets)
// live in src/harness/__tests__/adversarial/broad_object_types.foreign.test.ts;
// this file pins each helper's own branch in both directions.
import { describe, expect, it } from "vitest";
import {
	isExemptBareObject,
	isNarrowingCast,
	isReflectionTargetParam,
	isSpecifierRename,
	isTypeGuardSignature,
} from "./broad-object-types-exemptions.js";

const lines = (src: string): string[] => src.split("\n");

describe("isSpecifierRename", () => {
	it("P1: single-line export rename specifier", () => {
		expect(isSpecifierRename(lines("export { objectType as object, stringType as string };"), 0)).toBe(true);
	});
	it("P2: bare specifier row inside a multi-line export list", () => {
		const src = ["export {", "  numberType as number,", "  objectType as object,", "  optionalType as optional,", "};"];
		expect(isSpecifierRename(src, 2)).toBe(true);
	});
	it("P3: `import * as object from`", () => {
		expect(isSpecifierRename(lines('import * as object from "./object.js";'), 0)).toBe(true);
	});
	it("N1: a bare-looking row after the list closed is not a specifier", () => {
		const src = ["export { a as b };", "const x = y", "  as object,"];
		expect(isSpecifierRename(src, 2)).toBe(false);
	});
	it("N2: an ordinary cast line is not a specifier", () => {
		expect(isSpecifierRename(lines("const o = fetchUser() as object;"), 0)).toBe(false);
	});
});

describe("isTypeGuardSignature", () => {
	it("P1: same-line predicate", () => {
		expect(isTypeGuardSignature(lines("const isIterable = (obj: object): obj is Iterable<unknown> =>"), 0)).toBe(
			true,
		);
	});
	it("P2: predicate on a following line of a multi-line signature", () => {
		const src = ["function isRecord(", "  value: object,", "): value is Record<string, unknown> {", "  return true;", "}"];
		expect(isTypeGuardSignature(src, 1)).toBe(true);
	});
	it("P3: assertion predicate (`asserts x is T`)", () => {
		expect(isTypeGuardSignature(lines("function assertUser(x: object): asserts x is User {"), 0)).toBe(true);
	});
	it("N1: a plain signature with no predicate", () => {
		expect(isTypeGuardSignature(lines("function inspect(x: object): void {"), 0)).toBe(false);
	});
	it("N2: the predicate must be within the signature window", () => {
		const src = ["function a(x: object) {", "  return 1;", "}", "", "", "", "function b(y: unknown): y is T {"];
		expect(isTypeGuardSignature(src, 0)).toBe(false);
	});
	it("N3: a guard declared on the NEXT lines is not this signature's predicate", () => {
		const src = ["function a(x: object): void { run(x); }", "const isFoo = (y: unknown): y is Foo =>", "  true;"];
		expect(isTypeGuardSignature(src, 0)).toBe(false);
	});
	it("N4: a predicate on a DIFFERENT parameter does not exempt the `object` one", () => {
		expect(isTypeGuardSignature(lines("function g(opts: object, y: unknown): y is Foo {"), 0)).toBe(false);
	});
	it("P4: a callback parameter type's parens do not end the parameter list early", () => {
		const src = lines("function isNode(n: object, visit: (k: string) => void): n is Node {");
		expect(isTypeGuardSignature(src, 0)).toBe(true);
	});
});

describe("isNarrowingCast", () => {
	it("P1: operand declared `unknown` as a parameter", () => {
		const src = lines("function f(value: unknown) {\n  const o = value as object;\n}");
		expect(isNarrowingCast(src, 1)).toBe(true);
	});
	it("P2: operand is a catch binding", () => {
		const src = lines("try {} catch (err) {\n  log(err as object);\n}");
		expect(isNarrowingCast(src, 1)).toBe(true);
	});
	it("P3: cast inside a reflection consumer on the same line", () => {
		expect(isNarrowingCast(["  const keys = Object.keys(value as object).sort();"], 0)).toBe(true);
		expect(isNarrowingCast(["  seen.add(value as object);"], 0)).toBe(true);
		expect(isNarrowingCast(["  ...(persistedState as object),"], 0)).toBe(true);
	});
	it("N1: a stored cast of a value with a declared shape", () => {
		const src = lines("function f(user: User) {\n  const o = user as object;\n}");
		expect(isNarrowingCast(src, 1)).toBe(false);
	});
	it("N2: a line without an `as object` cast", () => {
		expect(isNarrowingCast(["x: unknown", "function g(x: object) {}"], 1)).toBe(false);
	});
	it("N3: the NEAREST declaration decides — an earlier same-named `unknown` does not exempt a typed cast", () => {
		const src = lines(
			"function parse(value: unknown) {\n  return typeof value;\n}\nfunction store(value: User) {\n  const o = value as object;\n}",
		);
		expect(isNarrowingCast(src, 4)).toBe(false);
	});
	it("N4: an unannotated `const` redeclaration shadows an earlier `unknown`", () => {
		const src = lines("function f(data: unknown) {\n  return 1;\n}\nconst data = loadUser();\nconst o = data as object;");
		expect(isNarrowingCast(src, 4)).toBe(false);
	});
	it("N5: no declaration within the window ⇒ not exempt", () => {
		expect(isNarrowingCast(["const o = mystery as object;"], 0)).toBe(false);
	});
});

describe("isReflectionTargetParam", () => {
	it("P1: parameter passed to Object.defineProperty in its body", () => {
		const src = ["function lazy(proto: object, key: string): void {", "  Object.defineProperty(proto, key, {});", "}"];
		expect(isReflectionTargetParam(src, 0)).toBe(true);
	});
	it("P2: parameter used as an `in` operand in a brace-less arrow body", () => {
		const src = ["const isIterable = (obj: object) =>", "  Symbol.iterator in obj"];
		expect(isReflectionTargetParam(src, 0)).toBe(true);
	});
	it("P3: parameter used as a WeakMap key", () => {
		const src = ["function tag(target: object) {", "  cache.set(target, 1);", "}"];
		expect(isReflectionTargetParam(src, 0)).toBe(true);
	});
	it("N1: parameter never used reflectively in its own block", () => {
		const src = ["function render(props: object) {", "  return template(props);", "}", "", "function other(props: object) {", "  Object.keys(props);", "}"];
		expect(isReflectionTargetParam(src, 0)).toBe(false);
	});
	it("N2: an empty body still fires", () => {
		expect(isReflectionTargetParam(["function inspect(x: object) {}"], 0)).toBe(false);
	});
	it("N3: a line with no annotated name (return type position)", () => {
		expect(isReflectionTargetParam(["function make(): object {", "  return {};", "}"], 0)).toBe(false);
	});
	it("N4: a spread options bag is not a reflection target", () => {
		const src = ["function configure(opts: object) {", "  return { ...defaults, ...opts };", "}"];
		expect(isReflectionTargetParam(src, 0)).toBe(false);
	});
	it("N5: a reflection use plus a property read is not ONLY reflection", () => {
		const src = ["function f(cfg: object) {", "  Object.keys(cfg);", "  return (cfg as any).timeout;", "}"];
		expect(isReflectionTargetParam(src, 0)).toBe(false);
	});
	it("N6: a reflection use plus a forward to an arbitrary callee is not ONLY reflection", () => {
		const src = ["function f(cfg: object) {", "  if (Object.keys(cfg).length) send(cfg);", "}"];
		expect(isReflectionTargetParam(src, 0)).toBe(false);
	});
	it("P4: a prototype walk (assignment target, truthiness test) stays opaque", () => {
		const src = [
			"function chain(p: object | null) {",
			"  while (p) {",
			"    seen.add(p);",
			"    p = Object.getPrototypeOf(p);",
			"  }",
			"}",
		];
		expect(isReflectionTargetParam(src, 0)).toBe(true);
	});
	it("P5: an identity comparison and a non-shape key `name:` do not count as reads", () => {
		const src = ["function same(a: object) {", "  if (a === last) return { a: 1 };", "  return weak.has(a);", "}"];
		expect(isReflectionTargetParam(src, 0)).toBe(true);
	});
});

describe("isExemptBareObject", () => {
	it("P1: any one class exempts the line", () => {
		const src = ["function f(value: unknown) {", "  seen.has(value as object);", "}"];
		expect(isExemptBareObject(src, 1)).toBe(true);
	});
	it("N1: a shape-hiding annotation matches no class", () => {
		const src = ["function render(props: object) {", "  return template(props);", "}"];
		expect(isExemptBareObject(src, 0)).toBe(false);
	});
});
