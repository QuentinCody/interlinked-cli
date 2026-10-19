// ===========================================
// TypeScript check scheduler (E21) — PostToolUse + Stop wiring
// ===========================================
// `quality_checks.typescript.scheduler` (DEFAULT OFF, local tier only). When
// enabled and `predictTscReports` says an edit is confidently clean, the
// synchronous typescript run is skipped for that edit and the file joins a
// durable per-session deferred set. The set is drained — tsc runs ONCE over
// every deferred file — at the next single-file edit the scheduler keeps, and
// unconditionally at Stop / SubagentStop / SessionEnd and commit. A deferral is never a silent skip: the
// edit says so, the drain reports its verdict, and a drain without a verdict
// blocks Stop as NOT CHECKED. Every decision is recorded in the
// check-results.jsonl row (`scheduler: {p, deferred, …}`) so the real miss
// rate can be measured against the E21 label later.
//
// Layering: the native PostToolBatch compiler queue (compiler-batch.ts) wins
// first; the scheduler only sees edits that would otherwise run tsc
// synchronously, which is exactly the population E21 was trained on.

import { appendCheckResults } from "../check-results-sink.js";
import { parseGitCommit } from "../evaluator/commit-parse.js";
import { isInsideRoot } from "../large-file-policy.js";
import { isOperationalCheckDeferral } from "../operational-check-deferrals.js";
import type { QualityCheckResult, ToolBreakdownEntry } from "../quality-checks/result-types.js";
import { extractTscEditFeatures, predictTscReports, type TscPrediction } from "../quality-checks/tsc-scheduler.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent, QualityCheckConfig, SessionTrajectory, TscSchedulerRecord } from "../types.js";
import { diagnosticKeys, preserveOutstandingErrors, runPendingChecks } from "./compiler-batch.js";
import { addTscDeferred, finishTscDrain, readTscStore, tscSchedulerStorePath, type TscDeferredSet } from "./tsc-scheduler-store.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import { applyQualityDecision, collectQualityResultEntries } from "./post-tool-file-checks-phases-quality.js";
import type { ServerRuntime } from "./runtime-context.js";

type QualityChecks = GuardRulesConfig["quality_checks"];
export { readTscDeferred, tscSchedulerStorePath } from "./tsc-scheduler-store.js";

/** Per-file plan handed from `scheduleTypescript` to `externalAndScheduledResults`. */
export interface TscSchedulePlan {
	record: TscSchedulerRecord;
	warning?: string;
	drain?: { store: string; pending: TscDeferredSet; paths: string[] };
}

/** Only a successful, current drain can discharge work; errors survive diff filtering. */
function completeDrain(ctx: ServerRuntime, store: string, checked: TscDeferredSet, out: DrainResult): boolean {
	try {
		const blocking = out.results.filter(result => result.name === "typescript" && result.severity === "error").flatMap(diagnosticKeys);
		return finishTscDrain(ctx.cwd, store, checked, blocking, out.unavailable);
	} catch (error) {
		ctx.logAlways(`tsc scheduler: drained set could not be cleared (it will drain again): ${String(error)}`);
		return false;
	}
}

function eligible(cwd: string, event: HarnessEvent, file: string, check: QualityCheckConfig): boolean {
	return !event.dry_run && Boolean(event.session_id) && isInsideRoot(cwd, file) && check.file_types.some((ext) => file.endsWith(ext));
}

function withoutTypescript(checks: QualityChecks): QualityChecks {
	return Object.fromEntries(Object.entries(checks).filter(([name]) => name !== "typescript"));
}

function toRecord(prediction: TscPrediction): TscSchedulerRecord {
	const { p, defer, threshold, recall_point, override } = prediction;
	return { deferred: defer, p, threshold, recall_point, trigger: "edit", ...(override ? { override } : {}) };
}

function deferEdit(ctx: ServerRuntime, event: HarnessEvent, file: string, acc: PerFileCheckCtx, record: TscSchedulerRecord): void {
	const p = (record.p ?? 0).toFixed(2);
	addTscDeferred(ctx.cwd, event, file, record.p ?? 0);
	acc.allCheckResults.push({ source: "quality", name: "external_check_deferred", severity: "warning", determinism: "fully_deterministic", file,
		message: `TypeScript deferred by the tsc scheduler (p=${p}); no compiler verdict for this edit until the next scheduled run or Stop` });
	acc.tscSchedule = { record, warning: `[interlinked:typescript] deferred by scheduler (p=${p}); tsc checks this file at the next scheduled run or at Stop` };
}

/** A kept run: drain the deferred set together with this file, in one tsc run. */
function planRun(ctx: ServerRuntime, event: HarnessEvent, file: string, checks: QualityChecks, acc: PerFileCheckCtx, record: TscSchedulerRecord): QualityChecks {
	const store = tscSchedulerStorePath(ctx.cwd, event);
	let pending = readTscStore(ctx.cwd, store);
	if (pending.entries.length === 0) {
		acc.tscSchedule = { record };
		return checks;
	}
	addTscDeferred(ctx.cwd, event, file, record.p ?? 0);
	pending = readTscStore(ctx.cwd, store);
	const paths = [...new Set([...pending.entries.map((e) => e.path), file])];
	acc.tscSchedule = { record: { ...record, drained_files: paths.length }, drain: { store, pending, paths } };
	return withoutTypescript(checks);
}

/**
 * Edit-time decision. Returns the checks to run for this file: unchanged when
 * the scheduler is off or does not apply (the synchronous path is untouched),
 * without `typescript` when the edit is deferred or when a drain replaces it.
 */
export function scheduleTypescript(ctx: ServerRuntime, event: HarnessEvent, file: string, checks: QualityChecks, acc: PerFileCheckCtx): QualityChecks {
	const check = checks.typescript;
	if (!check?.enabled || !check.scheduler?.enabled || !eligible(ctx.cwd, event, file, check)) return checks;
	const features = extractTscEditFeatures({ toolName: event.tool_name ?? "", toolInput: event.tool_input ?? {}, filePath: file, cwd: ctx.cwd,
		toolUseId: event.tool_use_id ?? "", isSubagent: Boolean(event.subagent_id), timestamp: event.timestamp });
	if (!features) return checks;
	const record = toRecord(predictTscReports(features, check.scheduler.min_recall_point));
	try {
		if (!record.deferred) return planRun(ctx, event, file, checks, acc, record);
		deferEdit(ctx, event, file, acc, record);
		return withoutTypescript(checks);
	} catch (error) {
		ctx.logAlways(`tsc scheduler state unavailable; checking this edit now: ${String(error)}`);
		acc.tscSchedule = { record: { ...record, deferred: false } };
		return checks;
	}
}

function noVerdict(file: string, reason: string): QualityCheckResult {
	return { name: "external_check_deferred", severity: "warning", file, message: `External check deferred for ${file} (typescript)`,
		detail: `No check verdict was produced: ${reason}` };
}

interface DrainResult { results: QualityCheckResult[]; executed: number; unavailable: boolean }

async function drain(ctx: ServerRuntime, paths: string[], metrics: ToolBreakdownEntry[], previous: readonly string[]): Promise<DrainResult> {
	try {
		const { results, executed } = await runPendingChecks(ctx, { revision: "", paths, calls: [], blocking: [] }, metrics);
		preserveOutstandingErrors(results, previous);
		return { results, executed, unavailable: results.some((r) => isOperationalCheckDeferral(r.name)) };
	} catch (error) {
		return { results: [noVerdict(paths[0] ?? "", error instanceof Error ? error.message : String(error))], executed: 0, unavailable: true };
	}
}

/**
 * Batched external results for the file, plus the scheduler's part: the
 * decision record, the deferral line, and — on a kept run with pending
 * deferrals — the drain's tsc results (which then flow through the normal
 * quality feedback and blocking path).
 */
export async function externalAndScheduledResults(ctx: ServerRuntime, acc: PerFileCheckCtx, file: string, decision: HarnessDecision): Promise<QualityCheckResult[]> {
	const batched = acc.externalCheckBatch ? await acc.externalCheckBatch.resultsForFile(file) : [];
	const plan = acc.tscSchedule;
	if (!plan) return batched;
	acc.tscSchedule = undefined;
	decision.scheduler = plan.record;
	if (plan.warning) decision.warnings = [...(decision.warnings ?? []), plan.warning];
	if (!plan.drain) return batched;
	const out = await drain(ctx, plan.drain.paths, acc.postToolMetrics, plan.drain.pending.blocking);
	if (out.executed > 0 && !out.unavailable) acc.checksRan.push("typescript");
	if (!completeDrain(ctx, plan.drain.store, plan.drain.pending, out) && !out.unavailable && !out.results.some(result => result.severity === "error")) {
		out.results.push(noVerdict(file, "scheduler work remains pending after this run"));
	}
	return [...batched, ...out.results];
}

const TRIGGERS: Partial<Record<string, { trigger: "stop" | "session_end" | "commit"; label: string }>> = {
	Stop: { trigger: "stop", label: "Stop" },
	SubagentStop: { trigger: "stop", label: "SubagentStop" },
	SessionEnd: { trigger: "session_end", label: "SessionEnd" },
};

/** SessionEnd cannot block; the verdict travels as context instead. */
function deliver(event: HarnessEvent, decision: HarnessDecision): HarnessDecision {
	if (event.hook_event !== "SessionEnd" || decision.decision !== "block") return decision;
	const { reason, rule_id: _rule, ...rest } = decision;
	return { ...rest, decision: "allow", additional_context: reason ?? "" };
}

function unreadable(event: HarnessEvent, store: string, error: unknown, trigger: "stop" | "session_end" | "commit"): HarnessDecision {
	const reason = `[interlinked:typescript] NOT CHECKED: the tsc scheduler's deferred set is unreadable (${String(error)}); `
		+ `the deferred files are unknown. Restore the retained state at ${store} from a known-good backup and retry verification; no obligation has been cleared.`;
	return deliver(event, { decision: "block", reason, scheduler: { deferred: false, trigger } });
}

function drainSummary(label: string, files: number, out: DrainResult): string {
	const findings = out.results.filter((r) => r.name === "typescript").length;
	const status = out.unavailable ? "NO VERDICT (checker unavailable)" : findings > 0 ? `${findings} finding group(s) reported` : "no findings";
	return `[interlinked:typescript] scheduler drain at ${label}: ${out.executed ? `tsc checked ${files} deferred file(s); ${status}` : "no compiler execution; " + (out.unavailable ? status : "not applicable")}`;
}

/** Mandatory lifecycle/commit drain. Null when nothing is deferred. */
export async function runTscSchedulerBoundary(ctx: ServerRuntime, event: HarnessEvent, session: SessionTrajectory): Promise<HarnessDecision | null> {
	const command = event.tool_input?.command;
	const commit = event.hook_event === "PreToolUse" && typeof command === "string" && parseGitCommit(command)?.isCommit;
	const kind = commit ? { trigger: "commit" as const, label: "commit" } : TRIGGERS[event.hook_event];
	if (!kind || event.dry_run || !event.session_id) return null;
	const store = tscSchedulerStorePath(ctx.cwd, event);
	let pending: TscDeferredSet;
	try {
		pending = readTscStore(ctx.cwd, store);
	} catch (error) {
		return unreadable(event, store, error, kind.trigger);
	}
	if (pending.entries.length === 0) return null;
	const paths = [...new Set(pending.entries.map((e) => e.path))];
	const metrics: ToolBreakdownEntry[] = [];
	const out = await drain(ctx, paths, metrics, pending.blocking);
	const completed = completeDrain(ctx, store, pending, out);
	const checkResults: NonNullable<HarnessDecision["check_results"]> = [];
	const decision: HarnessDecision = { decision: "allow", check_results: checkResults, tool_breakdown: metrics,
		scheduler: { deferred: false, drained_files: paths.length, trigger: kind.trigger } };
	collectQualityResultEntries(out.results, checkResults);
	if (out.executed > 0 && !out.unavailable) decision.checks_ran = ["typescript"];
	applyQualityDecision(ctx, out.results, decision, session, decision.checks_ran);
	decision.warnings = [...(decision.warnings ?? []), drainSummary(kind.label, paths.length, out)];
	if (out.unavailable || !completed) {
		decision.decision = "block";
		decision.reason ??= `[interlinked:typescript] NOT CHECKED: ${paths.length} scheduler-deferred file(s) have no compiler verdict; retry verification before finishing.`;
	}
	appendCheckResults(ctx.cwd, { ...event, files_modified: paths }, decision);
	return deliver(event, decision);
}
