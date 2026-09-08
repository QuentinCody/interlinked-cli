import { CheckEngine } from "../check-engine/index.js";
import type { AuditResult, CheckReport, CheckResult, SkipEntry, ToolMetrics } from "../check-engine/types.js";
import { LANGUAGE_PROFILES } from "../language-profiles-data.js";
import type { LanguageId, LanguageProfile } from "../types.js";
import type { SoftwareVersionFreshnessConcern, SoftwareVersionReference, SoftwareVersionRegression } from "./software-version-regression.js";

export interface LoopReportFixture {
	results: Array<Pick<CheckResult, "file" | "line" | "message" | "ruleId">>;
	metrics?: Array<Pick<ToolMetrics, "tool" | "elapsedMs" | "findingCount">>;
	skipped?: SkipEntry[];
}

export function loopReport(report: LoopReportFixture): CheckReport {
	return {
		results: report.results.map((result) => ({ tool: "biome", severity: "warning", ...result })),
		metrics: (report.metrics ?? []).map((metric) => ({ ...metric, cacheHit: false })),
		skipped: report.skipped ?? [], toolsRun: [], toolsSkipped: [], elapsedMs: 0, deduplicatedCount: 0,
	};
}

export function loopEngine(runChecksAsync: CheckEngine["runChecksAsync"]): CheckEngine {
	const engine = new CheckEngine("/proj");
	engine.runChecksAsync = runChecksAsync;
	return engine;
}

export function loopProfile(id: LanguageId, inline = false): LanguageProfile {
	return {
		...LANGUAGE_PROFILES[id],
		inline_checks: inline ? [{ name: "x", description: "fixture", file_types: [".py"], severity: "warning", fix_instruction: "review", pattern: "x" }] : [],
	};
}

export function loopAudit(detail: string): AuditResult {
	return { tool: "npm-audit", total: 3, high: 3, critical: 0, moderate: 0, low: 0, detail };
}

export function loopVersion(anchor: string, version: string): SoftwareVersionReference {
	return { anchor, version, label: anchor, kind: "package", line: 1, text: `${anchor}@${version}` };
}

export function loopRegression(anchor: string, before: string, after: string): SoftwareVersionRegression {
	return { before: loopVersion(anchor, before), after: loopVersion(anchor, after) };
}

export function loopFreshness(anchor: string, version: string): SoftwareVersionFreshnessConcern {
	return { ref: loopVersion(anchor, version), reason: "new version", verifyHint: { source: "package registry", instruction: "verify version" } };
}
