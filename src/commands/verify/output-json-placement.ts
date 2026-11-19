// ===========================================
// Verify JSON — result sections for every catalog check
// ===========================================
// `output-json.ts` writes the long-standing result keys. This module adds the keys that give every catalog check a
// place in the report (see `not-run.ts`): inline checks whose bucket had no key, the sweep checks, the structural and
// spec-ledger sweeps, the per-check suggestion counts, and the external-tool checks that ran. All sections use the
// same `{ issues, files, details }` shape as the older keys.

import { catalogSources, type CatalogSource } from "../../lib/metrics/catalog-sources.js";
import type { JsonObject } from "../../lib/json-types.js";
import type { OutputJsonArgs } from "./output-json.js";
import { placementFor, resultLocation, TOOL_QUALITY_ENGINE, type NotRunContext, type NotRunEntry } from "./not-run.js";
import { SWEEP_INLINE_IDS } from "./registry-sweep.js";
import { CQ_RESULT_KEYS } from "./tool-results-types.js";
import type { CodeQualityResults } from "./tool-results-types.js";

type Row = { file: string; line?: number; message?: string; check?: string };

function section(rows: readonly Row[]): JsonObject {
	return { issues: rows.length, files: [...new Set(rows.map((row) => row.file))].sort(), details: rows.map((row) => ({ ...row })) };
}

function groupByCheck(cq: CodeQualityResults): Map<string, Row[]> {
	const grouped = new Map<string, Row[]>();
	for (const key of CQ_RESULT_KEYS) {
		for (const issue of cq[key]) {
			const rows = grouped.get(issue.check) ?? [];
			rows.push({ check: issue.check, file: issue.file, line: issue.line, message: issue.message });
			grouped.set(issue.check, rows);
		}
	}
	return grouped;
}

function put(result: JsonObject, block: string, id: string, value: JsonObject): void {
	const target: JsonObject = {};
	const existing = result[block];
	if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) Object.assign(target, existing);
	target[id] = value;
	result[block] = target;
}

function suggestionRows(args: OutputJsonArgs, id: string): Row[] {
	const rows: Row[] = [];
	for (const [file, findings] of args.suggestions ?? []) {
		for (const finding of findings) if (finding.check === id) rows.push({ check: finding.check, file, line: finding.line, message: finding.message });
	}
	return rows;
}

function toolSection(args: OutputJsonArgs, id: string, incomplete?: NotRunEntry): JsonObject {
	const tool = TOOL_QUALITY_ENGINE[id];
	const own = (args.externalDiagnostics ?? []).filter((entry) => entry.tool === tool);
	const issues = tool === "dep-audit" && args.auditResult ? args.auditResult.total : own.length;
	return { tool: tool ?? null, issues, files: [...new Set(own.map((entry) => entry.file))].sort(), ...(incomplete ? { incomplete } : {}) };
}

/** Add the section for one catalog row whose placement is a result. */
function addOne(result: JsonObject, args: OutputJsonArgs, source: CatalogSource, byCheck: Map<string, Row[]>, incomplete?: NotRunEntry): void {
	const swept = args.scanLedger?.sweep.get(source.key) ?? [];
	const location = resultLocation(source, args.runContext as NotRunContext);
	if (source.family === "inline") {
		if (!(source.id in result)) result[source.id] = section(SWEEP_INLINE_IDS.includes(source.id) ? swept : byCheck.get(source.id) ?? []);
	} else if (location.startsWith("structural_checks.")) put(result, "structural_checks", source.id, section(swept));
	else if (source.family === "spec_ledger") put(result, "spec_ledger_checks", source.id, section(swept));
	else if (source.family === "suggestion") put(result, "suggestion_checks", source.id, section(suggestionRows(args, source.id)));
	else if (location.startsWith("tool_checks.")) put(result, "tool_checks", source.id, toolSection(args, source.id, incomplete));
}

/** Add the placement sections to `result` in place. */
export function addPlacementSections(result: JsonObject, args: OutputJsonArgs): void {
	const ctx = args.runContext;
	if (!ctx) return;
	const byCheck = groupByCheck(args.cq);
	for (const source of catalogSources()) {
		const placement = placementFor(source, ctx);
		if (placement.kind === "result") addOne(result, args, source, byCheck, placement.incomplete);
	}
}
