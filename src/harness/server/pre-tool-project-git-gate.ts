import { listWithOverflow } from "../finding-overflow.js";
import {
	checkProjectTestsClean,
	checkProjectTestsCleanAsync,
	checkProjectTypecheckClean,
	checkProjectTypecheckCleanAsync,
} from "../project-typecheck-gate.js";
import { tryAcquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import type {
	CheckResultEntry,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
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

/** Report a project-wide git-gate block when a server bridge is configured.
 *  `session` is typed non-optional at every OTHER call site in this module,
 *  but the "reports an absent session agent as an empty name without
 *  throwing" test deliberately calls the exported gate with
 *  `undefined as unknown as SessionTrajectory` to model a caller that
 *  defeats the type system — so this one parameter is honestly optional. */
function reportGitGateGuardBlock(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	reason: string,
): void {
	if (!ctx.serverBridge) return;
	ctx.serverBridge.reportGuardEvent({
		agent_name: event.agent_name || session?.agent_name || "",
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
		await checkProjectTypecheckCleanAsync(ctx.cwd),
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
		await checkProjectTestsCleanAsync(
			ctx.cwd,
			admissionAlreadyHeld ? { admissionAlreadyHeld: true } : {},
		),
	);
}

/** Run the legacy synchronous commit/push project gate. */
export function runProjectWideGitGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): void {
	if (preDecision.decision !== "allow" || event.tool_name !== "Bash") return;
	const cmdStr = (event.tool_input?.command as string) || "";
	const isCommit = /\bgit\s+commit\b/.test(cmdStr);
	const isPush = /\bgit\s+push\b/.test(cmdStr);
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
	const cmdStr = (event.tool_input?.command as string) || "";
	const isCommit = /\bgit\s+commit\b/.test(cmdStr);
	const isPush = /\bgit\s+push\b/.test(cmdStr);
	if (!isCommit && !isPush) return;

	const releaseHeavyProcess = tryAcquireProjectHeavyProcessLease(ctx.cwd);
	if (!releaseHeavyProcess) {
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
