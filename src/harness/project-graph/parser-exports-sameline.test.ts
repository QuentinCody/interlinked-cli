// An `export` that follows a block comment which closes on the same line
// (`*/ export function f(`, `/** doc */ export const x`) is a real export.
// Check that the scanner resumes at the end of the comment on the same line.

import { describe, expect, it } from "vitest";
import { parseExports } from "./parser-exports.js";

const names = (code: string): string[] => parseExports(code).map((e) => e.name);

it("distinguishes the enclosing module's exports from generated module text", () => {
	const source = [
		"export const script = String.raw`",
		"export async function launch() { return 2; }",
		"`;",
		"export const after = 1;",
	].join("\n");
	expect(parseExports(source).map(({ name, line }) => [name, line])).toEqual([["script", 1], ["after", 4]]);
});

describe("parseExports — export after a comment that ends on the same line", () => {
	it("P1: `*/ export function` closing a multi-line comment records the function", () => {
		expect(names(["/**", " * doc", " */ export function applyIt(", "\tx: number,", ") {}"].join("\n"))).toEqual(["applyIt"]);
	});

	it("P2: `/** doc */ export const` on one line records the constant", () => {
		expect(names(`/** doc */ export const limit = 1;`)).toEqual(["limit"]);
	});

	it("P3: every declaration form is read after the comment", () => {
		const forms = [
			["/* c */ export async function a() {}", "a"],
			["/* c */ export class B {}", "B"],
			["/* c */ export abstract class C {}", "C"],
			["/* c */ export interface D {}", "D"],
			["/* c */ export type E = 1;", "E"],
			["/* c */ export enum F { X }", "F"],
			["/* c */ export const enum G { X }", "G"],
			["/* c */ export let h = 1;", "h"],
			["/* c */ export declare const i: number;", "i"],
			["/* c */ export namespace J {}", "J"],
		] as const;
		for (const [code, name] of forms) expect(names(code), code).toEqual([name]);
	});

	it("P4: a default export, a brace list and a star re-export are read after the comment", () => {
		expect(names(`/* c */ export default function main() {}`)).toEqual(["default", "main"]);
		expect(names(`/* c */ export { one, two as three };`)).toEqual(["one", "three"]);
		expect(names(`/* c */ export * as ns from './x';`)).toEqual(["ns"]);
	});

	it("P5: two comments in a row before the export are both skipped", () => {
		expect(names(`/* a */ /** b */ export function both() {}`)).toEqual(["both"]);
		expect(names(["/* a", "*/ /* b */ export const chained = 1;"].join("\n"))).toEqual(["chained"]);
	});

	it("P6: a multi-line brace list that starts after a comment is read to its end", () => {
		expect(names(["/* c */ export {", "\tone,", "\ttwo,", "};"].join("\n"))).toEqual(["one", "two"]);
	});

	it("N1: an export that sits inside the comment is not recorded", () => {
		expect(names(`/* export function gone() {} */`)).toEqual([]);
		expect(names(["/*", " export function gone() {}", "*/"].join("\n"))).toEqual([]);
	});

	it("N2: an export after a comment on a line comment is not recorded", () => {
		expect(names(`/* c */ // export function gone() {}`)).toEqual([]);
	});

	it("N3: a comment that has not closed hides the export text that follows on that line", () => {
		expect(names(["/* open export function gone() {}", "still comment", "*/"].join("\n"))).toEqual([]);
	});

	it("N4: the line after a closing `*/` that holds no code adds nothing", () => {
		expect(names(["/**", " * doc", " */", "export const real = 1;"].join("\n"))).toEqual(["real"]);
	});
});
