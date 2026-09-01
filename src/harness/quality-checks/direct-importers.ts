// ===========================================
// Direct Importers — one-hop reverse-import resolution for affected_tests
// ===========================================
// Finds files that DIRECTLY import a given TS/JS file, without building a
// project-wide graph. `ProjectGraph.initialize()` parses exports, imports,
// interface bodies, and project boundaries for every file and RETAINS all of
// it in memory — the on-demand build of that graph is what spiked daemon RSS
// by +2GB in one tick when structural_checks turned it on (see
// .interlinked/guard-rules.local.json's structural_checks._note: "the
// daemon's on-demand project-graph build spiked +2166MB in one tick"). This
// module does one narrower thing — "which files import <target>?", one hop
// only — and retains nothing once the answer is computed.
//
// Two-phase, deliberately cheap:
//   1. Walk the tree (SKIP_DIRS-excluded — the SAME exclusion list
//      ProjectGraph itself uses, so `.stryker-tmp`, `node_modules`,
//      `.interlinked`, and friends are never touched) and cheaply
//      substring-prefilter each source file's content against the target's
//      basename — a CANDIDATE list, not the final answer.
//   2. Per-candidate confirm: parse the candidate's import statements
//      (`parseImports`) and resolve each specifier (`resolveImportPath`)
//      against the target's real absolute path. This is what rules out a
//      same-named file living elsewhere in the tree — this repo alone has
//      several `types.ts` / `index.ts` files, so a text-only match would be
//      wrong often enough to matter.
//
// Deliberately does NOT resolve tsconfig path aliases (`@/foo`-style) —
// only relative (`./`, `../`) specifiers are checked. A missed alias-only
// importer is a false negative, and that is safe here: it costs one fewer
// companion test running, never a wrong one running.
//
// No subprocess: `readdirSync`/`statSync`/`readFileSync` only. Two reasons —
// it stays independent of whatever's on PATH (matches the "degrade
// gracefully when a tool is missing" posture the dispatchers already use for
// vitest/pytest/cargo/go), and it never shares a mocked `spawnSync` with the
// vitest-invocation phases that already call it, so adding this feature does
// not perturb any of their existing call-count/argument assertions.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { SKIP_DIRS, TS_JS_EXTENSIONS } from "../project-graph.js";
import { parseImports } from "../project-graph/parser-imports.js";
import { resolveImportPath } from "../project-graph/resolve.js";

interface FindDirectImportersArgs {
	/** Absolute path of the edited (target) file. */
	absPath: string;
	/** Directory to walk — the file's project root/boundary. */
	projectRoot: string;
}

/** Shared, per-call state threaded through the walk — bundles the two
 *  values every helper needs (the target's basename for the cheap
 *  prefilter, its absolute path for the real resolve-and-confirm) plus the
 *  mutable result accumulator, so no helper below carries more than one
 *  "which entry am I looking at right now" parameter of its own. Mirrors
 *  the WalkCtx pattern in checks/dirty-dependent.ts. */
interface ImporterWalkCtx {
	targetBase: string;
	absPath: string;
	out: string[];
}

/**
 * Public API — consumed by test-dispatchers.runVitestDispatcher.
 *
 * Find files under `projectRoot` that DIRECTLY import `absPath` (one hop —
 * a file importing an importer of `absPath` is NOT included). Returns
 * absolute paths, order not significant to callers (they sort/dedup as
 * needed). Fails safe to `[]` on any I/O error (missing root, permission
 * issues, unreadable file) — the caller degrades to "no direct importers
 * found", never to a thrown error reaching the agent.
 */
export function findDirectImporters(args: FindDirectImportersArgs): string[] {
	const { absPath, projectRoot } = args;
	const targetBase = basename(absPath, extname(absPath));
	if (!targetBase) return [];
	const ctx: ImporterWalkCtx = { targetBase, absPath, out: [] };
	walkForImporters(resolveWalkRoot(projectRoot), ctx);
	return ctx.out;
}

/**
 * Scope the walk to `<projectRoot>/src` when it exists — the TypeScript
 * project's own `include` boundary (this repo's tsconfig.json declares
 * `"include": ["src"]`) and, by the established co-location convention,
 * where every companion test already lives too. This is what actually
 * keeps the walk cheap: repo-root SIBLINGS of `src/` are exactly where
 * non-product bulk accumulates. Measured live against this repo:
 * `scratch/` alone holds 17,160 TS/JS files (293MB of mutation-campaign
 * probe debris — SKIP_DIRS does not name it, and it correctly is not a
 * `.`-prefixed directory) against `src/`'s 2,545 — walking the whole repo
 * root visited 18,149 files and took ~2.7s; scoping to `src/` visits ~2,600
 * and takes well under 0.5s. Falls back to `projectRoot` itself for a
 * flatter (non-`src/`-rooted) layout.
 */
function resolveWalkRoot(projectRoot: string): string {
	const srcDir = join(projectRoot, "src");
	try {
		// existsSync+statSync is a TOCTOU pair, not one atomic check — the
		// directory can vanish between the two calls, and a coarse test
		// double for existsSync (answers the same for every path) can say
		// "true" for a src/ dir that was never created on real disk. Either
		// way statSync then throws, so this whole check stays inside the
		// try — matching the "fails safe to [] on any I/O error" contract
		// findDirectImporters documents, the same contract walkForImporters
		// and visitEntry below already honor for their own fs calls.
		if (existsSync(srcDir) && statSync(srcDir).isDirectory()) return srcDir;
	} catch {
		return projectRoot; // TOCTOU race or a lying test double — flat-layout fallback.
	}
	return projectRoot;
}

/** Recursive SKIP_DIRS-aware walk. Directories are visited depth-first;
 *  each qualifying file is handed to {@link confirmCandidate}. */
function walkForImporters(dir: string, ctx: ImporterWalkCtx): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return; // Unreadable or nonexistent — fail safe, no candidates from here.
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		// Defense in depth beyond the named SKIP_DIRS list: any OTHER hidden
		// directory (a cache directory not yet enumerated there) is tooling,
		// never hand-written source, so it is never worth walking.
		if (entry.startsWith(".")) continue;
		visitEntry(join(dir, entry), ctx);
	}
}

/** One directory entry: recurse if it's a directory, confirm if it's a
 *  qualifying source file. Split out of {@link walkForImporters} to keep
 *  that function's cyclomatic weight to the loop + one dispatch. */
function visitEntry(full: string, ctx: ImporterWalkCtx): void {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(full);
	} catch {
		return; // Symlink race / permission denied — skip this entry only.
	}
	if (stat.isDirectory()) {
		walkForImporters(full, ctx);
		return;
	}
	if (!stat.isFile()) return;
	if (full === ctx.absPath) return; // A file never counts as its own importer.
	if (!TS_JS_EXTENSIONS.has(extname(full))) return;
	confirmCandidate(full, ctx);
}

/** Read one candidate file and confirm it truly imports `ctx.absPath` — a
 *  real module resolution, not just a text match. Appends to `ctx.out` on
 *  success. */
function confirmCandidate(candidate: string, ctx: ImporterWalkCtx): void {
	let content: string;
	try {
		content = readFileSync(candidate, "utf-8");
	} catch {
		return;
	}
	// Cheap prefilter: skip the real (line-by-line) parse when the target's
	// basename never appears in the file text at all.
	if (!content.includes(ctx.targetBase)) return;
	const rawImports = parseImports(content, candidate);
	for (const raw of rawImports) {
		if (resolveImportPath(candidate, raw.specifier) === ctx.absPath) {
			ctx.out.push(candidate);
			return;
		}
	}
}
