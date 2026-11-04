// Bounded recursive file finder shared by the supply-chain surfaces that must
// enumerate variably-named, NESTED manifests (*.csproj, libs.versions.toml):
// the package-install snapshot gate (PreToolUse), `allowlist verify` (CI scan),
// and `allowlist snapshot`. .NET/Gradle nest these in subdirectories
// (src/App/App.csproj), so a root-only scan misses the projects `dotnet
// restore` actually resolves — which let an unapproved nested dependency slip
// past the snapshot gate (finding 2026-06).
//
// Returns paths RELATIVE to `root` (POSIX `/`-separated) so a caller can use the
// relative path as a stable snapshot KEY — bare basenames would alias two
// App.csproj in different dirs onto one snapshot entry — and `join(root, rel)`
// to read. Symlinked directories are NOT traversed: `Dirent.isDirectory()` is
// false for a symlink (it reflects lstat), so the walk can't escape the tree.

import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";

// Dirs never worth walking for source manifests; a node_modules descent alone
// would make the walk ruinous, and build outputs (bin/obj/target) only hold
// copies of the real project files.
const WALK_IGNORE_DIRS = new Set([
	"node_modules",
	".git",
	".interlinked",
	"dist",
	"build",
	"bin",
	"obj",
	"target",
	"vendor",
	"coverage",
	// Tool-managed tree COPIES: each Stryker sandbox clones the whole source
	// tree, so walking them multiplies every real file by the sandbox count
	// (found 2026-08-21: 3 sandboxes inflated gate-reach's denominator 5x,
	// reporting coverage-ratchet reach as 22% when the true figure was ~98%).
	".stryker-tmp",
	".wrangler",
	".next",
	"out",
	".venv",
	"venv",
	"__pycache__",
]);
const MAX_WALK_DEPTH = 8;

function readDirSorted(dir: string): Dirent[] | null {
	try {
		return readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
	} catch {
		return null;
	}
}

// Recursion state threaded alongside each entry: where we are (dir/rel/depth)
// and what counts as a match. Bundled so walkEntry takes one context param
// instead of three separate positional values a caller would have to track.
export interface ManifestWalkOptions {
	maxEntries?: number;
	skipRootDirs?: readonly string[];
	onLimit?: () => void;
}
type WalkState = { out: string[]; visited: number; limited: boolean; options: ManifestWalkOptions };
type WalkContext = {
	dir: string;
	rel: string;
	depth: number;
	match: (name: string) => boolean;
	state: WalkState;
};

// One entry's contribution to the walk: itself (if a matching file) or its
// whole subtree (if a directory worth descending into).
function walkEntry(e: Dirent, ctx: WalkContext): void {
	const childRel = ctx.rel ? `${ctx.rel}/${e.name}` : e.name;
	if (e.isDirectory()) {
		if (ctx.depth >= MAX_WALK_DEPTH || WALK_IGNORE_DIRS.has(e.name)
			|| (ctx.depth === 0 && ctx.state.options.skipRootDirs?.includes(e.name))) return;
		walk(join(ctx.dir, e.name), childRel, ctx.depth + 1, ctx.match, ctx.state);
		return;
	}
	if (e.isFile() && ctx.match(e.name)) ctx.state.out.push(childRel);
}

function walk(dir: string, rel: string, depth: number, match: (name: string) => boolean, state: WalkState): void {
	const entries = readDirSorted(dir);
	if (!entries) return;
	const ctx: WalkContext = { dir, rel, depth, match, state };
	for (const e of entries) {
		if (state.limited) break;
		if (state.visited >= (state.options.maxEntries ?? Infinity)) {
			state.limited = true; state.options.onLimit?.(); break;
		}
		state.visited++;
		walkEntry(e, ctx);
	}
}

export function findManifestFiles(root: string, match: (name: string) => boolean, options: ManifestWalkOptions = {}): string[] {
	const state: WalkState = { out: [], visited: 0, limited: false, options };
	// Append one path at a time: a large subtree must never become function
	// arguments (spreading 100k+ paths previously overflowed the call stack).
	walk(root, "", 0, match, state);
	return state.out;
}
