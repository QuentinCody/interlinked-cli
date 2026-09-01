// Behavioral coverage for `runPerFileChecks` — the PostToolUse per-file body.
//
// Every sibling check module and the six extracted check phases are mocked at
// the import boundary so each branch of `runPerFileChecks` is driven
// deterministically (no tsc spawn, no real project graph, no filesystem). We
// import the real `./post-tool-file-checks.js` and assert the real per-file
// aggregation: how structural / impact / deletion-hygiene findings flow into
// `decision.warnings`, `decision.decision`, `acc.allCheckResults`,
// `session.*`, and the recurrence/effectiveness/ack tail.
//
// Argument assertions go through vitest matchers (`toHaveBeenCalledWith` +
// `expect.objectContaining`/`arrayContaining`) rather than casting
// `mock.mock.calls[i]`, so the test needs no `as` casts on call arguments.
// `makeCtx`/`makeGraph` use one fixture-boundary `as unknown as` each to avoid
// satisfying every field of the ~30-field ServerRuntime interface (the same
// pattern the sibling post-tool-pipeline.test.ts uses).

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ProjectGraph } from "../project-graph.js";
import type {
	CheckResultEntry,
	ExportedSymbol,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

// ---------------------------------------------------------------------------
// Module mocks (vitest hoists these above the real-module imports below).
// `node:fs` is mocked wholesale; everything else spreads the real module and
// overrides only the functions this body calls, so the factories stay
// complete and type-checked.
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
}));

vi.mock("./post-tool-file-checks-phases.js", () => ({
	runQualityPhase: vi.fn(async () => 0),
	runProjectWideSweepPhase: vi.fn(async () => {}),
	runScoredSuggestionsPhase: vi.fn(() => {}),
	runShotgunSurgeryPhase: vi.fn(() => {}),
	runStructureChecksPhase: vi.fn(() => {}),
	runBehavioralPhase: vi.fn(() => {}),
}));

vi.mock("./runtime-context.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./runtime-context.js")>()),
	getGraphForFile: vi.fn(),
}));

vi.mock("../structural-checks.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../structural-checks.js")>()),
	runStructuralChecks: vi.fn(() => []),
	formatStructuralWarnings: vi.fn(() => []),
	shouldSkipTsc: vi.fn(() => true),
}));

vi.mock("../impact-analysis.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../impact-analysis.js")>()),
	runImpactAnalysis: vi.fn(),
	formatImpactWarning: vi.fn(() => []),
	recordImpactFollowUps: vi.fn(),
}));

vi.mock("../dependency-view.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../dependency-view.js")>()),
	resolveDependencyView: vi.fn(() => ({})),
}));

vi.mock("../deletion-hygiene.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../deletion-hygiene.js")>()),
	checkOrphanedTests: vi.fn(() => []),
}));

vi.mock("../recurrence.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../recurrence.js")>()),
	recordHarnessCaught: vi.fn(),
}));

vi.mock("../server-tdd-cycle.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../server-tdd-cycle.js")>()),
	recordImplEdit: vi.fn(),
	recordTestWrite: vi.fn(),
}));

vi.mock("../feedback-effectiveness.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../feedback-effectiveness.js")>()),
	recordWarningResolutions: vi.fn(),
	recordWarningsIssued: vi.fn(),
}));

vi.mock("../suppressions.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../suppressions.js")>()),
	loadFileSuppressions: vi.fn(() => new Set<string>()),
}));

vi.mock("../session-state.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../session-state.js")>()),
	acknowledgeChecks: vi.fn(),
	isAcknowledged: vi.fn(() => false),
}));

// Bind to the mocked exports so each test can re-program return values.
import { existsSync, readFileSync } from "node:fs";
import { checkOrphanedTests } from "../deletion-hygiene.js";
import {
	recordWarningResolutions,
	recordWarningsIssued,
} from "../feedback-effectiveness.js";
import {
	formatImpactWarning,
	recordImpactFollowUps,
	runImpactAnalysis,
} from "../impact-analysis.js";
import { recordHarnessCaught } from "../recurrence.js";
import { recordImplEdit, recordTestWrite } from "../server-tdd-cycle.js";
import { acknowledgeChecks, isAcknowledged } from "../session-state.js";
import {
	formatStructuralWarnings,
	runStructuralChecks,
	shouldSkipTsc,
} from "../structural-checks.js";
import { loadFileSuppressions } from "../suppressions.js";
import { runPerFileChecks } from "./post-tool-file-checks.js";
import {
	runBehavioralPhase,
	runProjectWideSweepPhase,
	runQualityPhase,
	runScoredSuggestionsPhase,
	runShotgunSurgeryPhase,
	runStructureChecksPhase,
} from "./post-tool-file-checks-phases.js";
import { getGraphForFile } from "./runtime-context.js";

const mExistsSync = existsSync as unknown as Mock;
const mReadFileSync = readFileSync as unknown as Mock;
const mGetGraph = getGraphForFile as unknown as Mock;
const mRunStructural = runStructuralChecks as unknown as Mock;
const mFormatStructural = formatStructuralWarnings as unknown as Mock;
const mShouldSkipTsc = shouldSkipTsc as unknown as Mock;
const mRunImpact = runImpactAnalysis as unknown as Mock;
const mFormatImpact = formatImpactWarning as unknown as Mock;
const mRecordImpactFollowUps = recordImpactFollowUps as unknown as Mock;
const mCheckOrphaned = checkOrphanedTests as unknown as Mock;
const mRecordHarnessCaught = recordHarnessCaught as unknown as Mock;
const mRecordImplEdit = recordImplEdit as unknown as Mock;
const mRecordTestWrite = recordTestWrite as unknown as Mock;
const mLoadFileSup = loadFileSuppressions as unknown as Mock;
const mIsAck = isAcknowledged as unknown as Mock;
const mAck = acknowledgeChecks as unknown as Mock;
const mRecordWarningsIssued = recordWarningsIssued as unknown as Mock;
const mRecordWarningResolutions = recordWarningResolutions as unknown as Mock;
const mQualityPhase = runQualityPhase as unknown as Mock;
const mSweepPhase = runProjectWideSweepPhase as unknown as Mock;
const mSuggestionsPhase = runScoredSuggestionsPhase as unknown as Mock;
const mShotgunPhase = runShotgunSurgeryPhase as unknown as Mock;
const mStructurePhase = runStructureChecksPhase as unknown as Mock;
const mBehavioralPhase = runBehavioralPhase as unknown as Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CWD = resolve("/repo");
const IN_REPO = resolve(CWD, "src/mod.ts");

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		tool_name: "Edit",
		tool_input: { file_path: IN_REPO },
		...partial,
	};
}

function exp(name: string): ExportedSymbol {
	return { name, kind: "function", isTypeOnly: false, line: 1 };
}

/** A real-shaped session — the body reads `files_written`, `failed_files`,
 *  `pending_completions`, `tool_sequence`, `tool_call_count`, `agent_name`. */
function makeSession(partial: Partial<SessionTrajectory> = {}): SessionTrajectory {
	const base: Partial<SessionTrajectory> = {
		agent_name: "agent-x",
		tool_call_count: 7,
		files_written: new Set<string>(),
		failed_files: new Map(),
		pending_completions: new Map(),
		tool_sequence: ["Read", "Edit"],
	};
	return { ...base, ...partial } as SessionTrajectory;
}

function makeRules(partial: Record<string, unknown> = {}): GuardRulesConfig {
	return {
		structural_checks: { enabled: true, impact_analysis: false },
		quality_checks: {},
		error_memory: { enabled: false },
		...partial,
	} as unknown as GuardRulesConfig;
}

/** A fully-typed fake ProjectGraph covering the methods the body calls. */
function makeGraph(over: Record<string, unknown> = {}): ProjectGraph {
	const g = {
		isInitialized: true,
		getExports: vi.fn((): ExportedSymbol[] => []),
		getInterfaceBodies: vi.fn(() => new Map<string, string>()),
		updateFile: vi.fn(),
		toRelative: vi.fn((f: string) => f.replace(`${CWD}/`, "")),
		classifyModule: vi.fn(() => "leaf"),
		getDependents: vi.fn((): string[] => []),
		getDependencies: vi.fn((): unknown[] => []),
		...over,
	};
	return g as unknown as ProjectGraph;
}

function makeCtx(over: Record<string, unknown> = {}): ServerRuntime {
	return {
		cwd: CWD,
		interlinkedDir: resolve(CWD, ".interlinked"),
		rules: makeRules(),
		sessions: {},
		routeMap: { updateFile: vi.fn() },
		errorHistory: {
			recordError: vi.fn(async () => {}),
			recordFix: vi.fn(),
		},
		preEditBaselines: new Map(),
		filePriorityMap: new Map(),
		log: vi.fn(),
		...over,
	} as unknown as ServerRuntime;
}

function makeAcc(partial: Partial<PerFileCheckCtx> = {}): PerFileCheckCtx {
	return {
		postStartMs: Date.now(),
		allCheckResults: [],
		checksRan: [],
		postToolMetrics: [],
		markPhase: vi.fn(),
		projectWideSweepFired: false,
		recurrenceCursor: 0,
		...partial,
	};
}

beforeEach(() => {
	// resetAllMocks (not clearAllMocks) so per-test `mockImplementation`
	// overrides (e.g. a suggestion phase that pushes a finding) don't leak
	// into later tests — clearAllMocks only resets call history, not impls.
	vi.resetAllMocks();
	mExistsSync.mockReturnValue(false);
	mReadFileSync.mockReturnValue("");
	mGetGraph.mockReturnValue(makeGraph());
	mRunStructural.mockReturnValue([]);
	mFormatStructural.mockReturnValue([]);
	mShouldSkipTsc.mockReturnValue(true);
	mRunImpact.mockReturnValue(undefined);
	mFormatImpact.mockReturnValue([]);
	mCheckOrphaned.mockReturnValue([]);
	mLoadFileSup.mockReturnValue(new Set<string>());
	mIsAck.mockReturnValue(false);
	// Phase mocks default to inert no-ops; individual tests re-program them.
	mQualityPhase.mockResolvedValue(0);
	mSweepPhase.mockResolvedValue(undefined);
	mSuggestionsPhase.mockReturnValue(undefined);
	mShotgunPhase.mockReturnValue(undefined);
	mStructurePhase.mockReturnValue(undefined);
	mBehavioralPhase.mockReturnValue(undefined);
});

// ===========================================================================
// 1. Synthetic checkEvent + file path resolution
// ===========================================================================

describe("checkEvent construction + path resolution", () => {
	it("injects file_path into a synthetic checkEvent when a path is given", async () => {
		const ctx = makeCtx();
		await runPerFileChecks(ctx, ev({ tool_input: {} }), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		// runStructuralChecks receives the synthetic event carrying file_path.
		expect(mRunStructural).toHaveBeenCalledWith(
			expect.objectContaining({ tool_input: expect.objectContaining({ file_path: IN_REPO }) }),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});

	it("falls back to the original event and resolves no path when both are empty", async () => {
		const ctx = makeCtx();
		// Empty currentEditedPath → ternary picks the original `event`; with no
		// file_path on it either, editedFilePath resolves "" so the structural
		// block is skipped while the quality phase still runs (path-independent).
		await runPerFileChecks(ctx, ev({ tool_input: {} }), makeSession(), "", { decision: "allow" }, makeAcc());
		expect(mRunStructural).not.toHaveBeenCalled();
		expect(mQualityPhase).toHaveBeenCalledOnce();
	});

	it("treats an out-of-tree file as not-in-repo (editedFileInRepo=false)", async () => {
		const ctx = makeCtx();
		const outside = resolve("/elsewhere/foo.ts");
		await runPerFileChecks(
			ctx,
			ev({ tool_input: { file_path: outside } }),
			makeSession(),
			outside,
			{ decision: "allow" },
			makeAcc(),
		);
		// editedFileInRepo is the 4th positional arg of runQualityPhase / 3rd of
		// the sweep / 3rd of the structure phase.
		expect(mQualityPhase).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			false,
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
		expect(mSweepPhase).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			false,
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
		expect(mStructurePhase).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			false,
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});

	it("treats an in-repo file as in-repo (editedFileInRepo=true)", async () => {
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mQualityPhase).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			true,
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});

	it("treats the repo root itself as in-repo", async () => {
		await runPerFileChecks(
			makeCtx(),
			ev({ tool_input: { file_path: CWD } }),
			makeSession(),
			CWD,
			{ decision: "allow" },
			makeAcc(),
		);
		expect(mQualityPhase).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			true,
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});
});

// ===========================================================================
// 2. TDD cycle tracking
// ===========================================================================

describe("TDD cycle tracking", () => {
	it("records a test write for a test-file path", async () => {
		const session = makeSession();
		const testPath = resolve(CWD, "src/mod.test.ts");
		await runPerFileChecks(
			makeCtx(),
			ev({ tool_input: { file_path: testPath } }),
			session,
			testPath,
			{ decision: "allow" },
			makeAcc(),
		);
		expect(mRecordTestWrite).toHaveBeenCalledWith(session, testPath, expect.any(String));
		expect(mRecordImplEdit).not.toHaveBeenCalled();
	});

	it("records an impl edit for a non-test path", async () => {
		const session = makeSession();
		await runPerFileChecks(makeCtx(), ev(), session, IN_REPO, { decision: "allow" }, makeAcc());
		expect(mRecordImplEdit).toHaveBeenCalledWith(session, IN_REPO, expect.any(String));
		expect(mRecordTestWrite).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 3. Structural-checks gating (the three-way branch)
// ===========================================================================

describe("structural-checks gating", () => {
	it("runs structural checks when enabled + graph initialized + path present", async () => {
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mRunStructural).toHaveBeenCalledOnce();
	});

	it("updates the graph but skips checks when structural_checks disabled", async () => {
		const graph = makeGraph();
		mGetGraph.mockReturnValue(graph);
		const ctx = makeCtx({ rules: makeRules({ structural_checks: { enabled: false } }) });
		await runPerFileChecks(ctx, ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mRunStructural).not.toHaveBeenCalled();
		expect(graph.updateFile).toHaveBeenCalledWith(IN_REPO);
	});

	it("skips graph update entirely when the graph is uninitialized", async () => {
		const graph = makeGraph({ isInitialized: false });
		mGetGraph.mockReturnValue(graph);
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(graph.updateFile).not.toHaveBeenCalled();
		expect(mRunStructural).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 4. Structural results: suppression + ack filtering, collection, warnings
// ===========================================================================

describe("structural results filtering + collection", () => {
	function structResult(over: Record<string, unknown> = {}) {
		return {
			check: "export_surface",
			severity: "warning",
			message: "surface changed",
			file: IN_REPO,
			...over,
		};
	}

	it("collects warnings, formats them, and records failed_files", async () => {
		mRunStructural.mockReturnValue([structResult()]);
		mFormatStructural.mockReturnValue(["[structural] surface changed"]);
		const session = makeSession();
		const decision: HarnessDecision = { decision: "allow" };
		const acc = makeAcc();
		await runPerFileChecks(makeCtx(), ev(), session, IN_REPO, decision, acc);
		expect(acc.allCheckResults).toHaveLength(1);
		expect(acc.allCheckResults[0]).toMatchObject({ source: "structural", name: "export_surface" });
		expect(decision.warnings).toContain("[structural] surface changed");
		expect(session.failed_files.get(IN_REPO)).toMatchObject({ checks: ["export_surface"] });
	});

	it("filters out JSON-suppressed structural checks", async () => {
		mRunStructural.mockReturnValue([structResult({ check: "import_resolution" })]);
		mLoadFileSup.mockReturnValue(new Set(["import_resolution"]));
		const acc = makeAcc();
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, acc);
		expect(acc.allCheckResults).toHaveLength(0);
	});

	it("suppresses an acknowledged warning but keeps an acknowledged error", async () => {
		mRunStructural.mockReturnValue([
			structResult({ check: "warn_check", severity: "warning" }),
			structResult({ check: "err_check", severity: "error" }),
		]);
		mIsAck.mockReturnValue(true); // both acknowledged
		const acc = makeAcc();
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, acc);
		const names = acc.allCheckResults.map((r) => r.name);
		expect(names).toEqual(["err_check"]); // warning dropped, error retained
	});

	it("does not record failed_files when no error/warning checks remain", async () => {
		mRunStructural.mockReturnValue([structResult({ severity: "info" })]);
		const session = makeSession();
		await runPerFileChecks(makeCtx(), ev(), session, IN_REPO, { decision: "allow" }, makeAcc());
		expect(session.failed_files.size).toBe(0);
	});
});

// ===========================================================================
// 5. Deterministic-actionable blocking
// ===========================================================================

describe("structural deterministic blocking", () => {
	it("blocks on a fully_deterministic error/warning finding", async () => {
		// import_resolution is fully_deterministic in STRUCTURAL_CHECK_META.
		mRunStructural.mockReturnValue([
			{ check: "import_resolution", severity: "error", message: "bad import", file: IN_REPO },
		]);
		const decision: HarnessDecision = { decision: "allow" };
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, decision, makeAcc());
		expect(decision.decision).toBe("block");
	});

	it("does NOT block on a heuristic finding (blast_radius)", async () => {
		mRunStructural.mockReturnValue([
			{ check: "blast_radius", severity: "warning", message: "wide", file: IN_REPO },
		]);
		const decision: HarnessDecision = { decision: "allow" };
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, decision, makeAcc());
		expect(decision.decision).toBe("allow");
	});
});

// ===========================================================================
// 6. Impact analysis branch vs fallback
// ===========================================================================

describe("impact analysis", () => {
	const structResults = [
		{ check: "export_surface", severity: "warning", message: "m", file: IN_REPO, affectedFiles: ["a.ts"] },
	];

	function impactResult(over: Record<string, unknown> = {}) {
		return {
			file: IN_REPO,
			severity: "high",
			moduleRole: "hub",
			dependentCount: 3,
			breakingFiles: ["a.ts"],
			testFiles: [],
			followUpFiles: ["a.ts"],
			exportSurfaceChanged: true,
			summary: "impact",
			...over,
		};
	}

	function impactRules(extra: Record<string, unknown> = {}) {
		return makeRules({
			structural_checks: { enabled: true, impact_analysis: true, ...extra },
		});
	}

	it("runs impact analysis and surfaces its warnings when enabled", async () => {
		mRunStructural.mockReturnValue(structResults);
		mRunImpact.mockReturnValue(impactResult());
		mFormatImpact.mockReturnValue(["[impact] 3 dependents"]);
		const ctx = makeCtx({ rules: impactRules() });
		const decision: HarnessDecision = { decision: "allow" };
		await runPerFileChecks(ctx, ev(), makeSession(), IN_REPO, decision, makeAcc());
		expect(mRunImpact).toHaveBeenCalledOnce();
		expect(mRecordImpactFollowUps).toHaveBeenCalledOnce();
		expect(decision.warnings).toContain("[impact] 3 dependents");
	});

	it("passes the configured high threshold (impact_high_threshold)", async () => {
		mRunStructural.mockReturnValue(structResults);
		mRunImpact.mockReturnValue(impactResult());
		const ctx = makeCtx({ rules: impactRules({ impact_high_threshold: 9 }) });
		await runPerFileChecks(ctx, ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mRunImpact).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			{ highThreshold: 9 },
		);
	});


	it("blocks when impact severity is critical", async () => {
		mRunStructural.mockReturnValue(structResults);
		mRunImpact.mockReturnValue(impactResult({ severity: "critical" }));
		const ctx = makeCtx({ rules: impactRules() });
		const decision: HarnessDecision = { decision: "allow" };
		await runPerFileChecks(ctx, ev(), makeSession(), IN_REPO, decision, makeAcc());
		expect(decision.decision).toBe("block");
	});

	it("appends structural + impact warnings onto a decision that already has warnings", async () => {
		// Pre-seeded decision.warnings exercises the `(decision.warnings || [])`
		// left arm at both the structural-append and impact-append sites.
		mRunStructural.mockReturnValue(structResults);
		mFormatStructural.mockReturnValue(["[structural] s"]);
		mRunImpact.mockReturnValue(impactResult());
		mFormatImpact.mockReturnValue(["[impact] i"]);
		const ctx = makeCtx({ rules: impactRules() });
		const decision: HarnessDecision = { decision: "allow", warnings: ["[pre] existing"] };
		await runPerFileChecks(ctx, ev(), makeSession(), IN_REPO, decision, makeAcc());
		expect(decision.warnings).toEqual(["[pre] existing", "[structural] s", "[impact] i"]);
	});

	it("does not append impact warnings when formatImpactWarning returns none", async () => {
		mRunStructural.mockReturnValue(structResults);
		mRunImpact.mockReturnValue(impactResult());
		mFormatImpact.mockReturnValue([]);
		mFormatStructural.mockReturnValue([]);
		const ctx = makeCtx({ rules: impactRules() });
		const decision: HarnessDecision = { decision: "allow" };
		await runPerFileChecks(ctx, ev(), makeSession(), IN_REPO, decision, makeAcc());
		expect((decision.warnings ?? []).some((w) => w.includes("[impact]"))).toBe(false);
	});

	it("falls back to pending_completions when impact analysis is disabled", async () => {
		mRunStructural.mockReturnValue(structResults);
		const session = makeSession();
		// impact_analysis defaults to false in makeRules.
		await runPerFileChecks(makeCtx(), ev(), session, IN_REPO, { decision: "allow" }, makeAcc());
		expect(mRunImpact).not.toHaveBeenCalled();
		expect(session.pending_completions.get(IN_REPO)).toMatchObject({
			source_file: IN_REPO,
			affected_files: ["a.ts"],
		});
	});

	it("fallback ignores export_surface findings without affected files", async () => {
		mRunStructural.mockReturnValue([
			{ check: "export_surface", severity: "warning", message: "m", file: IN_REPO },
		]);
		const session = makeSession();
		await runPerFileChecks(makeCtx(), ev(), session, IN_REPO, { decision: "allow" }, makeAcc());
		expect(session.pending_completions.size).toBe(0);
	});
});

// ===========================================================================
// 7. Error-memory error branch
// ===========================================================================

describe("error history (error branch)", () => {
	// A warning + an error: exercises both arms of the `severity === "error"
	// || severity === "warning"` guard inside the error-memory loop.
	const failing = [
		{ check: "import_resolution", severity: "error", message: "boom", file: IN_REPO },
		{ check: "circular_imports", severity: "warning", message: "cycle", file: IN_REPO },
	];
	// Single finding for the line-derivation tests (one recordError call).
	const singleError = [
		{ check: "import_resolution", severity: "error", message: "boom", file: IN_REPO },
	];

	function errMemCtx(recordError: Mock, over: Record<string, unknown> = {}) {
		// A graph whose getExports returns symbols so the `.map(e => e.name)`
		// export-name projection in the error-context builder is exercised.
		mGetGraph.mockReturnValue(makeGraph({ getExports: vi.fn(() => [exp("alpha"), exp("beta")]) }));
		return makeCtx({
			rules: makeRules({ error_memory: { enabled: true } }),
			errorHistory: { recordError, recordFix: vi.fn() },
			...over,
		});
	}

	it("records errors when error_memory is enabled (warning + error findings)", async () => {
		mRunStructural.mockReturnValue(failing);
		const recordError = vi.fn(async () => {});
		await runPerFileChecks(
			errMemCtx(recordError),
			ev({ tool_input: { file_path: IN_REPO, old_string: "old", new_string: "new", content: "c" } }),
			makeSession(),
			IN_REPO,
			{ decision: "allow" },
			makeAcc(),
		);
		// One recordError per error/warning finding (both qualify).
		expect(recordError).toHaveBeenCalledTimes(2);
	});

	it("does NOT record errors when error_memory is disabled", async () => {
		mRunStructural.mockReturnValue(failing);
		const recordError = vi.fn(async () => {});
		const ctx = makeCtx({ errorHistory: { recordError, recordFix: vi.fn() } });
		await runPerFileChecks(ctx, ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(recordError).not.toHaveBeenCalled();
	});

	it("skips info-severity findings inside the error-memory loop", async () => {
		// One error (recorded) + one info (skipped by the severity guard).
		mRunStructural.mockReturnValue([
			{ check: "import_resolution", severity: "error", message: "boom", file: IN_REPO },
			{ check: "test_proximity", severity: "info", message: "fyi", file: IN_REPO },
		]);
		const recordError = vi.fn(async () => {});
		await runPerFileChecks(
			errMemCtx(recordError),
			ev({ tool_input: { file_path: IN_REPO } }),
			makeSession(),
			IN_REPO,
			{ decision: "allow" },
			makeAcc(),
		);
		// Only the error finding is recorded; the info one is skipped.
		expect(recordError).toHaveBeenCalledTimes(1);
	});

	it("derives line_start from old_string when the file is readable", async () => {
		mRunStructural.mockReturnValue(singleError);
		mReadFileSync.mockReturnValue("line1\nNEEDLE here\nline3");
		const recordError = vi.fn(async () => {});
		await runPerFileChecks(
			errMemCtx(recordError),
			ev({ tool_input: { file_path: IN_REPO, old_string: "NEEDLE" } }),
			makeSession(),
			IN_REPO,
			{ decision: "allow" },
			makeAcc(),
		);
		// 7th positional arg of recordError is the options bag carrying line_start.
		expect(recordError).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ line_start: 2 }),
		);
	});

	it("swallows a readFileSync throw during line derivation", async () => {
		mRunStructural.mockReturnValue(singleError);
		mReadFileSync.mockImplementation(() => {
			throw new Error("EACCES");
		});
		const recordError = vi.fn(async () => {});
		await runPerFileChecks(
			errMemCtx(recordError),
			ev({ tool_input: { file_path: IN_REPO, old_string: "x" } }),
			makeSession(),
			IN_REPO,
			{ decision: "allow" },
			makeAcc(),
		);
		expect(recordError).toHaveBeenCalledOnce();
		// No line_start key when derivation threw.
		expect(recordError).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ line_start: expect.anything() }),
		);
	});

	it("omits line_start when old_string is not present in the file", async () => {
		mRunStructural.mockReturnValue(singleError);
		mReadFileSync.mockReturnValue("nothing matches");
		const recordError = vi.fn(async () => {});
		await runPerFileChecks(
			errMemCtx(recordError),
			ev({ tool_input: { file_path: IN_REPO, old_string: "ABSENT" } }),
			makeSession(),
			IN_REPO,
			{ decision: "allow" },
			makeAcc(),
		);
		expect(recordError).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ line_start: expect.anything() }),
		);
	});

	it("co_edited_files excludes the edited file itself", async () => {
		mRunStructural.mockReturnValue(failing);
		const other = resolve(CWD, "src/other.ts");
		const recordError = vi.fn(async () => {});
		mGetGraph.mockReturnValue(
			makeGraph({ toRelative: vi.fn((f: string) => f.replace(`${CWD}/`, "")) }),
		);
		const session = makeSession({ files_written: new Set([IN_REPO, other]) });
		await runPerFileChecks(errMemCtx(recordError), ev(), session, IN_REPO, { decision: "allow" }, makeAcc());
		expect(recordError).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ co_edited_files: ["src/other.ts"] }),
		);
	});
});

// ===========================================================================
// 8. Error-memory no-failure (fix) branch
// ===========================================================================

describe("error history (fix branch)", () => {
	it("records a fix when checks pass and error_memory is enabled (with edit strings + exports)", async () => {
		// No structural results → the no-failures else branch runs.
		mRunStructural.mockReturnValue([]);
		// getExports returns symbols so the fix-context `.map(e => e.name)` runs.
		mGetGraph.mockReturnValue(makeGraph({ getExports: vi.fn(() => [exp("gamma")]) }));
		const recordFix = vi.fn();
		const ctx = makeCtx({
			rules: makeRules({ error_memory: { enabled: true } }),
			errorHistory: { recordError: vi.fn(async () => {}), recordFix },
		});
		await runPerFileChecks(
			ctx,
			ev({ tool_input: { file_path: IN_REPO, old_string: "o", new_string: "n", content: "c" } }),
			makeSession(),
			IN_REPO,
			{ decision: "allow" },
			makeAcc(),
		);
		expect(recordFix).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
		);
	});

	it("records a fix omitting absent edit strings (no old/new/content)", async () => {
		// Drives the `... !== undefined ? {...} : {}` empty-arm of each spread.
		mRunStructural.mockReturnValue([]);
		const recordFix = vi.fn();
		const ctx = makeCtx({
			rules: makeRules({ error_memory: { enabled: true } }),
			errorHistory: { recordError: vi.fn(async () => {}), recordFix },
		});
		await runPerFileChecks(
			ctx,
			ev({ tool_input: { file_path: IN_REPO } }), // no old_string/new_string/content
			makeSession(),
			IN_REPO,
			{ decision: "allow" },
			makeAcc(),
		);
		expect(recordFix).toHaveBeenCalledOnce();
	});

	it("clears a stale failed_files entry on a clean pass", async () => {
		mRunStructural.mockReturnValue([]);
		const session = makeSession({
			failed_files: new Map([
				[IN_REPO, { failure_count: 1, checks: ["x"], recorded_at: "t", tool_call_count: 1 }],
			]),
		});
		await runPerFileChecks(makeCtx(), ev(), session, IN_REPO, { decision: "allow" }, makeAcc());
		expect(session.failed_files.has(IN_REPO)).toBe(false);
	});

	it("does not record a fix when error_memory is disabled", async () => {
		mRunStructural.mockReturnValue([]);
		const recordFix = vi.fn();
		const ctx = makeCtx({ errorHistory: { recordError: vi.fn(async () => {}), recordFix } });
		await runPerFileChecks(ctx, ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(recordFix).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 9. Deletion-hygiene (orphaned tests)
// ===========================================================================

describe("deletion hygiene (orphaned tests)", () => {
	// oldExports has a symbol; newExports (graph.getExports) returns none → removed.
	function ctxWithRemoval(testFileExists: boolean, orphans: unknown[]): ServerRuntime {
		const graph = makeGraph({
			// First call (oldExports capture) returns one symbol; subsequent
			// calls (newExports / deletion-hygiene) return none.
			getExports: vi.fn().mockReturnValueOnce([exp("removedFn")]).mockReturnValue([]),
		});
		mGetGraph.mockReturnValue(graph);
		mExistsSync.mockReturnValue(testFileExists);
		mReadFileSync.mockReturnValue("import { removedFn } from '../mod';");
		mCheckOrphaned.mockReturnValue(orphans);
		return makeCtx();
	}

	it("emits orphaned-test findings + warnings when a co-located test still references a removed export", async () => {
		const orphan = { check: "orphaned-test-reference", line: 0, message: "still referenced", source: "quality" };
		const ctx = ctxWithRemoval(true, [orphan]);
		// No structural results + no pre-seeded warnings → the deletion-hygiene
		// append takes the `(decision.warnings || [])` default-`[]` arm.
		const decision: HarnessDecision = { decision: "allow" };
		const acc = makeAcc();
		await runPerFileChecks(ctx, ev(), makeSession(), IN_REPO, decision, acc);
		expect(acc.allCheckResults.some((r) => r.name === "orphaned-test-reference")).toBe(true);
		expect(decision.warnings?.some((w) => w.includes("[deletion-hygiene:orphaned-test-reference]"))).toBe(true);
	});

	it("appends orphan warnings onto a decision that already carries warnings", async () => {
		// Pre-seeded warnings exercise the left arm of the same `|| []` default.
		const orphan = { check: "orphaned-test-reference", line: 0, message: "ref", source: "quality" };
		const ctx = ctxWithRemoval(true, [orphan]);
		const decision: HarnessDecision = { decision: "allow", warnings: ["[pre] keep"] };
		await runPerFileChecks(ctx, ev(), makeSession(), IN_REPO, decision, makeAcc());
		expect(decision.warnings?.[0]).toBe("[pre] keep");
		expect(decision.warnings?.some((w) => w.includes("[deletion-hygiene:"))).toBe(true);
	});

	it("reads an existing candidate but emits nothing when no orphans are found", async () => {
		// existsSync=true + readFileSync ok + checkOrphanedTests returns [] →
		// the `orphanFindings.length > 0` guard takes its skip (else) arm.
		const ctx = ctxWithRemoval(true, []);
		const acc = makeAcc();
		await runPerFileChecks(ctx, ev(), makeSession(), IN_REPO, { decision: "allow" }, acc);
		expect(mCheckOrphaned).toHaveBeenCalled();
		expect(acc.allCheckResults.some((r) => r.name === "orphaned-test-reference")).toBe(false);
	});

	it("skips test candidates that do not exist on disk", async () => {
		const ctx = ctxWithRemoval(false, []);
		await runPerFileChecks(ctx, ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mCheckOrphaned).not.toHaveBeenCalled();
	});

	it("swallows a readFileSync throw while reading a candidate test file", async () => {
		const graph = makeGraph({
			getExports: vi.fn().mockReturnValueOnce([exp("removedFn")]).mockReturnValue([]),
		});
		mGetGraph.mockReturnValue(graph);
		mExistsSync.mockReturnValue(true);
		mReadFileSync.mockImplementation(() => {
			throw new Error("read fail");
		});
		const decision: HarnessDecision = { decision: "allow" };
		// Must not throw; orphan check is never reached for that candidate.
		await expect(
			runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, decision, makeAcc()),
		).resolves.toBeUndefined();
		expect(mCheckOrphaned).not.toHaveBeenCalled();
	});

	it("skips deletion hygiene when no exports were removed", async () => {
		// getExports returns the same set both times → nothing removed.
		const graph = makeGraph({ getExports: vi.fn(() => [exp("keepFn")]) });
		mGetGraph.mockReturnValue(graph);
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mCheckOrphaned).not.toHaveBeenCalled();
	});

	it("skips deletion hygiene for a file with no recognized source extension", async () => {
		const noExt = resolve(CWD, "src/data");
		const graph = makeGraph({
			getExports: vi.fn().mockReturnValueOnce([exp("removedFn")]).mockReturnValue([]),
		});
		mGetGraph.mockReturnValue(graph);
		mExistsSync.mockReturnValue(true);
		await runPerFileChecks(
			makeCtx(),
			ev({ tool_input: { file_path: noExt } }),
			makeSession(),
			noExt,
			{ decision: "allow" },
			makeAcc(),
		);
		expect(mCheckOrphaned).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 10. shouldSkipTsc → exportSurfaceChanged threading
// ===========================================================================

describe("export surface change detection", () => {
	it("threads exportSurfaceChanged=true into the quality + sweep phases", async () => {
		mShouldSkipTsc.mockReturnValue(false); // surface changed
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		// runQualityPhase arg 5 (index 4) = exportSurfaceChanged; sweep arg 4 (index 3).
		expect(mQualityPhase).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			true,
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
		expect(mSweepPhase).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			true,
			expect.anything(),
			expect.anything(),
		);
	});

	it("threads exportSurfaceChanged=false when shouldSkipTsc returns true", async () => {
		mShouldSkipTsc.mockReturnValue(true);
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mQualityPhase).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			false,
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});
});

// ===========================================================================
// 11. Route map update
// ===========================================================================

describe("route map update", () => {
	it("updates the route map for a real path", async () => {
		const updateFile = vi.fn();
		const ctx = makeCtx({ routeMap: { updateFile } });
		await runPerFileChecks(ctx, ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(updateFile).toHaveBeenCalledWith(IN_REPO);
	});

	it("does not touch the route map for an empty path", async () => {
		const updateFile = vi.fn();
		const ctx = makeCtx({ routeMap: { updateFile } });
		// No file_path on the event + empty currentEditedPath → editedFilePath "".
		await runPerFileChecks(ctx, ev({ tool_input: {} }), makeSession(), "", { decision: "allow" }, makeAcc());
		expect(updateFile).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 12. Phase orchestration (all six phases invoked in order)
// ===========================================================================

describe("phase orchestration", () => {
	it("invokes all six check phases for a real edit", async () => {
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mQualityPhase).toHaveBeenCalledOnce();
		expect(mSweepPhase).toHaveBeenCalledOnce();
		expect(mSuggestionsPhase).toHaveBeenCalledOnce();
		expect(mShotgunPhase).toHaveBeenCalledOnce();
		expect(mStructurePhase).toHaveBeenCalledOnce();
		expect(mBehavioralPhase).toHaveBeenCalledOnce();
	});

	it("threads the quality-phase suppression baseline into the behavioral phase", async () => {
		mQualityPhase.mockResolvedValue(42);
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		// runBehavioralPhase(checkEvent, editedFilePath, previousSuppressionCount, ...)
		expect(mBehavioralPhase).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			42,
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});
});

// ===========================================================================
// 13. Feedback effectiveness
// ===========================================================================

describe("feedback effectiveness", () => {
	it("records warnings issued + resolutions when actionable findings exist", async () => {
		mRunStructural.mockReturnValue([
			{ check: "import_resolution", severity: "warning", message: "m", file: IN_REPO },
		]);
		const session = makeSession();
		await runPerFileChecks(makeCtx(), ev(), session, IN_REPO, { decision: "allow" }, makeAcc());
		expect(mRecordWarningResolutions).toHaveBeenCalledOnce();
		expect(mRecordWarningsIssued).toHaveBeenCalledWith(
			session,
			IN_REPO,
			expect.arrayContaining([expect.objectContaining({ name: "import_resolution" })]),
		);
	});

	it("includes the line number in warning evidence when present", async () => {
		// A suggestion phase that pushes a result with a line number.
		mSuggestionsPhase.mockImplementation(
			(_ctx, _ev, _path, _session, _decision, acc: PerFileCheckCtx) => {
				acc.allCheckResults.push({
					source: "suggestion",
					name: "magic_number",
					severity: "warning",
					message: "m",
					file: IN_REPO,
					line: 17,
					determinism: "heuristic",
				});
			},
		);
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mRecordWarningsIssued).toHaveBeenCalledWith(
			expect.anything(),
			IN_REPO,
			expect.arrayContaining([{ name: "magic_number", line: 17 }]),
		);
	});

	it("records resolutions but not issuance when only info-level findings exist", async () => {
		mSuggestionsPhase.mockImplementation((_c, _e, _p, _s, _d, acc: PerFileCheckCtx) => {
			acc.allCheckResults.push({
				source: "structure",
				name: "info_only",
				severity: "info",
				message: "m",
				determinism: "heuristic",
			});
		});
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mRecordWarningsIssued).not.toHaveBeenCalled();
		expect(mRecordWarningResolutions).toHaveBeenCalledOnce();
	});

	it("records nothing when there are zero findings", async () => {
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mRecordWarningsIssued).not.toHaveBeenCalled();
		expect(mRecordWarningResolutions).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 14. Session-ack of shown warnings
// ===========================================================================

describe("session-ack of shown warnings", () => {
	it("acknowledges warning-level findings so they don't re-fire", async () => {
		mRunStructural.mockReturnValue([
			{ check: "import_resolution", severity: "warning", message: "m", file: IN_REPO },
		]);
		const session = makeSession();
		await runPerFileChecks(makeCtx(), ev(), session, IN_REPO, { decision: "allow" }, makeAcc());
		expect(mAck).toHaveBeenCalledWith(session, IN_REPO, ["import_resolution"]);
	});

	it("does not acknowledge when only error-level findings exist", async () => {
		mRunStructural.mockReturnValue([
			{ check: "import_resolution", severity: "error", message: "m", file: IN_REPO },
		]);
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mAck).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 15. Recurrence consolidation
// ===========================================================================

describe("recurrence consolidation", () => {
	it("mirrors each error/warning finding once and advances the cursor", async () => {
		mRunStructural.mockReturnValue([
			{ check: "a_warn", severity: "warning", message: "m1", file: IN_REPO },
			{ check: "b_err", severity: "error", message: "m2", file: IN_REPO },
		]);
		const acc = makeAcc();
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, acc);
		expect(mRecordHarnessCaught).toHaveBeenCalledTimes(2);
		expect(acc.recurrenceCursor).toBe(acc.allCheckResults.length);
		expect(mRecordHarnessCaught).toHaveBeenCalledWith(
			expect.objectContaining({
				check_id: "a_warn",
				agent_source: "claude",
				session_id: "sess-1",
				severity: "warning",
			}),
		);
	});

	it("skips info-level findings in the recurrence mirror", async () => {
		mSuggestionsPhase.mockImplementation((_c, _e, _p, _s, _d, acc: PerFileCheckCtx) => {
			acc.allCheckResults.push({
				source: "structure",
				name: "info_only",
				severity: "info",
				message: "m",
				determinism: "heuristic",
			});
		});
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mRecordHarnessCaught).not.toHaveBeenCalled();
	});

	it("only mirrors findings past the incoming cursor (prior files not replayed)", async () => {
		mRunStructural.mockReturnValue([
			{ check: "new_warn", severity: "warning", message: "m", file: IN_REPO },
		]);
		// Pre-seed one prior finding and a cursor already past it.
		const prior: CheckResultEntry = {
			source: "quality",
			name: "old_warn",
			severity: "warning",
			message: "prior",
			determinism: "heuristic",
		};
		const acc = makeAcc({ allCheckResults: [prior], recurrenceCursor: 1 });
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, acc);
		// Only the newly-appended structural warning is mirrored, not the prior one.
		expect(mRecordHarnessCaught).toHaveBeenCalledTimes(1);
		expect(mRecordHarnessCaught).toHaveBeenCalledWith(
			expect.objectContaining({ check_id: "new_warn" }),
		);
	});

	it("uses the result's own file (relative) when present, else the edited path", async () => {
		const otherAbs = resolve(CWD, "src/dep.ts");
		mRunStructural.mockReturnValue([
			{ check: "with_file", severity: "warning", message: "m", file: otherAbs },
			{ check: "no_file", severity: "warning", message: "m" },
		]);
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, makeAcc());
		expect(mRecordHarnessCaught).toHaveBeenCalledWith(
			expect.objectContaining({ check_id: "with_file", file: "src/dep.ts" }),
		);
		expect(mRecordHarnessCaught).toHaveBeenCalledWith(
			expect.objectContaining({ check_id: "no_file", file: "src/mod.ts" }),
		);
	});

	it("does not advance the cursor or record when there are no new findings", async () => {
		const acc = makeAcc();
		await runPerFileChecks(makeCtx(), ev(), makeSession(), IN_REPO, { decision: "allow" }, acc);
		expect(mRecordHarnessCaught).not.toHaveBeenCalled();
		expect(acc.recurrenceCursor).toBe(0);
	});
});

// ===========================================================================
// 16. Falsy-session edge (TDD recording keyed on `session`)
// ===========================================================================

describe("falsy session handling", () => {
	it("skips TDD recording when session is null", async () => {
		// The body guards `if (session && editedFilePath)` for TDD; a falsy
		// session must not call recordImplEdit/recordTestWrite. Structural
		// checks are disabled here so the only session-keyed branch reached
		// is the TDD guard (the structural block itself is not session-gated
		// and would dereference a null session by design — never called that
		// way in production).
		const ctx = makeCtx({ rules: makeRules({ structural_checks: { enabled: false } }) });
		await runPerFileChecks(
			ctx,
			ev(),
			null as unknown as SessionTrajectory,
			IN_REPO,
			{ decision: "allow" },
			makeAcc(),
		);
		expect(mRecordImplEdit).not.toHaveBeenCalled();
		expect(mRecordTestWrite).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 17. Source-level pins (preserved from the original suite). These read the
// real source text through node:fs/promises (NOT the mocked node:fs) so the
// regression assertions survive the module-boundary mocking above.
// ===========================================================================

const FILE_CHECKS_TS = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"post-tool-file-checks.ts",
);

describe("recurrence consolidation — source-level pins", () => {
	it("imports recordHarnessCaught from recurrence.js", async () => {
		const src = await readFile(FILE_CHECKS_TS, "utf-8");
		expect(src).toMatch(
			/import\s*\{\s*recordHarnessCaught\s*\}\s*from\s*["']\.\.\/recurrence\.js["']/,
		);
	});

	it("walks allCheckResults via a cursor and fires recordHarnessCaught for every error/warning", async () => {
		const src = await readFile(FILE_CHECKS_TS, "utf-8");
		const consolidationBlock = src.match(
			/for\s*\(\s*let\s+i\s*=\s*acc\.recurrenceCursor[\s\S]*?recordHarnessCaught\(\{[\s\S]*?\}\);[\s\S]*?\}\s*acc\.recurrenceCursor\s*=\s*allCheckResults\.length/,
		);
		expect(consolidationBlock, "cursor-driven consolidation pass missing").toBeTruthy();
		const block = consolidationBlock?.[0] ?? "";
		expect(block).toContain('r.severity !== "error"');
		expect(block).toContain('r.severity !== "warning"');
		expect(block).toContain("check_id: r.name");
		expect(block).toContain("agent_source: event.agent_source");
		expect(block).toContain("session_id: event.session_id");
	});

	it("does NOT nest the recurrence write inside error_memory.enabled", async () => {
		const src = await readFile(FILE_CHECKS_TS, "utf-8");
		const idx = src.indexOf("if (rules.error_memory.enabled)");
		expect(idx, "error_memory block missing").toBeGreaterThan(-1);
		let depth = 0;
		let started = false;
		let end = idx;
		for (let i = idx; i < src.length; i++) {
			const c = src[i];
			if (c === "{") {
				depth++;
				started = true;
			} else if (c === "}") {
				depth--;
				if (started && depth === 0) {
					end = i + 1;
					break;
				}
			}
		}
		expect(src.slice(idx, end)).not.toContain("recordHarnessCaught(");
	});

	it("does NOT scope the recurrence write to a single source kind", async () => {
		const src = await readFile(FILE_CHECKS_TS, "utf-8");
		const block =
			src.match(
				/Mirror EVERY actionable check failure[\s\S]*?allCheckResults\.length\s*>\s*acc\.recurrenceCursor/,
			) ?? [];
		expect(block.length).toBeGreaterThan(0);
	});
});
