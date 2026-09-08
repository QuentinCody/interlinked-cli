import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { type ExistsProbe, resolvesToSelf } from "./self-import-scan.js";

// Differential test for Finding 4 [P1] (2026-09-05) and review finding 1 [P1]
// (seventh pass). `self_import` is a severity-error `pre_block` rail, so its
// resolver may never disagree with the compiler that will actually resolve the
// import: a disagreement is either a refused valid edit (false positive) or a
// hard rail that quietly does not exist (false negative).
//
// Two detectors died here. The first stripped every TS/JS extension and compared
// stems, so `"./widget.mjs"` inside `widget.ts` was a "self-import". The second
// walked a hand-written candidate TABLE — measured against the compiler, and
// still wrong, because a table cannot see the project's `compilerOptions`:
// `moduleSuffixes: [".native", ""]` with a sibling `widget.native.ts` sends
// `"./widget.js"` to a DIFFERENT module, and the table blocked it anyway.
//
// So the sweep below varies the OPTIONS as well as the tree, and requires our
// verdict to equal `resolvedFileName === importer` for every combination —
// including "TypeScript resolved nothing", where our verdict must be "not self".
// The trees are virtual (an injected probe) but rooted in a REAL directory,
// because resolution refuses to look inside a directory that is not on disk
// (`selfImportDirectoryVisible`). `typescript` is an optionalDependency and is
// present here; when it is absent nothing resolves at all and the check is NOT
// MEASURED (self-import-scan.unavailable.test.ts owns that state).

/** A real, empty directory: the files in each scenario are virtual, but the
 *  DIRECTORY has to exist or the compiler never probes at all. */
const CJS_ROOT = mkdtempSync(join(tmpdir(), "self-import-sweep-cjs-"));
/** The same, plus a `"type": "module"` package.json, so NodeNext reads the
 *  importer as ESM — the one place a package.json changes resolution. */
const ESM_ROOT = mkdtempSync(join(tmpdir(), "self-import-sweep-esm-"));
writeFileSync(join(ESM_ROOT, "package.json"), JSON.stringify({ name: "sweep", type: "module" }));

afterAll(() => {
	rmSync(CJS_ROOT, { recursive: true, force: true });
	rmSync(ESM_ROOT, { recursive: true, force: true });
});

/** Every module extension either side can carry. */
const IMPORTER_EXTS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const SPECIFIER_EXTS = ["", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".d.ts"];

/** Trees the resolution can land in, as the suffixes of the files that sit
 *  beside the importer: no sibling at all, one shadowing sibling, a crowded
 *  directory, and the `moduleSuffixes` targets that only some option sets can
 *  reach. */
const SIBLING_SETS: string[][] = [
	[],
	[".ts"],
	[".tsx"],
	[".ts", ".tsx"],
	[".js"],
	[".d.ts"],
	[".mts"],
	[".mjs"],
	[".cts"],
	[".cjs"],
	[".native.ts"],
	[".native.ts", ".ts"],
	[".native.js"],
	[".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"],
];

interface Mode {
	readonly name: string;
	readonly root: string;
	readonly options: ts.CompilerOptions;
	/** Files present in every tree under this mode. NodeNext reads the nearest
	 *  package.json to decide ESM vs CJS, and a virtual tree only contains what it
	 *  says it contains — with the real filesystem as the probe (the production
	 *  default) the package.json is simply there. */
	readonly extra?: readonly string[];
}

const COMMON = { allowJs: true, jsx: ts.JsxEmit.React, allowImportingTsExtensions: true, noEmit: true };
const SUFFIXES = [".native", ""];

/** The option sets. Each one moves resolution somewhere the others do not:
 *  extension substitution (classic), package-type-driven ESM (NodeNext under a
 *  `"type": "module"` root), the suffix search (`moduleSuffixes`), whether .js is
 *  a target at all (`allowJs: false`), and the two option families that never
 *  touch a relative specifier (`paths`/`baseUrl`, `rootDirs`) and so must change
 *  nothing. */
const BUNDLER: Mode = {
	name: "Bundler",
	root: CJS_ROOT,
	options: { ...COMMON, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext },
};

const NODE10: Mode = {
	name: "Node10",
	root: CJS_ROOT,
	options: { ...COMMON, moduleResolution: ts.ModuleResolutionKind.Node10, module: ts.ModuleKind.CommonJS },
};

const NODENEXT_CJS: Mode = {
	name: "NodeNext/cjs-package",
	root: CJS_ROOT,
	options: { ...COMMON, moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext },
};

const NODENEXT_ESM: Mode = {
	name: "NodeNext/esm-package",
	root: ESM_ROOT,
	options: { ...COMMON, moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext },
	extra: [join(ESM_ROOT, "package.json")],
};

const CLASSIC: Mode = {
	name: "Classic",
	root: CJS_ROOT,
	options: { ...COMMON, moduleResolution: ts.ModuleResolutionKind.Classic, module: ts.ModuleKind.ES2015 },
};

const BUNDLER_SUFFIXES: Mode = {
	name: "Bundler+moduleSuffixes",
	root: CJS_ROOT,
	options: {
		...COMMON,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		module: ts.ModuleKind.ESNext,
		moduleSuffixes: SUFFIXES,
	},
};

const NODE10_SUFFIXES: Mode = {
	name: "Node10+moduleSuffixes",
	root: CJS_ROOT,
	options: {
		...COMMON,
		moduleResolution: ts.ModuleResolutionKind.Node10,
		module: ts.ModuleKind.CommonJS,
		moduleSuffixes: SUFFIXES,
	},
};

const BUNDLER_NO_JS: Mode = {
	name: "Bundler/no-allowJs",
	root: CJS_ROOT,
	options: {
		...COMMON,
		allowJs: false,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		module: ts.ModuleKind.ESNext,
	},
};

const BUNDLER_PATHS: Mode = {
	name: "Bundler+paths+rootDirs",
	root: CJS_ROOT,
	options: {
		...COMMON,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		module: ts.ModuleKind.ESNext,
		baseUrl: CJS_ROOT,
		paths: { "#widget": ["./elsewhere.ts"] },
		rootDirs: [CJS_ROOT, join(CJS_ROOT, "generated")],
	},
};

const MODES: Mode[] = [
	BUNDLER,
	NODE10,
	NODENEXT_CJS,
	NODENEXT_ESM,
	CLASSIC,
	BUNDLER_SUFFIXES,
	NODE10_SUFFIXES,
	BUNDLER_NO_JS,
	BUNDLER_PATHS,
];

/** One import to judge: a file, the specifier it writes, and the tree around it. */
interface Scenario {
	readonly importer: string;
	readonly specifier: string;
	readonly files: ReadonlySet<string>;
}

/** The host contract `self-import-resolve.ts` documents, restated here rather
 *  than imported: the importer always exists (it is the content being written),
 *  sibling files come from the tree under test, package.json comes from the real
 *  filesystem, and DIRECTORIES come from the real filesystem only. */
function hostFor(scenario: Scenario): ts.ModuleResolutionHost {
	return {
		fileExists: (candidate) =>
			resolve(candidate) === resolve(scenario.importer) || scenario.files.has(candidate),
		readFile: (file) => {
			try {
				return readFileSync(file, "utf8");
			} catch {
				return undefined;
			}
		},
		directoryExists: (dir) => {
			try {
				return statSync(dir === "" ? "." : dir).isDirectory();
			} catch {
				return false;
			}
		},
	};
}

/** What TypeScript itself does with this import, reduced to the one bit the
 *  check cares about: did it resolve back to the importing file? */
function typescriptSaysSelf(scenario: Scenario, mode: Mode): boolean {
	const host = hostFor(scenario);
	const resolutionMode = ts.getImpliedNodeFormatForFile(scenario.importer, undefined, host, mode.options);
	const resolved = ts.resolveModuleName(
		scenario.specifier,
		scenario.importer,
		mode.options,
		host,
		undefined,
		undefined,
		resolutionMode,
	).resolvedModule?.resolvedFileName;
	return resolved !== undefined && resolve(resolved) === resolve(scenario.importer);
}

function probeFor(files: ReadonlySet<string>): ExistsProbe {
	return (path) => files.has(path);
}

/** What the check says, under the same options. */
function checkSaysSelf(scenario: Scenario, mode: Mode): boolean {
	return resolvesToSelf(scenario.importer, scenario.specifier, probeFor(scenario.files), mode.options);
}

interface Disagreement {
	importer: string;
	specifier: string;
	tree: string;
	mode: string;
	ours: boolean;
	typescript: boolean;
}

function disagreementFor(scenario: Scenario, mode: Mode, tree: string): Disagreement[] {
	const ours = checkSaysSelf(scenario, mode);
	const theirs = typescriptSaysSelf(scenario, mode);
	if (ours === theirs) return [];
	return [
		{
			importer: scenario.importer,
			specifier: scenario.specifier,
			tree,
			mode: mode.name,
			ours,
			typescript: theirs,
		},
	];
}

interface Case {
	readonly scenario: Scenario;
	readonly tree: string;
	readonly mode: Mode;
}

/** Every (sibling tree × specifier extension) case for one importer. */
function casesForImporter(base: string, importer: string, mode: Mode): Case[] {
	return SIBLING_SETS.flatMap((siblings) => {
		const files = new Set<string>([
			importer,
			...(mode.extra ?? []),
			...siblings.map((suffix) => join(mode.root, `${base}${suffix}`)),
		]);
		const tree = siblings.join(",") || "(empty)";
		return SPECIFIER_EXTS.map((specifierExt) => ({
			scenario: { importer, specifier: `./${base}${specifierExt}`, files },
			tree,
			mode,
		}));
	});
}

/** Every case one option set produces, across every importer extension. */
function casesForMode(base: string, importerExts: readonly string[], mode: Mode): Case[] {
	return importerExts.flatMap((ext) =>
		casesForImporter(base, join(mode.root, `${base}${ext}`), mode),
	);
}

function sweep(base: string, importerExts: readonly string[]): Disagreement[] {
	return MODES.flatMap((mode) =>
		casesForMode(base, importerExts, mode).flatMap((one) =>
			disagreementFor(one.scenario, one.mode, one.tree),
		),
	);
}

/** Every verdict the check produces over the same sweep, keyed by mode, so the
 *  matrix can be shown to exercise both directions AND to depend on the options. */
function verdictsByMode(base: string, importerExts: readonly string[]): Map<string, boolean[]> {
	return new Map(
		MODES.map((mode) => [
			mode.name,
			casesForMode(base, importerExts, mode).map((one) => checkSaysSelf(one.scenario, one.mode)),
		]),
	);
}

function scenario(importerExt: string, specifier: string, siblingSuffixes: string[]): Scenario {
	const importer = join(CJS_ROOT, `widget${importerExt}`);
	return {
		importer,
		specifier,
		files: new Set<string>([
			importer,
			...siblingSuffixes.map((suffix) => join(CJS_ROOT, `widget${suffix}`)),
		]),
	};
}

describe("self_import resolution agrees with ts.resolveModuleName", () => {
	it("D1: agrees on every (options × importer ext × specifier ext × sibling tree) combination", () => {
		expect(sweep("widget", IMPORTER_EXTS)).toEqual([]);
	});

	it("D2: the sweep is not vacuous — it covers the whole matrix and exercises both verdicts", () => {
		const verdicts = [...verdictsByMode("widget", IMPORTER_EXTS).values()].flat();
		expect(verdicts).toHaveLength(
			MODES.length * IMPORTER_EXTS.length * SIBLING_SETS.length * SPECIFIER_EXTS.length,
		);
		expect(verdicts.filter((v) => v).length).toBeGreaterThan(50);
		expect(verdicts.filter((v) => !v).length).toBeGreaterThan(50);
	});

	// The whole reason the table had to go: the SAME tree and the SAME specifier
	// get different verdicts under different `compilerOptions`, so a resolver that
	// cannot read the project cannot be right.
	it("D2b: the verdicts depend on the compiler options, not only on the tree", () => {
		const byMode = verdictsByMode("widget", IMPORTER_EXTS);
		const bundler = byMode.get("Bundler") ?? [];
		const suffixes = byMode.get("Bundler+moduleSuffixes") ?? [];
		const esm = byMode.get("NodeNext/esm-package") ?? [];
		expect(bundler.length).toBeGreaterThan(0);
		expect(suffixes.filter((v, i) => v !== bundler[i]).length).toBeGreaterThan(0);
		expect(esm.filter((v, i) => v !== bundler[i]).length).toBeGreaterThan(0);
	});

	// `paths`/`baseUrl` and `rootDirs` never apply to a relative specifier, so
	// this mode must produce exactly the plain Bundler verdicts.
	it("D2c: paths/baseUrl and rootDirs change no relative-specifier verdict", () => {
		const byMode = verdictsByMode("widget", IMPORTER_EXTS);
		expect(byMode.get("Bundler+paths+rootDirs")).toEqual(byMode.get("Bundler"));
	});

	it("D3: agrees for a double-extension file, where only the append pass can match", () => {
		expect(sweep("widget.js", [".ts", ".js"])).toEqual([]);
	});

	it("D4: agrees for a name whose stem already ends in a family extension", () => {
		expect(sweep("widget.mjs", [".ts", ".mts"])).toEqual([]);
	});
});

describe("self_import resolution — the reviewer's reproductions", () => {
	// test-contract: bug — the reviewer's seventh-pass reproduction: with
	// `moduleSuffixes: [".native", ""]` and a sibling widget.native.ts,
	// `"./widget.js"` inside widget.ts names a DIFFERENT module, and the candidate
	// table blocked the edit on a zero-false-positive rail.
	it("N0: `./widget.js` from widget.ts under moduleSuffixes names the .native sibling", () => {
		const s = scenario(".ts", "./widget.js", [".native.ts"]);
		const mode = BUNDLER_SUFFIXES;
		expect(typescriptSaysSelf(s, mode)).toBe(false);
		expect(checkSaysSelf(s, mode)).toBe(false);
	});

	// test-contract: invariant — the same options with the suffixed sibling absent
	// fall back to the empty suffix, so the import IS a self-import.
	it("P0: the same specifier fires under those options once the .native sibling is gone", () => {
		const s = scenario(".ts", "./widget.js", []);
		const mode = BUNDLER_SUFFIXES;
		expect(typescriptSaysSelf(s, mode)).toBe(true);
		expect(checkSaysSelf(s, mode)).toBe(true);
	});

	// test-contract: bug — the reviewer reproduced both of these with
	// ts.resolveModuleName against an in-memory filesystem; the stem-comparing
	// detector blocked them on a zero-false-positive pre_block rail.
	it("N1: `./widget.mjs` from widget.ts resolves to a DIFFERENT file, so it must not fire", () => {
		const s = scenario(".ts", "./widget.mjs", [".mts"]);
		expect(typescriptSaysSelf(s, BUNDLER)).toBe(false);
		expect(checkSaysSelf(s, BUNDLER)).toBe(false);
	});

	// test-contract: bug — the `.cjs` half of the same finding.
	it("N2: `./widget.cjs` from widget.ts names widget.cts, so it must not fire", () => {
		const s = scenario(".ts", "./widget.cjs", [".cts"]);
		expect(typescriptSaysSelf(s, BUNDLER)).toBe(false);
		expect(checkSaysSelf(s, BUNDLER)).toBe(false);
	});

	// test-contract: invariant — the fix must not cost the real self-import: the
	// ordinary `"./widget.js"` inside widget.ts still resolves to the importer.
	it("P1: `./widget.js` from widget.ts still resolves to the importer and fires", () => {
		const s = scenario(".ts", "./widget.js", []);
		expect(typescriptSaysSelf(s, BUNDLER)).toBe(true);
		expect(checkSaysSelf(s, BUNDLER)).toBe(true);
	});

	// test-contract: boundary — a same-basename module one directory away is the
	// classic false positive; TypeScript and the check must both say "not self".
	it("N3: a same-basename module in a subdirectory is never the importer", () => {
		const importer = join(CJS_ROOT, "widget.ts");
		const s: Scenario = {
			importer,
			specifier: "./sub/widget.js",
			files: new Set([importer, join(CJS_ROOT, "sub", "widget.ts")]),
		};
		expect(typescriptSaysSelf(s, BUNDLER)).toBe(false);
		expect(checkSaysSelf(s, BUNDLER)).toBe(false);
	});
});
