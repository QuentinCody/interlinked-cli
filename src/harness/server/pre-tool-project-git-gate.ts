import { readToolString } from "../evaluator/tool-input-values.js";
import { listGitInvocations } from "../evaluator/commit-parse.js";
import { listWithOverflow } from "../finding-overflow.js";
import {
	checkProjectTestsClean,
	checkProjectTestsCleanAsync,
	checkProjectTypecheckClean,
	checkProjectTypecheckCleanAsync,
} from "../project-typecheck-gate.js";
import { tryAcquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import { prepareManagedPushHandoff } from "../managed-push.js";
import { traceManagedPushCommand } from "../managed-push-command.js";
import type { ProjectProcessObservation, ProjectProcessObserver } from "../project-process-observation.js";
import { randomUUID } from "node:crypto";
import { elapsedMs, recordVerificationStage, type ReuseDeniedReason, type VerificationStage } from "../verification-stages.js";
import type {
	CheckResultEntry,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import { currentRequestSignal } from "./request-cancellation.js";
import { type ServerRuntime, summarizeToolInput } from "./runtime-context.js";

/**
 * Re-read `preDecision.decision` through an opaque call boundary.
 *
 * TypeScript's control-flow narrowing does NOT get invalidated by an
 * intervening function call that mutates a property on a passed-by-reference
 * object — only by a directly-visible assignment in the same control-flow
 * graph. `applyProjectTypecheckGate(Async)` DOES set `preDecision.decision =
 * "block"` when typecheck fails, but a bare `preDecision.decision === "allow"`
 * check after that call would still be narrowed (falsely) to the literal
 * `"allow"` from the earlier guard, making the comparison read as always-true
 * to the type checker even though it is a live runtime branch. Routing the
 * read through a function call (whose declared return type is the full
 * union, not a narrowed literal) breaks that false narrowing so the check
 * stays honest — and load-bearing.
 */
function currentDecision(preDecision: HarnessDecision): HarnessDecision["decision"] {
	return preDecision.decision;
}

/** Report a project-wide git-gate block when a server bridge is configured. */
function reportGitGateGuardBlock(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	reason: string,
): void {
	if (!ctx.serverBridge) return;
	ctx.serverBridge.reportGuardEvent({
		agent_name: event.agent_name || session.agent_name || "",
		event_type: "guard_block",
		tool_name: event.tool_name,
		tool_input_summary: summarizeToolInput(event),
		decision: "block",
		reason,
		occurred_at: event.timestamp,
	});
}

function applyProjectTypecheckResults(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
	tcResults: CheckResultEntry[],
	isCommit: boolean,
): void {
	const tcWarnings = tcResults.filter((result) => result.severity === "warning");
	const tcErrors = tcResults.filter((result) => result.severity === "error");
	if (tcWarnings.length > 0) {
		const warnings = preDecision.warnings || [];
		for (const warning of tcWarnings) {
			warnings.push(`[interlinked:${warning.name}] ${warning.message}`);
		}
		preDecision.warnings = warnings;
	}
	if (tcErrors.length === 0) return;

	preDecision.decision = "block";
	preDecision.rule_id ??= "commit-typecheck-gate";
	const action = isCommit ? "commit" : "push";
	const errLines = listWithOverflow(tcErrors, (error) => `  - ${error.message}`, 10);
	preDecision.reason =
		`BLOCKED: Project typecheck failed (${tcErrors.length} error${tcErrors.length === 1 ? "" : "s"}) — CI will fail on this ${action}. ` +
		"Pre-existing errors in untouched files DO count: every commit must build clean. Fix these first:\n" +
		errLines +
		"\n\nTo bypass (NOT RECOMMENDED — CI will still fail on the PR): " +
		"INTERLINKED_SKIP_PROJECT_TYPECHECK=1 git ...";
	reportGitGateGuardBlock(
		ctx,
		event,
		session,
		`project_typecheck_clean: ${tcErrors.length} error${tcErrors.length === 1 ? "" : "s"}`,
	);
}

function applyProjectTypecheckGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
	isCommit: boolean,
): void {
	applyProjectTypecheckResults(
		ctx,
		event,
		session,
		preDecision,
		checkProjectTypecheckClean(ctx.cwd),
		isCommit,
	);
}

async function applyProjectTypecheckGateAsync(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
	isCommit: boolean,
): Promise<void> {
	applyProjectTypecheckResults(
		ctx,
		event,
		session,
		preDecision,
		await observeGitCheck(ctx.cwd, event, isCommit ? "commit" : "push", "typecheck", observe => checkProjectTypecheckCleanAsync(ctx.cwd, { observe, ...requestSignal() })),
		isCommit,
	);
}

function applyProjectTestResults(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
	testResults: CheckResultEntry[],
): void {
	const testWarnings = testResults.filter((result) => result.severity === "warning");
	const testErrors = testResults.filter((result) => result.severity === "error");
	if (testWarnings.length > 0) {
		const warnings = preDecision.warnings || [];
		for (const warning of testWarnings) {
			warnings.push(`[interlinked:${warning.name}] ${warning.message}`);
		}
		preDecision.warnings = warnings;
	}
	if (testErrors.length === 0) return;

	preDecision.decision = "block";
	preDecision.rule_id ??= "push-test-gate";
	const failLines = listWithOverflow(testErrors, (error) => `  - ${error.message}`, 10);
	preDecision.reason =
		`BLOCKED: Project tests failed (${testErrors.length} failure${testErrors.length === 1 ? "" : "s"}) — CI will fail on this push. ` +
		"Pre-existing test failures DO count: every push must build clean. Failing tests:\n" +
		failLines +
		"\n\nTo bypass (NOT RECOMMENDED — CI will still fail on the PR): " +
		"INTERLINKED_SKIP_PROJECT_TESTS=1 git push ...";
	reportGitGateGuardBlock(
		ctx,
		event,
		session,
		`project_tests_clean: ${testErrors.length} failure${testErrors.length === 1 ? "" : "s"}`,
	);
}

function applyProjectTestGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): void {
	applyProjectTestResults(
		ctx,
		event,
		session,
		preDecision,
		checkProjectTestsClean(ctx.cwd),
	);
}

async function applyProjectTestGateAsync(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
	admissionAlreadyHeld = false,
): Promise<void> {
	applyProjectTestResults(
		ctx,
		event,
		session,
		preDecision,
		await observeGitCheck(ctx.cwd, event, "push", "tests", observe => checkProjectTestsCleanAsync(ctx.cwd,
            { ...(admissionAlreadyHeld ? { admissionAlreadyHeld: true } : {}), observe, ...requestSignal() })),
	);
}

/**
 * One correlation id per judged git command, shared by every ledger row the daemon writes for it and handed to
 * the native push so the hook's rows join them. Keyed by event so the sync and async gates agree.
 */
const traces = new WeakMap<HarnessEvent, string>();
function traceOf(event: HarnessEvent): string {
    let trace = traces.get(event);
    if (!trace) { trace = randomUUID(); traces.set(event, trace); }
    return trace;
}

/**
 * The hook client's disconnect signal for this request, as an options fragment. A client that timed out has no
 * use for the verdict, and its heavyweight child must not keep the host slot the Git hook it started now waits for.
 */
function requestSignal(): { signal?: AbortSignal } {
    const signal = currentRequestSignal();
    return signal ? { signal } : {};
}

/** Why a deferred legacy check produced no verdict: the client left, or the observed resource reason / first message. */
function deferredReason(observation: ProjectProcessObservation | undefined, results: CheckResultEntry[] | undefined): ReuseDeniedReason {
    if (currentRequestSignal()?.aborted) return "interrupted";
    return `plan-not-reusable:${observation?.resourceReason ?? results?.[0]?.message ?? "Project check unavailable"}`;
}

/** One ledger row per legacy check; lower process layers only supply observations. */
async function observeGitCheck(root: string, event: HarnessEvent, stage: VerificationStage, check: string, work: (observe: ProjectProcessObserver) => Promise<CheckResultEntry[]>): Promise<CheckResultEntry[]> {
    const started = Date.now();
    let observation: ProjectProcessObservation | undefined;
    let results: CheckResultEntry[] | undefined;
    try {
        results = await work(value => { observation = value; });
        return results;
    } finally {
        const status = legacyCheckStatus(results, observation);
        recordVerificationStage(root, { stage, check: `pre-tool:project-${check}`, identity: null, status, reused: false, trace: traceOf(event), owner: "daemon",
            session: event.session_id, wait_capacity_ms: observation?.waitMs ?? elapsedMs(started), exec_ms: observation?.execMs ?? 0,
            peak_rss_bytes: observation?.peakRssBytes ?? null,
            ...(observation?.resourceBudget ? { rss_budget_bytes: observation.resourceBudget.maxRssBytes } : {}),
            ...(observation?.heapLimitMb !== undefined ? { heap_limit_mb: observation.heapLimitMb } : {}),
            ...(status === "deferred" ? { reuse_denied_reason: deferredReason(observation, results) } : {}),
        });
    }
}

function legacyCheckStatus(results: CheckResultEntry[] | undefined, observation: ProjectProcessObservation | undefined): string {
    if (!results) return "deferred";
    if (results.some(result => result.severity === "error")) return "failed";
    if (results.some(result => /deferred|timed_out|failed_to_run/.test(result.name))) return "deferred";
    if (results.some(result => result.name.endsWith("_skipped"))) return "skipped";
    return observation ? "passed" : "not-applicable";
}

/** Share the execution parser used by commit safety gates; quoted examples are data. */
function gitGateActions(command: string): { isCommit: boolean; isPush: boolean } {
    const verbs = new Set(listGitInvocations(command).map(invocation => invocation.verb));
    return { isCommit: verbs.has("commit"), isPush: verbs.has("push") };
}

/** Run the legacy synchronous commit/push project gate. */
export function runProjectWideGitGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): void {
	if (preDecision.decision !== "allow" || event.tool_name !== "Bash") return;
	const cmdStr = readToolString(event.tool_input?.command);
	const { isCommit, isPush } = gitGateActions(cmdStr);
	if (!isCommit && !isPush) return;

	applyProjectTypecheckGate(ctx, event, session, preDecision, isCommit);
	if (currentDecision(preDecision) === "allow" && isPush) {
		applyProjectTestGate(ctx, event, session, preDecision);
	}
}

/** Run the production async commit/push gate under one heavyweight lease. */
export async function runProjectWideGitGateAsync(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): Promise<void> {
	if (preDecision.decision !== "allow" || event.tool_name !== "Bash") return;
	const cmdStr = readToolString(event.tool_input?.command);
	const { isCommit, isPush } = gitGateActions(cmdStr);
	if (!isCommit && !isPush) return;
	if (isPush && !isCommit && !preDecision.updated_input && applyManagedPush(ctx, event, preDecision, cmdStr)) return;

	const releaseHeavyProcess = tryAcquireProjectHeavyProcessLease(ctx.cwd);
	if (!releaseHeavyProcess) {
		recordVerificationStage(ctx.cwd, { stage: isCommit ? "commit" : "push", check: "pre-tool:project-git", identity: null, status: "deferred", reused: false, trace: traceOf(event), owner: "daemon", session: event.session_id, wait_capacity_ms: 0, exec_ms: 0, peak_rss_bytes: null, reuse_denied_reason: "capacity-timeout" });
		const warnings = preDecision.warnings || [];
		warnings.push(
			"[interlinked:project_git_gate_deferred] Project-wide typecheck/tests were NOT CHECKED because another heavyweight project check is active. Retry before committing or pushing.",
		);
		preDecision.warnings = warnings;
		return;
	}

	try {
		await applyProjectTypecheckGateAsync(ctx, event, session, preDecision, isCommit);
		if (currentDecision(preDecision) === "allow" && isPush) {
			await applyProjectTestGateAsync(ctx, event, session, preDecision, true);
		}
	} finally {
		releaseHeavyProcess();
	}
}

/**
 * Hand a recognized push to its pinned Git hook, or record why the legacy checks keep it. Both outcomes leave
 * one ledger row, and a fallback also tells the agent its cause (names only; no environment values).
 */
function applyManagedPush(ctx: ServerRuntime, event: HarnessEvent, decision: HarnessDecision, command: string): boolean {
    const started = Date.now();
    const trace = traceOf(event);
    const prepared = prepareManagedPushHandoff(ctx.cwd, command, event.agent_source, undefined, { trace });
    if (prepared.kind === "fallback") {
        // A command or client the handoff never covers is not a fallback worth a row: the legacy rows are its record.
        if (prepared.cause.startsWith("unsupported-")) return false;
        recordVerificationStage(ctx.cwd, { stage: "push", check: "pre-tool:managed-push", identity: null, status: "fallback", reused: false, trace, owner: "daemon",
            session: event.session_id, validate_ms: elapsedMs(started), exec_ms: 0, peak_rss_bytes: null, reuse_denied_reason: `handoff-fallback:${prepared.cause}` });
        const warnings = decision.warnings || [];
        warnings.push(`[interlinked:managed_push_fallback] Native push handoff not used (${prepared.cause}: ${prepared.detail}); the daemon's legacy typecheck/test checks run instead.`);
        decision.warnings = warnings;
        const correlated = traceManagedPushCommand(command, trace);
        if (correlated) decision.updated_input = { ...event.tool_input, command: correlated };
        return false;
    }
    decision.updated_input = { ...event.tool_input, command: prepared.command };
    recordVerificationStage(ctx.cwd, { stage: "push", check: "pre-tool:managed-push", identity: null, status: "delegated", reused: false, trace, owner: "git-hook",
        session: event.session_id, validate_ms: elapsedMs(started), exec_ms: 0, peak_rss_bytes: null });
    return true;
}
