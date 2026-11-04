// Semantic graph — refresh. Re-extract the units, append a `stale` copy of
// every latest edge whose source text changed or vanished, then build: the
// build skips every packet whose hash still carries a live judgment, so only
// the changed sources (and new candidates) are re-asked.

import { type BuildOptions, type BuildReport, buildSemanticGraph, unitsInScope } from "./build.js";
import { loadRelationships } from "./relationships.js";
import { markStale } from "./store.js";

export interface RefreshReport {
	/** Stale rows appended before the build. */
	stale: number;
	build: BuildReport;
}

export async function refreshSemanticGraph(cwd: string, opts: BuildOptions): Promise<RefreshReport> {
	const file = loadRelationships(cwd);
	const units = unitsInScope(cwd, file, opts.deps?.units);
	const stale = markStale(cwd, units, file.relationships, opts.now);
	opts.log?.(`refresh: ${stale.length} edge(s) marked stale`);
	const build = await buildSemanticGraph(cwd, { ...opts, deps: { ...opts.deps, units } });
	return { stale: stale.length, build };
}
