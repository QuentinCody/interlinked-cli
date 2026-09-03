// Supplementary behavioral coverage for src/harness/project-graph.ts.
//
// The existing project-graph.test.ts exercises the parser helpers and
// transitive `export *` resolution. This file targets the remaining
// uncovered ProjectGraph branches: the full scan (initialize/walkDir),
// the reachability BFS (self-hit, memo hit, path reconstruction, depth
// cap, verbose note, unreachable), the cache-like incremental refresh of
// reverse edges in updateFile, import resolution edge cases, tsconfig
// path-alias loading, and the various read-only accessors.
//
// node:fs is mocked here with a controllable in-memory filesystem that
// also supports directory listings (Dirent-shaped entries) so walkDir can
// be driven through its branches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory filesystem mock for node:fs
// ---------------------------------------------------------------------------
// fileContents: absolute path -> file text
// dirEntries: absolute dir -> array of child descriptors. `dir` marks a
// subdirectory; `other` marks an entry that is neither a file nor a
// directory (e.g. a symlink/socket) for the walkDir non-file/non-dir branch.
interface ChildEntry {
	name: string;
	dir: boolean;
	other?: boolean;
}
const fileContents = new Map<string, string>();
const dirEntries = new Map<string, ChildEntry[]>();

interface DirentLike {
	name: string;
	isDirectory: () => boolean;
	isFile: () => boolean;
}

vi.mock("node:fs", () => ({
	existsSync: vi.fn((p: string) => fileContents.has(p) || dirEntries.has(p)),
	statSync: vi.fn((p: string) => {
		if (fileContents.has(p)) {
			return { isFile: () => true, isDirectory: () => false };
		}
		if (dirEntries.has(p)) {
			return { isFile: () => false, isDirectory: () => true };
		}
		throw new Error(`ENOENT: ${p}`);
	}),
	readFileSync: vi.fn((p: string) => {
		const content = fileContents.get(p);
		if (content !== undefined) return content;
		throw new Error(`ENOENT: ${p}`);
	}),
	readdirSync: vi.fn((p: string, opts?: { withFileTypes?: boolean }) => {
		const entries = dirEntries.get(p);
		if (!entries) throw new Error(`ENOTDIR: ${p}`);
		if (opts?.withFileTypes) {
			return entries.map(
				(e): DirentLike => ({
					name: e.name,
					isDirectory: () => e.dir,
					// `other` entries are neither file nor directory.
					isFile: () => !e.dir && e.other !== true,
				}),
			);
		}
		return entries.map((e) => e.name);
	}),
}));

import { nonNull } from "../lib/non-null.js";
import { ProjectGraph } from "./project-graph.js";
import { REACHABILITY_DEPTH_CAP } from "./project-graph-reachability.js";

function resetFs(): void {
	fileContents.clear();
	dirEntries.clear();
}

/** Register a file in the in-memory FS. */
function addFile(path: string, content: string): void {
	fileContents.set(path, content);
}

/** Register a directory listing in the in-memory FS. */
function addDir(path: string, children: ChildEntry[]): void {
	dirEntries.set(path, children);
}

beforeEach(() => {
	resetFs();
});

afterEach(() => {
	delete process.env.INTERLINKED_VERBOSE;
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// constructor + loadTsconfigPaths
// ---------------------------------------------------------------------------
describe("ProjectGraph constructor / loadTsconfigPaths", () => {
	it("loads path aliases from tsconfig.json (comments stripped) and resolves them", () => {
		// tsconfig with a // comment and a compilerOptions.paths block.
		// A no-glob alias keeps `rest` empty so the candidate is
		// resolve(dirname/.. , target) = /proj/src/app.ts (a leading-slash
		// `rest` from a /* glob would reset path.resolve to root — that
		// glob path is covered by the miss case below).
		addFile(
			"/proj/tsconfig.json",
			[
				"{",
				"  // a comment line tsconfig allows",
				'  "compilerOptions": {',
				'    "paths": { "@root": ["./src/app.ts"] }',
				"  }",
				"}",
			].join("\n"),
		);
		addFile("/proj/src/app.ts", "export const x = 1;");
		addFile("/proj/src/index.ts", `import { x } from '@root';`);

		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/src/index.ts");

		const deps = graph.getDependencies("/proj/src/index.ts");
		expect(deps).toHaveLength(1);
		expect(nonNull(deps[0]).toFile).toBe("/proj/src/app.ts");
	});

	it("falls through to null when an aliased specifier resolves to nothing", () => {
		// A /* glob alias whose computed candidate has no file on disk: the
		// inner tryResolveFile returns null, the alias loop exhausts, and
		// resolveImportPath returns null -> toFile === "".
		addFile(
			"/proj/tsconfig.json",
			'{ "compilerOptions": { "paths": { "@app/*": ["./src/*"] } } }',
		);
		addFile("/proj/src/index.ts", `import { gone } from '@app/does-not-exist';`);
		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/src/index.ts");
		expect(nonNull(graph.getDependencies("/proj/src/index.ts")[0]).toFile).toBe("");
	});

	it("leaves a bare specifier unresolved when it matches no alias prefix", () => {
		// paths exist but the specifier doesn't start with any alias pattern,
		// so the `specifier.startsWith(pattern)` guard is false for every entry
		// and the function returns null.
		addFile(
			"/proj/tsconfig.json",
			'{ "compilerOptions": { "paths": { "@app/*": ["./src/*"] } } }',
		);
		addFile("/proj/index.ts", `import { z } from 'unrelated-pkg';`);
		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/index.ts");
		expect(nonNull(graph.getDependencies("/proj/index.ts")[0]).toFile).toBe("");
	});

	it("ignores tsconfig with no compilerOptions.paths", () => {
		addFile("/proj/tsconfig.json", '{ "compilerOptions": { "strict": true } }');
		const graph = new ProjectGraph("/proj");
		// A bare specifier with no alias config stays unresolved.
		graph.updateFile("/proj/a.ts", `import { y } from 'some-lib';`);
		expect(nonNull(graph.getDependencies("/proj/a.ts")[0]).toFile).toBe("");
	});

	it("swallows a malformed tsconfig.json without throwing", () => {
		addFile("/proj/tsconfig.json", "{ this is not valid json ");
		// Must not throw in the constructor.
		expect(() => new ProjectGraph("/proj")).not.toThrow();
	});

	it("is a no-op when tsconfig.json does not exist", () => {
		const graph = new ProjectGraph("/proj");
		expect(graph.isInitialized).toBe(false);
	});

	it("N1: a malformed alias target no longer crashes indexing", () => {
		// Pre-fix, `paths` was cast to Record<string, string[]> with zero runtime
		// validation, so a target that isn't actually a string (here `42`) reached
		// `target.replace("/*", "")` inside resolveImportPath and threw
		// `TypeError: target.replace is not a function` — uncaught, since
		// indexFile has no try/catch around resolveImportPath (only
		// loadTsconfigPaths itself is wrapped, and this throw happens later, on
		// the next file indexed). The fix rejects the whole paths map at load
		// time instead of trusting the cast.
		addFile("/proj/tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@bad/*": [42] } } }));
		addFile("/proj/src/index.ts", `import { x } from '@bad/thing';`);
		const graph = new ProjectGraph("/proj");
		expect(() => graph.updateFile("/proj/src/index.ts")).not.toThrow();
		expect(nonNull(graph.getDependencies("/proj/src/index.ts")[0]).toFile).toBe("");
	});

	it("N2: ignores a non-object paths field instead of reading fields off it", () => {
		addFile("/proj/tsconfig.json", JSON.stringify({ compilerOptions: { paths: "not-an-object" } }));
		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/a.ts", `import { y } from 'some-lib';`);
		expect(nonNull(graph.getDependencies("/proj/a.ts")[0]).toFile).toBe("");
	});

	it("N3: ignores a non-object compilerOptions field instead of reading fields off it", () => {
		addFile("/proj/tsconfig.json", JSON.stringify({ compilerOptions: "not-an-object" }));
		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/a.ts", `import { y } from 'some-lib';`);
		expect(nonNull(graph.getDependencies("/proj/a.ts")[0]).toFile).toBe("");
	});

	it("N4: a top-level `null` tsconfig.json is rejected without relying on the outer catch", () => {
		// Pre-fix, `config.compilerOptions` had no `?.` on `config` itself, so a
		// legally-parsed `null` (JSON.parse("null") === null) would throw
		// reading `.compilerOptions` off null — only saved by the surrounding
		// try/catch happening to catch it too. The fix rejects `null` explicitly
		// via isJsonObject before any property access.
		addFile("/proj/tsconfig.json", "null");
		const graph = new ProjectGraph("/proj");
		expect(() => graph.updateFile("/proj/a.ts", `import { y } from 'some-lib';`)).not.toThrow();
		expect(nonNull(graph.getDependencies("/proj/a.ts")[0]).toFile).toBe("");
	});

	it("P1: accepts an alias with multiple valid string targets", () => {
		addFile(
			"/proj/tsconfig.json",
			JSON.stringify({
				compilerOptions: { paths: { "@root": ["./src/app.ts", "./src/other.ts"] } },
			}),
		);
		addFile("/proj/src/app.ts", "export const x = 1;");
		addFile("/proj/src/index.ts", `import { x } from '@root';`);
		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/src/index.ts");
		expect(nonNull(graph.getDependencies("/proj/src/index.ts")[0]).toFile).toBe("/proj/src/app.ts");
	});
});

// ---------------------------------------------------------------------------
// initialize() + scanProjectFiles + walkDir
// ---------------------------------------------------------------------------
describe("ProjectGraph.initialize / walkDir", () => {
	it("scans the tree, indexes ts/js files, and sets project boundaries", () => {
		// Tree:
		//   /root/
		//     a.ts                 (boundary = root)
		//     README.md            (skipped, not ts/js)
		//     node_modules/        (skipped dir)
		//     pkg/                 (has package.json -> sub-boundary)
		//       package.json
		//       b.ts
		addDir("/root", [
			{ name: "a.ts", dir: false },
			{ name: "README.md", dir: false },
			{ name: "node_modules", dir: true },
			{ name: "pkg", dir: true },
		]);
		addDir("/root/node_modules", [{ name: "lib.ts", dir: false }]);
		addDir("/root/pkg", [
			{ name: "package.json", dir: false },
			{ name: "b.ts", dir: false },
		]);
		addFile("/root/a.ts", "export const a = 1;");
		addFile("/root/README.md", "# readme");
		addFile("/root/node_modules/lib.ts", "export const skipme = 1;");
		// package.json marks /root/pkg as a sub-project boundary.
		addFile("/root/pkg/package.json", "{}");
		addFile("/root/pkg/b.ts", "export const b = 2;");

		const graph = new ProjectGraph("/root");
		graph.initialize();

		expect(graph.isInitialized).toBe(true);
		const files = graph.allFiles().sort();
		expect(files).toEqual(["/root/a.ts", "/root/pkg/b.ts"]);
		// node_modules content must not be indexed.
		expect(files).not.toContain("/root/node_modules/lib.ts");
		// Boundary: a.ts -> root, b.ts -> the pkg sub-project.
		expect(graph.getProjectBoundary("/root/a.ts")).toBe("/root");
		expect(graph.getProjectBoundary("/root/pkg/b.ts")).toBe("/root/pkg");
		expect(graph.fileCount).toBe(2);
	});

	it("treats a directory with tsconfig.json as a sub-project boundary", () => {
		addDir("/root", [{ name: "sub", dir: true }]);
		addDir("/root/sub", [
			{ name: "tsconfig.json", dir: false },
			{ name: "c.ts", dir: false },
		]);
		addFile("/root/sub/tsconfig.json", "{}");
		addFile("/root/sub/c.ts", "export const c = 3;");

		const graph = new ProjectGraph("/root");
		graph.initialize();
		expect(graph.getProjectBoundary("/root/sub/c.ts")).toBe("/root/sub");
	});

	it("initialize() is idempotent (second call is a no-op)", () => {
		addDir("/root", [{ name: "a.ts", dir: false }]);
		addFile("/root/a.ts", "export const a = 1;");

		const graph = new ProjectGraph("/root");
		graph.initialize();
		const first = graph.fileCount;
		// Mutate the FS, then call again — the guard should prevent a rescan.
		addDir("/root", [
			{ name: "a.ts", dir: false },
			{ name: "extra.ts", dir: false },
		]);
		addFile("/root/extra.ts", "export const e = 1;");
		graph.initialize();
		expect(graph.fileCount).toBe(first);
	});

	it("skips dot-prefixed skip dirs and tolerates an unreadable directory", () => {
		// /root has a normal dir and the .git skip dir. The .git subtree is
		// never traversed; a missing/unreadable child dir is swallowed.
		addDir("/root", [
			{ name: ".git", dir: true },
			{ name: "ghost", dir: true }, // declared as a dir but no listing -> readdir throws
			{ name: "real.ts", dir: false },
		]);
		addFile("/root/real.ts", "export const r = 1;");
		// Note: no addDir for /root/.git or /root/ghost -> readdirSync throws,
		// exercising the catch in walkDir.

		const graph = new ProjectGraph("/root");
		graph.initialize();
		expect(graph.allFiles()).toEqual(["/root/real.ts"]);
	});

	it("ignores directory entries that are neither file nor directory", () => {
		// A socket/symlink-like dirent (isDirectory()=false, isFile()=false)
		// must be skipped — exercises the `else if (entry.isFile())` false branch.
		addDir("/root", [
			{ name: "sock", dir: false, other: true },
			{ name: "real.ts", dir: false },
		]);
		addFile("/root/real.ts", "export const r = 1;");
		const graph = new ProjectGraph("/root");
		graph.initialize();
		expect(graph.allFiles()).toEqual(["/root/real.ts"]);
	});

	it("respects the walkDir depth safety limit", () => {
		// Build a chain deeper than the depth cap (20). Each level has one
		// child dir plus a .ts file; files beyond depth 20 must be dropped.
		const depth = 24;
		for (let i = 0; i <= depth; i++) {
			const dirPath = i === 0 ? "/deep" : `/deep${"/d".repeat(i)}`;
			const childDir = `/deep${"/d".repeat(i + 1)}`;
			const fileName = `f${i}.ts`;
			addDir(dirPath, [
				{ name: "d", dir: true },
				{ name: fileName, dir: false },
			]);
			addFile(`${dirPath}/${fileName}`, `export const v${i} = ${i};`);
			void childDir;
		}

		const graph = new ProjectGraph("/deep");
		graph.initialize();
		// f0..f20 are at depths 0..20 and indexed; deeper ones are cut off.
		const files = graph.allFiles();
		expect(files).toContain("/deep/f0.ts");
		// A file at depth 21+ must be excluded by the depth>20 guard.
		expect(files.some((f) => f.endsWith("f24.ts"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// updateFile incremental reverse-edge maintenance + indexFile content path
// ---------------------------------------------------------------------------
describe("ProjectGraph.updateFile / indexFile", () => {
	it("returns prior exports and removes stale reverse edges on re-index", () => {
		addFile("/p/target.ts", "export const t = 1;");
		addFile("/p/dep.ts", "export const d = 1;");
		// First version of a.ts imports from target.ts.
		addFile("/p/a.ts", `import { t } from './target';`);

		const graph = new ProjectGraph("/p");
		const prevEmpty = graph.updateFile("/p/a.ts");
		expect(prevEmpty).toEqual([]); // no prior exports for a.ts
		expect(graph.getDependents("/p/target.ts")).toContain("/p/a.ts");

		// Re-index a.ts with content that no longer imports target.ts but adds
		// an export — exercises the old-edge removal branch + oldExports return.
		const oldExports = graph.updateFile(
			"/p/a.ts",
			["export const newSym = 1;", `import { d } from './dep';`].join("\n"),
		);
		// The previous a.ts had no exports.
		expect(oldExports).toEqual([]);
		// Stale reverse edge to target.ts must be gone; dep.ts now has one.
		expect(graph.getDependents("/p/target.ts")).not.toContain("/p/a.ts");
		expect(graph.getDependents("/p/dep.ts")).toContain("/p/a.ts");
		// And the new export is now indexed.
		expect(graph.getExports("/p/a.ts").map((e) => e.name)).toContain("newSym");
	});

	it("returns [] and indexes nothing when the file is unreadable and no content given", () => {
		const graph = new ProjectGraph("/p");
		// /p/missing.ts is not in the FS and no content arg -> readFileSync throws,
		// indexFile returns early, exportIndex never gets a key.
		const old = graph.updateFile("/p/missing.ts");
		expect(old).toEqual([]);
		expect(graph.allFiles()).not.toContain("/p/missing.ts");
		expect(graph.getExports("/p/missing.ts")).toEqual([]);
	});

	it("resolves star re-export targets and follows them through getExports", () => {
		addFile("/p/base.ts", "export const base1 = 1;\nexport const base2 = 2;");
		addFile("/p/idx.ts", `export * from './base';`);

		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/base.ts");
		graph.updateFile("/p/idx.ts");

		const names = graph.getExports("/p/idx.ts").map((e) => e.name);
		expect(names).toContain("base1");
		expect(names).toContain("base2");
	});

	it("records an empty star-target list when `export *` cannot resolve", () => {
		// `export * from './nope'` where ./nope does not exist -> resolveImportPath
		// returns null, so starTargets stays empty and getExports falls through to
		// the `!starTargets || length===0` direct-only return.
		addFile("/p/idx.ts", `export * from './nope';\nexport const own = 1;`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/idx.ts");
		const names = graph.getExports("/p/idx.ts").map((e) => e.name);
		// The unresolved star contributes nothing; only the direct export remains
		// (the synthetic "*" namespace entry is filtered out only when there are
		// star targets, so here direct includes "*"). Assert the real symbol.
		expect(names).toContain("own");
	});

	it("re-indexes a file whose prior version had an unresolved import edge", () => {
		// First index: a.ts imports a bare (unresolvable) package -> the stored
		// edge has toFile === "". Re-indexing iterates oldEdges and hits the
		// `if (edge.toFile)` false branch for that empty edge.
		addFile("/p/a.ts", `import { x } from 'bare-pkg';\nexport const a = 1;`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/a.ts");
		expect(nonNull(graph.getDependencies("/p/a.ts")[0]).toFile).toBe("");
		// Re-index with different content; must not throw on the empty old edge.
		const old = graph.updateFile("/p/a.ts", "export const a = 2;");
		expect(old.map((e) => e.name)).toEqual(["a"]);
		expect(graph.getDependencies("/p/a.ts")).toEqual([]);
	});

	it("uses provided content verbatim over reading from disk", () => {
		// FS has one version; content arg overrides it.
		addFile("/p/x.ts", "export const fromDisk = 1;");
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/x.ts", "export const fromArg = 2;");
		const names = graph.getExports("/p/x.ts").map((e) => e.name);
		expect(names).toEqual(["fromArg"]);
		expect(names).not.toContain("fromDisk");
	});
});

// ---------------------------------------------------------------------------
// getExports cycle/visited guard (direct-on-revisit branch)
// ---------------------------------------------------------------------------
describe("ProjectGraph.getExports visited guard", () => {
	it("returns direct exports when the file is already in the visited set", () => {
		addFile("/p/base.ts", "export const only = 1;");
		addFile("/p/idx.ts", `export * from './base';`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/base.ts");
		graph.updateFile("/p/idx.ts");

		// Pre-seed visited with idx.ts -> the seen.has(absPath) early-return
		// fires, yielding only the direct (filtered) exports of idx.ts, which
		// for a star-only file is empty.
		const visited = new Set<string>(["/p/idx.ts"]);
		const result = graph.getExports("/p/idx.ts", visited);
		// idx.ts has only the "*" namespace direct export, returned as-is here
		// (the filter only runs on the non-revisit path).
		expect(result.every((e) => e.name === "*")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// getDependents / getDependencies / getImporters
// ---------------------------------------------------------------------------
describe("ProjectGraph dependency accessors", () => {
	function buildAB(): ProjectGraph {
		addFile("/p/b.ts", "export const b = 1;");
		addFile("/p/a.ts", `import { b } from './b';`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/b.ts");
		graph.updateFile("/p/a.ts");
		return graph;
	}

	it("getDependents returns importers of a file and [] for none", () => {
		const graph = buildAB();
		expect(graph.getDependents("/p/b.ts")).toEqual(["/p/a.ts"]);
		expect(graph.getDependents("/p/a.ts")).toEqual([]);
	});

	it("getDependencies returns edges and [] for an unknown file", () => {
		const graph = buildAB();
		const deps = graph.getDependencies("/p/a.ts");
		expect(deps).toHaveLength(1);
		expect(nonNull(deps[0]).specifier).toBe("./b");
		expect(graph.getDependencies("/p/unknown.ts")).toEqual([]);
	});

	it("getImporters returns inbound edges and [] when there are no dependents", () => {
		const graph = buildAB();
		const importers = graph.getImporters("/p/b.ts");
		expect(importers).toHaveLength(1);
		expect(nonNull(importers[0]).fromFile).toBe("/p/a.ts");
		expect(nonNull(importers[0]).toFile).toBe("/p/b.ts");
		// a.ts has no dependents -> early [] return.
		expect(graph.getImporters("/p/a.ts")).toEqual([]);
	});

	it("getImporters filters edges that resolve elsewhere", () => {
		// c.ts depends on both b.ts and d.ts; getImporters(b) must only return
		// the b-targeting edge, exercising the `edge.toFile === absPath` filter
		// false branch.
		addFile("/p/b.ts", "export const b = 1;");
		addFile("/p/d.ts", "export const d = 1;");
		addFile("/p/c.ts", `import { b } from './b';\nimport { d } from './d';`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/b.ts");
		graph.updateFile("/p/d.ts");
		graph.updateFile("/p/c.ts");

		const importers = graph.getImporters("/p/b.ts");
		expect(importers).toHaveLength(1);
		expect(nonNull(importers[0]).toFile).toBe("/p/b.ts");
	});
});

// ---------------------------------------------------------------------------
// findDuplicateExports
// ---------------------------------------------------------------------------
describe("ProjectGraph.findDuplicateExports", () => {
	it("finds non-type duplicates and respects excludeFile", () => {
		addFile("/p/one.ts", "export const dup = 1;");
		addFile("/p/two.ts", "export const dup = 2;");
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/one.ts");
		graph.updateFile("/p/two.ts");

		// Without exclude: both files export `dup`.
		expect(graph.findDuplicateExports("dup").sort()).toEqual(["/p/one.ts", "/p/two.ts"]);
		// Excluding one.ts leaves only two.ts.
		expect(graph.findDuplicateExports("dup", "/p/one.ts")).toEqual(["/p/two.ts"]);
	});

	it("ignores type-only exports", () => {
		addFile("/p/t.ts", "export type Shape = { a: number };");
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/t.ts");
		// `Shape` is type-only -> the `!e.isTypeOnly` filter excludes it.
		expect(graph.findDuplicateExports("Shape")).toEqual([]);
	});

	it("filters by project boundary when provided", () => {
		// Two files exporting the same symbol live in different boundaries.
		// Scan walkDir so projectBoundaries is populated.
		addDir("/root", [
			{ name: "x.ts", dir: false },
			{ name: "sub", dir: true },
		]);
		addDir("/root/sub", [
			{ name: "package.json", dir: false },
			{ name: "y.ts", dir: false },
		]);
		addFile("/root/x.ts", "export const same = 1;");
		addFile("/root/sub/package.json", "{}");
		addFile("/root/sub/y.ts", "export const same = 2;");

		const graph = new ProjectGraph("/root");
		graph.initialize();

		// Boundary = /root: only x.ts qualifies (y.ts is in /root/sub boundary).
		expect(graph.findDuplicateExports("same", undefined, "/root")).toEqual(["/root/x.ts"]);
		// Boundary = /root/sub: only y.ts.
		expect(graph.findDuplicateExports("same", undefined, "/root/sub")).toEqual([
			"/root/sub/y.ts",
		]);
	});
});

// ---------------------------------------------------------------------------
// findCyclesThrough
// ---------------------------------------------------------------------------
describe("ProjectGraph.findCyclesThrough", () => {
	it("detects a 2-file import cycle", () => {
		addFile("/p/a.ts", `import { b } from './b';\nexport const a = 1;`);
		addFile("/p/b.ts", `import { a } from './a';\nexport const b = 1;`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/a.ts");
		graph.updateFile("/p/b.ts");

		const cycles = graph.findCyclesThrough("/p/a.ts");
		expect(cycles.length).toBeGreaterThanOrEqual(1);
		// The cycle should start and end at a.ts.
		const cyc = cycles[0];
		expect(nonNull(cyc)[0]).toBe("/p/a.ts");
		expect(nonNull(cyc)[nonNull(cyc).length - 1]).toBe("/p/a.ts");
	});

	it("returns [] when the file has no cycle", () => {
		addFile("/p/leaf.ts", "export const l = 1;");
		addFile("/p/a.ts", `import { l } from './leaf';`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/leaf.ts");
		graph.updateFile("/p/a.ts");
		expect(graph.findCyclesThrough("/p/a.ts")).toEqual([]);
	});

	it("returns [] for a file with no outbound import edges", () => {
		addFile("/p/iso.ts", "export const i = 1;");
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/iso.ts");
		// startEdges is empty -> the for loop never runs.
		expect(graph.findCyclesThrough("/p/iso.ts")).toEqual([]);
	});

	it("returns [] for a file that was never indexed (no importGraph entry)", () => {
		const graph = new ProjectGraph("/p");
		// /p/ghost.ts never went through updateFile -> importGraph.get is
		// undefined -> the `|| []` fallback on startEdges.
		expect(graph.findCyclesThrough("/p/ghost.ts")).toEqual([]);
	});

	it("skips a node already on the active DFS path (non-target back-edge)", () => {
		// Chain a -> b -> c -> b. The second visit to b (which is NOT the query
		// target a) trips the `visited.has(current)` guard. No cycle through a.
		addFile("/p/a.ts", `import { b } from './b';\nexport const a = 1;`);
		addFile("/p/b.ts", `import { c } from './c';\nexport const b = 1;`);
		addFile("/p/c.ts", `import { b } from './b';\nexport const c = 1;`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/a.ts");
		graph.updateFile("/p/b.ts");
		graph.updateFile("/p/c.ts");
		// No cycle passes through a (the b<->c loop excludes a).
		expect(graph.findCyclesThrough("/p/a.ts")).toEqual([]);
	});

	it("traverses an edge whose target file was never indexed", () => {
		// a imports b; b's file exists (so the edge resolves) but updateFile(b)
		// is never called, so importGraph.get(b) is undefined inside dfs ->
		// the `|| []` fallback on the recursive edge lookup.
		addFile("/p/a.ts", `import { b } from './b';\nexport const a = 1;`);
		addFile("/p/b.ts", "export const b = 1;");
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/a.ts");
		// deliberately skip updateFile("/p/b.ts")
		expect(graph.findCyclesThrough("/p/a.ts")).toEqual([]);
	});

	it("skips an unresolved start edge (empty toFile) on the query file", () => {
		// The query file's only import is a bare specifier that resolves to
		// nothing -> the edge has toFile === "" -> the `if (edge.toFile)` guard
		// in the startEdges loop takes its false branch.
		addFile("/p/a.ts", `import { x } from 'bare-pkg';\nexport const a = 1;`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/a.ts");
		expect(graph.findCyclesThrough("/p/a.ts")).toEqual([]);
	});

	it("skips an unresolved edge encountered mid-DFS", () => {
		// a -> b, and b has an additional unresolved import. When dfs visits b,
		// its bare edge has toFile === "" -> the inner `if (edge.toFile)` false
		// branch fires during recursion.
		addFile("/p/a.ts", `import { b } from './b';\nexport const a = 1;`);
		addFile("/p/b.ts", `import { x } from 'bare-pkg';\nexport const b = 1;`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/a.ts");
		graph.updateFile("/p/b.ts");
		expect(graph.findCyclesThrough("/p/a.ts")).toEqual([]);
	});

	it("bounds DFS depth to avoid pathological chains", () => {
		// Build a long linear chain longer than the depth guard (15) that does
		// NOT loop back. The dfs path.length>15 guard must stop expansion and
		// return no cycle without hanging.
		const n = 20;
		for (let i = 0; i < n; i++) {
			const next = i + 1 < n ? `import { v } from './f${i + 1}';\n` : "";
			addFile(`/p/f${i}.ts`, `${next}export const v = ${i};`);
		}
		const graph = new ProjectGraph("/p");
		for (let i = 0; i < n; i++) graph.updateFile(`/p/f${i}.ts`);
		expect(graph.findCyclesThrough("/p/f0.ts")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// getInterfaceBodies / getSiblingFiles
// ---------------------------------------------------------------------------
describe("ProjectGraph.getInterfaceBodies / getSiblingFiles", () => {
	it("returns extracted interface bodies and an empty map for unknown files", () => {
		addFile("/p/types.ts", "export interface Cfg {\n  port: number;\n}");
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/types.ts");
		const bodies = graph.getInterfaceBodies("/p/types.ts");
		expect(bodies.has("Cfg")).toBe(true);
		// Unknown file -> fresh empty Map.
		expect(graph.getInterfaceBodies("/p/none.ts").size).toBe(0);
	});

	it("lists ts/js siblings excluding the file itself", () => {
		addDir("/p/dir", [
			{ name: "self.ts", dir: false },
			{ name: "sibling.ts", dir: false },
			{ name: "notes.md", dir: false },
		]);
		addFile("/p/dir/self.ts", "export const s = 1;");
		addFile("/p/dir/sibling.ts", "export const sib = 1;");
		const graph = new ProjectGraph("/p");
		const sibs = graph.getSiblingFiles("/p/dir/self.ts");
		expect(sibs).toEqual(["/p/dir/sibling.ts"]);
		// notes.md is excluded (not a ts/js ext); self.ts excluded by identity.
		expect(sibs).not.toContain("/p/dir/notes.md");
		expect(sibs).not.toContain("/p/dir/self.ts");
	});

	it("returns [] when the directory cannot be read", () => {
		// No addDir for /missing-dir -> readdirSync throws -> catch returns [].
		const graph = new ProjectGraph("/p");
		expect(graph.getSiblingFiles("/missing-dir/file.ts")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// classifyModule
// ---------------------------------------------------------------------------
describe("ProjectGraph.classifyModule", () => {
	it("classifies a leaf (no dependents)", () => {
		addFile("/p/leaf.ts", "export const l = 1;");
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/leaf.ts");
		expect(graph.classifyModule("/p/leaf.ts")).toBe("leaf");
	});

	it("classifies a root (depended upon, no project imports)", () => {
		// constants.ts is imported by a.ts but imports nothing internal.
		addFile("/p/constants.ts", "export const C = 1;");
		addFile("/p/a.ts", `import { C } from './constants';`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/constants.ts");
		graph.updateFile("/p/a.ts");
		expect(graph.classifyModule("/p/constants.ts")).toBe("root");
	});

	it("classifies internal (1-4 dependents AND has project imports)", () => {
		// mid.ts imports base.ts AND is imported by a.ts -> internal.
		addFile("/p/base.ts", "export const base = 1;");
		addFile("/p/mid.ts", `import { base } from './base';\nexport const mid = 1;`);
		addFile("/p/a.ts", `import { mid } from './mid';`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/base.ts");
		graph.updateFile("/p/mid.ts");
		graph.updateFile("/p/a.ts");
		expect(graph.classifyModule("/p/mid.ts")).toBe("internal");
	});

	it("classifies a hub (5+ dependents)", () => {
		addFile("/p/hub.ts", "export const h = 1;");
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/hub.ts");
		for (let i = 0; i < 6; i++) {
			addFile(`/p/c${i}.ts`, `import { h } from './hub';`);
			graph.updateFile(`/p/c${i}.ts`);
		}
		expect(graph.classifyModule("/p/hub.ts")).toBe("hub");
	});

	it("classifies a never-indexed file as a leaf (no importGraph entry)", () => {
		const graph = new ProjectGraph("/p");
		// /p/unknown.ts has no dependents and no importGraph entry -> the
		// `importGraph.get(absPath) || []` fallback, 0 dependents -> leaf.
		expect(graph.classifyModule("/p/unknown.ts")).toBe("leaf");
	});
});

// ---------------------------------------------------------------------------
// getProjectBoundary / allFiles / toRelative (default branches)
// ---------------------------------------------------------------------------
describe("ProjectGraph misc accessors", () => {
	it("getProjectBoundary defaults to projectRoot for an unscanned file", () => {
		const graph = new ProjectGraph("/proj");
		// File never went through walkDir -> the `?? this.projectRoot` fallback.
		expect(graph.getProjectBoundary("/proj/loose.ts")).toBe("/proj");
	});

	it("toRelative converts absolute paths to project-relative", () => {
		const graph = new ProjectGraph("/proj");
		expect(graph.toRelative("/proj/src/x.ts")).toBe("src/x.ts");
		// A relative input is first made absolute against the root, then relativized.
		expect(graph.toRelative("src/y.ts")).toBe("src/y.ts");
	});

	it("allFiles reflects indexed files", () => {
		addFile("/proj/a.ts", "export const a = 1;");
		const graph = new ProjectGraph("/proj");
		expect(graph.allFiles()).toEqual([]);
		graph.updateFile("/proj/a.ts");
		expect(graph.allFiles()).toEqual(["/proj/a.ts"]);
	});
});

// ---------------------------------------------------------------------------
// isFileReachableFromEntryPoints — the reachability BFS + memo
// ---------------------------------------------------------------------------
describe("ProjectGraph.isFileReachableFromEntryPoints", () => {
	// Build entry -> mid -> target chain via imports.
	function buildChain(): ProjectGraph {
		addFile("/p/target.ts", "export const t = 1;");
		addFile("/p/mid.ts", `import { t } from './target';\nexport const m = 1;`);
		addFile("/p/entry.ts", `import { m } from './mid';`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/target.ts");
		graph.updateFile("/p/mid.ts");
		graph.updateFile("/p/entry.ts");
		return graph;
	}

	it("returns distance 0 / self-path when target IS an entry point", () => {
		const graph = buildChain();
		const v = graph.isFileReachableFromEntryPoints("/p/target.ts", [
			"/p/target.ts",
			"/p/entry.ts",
		]);
		expect(v.reachable).toBe(true);
		expect(v.distance).toBe(0);
		expect(v.path).toEqual(["/p/target.ts"]);
		expect(v.entry_points_considered).toContain("/p/target.ts");
	});

	it("finds a multi-hop chain and reconstructs the path entry->...->target", () => {
		const graph = buildChain();
		const v = graph.isFileReachableFromEntryPoints("/p/target.ts", ["/p/entry.ts"]);
		expect(v.reachable).toBe(true);
		expect(v.distance).toBe(2);
		expect(v.path).toEqual(["/p/entry.ts", "/p/mid.ts", "/p/target.ts"]);
	});

	it("returns the memoized verdict on a repeat query", () => {
		const graph = buildChain();
		const first = graph.isFileReachableFromEntryPoints("/p/target.ts", ["/p/entry.ts"]);
		const second = graph.isFileReachableFromEntryPoints("/p/target.ts", ["/p/entry.ts"]);
		// Same cached object reference is returned on the memo hit.
		expect(second).toBe(first);
	});

	it("invalidates the memo after updateFile", () => {
		const graph = buildChain();
		const before = graph.isFileReachableFromEntryPoints("/p/target.ts", ["/p/entry.ts"]);
		expect(before.reachable).toBe(true);
		// Sever the chain: entry.ts no longer imports mid.ts.
		graph.updateFile("/p/entry.ts", "export const noop = 1;");
		const after = graph.isFileReachableFromEntryPoints("/p/target.ts", ["/p/entry.ts"]);
		expect(after).not.toBe(before); // recomputed, not the cached object
		expect(after.reachable).toBe(false);
	});

	it("returns reachable:false with no path when no chain exists", () => {
		const graph = buildChain();
		// island.ts is indexed but not in the chain.
		addFile("/p/island.ts", "export const i = 1;");
		graph.updateFile("/p/island.ts");
		const v = graph.isFileReachableFromEntryPoints("/p/island.ts", ["/p/entry.ts"]);
		expect(v.reachable).toBe(false);
		expect(v.distance).toBeUndefined();
		expect(v.path).toBeUndefined();
		expect(v.entry_points_considered).toEqual(["/p/entry.ts"]);
	});

	it("handles a target with no reverse edges at all", () => {
		const graph = buildChain();
		// orphan.ts has no importers -> reverseGraph.get(orphan) is undefined,
		// the BFS exhausts immediately (the `!parentsOfCurrent` continue).
		addFile("/p/orphan.ts", "export const o = 1;");
		graph.updateFile("/p/orphan.ts");
		const v = graph.isFileReachableFromEntryPoints("/p/orphan.ts", ["/p/entry.ts"]);
		expect(v.reachable).toBe(false);
	});

	it("is cycle-safe (already-visited parent is skipped)", () => {
		// a <-> b cycle, plus entry imports a. Reaching target=a from entry must
		// terminate despite the a<->b loop.
		addFile("/p/a.ts", `import { b } from './b';\nexport const a = 1;`);
		addFile("/p/b.ts", `import { a } from './a';\nexport const b = 1;`);
		addFile("/p/entry.ts", `import { a } from './a';`);
		const graph = new ProjectGraph("/p");
		graph.updateFile("/p/a.ts");
		graph.updateFile("/p/b.ts");
		graph.updateFile("/p/entry.ts");
		const v = graph.isFileReachableFromEntryPoints("/p/a.ts", ["/p/entry.ts"]);
		expect(v.reachable).toBe(true);
	});

	it("skips a parent already discovered via another BFS path (diamond)", () => {
		// Reverse-graph diamond so the backward BFS re-encounters `top`:
		//   entry -> top ; top -> left ; top -> right ; left -> target ; right -> target
		// BFS from target reaches `top` via left, then again via right — the
		// second encounter trips the `distances.has(parent)` skip (L261).
		addFile("/p/target.ts", "export const t = 1;");
		addFile("/p/left.ts", `import { t } from './target';\nexport const l = 1;`);
		addFile("/p/right.ts", `import { t } from './target';\nexport const r = 1;`);
		addFile(
			"/p/top.ts",
			`import { l } from './left';\nimport { r } from './right';\nexport const top = 1;`,
		);
		addFile("/p/entry.ts", `import { top } from './top';`);
		const graph = new ProjectGraph("/p");
		for (const f of ["target", "left", "right", "top", "entry"]) {
			graph.updateFile(`/p/${f}.ts`);
		}
		const v = graph.isFileReachableFromEntryPoints("/p/target.ts", ["/p/entry.ts"]);
		expect(v.reachable).toBe(true);
		// Shortest chain is entry -> top -> {left|right} -> target = 3 hops.
		expect(v.distance).toBe(3);
		expect(v.path?.[0]).toBe("/p/entry.ts");
		expect(v.path?.[v.path.length - 1]).toBe("/p/target.ts");
	});

	it("hits the depth cap and stays unreachable, emitting a verbose note", () => {
		// Linear chain LONGER than REACHABILITY_DEPTH_CAP so the target is never
		// reached within the cap. f0 imports f1 imports f2 ... so reverseGraph
		// walks f_last -> ... but the entry sits beyond the cap.
		const n = REACHABILITY_DEPTH_CAP + 5;
		for (let i = 0; i < n; i++) {
			const next = i + 1 < n ? `import { v } from './f${i + 1}';\n` : "";
			addFile(`/p/f${i}.ts`, `${next}export const v = ${i};`);
		}
		const graph = new ProjectGraph("/p");
		for (let i = 0; i < n; i++) graph.updateFile(`/p/f${i}.ts`);

		process.env.INTERLINKED_VERBOSE = "1";
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		// Target is the deepest file f_{n-1}; entry is f0 which is > cap hops away
		// along reverseGraph. The BFS hits the depth cap before reaching f0.
		const target = `/p/f${n - 1}.ts`;
		const v = graph.isFileReachableFromEntryPoints(target, ["/p/f0.ts"]);
		expect(v.reachable).toBe(false);
		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(errSpy.mock.calls[0]?.[0]).toContain("depth cap");
	});

	it("hits the depth cap WITHOUT a verbose note when INTERLINKED_VERBOSE is unset", () => {
		const n = REACHABILITY_DEPTH_CAP + 5;
		for (let i = 0; i < n; i++) {
			const next = i + 1 < n ? `import { v } from './f${i + 1}';\n` : "";
			addFile(`/p/f${i}.ts`, `${next}export const v = ${i};`);
		}
		const graph = new ProjectGraph("/p");
		for (let i = 0; i < n; i++) graph.updateFile(`/p/f${i}.ts`);

		// INTERLINKED_VERBOSE intentionally unset (cleared in afterEach).
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const v = graph.isFileReachableFromEntryPoints(`/p/f${n - 1}.ts`, ["/p/f0.ts"]);
		expect(v.reachable).toBe(false);
		expect(errSpy).not.toHaveBeenCalled();
	});
});
