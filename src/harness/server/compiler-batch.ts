import { relative, resolve } from "node:path";
import { appendCheckResults } from "../check-results-sink.js";
import { parseGitCommit } from "../evaluator/commit-parse.js";
import { recordHookObservations } from "../hook-observations.js";
import { isInsideRoot } from "../large-file-policy.js";
import { isOperationalCheckDeferral } from "../operational-check-deferrals.js";
import { findProjectRoot } from "../quality-checks.js";
import type { QualityCheckResult, ToolBreakdownEntry } from "../quality-checks/result-types.js";
import { runCommandCheck } from "../quality-checks/tool-command-check.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import { completeCompilerBatch, compilerSessionKey, readCompilerBatch, writeCompilerBatch, type CompilerBatch } from "./compiler-batch-store.js";
import { applyQualityDecision, collectQualityResultEntries } from "./post-tool-file-checks-phases-quality.js";
import type { ServerRuntime } from "./runtime-context.js";

// Capability is observed, not inferred from a provider name or a timer.
const capable = new WeakMap<ServerRuntime, Set<string>>();

export function mergeCompilerDecision(current: HarnessDecision, compiler: HarnessDecision | null): HarnessDecision;
export function mergeCompilerDecision(current: HarnessDecision | null, compiler: HarnessDecision | null): HarnessDecision | null;
export function mergeCompilerDecision(current: HarnessDecision | null, compiler: HarnessDecision | null): HarnessDecision | null {
    if (!compiler) return current;
    if (!current) return compiler;
    const primary = current.decision === "block" ? current : compiler;
    return { ...current, ...compiler, decision: primary.decision, ...(primary.reason ? { reason: primary.reason } : {}),
        warnings: [...(current.warnings ?? []), ...(compiler.warnings ?? [])],
        additional_context: [current.additional_context, compiler.additional_context].filter(Boolean).join("\n") };
}

function canQueue(ctx: ServerRuntime, event: HarnessEvent, file: string): boolean {
    return !event.dry_run && event.agent_source === "claude" && Boolean(event.session_id)
        && event.write_attribution === "declared-target" && Boolean(ctx.rules.quality_checks.typescript?.enabled)
        && Boolean(capable.get(ctx)?.has(compilerSessionKey(event)))
        && isInsideRoot(ctx.cwd, file) && /\.[cm]?[jt]sx?$/.test(file);
}

export function queueBatchCompiler(ctx: ServerRuntime, event: HarnessEvent, file: string): boolean {
    const path = resolve(ctx.cwd, file);
    if (!canQueue(ctx, event, path)) return false;
    try {
        const pending = readCompilerBatch(ctx.cwd, event);
        if (pending.paths.length >= 4096 || pending.calls.length >= 4096) return false;
        writeCompilerBatch(ctx.cwd, event, { ...pending, paths: [...new Set([...pending.paths, path])],
            calls: [...new Set([...pending.calls, event.tool_use_id ?? "unknown"])] });
        recordHookObservations({ ...event, cwd: ctx.cwd }, [{ kind: "scheduled", check: "typescript", file: path, message: "Queued for native PostToolBatch; not checked yet" }]);
        return true;
    } catch (error) {
        ctx.logAlways(`Compiler batch could not be retained; checking this edit immediately: ${String(error)}`);
        return false;
    }
}

function isBoundary(event: HarnessEvent): boolean {
    if (["PostToolBatch", "Stop", "SessionEnd"].includes(event.hook_event)) return true;
    const command = event.tool_input?.command;
    return event.hook_event === "PreToolUse" && typeof command === "string" && Boolean(parseGitCommit(command)?.isCommit);
}

function rememberCapability(ctx: ServerRuntime, event: HarnessEvent): void {
    if (event.hook_event !== "PostToolBatch") return;
    let sessions = capable.get(ctx);
    if (!sessions) { sessions = new Set(); capable.set(ctx, sessions); }
    if (sessions.size >= 1024) sessions.delete(sessions.values().next().value!);
    sessions.add(compilerSessionKey(event));
}

/** Full checks remain synchronous for security, lint and all other providers. */
export async function runCompilerBoundary(ctx: ServerRuntime, event: HarnessEvent, session: SessionTrajectory): Promise<HarnessDecision | null> {
    if (event.dry_run || event.agent_source !== "claude" || !event.session_id || !isBoundary(event)) return null;
    rememberCapability(ctx, event);
    try {
        const pending = readCompilerBatch(ctx.cwd, event);
        if (!pending.paths.length) return null;
        return await checkPending(ctx, event, session, pending);
    } catch (error) {
        const reason = `[interlinked:typescript] NOT CHECKED: pending batch could not be verified: ${String(error)}`;
        return deliverBatchDecision(event, { decision: "block", reason }, "findings");
    }
}

function groupProjects(ctx: ServerRuntime, paths: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const path of paths) {
        const root = findProjectRoot(path, ctx.cwd) || ctx.cwd;
        const group = groups.get(root) ?? [];
        group.push(path);
        groups.set(root, group);
    }
    return groups;
}

const NOT_APPLICABLE = "external_check_not_applicable";
/** `executed` counts the project groups the compiler actually ran for; a group without a tsconfig is NOT APPLICABLE and never counts as executed. */
export async function runPendingChecks(ctx: ServerRuntime, pending: CompilerBatch, metrics: ToolBreakdownEntry[]): Promise<{ results: QualityCheckResult[]; executed: number }> {
    const check = ctx.rules.quality_checks.typescript;
    if (!check?.enabled) throw new Error("TypeScript policy changed while work was pending; restore the check and retry");
    const results: QualityCheckResult[] = [];
    let executed = 0;
    for (const [root, paths] of groupProjects(ctx, pending.paths)) {
        const file = paths[0]!;
        const rows = await runCommandCheck({ filePath: file, cwd: root, tscFilterFile: undefined,
            editedFiles: paths.map(path => relative(root, path)), outToolMetrics: metrics }, "typescript", check);
        if (rows === null) throw new Error("TypeScript checker did not produce a verdict");
        if (!rows.some(row => row.name === NOT_APPLICABLE)) executed += 1;
        results.push(...rows);
    }
    return { results, executed };
}
/** The evidence record: `checks_ran` only when a compiler executed; a not-applicable project is a SKIP (reason kept), never an execution claim. */
function recordExecution(decision: HarnessDecision, results: QualityCheckResult[], executed: number, unavailable: boolean): void {
    if (!unavailable && executed > 0) decision.checks_ran = ["typescript"];
    const skipped = results.filter(row => row.name === NOT_APPLICABLE);
    if (skipped.length) decision.checks_skipped = skipped.map(row => ({ check: "typescript", category: "config_disabled" as const, reason: `not applicable: ${row.detail ?? row.message}` }));
}

export function diagnosticKeys(result: QualityCheckResult): string[] {
    return result.diagnosticKeys ?? (result.detail ?? result.message).split("\n")
        .map(line => line.replace(/\([\d,…]+\)(?=:)/g, "(<line>)").trim());
}

export function preserveOutstandingErrors(results: QualityCheckResult[], previous: readonly string[]): void {
    const unresolved = new Set(previous);
    for (const result of results) {
        if (result.name !== "typescript" || !diagnosticKeys(result).some(key => unresolved.has(key))) continue;
        result.severity = "error";
        delete result.novelty;
        result.message = "typescript: unresolved issue(s) from the previous batch";
    }
}

async function checkPending(ctx: ServerRuntime, event: HarnessEvent, session: SessionTrajectory, pending: CompilerBatch): Promise<HarnessDecision> {
    const metrics: ToolBreakdownEntry[] = [];
    const { results, executed } = await runPendingChecks(ctx, pending, metrics);
    preserveOutstandingErrors(results, pending.blocking);
    const unavailable = results.some(result => isOperationalCheckDeferral(result.name));
    const blocking = results.filter(result => result.severity === "error").flatMap(diagnosticKeys);
    const outstanding = unavailable ? [...new Set([...pending.blocking, ...blocking])] : blocking;
    const completed = completeCompilerBatch(ctx.cwd, event, pending, outstanding, unavailable);
    const decision: HarnessDecision = { decision: "allow", check_results: [], tool_breakdown: metrics };
    collectQualityResultEntries(results, decision.check_results!);
    recordExecution(decision, results, executed, unavailable);
    applyQualityDecision(ctx, results, decision, session, decision.checks_ran);
    if (unavailable || !completed) {
        decision.decision = "block";
        decision.reason ??= "[interlinked:typescript] NOT CHECKED: compiler batch still pending; retry verification before completing.";
    }
    appendCheckResults(ctx.cwd, { ...event, files_modified: pending.paths }, decision);
    recordHookObservations({ ...event, cwd: ctx.cwd }, [{ kind: "metric", check: "typescript-batch",
        related_tool_use_ids: pending.calls, message: `${pending.calls.length} tool calls; ${pending.paths.length} paths; ${unavailable ? "unavailable" : "checked"}` }]);
    return deliverBatchDecision(event, decision, blockBasis(ctx, event, pending, unavailable && completed && outstanding.length === 0));
}

/** What a blocking batch verdict rests on: known diagnostics (or an unverified
 * race), only an operational deferral that no edit can resolve, or that same
 * deferral when this session was already told about it. */
type BatchBlockBasis = "findings" | "deferral-only" | "deferral-repeated";

// The deferral already announced to a session: its pending paths. Kept in
// memory, so a daemon restart announces a deferral that is still open once more.
const announcedDeferral = new WeakMap<ServerRuntime, Map<string, string>>();

/** `deferralOnly`: the checker could not run, this batch was the one it was
 * asked about, and no diagnostic is known. A tool batch says that once per
 * pending state; Stop says it each time. */
function blockBasis(ctx: ServerRuntime, event: HarnessEvent, pending: CompilerBatch, deferralOnly: boolean): BatchBlockBasis {
    let announced = announcedDeferral.get(ctx);
    if (!announced) { announced = new Map(); announcedDeferral.set(ctx, announced); }
    const session = compilerSessionKey(event);
    if (!deferralOnly) { announced.delete(session); return "findings"; }
    if (event.hook_event !== "PostToolBatch") return "deferral-only";
    const state = [...pending.paths].sort().join("\0");
    if (announced.get(session) === state) return "deferral-repeated";
    if (announced.size >= 1024) announced.delete(announced.keys().next().value!);
    announced.set(session, state);
    return "deferral-only";
}

const REPAIR_NOTE = "Repair the completed batch before finishing; pending compiler findings remain enforced at Stop and commit.";
const DEFERRAL_NOTE = "The compiler could not run (project check capacity was busy or unavailable); no edit resolves this. "
    + "The batch stays queued and is checked at the next tool batch; a commit stays blocked until it is checked. "
    + "A tool batch repeats this notice only when the pending files change.";

/** Native batch blocking cancels Claude's loop; context lets it repair the
 * final tree. Stop/commit retain the blocking verdict and the durable queue,
 * with one exception: a deferral-only verdict does not block Stop. A Stop block
 * that no edit can clear only makes the agent retry until the lease owner lets
 * go, and that owner can be the `interlinked verify` the Stop advice asked for.
 * The commit boundary keeps the block, so unchecked work is never committed. */
function deliverBatchDecision(event: HarnessEvent, decision: HarnessDecision, basis: BatchBlockBasis): HarnessDecision {
    if (decision.decision !== "block") return decision;
    const deferral = basis !== "findings";
    const batchEvent = ["PostToolBatch", "SessionEnd"].includes(event.hook_event);
    if (!batchEvent && !(deferral && event.hook_event === "Stop")) return decision;
    const { reason, rule_id: _rule, ...rest } = decision;
    if (basis === "deferral-repeated") return { ...rest, decision: "allow" };
    return { ...rest, decision: "allow", additional_context: `${reason}\n${deferral ? DEFERRAL_NOTE : REPAIR_NOTE}` };
}
