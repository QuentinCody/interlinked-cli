// ===========================================
// Project Graph — Import/Export Indexing Engine
// ===========================================
// Maintains an in-memory graph of TypeScript/JavaScript import and export
// relationships. Updated incrementally on each file edit. Enables fast
// dependency-aware checks without running tsc.
//
// Design goals:
//   - Regex-based parsing (no AST library dependency, sub-10ms per file)
//   - Incremental updates (only re-parse edited files, ~5ms per file)
//   - Cross-agent awareness via SessionTracker integration

import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { nonNull } from "../lib/non-null.js";
import { extractInterfaceBodies } from "./project-graph/interface-bodies.js";
import { parseExports } from "./project-graph/parser-exports.js";
import { parseImports } from "./project-graph/parser-imports.js";
import { resolveImportPath } from "./project-graph/resolve.js";
import { findCyclesThroughGraph } from "./project-graph-cycles.js";
import { computeReachabilityVerdict } from "./project-graph-reachability.js";
import { loadTsconfigPathsFor, scanProjectFiles, TS_JS_EXTENSIONS } from "./project-graph-scan.js";
import type {
	ExportedSymbol,
	ImportEdge,
	ModuleRole,
	ReachabilityVerdict,
} from "./types.js";

// Re-export the extracted helpers so existing call sites that import them
// from project-graph.ts continue to work without updating their specifier.
export { parseExports } from "./project-graph/parser-exports.js";
export { parseImports } from "./project-graph/parser-imports.js";
export { resolveImportPath } from "./project-graph/resolve.js";
export { SKIP_DIRS, TS_JS_EXTENSIONS } from "./project-graph-scan.js";

// ===========================================
// Project Graph
// ===========================================

export class ProjectGraph {
	/** file → exported symbols */
	private exportIndex: Map<string, ExportedSymbol[]> = new Map();
	/** file → import edges from this file */
	private importGraph: Map<string, ImportEdge[]> = new Map();
	/** file → files that import from this file (reverse lookup) */
	private reverseGraph: Map<string, Set<string>> = new Map();
	/** file → interface/type body text (for change detection) */
	private interfaceBodies: Map<string, Map<string, string>> = new Map();
	/** file → nearest project root (dir with tsconfig.json or package.json) */
	private projectBoundaries: Map<string, string> = new Map();
	/** file → resolved targets of `export * from '...'` statements */
	private starReExports: Map<string, string[]> = new Map();

	private projectRoot: string;
	private initialized = false;
	private tsconfigPaths: Record<string, string[]> | undefined;
	/**
	 * Memo for `isFileReachableFromEntryPoints`.
	 *
	 * Direction choice (Phase A2): backward BFS from `file` along
	 * `reverseGraph`. The runtime control flow is
	 * `entryPoint → A → B → file`, encoded forward in `importGraph`.
	 * We could BFS forward from every entry point looking for `file`,
	 * but the public API is single-target — one `file`, possibly many
	 * entry points — so walking ancestors of `file` (via `reverseGraph`)
	 * visits each candidate exactly once regardless of how many
	 * entry points the caller passes. This keeps the memo key tight
	 * (`file + entry-point-set-hash`) and skips re-expansion of the
	 * shared upstream subgraph.
	 *
	 * Key shape: `${file}|${sha-ish-hash-of-sorted-entry-points}`. Value
	 * is the cached verdict. Cleared per-file inside `updateFile()`
	 * (the only mutation path) and as a whole if the dirty set grows.
	 */
	private reachabilityMemo: Map<string, ReachabilityVerdict> = new Map();

	constructor(projectRoot: string) {
		this.projectRoot = resolve(projectRoot);
		this.tsconfigPaths = loadTsconfigPathsFor(this.projectRoot);
	}

	// --- Public API ---

	/** Whether the graph has been initialized via full scan */
	get isInitialized(): boolean {
		return this.initialized;
	}

	/** Number of files in the graph */
	get fileCount(): number {
		return this.exportIndex.size;
	}

	/**
	 * Full project scan. Call once on startup (or lazily on first check).
	 * Typically takes 500ms-2s for a 500-file project.
	 */
	initialize(): void {
		if (this.initialized) return;
		const files = scanProjectFiles(this.projectRoot);
		for (const { file, boundary } of files) {
			this.projectBoundaries.set(file, boundary);
			this.indexFile(file);
		}
		this.initialized = true;
	}

	/**
	 * Re-index a single file after it was edited.
	 * Returns the old exports for comparison.
	 */
	updateFile(filePath: string, content?: string): ExportedSymbol[] {
		const absPath = this.toAbsolute(filePath);
		const oldExports = this.exportIndex.get(absPath) || [];
		this.indexFile(absPath, content);
		// Any edit can mutate the import edges and thereby change which
		// files are reachable from which entry points. Reachability memo
		// is a function of graph topology, so a single edit invalidates
		// every cached verdict.
		this.reachabilityMemo.clear();
		return oldExports;
	}

	/** Get exports for a file, following `export *` re-exports */
	getExports(filePath: string, visited?: Set<string>): ExportedSymbol[] {
		const absPath = this.toAbsolute(filePath);
		const direct = this.exportIndex.get(absPath) || [];
		const starTargets = this.starReExports.get(absPath);
		if (!starTargets || starTargets.length === 0) return direct;

		// Follow export * chains (with cycle protection)
		const seen = visited ?? new Set<string>();
		if (seen.has(absPath)) return direct;
		seen.add(absPath);

		const result = direct.filter((e) => !(e.name === "*" && e.kind === "namespace"));
		for (const target of starTargets) {
			const targetExports = this.getExports(target, seen);
			for (const exp of targetExports) {
				if (exp.name !== "*" && !result.some((e) => e.name === exp.name)) {
					result.push(exp);
				}
			}
		}
		return result;
	}

	/** Get files that import from the given file (dependents/reverse dependencies) */
	getDependents(filePath: string): string[] {
		const absPath = this.toAbsolute(filePath);
		const deps = this.reverseGraph.get(absPath);
		return deps ? [...deps] : [];
	}

	/**
	 * Whether `filePath` was indexed into the graph (an existing project source
	 * file). Distinct from "has dependents" — a leaf module with zero importers is
	 * still in the graph. Lets a caller tell "unknown file" (not indexed) apart
	 * from "known file, no dependents", which the affected-test selector needs to
	 * choose between full-suite fallback and a strict-TDD block.
	 */
	hasFile(filePath: string): boolean {
		return this.exportIndex.has(this.toAbsolute(filePath));
	}

	/**
	 * Is `file` reachable from any of `entryPoints` via the import graph?
	 *
	 * "Reachable" = a chain `e → A → B → ... → file` exists where every
	 * arrow is a static import edge captured in `importGraph`. The
	 * implementation walks the chain backwards via `reverseGraph`
	 * starting from `file` — see the comment on `reachabilityMemo` for
	 * why backward (one BFS per file, regardless of entry-point count).
	 *
	 * Behavior:
	 * - Depth-capped at `REACHABILITY_DEPTH_CAP`. Hitting the cap returns
	 *   `reachable: false` with no `distance`/`path` and emits a stderr
	 *   note when `INTERLINKED_VERBOSE=1`.
	 * - Cycle-safe (visited set).
	 * - Self-reachability: if `file` is itself one of `entryPoints`, the
	 *   verdict is `reachable: true, distance: 0, path: [file]`.
	 * - Memoized per `(file, sorted-entry-point-set)`. The memo is
	 *   invalidated on every `updateFile()` call.
	 * - Pure read over the already-initialized graph; never triggers a
	 *   graph rebuild.
	 */
	isFileReachableFromEntryPoints(file: string, entryPoints: string[]): ReachabilityVerdict {
		const target = this.toAbsolute(file);
		const entryAbs = entryPoints.map((p) => this.toAbsolute(p));

		// Self-reachability shortcut: if the target is an entry point.
		const entrySet = new Set(entryAbs);
		if (entrySet.has(target)) {
			return {
				reachable: true,
				distance: 0,
				path: [target],
				entry_points_considered: [...entryAbs],
			};
		}

		const memoKey = `${target}|${[...entrySet].sort().join("|")}`;
		const cached = this.reachabilityMemo.get(memoKey);
		if (cached) return cached;

		const verdict = computeReachabilityVerdict(target, entryAbs, this.reverseGraph, (p) =>
			this.toRelative(p),
		);
		this.reachabilityMemo.set(memoKey, verdict);
		return verdict;
	}

	/** Get files that this file imports from (dependencies) */
	getDependencies(filePath: string): ImportEdge[] {
		return this.importGraph.get(this.toAbsolute(filePath)) || [];
	}

	/** Get import edges pointing to a file */
	getImporters(filePath: string): ImportEdge[] {
		const absPath = this.toAbsolute(filePath);
		const dependents = this.reverseGraph.get(absPath);
		if (!dependents) return [];

		const edges: ImportEdge[] = [];
		for (const depFile of dependents) {
			const imports = this.importGraph.get(depFile) || [];
			for (const edge of imports) {
				if (edge.toFile === absPath) {
					edges.push(edge);
				}
			}
		}
		return edges;
	}

	/**
	 * Find files that export a symbol with the given name.
	 * When `boundary` is provided, only return duplicates from files within
	 * the same project boundary — prevents false positives across independent sub-projects.
	 */
	findDuplicateExports(symbolName: string, excludeFile?: string, boundary?: string): string[] {
		const excludeAbs = excludeFile ? this.toAbsolute(excludeFile) : null;
		const files: string[] = [];
		for (const [file, exports] of this.exportIndex) {
			if (file === excludeAbs) continue;
			if (boundary && this.getProjectBoundary(file) !== boundary) continue;
			if (exports.some((e) => e.name === symbolName && !e.isTypeOnly)) {
				files.push(file);
			}
		}
		return files;
	}

	/**
	 * Detect import cycles involving the given file.
	 * Returns arrays of file paths forming each cycle, or empty if none.
	 */
	findCyclesThrough(filePath: string): string[][] {
		return findCyclesThroughGraph(this.toAbsolute(filePath), this.importGraph);
	}

	/** Get previous interface/type bodies for a file (for change comparison) */
	getInterfaceBodies(filePath: string): Map<string, string> {
		return this.interfaceBodies.get(this.toAbsolute(filePath)) || new Map();
	}

	/** List files in the same directory as the given file */
	getSiblingFiles(filePath: string): string[] {
		const absPath = this.toAbsolute(filePath);
		const dir = dirname(absPath);
		try {
			return readdirSync(dir)
				.sort()
				.filter((name) => {
					const ext = extname(name);
					return TS_JS_EXTENSIONS.has(ext) && join(dir, name) !== absPath;
				})
				.map((name) => join(dir, name));
		} catch {
			return [];
		}
	}

	/**
	 * Classify a file's role in the dependency graph.
	 * - "hub": 5+ dependents (high connectivity, edits have wide blast radius)
	 * - "root": 1+ dependents but no project imports (purely depended upon, e.g. constants/types)
	 * - "internal": 1-4 dependents (normal module)
	 * - "leaf": 0 dependents (end of dependency chain, standalone/unused)
	 */
	classifyModule(filePath: string): ModuleRole {
		const absPath = this.toAbsolute(filePath);
		const dependents = this.reverseGraph.get(absPath);
		const dependentCount = dependents ? dependents.size : 0;
		const dependencies = this.importGraph.get(absPath) || [];
		// Only count project-internal dependencies (those with resolved toFile)
		const hasProjectImports = dependencies.some((e) => e.toFile !== "");

		if (dependentCount >= 5) return "hub";
		if (dependentCount >= 1 && !hasProjectImports) return "root";
		if (dependentCount >= 1) return "internal";
		return "leaf";
	}

	/** Get the project boundary (nearest sub-project root) for a file */
	getProjectBoundary(filePath: string): string {
		const absPath = this.toAbsolute(filePath);
		return this.projectBoundaries.get(absPath) ?? this.projectRoot;
	}

	/** Get all indexed file paths */
	allFiles(): string[] {
		return [...this.exportIndex.keys()];
	}

	/** Convert to project-relative path for display */
	toRelative(filePath: string): string {
		const abs = this.toAbsolute(filePath);
		return relative(this.projectRoot, abs);
	}

	// --- Internal ---

	private toAbsolute(filePath: string): string {
		return isAbsolute(filePath) ? filePath : resolve(this.projectRoot, filePath);
	}

	private collectStarReExportTargets(
		fileContent: string,
		exports: ReturnType<typeof parseExports>,
		absPath: string,
	): string[] {
		const starTargets: string[] = [];
		for (const exp of exports) {
			if (exp.name === "*" && exp.kind === "namespace") {
				// Find the source specifier from the file content
				const starRe = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
				for (let m = starRe.exec(fileContent); m !== null; m = starRe.exec(fileContent)) {
					const resolved = resolveImportPath(absPath, nonNull(m[1]), this.tsconfigPaths);
					if (resolved) starTargets.push(resolved);
				}
				break; // Only need to scan once
			}
		}
		return starTargets;
	}

	private indexFile(absPath: string, content?: string): void {
		let fileContent: string;
		if (content) {
			fileContent = content;
		} else {
			try {
				fileContent = readFileSync(absPath, "utf-8");
			} catch {
				return; // File not readable
			}
		}

		// Remove old reverse edges from this file
		const oldEdges = this.importGraph.get(absPath) || [];
		for (const edge of oldEdges) {
			if (edge.toFile) {
				this.reverseGraph.get(edge.toFile)?.delete(absPath);
			}
		}

		// Parse exports
		const exports = parseExports(fileContent);
		this.exportIndex.set(absPath, exports);

		// Track `export * from '...'` targets for transitive resolution
		const starTargets = this.collectStarReExportTargets(fileContent, exports, absPath);
		this.starReExports.set(absPath, starTargets);

		// Parse imports and resolve paths
		const rawImports = parseImports(fileContent, absPath);
		const resolvedImports: ImportEdge[] = [];
		for (const raw of rawImports) {
			const toFile = resolveImportPath(absPath, raw.specifier, this.tsconfigPaths);
			resolvedImports.push({ ...raw, toFile: toFile || "" });

			// Update reverse graph
			if (toFile) {
				let set = this.reverseGraph.get(toFile);
				if (!set) {
					set = new Set();
					this.reverseGraph.set(toFile, set);
				}
				set.add(absPath);
			}
		}
		this.importGraph.set(absPath, resolvedImports);

		// Extract interface bodies for change detection
		this.interfaceBodies.set(absPath, extractInterfaceBodies(fileContent));
	}

}
