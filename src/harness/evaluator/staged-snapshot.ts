// ===========================================
// Staged-snapshot materialization (commit-time gate, finding 3)
// ===========================================
// A plain `git commit` captures the INDEX (the staged tree), not the working
// tree. The commit gate must therefore evaluate the staged snapshot, or it can
// (a) false-block on unrelated unstaged work and (b) — the soundness hole —
// false-ALLOW a broken staged change that an unstaged edit masks green.
//
// This materializes the index into a temp tree the suite can run against:
//   - `git checkout-index --all --prefix=<tmp>/` writes EXACTLY the staged tree
//     (no unstaged modifications, no untracked files) — the would-be commit.
//   - node_modules is symlinked back (gitignored, so absent from the index) so
//     the runner can still resolve dependencies, mirroring the coverage overlay.
//
// Fail-safe: any failure returns null and the caller falls back to evaluating the
// working tree (no worse than before this fix). The tree is rooted UNDER
// projectRoot/.interlinked (never os.tmpdir) for the same path-resolution reason
// the coverage overlay documents.

import { execFileSync } from "node:child_process";
import {
	type Dirent,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { INTERLINKED_DIR, interlinkedPath } from "../../lib/interlinked-path.js";
import { copyDirInTree, symlinkInTree, writeFileInTree } from "../overlay-safe-write.js";

const SNAPSHOT_PREFIX = ".commit-snapshot-";
const GIT_TIMEOUT_MS = 30_000;

/** A materialized staged tree the caller runs a suite against, then cleans up. */
export interface StagedSnapshot {
	/** Absolute path to the snapshot root (mirrors the repo root, staged content). */
	root: string;
	/** Remove the snapshot tree. Idempotent / best-effort (never throws). */
	cleanup(): void;
}

/** Symlink one real `node_modules` into the snapshot (best-effort). */
function linkOne(src: string, dst: string): void {
	try {
		symlinkSync(src, dst, "dir");
	} catch {
		// No node_modules, or the platform refused the symlink — the runner may
		// still work (pure-stdlib) or the caller fail-opens. Best-effort by design.
	}
}

/**
 * Symlink the real `node_modules` into the snapshot at EVERY depth. A pnpm (or
 * npm/yarn) workspace keeps each package's own dependencies in that package's
 * `node_modules` (`packages/x/node_modules`), not in the root one; linking only
 * the root made every workspace test fail with "Cannot find package" inside the
 * snapshot, so the commit gate could never pass in a monorepo (2026-11-12).
 * The walk follows the snapshot's own directories (tracked content only, so it
 * never descends into a dependency tree) and links wherever the real project
 * has a `node_modules` beside the same directory.
 */
function linkNodeModules(projectRoot: string, root: string): void {
	const pending = [""];
	while (pending.length > 0) {
		const rel = pending.pop() ?? "";
		const real = join(projectRoot, rel, "node_modules");
		if (lstatSync(real, { throwIfNoEntry: false })) linkOne(real, join(root, rel, "node_modules"));
		let entries: Dirent[];
		try {
			entries = readdirSync(join(root, rel), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") {
				pending.push(join(rel, entry.name));
			}
		}
	}
}

/** Best-effort recursive remove (never throws). */
function removeTree(root: string): void {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup — a leaked temp dir under .interlinked is harmless
		// and is reclaimed on the next run or by the OS temp sweeper.
	}
}

/** Run a read-only git command, returning trimmed nonempty lines, or [] on failure. */
function gitLines(projectRoot: string, args: string[]): string[] {
	try {
		return execFileSync("git", args, { cwd: projectRoot, encoding: "utf-8", timeout: GIT_TIMEOUT_MS })
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
	} catch {
		return [];
	}
}

/**
 * Overlay the working tree's TRACKED, unstaged modifications onto the snapshot —
 * the extra content `git commit -a` stages before committing. Untracked files are
 * intentionally NOT copied (`-a` never stages them), so an untracked test cannot
 * mask a tracked source change (finding 3). A tracked file deleted in the worktree
 * is removed from the snapshot (the `-a` commit records the deletion).
 */
function overlayTrackedWorktree(projectRoot: string, root: string): void {
	for (const rel of gitLines(projectRoot, ["diff", "--name-only"])) {
		// lstat (not exists) so a SYMLINK is detected as such — and a broken symlink
		// is still seen (exists would skip it). throwIfNoEntry:false ⇒ undefined when absent.
		const st = lstatSync(join(projectRoot, rel), { throwIfNoEntry: false });
		if (!st) {
			removeTree(join(root, rel)); // deleted in the worktree → -a commits the deletion
			continue;
		}
		if (st.isSymbolicLink()) {
			// Re-create the snapshot symlink pointing at the NEW target. Never copy
			// THROUGH it — copyFileSync would follow both the src and the old dst
			// symlink and overwrite the old external target's contents (finding 2026-06).
			symlinkInTree(root, rel, readlinkSync(join(projectRoot, rel)));
		} else {
			// Real file → symlink-safe BYTE copy (tracked files can be binary).
			writeFileInTree(root, rel, readFileSync(join(projectRoot, rel)));
		}
	}
}

/**
 * Overlay ONLY the named worktree paths onto the index snapshot — the actual
 * snapshot a NARROW constructed commit produces (`git add src/a.ts && git
 * commit`, `git commit src/a.ts`): the existing index plus exactly the paths the
 * command stages (finding 2026-06: evaluating the raw worktree let an untracked
 * test cover the staged source, approving a commit whose real tree is
 * uncovered). Per path, mirroring the staging semantics:
 *   - absent in the worktree → the add stages the DELETION → removed;
 *   - a symlink → re-created verbatim (never copied through);
 *   - a directory pathspec → the snapshot subtree is REPLACED with the dir's
 *     current worktree state (a dir add stages its untracked files and
 *     deletions too; gitignored content inside rides along — a small accepted
 *     over-inclusion, still far tighter than the whole worktree);
 *   - a regular file → symlink-safe byte copy;
 *   - a path in `trackedOnly` → TRACKED files only (see
 *     {@link overlayTrackedScope}): pathspec commits and `-u` adds never
 *     include untracked files, so the raw copy is wrong for them.
 * Paths under `.interlinked/` are skipped: the snapshot itself lives there, so a
 * dir copy would recurse into its own tree, and harness-internal state is never
 * suite-relevant.
 */
function overlayConstructedPaths(
	projectRoot: string,
	root: string,
	relPaths: string[],
	trackedOnly: ReadonlySet<string>,
): void {
	for (const rel of relPaths) {
		if (rel === INTERLINKED_DIR || rel.startsWith(`${INTERLINKED_DIR}/`)) continue;
		if (trackedOnly.has(rel)) {
			overlayTrackedScope(projectRoot, root, rel);
			continue;
		}
		const src = join(projectRoot, rel);
		const st = lstatSync(src, { throwIfNoEntry: false });
		if (!st) {
			removeTree(join(root, rel));
			continue;
		}
		if (st.isSymbolicLink()) {
			symlinkInTree(root, rel, readlinkSync(src));
		} else if (st.isDirectory()) {
			copyDirInTree(root, rel, src);
		} else {
			writeFileInTree(root, rel, readFileSync(src));
		}
	}
}

/**
 * Overlay ONLY the TRACKED files under pathspec `rel` (worktree content; a
 * worktree deletion removes the snapshot file — the pathspec commits the
 * deletion). `git commit -- src` commits tracked paths only: copying the raw
 * directory also picked up untracked files, so an untracked test beneath the
 * pathspec could supply coverage and approve a commit that does not contain it
 * (finding 2026-06, round 4). An untracked FILE pathspec overlays nothing —
 * git would refuse to commit it (`did not match any file(s) known to git`).
 * `ls-files` failure overlays nothing: the snapshot then shows index content
 * for the scope, and on a truly broken repo checkout-index already failed.
 */
function overlayTrackedScope(projectRoot: string, root: string, rel: string): void {
	for (const f of gitLines(projectRoot, ["ls-files", "--", rel])) {
		const src = join(projectRoot, f);
		const st = lstatSync(src, { throwIfNoEntry: false });
		if (!st) {
			removeTree(join(root, f));
			continue;
		}
		if (st.isSymbolicLink()) {
			symlinkInTree(root, f, readlinkSync(src));
		} else {
			writeFileInTree(root, f, readFileSync(src));
		}
	}
}

/**
 * Materialize the would-be-committed tree of the git repo at `projectRoot` into a
 * temp tree under `projectRoot/.interlinked`, with node_modules symlinked. Returns
 * the snapshot, or null on any failure (the caller falls back to the working tree).
 *
 *   - Plain `git commit` (`includeTrackedWorktree=false`) → the INDEX exactly: no
 *     unstaged edits, no untracked files.
 *   - `git commit -a` (`includeTrackedWorktree=true`) → the index PLUS tracked
 *     worktree modifications, but still NO untracked files — `-a` never stages them
 *     (finding 3: evaluating the raw worktree leaked untracked files, so an
 *     untracked test could mask a tracked source change).
 *   - NARROW constructed commit (`constructedPaths` given) → the base tree PLUS
 *     only those paths' worktree state (see {@link overlayConstructedPaths},
 *     finding 2026-06). Paths listed in `trackedOnlyPaths` overlay TRACKED
 *     files only — a pathspec commit / `-u` add never includes untracked files
 *     (round 4).
 *   - `baseTree: "head"` (a pathspec `--only` commit — `git commit src/a.ts`
 *     WITHOUT `--include`) → the base is HEAD, not the index: git builds that
 *     commit from HEAD plus the named paths, so unrelated STAGED index changes
 *     are NOT in it. Basing on the index let a separately staged failing test
 *     false-block the commit, and a staged test supply coverage the resulting
 *     commit does not contain (round 5). A repo without HEAD fails → null →
 *     working-tree fallback.
 */
export function materializeIndexSnapshot(
	projectRoot: string,
	includeTrackedWorktree = false,
	constructedPaths?: string[],
	trackedOnlyPaths?: string[],
	baseTree: "index" | "head" = "index",
): StagedSnapshot | null {
	let root: string | null = null;
	try {
		const parent = interlinkedPath(projectRoot);
		mkdirSync(parent, { recursive: true });
		root = realpathSync(mkdtempSync(join(parent, SNAPSHOT_PREFIX)));
		if (baseTree === "head") {
			// Materialize HEAD through a throwaway index file so the repo's real
			// index is never touched. Both steps share GIT_INDEX_FILE; the temp
			// file is removed once the tree is extracted.
			const tmpIndex = join(root, ".head-base.gitindex");
			const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
			execFileSync("git", ["read-tree", "HEAD"], {
				cwd: projectRoot,
				env,
				timeout: GIT_TIMEOUT_MS,
				stdio: "ignore",
			});
			execFileSync("git", ["checkout-index", "--all", `--prefix=${root}/`], {
				cwd: projectRoot,
				env,
				timeout: GIT_TIMEOUT_MS,
				stdio: "ignore",
			});
			rmSync(tmpIndex, { force: true });
		} else {
			execFileSync("git", ["checkout-index", "--all", `--prefix=${root}/`], {
				cwd: projectRoot,
				timeout: GIT_TIMEOUT_MS,
				stdio: "ignore",
			});
		}
		if (includeTrackedWorktree) overlayTrackedWorktree(projectRoot, root);
		if (constructedPaths && constructedPaths.length > 0) {
			overlayConstructedPaths(projectRoot, root, constructedPaths, new Set(trackedOnlyPaths ?? []));
		}
		linkNodeModules(projectRoot, root);
		const snapshotRoot = root;
		return {
			root: snapshotRoot,
			cleanup: () => removeTree(snapshotRoot),
		};
	} catch {
		if (root !== null) removeTree(root);
		return null;
	}
}
