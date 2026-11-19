import { computeFunctionTokens } from "../../harness/function-tokens/index.js";
import { extractChangedEvidence } from "../decision-metrics/evidence.js";
import { hashBytes } from "../metrics/inventory.js";
import type { InventoryFile, SourceRole } from "../metrics/measurement-types.js";
import type { StandardsOccurrence } from "./evidence.js";

export interface StandardsUnit {
	id: string;
	evidenceUnitId: string | null;
	file: string;
	role: SourceRole;
	name: string;
	sourceHash: string;
	extractor: string;
	line: number;
	endLine: number;
	startOffset: number;
	endOffset: number;
	comment: string | null;
	context: { callers: "not_collected"; filePurpose: "not_established" };
}

/** Reuse source-derived function identities and attached comments without inventing caller or file-purpose evidence. */
export function collectStandardsUnits(root: string, files: readonly InventoryFile[]) {
	const units: StandardsUnit[] = [], notMeasured: string[] = [];
	for (const file of files) {
		try {
			const entries = computeFunctionTokens(file.content, file.path);
			if (!entries) { notMeasured.push(`${file.path}: function unit extraction unavailable`); continue; }
			const records = extractChangedEvidence({ file: file.path, before: "", after: file.content, diff: "", repository: root, revision: "working-tree", timestamp: new Date().toISOString(), message: "", allFunctions: true });
			for (const entry of entries) {
				const record = records.find(row => row.unit === "function" && row.line === entry.line && row.evidence.signature === entry.qualifiedName);
				units.push({ id: hashBytes(JSON.stringify([file.path, file.sha256, entry.startOffset, entry.endOffset])), evidenceUnitId: record?.id ?? null,
					file: file.path, role: file.role, name: entry.qualifiedName, sourceHash: file.sha256, extractor: record?.provenance.extractor ?? "unavailable",
					line: entry.line, endLine: entry.endLine, startOffset: entry.startOffset, endOffset: entry.endOffset,
					comment: typeof record?.evidence.comment === "string" ? record.evidence.comment : null, context: { callers: "not_collected", filePurpose: "not_established" } });
			}
		} catch (error) { notMeasured.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	return { units, notMeasured };
}

/** Link all enclosing functions. Line-only detector locations may identify several nested units. */
export function attachStandardsUnitIds(occurrences: StandardsOccurrence[], units: StandardsUnit[]): void {
	const byFile = new Map<string, StandardsUnit[]>();
	for (const unit of units) { const rows = byFile.get(unit.file) ?? []; rows.push(unit); byFile.set(unit.file, rows); }
	for (const row of occurrences) row.unitIds = (byFile.get(row.file) ?? []).filter(unit => unit.sourceHash === row.sourceHash && (row.startOffset === null
		? row.line >= unit.line && row.line <= unit.endLine
		: row.startOffset >= unit.startOffset && (row.endOffset ?? row.startOffset) <= unit.endOffset)).map(unit => unit.id);
}
