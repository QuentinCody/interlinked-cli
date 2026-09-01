// Evidence-contract cases for public_api_leaks_internal_type (api-surface.ts).

import { describe, expect, it } from "vitest";
import { checkPublicApiLeaksInternalType } from "./api-surface.js";

const FILE = "/repo/src/lib/api.ts";

describe("checkPublicApiLeaksInternalType — positive (must fire)", () => {
	it("P1: exported function returns a non-exported interface", () => {
		const src = [
			"interface Options { retries: number }",
			"export function run(): Options {",
			"\treturn { retries: 1 };",
			"}",
		].join("\n");
		const out = checkPublicApiLeaksInternalType(src, FILE);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("'Options'");
		expect(out[0]?.line).toBe(2);
	});

	it("P2: exported const annotated with a non-exported type alias", () => {
		const src = [
			"type Config = { url: string };",
			'export const defaults: Config = { url: "x" };',
		].join("\n");
		expect(checkPublicApiLeaksInternalType(src, FILE)).toHaveLength(1);
	});

	it("P3: exported interface extends a non-exported interface", () => {
		const src = [
			"interface Base { id: string }",
			"export interface Item extends Base {",
			"\tname: string;",
			"}",
		].join("\n");
		expect(checkPublicApiLeaksInternalType(src, FILE)).toHaveLength(1);
	});

	it("P4: multi-line signature returning a non-exported enum", () => {
		const src = [
			"enum Mode { A, B }",
			"export function pick(",
			"\tn: number,",
			"): Mode {",
			"\treturn n === 0 ? Mode.A : Mode.B;",
			"}",
		].join("\n");
		expect(checkPublicApiLeaksInternalType(src, FILE)).toHaveLength(1);
	});
});

describe("checkPublicApiLeaksInternalType — negative (must not fire)", () => {
	it("N1: signature references an exported type", () => {
		const src = [
			"export interface Options { retries: number }",
			"export function run(): Options {",
			"\treturn { retries: 1 };",
			"}",
		].join("\n");
		expect(checkPublicApiLeaksInternalType(src, FILE)).toEqual([]);
	});

	it("N2: internal type used only inside the function body", () => {
		const src = [
			"interface Scratch { n: number }",
			"export function run(): number {",
			"\tconst s: Scratch = { n: 1 };",
			"\treturn s.n;",
			"}",
		].join("\n");
		expect(checkPublicApiLeaksInternalType(src, FILE)).toEqual([]);
	});

	it("N3: internal name made public via a later export statement", () => {
		const src = [
			"interface Options { retries: number }",
			"export function run(): Options {",
			"\treturn { retries: 1 };",
			"}",
			"export type { Options };",
		].join("\n");
		expect(checkPublicApiLeaksInternalType(src, FILE)).toEqual([]);
	});

	it("N4: internal type in a NON-exported function's signature", () => {
		const src = [
			"interface Options { retries: number }",
			"function helper(o: Options): number {",
			"\treturn o.retries;",
			"}",
			"export const x = 1;",
		].join("\n");
		expect(checkPublicApiLeaksInternalType(src, FILE)).toEqual([]);
	});

	it("N5: test files and non-TS files are skipped", () => {
		const src = ["interface I { n: number }", "export function f(): I { return { n: 1 }; }"].join(
			"\n",
		);
		expect(checkPublicApiLeaksInternalType(src, "/repo/src/lib/api.test.ts")).toEqual([]);
		expect(checkPublicApiLeaksInternalType(src, "/repo/src/lib/api.js")).toEqual([]);
		expect(checkPublicApiLeaksInternalType(src, "/repo/src/lib/api.d.ts")).toEqual([]);
	});

	it("N7: parameter-position reference is exempt (options-bag idiom)", () => {
		// 182 fires on this tree unrefined — the deliberate `cmd(opts: LocalOpts)`
		// pattern; callers pass object literals structurally without naming it.
		const src = [
			"interface AddOpts { force?: boolean }",
			"export async function addCommand(opts: AddOpts): Promise<void> {",
			"}",
		].join("\n");
		expect(checkPublicApiLeaksInternalType(src, FILE)).toEqual([]);
	});

	it("N6: type name mentioned only in a string or comment", () => {
		const src = [
			"interface Options { retries: number }",
			'export function run(): string {',
			'\treturn "uses Options internally"; // Options is private',
			"}",
		].join("\n");
		expect(checkPublicApiLeaksInternalType(src, FILE)).toEqual([]);
	});
});
