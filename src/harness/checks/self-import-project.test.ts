import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { governingCompilerOptions } from "./self-import-project.js";

// Session review r2 (2026-09-05), findings 1 and 2: the resolver cached parsed
// options by the nearest config's own mtime (an edited `extends` target went
// unnoticed) and treated the nearest `tsconfig.json` as the importer's project
// (a solution config with `references` handed the solution's options to a file
// that belongs to `tsconfig.app.json`). Both are false-positive sources on a
// zero-FP pre_block rail. This module owns the answer to "which project's
// options govern this file" — no cache, and project membership decided the way
// the compiler decides it (`files`/`include`/`exclude` against a virtual tree
// holding only the importer, so a file not yet on disk is still placed).

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "self-import-project-"));
	roots.push(root);
	return root;
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

const DEFAULTS: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };

function optionsOf(root: string, importer: string): ts.CompilerOptions {
	const resolution = governingCompilerOptions(ts, importer, DEFAULTS);
	if (!resolution.ok) throw new Error(`expected options, got ${resolution.reason}: ${resolution.detail} (${root})`);
	return resolution.options;
}

describe("governingCompilerOptions — positive (resolves the governing project)", () => {
	it("P1: the nearest tsconfig that INCLUDES the importer governs it, extends chain and all", () => {
		const root = tempRoot();
		writeFileSync(join(root, "base.json"), json({ compilerOptions: { moduleSuffixes: [".native", ""] } }));
		writeFileSync(join(root, "tsconfig.json"), json({ extends: "./base.json", include: ["src"] }));
		mkdirSync(join(root, "src"));
		const importer = join(root, "src", "widget.ts");
		writeFileSync(importer, "export const x = 1;\n");
		expect(optionsOf(root, importer).moduleSuffixes).toEqual([".native", ""]);
	});

	it("P2: a solution config (files: [], references) hands the importer to the referenced project that includes it — the reviewer's cold-start reproduction", () => {
		const root = tempRoot();
		writeFileSync(join(root, "tsconfig.json"), json({ files: [], references: [{ path: "./tsconfig.app.json" }] }));
		writeFileSync(
			join(root, "tsconfig.app.json"),
			json({ compilerOptions: { composite: true, module: "ESNext", moduleResolution: "Bundler", moduleSuffixes: [".native", ""] }, include: ["src"] }),
		);
		mkdirSync(join(root, "src"));
		const importer = join(root, "src", "widget.ts");
		writeFileSync(importer, 'export { x } from "./widget.js";\n');
		const options = optionsOf(root, importer);
		expect(options.moduleSuffixes).toEqual([".native", ""]);
		expect(options.configFilePath).toBe(join(root, "tsconfig.app.json"));
	});

	it("P3: a referenced project claims a file that is NOT on disk yet — membership is decided by pattern, not by listing", () => {
		const root = tempRoot();
		writeFileSync(join(root, "tsconfig.json"), json({ files: [], references: [{ path: "./packages/app" }] }));
		mkdirSync(join(root, "packages", "app", "src"), { recursive: true });
		writeFileSync(join(root, "packages", "app", "tsconfig.json"), json({ compilerOptions: { composite: true, moduleSuffixes: [".ios", ""] }, include: ["src/**/*"] }));
		const importer = join(root, "packages", "app", "src", "new-file.ts");
		// Not written: the check runs at PreToolUse, before the bytes land.
		expect(optionsOf(root, importer).moduleSuffixes).toEqual([".ios", ""]);
	});

	it("P4: an independently selected SIBLING config (never referenced) that claims the file governs it — the reviewer's r4 reproduction", () => {
		const root = tempRoot();
		writeFileSync(join(root, "build.ts"), "export const build = 1;\n");
		writeFileSync(join(root, "tsconfig.json"), json({ compilerOptions: { moduleSuffixes: [""] }, files: ["build.ts"] }));
		writeFileSync(join(root, "tsconfig.app.json"), json({ compilerOptions: { moduleSuffixes: [".native", ""] }, include: ["modules"] }));
		mkdirSync(join(root, "modules"), { recursive: true });
		const importer = join(root, "modules", "widget.ts");
		writeFileSync(importer, 'export { x } from "./widget.js";\n');
		writeFileSync(join(root, "modules", "widget.native.ts"), "export const x = 1;\n");
		const options = optionsOf(root, importer);
		expect(options.moduleSuffixes).toEqual([".native", ""]);
		expect(options.configFilePath).toBe(join(root, "tsconfig.app.json"));
	});

	it("P8: a JS-family importer is a member of the project whose patterns cover it although the project never enables allowJs — a .js self-import is a runtime fact (resolve test P11)", () => {
		const root = tempRoot();
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "tsconfig.json"), json({ compilerOptions: { moduleSuffixes: [".web", ""] }, include: ["src"] }));
		const importer = join(root, "src", "widget.js");
		expect(governingCompilerOptions(ts, importer, DEFAULTS)).toMatchObject({ ok: true, configPath: join(root, "tsconfig.json") });
		expect(optionsOf(root, importer).moduleSuffixes).toEqual([".web", ""]);
	});

	it("N10: a JS-family importer OUTSIDE the project's patterns is still project_orphan — the widened extension filter admits no path the patterns do not", () => {
		const root = tempRoot();
		writeFileSync(join(root, "tsconfig.json"), json({ compilerOptions: { moduleSuffixes: [".web", ""] }, include: ["src"] }));
		mkdirSync(join(root, "lib"), { recursive: true });
		const resolution = governingCompilerOptions(ts, join(root, "lib", "orphan.js"), DEFAULTS);
		expect(resolution).toMatchObject({ ok: false, reason: "project_orphan", configPath: join(root, "tsconfig.json") });
	});

	it("N9: under a LONE config a file outside its patterns is project_orphan — no references does not prove ownership (review r4, finding 3)", () => {
		const root = tempRoot();
		writeFileSync(join(root, "tsconfig.json"), json({ compilerOptions: { moduleSuffixes: [".web", ""] }, include: ["src"] }));
		mkdirSync(join(root, "lib"));
		const importer = join(root, "lib", "orphan.ts");
		writeFileSync(importer, "export const x = 1;\n");
		expect(governingCompilerOptions(ts, importer, DEFAULTS)).toMatchObject({ ok: false, reason: "project_orphan" });
	});

	it("P5: no tsconfig anywhere above the importer yields the caller's defaults and a null config path", () => {
		const root = tempRoot();
		const importer = join(root, "widget.ts");
		writeFileSync(importer, "export const x = 1;\n");
		const resolution = governingCompilerOptions(ts, importer, DEFAULTS);
		expect(resolution).toEqual({ ok: true, options: DEFAULTS, configPath: null });
	});

	it("P6: an edited `extends` target is seen by the very next call — nothing is cached (review r2, finding 1)", () => {
		const root = tempRoot();
		writeFileSync(join(root, "base.json"), json({ compilerOptions: { moduleSuffixes: [""] } }));
		writeFileSync(join(root, "tsconfig.json"), json({ extends: "./base.json" }));
		mkdirSync(join(root, "src"));
		const importer = join(root, "src", "widget.ts");
		writeFileSync(importer, "export const x = 1;\n");
		expect(optionsOf(root, importer).moduleSuffixes).toEqual([""]);
		writeFileSync(join(root, "base.json"), json({ compilerOptions: { moduleSuffixes: [".native", ""] } }));
		expect(optionsOf(root, importer).moduleSuffixes).toEqual([".native", ""]);
	});

	it("P7: a nearer tsconfig that appears between two calls takes over — discovery is never cached either", () => {
		const root = tempRoot();
		writeFileSync(join(root, "tsconfig.json"), json({ compilerOptions: { moduleSuffixes: [""] } }));
		mkdirSync(join(root, "nested"));
		const importer = join(root, "nested", "widget.ts");
		writeFileSync(importer, "export const x = 1;\n");
		expect(optionsOf(root, importer).moduleSuffixes).toEqual([""]);
		writeFileSync(join(root, "nested", "tsconfig.json"), json({ compilerOptions: { moduleSuffixes: [".native", ""] } }));
		expect(optionsOf(root, importer).moduleSuffixes).toEqual([".native", ""]);
	});
});

describe("governingCompilerOptions — negative (NOT MEASURED, never a guessed project)", () => {
	it("N1: an unparsable nearest config is config_unparsable", () => {
		const root = tempRoot();
		writeFileSync(join(root, "tsconfig.json"), "{ this is not json");
		const importer = join(root, "widget.ts");
		writeFileSync(importer, "export const x = 1;\n");
		const resolution = governingCompilerOptions(ts, importer, DEFAULTS);
		expect(resolution.ok).toBe(false);
		if (resolution.ok) throw new Error("unreachable");
		expect(resolution.reason).toBe("config_unparsable");
		expect(resolution.configPath).toBe(join(root, "tsconfig.json"));
	});

	it("N2: a missing `extends` target is config_unparsable — half a configuration is not a configuration", () => {
		const root = tempRoot();
		writeFileSync(join(root, "tsconfig.json"), json({ extends: "./missing.json" }));
		const importer = join(root, "widget.ts");
		writeFileSync(importer, "export const x = 1;\n");
		const resolution = governingCompilerOptions(ts, importer, DEFAULTS);
		expect(resolution).toMatchObject({ ok: false, reason: "config_unparsable" });
	});

	it("N3: two referenced projects that both include the importer are project_ambiguous, naming both", () => {
		const root = tempRoot();
		writeFileSync(join(root, "tsconfig.json"), json({ files: [], references: [{ path: "./tsconfig.a.json" }, { path: "./tsconfig.b.json" }] }));
		writeFileSync(join(root, "tsconfig.a.json"), json({ compilerOptions: { composite: true, moduleSuffixes: [".a", ""] }, include: ["src"] }));
		writeFileSync(join(root, "tsconfig.b.json"), json({ compilerOptions: { composite: true, moduleSuffixes: [".b", ""] }, include: ["src"] }));
		mkdirSync(join(root, "src"));
		const importer = join(root, "src", "widget.ts");
		writeFileSync(importer, "export const x = 1;\n");
		const resolution = governingCompilerOptions(ts, importer, DEFAULTS);
		expect(resolution.ok).toBe(false);
		if (resolution.ok) throw new Error("unreachable");
		expect(resolution.reason).toBe("project_ambiguous");
		expect(resolution.detail).toContain("tsconfig.a.json");
		expect(resolution.detail).toContain("tsconfig.b.json");
	});

	it("N4: a broken referenced project makes the graph undecidable — config_unparsable, not the solution's options", () => {
		const root = tempRoot();
		writeFileSync(join(root, "tsconfig.json"), json({ files: [], references: [{ path: "./tsconfig.app.json" }] }));
		writeFileSync(join(root, "tsconfig.app.json"), "{ broken");
		mkdirSync(join(root, "src"));
		const importer = join(root, "src", "widget.ts");
		writeFileSync(importer, "export const x = 1;\n");
		expect(governingCompilerOptions(ts, importer, DEFAULTS)).toMatchObject({ ok: false, reason: "config_unparsable" });
	});

	it("N5: a reference cycle terminates and still resolves the one project that includes the importer", () => {
		const root = tempRoot();
		writeFileSync(join(root, "tsconfig.json"), json({ files: [], references: [{ path: "./tsconfig.app.json" }] }));
		writeFileSync(join(root, "tsconfig.app.json"), json({ compilerOptions: { composite: true, moduleSuffixes: [".x", ""] }, include: ["src"], references: [{ path: "./tsconfig.json" }] }));
		mkdirSync(join(root, "src"));
		const importer = join(root, "src", "widget.ts");
		writeFileSync(importer, "export const x = 1;\n");
		expect(optionsOf(root, importer).moduleSuffixes).toEqual([".x", ""]);
	});

	it("N6: under a SOLUTION, a file no walked project claims by root patterns is project_orphan — a `/// <reference>` target belongs to a program the patterns cannot name (review r3, finding 2)", () => {
		const root = tempRoot();
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "tsconfig.json"), json({ files: [], references: [{ path: "./tsconfig.app.json" }] }));
		writeFileSync(
			join(root, "tsconfig.app.json"),
			json({ compilerOptions: { composite: true, module: "ESNext", moduleResolution: "Bundler", moduleSuffixes: [".native", ""] }, files: ["src/main.ts", "src/widget.native.ts"] }),
		);
		writeFileSync(join(root, "src", "main.ts"), '/// <reference path="./widget.d.ts" />\nexport const main = 1;\n');
		writeFileSync(join(root, "src", "widget.native.ts"), "export const x = 1;\n");
		const declaration = join(root, "src", "widget.d.ts");
		writeFileSync(declaration, 'export { x } from "./widget.js";\n');
		const resolution = governingCompilerOptions(ts, declaration, DEFAULTS);
		// The solution's own options (no moduleSuffixes) would have called this
		// declaration a self-import; declining is the only honest answer.
		expect(resolution).toMatchObject({ ok: false, reason: "project_orphan", configPath: join(root, "tsconfig.json") });
	});

	function cappedSolution(appFirst: boolean): { root: string; importer: string } {
		const root = tempRoot();
		mkdirSync(join(root, "src"));
		const importer = join(root, "src", "widget.ts");
		writeFileSync(importer, 'export { x } from "./widget.js";\n');
		writeFileSync(join(root, "src", "widget.native.ts"), "export const x = 1;\n");
		writeFileSync(join(root, "other.ts"), "export const other = 1;\n");
		const others = Array.from({ length: 31 }, (_, index) => {
			const name = `tsconfig.other${index}.json`;
			writeFileSync(join(root, name), json({ compilerOptions: { composite: true }, files: ["other.ts"] }));
			return { path: `./${name}` };
		});
		writeFileSync(join(root, "tsconfig.app.json"), json({ compilerOptions: { composite: true, moduleSuffixes: [".native", ""] }, include: ["src"] }));
		const app = { path: "./tsconfig.app.json" };
		writeFileSync(join(root, "tsconfig.json"), json({ files: [], references: appFirst ? [app, ...others] : [...others, app] }));
		return { root, importer };
	}

	it("N7: a reference walk that hits its bound with projects unvisited is graph_truncated, never the solution's options (review r3, finding 1)", () => {
		const { importer } = cappedSolution(false);
		const resolution = governingCompilerOptions(ts, importer, DEFAULTS);
		expect(resolution).toMatchObject({ ok: false, reason: "graph_truncated" });
	});

	it("N8: reordering the references does not change the verdict — a claimant found before the bound is still a partial answer", () => {
		const { importer } = cappedSolution(true);
		const resolution = governingCompilerOptions(ts, importer, DEFAULTS);
		expect(resolution).toMatchObject({ ok: false, reason: "graph_truncated" });
	});
});
