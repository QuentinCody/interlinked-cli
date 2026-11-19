// ===========================================
// Structure config + artifact graph cache, keyed by project root
// ===========================================
// The PostToolUse structure phase resolves each edited file to its project
// root and reuses that root's parsed `interlinked/structure.json` and artifact
// graph across calls. Each root owns its own entry.
//
// Before 2026-11-05 the daemon held ONE config and ONE graph for its whole
// life. The first root that had a `structure.json` (a nested test fixture,
// 2026-10-23) then judged every later edit in the real repository with the
// fixture's glossary: 1,410,037 `glossary_residue` findings in one daemon
// lifetime (scratch/instruction-files/glossary-residue.md).

import { resolve } from "node:path";
import type { ArtifactGraph } from "../structure/artifact-graph.js";
import type { StructureConfig } from "../structure/types.js";

/** Project roots kept before the least recently used entry is dropped. */
export const STRUCTURE_CACHE_MAX_ROOTS = 8;

export interface StructureRootEntry {
	/** The root's parsed `interlinked/structure.json`. `null` is a cached
	 *  negative answer: the root has no valid structure config. */
	readonly config: StructureConfig | null;
	/** The root's artifact graph; `null` until the first run builds it. */
	graph: ArtifactGraph | null;
}

/** Bounded least-recently-used map from a resolved project root to its entry. */
export class StructureRootCache {
	private readonly entries = new Map<string, StructureRootEntry>();

	/** The entry for `root`, marked most recently used; `undefined` on a miss. */
	get(root: string): StructureRootEntry | undefined {
		const key = resolve(root);
		const entry = this.entries.get(key);
		if (entry !== undefined) {
			this.entries.delete(key);
			this.entries.set(key, entry);
		}
		return entry;
	}

	/** Stores a new entry for `root` with no graph yet and returns it. */
	create(root: string, config: StructureConfig | null): StructureRootEntry {
		const key = resolve(root);
		const entry: StructureRootEntry = { config, graph: null };
		this.entries.delete(key);
		this.entries.set(key, entry);
		for (const oldest of this.entries.keys()) {
			if (this.entries.size <= STRUCTURE_CACHE_MAX_ROOTS) break;
			this.entries.delete(oldest);
		}
		return entry;
	}

	/** Drops the entry for `root`, so the next run reloads its config and graph. */
	delete(root: string): void {
		this.entries.delete(resolve(root));
	}
}
