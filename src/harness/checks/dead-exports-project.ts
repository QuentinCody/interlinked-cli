import { basename } from "node:path";
import { parseConsumptionEdges, type ConsumptionEdge, type ExportUsageScan } from "./export-consumption.js";
import type { ProjectCheckEvidence } from "./project-check-evidence.js";

interface IndexedReference { file: string; edge: ConsumptionEdge; }
interface UsageIndex {
	references: Map<string, IndexedReference[]>;
	sources: Array<{ file: string; content: string }>;
	mentions: Map<string, Set<string>>;
}
const indices = new WeakMap<ProjectCheckEvidence, UsageIndex>();

function usageIndex(evidence: ProjectCheckEvidence): UsageIndex {
	const cached = indices.get(evidence);
	if (cached) return cached;
	const index: UsageIndex = { references: new Map(), sources: evidence.sources(), mentions: new Map() };
	for (const source of index.sources) {
		for (const edge of parseConsumptionEdges(source.content, source.file)) {
			const references = index.references.get(edge.targetKey) ?? [];
			references.push({ file: source.file, edge });
			index.references.set(edge.targetKey, references);
		}
	}
	indices.set(evidence, index);
	return index;
}

function mentionedByOther(index: UsageIndex, base: string, self: string): boolean {
	let mentioned = index.mentions.get(base);
	if (!mentioned) {
		mentioned = new Set(index.sources.filter(source => source.content.includes(base)).map(source => source.file));
		index.mentions.set(base, mentioned);
	}
	return mentioned.size > (mentioned.has(self) ? 1 : 0);
}

/** Negative unused-export conclusions require the complete selected source view.
 * Resolver misses retain the existing basename-mention evidence guard. */
export function projectExportUsage(evidence: ProjectCheckEvidence, self: string, key: string, check: string): ExportUsageScan | null {
	const index = usageIndex(evidence);
	evidence.reportGaps(check);
	if (!evidence.complete) return null;
	const base = basename(self).replace(/\.[^.]*$/, "");
	const scan: ExportUsageScan = { mentions: 0, resolvedEdges: 0, allUsed: false, symbols: new Set() };
	for (const { file, edge } of index.references.get(key) ?? []) {
		if (file === self || !evidence.readFile(file).includes(base)) continue;
		scan.resolvedEdges++;
		if (edge.allUsed) return null;
		for (const symbol of edge.symbols) scan.symbols.add(symbol);
	}
	if (scan.resolvedEdges === 0 && mentionedByOther(index, base, self)) return null;
	return scan;
}
