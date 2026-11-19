// Tests for project-graph/parser-exports-destructure.ts.

import { describe, expect, it } from "vitest";
import {
	bracketDepth,
	destructuredExportNames,
	startsDestructuredExport,
} from "./parser-exports-destructure.js";

describe("destructuredExportNames — positive", () => {
	it("P1: reads shorthand, rename, default and rest bindings", () => {
		expect(destructuredExportNames("export const { a, b: c, d = 1, ...e } = x;")).toEqual(["a", "c", "d", "e"]);
	});

	it("P2: reads array bindings and skips holes", () => {
		expect(destructuredExportNames("export let [p, , q = [1, 2], ...r] = y;")).toEqual(["p", "q", "r"]);
	});

	it("P3: reads nested patterns and ignores a default value that holds braces", () => {
		expect(destructuredExportNames("export const { a: { b }, c = { k: 1 }, d } = z;")).toEqual(["b", "c", "d"]);
	});
});

describe("destructuredExportNames — negative", () => {
	it("N1: a plain declaration yields no names", () => {
		expect(destructuredExportNames("export const x = 1;")).toEqual([]);
	});

	it("N2: an unterminated pattern yields the names read so far without throwing", () => {
		expect(destructuredExportNames("export const { a, b")).toEqual(["a", "b"]);
	});
});

describe("startsDestructuredExport / bracketDepth", () => {
	it("P4: recognises the start of a destructured export", () => {
		expect(startsDestructuredExport("export const { a } = x;")).toBe(true);
		expect(startsDestructuredExport("export var [a] = x;")).toBe(true);
	});

	it("N3: does not match `export const x`, `export {` or `export default {`", () => {
		expect(startsDestructuredExport("export const x = {")).toBe(false);
		expect(startsDestructuredExport("export { a };")).toBe(false);
		expect(startsDestructuredExport("export default { a };")).toBe(false);
	});

	it("P5: bracketDepth counts open minus close brackets and ignores strings", () => {
		expect(bracketDepth("export const { a, b: {")).toBe(2);
		expect(bracketDepth("export const { a } = '}{'")).toBe(0);
		expect(bracketDepth("export const [a] = f(")).toBe(0);
	});
});
