// ===========================================
// Configuration graph — the files the type checker READS for a file
// ===========================================
// Session review r5 (2026-09-06), finding 1. The batch gate disclosed "the type
// checker cannot see the proposed configuration" by FILENAME (`tsconfig*.json`,
// `jsconfig.json`, `package.json`), so a batch that rewrote `base.json` — the
// target of the project's `extends` — was judged under the disk's options and
// reported clean while the materialized program was TS2322. The boundary is
// the configuration graph, not a name: the tsconfig that GOVERNS the file plus
// every file its `extends` chain pulls in, resolved by TypeScript's own config
// parser (relative paths, `extends` arrays, package references). The walk reads
// the batch's proposed view first, so a config the batch rewrites is walked in
// its proposed form. `package.json` stays a filename rule in the gate: module
// resolution reads it per import, which no config graph enumerates.
//
// Session review r6 (2026-09-06), finding 2. WHICH tsconfig governs the file is
// the same answer `self_import` gives (`self-import-project.ts`): the nearest
// config, its `references`, its sibling `tsconfig*.json` files, membership by
// the config's own patterns. The compiler phase (`tsc-overlay-service.ts`)
// selects its program through `selectCheckerConfig` below, so the three
// consumers judge ONE program. A file no single project claims is NOT MEASURED
// for the compiler, never forced into the project root's program; only a file
// with no tsconfig above it at all falls back to the project root's config.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type * as TS from "typescript";
import { proposedFileContent, proposedFileExists } from "./checks/proposed-files.js";
import { governingCompilerOptions, type OptionsResolutionReason } from "./checks/self-import-project.js";

type TsModule = typeof TS;

// Self-contained `typescript` loader — the same idiom as self-import-resolve.ts.
// The dep is an optionalDependency: without it there is no config parser, and
// the graph is empty (the gate's filename rule still applies).
let tsCache: TsModule | null | undefined;

function loadTs(): TsModule | null {
	if (tsCache !== undefined) return tsCache;
	try {
		// SAFETY: `require("typescript")` returns that module's namespace object, which is exactly `typeof import("typescript")`.
		tsCache = createRequire(import.meta.url)("typescript") as TsModule;
	} catch {
		tsCache = null;
	}
	return tsCache;
}

/** The legacy fallback walk: `tsconfig.json` at the project root or up to four levels above it. */
const CONFIG_WALK_LEVELS = 5;

function fileExistsInView(ts: TsModule, path: string): boolean {
	return proposedFileExists(path) ?? ts.sys.fileExists(path);
}

function readFileInView(ts: TsModule, path: string): string | undefined {
	const proposed = proposedFileContent(path);
	if (proposed === null) return undefined;
	return proposed ?? ts.sys.readFile(path);
}

/** The project root's own tsconfig, or null — the fallback for a file with no config above it. */
function rootConfigPath(ts: TsModule, projectRoot: string): string | null {
	let dir = resolve(projectRoot);
	for (let level = 0; level < CONFIG_WALK_LEVELS; level++) {
		const candidate = resolve(dir, "tsconfig.json");
		if (fileExistsInView(ts, candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/** Which tsconfig the type checker runs a file under. */
export type CheckerConfigSelection =
	/** ONE project claims the file (or no config sits above the file and the project root's config stands in). */
	| { readonly kind: "config"; readonly configPath: string }
	/** No single project can be established — the compiler must not guess; `configPath` is the nearest config, the disclosure root. */
	| {
			readonly kind: "not_measured";
			readonly reason: OptionsResolutionReason;
			readonly detail: string;
			readonly configPath: string;
	  }
	/** No tsconfig anywhere in reach. */
	| { readonly kind: "none" };

/**
 * The configuration the type checker runs `filePath` under — the same
 * selection `self_import` makes (review r6, finding 2), so the compiler phase
 * and the self-import rail judge one program.
 */
export function selectCheckerConfig(ts: TsModule, filePath: string, projectRoot: string): CheckerConfigSelection {
	const resolution = governingCompilerOptions(ts, filePath, {});
	if (!resolution.ok) {
		return { kind: "not_measured", reason: resolution.reason, detail: resolution.detail, configPath: resolution.configPath };
	}
	if (resolution.configPath !== null) return { kind: "config", configPath: resolution.configPath };
	const fallback = rootConfigPath(ts, projectRoot);
	return fallback === null ? { kind: "none" } : { kind: "config", configPath: fallback };
}

/** `configPath` and its whole `extends` closure (a missing `extends` target
 *  included — creating it changes the program too). An unparsable config is
 *  still on the graph: rewriting it changes the program. The config parser
 *  reports problems as diagnostics rather than throwing. The overlay service
 *  fingerprints exactly these files to decide whether a warm LanguageService
 *  still describes the configuration on disk (review r7, finding 2). */
function configClosureOf(ts: TsModule, configPath: string): readonly string[] {
	const graph = new Set<string>([configPath]);
	const read = ts.readConfigFile(configPath, (path) => readFileInView(ts, path));
	if (read.error !== undefined || read.config === undefined) return [...graph];
	const host: TS.ParseConfigHost = {
		useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
		fileExists: (path) => fileExistsInView(ts, path),
		readFile: (path) => readFileInView(ts, path),
		// Membership is not the question here; an empty listing keeps the parse
		// to the configuration files alone ("no inputs found" is a benign error).
		readDirectory: () => [],
	};
	const extended = new Map<string, TS.ExtendedConfigCacheEntry>();
	ts.parseJsonConfigFileContent(read.config, host, dirname(configPath), undefined, configPath, undefined, undefined, extended);
	for (const entry of extended.values()) graph.add(resolve(entry.extendedResult.fileName));
	return [...graph];
}

/** One file of a configuration closure as it is on disk right now: its content
 *  hash. Size and mtime are not identity — a same-size rewrite that preserves
 *  its timestamp is still a different configuration (review r8, finding 2). */
function fileStamp(file: string): string {
	try {
		return `${file}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
	} catch {
		return `${file}:missing`;
	}
}

/**
 * The identity of the configuration `configPath` describes on disk: every
 * file of its `extends` closure stamped by content. A warm compiler service
 * is reused only while this identity is unchanged — its host closes over the
 * options parsed at construction (review r7, finding 2).
 */
export function configFingerprintOf(ts: TsModule, configPath: string): string {
	return configClosureOf(ts, configPath).map(fileStamp).join("\n");
}

/**
 * Absolute paths of every configuration file the type checker reads for
 * `filePath`: the governing tsconfig and its `extends` closure. Empty when no
 * tsconfig is in reach or `typescript` is unresolvable. For a file no single
 * project claims, the nearest config (the disclosure root) — the compiler
 * reports that file NOT MEASURED, and a rewrite of the nearest config is
 * still a configuration change worth disclosing.
 */
export function configGraphFor(filePath: string, projectRoot: string): readonly string[] {
	const ts = loadTs();
	if (ts === null) return [];
	const selection = selectCheckerConfig(ts, filePath, projectRoot);
	if (selection.kind === "none") return [];
	return configClosureOf(ts, selection.configPath);
}
