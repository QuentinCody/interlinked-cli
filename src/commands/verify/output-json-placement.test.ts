import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../lib/json-types.js";
import type { NotRunContext } from "./not-run.js";
import { addPlacementSections } from "./output-json-placement.js";
import { createScanLedger } from "./scan-ledger.js";
import { emptyResults } from "./tool-results-types.js";

const base: NotRunContext = { allChecks: true, suggestions: false, structure: false, skipChecks: new Set(), toolsRun: [] };

function run(ctx: NotRunContext, extra: Partial<Parameters<typeof addPlacementSections>[1]> = {}): JsonObject {
	const result: JsonObject = {};
	addPlacementSections(result, { tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [], auditResult: null, cq: emptyResults(), suggestions: null, totalFiles: 0, runContext: ctx, scanLedger: createScanLedger(), ...extra });
	return result;
}

describe("addPlacementSections — positive", () => {
	it("keeps diagnostics from an interrupted external scan and identifies the incomplete verdict", () => {
		const ctx: NotRunContext = { ...base, toolsWithFindings: new Set(["gitleaks"]), skipped: [
			{ check: "gitleaks", category: "error", reason: "incomplete scan" },
		] };
		const out = run(ctx, { externalDiagnostics: [{ tool: "gitleaks", file: "a.ts", line: 1, severity: "warning", message: "finding" }] });
		expect(out.tool_checks).toMatchObject({ gitleaks: { issues: 1, files: ["a.ts"], incomplete: { reason: "external_tool_error", detail: "incomplete scan" } } });
	});
	it("P1: an inline battery id with no findings still appears with issues 0", () => {
		const out = run(base);
		expect(out.require_await).toEqual({ issues: 0, files: [], details: [] });
	});
	it("P2: findings in a CQ bucket are grouped under their check id", () => {
		const cq = emptyResults();
		cq.requireAwait.push({ check: "require_await", file: "a.ts", line: 3, message: "m" });
		const out = run(base, { cq });
		expect(out.require_await).toMatchObject({ issues: 1, files: ["a.ts"] });
	});
	it("P3: sweep findings from the ledger are reported under the id", () => {
		const ledger = createScanLedger();
		ledger.sweep.set("inline:swift_empty_catch", [{ check: "swift_empty_catch", file: "A.swift", line: 2, message: "m" }]);
		const out = run(base, { scanLedger: ledger });
		expect(out.swift_empty_catch).toMatchObject({ issues: 1, files: ["A.swift"] });
	});
	it("P4: structural sweep ids sit under structural_checks and spec ids under spec_ledger_checks", () => {
		const out = run(base);
		expect(Object.keys(out.structural_checks as JsonObject)).toEqual(expect.arrayContaining(["hallucinated_imports", "cross_package_imports", "undefined_env_vars"]));
		expect(Object.keys(out.spec_ledger_checks as JsonObject).sort()).toEqual(["count_claim_drift", "declared_fact_drift", "range_claim_drift", "xref_missing_anchor", "xref_missing_file"]);
	});
	it("P5: with --suggestions every suggestion id appears, counted from the findings", () => {
		const suggestions = new Map([["a.ts", [{ check: "god-file", line: 1, message: "m", source: "quality" as const }]]]);
		const out = run({ ...base, suggestions: true }, { suggestions });
		expect(out.suggestion_checks).toMatchObject({ "god-file": { issues: 1 }, "sql-injection": { issues: 0 } });
	});
	it("P6: an external tool that ran is reported with its diagnostic count", () => {
		const out = run({ ...base, toolsRun: ["tsc"] }, { externalDiagnostics: [{ tool: "tsc", file: "a.ts", line: 1, severity: "error", message: "m" }] });
		expect(out.tool_checks).toMatchObject({ typescript: { tool: "tsc", issues: 1 } });
	});
});

describe("addPlacementSections — negative", () => {
	it("N1: without --all-checks the sweep ids get no result key", () => {
		const out = run({ ...base, allChecks: false });
		expect(out.swift_empty_catch).toBeUndefined();
		expect(out.structural_checks).toBeUndefined();
		expect(out.spec_ledger_checks).toBeUndefined();
	});
	it("N2: without a run context nothing is added", () => {
		const { runContext: _context, ...rest } = { runContext: base };
		void rest;
		const result: JsonObject = {};
		addPlacementSections(result, { tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [], auditResult: null, cq: emptyResults(), suggestions: null, totalFiles: 0 });
		expect(result).toEqual({});
	});
	it("N3: an existing explicit key is not overwritten", () => {
		const result: JsonObject = { require_await: { issues: 9, files: [], details: [] } };
		addPlacementSections(result, { tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [], auditResult: null, cq: emptyResults(), suggestions: null, totalFiles: 0, runContext: base });
		expect(result.require_await).toEqual({ issues: 9, files: [], details: [] });
	});
	it("N4: with --only no inline result keys are added", () => {
		const out = run({ ...base, only: "tsc" });
		expect(out.require_await).toBeUndefined();
	});
});
