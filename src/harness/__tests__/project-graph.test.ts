import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportedSymbol } from "../types.js";

// ---------------------------------------------------------------------------
// Mock node:fs so tryResolveFile and ProjectGraph tests can control the filesystem
// ---------------------------------------------------------------------------
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	statSync: vi.fn(() => {
		throw new Error("ENOENT");
	}),
	readFileSync: vi.fn(() => {
		throw new Error("ENOENT");
	}),
	readdirSync: vi.fn(() => []),
}));

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { nonNull } from "../../lib/non-null.js";
import { ProjectGraph, parseExports, parseImports } from "../project-graph.js";
import { tryResolveFile } from "../project-graph/resolve.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exportNames(symbols: ExportedSymbol[]): string[] {
	return symbols.map((s) => s.name).sort();
}

const mockedExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;
const mockedStatSync = statSync as unknown as ReturnType<typeof vi.fn>;
const mockedReadFileSync = readFileSync as unknown as ReturnType<typeof vi.fn>;
const mockedReaddirSync = readdirSync as unknown as ReturnType<typeof vi.fn>;

function mockFileExists(paths: Set<string>) {
	mockedExistsSync.mockImplementation((p: string) => paths.has(p));
	mockedStatSync.mockImplementation((p: string) => {
		if (paths.has(p)) {
			return { isFile: () => true, isDirectory: () => false };
		}
		throw new Error("ENOENT");
	});
}

function mockFileSystem(files: Map<string, string>) {
	const pathSet = new Set(files.keys());
	mockFileExists(pathSet);
	mockedReadFileSync.mockImplementation((p: string) => {
		const content = files.get(p as string);
		if (content !== undefined) return content;
		throw new Error("ENOENT");
	});
	// Return empty directory listing (no walkDir scanning)
	mockedReaddirSync.mockImplementation(() => []);
}

// ---------------------------------------------------------------------------
// parseExports
// ---------------------------------------------------------------------------
describe("parseExports", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("parses export const", () => {
		const src = "export const FOO = 42;";
		const syms = parseExports(src);
		expect(syms).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "FOO", kind: "const", isTypeOnly: false }),
			]),
		);
	});

	it("parses export let and export var", () => {
		const src = ["export let mutable = 1;", "export var legacy = 2;"].join("\n");
		const names = exportNames(parseExports(src));
		expect(names).toEqual(["legacy", "mutable"]);
	});

	it("parses export function", () => {
		const src = "export function greet(name: string): string { return name; }";
		const syms = parseExports(src);
		expect(syms).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "greet", kind: "function", isTypeOnly: false }),
			]),
		);
	});

	it("parses export async function", () => {
		const src = "export async function fetchData() {}";
		const syms = parseExports(src);
		expect(syms).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "fetchData", kind: "function" }),
			]),
		);
	});

	it("parses export class", () => {
		const src = "export class Widget {}";
		const syms = parseExports(src);
		expect(syms).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "Widget", kind: "class", isTypeOnly: false }),
			]),
		);
	});

	it("parses export abstract class", () => {
		const src = "export abstract class BaseService {}";
		const syms = parseExports(src);
		expect(syms).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "BaseService", kind: "class" }),
			]),
		);
	});

	it("parses export enum", () => {
		const src = "export enum Color { Red, Green, Blue }";
		const syms = parseExports(src);
		expect(syms).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "Color", kind: "enum", isTypeOnly: false }),
			]),
		);
	});

	it("parses export interface", () => {
		const src = "export interface Config { port: number; }";
		const syms = parseExports(src);
		expect(syms).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "Config", kind: "interface", isTypeOnly: true }),
			]),
		);
	});

	it("parses export type alias", () => {
		const src = "export type ID = string | number;";
		const syms = parseExports(src);
		expect(syms).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "ID", kind: "type", isTypeOnly: true }),
			]),
		);
	});

	it("parses export default", () => {
		const src = "export default function main() {}";
		const syms = parseExports(src);
		expect(syms).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "default", kind: "default", isTypeOnly: false }),
			]),
		);
	});

	it("parses multiline export { } block", () => {
		const src = ["const a = 1;", "const b = 2;", "export {", "    a,", "    b,", "};"].join(
			"\n",
		);
		const names = exportNames(parseExports(src));
		expect(names).toContain("a");
		expect(names).toContain("b");
	});

	it("parses type exports in export { } block", () => {
		const src = ["interface Foo {}", "export { type Foo };"].join("\n");
		const syms = parseExports(src);
		// The "type" keyword is stripped from the name but the export is still detected
		expect(syms).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Foo" })]));
	});

	it("parses re-exports (export { x } from '...')", () => {
		const src = `export { helper } from './utils';`;
		const syms = parseExports(src);
		expect(syms).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "helper", kind: "re-export" }),
			]),
		);
	});

	it("parses export * (star re-export)", () => {
		const src = `export * from './base';`;
		const syms = parseExports(src);
		expect(syms).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "*", kind: "namespace" })]),
		);
	});

	it("parses export * as ns (namespace re-export)", () => {
		const src = `export * as utils from './utils';`;
		const syms = parseExports(src);
		expect(syms).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "utils", kind: "namespace" })]),
		);
	});

	it("skips single-line comments", () => {
		const src = ["// export const HIDDEN = true;", "export const VISIBLE = true;"].join("\n");
		const names = exportNames(parseExports(src));
		expect(names).toEqual(["VISIBLE"]);
		expect(names).not.toContain("HIDDEN");
	});

	it("skips block comments", () => {
		const src = [
			"/*",
			"export const HIDDEN = true;",
			"*/",
			"export const VISIBLE = true;",
		].join("\n");
		const names = exportNames(parseExports(src));
		expect(names).toEqual(["VISIBLE"]);
		expect(names).not.toContain("HIDDEN");
	});

	it("tracks line numbers", () => {
		const src = ["// header", "", "export const A = 1;", "export const B = 2;"].join("\n");
		const syms = parseExports(src);
		const a = syms.find((s) => s.name === "A");
		const b = syms.find((s) => s.name === "B");
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		// line numbers are 1-based; A is on line 3, B on line 4
		expect(a!.line).toBe(3);
		expect(b!.line).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// parseImports
// ---------------------------------------------------------------------------
describe("parseImports", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("parses named imports", () => {
		const src = `import { foo, bar } from './mod';`;
		const edges = parseImports(src, "/src/index.ts");
		expect(edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					fromFile: "/src/index.ts",
					specifier: "./mod",
					symbols: expect.arrayContaining(["foo", "bar"]),
					isTypeOnly: false,
				}),
			]),
		);
	});

	it("parses default import", () => {
		const src = `import Widget from './widget';`;
		const edges = parseImports(src, "/src/app.ts");
		expect(edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					specifier: "./widget",
					symbols: ["Widget"],
				}),
			]),
		);
	});

	it("parses namespace import (import * as)", () => {
		const src = `import * as utils from '../utils';`;
		const edges = parseImports(src, "/src/lib/index.ts");
		expect(edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					specifier: "../utils",
					symbols: [],
				}),
			]),
		);
	});

	it("parses side-effect import", () => {
		const src = `import './polyfill';`;
		const edges = parseImports(src, "/src/main.ts");
		expect(edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					specifier: "./polyfill",
					symbols: [],
				}),
			]),
		);
	});

	it("parses multiline imports", () => {
		const src = ["import {", "    alpha,", "    beta,", "    gamma", "} from './greek';"].join(
			"\n",
		);
		const edges = parseImports(src, "/src/index.ts");
		expect(edges.length).toBe(1);
		expect(nonNull(edges[0]).symbols.sort()).toEqual(["alpha", "beta", "gamma"]);
	});

	it("parses import type { X }", () => {
		const src = `import type { Config } from './config';`;
		const edges = parseImports(src, "/src/app.ts");
		expect(edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					specifier: "./config",
					symbols: ["Config"],
					isTypeOnly: true,
				}),
			]),
		);
	});

	it("parses require() calls", () => {
		const src = `const fs = require('node:fs');`;
		const edges = parseImports(src, "/src/legacy.ts");
		expect(edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					specifier: "node:fs",
				}),
			]),
		);
	});

	it("parses dynamic import() on its own line", () => {
		// The parser only detects dynamic import() when the line starts with "import"
		const src = `import('./lazy');`;
		const edges = parseImports(src, "/src/loader.ts");
		expect(edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					specifier: "./lazy",
				}),
			]),
		);
	});

	it("parses dynamic import() embedded in a namespace assignment", () => {
		// Namespace-style `const mod = await import('...')` is recorded as a
		// namespace import (empty symbols), equivalent to `import * as mod`.
		const src = `const mod = await import('./lazy');`;
		const edges = parseImports(src, "/src/loader.ts");
		expect(edges).toEqual([expect.objectContaining({ specifier: "./lazy", symbols: [] })]);
	});

	it("parses destructured dynamic import() assignments", () => {
		// `const { foo } = await import('./lazy')` must record `foo` as a
		// consumed symbol so dead-export analysis doesn't false-positive.
		const src = `const { foo, bar } = await import('./lazy');`;
		const edges = parseImports(src, "/src/loader.ts");
		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			specifier: "./lazy",
			symbols: ["foo", "bar"],
		});
	});
});

// ---------------------------------------------------------------------------
// tryResolveFile
// ---------------------------------------------------------------------------
describe("tryResolveFile", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("returns exact match when file exists", () => {
		mockFileExists(new Set(["/project/src/utils.ts"]));
		expect(tryResolveFile("/project/src/utils.ts")).toBe("/project/src/utils.ts");
	});

	it("maps .js to .ts", () => {
		mockFileExists(new Set(["/project/src/utils.ts"]));
		expect(tryResolveFile("/project/src/utils.js")).toBe("/project/src/utils.ts");
	});

	it("maps .mjs to .mts", () => {
		mockFileExists(new Set(["/project/src/mod.mts"]));
		expect(tryResolveFile("/project/src/mod.mjs")).toBe("/project/src/mod.mts");
	});

	it("resolves /index file", () => {
		const indexPath = "/project/src/utils/index.ts";
		mockFileExists(new Set([indexPath]));
		expect(tryResolveFile("/project/src/utils")).toBe(indexPath);
	});

	it("returns null for missing file", () => {
		mockFileExists(new Set());
		expect(tryResolveFile("/project/src/nonexistent.ts")).toBeNull();
	});

	it("appends .ts extension when base path has no extension", () => {
		mockFileExists(new Set(["/project/src/helper.ts"]));
		expect(tryResolveFile("/project/src/helper")).toBe("/project/src/helper.ts");
	});
});

// ---------------------------------------------------------------------------
// ProjectGraph.getExports - transitive export * resolution with cycle protection
// ---------------------------------------------------------------------------
describe("ProjectGraph.getExports", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves transitive export * through multiple files", () => {
		// Setup:
		//   /project/a.ts  ->  export * from './b';
		//   /project/b.ts  ->  export const hello = 1; export const world = 2;
		//
		// getExports('/project/a.ts') should include 'hello' and 'world' from b.ts

		const files = new Map<string, string>([
			["/project/a.ts", `export * from './b';`],
			["/project/b.ts", "export const hello = 1;\nexport const world = 2;"],
		]);

		mockFileSystem(files);

		const graph = new ProjectGraph("/project");
		// Manually index files since we mocked out the filesystem scanner
		graph.updateFile("/project/b.ts", files.get("/project/b.ts"));
		graph.updateFile("/project/a.ts", files.get("/project/a.ts"));

		const exports = graph.getExports("/project/a.ts");
		const names = exports.map((e) => e.name).sort();
		expect(names).toContain("hello");
		expect(names).toContain("world");
	});

	it("handles cycles without infinite recursion", () => {
		// /project/x.ts  ->  export * from './y'
		// /project/y.ts  ->  export * from './x'; export const safe = 1;

		const files = new Map<string, string>([
			["/project/x.ts", `export * from './y';`],
			["/project/y.ts", `export * from './x';\nexport const safe = 1;`],
		]);

		mockFileSystem(files);

		const graph = new ProjectGraph("/project");
		graph.updateFile("/project/y.ts", files.get("/project/y.ts"));
		graph.updateFile("/project/x.ts", files.get("/project/x.ts"));

		// Should not throw or hang
		const exports = graph.getExports("/project/x.ts");
		const names = exports.map((e) => e.name);
		expect(names).toContain("safe");
	});

	it("includes direct exports alongside re-exports", () => {
		const files = new Map<string, string>([
			[
				"/project/entry.ts",
				["export const ownSymbol = 1;", "export * from './dep';"].join("\n"),
			],
			["/project/dep.ts", "export function depFn() {}"],
		]);

		mockFileSystem(files);

		const graph = new ProjectGraph("/project");
		graph.updateFile("/project/dep.ts", files.get("/project/dep.ts"));
		graph.updateFile("/project/entry.ts", files.get("/project/entry.ts"));

		const exports = graph.getExports("/project/entry.ts");
		const names = exports.map((e) => e.name).sort();
		expect(names).toContain("ownSymbol");
		expect(names).toContain("depFn");
	});
});
