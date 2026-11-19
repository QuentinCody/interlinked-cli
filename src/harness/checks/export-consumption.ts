import { dirname, resolve } from "node:path";

export interface ConsumptionEdge { targetKey: string; symbols: string[]; allUsed: boolean; }
export interface ExportUsageScan { mentions: number; resolvedEdges: number; allUsed: boolean; symbols: Set<string>; }
const EDGE_RE = /\b(?:import|export)\s+(?:type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\}|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+["']([^"']+)["']/g;
const DYNAMIC_EDGE_RE = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Existing extension-blind module identity, including directory index resolution. */
export function consumptionPathKey(path: string): string {
	return path.replace(/\.(?:[cm]?[jt]sx?|d\.ts)$/, "").replace(/\/index$/, "");
}

function symbolsOf(clause: string): string[] {
	if (clause.startsWith("*")) return ["*"];
	return (clause.match(/\{([^}]*)\}/)?.[1] ?? "").split(",")
		.map(symbol => symbol.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "").filter(Boolean);
}

function targetKey(specifier: string, importer: string): string | null {
	if (!specifier.startsWith(".")) return null;
	return consumptionPathKey(resolve("/", dirname(importer), specifier)).replace(/^\/+/, "");
}

/** Parse each importer's existing static/dynamic consumption predicate once. */
export function parseConsumptionEdges(content: string, importer: string): ConsumptionEdge[] {
	const edges: ConsumptionEdge[] = [];
	EDGE_RE.lastIndex = 0;
	for (const match of content.matchAll(EDGE_RE)) {
		const key = targetKey(match[2] ?? "", importer);
		if (key === null) continue;
		const symbols = symbolsOf(match[1] ?? "");
		edges.push({ targetKey: key, symbols, allUsed: symbols.includes("*") });
	}
	DYNAMIC_EDGE_RE.lastIndex = 0;
	for (const match of content.matchAll(DYNAMIC_EDGE_RE)) {
		const key = targetKey(match[1] ?? "", importer);
		if (key !== null) edges.push({ targetKey: key, symbols: [], allUsed: true });
	}
	return edges;
}

export function collectExportUsage(content: string, importer: string, key: string, scan: ExportUsageScan): void {
	for (const edge of parseConsumptionEdges(content, importer)) {
		if (edge.targetKey !== key) continue;
		scan.resolvedEdges++;
		if (edge.allUsed) { scan.allUsed = true; return; }
		for (const symbol of edge.symbols) scan.symbols.add(symbol);
	}
}
