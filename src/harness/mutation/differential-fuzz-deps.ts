// ===========================================
// Differential fuzz — late runtime dependency resolution + mutant build
// ===========================================
// The fuzz engine (see differential-fuzz-types.ts) needs two things this
// package does not hard-depend on: a TypeScript compiler — to read the target
// function's declared types AND to build the pristine/mutant module pair — and
// fast-check, to search the input space and shrink a counterexample. This
// module resolves both LATE and reports absence honestly, the same
// loud-degradation contract `astComplexityAvailable()` (checks/cyclomatic-ast.ts)
// and `mutationIdentityAvailable()` (identity.ts) already use: never throw at
// load time, never pretend a search ran that could not run.
//
// Why NOT esbuild (the obvious mutant-builder): it is not in package.json at
// all — it exists only as a transitive dependency of the build/test toolchain.
// Depending on it from src/ would mean depending on a package this repo never
// declares, never pins, never puts through the supply-chain allowlist, and
// that a published install may not carry. `typescript` is ALREADY an
// optionalDependency (a normal `npm install` pulls it in), and
// `ts.transpileModule` does everything a mutant build needs: one file, no type
// check, no module graph, no bundler. See `transpileMutantModule` below.
//
// Why fast-check is loaded through a DYNAMIC import: it is a devDependency, so
// it is genuinely absent from a published install. A top-level `import` here
// would be a hard load-time failure for the daemon (this module sits under
// src/harness/, which the daemon bundles); a call-time `import()` is a
// recoverable one that degrades to "fuzz unavailable: fast-check not
// installed". The specifier goes through a const so a bundler cannot statically
// inline a devDependency into dist/.

import { createRequire } from "node:module";
import type * as TS from "typescript";
import { isJsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";

export type TsModule = typeof TS;

/** Module specifier held in a const so the bundler sees no literal to inline. */
const FAST_CHECK_SPECIFIER = "fast-check";

/** The narrow slice of fast-check this engine calls. Declared structurally
 *  rather than as `import type * as FC from "fast-check"` so nothing in src/
 *  references a package a published install does not carry — the runtime guard
 *  `isFastCheckModule` below is what actually proves the shape. */
export interface FastCheckModule {
	/** `fc.assert(property, { numRuns, seed })` — runs the search. */
	assert: (...args: unknown[]) => unknown;
	/** `fc.property(...arbitraries, predicate)` — the sync property builder. */
	property: (...args: unknown[]) => unknown;
	/** `fc.asyncProperty(...)` — used when the target returns a promise. */
	asyncProperty: (...args: unknown[]) => unknown;
}

/** Which of the engine's late dependencies this process can resolve. Both
 *  fields are always present — a caller reads booleans, never `undefined`. */
export interface DifferentialFuzzAvailability {
	/** `typescript`: type-derived arbitraries AND the mutant module build. */
	ts: boolean;
	/** `fast-check`: the counterexample search and its shrinker. */
	fastCheck: boolean;
}

/** Result of building one module from (possibly mutated) TypeScript source. */
export interface TranspiledModule {
	/** Emitted ESM JavaScript, ready to write next to the original file. */
	js: string;
	/** Syntactic diagnostics the emit produced, formatted one per entry.
	 *  Empty on a clean build. Never thrown: a mutant whose source no longer
	 *  parses is an honest "could not build", not a crash. */
	diagnostics: string[];
}

let tsCache: TsModule | null | undefined;
let fastCheckCache: FastCheckModule | null | undefined;
let fastCheckPending: Promise<FastCheckModule | null> | null = null;

/** Resolve a package from this module's location WITHOUT executing it — the
 *  cheap, side-effect-free half of the availability probe. Exported so the
 *  unresolvable-specifier catch branch is directly testable: both real
 *  specifiers this module calls it with (`typescript`, `fast-check`) resolve
 *  in every environment that runs this suite, so the false path is otherwise
 *  unreachable through `differentialFuzzAvailability()`. */
export function canResolve(specifier: string): boolean {
	try {
		createRequire(import.meta.url).resolve(specifier);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve `typescript` once, synchronously, treating absence as a non-error.
 * Cached (including the null result) so a missing dep costs one failed require.
 * Same load dance as checks/cyclomatic-ast.ts and mutation/identity.ts.
 */
export function loadTsModule(): TsModule | null {
	if (tsCache !== undefined) return tsCache;
	try {
		// SAFETY: this resolves the installed TypeScript package described by its compiler API declarations.
		tsCache = createRequire(import.meta.url)(FAST_CHECK_TS_SPECIFIER) as TsModule;
	} catch {
		tsCache = null;
	}
	return tsCache;
}

/** Held in a const for the same bundler reason as the fast-check specifier. */
const FAST_CHECK_TS_SPECIFIER = "typescript";

/** Runtime shape proof for the dynamically imported module — the import is
 *  untyped by construction (a non-literal specifier), so the surface is
 *  CHECKED rather than asserted. */
function isFastCheckModule(mod: unknown): mod is FastCheckModule {
	if (!isJsonObject(mod)) return false;
	const candidate = mod;
	return (
		typeof candidate.assert === "function" &&
		typeof candidate.property === "function" &&
		typeof candidate.asyncProperty === "function"
	);
}

/**
 * Resolve `fast-check` at CALL time via a dynamic import, treating absence (and
 * an unexpected module shape) as a non-error null. Cached — including the null
 * — and concurrency-safe: overlapping callers share one in-flight import rather
 * than racing two loads.
 */
export async function loadFastCheck(): Promise<FastCheckModule | null> {
	if (fastCheckCache !== undefined) return fastCheckCache;
	if (fastCheckPending !== null) return fastCheckPending;
	fastCheckPending = (async (): Promise<FastCheckModule | null> => {
		let mod: unknown;
		try {
			mod = await import(FAST_CHECK_SPECIFIER);
		} catch {
			mod = null;
		}
		fastCheckCache = isFastCheckModule(mod) ? mod : null;
		fastCheckPending = null;
		return fastCheckCache;
	})();
	return fastCheckPending;
}

/**
 * Which late dependencies this process can resolve. A pure probe: it resolves
 * paths, it does not execute either package, so calling it is cheap and safe
 * on any path (including a hook path that will never run a fuzz search).
 */
export function differentialFuzzAvailability(): DifferentialFuzzAvailability {
	return {
		ts: canResolve(FAST_CHECK_TS_SPECIFIER),
		fastCheck: canResolve(FAST_CHECK_SPECIFIER),
	};
}

/**
 * The user-facing degradation line for an availability report: empty string
 * when everything resolved, otherwise a loud note naming exactly what is
 * missing, in a stable order (typescript, then fast-check). Callers put this
 * straight into a `FuzzUnavailableOutcome.reason` — the engine never silently
 * skips a search it could not run.
 */
export function missingDependencyNote(availability: DifferentialFuzzAvailability): string {
	const missing: string[] = [];
	if (!availability.ts) missing.push("typescript not installed");
	if (!availability.fastCheck) missing.push("fast-check not installed");
	if (missing.length === 0) return "";
	return `fuzz unavailable: ${missing.join("; ")}`;
}

/**
 * Build one module from TypeScript source using `ts.transpileModule` — the
 * esbuild replacement. Emits ESM (this package is `"type": "module"`), strips
 * types only, and never type-checks: a mutant is a deliberate perturbation of
 * working code, so a type error in the MUTANT is not a reason to refuse to run
 * it. Returns null when `typescript` is unresolvable, so the caller reports
 * `unavailable` rather than crashing.
 */
export function transpileMutantModule(source: string, filePath: string): TranspiledModule | null {
	const ts = loadTsModule();
	if (ts === null) return null;
	const emitted = ts.transpileModule(source, {
		fileName: filePath,
		reportDiagnostics: true,
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
			isolatedModules: true,
			// The mutant is written NEXT TO its original, so relative imports
			// resolve unchanged; no path rewriting is needed or wanted.
			verbatimModuleSyntax: false,
		},
	});
	// TypeScript's transpileWorker always returns its initialized diagnostics array.
	const diagnostics = nonNull(emitted.diagnostics).map((d) =>
		ts.flattenDiagnosticMessageText(d.messageText, " "),
	);
	return { js: emitted.outputText, diagnostics };
}

/** Test-only cache reset so a suite can exercise both resolution paths without
 *  a stale memo leaking across cases. */
export function __resetDifferentialFuzzDepsCacheForTests(): void {
	tsCache = undefined;
	fastCheckCache = undefined;
	fastCheckPending = null;
}
