// Tests for the export forms in parser-exports-forms.ts, through parseExports:
// namespaces, `declare` declarations, and the minified bundle `export{...}`.
// Every MUST-NOT-FIRE case measured as a false "missing export" on a real repo.

import { describe, expect, it } from "vitest";
import { parseExports } from "./parser-exports.js";

function names(src: string): string[] {
	return parseExports(src).map((e) => e.name);
}

describe("namespace and module exports", () => {
	it("P1: export namespace / declare namespace / module count as exports of that name", () => {
		expect(names("export namespace DomainModel {\n}")).toEqual(["DomainModel"]);
		expect(names("export declare namespace X { }")).toEqual(["X"]);
		expect(names("export module Legacy { }")).toEqual(["Legacy"]);
		expect(names("export declare module M { }")).toEqual(["M"]);
	});

	it("P2: a dotted namespace exports its first segment", () => {
		expect(names("export namespace A.B.C { }")).toEqual(["A"]);
	});

	it("N1: an ambient module with a string name exports nothing", () => {
		expect(names(`export declare module "x" { }`)).toEqual([]);
	});

	it("N2: a function named `namespace` is not a namespace form", () => {
		expect(names("export function namespace() {}")).toEqual(["namespace"]);
	});
});

describe("declare declarations", () => {
	it("P3: export declare function/class/const/let/var/interface/type/enum export the name", () => {
		const src = [
			"export declare function f(a: number): void;",
			"export declare class C {}",
			"export declare abstract class AC {}",
			"export declare const k: number;",
			"export declare let l: number;",
			"export declare const enum CE { A }",
			"export declare enum E { A }",
			"export declare interface I {}",
			"export declare type T = 1;",
		].join("\n");
		expect(names(src)).toEqual(["f", "C", "AC", "k", "l", "CE", "E", "I", "T"]);
	});

	it("P4: export enum, const enum and abstract class keep working", () => {
		expect(names("export enum A { X }\nexport const enum B { X }\nexport abstract class D {}")).toEqual(["A", "B", "D"]);
	});

	it("N3: `export declare` with nothing nameable exports nothing", () => {
		expect(names("export declare global { }")).toEqual([]);
	});
});

describe("minified export lists", () => {
	it("P5: an `export{...}` that ends a long bundle line lists its names", () => {
		const src = `var a=1,b=2;function f(){return 1}export{a as ACTION,b as default,f as run};\n`;
		expect(names(src)).toEqual(["ACTION", "default", "run"]);
	});

	it("P6: `export{a,b}` with no space after the keyword is read at the start of a line", () => {
		expect(names("export{a,b as c};")).toEqual(["a", "c"]);
	});

	it("N4: the same text inside a string literal is not an export", () => {
		expect(names(`const s = "x;export{a}";\n`)).toEqual([]);
	});

	it("N5: an `export{` that is not the end of its statement line adds nothing twice", () => {
		expect(parseExports("export { a };\n").map((e) => e.name)).toEqual(["a"]);
	});
});
