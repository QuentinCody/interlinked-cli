import { extname, relative } from "node:path";
import { addFileAt, classifyByPathAt, createPopulation, type PopulationSummary } from "../lib/metrics/role-population.js";
import { LOCAL_SIMPLIFICATION_EXTENSIONS } from "./simplify-detectors.js";

export interface DiscoveredPartition {
	/** Absolute paths that stay in the detectors' population: measured source, and every file that is not source. */
	kept: string[];
	/** Repository-relative paths of source files that the v5 source roles set aside (generated, vendored, minified). */
	setAside: string[];
	population: PopulationSummary;
}

function isDetectorSource(path: string): boolean {
	const extension = extname(path).toLowerCase();
	return LOCAL_SIMPLIFICATION_EXTENSIONS.has(extension) || extension === ".py";
}

/**
 * Apply the source roles that `metrics score` uses to the files `simplify` discovered. Only source files that the detectors read are
 * removed; other files stay so that the coverage receipt keeps reporting them as unsupported. Every file is counted by role.
 */
export function partitionDiscovered(cwd: string, discovered: readonly string[]): DiscoveredPartition {
	const population = createPopulation(), kept: string[] = [], setAside: string[] = [];
	for (const path of discovered) {
		const rel = relative(cwd, path).replace(/\\/g, "/");
		if (!isDetectorSource(rel)) { population.add(rel, classifyByPathAt(cwd, rel), null); kept.push(path); continue; }
		if (addFileAt(population, cwd, rel).kept) kept.push(path);
		else setAside.push(rel);
	}
	return { kept, setAside, population: population.summary() };
}
