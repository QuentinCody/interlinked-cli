// Instruction packets — where a packet's `source.file` lives on disk.
//
// Packet sources are named as /enforce records them: repo-relative
// (`AGENTS.md`, `docs/x.md`) or home-relative (`~/.claude/CLAUDE.md`, the
// global instruction file that every session loads). One resolver serves the
// compiler (hashing), the evaluator (hash check), the release/restore commands
// and the budget report, so all four read the same bytes.

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

/** True when a repo-relative `file` really lives outside `root` once symlinks are resolved: the
 *  nearest existing ancestor's real path is compared with the root's real path (R6 Y4; the lexical
 *  `isGlobalSource` misses `link/AGENTS.md` when `link` points outside the repo). */
export function escapesRoot(root: string, file: string): boolean {
	if (isGlobalSource(file)) return true;
	try {
		let probe = join(root, file);
		while (!existsSync(probe) && dirname(probe) !== probe) {
			// A dangling symlink: a write would follow it to a target we cannot resolve — fail closed.
			if (lstatSync(probe, { throwIfNoEntry: false })?.isSymbolicLink()) return true;
			probe = dirname(probe);
		}
		const rel = relative(realpathSync(root), realpathSync(probe));
		return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
	} catch {
		return true; // unresolvable (EACCES, a race with a delete): never write through it
	}
}

/** `~/x` → under the home directory; an absolute name → itself; anything else under `cwd`. */
export function resolveSourcePath(cwd: string, file: string): string {
	if (file.startsWith("~/")) return join(homedir(), file.slice(2));
	return isAbsolute(file) ? normalize(file) : join(cwd, file);
}

/** A source outside the repo — home-relative (`~/`, loaded by EVERY project on this machine), absolute,
 *  or a relative name that climbs above the repo root (`../x`, `docs/../../x`) — may be judged here but
 *  is never released from here (the release and its fallback live in one repo; R38). */
export function isGlobalSource(file: string): boolean {
	if (file.startsWith("~/") || isAbsolute(file)) return true;
	const n = normalize(file);
	return n === ".." || n.startsWith("../") || n.startsWith("..\\");
}
