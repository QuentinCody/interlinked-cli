import { describe, expect, it } from "vitest";
import { verifyActions } from "./action-projection.js";
import { emptyResults } from "./tool-results-types.js";
import type { OutputJsonArgs } from "./output-json.js";

const input = (): OutputJsonArgs => ({ tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [], auditResult: null, cq: emptyResults(), suggestions: null, totalFiles: 0 });

describe("complete verification action projection", () => {
	it("retains setup, registry, suggestions and aggregate audit evidence with their next steps", () => {
		const args = input();
		args.setupIssues = [{ check: "project_setup", file: "tsconfig.json", line: 1, message: "Missing strictness", fix: "Review strict configuration" }];
		args.registryDrift = [{ pair: "registry", kind: "missing-from-right", id: "example", source_file: "a.ts", target_file: "b.ts", message: "Missing registered entry" }];
		args.suggestions = new Map([["index.ts", [{ check: "simplify", line: 4, message: "Inspect repeated behavior", source: "quality" }]]]);
		args.auditResult = { tool: "npm", total: 2, critical: 0, high: 2, moderate: 0, low: 0, detail: "Two package advisories; inspect affected versions" };
		const report = verifyActions(args);
		expect(report.actions.map(action => action.evidence[0]?.check).sort()).toEqual(["dependency_audit", "project_setup", "registry_parity", "simplify"]);
		expect(report.actions.find(action => action.file === "tsconfig.json")?.nextSteps).toEqual(["Review strict configuration"]);
		expect(report.actions.every(action => action.enforcement === "report")).toBe(true);
		expect(report.actions.find(action => action.file === "index.ts")?.line).toBe(4);
	});

	it("exposes unavailable analysis and catalogue coverage as gaps rather than empty clean results", () => {
		const report = verifyActions({ ...input(), unavailableChecks: [{ check: "tsc", reason: "Compiler missing" }], catalogue: { unread_config_key: { findings: [], examined: 3, unavailable: 2, durationMs: 1 } }, structureSection: { error: "Structure unavailable" }, projectE2e: { status: "unavailable", reason: "Ledger unavailable", scenarios: [] } });
		expect(report.actions).toHaveLength(4);
		expect(report.actions.every(action => action.classification === "evidence_gap")).toBe(true);
		expect(report.actions.find(action => action.evidence[0]?.check === "unread_config_key")?.evidence[0]?.message).toContain("2");
	});

	it("keeps every structure, stale-proof and open scenario finding while ignoring satisfied scenarios", () => {
		const report = verifyActions({ ...input(),
			structureSection: { details: [{ name: "companion", file: "a.ts", artifact_id: "a", determinism: "heuristic", required_updates: [{ file: "a.test.ts", kind: "test", reason: "Check behavior" }] }] },
			killProofs: { details: [{ check: "kill_proof_stale", id: "proof", files: ["a.test.ts"], message: "Source changed", fix: "Renew retained proof" }] },
			projectE2e: { status: "configured", scenarios: [{ key: "good", status: "satisfied", required: true, codes: [] }, { key: "first", status: "open", required: true, codes: ["missing_receipt"] }, { key: "second", status: "open", required: true, codes: ["stale_receipt"] }] },
		});
		expect(report.actions).toHaveLength(4);
		expect(report.actions.filter(action => action.evidence[0]?.check === "project_e2e")).toHaveLength(2);
		expect(report.actions.find(action => action.file === "a.test.ts")?.nextSteps).toEqual(["Renew retained proof"]);
		expect(report.actions.find(action => action.file === "a.ts")?.evidence[0]?.message).toContain("a.test.ts");
	});

	it("keeps unrelated tool rules at the same source line distinct and never manufactures unknown section findings", () => {
		const args = input();
		args.tscResults = [{ tool: "tsc", file: "a.ts", line: 2, severity: "error", ruleId: "TS1", message: "First" }, { tool: "tsc", file: "a.ts", line: 2, severity: "error", ruleId: "TS2", message: "Second" }];
		const report = verifyActions({ ...args, structureSection: { details: [null, {}] }, projectE2e: { status: "unconfigured" } });
		expect(report.actions).toHaveLength(2);
		expect(report.modelCalls).toBe(0);
	});

	it("distinguishes failed or deferred checks from deliberately disabled and inapplicable tools", () => {
		const report = verifyActions({ ...input(), checkCoverage: { toolsRun: [], skipped: [
			{ check: "tsc", category: "resource_busy", reason: "Capacity unavailable" },
			{ check: "ruff", category: "file_type_mismatch", reason: "No Python source" },
			{ check: "semgrep", category: "config_disabled", reason: "Disabled by project" },
		] }, checkTimings: [{ check: "dead_exports", calls: 2, skipped: 4, errors: 0, duration_ms: 30000, max_call_ms: 30000, unavailable_inputs: [{ file: "large.ts", reason: "Input size budget" }] }] });
		expect(report.actions.map(action => action.evidence[0]?.check).sort()).toEqual(["dead_exports", "dead_exports", "tsc"]);
		expect(report.actions.every(action => action.classification === "evidence_gap")).toBe(true);
		expect(report.actions.some(action => action.file === "large.ts")).toBe(true);
	});

	it("retains tool-specific unavailable inputs and native limitations without relabeling explicit exclusions as failures", () => {
		const report = verifyActions({ ...input(), toolInputScopes: [{ tool: "gitleaks", selectedFiles: 2,
			targets: ["a.ts", "b.ts"], selection: "git-visible", excludedInputs: [{ file: ".env", reason: "Explicit Git-visible scope" }],
			unavailableInputs: [{ file: "b.ts", reason: "Selected source disappeared" }], nativeLimitations: ["Native parser cannot assess this construct"] }] });
		expect(report.actions.some(action => action.file === "b.ts" && action.classification === "evidence_gap")).toBe(true);
		expect(report.actions.some(action => action.file === ".env")).toBe(false);
		expect(report.actions).toHaveLength(1);
		expect(report.limitations.join(" ")).toContain("gitleaks: Native parser cannot assess this construct");
	});

	it("keeps same-rule external diagnostics at distinct columns and original span evidence", () => {
		const report = verifyActions({ ...input(), externalDiagnostics: [
			{ tool: "tsc", file: "a.ts", line: 2, column: 3, severity: "error", ruleId: "TS1", message: "First" },
			{ tool: "tsc", file: "a.ts", line: 2, column: 15, severity: "error", ruleId: "TS1", message: "Second" },
		] });
		expect(report.actions).toHaveLength(2);
		expect(report.actions.map(action => action.evidence[0]?.column)).toEqual([3, 15]);
		expect(report.actions.every(action => action.freshness === "unknown")).toBe(true);
	});
});
