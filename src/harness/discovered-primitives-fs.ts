// interlinked-tdd: exempt
// ============================================================
// Interlinked Harness — Defensive-primitive coverage detector
// Filesystem-I/O leaf helpers: source-tree walk + discovery cache.
// ============================================================
// Extracted verbatim from discovered-primitives.ts to keep the main
// module under the per-file line cap. These functions touch only the
// filesystem and their own logic; they hold no module-private state
// from the main file. Behavior is byte-identical to the originals.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DiscoveredPrimitive, DiscoveryCache } from "./discovered-primitives.js";

/** Cap on files scanned per discovery run. Large monorepos are
 *  expensive to walk; we stop after this many TS/JS files. */
const MAX_FILES_TO_SCAN = 5000;

const SOURCE_FILE_RE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	".next",
	"coverage",
	".interlinked",
	".git",
	"reference-repos",
	".archive",
]);

/** Walk the repo and return absolute paths to source files, capped
 *  at MAX_FILES_TO_SCAN. Skips vendored/generated/git trees. */
export function listSourceFiles(repoRoot: string): string[] {
	const out: string[] = [];
	const stack: string[] = [repoRoot];
	while (stack.length > 0 && out.length < MAX_FILES_TO_SCAN) {
		const dir = stack.pop();
		if (!dir) break;
		let entries: string[];
		try {
			entries = readdirSync(dir).sort();
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (SKIP_DIRS.has(entry)) continue;
			const full = join(dir, entry);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				stack.push(full);
			} else if (st.isFile() && SOURCE_FILE_RE.test(entry)) {
				out.push(full);
				if (out.length >= MAX_FILES_TO_SCAN) break;
			}
		}
	}
	return out;
}

/** Path to the per-repo cache file. */
export function cachePath(repoRoot: string): string {
	return join(repoRoot, ".interlinked", "discovered-primitives.json");
}

/** Load the cached discovery, or null if missing/malformed. */
export function loadCache(repoRoot: string): DiscoveryCache | null {
	const path = cachePath(repoRoot);
	if (!existsSync(path)) return null;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof raw !== "object" || raw === null) return null;
		const c = raw as Partial<DiscoveryCache>;
		if (c.version !== 1 || !Array.isArray(c.primitives)) return null;
		return {
			version: 1,
			discoveredAt: typeof c.discoveredAt === "number" ? c.discoveredAt : 0,
			primitives: c.primitives,
			disabled: Array.isArray(c.disabled) ? c.disabled : [],
		};
	} catch {
		return null;
	}
}

/** Write the discovery cache, creating `.interlinked/` if absent. */
export function saveCache(repoRoot: string, cache: DiscoveryCache): void {
	const path = cachePath(repoRoot);
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
}

export function filterDisabled(cache: DiscoveryCache): DiscoveredPrimitive[] {
	if (cache.disabled.length === 0) return cache.primitives;
	const dset = new Set(cache.disabled);
	return cache.primitives.filter((p) => !dset.has(p.wrapperName));
}
