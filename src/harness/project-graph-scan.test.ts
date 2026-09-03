import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTsconfigPathsFor, scanProjectFiles, SKIP_DIRS, TS_JS_EXTENSIONS } from "./project-graph-scan.js";

describe("project-graph-scan", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pg-scan-test-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	describe("SKIP_DIRS / TS_JS_EXTENSIONS — positive (must fire)", () => {
		it("P1: SKIP_DIRS contains node_modules and .git", () => {
			expect(SKIP_DIRS.has("node_modules")).toBe(true);
			expect(SKIP_DIRS.has(".git")).toBe(true);
			expect(SKIP_DIRS.has(".stryker-tmp")).toBe(true);
		});

		it("P2: TS_JS_EXTENSIONS contains .ts and .tsx", () => {
			expect(TS_JS_EXTENSIONS.has(".ts")).toBe(true);
			expect(TS_JS_EXTENSIONS.has(".tsx")).toBe(true);
		});
	});

	describe("scanProjectFiles — positive (must fire)", () => {
		it("P1: collects TS/JS files under the root with the root as boundary", () => {
			writeFileSync(join(root, "a.ts"), "export const a = 1;");
			writeFileSync(join(root, "b.js"), "module.exports = {};");
			writeFileSync(join(root, "readme.md"), "not source");

			const files = scanProjectFiles(root);
			const byFile = new Map(files.map((f) => [f.file, f.boundary]));

			expect(byFile.has(join(root, "a.ts"))).toBe(true);
			expect(byFile.has(join(root, "b.js"))).toBe(true);
			expect(byFile.has(join(root, "readme.md"))).toBe(false);
			expect(byFile.get(join(root, "a.ts"))).toBe(root);
		});

		it("P2: a subdirectory with its own package.json becomes a new boundary", () => {
			const sub = join(root, "packages", "widget");
			mkdirSync(sub, { recursive: true });
			writeFileSync(join(sub, "package.json"), "{}");
			writeFileSync(join(sub, "index.ts"), "export {};");

			const files = scanProjectFiles(root);
			const entry = files.find((f) => f.file === join(sub, "index.ts"));
			expect(entry?.boundary).toBe(sub);
		});
	});

	describe("scanProjectFiles — negative (must not fire)", () => {
		it("N1: skips node_modules and root-local scratch/", () => {
			const nm = join(root, "node_modules", "pkg");
			mkdirSync(nm, { recursive: true });
			writeFileSync(join(nm, "index.js"), "module.exports = {};");

			const scratch = join(root, "scratch");
			mkdirSync(scratch, { recursive: true });
			writeFileSync(join(scratch, "probe.ts"), "export {};");

			const files = scanProjectFiles(root);
			expect(files.some((f) => f.file.includes("node_modules"))).toBe(false);
			expect(files.some((f) => f.file === join(scratch, "probe.ts"))).toBe(false);
		});
	});

	describe("loadTsconfigPathsFor — positive (must fire)", () => {
		it("P1: parses compilerOptions.paths from a well-formed tsconfig.json", () => {
			writeFileSync(
				join(root, "tsconfig.json"),
				JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }),
			);
			expect(loadTsconfigPathsFor(root)).toEqual({ "@/*": ["src/*"] });
		});

		it("P2: strips single-line comments before parsing", () => {
			writeFileSync(
				join(root, "tsconfig.json"),
				'{\n  // a comment\n  "compilerOptions": { "paths": { "@/*": ["src/*"] } }\n}',
			);
			expect(loadTsconfigPathsFor(root)).toEqual({ "@/*": ["src/*"] });
		});
	});

	describe("loadTsconfigPathsFor — negative (must not fire)", () => {
		it("N1: returns undefined when tsconfig.json is absent", () => {
			expect(loadTsconfigPathsFor(root)).toBeUndefined();
		});

		it("N2: returns undefined when paths is malformed", () => {
			writeFileSync(
				join(root, "tsconfig.json"),
				JSON.stringify({ compilerOptions: { paths: { "@/*": "src/*" } } }),
			);
			expect(loadTsconfigPathsFor(root)).toBeUndefined();
		});
	});
});
