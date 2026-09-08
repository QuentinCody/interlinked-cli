// Mutation-kill suite for the survivor mutants in `pre-tool-pipeline.ts`
// (wave 34). The existing `pre-tool-pipeline.integration.test.ts` covers the
// broad decision-tree but never mocks `baseline-effect-guard.js`,
// `workspace-effects.js`, `commit-baseline-gate.js`, or
// `commit-laundering-gate.js` (real implementations run un-asserted), and
// several classifier/coordination sub-branches lack exact-value assertions.
// This file mocks every sibling module at the import boundary (matching the
// established pattern) and pins the exact observable each survivor needs.

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	ClassifierConfig,
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import { runPreToolPipeline } from "./pre-tool-pipeline.js";
import type { ServerRuntime } from "./runtime-context.js";

vi.mock("../../lib/config.js", () => ({
	readSharedConfig: vi.fn(() => ({})),
}));

vi.mock("../auto-coordinate.js", () => ({
	shouldCoordinate: vi.fn(() => false),
	injectCoordinationWarnings: vi.fn(),
}));

vi.mock("../coverage-discharge.js", () => ({
	isCoverageSuiteCommand: vi.fn(() => false),
	noteCoverageSuiteRunStart: vi.fn(),
}));

vi.mock("../evaluator/commit-baseline-gate.js", () => ({
	runCommitBaselineGate: vi.fn(() => null),
}));

vi.mock("../evaluator/commit-function-token-gate.js", () => ({
	runCommitFunctionTokenGate: vi.fn(() => null),
}));

vi.mock("../evaluator/commit-laundering-gate.js", () => ({
	runCommitLaunderingGate: vi.fn(() => null),
}));

vi.mock("../evaluator.js", () => ({
	evaluatePreToolUse: vi.fn((): HarnessDecision => ({ decision: "allow" })),
	extractPermissionPattern: vi.fn(() => null),
}));

vi.mock("../evaluator/baseline-effect-guard.js", () => ({
	baselineCallKey: vi.fn((opts: { toolUseId?: string; sessionId: string; timestamp: string }) =>
		opts.toolUseId ?? `${opts.sessionId}:${opts.timestamp}`,
	),
	rememberBaselineSnapshot: vi.fn(),
}));

vi.mock("../policy-classifier.js", () => ({
	appendShadowLog: vi.fn(),
	buildEvidenceEnvelope: vi.fn(() => ({ action_class: "network" })),
	callClassifier: vi.fn(async () => ({ label: "allow", confidence: 0.5, reasoning: "fine" })),
	createClassifierSessionState: vi.fn(() => ({ calls_this_session: 0, consecutive_failures: 0 })),
	hashEvidence: vi.fn(() => "evhash"),
}));

vi.mock("../workspace-effects.js", () => ({
	rememberWorkspaceSnapshot: vi.fn(),
	shouldObserveWorkspaceEffects: vi.fn(() => false),
}));

vi.mock("./pre-tool-coverage-gates.js", () => ({
	runCoverageWriteGate: vi.fn(async () => null),
	runCommitGate: vi.fn(async () => null),
	runMutationWriteGate: vi.fn(async () => null),
}));

vi.mock("./pre-tool-pipeline-content-scan.js", () => ({
	runContentScanRequest: vi.fn(async () => {}),
	runWebFetchProxy: vi.fn(async () => null),
}));

vi.mock("./pre-tool-pipeline-search.js", () => ({
	classifySearchTool: vi.fn(() => ({})),
	emitIndexStatusWarning: vi.fn(),
	runGrepAcceleration: vi.fn(() => null),
	runTsgoAcceleration: vi.fn(() => null),
}));

vi.mock("./pre-tool-pipeline-stages.js", () => ({
	captureDiffAwareBaseline: vi.fn(),
	injectStructureContext: vi.fn(),
	runProjectWideGitGate: vi.fn(),
	runProjectWideGitGateAsync: vi.fn(async () => {}),
	runTddCommitGate: vi.fn(),
}));

vi.mock("./runtime-context.js", async () => {
	const actual =
		await vi.importActual<typeof import("./runtime-context.js")>("./runtime-context.js");
	return {
		summarizeToolInput: actual.summarizeToolInput,
		getGraphForFile: vi.fn(() => ({}) as unknown),
		getAutoCoordState: vi.fn(() => ({
			lastCoordAt: 0,
			lastCoordTs: 0,
			consecutiveMisses: 0,
			totalCheckins: 0,
			disabled: false,
		})),
	};
});

import { shouldCoordinate } from "../auto-coordinate.js";
import { evaluatePreToolUse, extractPermissionPattern } from "../evaluator.js";
import {
	baselineCallKey,
	rememberBaselineSnapshot,
} from "../evaluator/baseline-effect-guard.js";
import { runCommitBaselineGate } from "../evaluator/commit-baseline-gate.js";
import { runCommitLaunderingGate } from "../evaluator/commit-laundering-gate.js";
import { appendShadowLog, callClassifier } from "../policy-classifier.js";
import { rememberWorkspaceSnapshot, shouldObserveWorkspaceEffects } from "../workspace-effects.js";
import { runCoverageWriteGate, runMutationWriteGate } from "./pre-tool-coverage-gates.js";
import { getAutoCoordState, getGraphForFile } from "./runtime-context.js";

const mShouldCoordinate = shouldCoordinate as unknown as Mock;
const mEvaluate = evaluatePreToolUse as unknown as Mock;
const mExtractPattern = extractPermissionPattern as unknown as Mock;
const mRunCommitBaselineGate = runCommitBaselineGate as unknown as Mock;
const mBaselineCallKey = baselineCallKey as unknown as Mock;
const mRememberBaselineSnapshot = rememberBaselineSnapshot as unknown as Mock;
const mRunCommitLaunderingGate = runCommitLaunderingGate as unknown as Mock;
const mAppendShadow = appendShadowLog as unknown as Mock;
const mCallClassifier = callClassifier as unknown as Mock;
const mRememberWorkspaceSnapshot = rememberWorkspaceSnapshot as unknown as Mock;
const mShouldObserveWorkspaceEffects = shouldObserveWorkspaceEffects as unknown as Mock;
const mRunCoverageWriteGate = runCoverageWriteGate as unknown as Mock;
const mRunMutationWriteGate = runMutationWriteGate as unknown as Mock;
const mGetAutoCoord = getAutoCoordState as unknown as Mock;
const mGetGraphForFile = getGraphForFile as unknown as Mock;

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		...partial,
	};
}

function makeSession(partial: Record<string, unknown> = {}): SessionTrajectory {
	return {
		agent_name: "session-agent",
		tool_call_count: 5,
		tool_sequence: [],
		taint_sources: [],
		pending_completions: new Map(),
		acknowledged_checks: new Set(["shell-sandbox-evidence"]),
		...partial,
	} as unknown as SessionTrajectory;
}

function makeRules(partial: Record<string, unknown> = {}): GuardRulesConfig {
	return { rules: [], ...partial } as unknown as GuardRulesConfig;
}

function makeCtx(overrides: Record<string, unknown> = {}): ServerRuntime {
	return {
		cwd: "/repo",
		interlinkedDir: "/repo/.interlinked",
		rules: makeRules(),
		cohort: {},
		sessions: {},
		reservations: {},
		errorHistory: {},
		routeMap: {},
		serverBridge: null,
		asyncFindings: { drain: vi.fn(() => []) },
		learnedRules: { has: vi.fn(() => false), observe: vi.fn(() => null) },
		asyncAnalysis: { consume: vi.fn(() => []) },
		compiledAllowlist: [],
		classifierSessions: new Map(),
		autoCoordStates: new Map(),
		autoCoordConfig: { max_misses_before_disable: 5, timeout_ms: 2000 },
		indexWarningSent: new Set(),
		preEditBaselines: new Map(),
		trigramIndex: null,
		fileContentCache: { set: vi.fn() },
		log: vi.fn(),
		logAlways: vi.fn(),
		writeClassifierStatus: vi.fn(),
		writeReviewPendingMarker: vi.fn(),
		...overrides,
	} as unknown as ServerRuntime;
}

function escalation(partial: Partial<EscalationRequest> = {}): EscalationRequest {
	return {
		trigger: "external_url",
		summary: "egress to a vendor host",
		tool_name: "WebFetch",
		tool_input_redacted: {},
		sensitivity_level: "Public",
		step_number: 3,
		recent_tool_sequence: [],
		...partial,
	};
}

function classifierConfig(partial: Partial<ClassifierConfig> = {}): ClassifierConfig {
	return {
		enabled: true,
		mode: "shadow",
		provider: "openai_compatible",
		endpoint: "https://example.invalid/v1/chat",
		api_key_env: "VENDOR_KEY",
		model: "vendor-model-v6",
		timeout_ms: 3000,
		max_input_tokens: 800,
		confidence_threshold: 0.8,
		max_calls_per_session: 50,
		...partial,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mEvaluate.mockImplementation((): HarnessDecision => ({ decision: "allow" }));
	mRunCommitBaselineGate.mockReturnValue(null);
	mRunCommitLaunderingGate.mockReturnValue(null);
	mBaselineCallKey.mockImplementation(
		(opts: { toolUseId?: string; sessionId: string; timestamp: string }) =>
			opts.toolUseId ?? `${opts.sessionId}:${opts.timestamp}`,
	);
	mShouldObserveWorkspaceEffects.mockReturnValue(false);
	mRunCoverageWriteGate.mockResolvedValue(null);
	mRunMutationWriteGate.mockResolvedValue(null);
	mShouldCoordinate.mockReturnValue(false);
	mCallClassifier.mockResolvedValue({ label: "allow", confidence: 0.5, reasoning: "fine" });
	mGetAutoCoord.mockReturnValue({
		lastCoordAt: 0,
		lastCoordTs: 0,
		consecutiveMisses: 0,
		totalCheckins: 0,
		disabled: false,
	});
	mGetGraphForFile.mockReturnValue({});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// dry_run gate (mutants: e6773c7b, 6b87298e, ff2dc5b2, abe53d19)
// ---------------------------------------------------------------------------

describe("dry-run baseline/workspace snapshot gate", () => {
	// test-contract: exact-observable — dry_run suppresses the snapshot arm
	it("skips baseline snapshotting entirely when event.dry_run is true", async () => {
		await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Read", dry_run: true } as Partial<HarnessEvent>),
			makeSession(),
		);
		expect(mRememberBaselineSnapshot).not.toHaveBeenCalled();
	});

	// test-contract: exact-observable — a real (non-dry) call snapshots
	it("captures the baseline snapshot when event.dry_run is false/absent", async () => {
		await runPreToolPipeline(makeCtx(), ev({ tool_name: "Read" }), makeSession());
		expect(mRememberBaselineSnapshot).toHaveBeenCalledOnce();
		expect(mRememberBaselineSnapshot).toHaveBeenCalledWith("s:2026-04-23T00:00:00.000Z", "/repo");
	});
});

// ---------------------------------------------------------------------------
// baselineCallKey object literal (mutant: 8ba72b40)
// ---------------------------------------------------------------------------

describe("baselineCallKey argument", () => {
	// test-contract: exact-observable — the key components reach baselineCallKey
	it("passes toolUseId/sessionId/timestamp through to baselineCallKey", async () => {
		await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Read", tool_use_id: "tu-1", timestamp: "2026-05-01T00:00:00.000Z" }),
			makeSession(),
		);
		expect(mBaselineCallKey).toHaveBeenCalledWith({
			toolUseId: "tu-1",
			sessionId: "s",
			timestamp: "2026-05-01T00:00:00.000Z",
		});
	});
});

// ---------------------------------------------------------------------------
// workspace-effects gate (mutants: 7411313a, 65a69485, 4834356b)
// ---------------------------------------------------------------------------

describe("workspace snapshot gate", () => {
	// test-contract: exact-observable — false result means no workspace snapshot
	it("does not capture a workspace snapshot when shouldObserveWorkspaceEffects is false", async () => {
		mShouldObserveWorkspaceEffects.mockReturnValue(false);
		await runPreToolPipeline(makeCtx(), ev({ tool_name: "Edit" }), makeSession());
		expect(mRememberWorkspaceSnapshot).not.toHaveBeenCalled();
	});

	// test-contract: exact-observable — true result captures the snapshot
	it("captures a workspace snapshot when shouldObserveWorkspaceEffects is true", async () => {
		mShouldObserveWorkspaceEffects.mockReturnValue(true);
		await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Edit", tool_use_id: "tu-2" }),
			makeSession(),
		);
		expect(mRememberWorkspaceSnapshot).toHaveBeenCalledWith({
			toolUseId: "tu-2",
			sessionId: "s",
			root: "/repo",
		});
	});
});

// ---------------------------------------------------------------------------
// filePath || CWD passed to getGraphForFile (mutants: 4797a31c, a1eaf4e1, 79f254918)
// ---------------------------------------------------------------------------

describe("graph resolution filePath fallback", () => {
	// test-contract: exact-observable — a present filePath wins over CWD
	it("resolves the graph using the event filePath when present", async () => {
		await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Read", tool_input: { file_path: "src/x.ts" } }),
			makeSession(),
		);
		expect(mGetGraphForFile).toHaveBeenCalledWith(expect.anything(), "src/x.ts");
	});

	// test-contract: exact-observable — an absent filePath falls back to CWD
	it("resolves the graph using CWD when filePath is absent", async () => {
		await runPreToolPipeline(makeCtx(), ev({ tool_name: "Bash" }), makeSession());
		expect(mGetGraphForFile).toHaveBeenCalledWith(expect.anything(), "/repo");
	});
});

// ---------------------------------------------------------------------------
// commit-baseline / commit-laundering short circuits (mutants: 623a686b, 064080e8, ac89672b)
// ---------------------------------------------------------------------------

describe("commit-baseline and laundering gate short circuits", () => {
	// test-contract: exact-observable — a commit-baseline verdict short-circuits
	it("returns the commit-baseline gate's decision when it fires", async () => {
		const preDecision: HarnessDecision = { decision: "allow" };
		mEvaluate.mockReturnValue(preDecision);
		mRunCommitBaselineGate.mockReturnValue({ decision: "block", reason: "BASELINE-LOOSENED" });
		const ctx = makeCtx();
		const event = ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } });
		const decision = await runPreToolPipeline(ctx, event, makeSession());
		expect(decision).toEqual({ decision: "block", reason: "BASELINE-LOOSENED" });
		expect(mRunCommitBaselineGate).toHaveBeenCalledWith(event, preDecision);
	});

	// test-contract: exact-observable — a laundering verdict short-circuits
	it("returns the commit-laundering gate's decision when it fires", async () => {
		mRunCommitLaunderingGate.mockReturnValue({ decision: "block", reason: "LAUNDERED" });
		const ctx = makeCtx();
		const event = ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } });
		const session = makeSession();
		const decision = await runPreToolPipeline(ctx, event, session);
		expect(decision).toEqual({ decision: "block", reason: "LAUNDERED" });
		expect(mRunCommitLaunderingGate).toHaveBeenCalledWith(
			event,
			session,
			expect.objectContaining({ nowMs: expect.any(Number) }),
		);
	});

	// test-contract: exact-observable — nowMs is a real timestamp, not {}
	it("passes a numeric nowMs to the commit-laundering gate", async () => {
		await runPreToolPipeline(makeCtx(), ev({ tool_name: "Bash" }), makeSession());
		expect(mRunCommitLaunderingGate).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ nowMs: expect.any(Number) }),
		);
	});
});

// ---------------------------------------------------------------------------
// combineMetricGateDecisions (mutant: eb56d8a6)
// ---------------------------------------------------------------------------

describe("combineMetricGateDecisions", () => {
	// test-contract: exact-observable — both gates firing merges BOTH warning sets
	it("merges mutation warnings onto the coverage decision when both gates fire", async () => {
		mRunCoverageWriteGate.mockResolvedValue({ decision: "block", reason: "COV", warnings: ["COVW"] });
		mRunMutationWriteGate.mockResolvedValue({ decision: "allow", warnings: ["MUTW"] });
		const decision = await runPreToolPipeline(makeCtx(), ev({ tool_name: "Edit" }), makeSession());
		expect(decision.warnings).toEqual(["COVW", "MUTW"]);
		expect(decision.reason).toBe("COV");
	});
});

// ---------------------------------------------------------------------------
// runClassifierEscalation exact-value assertions
// (mutants: 55d98539, e7cbae20, 73d799e7, aa9fe5ef, 7ec13f00, 22433113, ef3056c9, f120c217)
// ---------------------------------------------------------------------------

describe("classifier escalation exact observables", () => {
	function classifierCtx(cfg: Partial<ClassifierConfig> = {}): ServerRuntime {
		return makeCtx({ rules: makeRules({ policy_classifier: classifierConfig(cfg) }) });
	}

	// test-contract: exact-observable — a fresh classifierState object is created
	// exactly once and re-used; mutating `!classifierState` to `true` would
	// overwrite it (a new object reference) on the second call.
	it("keeps the identity of an already-seeded classifier session state", async () => {
		mEvaluate.mockImplementation(() => ({ decision: "allow", _escalation: escalation() }));
		const ctx = classifierCtx();
		const seeded = { calls_this_session: 7, consecutive_failures: 0 };
		ctx.classifierSessions.set("s", seeded);
		await runPreToolPipeline(ctx, ev({ tool_name: "WebFetch" }), makeSession());
		expect(ctx.classifierSessions.get("s")).toBe(seeded);
	});

	// test-contract: exact-observable — Date.now() diff, not sum
	it("computes latencyMs as a subtraction (not a sum) of two Date.now() reads", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		// The pipeline calls Date.now() once earlier (commit-laundering-gate's
		// `nowMs`) before the classifier's own start/end reads, so the
		// classifierStart/latency pair is calls #2 and #3, not #1 and #2.
		let call = 0;
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => {
			call++;
			if (call === 2) return 1_000_000;
			if (call === 3) return 1_000_500;
			return realNow();
		});
		const ctx = classifierCtx();
		await runPreToolPipeline(ctx, ev({ tool_name: "WebFetch" }), makeSession());
		expect(ctx.writeClassifierStatus).toHaveBeenCalledWith(
			expect.stringContaining(":500ms"),
		);
		expect(ctx.writeClassifierStatus).not.toHaveBeenCalledWith(
			expect.stringContaining(":2000500ms"),
		);
	});

	// test-contract: exact-observable — label must be "deny", not just truthy
	it("keeps would_have_changed false for a high-confidence 'allow' label", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		mCallClassifier.mockResolvedValue({ label: "allow", confidence: 0.99, reasoning: "fine" });
		await runPreToolPipeline(classifierCtx(), ev({ tool_name: "WebFetch" }), makeSession());
		expect(mAppendShadow).toHaveBeenCalledWith(
			expect.objectContaining({ would_have_changed: false }),
			"/repo",
		);
	});

	// test-contract: exact-observable — boundary case distinguishes >= from >
	it("treats confidence exactly at the threshold as would_have_changed=true (>=)", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		mCallClassifier.mockResolvedValue({ label: "deny", confidence: 0.8, reasoning: "boundary" });
		await runPreToolPipeline(
			classifierCtx({ confidence_threshold: 0.8 }),
			ev({ tool_name: "WebFetch" }),
			makeSession(),
		);
		expect(mAppendShadow).toHaveBeenCalledWith(
			expect.objectContaining({ would_have_changed: true }),
			"/repo",
		);
	});

	// test-contract: exact-observable — a truthy threshold must be used via ||,
	// not && (a nonzero threshold picked by && would be the 0.8 fallback instead).
	it("uses the configured (truthy) threshold, not the 0.8 fallback (|| vs &&)", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		mCallClassifier.mockResolvedValue({ label: "deny", confidence: 0.85, reasoning: "x" });
		await runPreToolPipeline(
			classifierCtx({ confidence_threshold: 0.9 }),
			ev({ tool_name: "WebFetch" }),
			makeSession(),
		);
		// 0.85 >= 0.9 (real threshold) is false; 0.85 >= 0.8 (&& fallback) would be true.
		expect(mAppendShadow).toHaveBeenCalledWith(
			expect.objectContaining({ would_have_changed: false }),
			"/repo",
		);
	});

	// test-contract: exact-observable — local_decision is the literal "allow"
	it("records local_decision literally as 'allow' in the shadow log", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		await runPreToolPipeline(classifierCtx(), ev({ tool_name: "WebFetch" }), makeSession());
		expect(mAppendShadow).toHaveBeenCalledWith(
			expect.objectContaining({ local_decision: "allow" }),
			"/repo",
		);
	});

	// test-contract: exact-observable — warnings seed is [] (exact length, not 2)
	it("produces exactly one shadow warning when preDecision.warnings started empty", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		const decision = await runPreToolPipeline(
			classifierCtx(),
			ev({ tool_name: "WebFetch" }),
			makeSession(),
		);
		expect(decision.warnings).toHaveLength(1);
	});

	// test-contract: exact-observable — the log message names the trigger/latency
	it("logs the classifier outcome with the escalation trigger", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation({ trigger: "external_url" }) });
		const ctx = classifierCtx();
		await runPreToolPipeline(ctx, ev({ tool_name: "WebFetch" }), makeSession());
		expect(ctx.log).toHaveBeenCalledWith(
			expect.stringMatching(/^Policy classifier: allow \(0\.50\) for external_url — \d+ms$/),
		);
	});
});

// ---------------------------------------------------------------------------
// runAutoCoordination exact observables
// (mutants: 9d4e4050, 6c477e2f, 74cef67a, 78bf4471, d0d9ddd7, 3a821afc, 6ef35320, 54641320, 02fce71f)
// ---------------------------------------------------------------------------

describe("auto-coordination exact observables", () => {
	// test-contract: exact-observable — the resolved tool_name reaches shouldCoordinate
	it("passes the actual event.tool_name to shouldCoordinate", async () => {
		await runPreToolPipeline(
			makeCtx({ serverBridge: { fetchCoordinationState: vi.fn(async () => null) } }),
			ev({ tool_name: "Edit" }),
			makeSession(),
		);
		expect(mShouldCoordinate).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			"Edit",
		);
	});

	// test-contract: exact-observable — an absent tool_name falls back to "" (not a sentinel)
	it("passes '' to shouldCoordinate when tool_name is absent", async () => {
		await runPreToolPipeline(
			makeCtx({ serverBridge: { fetchCoordinationState: vi.fn(async () => null) } }),
			ev({}),
			makeSession(),
		);
		expect(mShouldCoordinate).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			"",
		);
	});

	// test-contract: exact-observable — a non-allow decision skips coordination even
	// when serverBridge exists and shouldCoordinate would say yes.
	it("never checks in when the decision is not allow, even with a bridge present", async () => {
		mEvaluate.mockReturnValue({ decision: "block", reason: "no" });
		mShouldCoordinate.mockReturnValue(true);
		const fetchCoordinationState = vi.fn(async () => null);
		await runPreToolPipeline(
			makeCtx({
				serverBridge: { fetchCoordinationState, reportGuardEvent: vi.fn() },
			}),
			ev({ tool_name: "Edit" }),
			makeSession(),
		);
		expect(fetchCoordinationState).not.toHaveBeenCalled();
	});

	// test-contract: exact-observable — the log line names counts, not blank
	it("logs the unread/task-change counts on a successful check-in", async () => {
		mShouldCoordinate.mockReturnValue(true);
		const coordResponse = { unread: { total: 3, urgent: [] }, task_changes: [{ id: 1 }, { id: 2 }] };
		const ctx = makeCtx({
			serverBridge: { fetchCoordinationState: vi.fn(async () => coordResponse) },
		});
		await runPreToolPipeline(ctx, ev({ tool_name: "Edit" }), makeSession());
		expect(ctx.log).toHaveBeenCalledWith("Auto-coordination: 3 unread, 2 task changes");
	});

	// test-contract: exact-observable — the disable log line names the reason
	it("logs the disable message once the miss threshold is reached", async () => {
		mShouldCoordinate.mockReturnValue(true);
		const coordState = {
			lastCoordAt: 0,
			lastCoordTs: 0,
			consecutiveMisses: 4,
			totalCheckins: 0,
			disabled: false,
		};
		mGetAutoCoord.mockReturnValue(coordState);
		const ctx = makeCtx({
			serverBridge: { fetchCoordinationState: vi.fn(async () => null) },
			autoCoordConfig: { max_misses_before_disable: 5, timeout_ms: 2000 },
		});
		await runPreToolPipeline(ctx, ev({ tool_name: "Edit" }), makeSession());
		expect(ctx.log).toHaveBeenCalledWith("Auto-coordination: disabled after consecutive misses");
	});
});

// ---------------------------------------------------------------------------
// injectAsyncAnalysisFindings exact observables (mutants: 2a2f6880, 5335ee9b)
// ---------------------------------------------------------------------------

describe("async-analysis findings exact observables", () => {
	// test-contract: exact-observable — the warnings array starts at [] (length 1, not 2)
	it("produces exactly one async warning when preDecision.warnings started empty", async () => {
		const ctx = makeCtx({ asyncAnalysis: { consume: vi.fn(() => [{ name: "n", message: "m" }]) } });
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Edit", tool_input: { file_path: "src/x.ts" } }),
			makeSession(),
		);
		expect(decision.warnings).toHaveLength(1);
		expect(decision.warnings?.[0]).toBe("[interlinked:async] n: m");
	});

	// test-contract: exact-observable — the log names the count and file path
	it("logs the injected async-finding count and file path", async () => {
		const ctx = makeCtx({
			asyncAnalysis: {
				consume: vi.fn(() => [
					{ name: "a", message: "1" },
					{ name: "b", message: "2" },
				]),
			},
		});
		await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Edit", tool_input: { file_path: "src/x.ts" } }),
			makeSession(),
		);
		expect(ctx.log).toHaveBeenCalledWith("Injected 2 async finding(s) for src/x.ts");
	});
});

// ---------------------------------------------------------------------------
// observeLearnedRules exact observables (mutants: 4403435c, deb120e2)
// ---------------------------------------------------------------------------

describe("learned rules exact observables", () => {
	// test-contract: exact-observable — the warnings array starts at [] (length 1, not 2)
	it("produces exactly one learned-rule warning when preDecision.warnings started empty", async () => {
		mExtractPattern.mockReturnValue("Bash(npm test *)");
		const learnedRules = {
			has: vi.fn(() => false),
			observe: vi.fn(() => ({ pattern: "Bash(npm test *)", observation_count: 5 })),
		};
		const decision = await runPreToolPipeline(
			makeCtx({ learnedRules }),
			ev({ tool_name: "Bash", tool_input: { command: "npm test" } }),
			makeSession(),
		);
		expect(decision.warnings).toHaveLength(1);
	});

	// test-contract: exact-observable — the log names the learned pattern
	it("logs the learned pattern by name", async () => {
		mExtractPattern.mockReturnValue("Bash(npm test *)");
		const learnedRules = {
			has: vi.fn(() => false),
			observe: vi.fn(() => ({ pattern: "Bash(npm test *)", observation_count: 5 })),
		};
		const ctx = makeCtx({ learnedRules });
		await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Bash", tool_input: { command: "npm test" } }),
			makeSession(),
		);
		expect(ctx.log).toHaveBeenCalledWith("Learned rule: Bash(npm test *)");
	});
});
