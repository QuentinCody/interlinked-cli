import type { CoordinationResponse } from "../auto-coordinate.js";
import { nonNull } from "../../lib/non-null.js";
import { makeServerRuntime, makeServerRules, makeTrigramIndex } from "./__tests__/fixtures.js";
import { makeSession as makeSessionFixture } from "../__tests__/fixtures/evaluator.js";
// Behavioral coverage for the PreToolUse pipeline orchestrator
// (`runPreToolPipeline`). Cyclomatic ~108 — every imported sibling module is
// mocked at the import boundary so each gate, early-return, ternary, &&/||/??,
// and catch is driven deterministically. `node:child_process` is mocked so the
// two git-freshness branches (grep-substitution gate + index-status warning)
// are reachable without touching a real repo. We import the real
// `./pre-tool-pipeline.js` and assert the decision / warnings it returns.
//
// `makeCtx` / `makeRules` / `makeSession` take loose record literals and cast
// once (`as unknown as ...`) so a test supplies just the fields the
// orchestrator reads, without satisfying every field of the large runtime
// interfaces — and without per-property `undefined`-widening casts that
// exactOptionalPropertyTypes rejects.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ClassifierConfig,
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	PolicyClassification,
	SessionTrajectory,
} from "../types.js";
import { runPreToolPipeline } from "./pre-tool-pipeline.js";
import type { ServerRuntime } from "./runtime-context.js";

// ---------------------------------------------------------------------------
// Module mocks (vitest hoists these above the real-module imports below).
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
	execSync: vi.fn(() => ""),
}));

vi.mock("../../lib/config.js", () => ({
	readSharedConfig: vi.fn(() => ({})),
}));

vi.mock("../auto-coordinate.js", () => ({
	shouldCoordinate: vi.fn(() => false),
	injectCoordinationWarnings: vi.fn(),
}));

vi.mock("../content-scanner/allowlist.js", () => ({
	applyAllowlist: vi.fn((findings) => ({ kept: findings, suppressed: [] })),
}));

vi.mock("../content-scanner/policy.js", () => ({
	decideFromFindings: vi.fn(() => ({ decision: "allow" })),
}));

vi.mock("../content-scanner/redact-preview.js", () => ({
	buildAskReason: vi.fn(() => ({ reason: "ASK-REASON", systemMessage: "SYS-MSG" })),
	writePendingPrompt: vi.fn(() => ".interlinked/scanner/pending/x.json"),
}));

vi.mock("../content-scanner/review-files.js", () => ({
	countPendingReviews: vi.fn(() => 2),
}));

vi.mock("../content-scanner/web-fetch-proxy.js", () => ({
	fetchAndScan: vi.fn(async () => ({ kind: "fail_open", detail: "transient" })),
}));

vi.mock("../evaluator.js", () => ({
	evaluatePreToolUse: vi.fn((): HarnessDecision => ({ decision: "allow" })),
	extractPermissionPattern: vi.fn(() => null),
}));

vi.mock("../evaluator/coverage-write-guard.js", () => ({
	checkCoverageWrite: vi.fn(async (): Promise<HarnessDecision | null> => null),
}));

vi.mock("../coverage-discharge.js", () => ({
	isCoverageSuiteCommand: vi.fn(() => false),
	noteCoverageSuiteRunStart: vi.fn(),
}));

// The two coverage phase helpers were extracted to a sibling; mock it directly so
// the pipeline wiring is asserted without driving the real overlay / suite / git.
vi.mock("./pre-tool-coverage-gates.js", () => ({
	runCoverageWriteGate: vi.fn(async (): Promise<HarnessDecision | null> => null),
	runCommitGate: vi.fn(async (): Promise<HarnessDecision | null> => null),
	runMutationWriteGate: vi.fn(async (): Promise<HarnessDecision | null> => null),
}));

vi.mock("../grep-accelerator.js", () => ({
	checkGrepAcceleration: vi.fn(() => null),
	findRipgrep: vi.fn(() => "/usr/bin/rg"),
}));

vi.mock("../policy-classifier.js", () => ({
	appendShadowLog: vi.fn(),
	buildEvidenceEnvelope: vi.fn(() => ({ action_class: "network" })),
	callClassifier: vi.fn(
		async (): Promise<PolicyClassification> => ({
			label: "allow",
			confidence: 0.5,
			reasoning: "looks fine",
		}),
	),
	createClassifierSessionState: vi.fn(() => ({ calls_this_session: 0, consecutive_failures: 0 })),
	hashEvidence: vi.fn(() => "evhash"),
}));

vi.mock("../server-tsgo-bash.js", () => ({
	isBashTsc: vi.fn(() => false),
	tryTsgoRewrite: vi.fn(() => null),
}));

vi.mock("./pre-tool-pipeline-stages.js", () => ({
	captureDiffAwareBaseline: vi.fn(),
	injectStructureContext: vi.fn(),
	runProjectWideGitGate: vi.fn(),
	runProjectWideGitGateAsync: vi.fn(async () => {}),
	runTddCommitGate: vi.fn(),
}));

// runtime-context.js: keep summarizeToolInput real (a pure helper used by the
// guard-event report), but stub the two graph/coord lookups so they never
// touch the filesystem.
vi.mock("./runtime-context.js", async () => {
	const actual =
		await vi.importActual<typeof import("./runtime-context.js")>("./runtime-context.js");
	return {
		summarizeToolInput: actual.summarizeToolInput,
		getGraphForFile: vi.fn(() => ({})),
		getAutoCoordState: vi.fn(() => ({
			lastCoordAt: 0,
			lastCoordTs: 0,
			consecutiveMisses: 0,
			totalCheckins: 0,
			disabled: false,
		})),
	};
});

// Bind to the mocked exports so each test can re-program return values.
import { execSync } from "node:child_process";
import { injectCoordinationWarnings, shouldCoordinate } from "../auto-coordinate.js";
import { applyAllowlist } from "../content-scanner/allowlist.js";
import { decideFromFindings } from "../content-scanner/policy.js";
import { buildAskReason, writePendingPrompt } from "../content-scanner/redact-preview.js";
import { fetchAndScan } from "../content-scanner/web-fetch-proxy.js";
import { isCoverageSuiteCommand, noteCoverageSuiteRunStart } from "../coverage-discharge.js";
import { checkCoverageWrite } from "../evaluator/coverage-write-guard.js";
import { evaluatePreToolUse, extractPermissionPattern } from "../evaluator.js";
import { checkGrepAcceleration, findRipgrep } from "../grep-accelerator.js";
import { appendShadowLog, callClassifier } from "../policy-classifier.js";
import { isBashTsc, tryTsgoRewrite } from "../server-tsgo-bash.js";
import { runCommitGate, runCoverageWriteGate } from "./pre-tool-coverage-gates.js";
import {
	captureDiffAwareBaseline,
	injectStructureContext,
	runProjectWideGitGateAsync,
	runTddCommitGate,
} from "./pre-tool-pipeline-stages.js";
import { getAutoCoordState } from "./runtime-context.js";

const mExecSync = vi.mocked(execSync);
const mShouldCoordinate = vi.mocked(shouldCoordinate);
const mInjectCoord = vi.mocked(injectCoordinationWarnings);
const mApplyAllowlist = vi.mocked(applyAllowlist);
const mDecideFromFindings = vi.mocked(decideFromFindings);
const mBuildAskReason = vi.mocked(buildAskReason);
const mWritePendingPrompt = vi.mocked(writePendingPrompt);
const mFetchAndScan = vi.mocked(fetchAndScan);
const mIsCoverageSuiteCommand = vi.mocked(isCoverageSuiteCommand);
const mNoteCoverageSuiteRunStart = vi.mocked(noteCoverageSuiteRunStart);
const mEvaluate = vi.mocked(evaluatePreToolUse);
const mCheckCoverage = vi.mocked(checkCoverageWrite);
const mRunCoverageGate = vi.mocked(runCoverageWriteGate);
const mRunCommitGate = vi.mocked(runCommitGate);
const mExtractPattern = vi.mocked(extractPermissionPattern);
const mCheckGrep = vi.mocked(checkGrepAcceleration);
const mFindRg = vi.mocked(findRipgrep);
const mAppendShadow = vi.mocked(appendShadowLog);
const mCallClassifier = vi.mocked(callClassifier);
const mIsBashTsc = vi.mocked(isBashTsc);
const mTryTsgo = vi.mocked(tryTsgoRewrite);
const mCaptureBaseline = vi.mocked(captureDiffAwareBaseline);
const mInjectStructure = vi.mocked(injectStructureContext);
const mProjectWide = vi.mocked(runProjectWideGitGateAsync);
const mTddGate = vi.mocked(runTddCommitGate);
const mGetAutoCoord = vi.mocked(getAutoCoordState);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		...partial,
	};
}

function makeSession(partial: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return ({ ...makeSessionFixture(),
		agent_name: "session-agent",
		tool_call_count: 5,
		tool_sequence: [],
		taint_sources: [],
		pending_completions: new Map(),
		acknowledged_checks: new Set(["shell-sandbox-evidence"]),
		...partial,
	} satisfies SessionTrajectory);
}

function makeRules(partial: NonNullable<Parameters<typeof makeServerRules>[0]> = {}): GuardRulesConfig { return makeServerRules(partial); }

/** Minimal AsyncFindingQueue stub: drain returns the configured list. */
function asyncFindingsStub(drained: Array<{ message: string }> = []) {
	return { drain: vi.fn(() => drained.map((finding, index) => ({ id: String(index), check: "fixture", computedAt: "2026-09-08T00:00:00Z", ...finding }))) };
}

/** Minimal AsyncAnalysisManager stub: consume returns the configured list. */
function asyncAnalysisStub(consumed: Array<{ name: string; message: string }> = []) {
	return { consume: vi.fn((): ReturnType<ServerRuntime["asyncAnalysis"]["consume"]> => consumed.map((finding) => ({ source: "quality", severity: "warning", determinism: "heuristic", ...finding }))) };
}

function makeCtx(overrides: NonNullable<Parameters<typeof makeServerRuntime>[0]> = {}): ServerRuntime {
	return makeServerRuntime({
		cwd: "/repo",
		interlinkedDir: "/repo/.interlinked",
		rules: makeRules(),
		cohort: {},
		sessions: {},
		reservations: {},
		errorHistory: {},
		routeMap: {},
		serverBridge: null,
		asyncFindings: asyncFindingsStub(),
		learnedRules: { has: vi.fn(() => false), observe: vi.fn(() => null) },
		asyncAnalysis: asyncAnalysisStub(),
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
		// `contentScanner` deliberately omitted — it is optional and the default
		// (absent) is what most tests want; scanner-path tests override it.
		...overrides,
	});
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
	delete process.env.INTERLINKED_GREP_ACCELERATOR;
	// Re-establish default mock implementations cleared above. `mEvaluate` uses
	// `mockImplementation` (not `mockReturnValue`) so every call gets a FRESH
	// decision object — the orchestrator mutates the decision in place
	// (`delete preDecision._escalation`, `preDecision.warnings = …`), so a
	// shared object reference would leak state across invocations in the
	// double-invocation tests below.
	mEvaluate.mockImplementation((): HarnessDecision => ({ decision: "allow" }));
	mCheckCoverage.mockResolvedValue(null);
	mRunCoverageGate.mockResolvedValue(null);
	mRunCommitGate.mockResolvedValue(null);
	mExtractPattern.mockReturnValue(null);
	mShouldCoordinate.mockReturnValue(false);
	mApplyAllowlist.mockImplementation((findings) => ({
		kept: findings,
		suppressed: [],
	}));
	mDecideFromFindings.mockReturnValue({ decision: "allow" });
	mFetchAndScan.mockResolvedValue({ kind: "fail_open", detail: "transient" });
	mIsCoverageSuiteCommand.mockReturnValue(false);
	mCheckGrep.mockReturnValue(null);
	mFindRg.mockReturnValue("/usr/bin/rg");
	mIsBashTsc.mockReturnValue(false);
	mTryTsgo.mockReturnValue(null);
	mExecSync.mockReturnValue("");
	mCallClassifier.mockResolvedValue({
		label: "allow",
		confidence: 0.5,
		reasoning: "looks fine",
	} satisfies PolicyClassification);
	mGetAutoCoord.mockReturnValue({
		lastCoordAt: 0,
		lastCoordTs: 0,
		consecutiveMisses: 0,
		totalCheckins: 0,
		disabled: false,
	});
});

afterEach(() => {
	delete process.env.INTERLINKED_GREP_ACCELERATOR;
});

// ---------------------------------------------------------------------------
// 1. Baseline / passthrough
// ---------------------------------------------------------------------------

describe("baseline passthrough", () => {
	it("returns the evaluator's allow decision and runs the two unconditional stages", async () => {
		const ctx = makeCtx();
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Read", tool_input: { file_path: "src/x.ts" } }),
			makeSession(),
		);
		expect(decision.decision).toBe("allow");
		expect(mEvaluate).toHaveBeenCalledOnce();
		// Unconditional stage helpers always run on the non-short-circuit path.
		expect(mTddGate).toHaveBeenCalledOnce();
		expect(mProjectWide).toHaveBeenCalledOnce();
		expect(mCaptureBaseline).toHaveBeenCalledOnce();
		expect(mInjectStructure).toHaveBeenCalledOnce();
	});

	it("passes a block decision straight through (most allow-gated blocks skipped)", async () => {
		mEvaluate.mockReturnValue({ decision: "block", reason: "BLOCKED: bad" });
		const decision = await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
			makeSession(),
		);
		expect(decision.decision).toBe("block");
		expect(decision.reason).toBe("BLOCKED: bad");
	});

	it("derives filePath from tool_input.path when file_path is absent", async () => {
		const consume = vi.fn(() => []);
		const ctx = makeCtx({ asyncAnalysis: { consume } });
		await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Read", tool_input: { path: "src/from-path.ts" } }),
			makeSession(),
		);
		// `if (filePath)` true → asyncAnalysis.consume called with the path.
		expect(consume).toHaveBeenCalledWith("src/from-path.ts");
	});

	it("uses an empty filePath when neither file_path nor path is present", async () => {
		const consume = vi.fn(() => []);
		const ctx = makeCtx({ asyncAnalysis: { consume } });
		await runPreToolPipeline(ctx, ev({ tool_name: "Bash" }), makeSession());
		// `if (filePath)` false → consume never called.
		expect(consume).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 2. Async-deferred findings drain
// ---------------------------------------------------------------------------

describe("async-deferred findings drain", () => {
	it("appends drained finding messages to warnings (?? [] seed)", async () => {
		const ctx = makeCtx({
			asyncFindings: asyncFindingsStub([{ message: "DRAINED-1" }, { message: "DRAINED-2" }]),
		});
		const decision = await runPreToolPipeline(ctx, ev({ tool_name: "Read" }), makeSession());
		expect(decision.warnings).toEqual(["DRAINED-1", "DRAINED-2"]);
	});

	it("merges drained findings into an existing warnings array", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["PRE"] });
		const ctx = makeCtx({ asyncFindings: asyncFindingsStub([{ message: "DRAINED" }]) });
		const decision = await runPreToolPipeline(ctx, ev({ tool_name: "Read" }), makeSession());
		expect(decision.warnings).toEqual(["PRE", "DRAINED"]);
	});

	it("does not touch warnings when nothing is drained", async () => {
		const decision = await runPreToolPipeline(makeCtx(), ev({ tool_name: "Read" }), makeSession());
		expect(decision.warnings).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 3. LLM policy classifier escalation (shadow mode)
// ---------------------------------------------------------------------------

describe("policy classifier escalation", () => {
	function classifierCtx(cfg: Partial<ClassifierConfig> = {}): ServerRuntime {
		return makeCtx({ rules: makeRules({ policy_classifier: classifierConfig(cfg) }) });
	}

	it("runs the classifier and injects a shadow warning when allow + escalation + enabled", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		mCallClassifier.mockResolvedValue({
			label: "allow",
			confidence: 0.42,
			reasoning: "benign egress",
		});
		const ctx = classifierCtx();
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "WebFetch", agent_name: "evt-agent" }),
			makeSession(),
		);
		expect(mCallClassifier).toHaveBeenCalledOnce();
		expect(mAppendShadow).toHaveBeenCalledOnce();
		expect(decision.warnings?.some((w) => w.includes("[interlinked:policy] Shadow:"))).toBe(true);
		expect(ctx.writeClassifierStatus).toHaveBeenCalledWith(
			expect.stringContaining("openai_compatible:vendor-model-v6:ok:"),
		);
	});

	it("creates per-session classifier state on first use, reuses it after", async () => {
		// Fresh object per call so the in-place `delete preDecision._escalation`
		// from the first invocation doesn't strip the escalation off the second.
		mEvaluate.mockImplementation(() => ({ decision: "allow", _escalation: escalation() }));
		const ctx = classifierCtx();
		await runPreToolPipeline(ctx, ev({ tool_name: "WebFetch" }), makeSession());
		expect(ctx.classifierSessions.has("s")).toBe(true);
		// Second call: state already present → the `if (!classifierState)` branch
		// takes its false path.
		await runPreToolPipeline(ctx, ev({ tool_name: "WebFetch" }), makeSession());
		expect(mCallClassifier).toHaveBeenCalledTimes(2);
	});

	it("reuses a pre-seeded classifier state (false branch of the create guard)", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		const ctx = classifierCtx();
		const seeded = {
			calls_this_session: 7,
			consecutive_failures: 0,
		};
		ctx.classifierSessions.set("s", seeded);
		await runPreToolPipeline(ctx, ev({ tool_name: "WebFetch" }), makeSession());
		expect(mCallClassifier).toHaveBeenCalledOnce();
		expect(mCallClassifier.mock.calls[0]?.[2]).toBe(seeded);
		expect(ctx.classifierSessions.get("s")).toBe(seeded);
	});

	it("computes would_have_changed=true for a confident deny", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		mCallClassifier.mockResolvedValue({
			label: "deny",
			confidence: 0.95,
			reasoning: "policy violation",
		});
		await runPreToolPipeline(classifierCtx(), ev({ tool_name: "WebFetch" }), makeSession());
		expect(mAppendShadow).toHaveBeenCalledWith(
			expect.objectContaining({ would_have_changed: true }),
			"/repo",
		);
	});

	it("uses the 0.8 fallback when confidence_threshold is 0 (|| 0.8)", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		mCallClassifier.mockResolvedValue({
			label: "deny",
			confidence: 0.85,
			reasoning: "violation",
		});
		// threshold 0 → `|| 0.8` → 0.85 >= 0.8 → would_have_changed true.
		await runPreToolPipeline(
			classifierCtx({ confidence_threshold: 0 }),
			ev({ tool_name: "WebFetch" }),
			makeSession(),
		);
		expect(mAppendShadow).toHaveBeenCalledWith(
			expect.objectContaining({ would_have_changed: true }),
			"/repo",
		);
	});

	it("would_have_changed=false for a low-confidence deny", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		mCallClassifier.mockResolvedValue({
			label: "deny",
			confidence: 0.5,
			reasoning: "uncertain",
		});
		await runPreToolPipeline(classifierCtx(), ev({ tool_name: "WebFetch" }), makeSession());
		expect(mAppendShadow).toHaveBeenCalledWith(
			expect.objectContaining({ would_have_changed: false }),
			"/repo",
		);
	});

	it("uses the empty-string tool_name fallback in the shadow record (|| '')", async () => {
		// No event.tool_name → `event.tool_name || ""` takes its fallback arm.
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		await runPreToolPipeline(classifierCtx(), ev({}), makeSession());
		expect(mAppendShadow).toHaveBeenCalledWith(
			expect.objectContaining({ tool_name: "" }),
			"/repo",
		);
	});

	it("prefers event.agent_name, falls back to session.agent_name in the shadow record", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		// No event.agent_name → session.agent_name used.
		await runPreToolPipeline(classifierCtx(), ev({ tool_name: "WebFetch" }), makeSession());
		expect(mAppendShadow).toHaveBeenCalledWith(
			expect.objectContaining({ agent_name: "session-agent" }),
			"/repo",
		);
	});

	it("does NOT inject a warning in enforce mode (only shadow injects)", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		const decision = await runPreToolPipeline(
			classifierCtx({ mode: "enforce" }),
			ev({ tool_name: "WebFetch" }),
			makeSession(),
		);
		expect(decision.warnings ?? []).not.toContainEqual(expect.stringContaining("Shadow:"));
		// Still logged as ok.
		expect(mAppendShadow).toHaveBeenCalledOnce();
	});

	it("merges the shadow warning into an existing warnings array", async () => {
		mEvaluate.mockReturnValue({
			decision: "allow",
			_escalation: escalation(),
			warnings: ["SEED"],
		});
		const decision = await runPreToolPipeline(
			classifierCtx(),
			ev({ tool_name: "WebFetch" }),
			makeSession(),
		);
		expect(decision.warnings?.[0]).toBe("SEED");
		expect(decision.warnings?.length).toBe(2);
	});

	it("fails open and writes :error status when the classifier throws an Error", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		mCallClassifier.mockRejectedValue(new Error("classifier boom"));
		const ctx = classifierCtx();
		const decision = await runPreToolPipeline(ctx, ev({ tool_name: "WebFetch" }), makeSession());
		expect(decision.decision).toBe("allow");
		expect(ctx.writeClassifierStatus).toHaveBeenCalledWith(
			"openai_compatible:vendor-model-v6:error",
		);
		expect(ctx.log).toHaveBeenCalledWith(
			expect.stringContaining("Policy classifier error (fail-open): classifier boom"),
		);
	});

	it("stringifies a non-Error classifier throw", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		mCallClassifier.mockRejectedValue("plain boom");
		const ctx = classifierCtx();
		await runPreToolPipeline(ctx, ev({ tool_name: "WebFetch" }), makeSession());
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("plain boom"));
	});

	it("skips the classifier when there is no escalation", async () => {
		mEvaluate.mockReturnValue({ decision: "allow" });
		await runPreToolPipeline(classifierCtx(), ev({ tool_name: "WebFetch" }), makeSession());
		expect(mCallClassifier).not.toHaveBeenCalled();
	});

	it("skips the classifier when config is disabled", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		await runPreToolPipeline(
			classifierCtx({ enabled: false }),
			ev({ tool_name: "WebFetch" }),
			makeSession(),
		);
		expect(mCallClassifier).not.toHaveBeenCalled();
	});

	it("skips the classifier when policy_classifier config is absent (optional-chain)", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", _escalation: escalation() });
		await runPreToolPipeline(makeCtx(), ev({ tool_name: "WebFetch" }), makeSession());
		expect(mCallClassifier).not.toHaveBeenCalled();
	});

	it("skips the classifier when decision is not allow", async () => {
		mEvaluate.mockReturnValue({ decision: "block", _escalation: escalation() });
		await runPreToolPipeline(classifierCtx(), ev({ tool_name: "WebFetch" }), makeSession());
		expect(mCallClassifier).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 4. Content scanner — WebFetch proxy
// ---------------------------------------------------------------------------

describe("content scanner WebFetch proxy", () => {
	function proxyCtx(): ServerRuntime {
		return makeCtx({
			contentScanner: { name: "fixture", runtime: "http", ready: vi.fn(async () => true), scan: vi.fn(async () => []), shutdown: vi.fn(async () => {}) },
			rules: makeRules({
				content_scanner: { enabled: true, scan_points: { external_egress: true } },
			}),
		});
	}

	it("blocks with the body on a passthrough result", async () => {
		mFetchAndScan.mockResolvedValue({ kind: "passthrough", body: "FETCHED BODY" });
		const decision = await runPreToolPipeline(
			proxyCtx(),
			ev({ tool_name: "WebFetch", tool_input: { url: "https://vendor.example/x" } }),
			makeSession(),
		);
		expect(decision.decision).toBe("block");
		expect(decision.reason).toBe("FETCHED BODY");
	});

	it("recognizes the snake_case web_fetch tool name", async () => {
		mFetchAndScan.mockResolvedValue({ kind: "passthrough", body: "B" });
		const decision = await runPreToolPipeline(
			proxyCtx(),
			ev({ tool_name: "web_fetch", tool_input: { url: "https://vendor.example/y" } }),
			makeSession(),
		);
		expect(decision.decision).toBe("block");
		expect(mFetchAndScan).toHaveBeenCalledOnce();
	});

	it("blocks with the review-pending message and writes the marker", async () => {
		mFetchAndScan.mockResolvedValue({
			kind: "review_pending",
			reviewPath: "p",
			key: "k",
			findingCount: 3,
		});
		const ctx = proxyCtx();
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "WebFetch", tool_input: { url: "https://vendor.example/z" } }),
			makeSession(),
		);
		expect(decision.decision).toBe("block");
		expect(decision.reason).toContain("Privacy filter flagged");
		expect(decision.reason).toContain("(3 finding(s))");
		expect(ctx.writeReviewPendingMarker).toHaveBeenCalledWith(2);
	});

	it("blocks with the resolved body and writes the marker on decision_resolved", async () => {
		mFetchAndScan.mockResolvedValue({
			kind: "decision_resolved",
			decision: "redact",
			body: "REDACTED",
		});
		const ctx = proxyCtx();
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "WebFetch", tool_input: { url: "https://vendor.example/r" } }),
			makeSession(),
		);
		expect(decision.decision).toBe("block");
		expect(decision.reason).toBe("REDACTED");
		expect(ctx.writeReviewPendingMarker).toHaveBeenCalledWith(2);
	});

	it("falls through on fail_open (decision stays allow, logs the detail)", async () => {
		mFetchAndScan.mockResolvedValue({ kind: "fail_open", detail: "DNS failure" });
		const ctx = proxyCtx();
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "WebFetch", tool_input: { url: "https://vendor.example/f" } }),
			makeSession(),
		);
		expect(decision.decision).toBe("allow");
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("fail_open — DNS failure"));
	});

	it("passes a default prompt of '' when prompt field is absent", async () => {
		mFetchAndScan.mockResolvedValue({ kind: "fail_open", detail: "x" });
		await runPreToolPipeline(
			proxyCtx(),
			ev({ tool_name: "WebFetch", tool_input: { url: "https://vendor.example/p" } }),
			makeSession(),
		);
		expect(mFetchAndScan).toHaveBeenCalledWith(expect.objectContaining({ prompt: "" }));
	});

	it("forwards a present prompt field", async () => {
		mFetchAndScan.mockResolvedValue({ kind: "fail_open", detail: "x" });
		await runPreToolPipeline(
			proxyCtx(),
			ev({
				tool_name: "WebFetch",
				tool_input: { url: "https://vendor.example/p", prompt: "summarize" },
			}),
			makeSession(),
		);
		expect(mFetchAndScan).toHaveBeenCalledWith(expect.objectContaining({ prompt: "summarize" }));
	});

	it("skips the proxy entirely when url is empty", async () => {
		const decision = await runPreToolPipeline(
			proxyCtx(),
			ev({ tool_name: "WebFetch", tool_input: {} }),
			makeSession(),
		);
		expect(mFetchAndScan).not.toHaveBeenCalled();
		expect(decision.decision).toBe("allow");
	});

	it("skips the proxy when contentScanner is absent", async () => {
		const ctx = makeCtx({
			rules: makeRules({
				content_scanner: { enabled: true, scan_points: { external_egress: true } },
			}),
		});
		await runPreToolPipeline(
			ctx,
			ev({ tool_name: "WebFetch", tool_input: { url: "https://vendor.example/x" } }),
			makeSession(),
		);
		expect(mFetchAndScan).not.toHaveBeenCalled();
	});

	it("skips the proxy when external_egress scan point is off", async () => {
		const ctx = makeCtx({
			contentScanner: { name: "fixture", runtime: "http", ready: vi.fn(async () => true), scan: vi.fn(async () => []), shutdown: vi.fn(async () => {}) },
			rules: makeRules({
				content_scanner: { enabled: true, scan_points: { external_egress: false } },
			}),
		});
		await runPreToolPipeline(
			ctx,
			ev({ tool_name: "WebFetch", tool_input: { url: "https://vendor.example/x" } }),
			makeSession(),
		);
		expect(mFetchAndScan).not.toHaveBeenCalled();
	});

	it("skips the proxy for a non-WebFetch tool", async () => {
		await runPreToolPipeline(
			proxyCtx(),
			ev({ tool_name: "Read", tool_input: { url: "https://vendor.example/x" } }),
			makeSession(),
		);
		expect(mFetchAndScan).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 5. Content scanner — scan-request handling
// ---------------------------------------------------------------------------

describe("content scanner scan-request handling", () => {
	const scanReq = {
		hook: "pre_write_edit" as const,
		parts: [
			{ source: "Write.content", text: "alice@vendor.example secret stuff" },
			{ source: "Write.path", text: "src/x.ts" },
		],
	};

	function scanCtx(scannerOverrides: Partial<NonNullable<ServerRuntime["contentScanner"]>> = {}): ServerRuntime {
		const scan = scannerOverrides.scan ?? vi.fn(async () => []);
		return makeCtx({
			contentScanner: { name: "fixture", runtime: "http", ready: vi.fn(async () => true), shutdown: vi.fn(async () => {}), scan },
			rules: makeRules({ content_scanner: { enabled: true } }),
		});
	}

	it("scans each part and asks when the verdict is ask, writing the pending prompt", async () => {
		const finding = {
			label: "private_email",
			start: 0,
			end: 19,
			text: "alice@vendor.example",
			source: "Write.content",
		};
		const scan = vi.fn(async () => [finding]);
		mDecideFromFindings.mockReturnValue({ decision: "ask", reason: "privacy detected" });
		const ctx = scanCtx({ scan });
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Write" }),
			makeSessionWithScan(scanReq),
		);
		expect(scan).toHaveBeenCalledTimes(2);
		expect(decision.decision).toBe("ask");
		expect(decision.reason).toBe("ASK-REASON");
		expect(decision.system_message).toBe("SYS-MSG");
		expect(mWritePendingPrompt).toHaveBeenCalledOnce();
	});

	it("uses the verdict.reason ?? fallback for the policy summary", async () => {
		const finding = {
			label: "secret",
			start: 0,
			end: 6,
			text: "secret",
			source: "Write.content",
		};
		mDecideFromFindings.mockReturnValue({ decision: "ask" });
		await runPreToolPipeline(
			scanCtx({ scan: vi.fn(async () => [finding]) }),
			ev({ tool_name: "Write" }),
			makeSessionWithScan(scanReq),
		);
		expect(mBuildAskReason).toHaveBeenCalledWith(
			expect.objectContaining({
				policySummary: "privacy-filter detected sensitive content.",
			}),
		);
	});

	it("omits system_message when buildAskReason returns an empty one", async () => {
		mBuildAskReason.mockReturnValue({ reason: "R", systemMessage: "" });
		mDecideFromFindings.mockReturnValue({ decision: "ask" });
		const decision = await runPreToolPipeline(
			scanCtx({ scan: vi.fn(async () => [{ label: "secret", start: 0, end: 1, text: "x", source: "Write.content" }]) }),
			ev({ tool_name: "Write" }),
			makeSessionWithScan(scanReq),
		);
		expect(decision.system_message).toBeUndefined();
	});

	it("uses 'unknown' as the tool name fallback for writePendingPrompt", async () => {
		mDecideFromFindings.mockReturnValue({ decision: "ask" });
		await runPreToolPipeline(
			scanCtx({ scan: vi.fn(async () => [{ label: "secret", start: 0, end: 1, text: "x", source: "Write.content" }]) }),
			// No tool_name → `?? "unknown"`.
			ev({}),
			makeSessionWithScan(scanReq),
		);
		expect(mWritePendingPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ toolName: "unknown" }),
		);
	});

	it("stays allow when the verdict is allow", async () => {
		mDecideFromFindings.mockReturnValue({ decision: "allow" });
		const decision = await runPreToolPipeline(
			scanCtx({ scan: vi.fn(async () => []) }),
			ev({ tool_name: "Write" }),
			makeSessionWithScan(scanReq),
		);
		expect(decision.decision).toBe("allow");
		expect(mWritePendingPrompt).not.toHaveBeenCalled();
	});

	it("logs allowlist suppression when entries are dropped", async () => {
		const finding = { label: "secret", start: 0, end: 1, text: "x", source: "Write.content" };
		mApplyAllowlist.mockReturnValue({
			kept: [],
			suppressed: [{ finding, entry: { kind: "exact", pattern: "x" } }],
		});
		const ctx = scanCtx({ scan: vi.fn(async () => [finding]) });
		await runPreToolPipeline(ctx, ev({ tool_name: "Write" }), makeSessionWithScan(scanReq));
		expect(ctx.log).toHaveBeenCalledWith(
			expect.stringContaining("allowlist suppressed 1 finding(s)"),
		);
	});

	it("uses the configured max_scan_bytes and scan_timeout_ms", async () => {
		const scan = vi.fn(async () => []);
		const ctx = makeCtx({
			contentScanner: { name: "fixture", runtime: "http", ready: vi.fn(async () => true), shutdown: vi.fn(async () => {}), scan },
			rules: makeRules({
				content_scanner: {
					enabled: true,
					max_scan_bytes: 5,
					local: { scan_timeout_ms: 250 },
				},
			}),
		});
		const longReq = {
			hook: "pre_write_edit" as const,
			parts: [{ source: "Write.content", text: "0123456789abcdef" }],
		};
		await runPreToolPipeline(ctx, ev({ tool_name: "Write" }), makeSessionWithScan(longReq));
		// text sliced to 5 bytes.
		expect(scan).toHaveBeenCalledWith(expect.objectContaining({ text: "01234" }));
	});

	it("falls back to default byte/timeout when config omits them (|| defaults)", async () => {
		const scan = vi.fn(async () => []);
		const ctx = makeCtx({
			contentScanner: { name: "fixture", runtime: "http", ready: vi.fn(async () => true), shutdown: vi.fn(async () => {}),  scan },
			rules: makeRules({ content_scanner: { enabled: true } }),
		});
		await runPreToolPipeline(ctx, ev({ tool_name: "Write" }), makeSessionWithScan(scanReq));
		// Full (un-truncated) text passed — default 100_000 cap not hit.
		expect(scan).toHaveBeenCalledWith(
			expect.objectContaining({ text: "alice@vendor.example secret stuff" }),
		);
	});

	it("fails open (logs) when a per-part scan throws an Error", async () => {
		const scan = vi.fn(async () => {
			throw new Error("scan boom");
		});
		const ctx = scanCtx({ scan });
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Write" }),
			makeSessionWithScan(scanReq),
		);
		expect(decision.decision).toBe("allow");
		expect(ctx.log).toHaveBeenCalledWith(
			expect.stringContaining("Content scanner scan failed (fail-open): scan boom"),
		);
	});

	it("stringifies a non-Error per-part scan throw", async () => {
		const scan = vi.fn(async () => {
			throw "scan string boom";
		});
		const ctx = scanCtx({ scan });
		await runPreToolPipeline(ctx, ev({ tool_name: "Write" }), makeSessionWithScan(scanReq));
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("scan string boom"));
	});

	it("skips scan handling when _contentScan is absent", async () => {
		const scan = vi.fn(async () => []);
		const ctx = scanCtx({ scan });
		await runPreToolPipeline(ctx, ev({ tool_name: "Write" }), makeSession());
		expect(scan).not.toHaveBeenCalled();
	});

	it("skips scan handling when contentScanner is absent", async () => {
		const ctx = makeCtx({ rules: makeRules({ content_scanner: { enabled: true } }) });
		await runPreToolPipeline(ctx, ev({ tool_name: "Write" }), makeSessionWithScan(scanReq));
		expect(mDecideFromFindings).not.toHaveBeenCalled();
	});

	it("groups multiple findings per source for the ask path", async () => {
		const f1 = { label: "secret", start: 0, end: 1, text: "a", source: "Write.content" };
		const f2 = { label: "private_email", start: 5, end: 6, text: "b", source: "Write.content" };
		mApplyAllowlist.mockReturnValue({ kept: [f1, f2], suppressed: [] });
		mDecideFromFindings.mockReturnValue({ decision: "ask" });
		await runPreToolPipeline(
			scanCtx({ scan: vi.fn(async () => [f1, f2]) }),
			ev({ tool_name: "Write" }),
			makeSessionWithScan(scanReq),
		);
		const callArg = nonNull(mWritePendingPrompt.mock.calls[0])[0];
		expect(callArg.findingsBySource.get("Write.content")?.length).toBe(2);
	});
});

/** Session whose evaluator result carries a `_contentScan` request — modeled by
 *  re-programming the evaluator mock per call. */
function makeSessionWithScan(req: {
	hook: "pre_write_edit";
	parts: Array<{ source: string; text: string }>;
}): SessionTrajectory {
	mEvaluate.mockReturnValue({ decision: "allow", _contentScan: req });
	return makeSession();
}

// ---------------------------------------------------------------------------
// 6. Internal-field cleanup
// ---------------------------------------------------------------------------

describe("internal-field cleanup", () => {
	it("strips _escalation and _contentScan from the returned decision", async () => {
		mEvaluate.mockReturnValue({
			decision: "allow",
			_escalation: escalation(),
			_contentScan: { hook: "pre_write_edit", parts: [] },
		});
		const decision = await runPreToolPipeline(makeCtx(), ev({ tool_name: "Read" }), makeSession());
		expect(decision._escalation).toBeUndefined();
		expect(decision._contentScan).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 7. Auto-coordination
// ---------------------------------------------------------------------------

describe("auto-coordination", () => {
	function coordCtx(bridge: Partial<NonNullable<ServerRuntime["serverBridge"]>>): ServerRuntime {
		return makeCtx({ serverBridge: { reportGuardEvent: vi.fn(), fetchCoordinationState: vi.fn(async () => null), ...bridge } });
	}

	it("injects coordination warnings and resets misses on a successful check-in", async () => {
		mShouldCoordinate.mockReturnValue(true);
		const coordResponse: CoordinationResponse = { heartbeat_recorded: true,
			unread: { total: 3, urgent: [] },
			task_changes: [1, 2].map((id) => ({ id, title: "Task", status: "blocked", change_type: "blocked" })),
		};
		const fetchCoordinationState = vi.fn(async () => coordResponse);
		const coordState = {
			lastCoordAt: 0,
			lastCoordTs: 0,
			consecutiveMisses: 4,
			totalCheckins: 1,
			disabled: false,
		};
		mGetAutoCoord.mockReturnValue(coordState);
		const session = makeSession({ tool_call_count: 9 });
		await runPreToolPipeline(
			coordCtx({ fetchCoordinationState }),
			ev({ tool_name: "Edit", agent_name: "evt-agent" }),
			session,
		);
		expect(fetchCoordinationState).toHaveBeenCalledWith("evt-agent", session, 2000);
		expect(mInjectCoord).toHaveBeenCalledOnce();
		expect(coordState.consecutiveMisses).toBe(0);
		expect(coordState.totalCheckins).toBe(2);
		expect(session.last_coordination_at).toBe(9);
	});

	it("falls back to session.agent_name when event.agent_name is absent", async () => {
		mShouldCoordinate.mockReturnValue(true);
		const fetchCoordinationState = vi.fn(async () => ({
			heartbeat_recorded: false,
			unread: { total: 0, urgent: [] },
			task_changes: [],
		}));
		await runPreToolPipeline(
			coordCtx({ fetchCoordinationState }),
			ev({ tool_name: "Edit" }),
			makeSession(),
		);
		expect(fetchCoordinationState).toHaveBeenCalledWith("session-agent", expect.anything(), 2000);
	});

	it("increments misses on a null response, disabling after the threshold", async () => {
		mShouldCoordinate.mockReturnValue(true);
		const fetchCoordinationState = vi.fn(async () => null);
		const coordState = {
			lastCoordAt: 0,
			lastCoordTs: 0,
			consecutiveMisses: 4,
			totalCheckins: 0,
			disabled: false,
		};
		mGetAutoCoord.mockReturnValue(coordState);
		const ctx = makeCtx({
			serverBridge: { reportGuardEvent: vi.fn(), fetchCoordinationState },
			autoCoordConfig: { max_misses_before_disable: 5, timeout_ms: 2000 },
		});
		await runPreToolPipeline(ctx, ev({ tool_name: "Edit" }), makeSession());
		expect(coordState.consecutiveMisses).toBe(5);
		expect(coordState.disabled).toBe(true);
	});

	it("increments misses on null response WITHOUT disabling below the threshold", async () => {
		mShouldCoordinate.mockReturnValue(true);
		const fetchCoordinationState = vi.fn(async () => null);
		const coordState = {
			lastCoordAt: 0,
			lastCoordTs: 0,
			consecutiveMisses: 1,
			totalCheckins: 0,
			disabled: false,
		};
		mGetAutoCoord.mockReturnValue(coordState);
		await runPreToolPipeline(
			coordCtx({ fetchCoordinationState }),
			ev({ tool_name: "Edit" }),
			makeSession(),
		);
		expect(coordState.consecutiveMisses).toBe(2);
		expect(coordState.disabled).toBe(false);
	});

	it("increments misses when fetchCoordinationState throws (catch path)", async () => {
		mShouldCoordinate.mockReturnValue(true);
		const fetchCoordinationState = vi.fn(async () => {
			throw new Error("network down");
		});
		const coordState = {
			lastCoordAt: 0,
			lastCoordTs: 0,
			consecutiveMisses: 0,
			totalCheckins: 0,
			disabled: false,
		};
		mGetAutoCoord.mockReturnValue(coordState);
		const decision = await runPreToolPipeline(
			coordCtx({ fetchCoordinationState }),
			ev({ tool_name: "Edit" }),
			makeSession(),
		);
		expect(decision.decision).toBe("allow");
		expect(coordState.consecutiveMisses).toBe(1);
	});

	it("skips coordination when shouldCoordinate returns false", async () => {
		mShouldCoordinate.mockReturnValue(false);
		const fetchCoordinationState = vi.fn(async () => null);
		await runPreToolPipeline(
			coordCtx({ fetchCoordinationState }),
			ev({ tool_name: "Edit" }),
			makeSession(),
		);
		expect(fetchCoordinationState).not.toHaveBeenCalled();
	});

	it("skips coordination when serverBridge is null", async () => {
		mShouldCoordinate.mockReturnValue(true);
		await runPreToolPipeline(makeCtx(), ev({ tool_name: "Edit" }), makeSession());
		expect(mShouldCoordinate).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 8. Background async-analysis findings
// ---------------------------------------------------------------------------

describe("background async-analysis findings", () => {
	it("injects async findings as tagged warnings when filePath present", async () => {
		const consume = vi.fn(() => [
			{ name: "coverage_delta", message: "coverage dropped", source: "quality", severity: "warning", determinism: "heuristic" } satisfies import("../types.js").CheckResultEntry,
			{ name: "complexity", message: "too complex", source: "quality", severity: "warning", determinism: "heuristic" } satisfies import("../types.js").CheckResultEntry,
		]);
		const ctx = makeCtx({ asyncAnalysis: { consume } });
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Edit", tool_input: { file_path: "src/x.ts" } }),
			makeSession(),
		);
		expect(consume).toHaveBeenCalledWith("src/x.ts");
		expect(decision.warnings).toContain("[interlinked:async] coverage_delta: coverage dropped");
		expect(decision.warnings).toContain("[interlinked:async] complexity: too complex");
	});

	it("merges async findings into an existing warnings array", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["PRE"] });
		const ctx = makeCtx({
			asyncAnalysis: { consume: vi.fn(() => [{ name: "c", message: "m", source: "quality", severity: "warning", determinism: "heuristic" } satisfies import("../types.js").CheckResultEntry]) },
		});
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Edit", tool_input: { file_path: "src/x.ts" } }),
			makeSession(),
		);
		expect(decision.warnings?.[0]).toBe("PRE");
		expect(decision.warnings?.[1]).toBe("[interlinked:async] c: m");
	});

	it("does nothing when consume returns no findings", async () => {
		const decision = await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Edit", tool_input: { file_path: "src/x.ts" } }),
			makeSession(),
		);
		expect(decision.warnings).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 9. Cross-session learned rules
// ---------------------------------------------------------------------------

describe("learned rules", () => {
	it("observes a new pattern and warns when it crosses the threshold", async () => {
		mExtractPattern.mockReturnValue("Bash(npm test *)");
		const learnedRules = {
			has: vi.fn(() => false),
			observe: vi.fn<ServerRuntime["learnedRules"]["observe"]>(() => ({ pattern: "Bash(npm test *)", observation_count: 5, decision: "allow", first_seen: "2026-09-08T00:00:00Z", learned_at: "2026-09-08T00:00:00Z", learned_in_session: "s" })),
		};
		const ctx = makeCtx({ learnedRules });
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Bash", tool_input: { command: "npm test" } }),
			makeSession(),
		);
		expect(learnedRules.observe).toHaveBeenCalledWith("Bash(npm test *)", "s");
		expect(learnedRules.observe).toHaveBeenCalledOnce();
		expect(
			decision.warnings?.some((w) => w.includes("[interlinked:learned]") && w.includes("5 times")),
		).toBe(true);
	});

	it("merges the learned warning into an existing warnings array", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["PRE"] });
		mExtractPattern.mockReturnValue("Bash(ls *)");
		const learnedRules = {
			has: vi.fn(() => false),
			observe: vi.fn<ServerRuntime["learnedRules"]["observe"]>(() => ({ pattern: "Bash(ls *)", observation_count: 3, decision: "allow", first_seen: "2026-09-08T00:00:00Z", learned_at: "2026-09-08T00:00:00Z", learned_in_session: "s" })),
		};
		const decision = await runPreToolPipeline(
			makeCtx({ learnedRules }),
			ev({ tool_name: "Bash", tool_input: { command: "ls" } }),
			makeSession(),
		);
		expect(decision.warnings?.[0]).toBe("PRE");
		expect(decision.warnings?.length).toBe(2);
	});

	it("observes but stays quiet when the threshold is not yet crossed (learned=null)", async () => {
		mExtractPattern.mockReturnValue("Bash(npm test *)");
		const learnedRules = { has: vi.fn(() => false), observe: vi.fn(() => null) };
		const decision = await runPreToolPipeline(
			makeCtx({ learnedRules }),
			ev({ tool_name: "Bash", tool_input: { command: "npm test" } }),
			makeSession(),
		);
		expect(learnedRules.observe).toHaveBeenCalledWith("Bash(npm test *)", "s");
		expect(learnedRules.observe).toHaveBeenCalledOnce();
		expect(decision.warnings).toBeUndefined();
	});

	it("does not re-observe a pattern already learned (has() true)", async () => {
		mExtractPattern.mockReturnValue("Bash(npm test *)");
		const learnedRules = { has: vi.fn(() => true), observe: vi.fn(() => null) };
		await runPreToolPipeline(
			makeCtx({ learnedRules }),
			ev({ tool_name: "Bash", tool_input: { command: "npm test" } }),
			makeSession(),
		);
		expect(learnedRules.observe).not.toHaveBeenCalled();
	});

	it("skips learning when extractPermissionPattern returns null", async () => {
		mExtractPattern.mockReturnValue(null);
		const learnedRules = { has: vi.fn(() => false), observe: vi.fn(() => null) };
		await runPreToolPipeline(
			makeCtx({ learnedRules }),
			ev({ tool_name: "Bash", tool_input: { command: "npm test" } }),
			makeSession(),
		);
		expect(learnedRules.has).not.toHaveBeenCalled();
	});

	it("uses an empty tool_input fallback ({} ) when tool_input is absent", async () => {
		mExtractPattern.mockReturnValue(null);
		await runPreToolPipeline(makeCtx(), ev({ tool_name: "Bash" }), makeSession());
		expect(mExtractPattern).toHaveBeenCalledWith("Bash", {});
	});

	it("skips learning entirely when decision is not allow", async () => {
		mEvaluate.mockReturnValue({ decision: "block", reason: "no" });
		await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "x" } }),
			makeSession(),
		);
		expect(mExtractPattern).not.toHaveBeenCalled();
	});

	it("skips learning when tool_name is absent", async () => {
		await runPreToolPipeline(makeCtx(), ev({ tool_input: { command: "x" } }), makeSession());
		expect(mExtractPattern).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 10. Guard-block reporting to the server
// ---------------------------------------------------------------------------

describe("guard-block reporting", () => {
	it("reports a block to the server bridge with summarized input", async () => {
		mEvaluate.mockReturnValue({ decision: "block", reason: "BLOCKED: nope" });
		const reportGuardEvent = vi.fn();
		await runPreToolPipeline(
			makeCtx({ serverBridge: { reportGuardEvent, fetchCoordinationState: vi.fn(async () => null) } }),
			ev({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/data" }, agent_name: "a" }),
			makeSession(),
		);
		expect(reportGuardEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "guard_block",
				decision: "block",
				reason: "BLOCKED: nope",
				tool_input_summary: "rm -rf /tmp/data",
				agent_name: "a",
			}),
		);
	});

	it("uses the default reason when the block carries none", async () => {
		mEvaluate.mockReturnValue({ decision: "block" });
		const reportGuardEvent = vi.fn();
		await runPreToolPipeline(
			makeCtx({ serverBridge: { reportGuardEvent, fetchCoordinationState: vi.fn(async () => null) } }),
			ev({ tool_name: "Bash", tool_input: { command: "x" } }),
			makeSession(),
		);
		expect(reportGuardEvent).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "Blocked by guard rule" }),
		);
	});

	it("falls back to session.agent_name for the report when event lacks one", async () => {
		mEvaluate.mockReturnValue({ decision: "block", reason: "r" });
		const reportGuardEvent = vi.fn();
		await runPreToolPipeline(
			makeCtx({ serverBridge: { reportGuardEvent, fetchCoordinationState: vi.fn(async () => null) } }),
			ev({ tool_name: "Bash", tool_input: { command: "x" } }),
			makeSession(),
		);
		expect(reportGuardEvent).toHaveBeenCalledWith(
			expect.objectContaining({ agent_name: "session-agent" }),
		);
	});

	it("does not report when the decision is allow", async () => {
		const reportGuardEvent = vi.fn();
		await runPreToolPipeline(
			makeCtx({ serverBridge: { reportGuardEvent, fetchCoordinationState: vi.fn(async () => null) } }),
			ev({ tool_name: "Read" }),
			makeSession(),
		);
		expect(reportGuardEvent).not.toHaveBeenCalled();
	});

	it("does not throw when blocked but serverBridge is null", async () => {
		mEvaluate.mockReturnValue({ decision: "block", reason: "r" });
		const decision = await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "x" } }),
			makeSession(),
		);
		expect(decision.decision).toBe("block");
	});
});

// ---------------------------------------------------------------------------
// 11. Grep acceleration — substitution path
// ---------------------------------------------------------------------------

describe("grep acceleration substitution", () => {
	function searchCtx(overrides: Record<string, unknown> = {}): ServerRuntime {
		return makeCtx({
			trigramIndex: makeTrigramIndex("abc1234def", false),
			rules: makeRules({ grep_acceleration: { substitution_enabled: true } }),
			...overrides,
		});
	}

	it("returns the accelerated decision when the index is fresh and substitution enabled", async () => {
		mExecSync
			.mockReturnValueOnce("abc1234def\n") // git rev-parse HEAD
			.mockReturnValueOnce(""); // git status --porcelain (clean)
		mCheckGrep.mockReturnValue({ decision: "block", reason: "GREP RESULTS" });
		const ctx = searchCtx();
		const event = ev({ tool_name: "Grep", tool_input: { pattern: "foo" } });
		const decision = await runPreToolPipeline(ctx, event, makeSession());
		expect(decision.decision).toBe("block");
		expect(decision.reason).toBe("GREP RESULTS");
		expect(mCheckGrep).toHaveBeenCalledWith(
			event,
			ctx.trigramIndex,
			{ indexFresh: true },
			ctx.fileContentCache,
		);
	});

	it("merges preDecision warnings into the accelerated decision's warnings", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["PRE-W"] });
		mExecSync.mockReturnValueOnce("abc1234def\n").mockReturnValueOnce("");
		mCheckGrep.mockReturnValue({ decision: "block", reason: "R", warnings: ["GREP-W"] });
		const decision = await runPreToolPipeline(
			searchCtx(),
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(decision.warnings).toEqual(["PRE-W", "GREP-W"]);
	});

	it("merges preDecision warnings when the accelerated decision has none (|| [] arm)", async () => {
		// preDecision.warnings present (enters the merge block) but
		// grepDecision.warnings absent → `grepDecision.warnings || []` fallback.
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["ONLY-PRE"] });
		mExecSync.mockReturnValueOnce("abc1234def\n").mockReturnValueOnce("");
		mCheckGrep.mockReturnValue({ decision: "block", reason: "R" });
		const decision = await runPreToolPipeline(
			searchCtx(),
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(decision.warnings).toEqual(["ONLY-PRE"]);
	});

	it("enables substitution via env=1 even when rules disable it", async () => {
		process.env.INTERLINKED_GREP_ACCELERATOR = "1";
		mExecSync.mockReturnValueOnce("abc1234def\n").mockReturnValueOnce("");
		mCheckGrep.mockReturnValue({ decision: "block", reason: "ENV-ON" });
		const ctx = makeCtx({
			trigramIndex: makeTrigramIndex("abc1234def", false),
			rules: makeRules({ grep_acceleration: { substitution_enabled: false } }),
		});
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(decision.reason).toBe("ENV-ON");
	});

	it("disables substitution via env=0 even when rules enable it", async () => {
		process.env.INTERLINKED_GREP_ACCELERATOR = "0";
		const decision = await runPreToolPipeline(
			searchCtx(),
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		// checkGrepAcceleration is in the substitution block — never reached.
		expect(mCheckGrep).not.toHaveBeenCalled();
		expect(decision.decision).toBe("allow");
	});

	it("recognizes a Bash rg command as a search tool", async () => {
		mExecSync.mockReturnValueOnce("abc1234def\n").mockReturnValueOnce("");
		mCheckGrep.mockReturnValue({ decision: "block", reason: "BASH-RG" });
		const ctx = searchCtx();
		const event = ev({ tool_name: "Bash", tool_input: { command: "rg foo src/" } });
		const decision = await runPreToolPipeline(ctx, event, makeSession());
		expect(decision.reason).toBe("BASH-RG");
		expect(mCheckGrep).toHaveBeenCalledWith(
			event,
			ctx.trigramIndex,
			{ indexFresh: true },
			ctx.fileContentCache,
		);
	});

	it("recognizes ugrep via the ugrepAwareSearch widening", async () => {
		mExecSync.mockReturnValueOnce("abc1234def\n").mockReturnValueOnce("");
		mCheckGrep.mockReturnValue({ decision: "block", reason: "UGREP" });
		const decision = await runPreToolPipeline(
			searchCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "ugrep foo src/" } }),
			makeSession(),
		);
		expect(decision.reason).toBe("UGREP");
	});

	it("treats the index as not-fresh when HEAD != baseCommit (declines to native)", async () => {
		mExecSync.mockReturnValueOnce("differenthead\n");
		mCheckGrep.mockReturnValue({ decision: "block", reason: "SHOULD-NOT-MATTER" });
		const decision = await runPreToolPipeline(
			searchCtx(),
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		// indexFresh:false passed to checkGrep, but checkGrep still mocked to a
		// decision — the orchestrator returns it regardless. Assert indexFresh.
		expect(mCheckGrep.mock.calls[0]?.[2]).toEqual({ indexFresh: false });
		expect(decision.reason).toBe("SHOULD-NOT-MATTER");
	});

	it("treats the index as not-fresh when the working tree is dirty (porcelain non-empty)", async () => {
		mExecSync.mockReturnValueOnce("abc1234def\n").mockReturnValueOnce(" M src/x.ts\n");
		mCheckGrep.mockReturnValue(null);
		await runPreToolPipeline(
			searchCtx(),
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(mCheckGrep.mock.calls[0]?.[2]).toEqual({ indexFresh: false });
	});

	it("treats the index as not-fresh when the in-memory dirty layer is set", async () => {
		mExecSync.mockReturnValueOnce("abc1234def\n");
		mCheckGrep.mockReturnValue(null);
		const ctx = makeCtx({
			trigramIndex: makeTrigramIndex("abc1234def", true),
			rules: makeRules({ grep_acceleration: { substitution_enabled: true } }),
		});
		await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(mCheckGrep.mock.calls[0]?.[2]).toEqual({ indexFresh: false });
	});

	it("treats the index as not-fresh when a git command throws", async () => {
		mExecSync.mockImplementation(() => {
			throw new Error("not a git repo");
		});
		mCheckGrep.mockReturnValue(null);
		await runPreToolPipeline(
			searchCtx(),
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(mCheckGrep.mock.calls[0]?.[2]).toEqual({ indexFresh: false });
	});

	it("falls through (no return) when checkGrepAcceleration declines", async () => {
		mExecSync.mockReturnValueOnce("abc1234def\n").mockReturnValueOnce("");
		mCheckGrep.mockReturnValue(null);
		const decision = await runPreToolPipeline(
			searchCtx(),
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(decision.decision).toBe("allow");
		// Falls through to the unconditional tail stages.
		expect(mCaptureBaseline).toHaveBeenCalledOnce();
	});

	it("skips the substitution block when there is no trigram index", async () => {
		const ctx = makeCtx({
			rules: makeRules({ grep_acceleration: { substitution_enabled: true } }),
		});
		await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(mCheckGrep).not.toHaveBeenCalled();
	});

	it("skips the substitution block for a non-search tool", async () => {
		await runPreToolPipeline(
			searchCtx(),
			ev({ tool_name: "Read", tool_input: { file_path: "x" } }),
			makeSession(),
		);
		expect(mCheckGrep).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 12. Index-status warning (only for an enabled, loaded index)
// ---------------------------------------------------------------------------

describe("index-status warning", () => {
	function loadedIndexCtx(overrides: Record<string, unknown> = {}): ServerRuntime {
		return makeCtx({
			trigramIndex: makeTrigramIndex("abc1234def", false),
			rules: makeRules({ grep_acceleration: { substitution_enabled: true } }),
			...overrides,
		});
	}

	it("does not suggest building an index when trigramIndex is null", async () => {
		const ctx = makeCtx({
			rules: makeRules({ grep_acceleration: { substitution_enabled: true } }),
		});
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(decision.warnings ?? []).not.toContainEqual(
			expect.stringContaining("[interlinked:index]"),
		);
		expect(ctx.indexWarningSent.has("s")).toBe(false);
		expect(mFindRg).not.toHaveBeenCalled();
	});

	it("does not emit index status when substitution is disabled", async () => {
		mFindRg.mockReturnValue(null);
		const ctx = makeCtx({
			trigramIndex: makeTrigramIndex("abc1234def", false),
		});
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(decision.warnings ?? []).not.toContainEqual(
			expect.stringContaining("[interlinked:index]"),
		);
		expect(ctx.indexWarningSent.has("s")).toBe(false);
		expect(mFindRg).not.toHaveBeenCalled();
	});

	it("does not emit index status for Bash searches outside the indexed project", async () => {
		mFindRg.mockReturnValue(null);
		for (const command of [
			"cd /private/tmp/clone && rg foo .",
			"rg foo /private/tmp/clone",
		]) {
			const ctx = loadedIndexCtx();
			const decision = await runPreToolPipeline(
				ctx,
				ev({ tool_name: "Bash", tool_input: { command } }),
				makeSession(),
			);
			expect(decision.warnings ?? []).not.toContainEqual(
				expect.stringContaining("[interlinked:index]"),
			);
			expect(ctx.indexWarningSent.has("s")).toBe(false);
		}
		expect(mFindRg).not.toHaveBeenCalled();
	});

	it("warns when index loaded but ripgrep is missing", async () => {
		mFindRg.mockReturnValue(null);
		const ctx = loadedIndexCtx();
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(decision.warnings?.some((w) => w.includes("ripgrep not installed"))).toBe(true);
	});

	it("keeps index status for an applicable in-project Bash search", async () => {
		mFindRg.mockReturnValue(null);
		const decision = await runPreToolPipeline(
			loadedIndexCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "rg foo src/" } }),
			makeSession(),
		);
		expect(decision.warnings?.some((w) => w.includes("ripgrep not installed"))).toBe(true);
	});

	it("warns the index is N commits behind HEAD when index + rg present", async () => {
		mFindRg.mockReturnValue("/usr/bin/rg");
		mExecSync
			.mockReturnValueOnce("newhead0000\n") // accelerator freshness: rev-parse HEAD
			.mockReturnValueOnce("newhead0000\n") // status freshness: rev-parse HEAD
			.mockReturnValueOnce("7\n"); // status freshness: rev-list --count
		const ctx = loadedIndexCtx();
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(decision.warnings?.some((w) => w.includes("7 commit(s) behind HEAD"))).toBe(true);
	});

	it("emits no freshness warning when HEAD matches baseCommit", async () => {
		mFindRg.mockReturnValue("/usr/bin/rg");
		mExecSync.mockReturnValueOnce("abc1234def\n");
		const ctx = loadedIndexCtx();
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(decision.warnings ?? []).not.toContainEqual(expect.stringContaining("behind HEAD"));
	});

	it("swallows a git error in the freshness check (catch path)", async () => {
		mFindRg.mockReturnValue("/usr/bin/rg");
		mExecSync.mockImplementation(() => {
			throw new Error("git fail");
		});
		const ctx = loadedIndexCtx();
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(decision.decision).toBe("allow");
		expect(decision.warnings ?? []).not.toContainEqual(expect.stringContaining("behind HEAD"));
	});

	it("emits no freshness warning when the index has no baseCommit", async () => {
		mFindRg.mockReturnValue("/usr/bin/rg");
		mExecSync.mockReturnValueOnce("newhead0000\n");
		const ctx = loadedIndexCtx({
			trigramIndex: makeTrigramIndex("", false),
		});
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		// `ctx.trigramIndex.baseCommit` falsy → freshness branch not taken; no
		// emit, but the session is still marked.
		expect(decision.warnings ?? []).not.toContainEqual(expect.stringContaining("behind HEAD"));
		expect(ctx.indexWarningSent.has("s")).toBe(true);
	});

	it("dedups: marks the session sent and does not re-warn on the second call", async () => {
		// Fresh decision object per call so the second invocation doesn't inherit
		// the first invocation's mutated `warnings` array.
		mEvaluate.mockImplementation(() => ({ decision: "allow" }));
		mFindRg.mockReturnValue(null);
		const ctx = loadedIndexCtx();
		const first = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(first.warnings?.some((w) => w.includes("ripgrep not installed"))).toBe(true);
		expect(ctx.indexWarningSent.has("s")).toBe(true);
		const second = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "bar" } }),
			makeSession(),
		);
		expect(second.warnings).toBeUndefined();
	});

	it("uses the 'anonymous' dedup key when session_id is empty", async () => {
		mFindRg.mockReturnValue(null);
		const ctx = loadedIndexCtx();
		await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" }, session_id: "" }),
			makeSession(),
		);
		expect(ctx.indexWarningSent.has("anonymous")).toBe(true);
	});

	it("does not emit the index warning for a non-search tool", async () => {
		mFindRg.mockReturnValue(null);
		const ctx = loadedIndexCtx();
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Read", tool_input: { file_path: "x" } }),
			makeSession(),
		);
		expect(decision.warnings).toBeUndefined();
		expect(ctx.indexWarningSent.has("s")).toBe(false);
	});

	it("merges an applicable index warning into an existing warnings array", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["PRE"] });
		mFindRg.mockReturnValue(null);
		const decision = await runPreToolPipeline(
			loadedIndexCtx(),
			ev({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
			makeSession(),
		);
		expect(decision.warnings?.[0]).toBe("PRE");
		expect(decision.warnings?.some((w) => w.includes("ripgrep not installed"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 13. tsgo acceleration
// ---------------------------------------------------------------------------

describe("tsgo acceleration", () => {
	it("returns the tsgo block result when tryTsgoRewrite succeeds", async () => {
		mIsBashTsc.mockReturnValue(true);
		mTryTsgo.mockReturnValue({ decision: "block", reason: "TSGO OUTPUT" });
		const decision = await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "tsc --noEmit" } }),
			makeSession(),
		);
		expect(decision.decision).toBe("block");
		expect(decision.reason).toBe("TSGO OUTPUT");
	});

	it("adds a tsc-fallback warning when tsgo is unavailable", async () => {
		mIsBashTsc.mockReturnValue(true);
		mTryTsgo.mockReturnValue(null);
		const decision = await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "tsc --noEmit" } }),
			makeSession(),
		);
		expect(decision.warnings?.some((w) => w.includes("[interlinked:tsc] Using tsc"))).toBe(true);
	});

	it("merges the tsc-fallback warning into an existing warnings array", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["PRE"] });
		mIsBashTsc.mockReturnValue(true);
		mTryTsgo.mockReturnValue(null);
		const decision = await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "tsc" } }),
			makeSession(),
		);
		expect(decision.warnings?.[0]).toBe("PRE");
		expect(decision.warnings?.length).toBe(2);
	});

	it("skips tsgo when isBashTsc is false", async () => {
		mIsBashTsc.mockReturnValue(false);
		await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "echo hi" } }),
			makeSession(),
		);
		expect(mTryTsgo).not.toHaveBeenCalled();
	});

	it("skips tsgo when the decision is not allow", async () => {
		mEvaluate.mockReturnValue({ decision: "block", reason: "x" });
		mIsBashTsc.mockReturnValue(true);
		await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "tsc" } }),
			makeSession(),
		);
		expect(mTryTsgo).not.toHaveBeenCalled();
	});
});

describe("coverage run-start observation", () => {
	it("records coverage starts for shell tool aliases with command input", async () => {
		mIsCoverageSuiteCommand.mockReturnValue(true);
		await runPreToolPipeline(
			makeCtx(),
			ev({
				tool_name: "shell",
				tool_input: { command: "python -m coverage run -m pytest" },
				session_id: "sess-shell",
				timestamp: "2026-06-18T12:00:00.000Z",
			}),
			makeSession(),
		);

		expect(mIsCoverageSuiteCommand).toHaveBeenCalledWith("python -m coverage run -m pytest");
		expect(mNoteCoverageSuiteRunStart).toHaveBeenCalledWith(
			"sess-shell",
			"2026-06-18T12:00:00.000Z",
		);
	});

	it("does not classify non-command tool inputs as coverage starts", async () => {
		await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "shell", tool_input: { query: "pytest --cov" } }),
			makeSession(),
		);

		expect(mIsCoverageSuiteCommand).not.toHaveBeenCalled();
		expect(mNoteCoverageSuiteRunStart).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 13b. Per-edit coverage gate (config-gated, DEFAULT ON)
// ---------------------------------------------------------------------------

describe("per-edit coverage gate wiring", () => {
	it("invokes the extracted coverage gate and returns its block", async () => {
		mRunCoverageGate.mockResolvedValue({
			decision: "block",
			reason: "[interlinked:coverage] BLOCKED: src/x.ts line 2 uncovered",
			rule_id: "per-edit-coverage",
		});
		const decision = await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Write", tool_input: { file_path: "src/x.ts", content: "x" } }),
			makeSession(),
		);
		expect(mRunCoverageGate).toHaveBeenCalledOnce();
		expect(decision.decision).toBe("block");
		expect(decision.reason).toContain("[interlinked:coverage]");
	});

	it("continues to allow when the coverage gate returns null (falls through to tail stages)", async () => {
		mRunCoverageGate.mockResolvedValue(null);
		const decision = await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Write", tool_input: { file_path: "src/x.ts", content: "x" } }),
			makeSession(),
		);
		expect(mRunCoverageGate).toHaveBeenCalledOnce();
		expect(decision.decision).toBe("allow");
		expect(mCaptureBaseline).toHaveBeenCalledOnce();
	});

	it("a coverage-gate block short-circuits before the commit gate runs", async () => {
		mRunCoverageGate.mockResolvedValue({ decision: "block", reason: "cov" });
		await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Write", tool_input: { file_path: "src/x.ts", content: "x" } }),
			makeSession(),
		);
		expect(mRunCommitGate).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 13c. Commit-time quality gate (config-gated, DEFAULT ON)
// ---------------------------------------------------------------------------

describe("commit gate wiring", () => {
	const commitEv = () =>
		ev({ tool_name: "Bash", tool_input: { command: 'git commit -m "x"' } });

	it("invokes the commit gate on the Bash path and returns its block", async () => {
		mRunCommitGate.mockResolvedValue({
			decision: "block",
			reason: "[interlinked:commit-gate] BLOCKED: suite RED",
			rule_id: "commit-gate",
		});
		const decision = await runPreToolPipeline(makeCtx(), commitEv(), makeSession());
		expect(mRunCommitGate).toHaveBeenCalledOnce();
		expect(decision.decision).toBe("block");
		expect(decision.reason).toContain("[interlinked:commit-gate]");
	});

	it("continues to allow when the commit gate returns null (clean commit)", async () => {
		mRunCommitGate.mockResolvedValue(null);
		const decision = await runPreToolPipeline(makeCtx(), commitEv(), makeSession());
		expect(mRunCommitGate).toHaveBeenCalledOnce();
		expect(decision.decision).toBe("allow");
		// Falls through to the unconditional tail stages.
		expect(mCaptureBaseline).toHaveBeenCalledOnce();
	});

	it("the commit gate runs AFTER the coverage gate (both invoked on a clean allow)", async () => {
		const phaseOrder: string[] = [];
		mRunCoverageGate.mockImplementation(async () => {
			phaseOrder.push("coverage");
			return null;
		});
		mRunCommitGate.mockImplementation(async () => {
			phaseOrder.push("commit");
			return null;
		});
		await runPreToolPipeline(makeCtx(), commitEv(), makeSession());
		expect(phaseOrder).toEqual(["coverage", "commit"]);
	});
});

// ---------------------------------------------------------------------------
// 14. Interaction: blocked decision short-circuits all allow-gated layers
// ---------------------------------------------------------------------------

describe("blocked decisions skip allow-gated layers but still run tail stages", () => {
	it("a block from the evaluator still reaches the unconditional stage helpers", async () => {
		mEvaluate.mockReturnValue({ decision: "block", reason: "BLOCKED" });
		await runPreToolPipeline(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
			makeSession(),
		);
		// captureDiffAwareBaseline + injectStructureContext run regardless of decision.
		expect(mCaptureBaseline).toHaveBeenCalledOnce();
		expect(mCaptureBaseline.mock.calls[0]?.[1]).toMatchObject({ tool_name: "Bash" });
		expect(mInjectStructure).toHaveBeenCalledOnce();
		expect(mInjectStructure.mock.calls[0]?.[1]).toMatchObject({ tool_name: "Bash" });
		// But the TDD / project-wide gates always run too (they internally gate).
		expect(mTddGate).toHaveBeenCalledOnce();
		expect(mProjectWide).toHaveBeenCalledOnce();
	});
});
