import { makeServerRuntime, makeServerRules } from "./__tests__/fixtures.js";
import { buildTestIndex } from "../__tests__/fixtures/trigram.js";
import { makeSession as makeSessionFixture } from "../__tests__/fixtures/evaluator.js";
// Behavioral coverage for the PostToolUse pipeline orchestrator.
//
// Every sibling check module is mocked at the import boundary so each branch
// of `runPostToolPipeline` is driven deterministically. `node:fs` is mocked
// so the marker-write / pending-write error paths are reachable. We import
// the real `./post-tool-pipeline.js` and assert the aggregated decision it
// returns (warnings / summary / check_results / timing / phase_breakdown).
//

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	CheckResultEntry,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import { runPostToolPipeline } from "./post-tool-pipeline.js";
import type { ServerRuntime } from "./runtime-context.js";

// ---------------------------------------------------------------------------
// Module mocks (vitest hoists these above the real-module imports below).
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(() => "file contents"),
	unlinkSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

vi.mock("../check-engine/index.js", () => ({
	getOrCreateEngine: vi.fn(() => ({ isToolAvailable: vi.fn(() => true) })),
}));

vi.mock("../content-scanner/post-scan.js", () => ({
	runPostToolScan: vi.fn(async () => ({ warnings: [], findings: [] })),
}));

vi.mock("../coverage-discharge.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../coverage-discharge.js")>();
	return {
		// Real command detection (it is the contract under test); mocked ledger
		// side-effect so no real report parse / file write happens.
		isCoverageSuiteCommand: real.isCoverageSuiteCommand,
		dischargeObligationsAfterGreenRun: vi.fn(() => []),
	};
});

vi.mock("../evaluator.js", () => ({
	evaluatePostToolUse: vi.fn((): HarnessDecision => ({ decision: "allow" })),
}));

vi.mock("../failure-channels.js", () => ({
	runFailureChannels: vi.fn(() => null),
}));

vi.mock("../server-tdd-cycle.js", () => ({
	// Real sentinel value (the whole-suite branch compares against it).
	ALL_TESTS_SENTINEL: "__all_tests__",
	detectTestRunFile: vi.fn(() => null),
	recordTestRunCycle: vi.fn(),
}));

vi.mock("../server-tool-helpers.js", () => ({
	extractAllEditedFilePaths: vi.fn(() => []),
}));

vi.mock("../skip-paths.js", () => ({
	shouldSkipPath: vi.fn(() => false),
}));

vi.mock("../tool-result-checks.js", () => ({
	checkSilentFailure: vi.fn(() => null),
	checkContextBloat: vi.fn(() => null),
	consecutiveFailureWarning: vi.fn(() => null),
	formatSilentFailureWarning: vi.fn(() => "SILENT"),
	formatBloatWarning: vi.fn(() => "BLOAT"),
}));

vi.mock("./post-tool-file-checks.js", () => ({
	runPerFileChecks: vi.fn(),
}));

vi.mock("./post-tool-warning-spool.js", () => ({
	beginPostToolWarningSpool: vi.fn(() => ({
		token: "test-delivery-token",
		sessionId: "s",
		markerPath: "/repo/.interlinked/quality-warning-spool/test.active.json",
		readyPath: "/repo/.interlinked/quality-warning-spool/test.ready.json",
		requested: true,
		ownsMarker: true,
		closed: false,
	})),
	completePostToolWarningSpool: vi.fn(),
}));

// Bind to the mocked exports so each test can re-program return values.
import { existsSync, readFileSync } from "node:fs";
import { getOrCreateEngine } from "../check-engine/index.js";
import { runPostToolScan } from "../content-scanner/post-scan.js";
import { dischargeObligationsAfterGreenRun } from "../coverage-discharge.js";
import { evaluatePostToolUse } from "../evaluator.js";
import { runFailureChannels } from "../failure-channels.js";
import { detectTestRunFile, recordTestRunCycle } from "../server-tdd-cycle.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import { shouldSkipPath } from "../skip-paths.js";
import {
	checkContextBloat,
	checkSilentFailure,
	consecutiveFailureWarning,
} from "../tool-result-checks.js";
import { runPerFileChecks } from "./post-tool-file-checks.js";
import {
	beginPostToolWarningSpool,
	completePostToolWarningSpool,
} from "./post-tool-warning-spool.js";

const mEvaluate = vi.mocked(evaluatePostToolUse);
const mDischarge = vi.mocked(dischargeObligationsAfterGreenRun);
const mPostScan = vi.mocked(runPostToolScan);
const mFailureChannels = vi.mocked(runFailureChannels);
const mDetectTestRun = vi.mocked(detectTestRunFile);
const mRecordTestRunCycle = vi.mocked(recordTestRunCycle);
const mExtractPaths = vi.mocked(extractAllEditedFilePaths);
const mShouldSkip = vi.mocked(shouldSkipPath);
const mCheckSilent = vi.mocked(checkSilentFailure);
const mCheckBloat = vi.mocked(checkContextBloat);
const mConsecutive = vi.mocked(consecutiveFailureWarning);
const mGetEngine = vi.mocked(getOrCreateEngine);
const mRunPerFile = vi.mocked(runPerFileChecks);
const mBeginWarningSpool = vi.mocked(beginPostToolWarningSpool);
const mCompleteWarningSpool = vi.mocked(completePostToolWarningSpool);
const { CheckEngine } = await vi.importActual<typeof import("../check-engine/index.js")>("../check-engine/index.js");
function engineWithAvailability(isToolAvailable: (tool: string) => boolean) {
	const engine = new CheckEngine("/repo");
	vi.spyOn(engine, "isToolAvailable").mockImplementation(isToolAvailable);
	return engine;
}
function failureOutput(warnings: string[]): NonNullable<ReturnType<typeof runFailureChannels>> {
	return { warnings, failure_id: "failure-1", signature: "test-signature", record_path: "/repo/.interlinked/failures/failure-1.json", triage: { label: "unknown", category: "test", confidence: 1, source: "local-heuristic" } };
}

const mExistsSync = vi.mocked(existsSync);
const mReadFile = vi.mocked(readFileSync);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		...partial,
	};
}

function makeSession(partial: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return ({ ...makeSessionFixture(),
		test_runs: new Map(),
		silent_failure_warned: new Set<string>(),
		bloat_warned: new Set<string>(),
		consecutive_tool_failures: new Map<string, number>(),
		acknowledged_checks: new Set<string>(),
		tool_call_count: 3,
		...partial,
	} satisfies SessionTrajectory);
}

function makeRules(partial: NonNullable<Parameters<typeof makeServerRules>[0]> = {}): GuardRulesConfig {
 return makeServerRules({ rules: ["r1", "r2"].map((id) => ({ id, enabled: true, trigger: "PostToolUse", tool_match: ["*"], action: "warn", patterns: [], reason: id, severity: "low" })), ...partial });
}

function makeCtx(overrides: NonNullable<Parameters<typeof makeServerRuntime>[0]> = {}): ServerRuntime {
	return makeServerRuntime({
		cwd: "/repo",
		interlinkedDir: "/repo/.interlinked",
		rules: makeRules(),
		cohort: {},
		reservations: {},
		contentScanner: undefined,
		compiledAllowlist: [],
		trigramIndex: null,
		fileContentCache: { set: vi.fn() },
		log: vi.fn(),
		...overrides,
	});
}

/** A minimal but fully-typed structured finding (the orchestrator only reads
 *  `allCheckResults.length`, never these fields). */
function finding(): CheckResultEntry {
	return {
		source: "quality",
		name: "x",
		severity: "warning",
		message: "m",
		determinism: "heuristic",
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Re-establish default mock implementations cleared above.
	mShouldSkip.mockReturnValue(false);
	mEvaluate.mockReturnValue({ decision: "allow" } satisfies HarnessDecision);
	mFailureChannels.mockReturnValue(null);
	mPostScan.mockResolvedValue({ warnings: [], findings: [] });
	mDetectTestRun.mockReturnValue(null);
	mExtractPaths.mockReturnValue([]);
	mCheckSilent.mockReturnValue(null);
	mCheckBloat.mockReturnValue(null);
	mConsecutive.mockReturnValue(null);
	mGetEngine.mockReturnValue(engineWithAvailability(vi.fn(() => true)));
	mRunPerFile.mockResolvedValue(undefined);
	mExistsSync.mockReturnValue(true);
	mReadFile.mockReturnValue("file contents");
});

// ---------------------------------------------------------------------------
// 1. skip_paths short-circuit
// ---------------------------------------------------------------------------

describe("skip_paths short-circuit", () => {
	it("returns allow + summary and runs nothing else when shouldSkipPath matches (file_path)", async () => {
		mShouldSkip.mockReturnValue(true);
		const ctx = makeCtx();
		const event = ev({ tool_name: "Write", tool_input: { file_path: "dist/b.js" } });
		const decision = await runPostToolPipeline(ctx, event, makeSession());
		expect(decision.decision).toBe("allow");
		expect(decision.summary).toBe("skip_paths matched (dist/b.js) — post-event pipeline skipped");
		expect(mShouldSkip).toHaveBeenCalledWith("dist/b.js", ctx.rules);
		expect(mEvaluate).not.toHaveBeenCalled();
	});

	it("derives the path from tool_input.path when file_path is absent", async () => {
		mShouldSkip.mockReturnValue(true);
		const event = ev({ tool_name: "Write", tool_input: { path: "dist/c.js" } });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.summary).toContain("dist/c.js");
	});

	it("does not short-circuit when the raw path is empty (no file_path/path)", async () => {
		const event = ev({ tool_name: "Read" });
		const ctx = makeCtx();
		const session = makeSession();
		const decision = await runPostToolPipeline(ctx, event, session);
		expect(decision.summary).toBeUndefined();
		// shouldSkipPath is short-circuited away by the empty-string guard.
		expect(mShouldSkip).not.toHaveBeenCalled();
		expect(mEvaluate).toHaveBeenCalledOnce();
		expect(mEvaluate).toHaveBeenCalledWith(event, ctx.rules, session, ctx.reservations, ctx.cohort);
	});

	it("short-circuits only when every observed effect matches skip_paths", async () => {
		mShouldSkip.mockImplementation((path: string) => path.startsWith("dist/"));
		const change_set = {
			source: "filesystem-observation" as const,
			complete: true,
			before_captured_at: "before",
			after_captured_at: "after",
			files: [
				{ path: "dist/a.js", kind: "modified" as const, before_sha256: "a", after_sha256: "b" },
			],
		};
		const skipped = await runPostToolPipeline(makeCtx(), ev({ tool_name: "Bash", change_set }), makeSession());
		expect(skipped.summary).toContain("all 1 observed");

		change_set.files.push({
			path: "src/a.ts",
			kind: "modified",
			before_sha256: "a",
			after_sha256: "b",
		});
		const checked = await runPostToolPipeline(makeCtx(), ev({ tool_name: "Bash", change_set }), makeSession());
		expect(checked.summary ?? "").not.toContain("post-event pipeline skipped");
		expect(mEvaluate).toHaveBeenCalled();
	});

	// test-contract: boundary — observed runtime control-file effects must reach evaluation even when skip_paths claims them
	it("does not short-circuit an observed control-file effect when shouldSkipPath matches", async () => {
		mShouldSkip.mockReturnValue(true);
		const change_set = {
			source: "filesystem-observation" as const,
			complete: true,
			before_captured_at: "before",
			after_captured_at: "after",
			files: [
				{
					path: ".interlinked/config.local.json",
					kind: "modified" as const,
					before_sha256: "a",
					after_sha256: "b",
				},
			],
		};
		const decision = await runPostToolPipeline(
			makeCtx(),
			ev({ tool_name: "Bash", change_set }),
			makeSession(),
		);
		expect(decision.summary ?? "").not.toContain("post-event pipeline skipped");
		expect(mEvaluate).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 2. Trigram dirty-layer update
// ---------------------------------------------------------------------------

describe("trigram dirty-layer update", () => {
	function ctxWithIndex(updateFile = vi.fn()): { ctx: ServerRuntime; updateFile: Mock } {
		const fileContentCache = { set: vi.fn(), invalidate: vi.fn() };
		const ctx = makeCtx({ trigramIndex: Object.assign(buildTestIndex({}), { updateFile }), fileContentCache });
		return { ctx, updateFile: vi.mocked(updateFile) };
	}

	it("updates the index + content cache for an in-repo file write", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		mExtractPaths.mockReturnValue([]);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/src/a.ts" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).toHaveBeenCalledWith("src/a.ts", "file contents");
		expect(ctx.fileContentCache.set).toHaveBeenCalledWith(
			"src/a.ts",
			"file contents",
		);
	});

	it("joins a relative path against cwd before reading", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		const event = ev({ tool_name: "Write", tool_input: { file_path: "src/rel.ts" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(mReadFile).toHaveBeenCalledWith("/repo/src/rel.ts", "utf-8");
		expect(updateFile).toHaveBeenCalledWith("src/rel.ts", "file contents");
	});

	it("skips the update for a non-write tool even with trigram index present", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		const event = ev({ tool_name: "Read", tool_input: { file_path: "/repo/src/a.ts" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).not.toHaveBeenCalled();
	});

	it("removes a deleted file from the index and content cache", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		mExistsSync.mockReturnValue(false); // affects both the dirty check and downstream marker writes
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/src/gone.ts" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).toHaveBeenCalledWith("src/gone.ts", null);
		expect(ctx.fileContentCache.invalidate).toHaveBeenCalledWith(
			"src/gone.ts",
		);
	});

	it("skips an out-of-tree write (relative path starts with ..)", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/other/x.ts" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).not.toHaveBeenCalled();
	});

	it("swallows a readFileSync throw inside the dirty-layer try/catch", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		mReadFile.mockImplementationOnce(() => {
			throw new Error("read boom");
		});
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/src/a.ts" } });
		const decision = await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).not.toHaveBeenCalled();
		expect(decision.decision).toBe("allow");
	});

	it("handles a write event whose file_path is empty", async () => {
		const { ctx, updateFile } = ctxWithIndex();
		const event = ev({ tool_name: "Write", tool_input: { command: "noop" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).not.toHaveBeenCalled();
	});

	it("falls back to an empty toolName (|| '') when tool_name is absent", async () => {
		// Exercises the `event.tool_name || ""` fallback while the trigram
		// index is present; with no tool name the write list never matches.
		const { ctx, updateFile } = ctxWithIndex();
		const event = ev({ tool_input: { file_path: "/repo/src/a.ts" } });
		await runPostToolPipeline(ctx, event, makeSession());
		expect(updateFile).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 3. Test-run tracking
// ---------------------------------------------------------------------------

describe("deferred-coverage discharge on an observed GREEN coverage run (finding 2026-06)", () => {
	it("fires for a coverage-suite command that completed green", async () => {
		const event = ev({
			tool_name: "Bash",
			tool_input: { command: "npx vitest run --coverage" },
			tool_outcome: "success",
		});
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mDischarge).toHaveBeenCalledTimes(1);
		expect(mDischarge).toHaveBeenCalledWith("/repo", "s", "2026-04-23T00:00:00.000Z");
	});

	it("does NOT fire for a test run without coverage", async () => {
		const event = ev({
			tool_name: "Bash",
			tool_input: { command: "npx vitest run" },
			tool_outcome: "success",
		});
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mDischarge).not.toHaveBeenCalled();
	});

	it("does NOT fire for a RED coverage run (green-ness is the evidence)", async () => {
		const event = ev({
			tool_name: "Bash",
			tool_input: { command: "npx vitest run --coverage" },
			tool_outcome: "error",
		});
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mDischarge).not.toHaveBeenCalled();
	});
});

describe("test-run tracking", () => {
	it("records a pass + drives the TDD cycle when a test runner completes green", async () => {
		mDetectTestRun.mockReturnValue("src/x.test.ts");
		const session = makeSession();
		const event = ev({
			tool_name: "Bash",
			tool_outcome: "success",
			tool_input: { command: "vitest run x" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.test_runs.get("src/x.test.ts")).toEqual({ status: "pass", at_step: 3 });
		// 4th arg: the command that produced the result, so a red cycle can name
		// its evidence in the commit-gate block reason.
		expect(mRecordTestRunCycle).toHaveBeenCalledWith(session, "src/x.test.ts", true, "vitest run x");
	});

	it("records a fail for a PostToolUseFailure hook event", async () => {
		mDetectTestRun.mockReturnValue("src/x.test.ts");
		const session = makeSession();
		const event = ev({
			hook_event: "PostToolUseFailure",
			tool_name: "Bash",
			tool_input: { command: "vitest run x" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.test_runs.get("src/x.test.ts")).toEqual({ status: "fail", at_step: 3 });
		expect(mRecordTestRunCycle).toHaveBeenCalledWith(session, "src/x.test.ts", false, "vitest run x");
	});

	it("records a fail for a folded tool_outcome=error on a regular PostToolUse (bug fix: was mis-counted as pass)", async () => {
		mDetectTestRun.mockReturnValue("src/x.test.ts");
		const session = makeSession();
		const event = ev({
			hook_event: "PostToolUse",
			tool_name: "Bash",
			tool_outcome: "error",
			tool_input: { command: "vitest run x" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.test_runs.get("src/x.test.ts")).toEqual({ status: "fail", at_step: 3 });
		expect(mRecordTestRunCycle).toHaveBeenCalledWith(session, "src/x.test.ts", false, "vitest run x");
	});

	it("records NOTHING for an interrupted test run (neither pass nor fail)", async () => {
		mDetectTestRun.mockReturnValue("src/x.test.ts");
		const session = makeSession();
		const event = ev({
			tool_name: "Bash",
			tool_outcome: "interrupted",
			tool_input: { command: "vitest run x" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.test_runs.size).toBe(0);
		expect(mRecordTestRunCycle).not.toHaveBeenCalled();
	});

	it("records NOTHING when the outcome is unproven (no tool_outcome, no failure marker)", async () => {
		mDetectTestRun.mockReturnValue("src/x.test.ts");
		const session = makeSession();
		const event = ev({ tool_name: "Bash", tool_input: { command: "vitest run x" } });
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.test_runs.size).toBe(0);
		expect(mRecordTestRunCycle).not.toHaveBeenCalled();
	});

	it("does nothing when no test runner is detected", async () => {
		mDetectTestRun.mockReturnValue(null);
		const session = makeSession();
		await runPostToolPipeline(makeCtx(), ev({ tool_name: "Bash" }), session);
		expect(mRecordTestRunCycle).not.toHaveBeenCalled();
		expect(session.test_runs.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 3b. Observed-check outcome tracking (trackVerificationOutcome)
// ---------------------------------------------------------------------------
// classifyVerificationCommand is the REAL module here (not mocked), so these
// assertions exercise the genuine red/green/neither classification and the
// last-status-wins map write. `tool_call_count` comes from makeSession (3).
describe("observed-check outcome tracking", () => {
	function obsSession(partial: Record<string, unknown> = {}): SessionTrajectory {
		return makeSession({ observed_checks: new Map(), ...partial });
	}

	it("records typecheck=red when a tsc --noEmit Bash command fails (tool_outcome error)", async () => {
		const session = obsSession();
		const event = ev({
			tool_name: "Bash",
			tool_outcome: "error",
			tool_input: { command: "tsc --noEmit" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		const entry = session.observed_checks?.get("typecheck");
		expect(entry?.status).toBe("red");
		expect(entry?.kind).toBe("typecheck");
		expect(entry?.red_at).toBe(3);
		expect(entry?.detail).toContain("tsc --noEmit");
	});

	it("records red from a dedicated PostToolUseFailure even without tool_outcome", async () => {
		const session = obsSession();
		const event = ev({
			hook_event: "PostToolUseFailure",
			tool_name: "Bash",
			tool_input: { command: "tsc --noEmit" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.observed_checks?.get("typecheck")?.status).toBe("red");
	});

	it("flips a prior red to green when a later tsc run succeeds (last-status-wins)", async () => {
		const session = obsSession({
			observed_checks: new Map([["typecheck", { kind: "typecheck", status: "red", red_at: 1 }]]),
		});
		const event = ev({
			tool_name: "Bash",
			tool_outcome: "success",
			tool_input: { command: "tsc --noEmit" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		const entry = session.observed_checks?.get("typecheck");
		expect(entry?.status).toBe("green");
		expect(entry?.green_at).toBe(3);
		// Prior red_at is preserved for audit.
		expect(entry?.red_at).toBe(1);
	});

	it("treats tool_outcome interrupted as NEITHER — leaves a prior red untouched", async () => {
		const session = obsSession({
			observed_checks: new Map([["typecheck", { kind: "typecheck", status: "red", red_at: 1 }]]),
		});
		const event = ev({
			tool_name: "Bash",
			tool_outcome: "interrupted",
			tool_input: { command: "tsc --noEmit" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		const entry = session.observed_checks?.get("typecheck");
		// Unchanged: still red, still red_at 1 (no green_at written).
		expect(entry?.status).toBe("red");
		expect(entry?.red_at).toBe(1);
		expect(entry?.green_at).toBeUndefined();
	});

	it("records nothing for a local non-verification Bash command", async () => {
		const session = obsSession();
		const event = ev({
			tool_name: "Bash",
			tool_outcome: "error",
			tool_input: { command: "ls -la" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.observed_checks?.size).toBe(0);
	});

	it("does NOT count a folded tool_outcome=error as green (the trackTestRun latent-bug case)", async () => {
		// A regular PostToolUse (not PostToolUseFailure) carrying a folded
		// tool_outcome === "error". trackTestRun's hook_event-only rule would
		// mis-mark this passed; trackVerificationOutcome's outcome-first rule
		// correctly records red.
		const session = obsSession();
		const event = ev({
			hook_event: "PostToolUse",
			tool_name: "Bash",
			tool_outcome: "error",
			tool_input: { command: "biome check ." },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.observed_checks?.get("lint")?.status).toBe("red");
	});

	it("body-scans only when tool_outcome is absent: nonzero exit_code → red", async () => {
		const session = obsSession();
		const event = ev({
			tool_name: "Bash",
			exit_code: 2,
			tool_input: { command: "go build ./..." },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.observed_checks?.get("build")?.status).toBe("red");
	});

	it("records nothing when tool_outcome is absent and no failure marker is present (neither)", async () => {
		const session = obsSession();
		const event = ev({
			tool_name: "Bash",
			exit_code: 0,
			tool_input: { command: "tsc --noEmit" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.observed_checks?.size).toBe(0);
	});

	// --- whole-suite test runs → the `test-suite` observed check (backlog 3A) --

	it("records test-suite=red when a bare `vitest run` (whole suite) fails", async () => {
		mDetectTestRun.mockReturnValue("__all_tests__");
		const session = obsSession();
		const event = ev({
			tool_name: "Bash",
			tool_outcome: "error",
			tool_input: { command: "npx vitest run" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		const entry = session.observed_checks?.get("test-suite");
		expect(entry?.status).toBe("red");
		expect(entry?.kind).toBe("test-suite");
		expect(entry?.detail).toContain("npx vitest run");
	});

	it("records test-suite=red for an unknown-runner suite command (`bun test`, detect=null)", async () => {
		// classifyVerificationCommand says "test" but detectTestRunFile doesn't
		// know the runner — still a whole-suite run (no file argument).
		mDetectTestRun.mockReturnValue(null);
		const session = obsSession();
		const event = ev({
			hook_event: "PostToolUseFailure",
			tool_name: "Bash",
			tool_input: { command: "bun test" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.observed_checks?.get("test-suite")?.status).toBe("red");
	});

	it("flips a prior test-suite red to green when a later whole-suite run passes", async () => {
		mDetectTestRun.mockReturnValue("__all_tests__");
		const session = obsSession({
			observed_checks: new Map([
				["test-suite", { kind: "test-suite", status: "red", red_at: 1 }],
			]),
		});
		const event = ev({
			tool_name: "Bash",
			tool_outcome: "success",
			tool_input: { command: "npm test" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		const entry = session.observed_checks?.get("test-suite");
		expect(entry?.status).toBe("green");
		expect(entry?.green_at).toBe(3);
		expect(entry?.red_at).toBe(1); // preserved for audit
	});

	it("does NOT record test-suite for a per-file test run (the TDD cycle owns per-file red/green)", async () => {
		mDetectTestRun.mockReturnValue("/repo/src/x.test.ts");
		const session = obsSession();
		const event = ev({
			tool_name: "Bash",
			tool_outcome: "error",
			tool_input: { command: "npx vitest run src/x.test.ts" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.observed_checks?.size).toBe(0);
		// The per-file path still flows through trackTestRun.
		expect(session.test_runs.get("/repo/src/x.test.ts")?.status).toBe("fail");
	});

	it("records NOTHING for an interrupted whole-suite run", async () => {
		mDetectTestRun.mockReturnValue("__all_tests__");
		const session = obsSession();
		const event = ev({
			tool_name: "Bash",
			tool_outcome: "interrupted",
			tool_input: { command: "npx vitest run" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.observed_checks?.size).toBe(0);
	});

	it("records NOTHING for an unproven whole-suite run (no outcome, no failure marker)", async () => {
		mDetectTestRun.mockReturnValue("__all_tests__");
		const session = obsSession();
		const event = ev({
			tool_name: "Bash",
			exit_code: 0,
			tool_input: { command: "npx vitest run" },
		});
		await runPostToolPipeline(makeCtx(), event, session);
		expect(session.observed_checks?.size).toBe(0);
	});

	// --- per-file runs of runners detectTestRunFile doesn't parse (regression
	// for the finding: mocha / bun test / ava / deno test / tap / rspec).
	// classifyVerificationCommand calls these "test", but detectTestRunFile
	// returns null whether or not a file is targeted, so a per-file run used to
	// be misread as whole-suite — a per-file green could clear a genuine
	// whole-suite red, and a per-file red could spuriously set it. detectTestRunFile
	// is mocked to null here (the default), mirroring its real behavior for these
	// runners; classifyVerificationCommand + isWholeSuiteTestCommand run for real.
	describe("per-file runs of unparsed runners don't touch the whole-suite axis", () => {
		const CASES: ReadonlyArray<{ runner: string; perFile: string; whole: string }> = [
			{ runner: "mocha", perFile: "mocha test/user.test.js", whole: "mocha" },
			{ runner: "bun test", perFile: "bun test ./src/user.test.ts", whole: "bun test" },
			{ runner: "ava", perFile: "ava test/user.test.js", whole: "ava" },
			{ runner: "deno test", perFile: "deno test src/user_test.ts", whole: "deno test" },
			{ runner: "tap", perFile: "tap test/user.test.js", whole: "tap" },
			{ runner: "rspec", perFile: "rspec spec/models/user_spec.rb", whole: "rspec" },
		];

		for (const { runner, perFile, whole } of CASES) {
			it(`drops a per-file ${runner} RED run from the whole-suite axis`, async () => {
				mDetectTestRun.mockReturnValue(null); // real behavior: runner not parsed
				const session = obsSession();
				const event = ev({
					tool_name: "Bash",
					tool_outcome: "error",
					tool_input: { command: perFile },
				});
				await runPostToolPipeline(makeCtx(), event, session);
				// Per-file red must NOT spuriously set the whole-suite axis.
				expect(session.observed_checks?.size).toBe(0);
			});

			it(`a per-file ${runner} GREEN run does NOT clear a whole-suite red`, async () => {
				mDetectTestRun.mockReturnValue(null);
				const session = obsSession({
					observed_checks: new Map([
						["test-suite", { kind: "test-suite", status: "red", red_at: 1 }],
					]),
				});
				const event = ev({
					tool_name: "Bash",
					tool_outcome: "success",
					tool_input: { command: perFile },
				});
				await runPostToolPipeline(makeCtx(), event, session);
				// The whole-suite red survives — a per-file green is not the suite.
				expect(session.observed_checks?.get("test-suite")?.status).toBe("red");
			});

			it(`still records test-suite=red for a bare (whole-suite) ${runner} run`, async () => {
				mDetectTestRun.mockReturnValue(null);
				const session = obsSession();
				const event = ev({
					tool_name: "Bash",
					tool_outcome: "error",
					tool_input: { command: whole },
				});
				await runPostToolPipeline(makeCtx(), event, session);
				expect(session.observed_checks?.get("test-suite")?.status).toBe("red");
			});
		}
	});
});

// ---------------------------------------------------------------------------
// 4. Failure-recovery channels
// ---------------------------------------------------------------------------

describe("failure-recovery channels", () => {
	it("appends channel warnings when tool_outcome is error", async () => {
		mFailureChannels.mockReturnValue(failureOutput(["CHAN-1", "CHAN-2"]));
		const ctx = makeCtx();
		const event = ev({ tool_name: "Bash", tool_outcome: "error" });
		const session = makeSession();
		const decision = await runPostToolPipeline(ctx, event, session);
		expect(decision.warnings).toEqual(["CHAN-1", "CHAN-2"]);
		expect(mFailureChannels).toHaveBeenCalledOnce();
		expect(mFailureChannels).toHaveBeenCalledWith({ event, session, cwd: ctx.cwd });
	});

	it("merges channel warnings into an existing warnings array", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["EXISTING"] });
		mFailureChannels.mockReturnValue(failureOutput(["CHAN"]));
		const event = ev({ tool_name: "Bash", tool_outcome: "error" });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.warnings).toEqual(["EXISTING", "CHAN"]);
	});

	it("does not append when the channel output has no warnings", async () => {
		mFailureChannels.mockReturnValue(failureOutput([]));
		const event = ev({ tool_name: "Bash", tool_outcome: "error" });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.warnings).toBeUndefined();
	});

	it("does not append when the channel output is null", async () => {
		mFailureChannels.mockReturnValue(null);
		const event = ev({ tool_name: "Bash", tool_outcome: "error" });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.warnings).toBeUndefined();
	});

	it("skips channels entirely when tool_outcome is not error", async () => {
		const event = ev({ tool_name: "Bash", tool_outcome: "success" });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mFailureChannels).not.toHaveBeenCalled();
	});

	it("fails open (logs, no throw) when the channel orchestrator throws an Error", async () => {
		const log = vi.fn();
		mFailureChannels.mockImplementation(() => {
			throw new Error("orchestrator boom");
		});
		const event = ev({ tool_name: "Bash", tool_outcome: "error" });
		const decision = await runPostToolPipeline(makeCtx({ log }), event, makeSession());
		expect(decision.decision).toBe("allow");
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("Failure-recovery channels error: orchestrator boom"),
		);
	});

	it("stringifies a non-Error throw from the channel orchestrator", async () => {
		const log = vi.fn();
		mFailureChannels.mockImplementation(() => {
			throw "plain string boom";
		});
		const event = ev({ tool_name: "Bash", tool_outcome: "error" });
		await runPostToolPipeline(makeCtx({ log }), event, makeSession());
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("Failure-recovery channels error: plain string boom"),
		);
	});
});

// ---------------------------------------------------------------------------
// 5. Content scanner post-scan
// ---------------------------------------------------------------------------

describe("content scanner post-scan", () => {
	function ctxWithScanner(): ServerRuntime {
		return makeCtx({
			contentScanner: { name: "fixture", runtime: "http", ready: vi.fn(async () => true), scan: vi.fn(async () => []), shutdown: vi.fn(async () => {}) },
			rules: makeRules({ content_scanner: { enabled: true } }),
		});
	}

	it("appends post-scan warnings when scanner enabled and warnings produced", async () => {
		mPostScan.mockResolvedValue({ warnings: ["PII-RATCHET"], findings: [] });
		const ctx = ctxWithScanner();
		const event = ev({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } });
		const session = makeSession();
		const decision = await runPostToolPipeline(ctx, event, session);
		expect(decision.warnings).toEqual(["PII-RATCHET"]);
		expect(mPostScan).toHaveBeenCalledOnce();
		expect(mPostScan).toHaveBeenCalledWith({
			event,
			session,
			rules: ctx.rules,
			scanner: ctx.contentScanner,
			compiledAllowlist: ctx.compiledAllowlist,
		});
	});

	it("merges post-scan warnings into an existing warnings array", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["PRE"] });
		mPostScan.mockResolvedValue({ warnings: ["PII"], findings: [] });
		const event = ev({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } });
		const decision = await runPostToolPipeline(ctxWithScanner(), event, makeSession());
		expect(decision.warnings).toEqual(["PRE", "PII"]);
	});

	it("does not append when post-scan returns no warnings", async () => {
		mPostScan.mockResolvedValue({ warnings: [], findings: [] });
		const event = ev({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } });
		const decision = await runPostToolPipeline(ctxWithScanner(), event, makeSession());
		expect(decision.warnings).toBeUndefined();
	});

	it("skips post-scan when contentScanner is absent", async () => {
		const ctx = makeCtx({ rules: makeRules({ content_scanner: { enabled: true } }) });
		await runPostToolPipeline(ctx, ev({ tool_name: "Read" }), makeSession());
		expect(mPostScan).not.toHaveBeenCalled();
	});

	it("skips post-scan when content_scanner config is disabled", async () => {
		const ctx = makeCtx({ contentScanner: { name: "fixture", runtime: "http", ready: vi.fn(async () => true), scan: vi.fn(async () => []), shutdown: vi.fn(async () => {}) } });
		await runPostToolPipeline(ctx, ev({ tool_name: "Read" }), makeSession());
		expect(mPostScan).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 6. Tool-response checks (silent-failure / bloat / consecutive)
// ---------------------------------------------------------------------------

describe("tool-response checks", () => {
	it("pushes a silent-failure warning and records it once per tool", async () => {
		mCheckSilent.mockReturnValue({ pattern: "body-error", detail: "tool response reported an error" });
		const session = makeSession();
		const event = ev({ tool_name: "mcp__x", tool_response: { ok: false } });
		const decision = await runPostToolPipeline(makeCtx(), event, session);
		expect(decision.warnings).toContain("SILENT");
		expect(session.silent_failure_warned.has("mcp__x")).toBe(true);
		expect(decision.checks_ran).toContain("silent-failure");
	});

	it("does not re-fire silent-failure when the tool is already warned", async () => {
		mCheckSilent.mockReturnValue({ pattern: "body-error", detail: "tool response reported an error" });
		const session = makeSession({ silent_failure_warned: new Set(["mcp__x"]) });
		const event = ev({ tool_name: "mcp__x" });
		const decision = await runPostToolPipeline(makeCtx(), event, session);
		expect(mCheckSilent).not.toHaveBeenCalled();
		expect(decision.warnings ?? []).not.toContain("SILENT");
	});

	it("does not push silent-failure when the check returns null", async () => {
		mCheckSilent.mockReturnValue(null);
		const decision = await runPostToolPipeline(
			makeCtx(),
			ev({ tool_name: "mcp__x" }),
			makeSession(),
		);
		expect(mCheckSilent).toHaveBeenCalledOnce();
		expect(decision.warnings ?? []).not.toContain("SILENT");
	});

	it("pushes a context-bloat warning and records it once per tool", async () => {
		mCheckBloat.mockReturnValue({ approx_tokens: 9000, chars: 9000 * 4 });
		const session = makeSession();
		const decision = await runPostToolPipeline(makeCtx(), ev({ tool_name: "Grep" }), session);
		expect(decision.warnings).toContain("BLOAT");
		expect(session.bloat_warned.has("Grep")).toBe(true);
		expect(decision.checks_ran).toContain("context-bloat");
	});

	it("does not re-fire context-bloat when already warned", async () => {
		mCheckBloat.mockReturnValue({ approx_tokens: 9000, chars: 9000 * 4 });
		const session = makeSession({ bloat_warned: new Set(["Grep"]) });
		await runPostToolPipeline(makeCtx(), ev({ tool_name: "Grep" }), session);
		expect(mCheckBloat).not.toHaveBeenCalled();
	});

	it("pushes a consecutive-error warning from the existing failure counter", async () => {
		mConsecutive.mockReturnValue("CONSEC");
		const session = makeSession({
			consecutive_tool_failures: new Map([["Bash", 3]]),
		});
		const decision = await runPostToolPipeline(makeCtx(), ev({ tool_name: "Bash" }), session);
		expect(decision.warnings).toContain("CONSEC");
		expect(decision.checks_ran).toContain("consecutive-errors");
		expect(mConsecutive).toHaveBeenCalledWith(3, "Bash");
	});

	it("passes 0 to the consecutive check when no counter entry exists (|| fallback)", async () => {
		mConsecutive.mockReturnValue(null);
		await runPostToolPipeline(makeCtx(), ev({ tool_name: "Bash" }), makeSession());
		expect(mConsecutive).toHaveBeenCalledWith(0, "Bash");
	});

	it("skips all tool-response checks when tool_name is absent", async () => {
		await runPostToolPipeline(makeCtx(), ev({}), makeSession());
		expect(mCheckSilent).not.toHaveBeenCalled();
		expect(mCheckBloat).not.toHaveBeenCalled();
		expect(mConsecutive).not.toHaveBeenCalled();
	});

	it("appends silent-failure / bloat / consecutive into a pre-existing warnings array", async () => {
		// Pre-seeds postDecision.warnings so the `!postDecision.warnings`
		// guards on all three tool-response pushes take their false branch.
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["SEED"] });
		mCheckSilent.mockReturnValue({ pattern: "body-error", detail: "tool response reported an error" });
		mCheckBloat.mockReturnValue({ approx_tokens: 9000, chars: 9000 * 4 });
		mConsecutive.mockReturnValue("CONSEC");
		const session = makeSession({ consecutive_tool_failures: new Map([["Bash", 4]]) });
		const decision = await runPostToolPipeline(makeCtx(), ev({ tool_name: "Bash" }), session);
		expect(decision.warnings).toEqual(["SEED", "SILENT", "BLOAT", "CONSEC"]);
	});
});

// ---------------------------------------------------------------------------
// 7. Edited-path resolution (direct edit / Bash detection / neither)
// ---------------------------------------------------------------------------

describe("edited-path resolution", () => {
	it("runs per-file checks for a direct file edit via extractAllEditedFilePaths", async () => {
		mExtractPaths.mockReturnValue(["/repo/a.ts", "/repo/b.ts"]);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mExtractPaths).toHaveBeenCalledWith(event);
		// One per-file call per extracted path.
		expect(mRunPerFile).toHaveBeenCalledTimes(2);
		expect(mRunPerFile.mock.calls[0]?.[3]).toBe("/repo/a.ts");
		expect(mRunPerFile.mock.calls[1]?.[3]).toBe("/repo/b.ts");
	});

	it("falls back to the empty-string single-path when a direct edit yields no paths", async () => {
		mExtractPaths.mockReturnValue([]);
		const event = ev({ tool_name: "Write", tool_input: { command: "x" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		// shouldRunChecks is true (isDirectFileEdit) so the loop runs once with "".
		expect(mRunPerFile).toHaveBeenCalledTimes(1);
		expect(mRunPerFile.mock.calls[0]?.[3]).toBe("");
	});

	it("extracts an edited file path from a Bash command", async () => {
		const event = ev({
			tool_name: "Bash",
			tool_input: { command: "sed -i 's/a/b/' src/util.ts" },
		});
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mRunPerFile).toHaveBeenCalledTimes(1);
		expect(mRunPerFile.mock.calls[0]?.[3]).toBe("src/util.ts");
	});

	it("does not run per-file checks for a Bash command touching no source file", async () => {
		const event = ev({ tool_name: "Bash", tool_input: { command: "ls -la" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mRunPerFile).not.toHaveBeenCalled();
	});

	it("does not run per-file checks for a non-edit, non-Bash tool", async () => {
		const event = ev({ tool_name: "WebFetch", tool_input: { url: "https://x" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mRunPerFile).not.toHaveBeenCalled();
	});

	it("handles a Bash event with no command string", async () => {
		const event = ev({ tool_name: "Bash" });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mRunPerFile).not.toHaveBeenCalled();
	});

	it("passes a shared accumulator across the per-file fan-out", async () => {
		mExtractPaths.mockReturnValue(["/repo/a.ts", "/repo/b.ts"]);
		let firstAcc: PerFileCheckCtx | undefined;
		let secondAcc: PerFileCheckCtx | undefined;
		mRunPerFile.mockImplementation(
			async (_ctx, _ev, _se, _path, _dec, acc: PerFileCheckCtx) => {
				if (!firstAcc) firstAcc = acc;
				else secondAcc = acc;
			},
		);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(firstAcc).toBeDefined();
		expect(firstAcc).toBe(secondAcc);
		expect(firstAcc?.projectWideSweepFired).toBe(false);
		expect(firstAcc?.recurrenceCursor).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 8. Request-owned warning spool orchestration
// ---------------------------------------------------------------------------

describe("request-owned warning spool orchestration", () => {
	it("begins one spool record and publishes accumulated warnings", async () => {
		mRunPerFile.mockImplementation(
			async (_ctx, _ev, _se, _path, decision: HarnessDecision) => {
				decision.warnings = ["W1"];
			},
		);
		const event = ev({
			tool_name: "Edit",
			tool_input: { file_path: "/repo/a.ts" },
			post_delivery_token: "request-token-0001",
		});
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mBeginWarningSpool).toHaveBeenCalledWith("/repo/.interlinked", event);
		expect(mCompleteWarningSpool).toHaveBeenCalledWith(
			expect.objectContaining({ ownsMarker: true }),
			["W1"],
		);
	});

	it("publishes an empty warning list for a clean request", async () => {
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mCompleteWarningSpool).toHaveBeenCalledWith(expect.any(Object), []);
	});

	it("logs an unavailable spool but keeps the synchronous decision", async () => {
		const log = vi.fn();
		mBeginWarningSpool.mockReturnValueOnce({
			token: "unavailable-token",
			sessionId: "s",
			markerPath: "active",
			readyPath: "ready",
			requested: true,
			ownsMarker: false,
			closed: false,
		});
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		const decision = await runPostToolPipeline(makeCtx({ log }), event, makeSession());
		expect(log).toHaveBeenCalledWith(expect.stringContaining("spool unavailable"));
		expect(decision.decision).toBe("allow");
	});

	it("does not log a spool failure for a rolling-upgrade hook with no delivery token", async () => {
		const log = vi.fn();
		mBeginWarningSpool.mockReturnValueOnce({
			token: "missing-token",
			sessionId: "s",
			markerPath: "active",
			readyPath: "ready",
			requested: false,
			ownsMarker: false,
			closed: false,
		});
		await runPostToolPipeline(
			makeCtx({ log }),
			ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } }),
			makeSession(),
		);
		expect(log).not.toHaveBeenCalledWith(expect.stringContaining("spool unavailable"));
	});

	it("publishes an explicit NOT CHECKED diagnostic when a per-file check throws", async () => {
		mRunPerFile.mockRejectedValueOnce(new Error("check failed"));
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		await expect(runPostToolPipeline(makeCtx(), event, makeSession())).rejects.toThrow(
			"check failed",
		);
		expect(mCompleteWarningSpool).toHaveBeenCalledWith(expect.any(Object), [
			expect.stringMatching(/NOT CHECKED.*interlinked verify/),
		]);
	});

	it("logs a publish failure without replacing the synchronous result", async () => {
		const log = vi.fn();
		mCompleteWarningSpool.mockImplementationOnce(() => {
			throw new Error("publish failed");
		});
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		const decision = await runPostToolPipeline(makeCtx({ log }), event, makeSession());
		expect(log).toHaveBeenCalledWith(expect.stringContaining("Quality warning spool error"));
		expect(decision.decision).toBe("allow");
	});

	it("persists a warning-less block reason for late delivery", async () => {
		mEvaluate.mockReturnValue({ decision: "block", reason: "late block reason", warnings: [] });
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mCompleteWarningSpool).toHaveBeenCalledWith(expect.any(Object), [
			"late block reason",
		]);
	});

	it("persists the block reason before warnings and removes exact duplicates", async () => {
		mEvaluate.mockReturnValue({
			decision: "block",
			reason: "late block reason",
			warnings: ["supporting warning", "late block reason"],
		});
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(mCompleteWarningSpool).toHaveBeenCalledWith(expect.any(Object), [
			"late block reason",
			"supporting warning",
		]);
	});
});

// ---------------------------------------------------------------------------
// 9. Tail aggregation: check_results / checks_ran / tool_breakdown / phases
// ---------------------------------------------------------------------------

describe("tail aggregation of structured results", () => {
	it("attaches check_results, checks_ran (deduped), timing, tool_breakdown, and phase_breakdown", async () => {
		const f = finding();
		mRunPerFile.mockImplementation(
			async (_ctx, _ev, _se, _path, _dec, acc: PerFileCheckCtx) => {
				acc.allCheckResults.push(f);
				acc.checksRan.push("structural", "structural", "typescript");
				acc.postToolMetrics.push({ tool: "tsc", ms: 12, finding_count: 1 });
			},
		);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.check_results).toEqual([f]);
		expect(decision.checks_ran).toEqual(["structural", "typescript"]);
		expect(typeof decision.checks_timing_ms).toBe("number");
		expect(decision.tool_breakdown).toEqual([{ tool: "tsc", ms: 12, finding_count: 1 }]);
		expect(decision.phase_breakdown).toBeDefined();
		expect(Object.keys(decision.phase_breakdown ?? {})).toEqual(
			expect.arrayContaining(["pre_tool_response", "tool_response_checks", "session_persist"]),
		);
	});

	it("omits check_results / checks_ran / tool_breakdown when nothing accumulated", async () => {
		const event = ev({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.check_results).toBeUndefined();
		expect(decision.checks_ran).toBeUndefined();
		expect(decision.checks_timing_ms).toBeUndefined();
		expect(decision.tool_breakdown).toBeUndefined();
		// phase_breakdown is always attached.
		expect(decision.phase_breakdown).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// 10. Required-tool coverage
// ---------------------------------------------------------------------------

describe("required-tool coverage", () => {
	it("warns once per missing required tool and acknowledges it", async () => {
		mGetEngine.mockReturnValue(engineWithAvailability(vi.fn(() => false)));
		const ctx = makeCtx({ rules: makeRules({ required_tools: ["tsc"] }) });
		const session = makeSession();
		const decision = await runPostToolPipeline(ctx, ev({ tool_name: "Read" }), session);
		expect(decision.warnings?.some((w) => w.includes('Required tool "tsc"'))).toBe(true);
		expect(session.acknowledged_checks.has("required-tool-missing::tsc")).toBe(true);
		expect(mCompleteWarningSpool).toHaveBeenCalledWith(
			expect.any(Object),
			expect.arrayContaining([expect.stringContaining('Required tool "tsc"')]),
		);
	});

	it("merges the required-tool warning into an existing warnings array", async () => {
		mEvaluate.mockReturnValue({ decision: "allow", warnings: ["PRE"] });
		mGetEngine.mockReturnValue(engineWithAvailability(vi.fn(() => false)));
		const ctx = makeCtx({ rules: makeRules({ required_tools: ["tsc"] }) });
		const decision = await runPostToolPipeline(ctx, ev({ tool_name: "Read" }), makeSession());
		expect(decision.warnings?.[0]).toBe("PRE");
		expect(decision.warnings?.some((w) => w.includes('Required tool "tsc"'))).toBe(true);
	});

	it("does not warn when the required tool is available", async () => {
		mGetEngine.mockReturnValue(engineWithAvailability(vi.fn(() => true)));
		const ctx = makeCtx({ rules: makeRules({ required_tools: ["tsc"] }) });
		const decision = await runPostToolPipeline(ctx, ev({ tool_name: "Read" }), makeSession());
		expect(decision.warnings ?? []).not.toContainEqual(expect.stringContaining("Required tool"));
	});

	it("skips a required tool already acknowledged this session", async () => {
		const isToolAvailable = vi.fn(() => false);
		mGetEngine.mockReturnValue(engineWithAvailability(isToolAvailable));
		const ctx = makeCtx({ rules: makeRules({ required_tools: ["tsc"] }) });
		const session = makeSession({
			acknowledged_checks: new Set(["required-tool-missing::tsc"]),
		});
		await runPostToolPipeline(ctx, ev({ tool_name: "Read" }), session);
		expect(isToolAvailable).not.toHaveBeenCalled();
	});

	it("skips the required-tool block entirely when required_tools is empty", async () => {
		await runPostToolPipeline(makeCtx(), ev({ tool_name: "Read" }), makeSession());
		expect(mGetEngine).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 11. All-clean summary line
// ---------------------------------------------------------------------------

describe("all-clean summary line", () => {
	it("emits a positive summary mapping check names when no warnings and checks ran", async () => {
		mRunPerFile.mockImplementation(
			async (_ctx, _ev, _se, _path, _dec, acc: PerFileCheckCtx) => {
				acc.checksRan.push(
					"structural",
					"typescript",
					"biome_lint",
					"secrets_in_source",
					"affected_tests",
					"custom_check",
				);
			},
		);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.summary).toMatch(/^\[interlinked\] ✓ 2 guard rules, /);
		expect(decision.summary).toContain("structural");
		expect(decision.summary).toContain("tsc");
		expect(decision.summary).toContain("biome");
		expect(decision.summary).toContain("secrets");
		expect(decision.summary).toContain("tests");
		// Unmapped names: underscores → dashes.
		expect(decision.summary).toContain("custom-check");
		expect(decision.summary).toMatch(/all clean \(\d+ms\)/);
	});

	it("does not emit a summary when there are warnings", async () => {
		mRunPerFile.mockImplementation(
			async (_ctx, _ev, _se, _path, decision: HarnessDecision, acc: PerFileCheckCtx) => {
				acc.checksRan.push("typescript");
				decision.warnings = ["a finding"];
			},
		);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } });
		const decision = await runPostToolPipeline(makeCtx(), event, makeSession());
		expect(decision.summary).toBeUndefined();
	});

	it("does not emit a summary when no checks ran (non-edit, clean)", async () => {
		const decision = await runPostToolPipeline(
			makeCtx(),
			ev({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } }),
			makeSession(),
		);
		expect(decision.summary).toBeUndefined();
	});
});
