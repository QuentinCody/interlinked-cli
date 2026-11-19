import { classifyFileAt } from "../lib/metrics/role-population.js";
import type { DeadCodeReport } from "./deadcode.js";

/**
 * Dead-code findings in a set-aside file (generated, vendor, or unlinted by the owner's own linter) are not product findings: nobody
 * deletes a function from generated output by hand. They leave every finding list and appear in the `setAside` block with the role, the
 * evidence (tool, file, line) and the number of findings they would have added, as `interlinked verify` does for its content checks.
 * The scan itself still reads those files, so a hand-written module that only generated code imports stays reachable.
 */
export interface SetAsideDecision { role: string; evidence: string; detail: string; }
export interface DeadCodeSetAsideRow { file: string; role: string; evidence: string; detail: string; findings: number; }
export interface DeadCodeSetAside { files: number; byRole: Record<string, number>; listed: DeadCodeSetAsideRow[]; omitted: number; findings: number; }
export const DEADCODE_SET_ASIDE_LISTED = 50;
const SET_ASIDE_ROLES: ReadonlySet<string> = new Set(["generated", "vendor", "unlinted"]);

/** The source-role decision that verify and the metrics share: a set-aside role with evidence takes the file out of the findings. */
export function setAsideDecision(cwd: string): (file: string) => SetAsideDecision | null {
	return (file) => {
		const { decision } = classifyFileAt(cwd, file);
		if (!SET_ASIDE_ROLES.has(decision.role) || decision.evidence === null) return null;
		return { role: decision.role, evidence: decision.evidence.kind, detail: decision.evidence.detail };
	};
}

export function printSetAside(report: { setAside?: DeadCodeSetAside | undefined }): void {
	const aside = report.setAside;
	if (aside === undefined || aside.files === 0) return;
	const roles = Object.entries(aside.byRole).map(([role, count]) => `${role} ${count}`).join(", ");
	console.log(`\nSet aside (${aside.files} files: ${roles}; ${aside.findings} findings not counted above):`);
	for (const row of aside.listed) console.log(`  ${row.file} [${row.role}, ${row.evidence}] ${row.detail} (${row.findings})`);
	if (aside.omitted > 0) console.log(`  … +${aside.omitted} more (use --json)`);
}

export function applySetAside(report: DeadCodeReport, decide: (file: string) => SetAsideDecision | null): DeadCodeReport & { setAside: DeadCodeSetAside } {
	const verdicts = new Map<string, SetAsideDecision | null>(), findings = new Map<string, number>();
	const aside = (file: string): boolean => {
		if (!verdicts.has(file)) verdicts.set(file, decide(file));
		const hit = verdicts.get(file) ?? null;
		if (hit !== null) findings.set(file, (findings.get(file) ?? 0) + 1);
		return hit !== null;
	};
	const kept = {
		unreachableFiles: report.unreachableFiles.filter((file) => !aside(file)),
		deadImportBindings: report.deadImportBindings.filter((row) => !aside(row.file)),
		deadExports: report.deadExports.filter((row) => !aside(row.file)),
		deadTypeExports: report.deadTypeExports.filter((row) => !aside(row.file)),
		...(report.testOnlyImporterFiles === undefined ? {} : { testOnlyImporterFiles: report.testOnlyImporterFiles.filter((file) => !aside(file)) }),
	};
	const rows: DeadCodeSetAsideRow[] = [], byRole: Record<string, number> = {};
	for (const [file, verdict] of verdicts) {
		if (verdict === null) continue;
		byRole[verdict.role] = (byRole[verdict.role] ?? 0) + 1;
		rows.push({ file, role: verdict.role, evidence: verdict.evidence, detail: verdict.detail, findings: findings.get(file) ?? 0 });
	}
	rows.sort((a, b) => b.findings - a.findings || a.file.localeCompare(b.file));
	const total = rows.reduce((sum, row) => sum + row.findings, 0);
	return { ...report, ...kept, setAside: { files: rows.length, byRole, listed: rows.slice(0, DEADCODE_SET_ASIDE_LISTED), omitted: Math.max(0, rows.length - DEADCODE_SET_ASIDE_LISTED), findings: total } };
}
