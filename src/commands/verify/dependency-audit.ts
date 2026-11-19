import { isJsonObject } from "../../lib/json-types.js";
import { statSync } from "node:fs";
import { join } from "node:path";
import { parseNpmAuditJson, parseOsvScannerJson } from "../../harness/check-engine/output-parsers.js";
import { runProcessAsync } from "../../harness/check-engine/spawn-async.js";
import { requireFileProcessVerdict } from "../../harness/check-engine/tool-runners/file-process-verdict.js";
import { selectApplicableTools } from "../../harness/check-engine/tool-applicability.js";
import type { AuditResult, CheckReport, SkipEntry } from "../../harness/check-engine/types.js";
import { recordVerifyMeasurement } from "./check-timing.js";
import { resolveVerifyToolIds } from "./tool-selection.js";
import { resolveDependencyAuditCommandAsync } from "../../harness/quality-checks/dependency-audit.js";
import { parseWire, wireAbsentOptional, wireArray, wireObject, wireString } from "../../lib/value-validation.js";
import { currentProcessSignal } from "../../harness/check-engine/process-cancellation.js";

const NPM_COMMAND = { cmd: ["npm", "audit", "--json", "--audit-level=moderate"], parser: "npm-audit" as const };
type AuditCommand = { cmd: string[]; parser: "npm-audit" | "osv-scanner" };
export interface VerifyAuditOutcome { audit: AuditResult | null; skipped?: SkipEntry; elapsedMs: number; }

function rootNpmManifest(projectRoot: string): boolean {
	try { return statSync(join(projectRoot, "package.json")).isFile(); }
	catch { return false; }
}

async function resolveVerifyAuditCommand(projectRoot: string, timeoutMs: number): Promise<AuditCommand> {
	const selected = await resolveDependencyAuditCommandAsync("package.json", { probeTimeoutMs: timeoutMs });
	if (selected?.parser === "osv-scanner") return { parser: "osv-scanner", cmd: ["osv-scanner", "scan", "source", "--format=json", "--recursive", "."] };
	if (rootNpmManifest(projectRoot)) return NPM_COMMAND;
	throw new Error("osv-scanner is unavailable for selected non-npm dependency inputs; no audit verdict");
}

const osvPackage = wireObject({
	vulnerabilities: wireAbsentOptional(wireArray(wireObject({
		id: wireAbsentOptional(wireString),
		severity: wireAbsentOptional(wireArray(wireObject({ score: wireAbsentOptional(wireString) }))),
	}))),
	groups: wireAbsentOptional(wireArray(wireObject({
		ids: wireAbsentOptional(wireArray(wireString)),
		max_severity: wireAbsentOptional(wireString),
	}))),
});

function parseOsvAudit(output: string): AuditResult | null {
	let parsed: unknown;
	try { parsed = JSON.parse(output); }
	catch (error) { throw new Error("OSV audit returned malformed JSON", { cause: error }); }
	const report = parseWire(parsed, wireObject({ results: wireArray(wireObject({ packages: wireArray(osvPackage) })) }), "OSV dependency report");
	if (report.results.some(result => result.packages.some(pkg => pkg.vulnerabilities?.length && !pkg.groups?.length))) throw new Error("OSV report has ungrouped vulnerabilities; no complete audit verdict");
	return parseOsvScannerJson(output);
}

/** A valid clean npm audit and an invalid/missing report have distinct outcomes. */
export function parseDependencyAudit(output: string): AuditResult | null {
	let parsed: unknown;
	try { parsed = JSON.parse(output); }
	catch (error) { throw new Error("Dependency audit returned malformed JSON", { cause: error }); }
	const metadata = isJsonObject(parsed) && !parsed.error ? parsed.metadata : undefined;
	const vulnerabilities = isJsonObject(metadata) ? metadata.vulnerabilities : undefined;
	if (!isJsonObject(vulnerabilities) || !["low", "moderate", "high", "critical", "total"].every(key =>
		typeof vulnerabilities[key] === "number" && Number.isSafeInteger(vulnerabilities[key]) && vulnerabilities[key] >= 0)) {
		throw new Error("Dependency audit returned no valid vulnerability-count report");
	}
	return parseNpmAuditJson(output);
}

export function dependencyAuditRequested(only: string | undefined, skip: ReadonlySet<string>): boolean {
	return (!only || only === "sca" || resolveVerifyToolIds([only]).includes("dep-audit"))
		&& !skip.has("sca") && !resolveVerifyToolIds(skip).includes("dep-audit");
}

/** Replace the generic dispatch placeholder with the dedicated audit's actual evidence. */
export async function runBatchDependencyAudit(report: CheckReport, projectRoot: string, only: string | undefined, skip: ReadonlySet<string>, timeoutMs = 0): Promise<AuditResult | null> {
	if (!dependencyAuditRequested(only, skip)) return null;
	const outcome = await runVerifyDependencyAudit(projectRoot, timeoutMs);
	report.skipped = (report.skipped ?? []).filter(row => row.check !== "dep-audit");
	report.toolsSkipped = (report.toolsSkipped ?? []).filter(row => row.id !== "dep-audit");
	if (outcome.skipped) report.skipped.push(outcome.skipped);
	else report.toolsRun.push({ id: "dep-audit", available: true });
	recordVerifyMeasurement("dep-audit", outcome.elapsedMs);
	return outcome.audit;
}

/** Dedicated verify audit path. It owns one managed process and preserves no-verdict evidence. */
export async function runVerifyDependencyAudit(projectRoot: string, timeoutMs: number): Promise<VerifyAuditOutcome> {
	currentProcessSignal()?.throwIfAborted();
	const start = performance.now();
	const selection = selectApplicableTools([{ id: "dep-audit", available: true }], { projectRoot, mode: "project" });
	if (selection.skipped[0]) return { audit: null, skipped: selection.skipped[0], elapsedMs: 0 };
	try {
		const command = await resolveVerifyAuditCommand(projectRoot, timeoutMs);
		const outcome = await executeAuditWithFallback(command, projectRoot, timeoutMs);
		return { ...outcome, elapsedMs: performance.now() - start };
	} catch (error) {
		currentProcessSignal()?.throwIfAborted();
		return { audit: null, skipped: { check: "dep-audit", category: "error", reason: error instanceof Error ? error.message : String(error) }, elapsedMs: performance.now() - start };
	}
}

async function executeAudit(command: AuditCommand, projectRoot: string, timeoutMs: number): Promise<AuditResult | null> {
	currentProcessSignal()?.throwIfAborted();
	const binary = command.cmd[0];
	if (!binary) throw new Error("Dependency audit command has no executable");
	const result = await runProcessAsync(binary, command.cmd.slice(1), { cwd: projectRoot, timeout: timeoutMs, maxBufferBytes: null });
	currentProcessSignal()?.throwIfAborted();
	requireFileProcessVerdict("dep-audit", result, 1);
	const audit = command.parser === "osv-scanner" ? parseOsvAudit(result.stdout) : parseDependencyAudit(result.stdout);
	requireFileProcessVerdict("dep-audit", result, audit?.total ?? 0);
	return audit;
}

async function executeAuditWithFallback(command: AuditCommand, projectRoot: string, timeoutMs: number): Promise<Omit<VerifyAuditOutcome, "elapsedMs">> {
	try { return { audit: await executeAudit(command, projectRoot, timeoutMs) }; }
	catch (error) {
		currentProcessSignal()?.throwIfAborted();
		if (command.parser !== "osv-scanner" || !rootNpmManifest(projectRoot)) throw error;
		const audit = await executeAudit(NPM_COMMAND, projectRoot, timeoutMs);
		return { audit, skipped: { check: "dep-audit", category: "error", reason: `OSV audit failed (${error instanceof Error ? error.message : String(error)}). npm fallback completed. Other dependency scope remains unavailable.` } };
	}
}
