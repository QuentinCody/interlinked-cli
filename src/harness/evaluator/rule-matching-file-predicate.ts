// ===========================================
// Rule-pattern filesystem predicate (`nonempty_file_group`)
// ===========================================
// A regex cannot tell `: > existing.log` (destroys contents) from
// `: > .gitkeep` (creates an empty file), but the daemon has the filesystem.
// A pattern that names its file operand in a capture group asks this
// predicate whether that operand is an existing, non-empty regular file;
// only then does the pattern match (2026-10-15 review of builtin-file-truncate).

import { statSync } from "node:fs";
import { resolveBashWriteTarget } from "../pre-checks-bash-write-detect.js";

/** True when `operand` (a captured file word, quotes tolerated) resolves under
 *  `cwd` — same-command `cd` hops and `VAR=` assignments applied — to an
 *  existing regular file with contents. Unresolvable, or any error other than
 *  ENOENT ⇒ true: the predicate may only REMOVE a match it can prove harmless. */
export function isNonemptyFile(command: string, operand: string, cwd: string): boolean {
	const target = operand.replace(/^["']/, "").replace(/["']$/, "");
	const resolved = resolveBashWriteTarget(command, target, cwd);
	if (resolved === null) return true;
	try {
		const stat = statSync(resolved);
		return stat.isFile() && stat.size > 0;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ENOENT");
	}
}
