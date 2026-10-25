import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Files only `interlinked enable` or a running daemon writes into a project's `.interlinked/`. The hook path itself
 *  writes receipts, the payload census and prediction state, never these — so a folder holding none of them and no
 *  socket is not a guarded project (2026-10-22: such stray folders under `scratch/` made every hook call below them
 *  find no socket and skip the daemon; 135 of 734 calls in one session). */
const PROJECT_MARKERS = ["config.json", "guard-rules.json", "harness.pid"];

function isProjectDataDir(dataDir: string): boolean {
	if (PROJECT_MARKERS.some((name) => existsSync(join(dataDir, name)))) return true;
	try {
		return readdirSync(dataDir).some((name) => name.endsWith(".sock"));
	} catch {
		return false; // an unreadable folder proves nothing
	}
}

/** Walk up from `cwd` (20 hops) to the nearest ancestor whose `.interlinked/` is a project data dir (a project marker
 * or a harness socket) — the project root the daemon serves. When no ancestor has one, the nearest ancestor holding
 * any `.interlinked/` (an unconfigured project), or null. Shared by the hook client and the daemon's evaluators, so
 * both resolve the same project for a tool call made from a subfolder. */
export function findRepoRoot(cwd: string): string | null {
	let dir = cwd;
	let nearest: string | null = null;
	for (let depth = 0; depth < 20; depth++) {
		const dataDir = join(dir, ".interlinked");
		if (existsSync(dataDir)) {
			if (isProjectDataDir(dataDir)) return dir;
			nearest ??= dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return nearest;
}
