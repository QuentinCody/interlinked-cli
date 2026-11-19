// ===========================================
// Project sweep — whole-tree structural and spec-ledger checks
// ===========================================
// Three structural checks (`hallucinated_imports`, `cross_package_imports`, `undefined_env_vars`) and the five
// spec-ledger drift checks judge a file or the document set without session state. Their detectors already exist
// (`structural-checks/`, `spec/ledger.ts`); this sweep runs them over a checkout and records findings in the run ledger.
// It runs only with `--all-checks`, so the default gate gains no check.

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { ProjectGraph } from "../../harness/project-graph.js";
import { SpecLedger } from "../../harness/spec/ledger.js";
import { checkCrossPackageImports, checkHallucinatedImports } from "../../harness/structural-checks/imports.js";
import { checkUndefinedEnvVars } from "../../harness/structural-checks/env-vars.js";
import type { StructuralCheckResult } from "../../harness/types.js";
import { currentScanLedger, isVerifyAllChecks, isVerifyCheckSelected, recordVerifyInputDeferral, verifyDeadlinePassed } from "./check-timing.js";
import type { ScanLedger } from "./scan-ledger.js";

function push(ledger: ScanLedger, key: string, row: { check: string; file: string; line: number; message: string }): void {
	const rows = ledger.sweep.get(key) ?? [];
	rows.push(row);
	ledger.sweep.set(key, rows);
}

function recordStructural(ledger: ScanLedger, root: string, results: StructuralCheckResult[], fallbackFile: string): void {
	for (const result of results) {
		const file = relative(root, result.file ?? fallbackFile).replaceAll("\\", "/");
		push(ledger, `structural:${result.check}`, { check: result.check, file, line: 0, message: result.message });
	}
}

function sweepStructural(root: string, ledger: ScanLedger, isSetAside: (relPath: string) => boolean): void {
	const wanted = ["hallucinated_imports", "cross_package_imports", "undefined_env_vars"].filter(isVerifyCheckSelected);
	if (wanted.length === 0) return;
	const graph = new ProjectGraph(root);
	graph.initialize();
	for (const file of graph.allFiles()) {
		const rel = relative(root, file).replaceAll("\\", "/");
		if (isSetAside(rel)) continue;
		try {
			if (wanted.includes("hallucinated_imports")) recordStructural(ledger, root, checkHallucinatedImports(file, rel, graph), file);
			if (wanted.includes("cross_package_imports")) recordStructural(ledger, root, checkCrossPackageImports(file, rel, graph), file);
			if (wanted.includes("undefined_env_vars")) {
				readFileSync(file, "utf-8");
				recordStructural(ledger, root, checkUndefinedEnvVars(file, rel), file);
			}
		} catch (error) {
			recordVerifyInputDeferral("structural_sweep", { file: rel, reason: error instanceof Error ? `${error.name}: ${error.message}` : "Unknown check error" });
		}
	}
}

function sweepSpecLedger(root: string, ledger: ScanLedger): void {
	const spec = SpecLedger.build(root);
	for (const finding of spec.computeDrift()) {
		if (!isVerifyCheckSelected(`spec_${finding.kind}`)) continue;
		push(ledger, `spec_ledger:${finding.kind}`, { check: finding.kind, file: finding.file, line: finding.line, message: finding.message });
	}
}

/** Run the project-wide sweeps once, after every per-file check has finished. No effect without `--all-checks`. */
export function sweepProjectChecks(root: string, isSetAside: (relPath: string) => boolean): void {
	const ledger = currentScanLedger();
	if (!ledger || !isVerifyAllChecks() || verifyDeadlinePassed()) return;
	try { sweepStructural(root, ledger, isSetAside); }
	catch (error) { recordVerifyInputDeferral("structural_sweep", { file: "<project>", reason: error instanceof Error ? `${error.name}: ${error.message}` : "Unknown check error" }); }
	try { sweepSpecLedger(root, ledger); }
	catch (error) { recordVerifyInputDeferral("spec_ledger_sweep", { file: "<project>", reason: error instanceof Error ? `${error.name}: ${error.message}` : "Unknown check error" }); }
}
