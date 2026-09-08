import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ExistsProbe,
	resolvesToSelf,
	selfImportCompilerOptions,
	selfImportConfigPath,
} from "./self-import-resolve.js";

// Review finding 1 [P1] (2026-09-05, seventh pass). `self_import` is a
// `pre_block` rail, so its resolver may not GUESS which file a specifier names.
// The hand-built candidate table it used to walk could not see the project's own
// `compilerOptions`: with `moduleSuffixes: [".native", ""]` and a sibling
// `widget.native.ts`, `export { x } from "./widget.js"` inside `widget.ts` names
// a DIFFERENT module, and the table blocked the edit anyway (the reviewer
// reproduced it with TypeScript 5.9.3).
//
// Every case below drives the real discovery path — a real temp-dir project with
// a real tsconfig — because that path is the fix: `ts.findConfigFile` +
// `ts.parseJsonConfigFileContent` + `ts.resolveModuleName`. The option-injected
// cases live in `self-import-scan.resolution.test.ts`, which sweeps our verdict
// against the compiler's for every (options × tree × specifier) combination.

const roots: string[] = [];

/** A throwaway project on the real filesystem: the resolver reads `tsconfig.json`
 *  and `package.json` through `ts.sys` / `node:fs`, so a virtual tree cannot
 *  exercise discovery at all. */
function project(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "self-import-resolve-"));
	roots.push(root);
	for (const [relative, content] of Object.entries(files)) {
		const target = join(root, relative);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return root;
}

const WIDGET = "export const x = 1;\n";

function tsconfig(compilerOptions: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ compilerOptions, ...extra });
}

const BUNDLER = { moduleResolution: "bundler", module: "esnext" };

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("selfImportCompilerOptions — the project's own options, or NOT MEASURED", () => {
	it("P1: reads moduleSuffixes out of the governing tsconfig", () => {
		const root = project({
			"tsconfig.json": tsconfig({ ...BUNDLER, moduleSuffixes: [".native", ""] }),
			"src/widget.ts": WIDGET,
		});
		expect(selfImportCompilerOptions(join(root, "src/widget.ts"))?.moduleSuffixes).toEqual([
			".native",
			"",
		]);
	});

	it("P2: follows an `extends` chain to options declared in the base config", () => {
		const root = project({
			"cfg/base.json": tsconfig({ moduleSuffixes: [".native", ""] }),
			"tsconfig.json": tsconfig(BUNDLER, { extends: "./cfg/base.json" }),
			"src/widget.ts": WIDGET,
		});
		expect(selfImportCompilerOptions(join(root, "src/widget.ts"))?.moduleSuffixes).toEqual([
			".native",
			"",
		]);
	});

	it("P3: falls back to permissive defaults when no tsconfig governs the file", () => {
		const root = project({ "src/widget.ts": WIDGET });
		const options = selfImportCompilerOptions(join(root, "src/widget.ts"));
		expect(options?.allowJs).toBe(true);
		expect(selfImportConfigPath(join(root, "src/widget.ts"))).toBeNull();
	});

	it("N1: reports NOT MEASURED (null) for a tsconfig that is not valid JSON", () => {
		const root = project({ "tsconfig.json": "{ not json ,,, }", "src/widget.ts": WIDGET });
		expect(selfImportCompilerOptions(join(root, "src/widget.ts"))).toBeNull();
	});

	it("N2: reports NOT MEASURED (null) when the `extends` target cannot be read", () => {
		const root = project({
			"tsconfig.json": tsconfig(BUNDLER, { extends: "./missing-base.json" }),
			"src/widget.ts": WIDGET,
		});
		expect(selfImportCompilerOptions(join(root, "src/widget.ts"))).toBeNull();
		expect(selfImportConfigPath(join(root, "src/widget.ts"))).toBe(join(root, "tsconfig.json"));
	});

	it("P4: names the nearest tsconfig above the file, not the outermost one", () => {
		const root = project({
			"tsconfig.json": tsconfig(BUNDLER),
			"src/tsconfig.json": tsconfig(BUNDLER),
			"src/widget.ts": WIDGET,
		});
		expect(selfImportConfigPath(join(root, "src/widget.ts"))).toBe(join(root, "src/tsconfig.json"));
	});
});

describe("resolvesToSelf — the reviewer's moduleSuffixes reproduction", () => {
	// test-contract: bug — the exact tree the reviewer ran against TypeScript
	// 5.9.3: `moduleSuffixes` makes `./widget.js` name `widget.native.ts`, and the
	// candidate table blocked the edit anyway.
	it("N3: does NOT fire when moduleSuffixes routes the specifier to a sibling", () => {
		const root = project({
			"tsconfig.json": tsconfig({ ...BUNDLER, moduleSuffixes: [".native", ""] }),
			"src/widget.ts": WIDGET,
			"src/widget.native.ts": WIDGET,
		});
		expect(resolvesToSelf(join(root, "src/widget.ts"), "./widget.js")).toBe(false);
	});

	// test-contract: invariant — the same config with the suffixed sibling ABSENT
	// falls back to the empty suffix, so the import really is a self-import.
	it("P5: fires under the same config once the suffixed sibling is gone", () => {
		const root = project({
			"tsconfig.json": tsconfig({ ...BUNDLER, moduleSuffixes: [".native", ""] }),
			"src/widget.ts": WIDGET,
		});
		expect(resolvesToSelf(join(root, "src/widget.ts"), "./widget.js")).toBe(true);
	});

	it("N4: does NOT fire when moduleSuffixes arrives through an `extends` chain", () => {
		const root = project({
			"cfg/base.json": tsconfig({ moduleSuffixes: [".native", ""] }),
			"tsconfig.json": tsconfig(BUNDLER, { extends: "./cfg/base.json" }),
			"src/widget.ts": WIDGET,
			"src/widget.native.ts": WIDGET,
		});
		expect(resolvesToSelf(join(root, "src/widget.ts"), "./widget.js")).toBe(false);
	});
});

describe("resolvesToSelf — resolution modes the candidate table could not model", () => {
	// test-contract: invariant — MEASURED against TypeScript 5.9.3, not assumed:
	// classic resolution shares `loadModuleFromFile` with node resolution, so it
	// DOES substitute `.js` → `.ts` for a relative specifier (what classic drops
	// is directory/index and node_modules lookup). The review brief predicted the
	// opposite; the compiler decides, which is this module's entire point.
	it("P14: classic resolution still fires for `./widget.js` from widget.ts", () => {
		const root = project({
			"tsconfig.json": tsconfig({ moduleResolution: "classic", module: "es2015" }),
			"src/widget.ts": WIDGET,
		});
		expect(resolvesToSelf(join(root, "src/widget.ts"), "./widget.js")).toBe(true);
	});

	it("P6: classic resolution still fires for the extensionless `./widget`", () => {
		const root = project({
			"tsconfig.json": tsconfig({ moduleResolution: "classic", module: "es2015" }),
			"src/widget.ts": WIDGET,
		});
		expect(resolvesToSelf(join(root, "src/widget.ts"), "./widget")).toBe(true);
	});

	// An ESM NodeNext file may not write an extensionless relative import at all:
	// TypeScript resolves NOTHING and reports TS2835. So this is a broken import,
	// not a running self-import, and a self-import rail must stay off it — the
	// compiler already refuses the file.
	it("N6: NodeNext ESM does not fire for an extensionless `./widget`", () => {
		const root = project({
			"package.json": JSON.stringify({ name: "p", type: "module" }),
			"tsconfig.json": tsconfig({ moduleResolution: "nodenext", module: "nodenext" }),
			"src/widget.ts": WIDGET,
		});
		expect(resolvesToSelf(join(root, "src/widget.ts"), "./widget")).toBe(false);
	});

	it("P7: NodeNext ESM fires for the `./widget.js` spelling it requires", () => {
		const root = project({
			"package.json": JSON.stringify({ name: "p", type: "module" }),
			"tsconfig.json": tsconfig({ moduleResolution: "nodenext", module: "nodenext" }),
			"src/widget.ts": WIDGET,
		});
		expect(resolvesToSelf(join(root, "src/widget.ts"), "./widget.js")).toBe(true);
	});

	it("P8: NodeNext CJS fires for the extensionless `./widget`", () => {
		const root = project({
			"package.json": JSON.stringify({ name: "p", type: "commonjs" }),
			"tsconfig.json": tsconfig({ moduleResolution: "nodenext", module: "nodenext" }),
			"src/widget.ts": WIDGET,
		});
		expect(resolvesToSelf(join(root, "src/widget.ts"), "./widget")).toBe(true);
	});

	// test-contract: invariant — `paths`/`baseUrl` and `rootDirs` never apply to a
	// RELATIVE specifier, so the ordinary self-import still fires under them.
	it("P9: fires under paths/baseUrl, which do not touch relative specifiers", () => {
		const root = project({
			"tsconfig.json": tsconfig({
				...BUNDLER,
				baseUrl: ".",
				paths: { "#widget": ["./src/other.ts"] },
			}),
			"src/widget.ts": WIDGET,
			"src/other.ts": WIDGET,
		});
		expect(resolvesToSelf(join(root, "src/widget.ts"), "./widget.js")).toBe(true);
	});

	it("P10: fires under rootDirs, which do not touch this specifier either", () => {
		const root = project({
			"tsconfig.json": tsconfig({ ...BUNDLER, rootDirs: ["./src", "./generated"] }),
			"src/widget.ts": WIDGET,
			"generated/other.ts": WIDGET,
		});
		expect(resolvesToSelf(join(root, "src/widget.ts"), "./widget.js")).toBe(true);
	});
});

describe("resolvesToSelf — JS importers, NOT MEASURED, and the cheap pre-filter", () => {
	// A `.js` file that imports itself self-imports at RUNTIME whatever `allowJs`
	// says about compiling it, so a JS-family importer is resolved with `allowJs`
	// on. Only the discovery path widens; an explicitly injected option set is
	// used verbatim.
	it("P11: fires for a .js importer under a tsconfig that excludes JS", () => {
		const root = project({
			"tsconfig.json": tsconfig({ ...BUNDLER, allowJs: false }),
			"src/widget.js": WIDGET,
		});
		expect(resolvesToSelf(join(root, "src/widget.js"), "./widget.js")).toBe(true);
	});

	it("N7: does NOT fire for that .js importer when a .ts sibling wins the lookup", () => {
		const root = project({
			"tsconfig.json": tsconfig({ ...BUNDLER, allowJs: false }),
			"src/widget.js": WIDGET,
			"src/widget.ts": WIDGET,
		});
		expect(resolvesToSelf(join(root, "src/widget.js"), "./widget.js")).toBe(false);
	});

	it("N8: never fires while the tsconfig cannot be parsed — no guess, no block", () => {
		const root = project({ "tsconfig.json": "{ not json ,,, }", "src/widget.ts": WIDGET });
		expect(resolvesToSelf(join(root, "src/widget.ts"), "./widget.js")).toBe(false);
	});

	it("N9: costs no filesystem probe when the importer cannot carry the specifier's name", () => {
		const root = project({ "tsconfig.json": tsconfig(BUNDLER), "src/widget.ts": WIDGET });
		const probe = vi.fn<ExistsProbe>(() => true);
		expect(resolvesToSelf(join(root, "src/widget.ts"), "./other.js", probe)).toBe(false);
		expect(probe).not.toHaveBeenCalled();
	});

	it("P12: does run the resolver when the importer's name EXTENDS the specifier stem", () => {
		const root = project({
			"tsconfig.json": tsconfig({ ...BUNDLER, moduleSuffixes: [".native", ""] }),
			"src/widget.native.ts": WIDGET,
		});
		expect(resolvesToSelf(join(root, "src/widget.native.ts"), "./widget.js")).toBe(true);
	});

	it("P13: re-reads a tsconfig whose mtime moved rather than serving the cached options", () => {
		const root = project({
			"tsconfig.json": tsconfig({ ...BUNDLER, moduleSuffixes: [".native", ""] }),
			"src/widget.ts": WIDGET,
			"src/widget.native.ts": WIDGET,
		});
		const importer = join(root, "src/widget.ts");
		expect(resolvesToSelf(importer, "./widget.js")).toBe(false);
		writeFileSync(join(root, "tsconfig.json"), tsconfig(BUNDLER));
		// A fixed stamp, not `Date.now()`: the cache key is the config's mtime, and
		// two writes inside one millisecond would otherwise share it.
		const stamp = new Date("2030-01-01T00:00:00Z");
		utimesSync(join(root, "tsconfig.json"), stamp, stamp);
		expect(resolvesToSelf(importer, "./widget.js")).toBe(true);
	});
});
