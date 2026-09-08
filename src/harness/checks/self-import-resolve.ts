// ===========================================
// Self-import resolution — run the PROJECT's compiler, never a table
// ===========================================
// Which file a specifier names is half of a self-import decision, and until
// 2026-09-05 this half was a hand-written candidate table: one ordered list of
// extension substitutions, walked against an on-disk probe. The table was
// measured against `ts.resolveModuleName` and still wrong, because a table
// cannot see the importer's PROJECT (review finding 1 [P1], seventh pass,
// reviewer-reproduced with TypeScript 5.9.3):
//
//   compilerOptions: { moduleSuffixes: [".native", ""] }, sibling widget.native.ts
//   widget.ts:  export { x } from "./widget.js";   // → widget.native.ts
//
// That import names a DIFFERENT module, and the table blocked it. `self_import`
// is a `fully_deterministic`, severity-error `pre_block` rail, so that is a
// valid edit refused with no recourse. And `moduleSuffixes` is only the first
// option to move resolution: `moduleResolution: "classic"` does NOT substitute
// extensions (from widget.ts, `"./widget.js"` looks for widget.js.ts and never
// reaches widget.ts), NodeNext decides ESM-vs-CJS from the nearest package.json
// `type` (an ESM file's extensionless `"./widget"` resolves to NOTHING),
// `rootDirs` adds virtual directories, `allowJs` decides whether .js is a
// target at all, and `paths`/`baseUrl` exist but never apply to a relative
// specifier. A deterministic blocking gate may not guess across that space.
//
// So this module asks the compiler instead: discover the governing tsconfig,
// parse it (`extends` chains and all), and hand the resulting options to
// `ts.resolveModuleName` with a host whose `fileExists` is the injected probe.
// The verdict is "self" iff the compiler's own `resolvedFileName` IS the
// importer. `self-import-scan.resolution.test.ts` sweeps that verdict against
// `ts.resolveModuleName` over every (options × tree × specifier) combination.
//
// Split out of `self-import-scan.ts` (which keeps the AST pass and the check's
// public entry points) to stay under the per-file line cap.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, resolve as toAbsolutePath } from "node:path";
import type * as TS from "typescript";
import { proposedDirectoryExists, proposedFileContent, proposedFileExists } from "./proposed-files.js";
import { governingCompilerOptions, type OptionsResolution } from "./self-import-project.js";

type TsModule = typeof TS;

// Self-contained `typescript` loader — the same idiom as cyclomatic-ast.ts /
// introverted-test.ts. The dep is an optionalDependency: under
// `--omit=optional` there is no resolver, and the check is NOT MEASURED rather
// than guessed (`selfImportMeasurable` in self-import-scan.ts discloses it).
let tsCache: TsModule | null | undefined;

function loadTs(): TsModule | null {
	if (tsCache !== undefined) return tsCache;
	try {
		// An absent dep throws and is cached as null below.
		// SAFETY: `require("typescript")` returns that module's namespace object, which is exactly `typeof import("typescript")`.
		tsCache = createRequire(import.meta.url)("typescript") as TsModule;
	} catch {
		tsCache = null;
	}
	return tsCache;
}

/** How the resolver asks whether a sibling file is on disk. Injectable so a test
 *  can drive a virtual tree, and so no caller is forced to touch the filesystem. */
export type ExistsProbe = (path: string) => boolean;

/** The batch's PROPOSED view first (a sibling the same batch creates exists;
 *  one it deletes does not), the disk second — review r3, finding 3. */
const defaultExists: ExistsProbe = (path) => proposedFileExists(path) ?? existsSync(path);

/** A probe that throws answers "absent" — the same answer `existsSync` gives for
 *  an unreadable path, so the injected and default paths agree. */
function probe(path: string, exists: ExistsProbe): boolean {
	try {
		return exists(path);
	} catch {
		return false;
	}
}

/** cwd-absolute and case-PRESERVING, so two spellings of one path compare equal
 *  while two casings of one path on a case-insensitive volume do not (the
 *  compiler resolves `"./Widget.js"` to `Widget.ts`, and so do we). */
function pathKey(path: string): string {
	return toAbsolutePath(path);
}

// ---------------------------------------------------------------------------
// The governing compiler options
// ---------------------------------------------------------------------------

/** Used only when NO tsconfig governs the file. Bundler + allowJs is the most
 *  permissive relative-specifier behavior there is, so the ordinary
 *  `"./widget"` / `"./widget.js"` self-import still fires in a directory nobody
 *  has configured. */
function defaultOptions(ts: TsModule): TS.CompilerOptions {
	return { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
}

/** The nearest tsconfig above `filePath`, or null when none sits above it. The
 *  GOVERNING config may be a referenced project instead
 *  (`governingCompilerOptions`); this is the discovery root the NOT MEASURED
 *  disclosure names. */
export function selfImportConfigPath(filePath: string): string | null {
	const ts = loadTs();
	if (ts === null) return null;
	const exists = (path: string): boolean => proposedFileExists(path) ?? ts.sys.fileExists(path);
	return ts.findConfigFile(dirname(pathKey(filePath)), exists) ?? null;
}

/** Which project's options govern `filePath`, walked fresh on every call —
 *  nearest config, `references`, membership by the compiler's own patterns
 *  (`self-import-project.ts`). Null only when `typescript` is unresolvable. */
export function selfImportOptionsResolution(filePath: string): OptionsResolution | null {
	const ts = loadTs();
	return ts === null ? null : governingCompilerOptions(ts, filePath, defaultOptions(ts));
}

const JS_IMPORTER_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

/** A `.js` file that imports itself self-imports at RUNTIME whatever the project
 *  says about COMPILING it, so a JS-family importer resolves with `allowJs` on
 *  even when the tsconfig excludes JS. The widening only ADDS candidates, and
 *  TypeScript tries every .ts candidate before any .js one, so it can never
 *  shadow a TS importer — it only lets a JS importer be found at all. Discovery
 *  path only: options handed in by a caller are used verbatim. */
function widenForJsImporter(base: TS.CompilerOptions, filePath: string): TS.CompilerOptions {
	if (base.allowJs === true || !JS_IMPORTER_EXTS.has(extname(filePath).toLowerCase())) return base;
	return { ...base, allowJs: true };
}

/**
 * The compiler options `filePath`'s own project resolves under, or null when the
 * check cannot measure: `typescript` is unresolvable, or the governing tsconfig
 * cannot be understood. Null is never "assume defaults" — a `pre_block` rail
 * that guessed the configuration is exactly the defect this module replaced.
 */
export function selfImportCompilerOptions(filePath: string): TS.CompilerOptions | null {
	const resolution = selfImportOptionsResolution(filePath);
	if (resolution === null || !resolution.ok) return null;
	return widenForJsImporter(resolution.options, filePath);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function readFileOrUndefined(file: string): string | undefined {
	const proposed = proposedFileContent(file);
	if (proposed !== undefined) return proposed ?? undefined;
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** `""` is the directory of a bare relative filename — the process cwd, which is
 *  what every other relative path in the call resolves against. */
function directoryExistsOnDisk(dir: string): boolean {
	const proposed = proposedDirectoryExists(dir === "" ? "." : dir);
	if (proposed !== undefined) return proposed;
	try {
		return statSync(dir === "" ? "." : dir).isDirectory();
	} catch {
		return false;
	}
}

/**
 * True when the importer's own directory is on disk — i.e. there is a real tree
 * to resolve in. Directories come from the REAL filesystem, never from the
 * probe and never assumed: TypeScript skips every `fileExists` probe under a
 * directory it believes is absent, so a fabricated "yes" would let the resolver
 * decide inside a tree nobody can see, which is the class of defect this module
 * exists to end. When this is false the check is NOT MEASURED and says so
 * (`selfImportNotMeasuredWarning`) — a `pre_block` rail may under-report, but it
 * may never block on an invented tree. The PostToolUse pass re-runs once the
 * directory is on disk, so a file written into a brand-new directory is judged
 * one phase later rather than guessed at.
 */
export function selfImportDirectoryVisible(filePath: string): boolean {
	return directoryExistsOnDisk(dirname(filePath));
}

/** The compiler's view of the tree for ONE importer: the injected probe decides
 *  which sibling FILES exist, the importer itself always exists (it is the
 *  content being written, which may not be on disk yet), and package.json is
 *  read from the real filesystem because NodeNext's ESM-vs-CJS decision depends
 *  on it. `realpath` is deliberately absent: a symlinked path that names the
 *  importer is still the importer. */
function resolutionHost(filePath: string, exists: ExistsProbe): TS.ModuleResolutionHost {
	const importerKey = pathKey(filePath);
	return {
		fileExists: (candidate) => pathKey(candidate) === importerKey || probe(candidate, exists),
		readFile: readFileOrUndefined,
		directoryExists: directoryExistsOnDisk,
	};
}

/** Everything one importer's resolutions share, built once per file. */
interface ImporterView {
	readonly ts: TsModule;
	readonly filePath: string;
	readonly importerKey: string;
	readonly options: TS.CompilerOptions;
	readonly host: TS.ModuleResolutionHost;
	readonly mode: TS.ResolutionMode;
}

/** Establish the importer's project format and filesystem view once per scan.
 * Each AST usage then supplies its own import/require resolution mode: dynamic
 * imports, import-equals and type-import attributes can override the file format.
 * Callers supplying only a specifier use the importer's format as their default. */
function importerView(input: {
	ts: TsModule;
	filePath: string;
	options: TS.CompilerOptions;
	exists: ExistsProbe;
}): ImporterView {
	const { ts, filePath, options } = input;
	const importerKey = pathKey(filePath);
	const host = resolutionHost(filePath, input.exists);
	let mode: TS.ResolutionMode;
	try {
		mode = ts.getImpliedNodeFormatForFile(importerKey, undefined, host, options);
	} catch {
		mode = undefined;
	}
	return { ts, filePath, importerKey, options, host, mode };
}

/** The specifier's file-name stem: everything before its FIRST dot, which is the
 *  longest prefix every possible target shares. `moduleSuffixes` inserts a
 *  suffix before the extension (`"./widget.js"` → widget.native.ts) and the
 *  append pass adds one (`"./widget.js"` → widget.js.ts), so the test is
 *  startsWith, never equality. */
function specifierStem(specifier: string): string {
	const name = basename(specifier);
	const dot = name.indexOf(".");
	return dot < 0 ? name : name.slice(0, dot);
}

/** The cheap pre-filter: unless the importer's own name could be built from the
 *  specifier's stem, no tree can make this specifier name the importer, so the
 *  resolver never runs and the filesystem is never touched.
 *
 *  Known, deliberate blind spot: a DIRECTORY specifier (`"."`, `"../foo"`) can
 *  name `foo/index.ts` without sharing its stem. `"."` and `"./"` have an empty
 *  stem and still pass; `"../foo"` from `foo/index.ts` does not, and that
 *  self-import is not reported. The pre-AST detector missed the same shape, and
 *  a `pre_block` rail may under-report — it may not over-block. */
function couldNameImporter(filePath: string, specifier: string): boolean {
	return basename(filePath).startsWith(specifierStem(specifier));
}

/** A resolver bound to ONE importer: options, host and module mode are computed
 *  once, so a file with thirty relative imports pays the setup once. Null means
 *  the check is NOT MEASURED for this file (no `typescript`, or an unparsable
 *  tsconfig) — never "no self-imports". */
export type SelfImportResolver = (specifier: string, usage?: TS.StringLiteralLike) => boolean;

export function selfImportResolverFor(
	filePath: string,
	exists: ExistsProbe = defaultExists,
	options?: TS.CompilerOptions,
): SelfImportResolver | null {
	const ts = loadTs();
	if (ts === null) return null;
	if (!selfImportDirectoryVisible(filePath)) return null;
	const effective = options ?? selfImportCompilerOptions(filePath);
	if (effective === null) return null;
	const view = importerView({ ts, filePath, options: effective, exists });
	return (specifier, usage) => {
		if (!specifier.startsWith(".") || !couldNameImporter(filePath, specifier)) return false;
		return resolvedFileKey(view, specifier, usage) === view.importerKey;
	};
}

/** The shared parser's SourceFile is immutable. Project format belongs to this
 * resolver view, while the compiler derives each usage's import/require mode
 * from its syntax and any resolution-mode attribute. */
function usageMode(view: ImporterView, usage: TS.StringLiteralLike): TS.ResolutionMode {
	const source = new Proxy(usage.getSourceFile(), {
		get(target, key, receiver) {
			return key === "impliedNodeFormat" ? view.mode : Reflect.get(target, key, receiver);
		},
	});
	return view.ts.getModeForUsageLocation(source, usage, view.options);
}

function resolvedFileKey(view: ImporterView, specifier: string, usage?: TS.StringLiteralLike): string | null {
	try {
		const resolved = view.ts.resolveModuleName(
			specifier,
			view.filePath,
			view.options,
			view.host,
			undefined,
			undefined,
			usage === undefined ? view.mode : usageMode(view, usage),
		).resolvedModule?.resolvedFileName;
		return resolved === undefined ? null : pathKey(resolved);
	} catch {
		return null;
	}
}

/**
 * True when a RELATIVE specifier resolves back to the importing file, decided by
 * the compiler the importer's own project would run: `ts.resolveModuleName`
 * under the discovered `compilerOptions`, against `exists`. False whenever the
 * answer is not certain — the check is NOT MEASURED (no `typescript`, unparsable
 * tsconfig) or TypeScript resolved nothing at all. Pass `options` to pin the
 * configuration explicitly; the differential test does exactly that.
 */
export function resolvesToSelf(
	filePath: string,
	specifier: string,
	exists: ExistsProbe = defaultExists,
	options?: TS.CompilerOptions,
): boolean {
	const resolver = selfImportResolverFor(filePath, exists, options);
	return resolver !== null && resolver(specifier);
}
