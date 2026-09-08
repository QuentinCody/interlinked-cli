// ===========================================
// Self-import resolution — WHICH PROJECT governs the importer
// ===========================================
// `self-import-resolve.ts` asks the compiler which file a specifier names, under
// the importer's compiler options. This module answers the question that comes
// before it: WHOSE options. Two reviewed defects lived in the previous answer
// (session review r2, 2026-09-05, findings 1 and 2):
//
//   - Parsed options were cached by the nearest config's own mtime, so an
//     edited `extends` target (or one that appeared after being missing) left a
//     long-lived daemon resolving under obsolete options and BLOCKING a valid
//     import. Nothing is cached here. A parse costs low single-digit
//     milliseconds against the PreToolUse path's seconds, and a `pre_block`
//     rail that consumes a stale configuration is the same defect class as one
//     that guesses a configuration.
//   - The nearest `tsconfig.json` was treated as the importer's project. A
//     solution config (`files: []`, `references: [...]`) governs nothing; the
//     project that INCLUDES the file does, and it may have any filename. So the
//     config graph is walked through `references`, and membership is decided
//     the way the compiler decides it — the config's `files` / `include` /
//     `exclude` matched against a virtual tree that holds ONLY the importer.
//     That also places a file that is not on disk yet (PreToolUse runs before
//     the bytes land), which a directory listing never could.
//
// What cannot be established is NOT MEASURED, never guessed: an unparsable
// config anywhere in the walked graph, two projects that both claim the file,
// a reference walk that hit its bound, or a file that NO walked project claims
// (`project_orphan` — session review r4, finding 3, retired the fallback that
// handed an orphan the nearest config's options: outside a project's `include`
// the honest answer is a disclosure, not a guessed configuration). The walk
// also visits the sibling `tsconfig*.json` files beside the nearest config, so
// an independently selected project (never referenced) still claims its files.

import { basename, dirname, extname, resolve as toAbsolutePath } from "node:path";
import type * as TS from "typescript";
import { proposedFileContent, proposedFileExists } from "./proposed-files.js";

type TsModule = typeof TS;

/** Why the governing project could not be established. Each is NOT MEASURED,
 *  never a guess (session review r3, findings 1 and 2):
 *  - `config_unparsable` — a config on the walk, or a file it extends, is unreadable;
 *  - `project_ambiguous` — two projects on the walk claim the file;
 *  - `graph_truncated` — the reference walk hit its bound with projects unvisited,
 *    so the claimant set is partial and no verdict may rest on it;
 *  - `project_orphan` — a solution (a config with `references`) governs the tree
 *    and no walked project claims the file by its root patterns; the file may
 *    still be a transitive member of one program (a `/// <reference>` target,
 *    an import-reached declaration), and root patterns cannot say which. */
export type OptionsResolutionReason = "config_unparsable" | "project_ambiguous" | "graph_truncated" | "project_orphan";

/** The answer for one importer. `configPath` is null only when no tsconfig sits
 *  above the file at all (the caller's defaults apply). */
export type OptionsResolution =
	| { readonly ok: true; readonly options: TS.CompilerOptions; readonly configPath: string | null }
	| {
			readonly ok: false;
			readonly reason: OptionsResolutionReason;
			readonly configPath: string;
			readonly detail: string;
	  };

/** The filesystem the config walk reads: the batch's PROPOSED view first (a
 *  tsconfig or package.json the batch itself writes governs the batch), the
 *  disk second. */
function fileExistsInView(ts: TsModule, path: string): boolean {
	return proposedFileExists(path) ?? ts.sys.fileExists(path);
}

function readFileInView(ts: TsModule, path: string): string | undefined {
	const proposed = proposedFileContent(path);
	if (proposed === null) return undefined;
	return proposed ?? ts.sys.readFile(path);
}

/** "No inputs were found" (18002/18003) is expected: the virtual tree holds one
 *  file, and a config whose patterns do not match it legitimately lists nothing. */
const BENIGN_CONFIG_ERRORS = new Set([18002, 18003]);

/** Bound on the reference walk. A real solution has a handful of projects; a
 *  graph deeper than this is not one this check needs to understand. */
const MAX_PROJECTS = 32;

interface FileSystemEntries {
	readonly files: readonly string[];
	readonly directories: readonly string[];
}

type MatchFiles = (
	path: string,
	extensions: readonly string[] | undefined,
	excludes: readonly string[] | undefined,
	includes: readonly string[] | undefined,
	useCaseSensitiveFileNames: boolean,
	currentDirectory: string,
	depth: number | undefined,
	getFileSystemEntries: (path: string) => FileSystemEntries,
	realpath: (path: string) => string,
) => string[];

/** `ts.matchFiles` is what `ts.sys.readDirectory` runs the config patterns
 *  through. It is not in the public typings, so its presence is checked at
 *  runtime; without it membership cannot be decided and every config reads as
 *  claiming nothing (the orphan rule then applies — the pre-r2 behavior). */
function matchFilesOf(ts: TsModule): MatchFiles | null {
	// SAFETY: a runtime-internal member is read off the module namespace and
	// type-checked by the `typeof` guard below; a missing member yields null.
	const candidate = (ts as unknown as { matchFiles?: unknown }).matchFiles;
	// SAFETY: the guard proves it is a function; its parameter list is the one
	// `ts.sys.readDirectory` passes in typescript.js 5.x, transcribed above.
	return typeof candidate === "function" ? (candidate as MatchFiles) : null;
}

function slashes(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** A directory listing of a tree that contains exactly one file: the importer.
 *  Each ancestor directory lists the next segment toward it; its own directory
 *  lists the file; anything else is empty. */
function virtualEntries(importerKey: string): (path: string) => FileSystemEntries {
	const importer = slashes(importerKey);
	const importerDir = slashes(dirname(importerKey));
	return (path) => {
		const dir = slashes(path);
		if (dir === importerDir) return { files: [basename(importer)], directories: [] };
		if (importer.startsWith(`${dir}/`)) {
			const rest = importer.slice(dir.length + 1);
			const next = rest.slice(0, rest.indexOf("/"));
			return next === "" ? { files: [], directories: [] } : { files: [], directories: [next] };
		}
		return { files: [], directories: [] };
	};
}

const JS_FAMILY_EXTS: readonly string[] = [".js", ".jsx", ".mjs", ".cjs"];

/** A JS-family importer self-imports at RUNTIME whatever the project says about
 *  COMPILING JavaScript, so its membership is judged by the project's patterns
 *  alone: the extension filter the compiler hands the host (TS-only unless
 *  `allowJs`) is widened the way `widenForJsImporter` (self-import-resolve.ts)
 *  widens the resolution options. The virtual tree holds only the importer, so
 *  the wider filter can admit nothing else — `include`/`exclude` still decide. */
function membershipExtensions(extensions: readonly string[] | undefined, importerKey: string): readonly string[] | undefined {
	if (extensions === undefined || !JS_FAMILY_EXTS.includes(extname(importerKey).toLowerCase())) return extensions;
	return [...extensions, ...JS_FAMILY_EXTS.filter((ext) => !extensions.includes(ext))];
}

function virtualHost(ts: TsModule, importerKey: string): TS.ParseConfigHost {
	const matchFiles = matchFilesOf(ts);
	const entries = virtualEntries(importerKey);
	return {
		useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
		fileExists: (path) => fileExistsInView(ts, path),
		readFile: (path) => readFileInView(ts, path),
		readDirectory: (rootDir, extensions, excludes, includes, depth) =>
			matchFiles === null
				? []
				: matchFiles(rootDir, membershipExtensions(extensions, importerKey), excludes, includes, ts.sys.useCaseSensitiveFileNames, rootDir, depth, entries, (path) => path),
	};
}

interface ProjectConfig {
	readonly configPath: string;
	readonly options: TS.CompilerOptions;
	readonly references: readonly string[];
	readonly includesImporter: boolean;
}

/** Parse one config against the virtual tree. Null when the config — or any
 *  file in its `extends` chain — cannot be read: half a configuration is not a
 *  configuration a blocking verdict may rest on. */
function parseProject(ts: TsModule, configPath: string, importerKey: string): ProjectConfig | null {
	try {
		const read = ts.readConfigFile(configPath, (path) => readFileInView(ts, path));
		if (read.error !== undefined || read.config === undefined) return null;
		const parsed = ts.parseJsonConfigFileContent(read.config, virtualHost(ts, importerKey), dirname(configPath), undefined, configPath);
		if (parsed.errors.some((error) => !BENIGN_CONFIG_ERRORS.has(error.code))) return null;
		return {
			configPath,
			options: parsed.options,
			references: (parsed.projectReferences ?? []).map((reference) => toAbsolutePath(ts.resolveProjectReferencePath(reference))),
			includesImporter: parsed.fileNames.some((file) => toAbsolutePath(file) === importerKey),
		};
	} catch {
		return null;
	}
}

function unparsable(configPath: string): OptionsResolution {
	return { ok: false, reason: "config_unparsable", configPath, detail: `${configPath} (or a file it extends) could not be parsed` };
}

interface Walk {
	readonly claims: readonly ProjectConfig[];
	/** True when the bound stopped the walk with projects still unvisited. A
	 *  partial claimant set is not a verdict — even one claim found so far can
	 *  be made ambiguous by a project the walk never reached (review r3, 1). */
	readonly truncated: boolean;
}

/** The other `tsconfig*.json` files BESIDE the nearest config. A project
 *  selected independently (`tsc -p tsconfig.app.json`, a build tool's own
 *  config) need not appear in any `references` graph, and its absence there
 *  is no evidence that it does not own the file (review r4, finding 3). Disk
 *  listing only: a config the batch itself creates beside the nearest one is
 *  not discovered — a narrow, documented blind spot. */
function siblingConfigs(ts: TsModule, configPath: string): string[] {
	const dir = dirname(configPath);
	try {
		return ts.sys
			.readDirectory(dir, [".json"], undefined, ["tsconfig*.json"], 1)
			.map((path) => toAbsolutePath(path))
			.filter((path) => path !== configPath);
	} catch {
		return [];
	}
}

/** Walk `references` breadth-first from the nearest config — and its sibling
 *  configs — collecting every project whose patterns claim the importer. Null
 *  when any config on the walk is unparsable. */
function claimingProjects(ts: TsModule, root: ProjectConfig, importerKey: string): Walk | null {
	const visited = new Set<string>([root.configPath]);
	const queue = [...root.references, ...siblingConfigs(ts, root.configPath)];
	const claims: ProjectConfig[] = [];
	while (queue.length > 0) {
		const next = queue.shift();
		if (next === undefined || visited.has(next)) continue;
		if (visited.size >= MAX_PROJECTS) return { claims, truncated: true };
		visited.add(next);
		const project = parseProject(ts, next, importerKey);
		if (project === null) return null;
		if (project.includesImporter) claims.push(project);
		queue.push(...project.references);
	}
	return { claims, truncated: false };
}

function notMeasured(reason: OptionsResolutionReason, configPath: string, detail: string): OptionsResolution {
	return { ok: false, reason, configPath, detail };
}

/** The verdict once the nearest config does NOT claim the file and its
 *  reference graph has been walked. */
function verdictFromWalk(root: ProjectConfig, walk: Walk): OptionsResolution {
	const { configPath } = root;
	if (walk.truncated) {
		return notMeasured("graph_truncated", configPath, `the reference walk from ${configPath} stopped at ${MAX_PROJECTS} projects with more unvisited, so the owning project may lie beyond the bound`);
	}
	const [only] = walk.claims;
	if (walk.claims.length === 1 && only !== undefined) return { ok: true, options: only.options, configPath: only.configPath };
	if (walk.claims.length > 1) {
		const names = walk.claims.map((project) => project.configPath).join(", ");
		return notMeasured("project_ambiguous", configPath, `${walk.claims.length} referenced projects claim this file: ${names}`);
	}
	// No walked project — the nearest config, its references, its sibling
	// configs — claims the file by root patterns. The previous fallback took
	// the nearest config's options when it had no references, reasoning that
	// only one program existed; review r4 (finding 3) showed an independently
	// selected sibling config owning the file with different options, so the
	// absence of references proves nothing. Ownership not established is NOT
	// MEASURED, never a guess.
	return notMeasured("project_orphan", configPath, `no project reachable from ${configPath} (its references and sibling tsconfig*.json files) claims this file by its files/include patterns; it may be a transitive member of one of them, which root patterns cannot decide`);
}

/**
 * The compiler options governing `filePath`: the nearest config when it claims
 * the file itself; otherwise the ONE referenced project that does; the caller's
 * `defaults` when no config exists at all; the nearest config's options when it
 * has no references and does not claim the file (the only program there is).
 * NOT MEASURED — never a guess — when a config on the walk is unparsable, two
 * projects claim the file, the walk hit its bound, or a solution's projects
 * leave the file unclaimed by root patterns.
 */
export function governingCompilerOptions(ts: TsModule, filePath: string, defaults: TS.CompilerOptions): OptionsResolution {
	const importerKey = toAbsolutePath(filePath);
	const nearest = ts.findConfigFile(dirname(importerKey), (path) => fileExistsInView(ts, path));
	if (nearest === undefined) return { ok: true, options: defaults, configPath: null };
	const configPath = toAbsolutePath(nearest);
	const root = parseProject(ts, configPath, importerKey);
	if (root === null) return unparsable(configPath);
	if (root.includesImporter) return { ok: true, options: root.options, configPath };
	const walk = claimingProjects(ts, root, importerKey);
	if (walk === null) return unparsable(configPath);
	return verdictFromWalk(root, walk);
}
