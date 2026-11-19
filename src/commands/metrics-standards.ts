import { collectStandardsReport, type StandardsReport } from "../lib/standards/census.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

export interface MetricsStandardsOptions { cwd?: string; profile?: string; scope?: string; json?: boolean; short?: boolean; full?: boolean; }

function renderStandards(report: StandardsReport): string {
	const measurements = report.actions.actions.filter(action => action.classification === "measurement").length;
	const candidates = report.actions.actions.filter(action => action.classification === "candidate").length;
	const gaps = report.actions.actions.filter(action => action.classification === "evidence_gap").length;
	const lines = [`Standards profile ${report.profile.id}`, `${report.inventory.selectedFiles} selected JS/TS files across ${report.inventory.entries.length} discovered paths.`,
		`Source ${report.profile.source.revision}, SHA-256 ${report.profile.source.sha256}`, "", "Standard · AST occurrences · deterministic matches · semantic candidates · scope"];
	for (const row of report.standards) lines.push(`${row.id} ${row.title} · ${row.counts.astOccurrences} · ${row.counts.detectorMatches} · ${row.counts.semanticCandidates} · ${row.state}`);
	lines.push("", `Syntax files measured ${report.syntax.measuredFiles}/${report.syntax.eligibleFiles}, unknown ${report.syntax.unknownFiles}.`,
		`Discovery unresolved calls ${report.discovery.unresolvedCalls}, compiler metadata ${report.compiler.state}.`,
		`Source snapshot ${report.provenance.sourceConsistency.state}. ${measurements} measurements, ${candidates} review candidates and ${gaps} evidence gaps.`,
		"Compliance remains unmeasured. Full and JSON output retain method coverage, source spans, suppressed matches, candidates and context gaps.");
	return lines.join("\n");
}

/** Offline source measurement with complete machine-readable evidence and explicit unknowns. */
export function metricsStandardsCommand(options: MetricsStandardsOptions): void {
	const mode = getOutputMode(options);
	try {
		const report = collectStandardsReport(options.cwd ?? process.cwd(), options);
		output(mode, report, { normal: () => renderStandards(report), full: () => JSON.stringify(report, null, 2),
			short: () => `${report.profile.id}: ${report.standards.length} standards, ${report.inventory.selectedFiles} JS/TS files, ${report.occurrences.length} occurrences, ${report.discovery.cases.length} discovery candidates, ${report.discovery.unresolvedCalls} unresolved calls, compliance unmeasured` });
	} catch (error) { outputError(mode, error instanceof Error ? error.message : String(error)); }
}
