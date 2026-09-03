// ===========================================
// Project Graph — filesystem scan helpers
// ===========================================
// Directory walk (skip-dir list, project-boundary detection) and tsconfig
// path-alias loading for ProjectGraph.initialize(). Split out of
// project-graph.ts to keep the class body under the per-file line cap.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { resolveIgnoredDirs } from "./structure/extractors/skip-dirs.js";

export const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	".nuxt",
	"coverage",
	".wrangler",
	".cache",
	".turbo",
	"out",
	".interlinked",
	".claude",
	".entire",
	"__pycache__",
	".vscode",
	".idea",
	"reference-repos",
	"vendor",
	"third_party",
	"third-party",
	"external",
	".venv",
	"venv",
	"target",
	".gradle",
	".svelte-kit",
	".output",
	// Tool sandboxes and caches. `.stryker-tmp` matters most: the mutation
	// engine copies the ENTIRE tree into `.stryker-tmp/sandbox-*/`, so leaving it
	// in multiplied this repo's graph 32119 nodes / 81050 edges against a real
	// 2934 / 6680 — a 45s walk, and every symbol appeared to be duplicately
	// exported by its own sandbox copy. A sandbox is a transient mirror of files
	// already in the graph; it is never the source of truth.
	".stryker-tmp",
	".nyc_output",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".tox",
	".parcel-cache",
	".vite",
	".astro",
]);

export const TS_JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** Root-local agent scratch is deliberately outside the shipped dependency
 * graph. Its `.gitignore` has a README carve-out, so Git cannot collapse the
 * directory to a single ignored marker even when it contains thousands of
 * generated source probes. Keep this path-specific: a real `src/scratch/`
 * package remains ordinary project source. */
const ROOT_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set(["scratch"]);

/** One file discovered by `scanProjectFiles`, with its resolved nearest
 * project boundary (dir with tsconfig.json or package.json). */
export interface ScannedFile {
	file: string;
	boundary: string;
}

interface WalkState {
	dir: string;
	result: ScannedFile[];
	depth: number;
	currentBoundary?: string;
	ignoredDirs: ReadonlySet<string>;
	projectRoot: string;
}

/**
 * Project boundary that applies to `dir`: the directory itself when it carries
 * its own tsconfig.json or package.json, otherwise the inherited boundary (or
 * the project root, which is always the default boundary).
 */
function boundaryForDir(dir: string, currentBoundary: string | undefined, projectRoot: string): string {
	const inherited = currentBoundary ?? projectRoot;
	if (dir === projectRoot) return inherited;
	const hasTsconfig = existsSync(join(dir, "tsconfig.json"));
	const hasPackageJson = existsSync(join(dir, "package.json"));
	return hasTsconfig || hasPackageJson ? dir : inherited;
}

/** True when a subdirectory of `state.dir` is excluded from the scan: a
 * `SKIP_DIRS` name, root-local `scratch/`, or a `resolveIgnoredDirs` entry. */
function isSkippedScanDir(entryName: string, fullPath: string, state: WalkState): boolean {
	const isRootScratch = state.dir === state.projectRoot && ROOT_SCAN_SKIP_DIRS.has(entryName);
	return SKIP_DIRS.has(entryName) || isRootScratch || state.ignoredDirs.has(fullPath);
}

function walkDir(state: WalkState): void {
	const { dir, result, depth, currentBoundary, ignoredDirs, projectRoot } = state;
	if (depth > 20) return; // Safety limit
	try {
		const boundary = boundaryForDir(dir, currentBoundary, projectRoot);

		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (isSkippedScanDir(entry.name, fullPath, state)) continue;
				walkDir({
					dir: fullPath,
					result,
					depth: depth + 1,
					currentBoundary: boundary,
					ignoredDirs,
					projectRoot,
				});
				continue;
			}
			if (entry.isFile() && TS_JS_EXTENSIONS.has(extname(entry.name))) {
				result.push({ file: fullPath, boundary });
			}
		}
	} catch (err) {
		void err; /* intentional: directory not readable — skip */
	}
}

/**
 * Walk the project tree rooted at `projectRoot`, collecting every TS/JS
 * source file along with its nearest project boundary. Skips `SKIP_DIRS`,
 * root-local `scratch/`, and any directory `resolveIgnoredDirs` reports.
 */
export function scanProjectFiles(projectRoot: string): ScannedFile[] {
	const result: ScannedFile[] = [];
	walkDir({
		dir: projectRoot,
		result,
		depth: 0,
		ignoredDirs: resolveIgnoredDirs(projectRoot),
		projectRoot,
	});
	return result;
}

/**
 * Load `compilerOptions.paths` from `<projectRoot>/tsconfig.json`, if the
 * file exists and its `paths` value is a well-formed string-array map.
 * Returns `undefined` on any parse failure or malformed shape.
 */
export function loadTsconfigPathsFor(projectRoot: string): Record<string, string[]> | undefined {
	try {
		const tsconfigPath = join(projectRoot, "tsconfig.json");
		if (!existsSync(tsconfigPath)) return undefined;

		const raw = readFileSync(tsconfigPath, "utf-8");
		// Strip single-line comments (tsconfig allows them)
		const cleaned = raw.replace(/\/\/.*$/gm, "");
		const config: unknown = JSON.parse(cleaned);
		const paths = isJsonObject(config) && isJsonObject(config.compilerOptions) ? config.compilerOptions.paths : undefined;
		if (isJsonObject(paths) && Object.values(paths).every((t) => Array.isArray(t) && t.every((s): s is string => typeof s === "string"))) {
			return paths as Record<string, string[]>;
		}
		return undefined;
	} catch (err) {
		void err; /* intentional: can't parse tsconfig — skip path alias support */
		return undefined;
	}
}
