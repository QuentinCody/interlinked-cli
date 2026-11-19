import { readFileSync } from "node:fs";
import { discoverFindings } from "../decision-metrics/finding-discovery.js";
import type { FindingCase } from "../decision-metrics/finding-evidence.js";
import { containedFile, hashBytes } from "../metrics/inventory.js";
import type { InventoryFile } from "../metrics/measurement-types.js";

export interface StandardsDiscovery {
	cases: FindingCase[];
	files: number;
	unresolvedCalls: number;
	notMeasured: string[];
	limitations: string[];
}

function stableSources(root: string, files: readonly InventoryFile[], notMeasured: string[]): Map<string, InventoryFile> {
	const stable = new Map<string, InventoryFile>();
	for (const file of files) {
		try {
			if (hashBytes(readFileSync(containedFile(root, file.path))) !== file.sha256) throw new Error("source changed after inventory capture");
			stable.set(file.path, file);
		} catch (error) { notMeasured.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	return stable;
}

/** Preserve the existing candidate workflow with snapshot-bound primary evidence and explicit live dependencies. */
export function collectStandardsDiscovery(root: string, files: readonly InventoryFile[], discover: typeof discoverFindings = discoverFindings): StandardsDiscovery {
	const result: StandardsDiscovery = { cases: [], files: 0, unresolvedCalls: 0, notMeasured: [], limitations: ["Discovery combines compiler-resolved shapes and existing static candidates. Candidates require contract, ownership and caller review.", "Primary source hashes must match inventory capture. Compiler configuration and dependency declarations remain live read-only inputs.", "The existing discovery engine uses strict, allowJs, noEmit and skipLibCheck with checkJs disabled. It does not run the project's compiler command.", "Discarded calls with unresolved any/unknown return types remain unknown."] };
	const before = stableSources(root, files, result.notMeasured), paths = [...before.keys()];
	if (paths.length) {
		try {
			const batch = discover(root, { files: paths }, { resourcePolicy: "foreground-survey" });
			for (const candidate of batch.cases) result.cases.push(candidate);
			result.files += batch.files;
			result.unresolvedCalls += batch.unresolvedCalls;
			for (const reason of batch.notMeasured) result.notMeasured.push(reason);
		} catch (error) { result.notMeasured.push(`Discovery unavailable: ${error instanceof Error ? error.message : String(error)}`); }
	}
	const after = stableSources(root, [...before.values()], result.notMeasured);
	result.cases = result.cases.filter(candidate => {
		const source = candidate.sources[0], captured = source && after.get(source.file);
		if (source && captured && source.expectedHash === captured.sha256) return true;
		result.notMeasured.push(`${candidate.id}: primary discovery evidence does not match captured source`);
		return false;
	});
	result.notMeasured = [...new Set(result.notMeasured)];
	return result;
}
