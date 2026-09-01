// Behavioral coverage for the six extracted PostToolUse per-file check phases
// in `./post-tool-file-checks-phases.js`.
//
// Each phase mutates `decision` / `session` / `acc` in place and (for the
// quality phase) returns a number. Every sibling check module and `node:fs`
// are mocked at the import boundary so each branch is driven deterministically
// — no tsc spawn, no real project graph, no filesystem. We import the REAL
// phase functions and assert the REAL phase outputs: how findings flow into
// `decision.warnings`, `decision.decision`, `acc.allCheckResults`,
// `acc.checksRan`, `session.pending_completions`, and the phase marks.
//
// Argument/return assertions go through vitest matchers (`toHaveBeenCalledWith`
// + `expect.objectContaining` / `arrayContaining`) and concrete value checks
// rather than casting `mock.mock.calls[i]`. `makeCtx` uses one fixture-boundary
// `as unknown as` to avoid satisfying every field of the ~30-field
// ServerRuntime interface (the same pattern the sibling tests use).

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	CheckResultEntry,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

const { createChangeSetExternalBatch, batchResultsForFile } = vi.hoisted(() => ({
	createChangeSetExternalBatch: vi.fn(),
	batchResultsForFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks (vitest hoists these above the real-module imports below).
// `node:fs` is mocked wholesale; everything else spreads the real module and
// overrides only the functions the phases call, so the factories stay complete
// and type-checked.
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
}));

vi.mock("../behavioral-checks.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../behavioral-checks.js")>()),
	runBehavioralChecks: vi.fn(() => []),
	checkAssertionDensity: vi.fn(() => null),
}));

vi.mock("../quality-checks.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../quality-checks.js")>()),
	runQualityChecks: vi.fn(async () => []),
	runProjectWideChecksAsync: vi.fn(async () => ({
		findings: [],
		toolsRun: [],
		elapsedMs: 0,
	})),
	formatQualityWarnings: vi.fn(() => []),
	countSuppressionDirectives: vi.fn(() => 0),
	findProjectRoot: vi.fn((_f: string, cwd: string) => cwd),
}));

vi.mock("../quality-checks/change-set-external.js", () => ({
	MULTI_FILE_NAMED_EXTERNAL_CHECKS: new Set(["affected_tests", "dependency_audit"]),
	createChangeSetExternalBatch,
}));

vi.mock("../session-state.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../session-state.js")>()),
	acknowledgeChecks: vi.fn(),
	isAcknowledged: vi.fn(() => false),
}));

vi.mock("../sibling-expansion.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../sibling-expansion.js")>()),
	expandSiblings: vi.fn(() => []),
}));

vi.mock("../structure/structure-checks.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../structure/structure-checks.js")>()),
	runStructureChecks: vi.fn(),
}));

vi.mock("../structure/structure-formatter.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../structure/structure-formatter.js")>()),
	formatStructureWarnings: vi.fn(() => []),
}));

vi.mock("../structure/structure-loader.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../structure/structure-loader.js")>()),
	loadStructureConfig: vi.fn(() => ({ config: { loaded: true } })),
}));

vi.mock("../suggestion-scorer.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../suggestion-scorer.js")>()),
	scoreFindings: vi.fn(() => []),
	formatScoredFindings: vi.fn(() => []),
	writeTelemetry: vi.fn(),
}));

vi.mock("../suppressions.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../suppressions.js")>()),
	loadFileSuppressions: vi.fn(() => new Set<string>()),
	scanInlineSuppressions: vi.fn(() => []),
}));

vi.mock("./deletion-hygiene-diff.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./deletion-hygiene-diff.js")>()),
	collectDeletionHygieneDiffFindings: vi.fn(() => []),
}));

vi.mock("./edit-line-derivation.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./edit-line-derivation.js")>()),
	deriveEditedLineNumbers: vi.fn(() => undefined),
}));

vi.mock("./suggestion-checks.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./suggestion-checks.js")>()),
	collectSuggestionFindings: vi.fn(() => []),
}));

// Bind to the mocked exports so each test can re-program return values.
import { existsSync, readFileSync } from "node:fs";
import { nonNull } from "../../lib/non-null.js";
import { checkAssertionDensity, runBehavioralChecks } from "../behavioral-checks.js";
import {
	countSuppressionDirectives,
	findProjectRoot,
	formatQualityWarnings,
	runProjectWideChecksAsync,
	runQualityChecks,
} from "../quality-checks.js";
import { acknowledgeChecks, isAcknowledged } from "../session-state.js";
import { expandSiblings } from "../sibling-expansion.js";
import { runStructureChecks } from "../structure/structure-checks.js";
import { formatStructureWarnings } from "../structure/structure-formatter.js";
import { loadStructureConfig } from "../structure/structure-loader.js";
import { formatScoredFindings, scoreFindings, writeTelemetry } from "../suggestion-scorer.js";
import { loadFileSuppressions, scanInlineSuppressions } from "../suppressions.js";
import { collectDeletionHygieneDiffFindings } from "./deletion-hygiene-diff.js";
import { deriveEditedLineNumbers } from "./edit-line-derivation.js";
import {
	runBehavioralPhase,
	runProjectWideSweepPhase,
	runQualityPhase,
	runScoredSuggestionsPhase,
	runShotgunSurgeryPhase,
	runStructureChecksPhase,
} from "./post-tool-file-checks-phases.js";
import { collectSuggestionFindings } from "./suggestion-checks.js";

const mExistsSync = existsSync as unknown as Mock;
const mReadFileSync = readFileSync as unknown as Mock;
const mRunQualityChecks = runQualityChecks as unknown as Mock;
const mRunProjectWide = runProjectWideChecksAsync as unknown as Mock;
const mFormatQuality = formatQualityWarnings as unknown as Mock;
const mCountSuppressions = countSuppressionDirectives as unknown as Mock;
const mFindProjectRoot = findProjectRoot as unknown as Mock;
const mIsAck = isAcknowledged as unknown as Mock;
const mAck = acknowledgeChecks as unknown as Mock;
const mExpandSiblings = expandSiblings as unknown as Mock;
const mRunStructure = runStructureChecks as unknown as Mock;
const mFormatStructure = formatStructureWarnings as unknown as Mock;
const mLoadStructureConfig = loadStructureConfig as unknown as Mock;
const mScoreFindings = scoreFindings as unknown as Mock;
const mFormatScored = formatScoredFindings as unknown as Mock;
const mWriteTelemetry = writeTelemetry as unknown as Mock;
const mLoadFileSup = loadFileSuppressions as unknown as Mock;
const mScanInlineSup = scanInlineSuppressions as unknown as Mock;
const mDeletionHygiene = collectDeletionHygieneDiffFindings as unknown as Mock;
const mDeriveLines = deriveEditedLineNumbers as unknown as Mock;
const mCollectSuggestions = collectSuggestionFindings as unknown as Mock;
const mRunBehavioral = runBehavioralChecks as unknown as Mock;
const mAssertionDensity = checkAssertionDensity as unknown as Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CWD = "/repo";
const FILE = "/repo/src/mod.ts";

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		tool_name: "Edit",
		tool_input: { file_path: FILE },
		...partial,
	};
}

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
		quality_checks: {},
		project_wide_checks: { enabled: false },
		...partial,
	} as unknown as GuardRulesConfig;
}

/** Structural-checks config fixture. `runQualityPhase` only reads `smart_tsc`;
 *  the full StructuralChecksConfig has 28 fields, so this builds a partial at
 *  the fixture boundary (one cast, the same pattern makeRules/makeCtx use). */
function sc(over: Record<string, unknown> = {}): GuardRulesConfig["structural_checks"] {
	return { enabled: true, ...over } as unknown as GuardRulesConfig["structural_checks"];
}

function makeCtx(over: Record<string, unknown> = {}): ServerRuntime {
	return {
		cwd: CWD,
		interlinkedDir: `${CWD}/.interlinked`,
		rules: makeRules(),
		preEditBaselines: new Map(),
		filePriorityMap: new Map(),
		trigramIndex: null,
		structureGraph: null,
		structureConfigCache: null,
		projectWideSweepState: {
			recordFileChecked: vi.fn(),
			recordEdit: vi.fn(() => false),
		},
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

/** The warning/error shape `runQualityChecks` returns (no info severity). */
interface QRes {
	name: string;
	severity: "error" | "warning";
	message: string;
	file?: string;
	detail?: string;
}

/** A real-shaped quality finding the runQualityChecks mock returns. */
function qres(over: Partial<QRes> = {}): QRes {
	return {
		name: "strong_typing",
		severity: "warning",
		message: "loose type",
		file: FILE,
		...over,
	};
}

beforeEach(() => {
	// resetAllMocks so per-test `mockImplementation` overrides don't leak.
	vi.resetAllMocks();
	mExistsSync.mockReturnValue(false);
	mReadFileSync.mockReturnValue("");
	mRunQualityChecks.mockResolvedValue([]);
	mRunProjectWide.mockResolvedValue({ findings: [], toolsRun: [], elapsedMs: 0 });
	mFormatQuality.mockImplementation((rs: { name: string }[]) => rs.map((r) => `[q] ${r.name}`));
	mCountSuppressions.mockReturnValue(0);
	mFindProjectRoot.mockImplementation((_f: string, cwd: string) => cwd);
	mIsAck.mockReturnValue(false);
	mExpandSiblings.mockReturnValue([]);
	mRunStructure.mockReturnValue({
		results: [],
		findings: [],
		graph: { id: "g" },
		pendingCompletions: [],
	});
	mFormatStructure.mockImplementation((fs: { name: string }[]) => fs.map((f) => `[struct] ${f.name}`));
	mLoadStructureConfig.mockReturnValue({ config: { loaded: true } });
	mScoreFindings.mockReturnValue([]);
	mFormatScored.mockImplementation((ss: { check: string }[]) => ss.map((s) => `[sugg] ${s.check}`));
	mLoadFileSup.mockReturnValue(new Set<string>());
	mScanInlineSup.mockReturnValue([]);
	mDeletionHygiene.mockReturnValue([]);
	mDeriveLines.mockReturnValue(undefined);
	mCollectSuggestions.mockReturnValue([]);
	mRunBehavioral.mockReturnValue([]);
	mAssertionDensity.mockReturnValue(null);
	batchResultsForFile.mockResolvedValue([]);
	createChangeSetExternalBatch.mockReturnValue({ resultsForFile: batchResultsForFile });
});

// ===========================================================================
// 1. runQualityPhase
// ===========================================================================

describe("runQualityPhase", () => {
	async function call(over: {
		ctx?: ServerRuntime;
		event?: HarnessEvent;
		file?: string;
		inRepo?: boolean;
		exportChanged?: boolean;
		structuralConfig?: GuardRulesConfig["structural_checks"];
		session?: SessionTrajectory;
		decision?: HarnessDecision;
		acc?: PerFileCheckCtx;
	} = {}): Promise<{
		ret: number;
		decision: HarnessDecision;
		acc: PerFileCheckCtx;
		ctx: ServerRuntime;
	}> {
		const ctx = over.ctx ?? makeCtx({ rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }) });
		const decision = over.decision ?? { decision: "allow" };
		const acc = over.acc ?? makeAcc();
		const ret = await runQualityPhase(
			ctx,
			over.event ?? ev(),
			over.file ?? FILE,
			over.inRepo ?? true,
			over.exportChanged ?? false,
			over.structuralConfig ?? sc(),
			over.session ?? makeSession(),
			decision,
			acc,
		);
		return { ret, decision, acc, ctx };
	}

	it("runs checks and fires the structural_checks + quality_checks phase marks in order", async () => {
		const { acc } = await call();
		expect(mRunQualityChecks).toHaveBeenCalledOnce();
		const markNames = (acc.markPhase as unknown as Mock).mock.calls.map((c) => c[0]);
		expect(markNames).toEqual(["structural_checks", "quality_checks"]);
	});

	it("applies smart-tsc filtering (tscFilterFile) when smart_tsc set + no export change + tsc enabled", async () => {
		const ctx = makeCtx({
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
		});
		await call({ ctx, structuralConfig: sc({ smart_tsc: true }), exportChanged: false });
		// findProjectRoot mock returns cwd, so relative(cwd, file) === "src/mod.ts".
		expect(mRunQualityChecks).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			CWD,
			expect.objectContaining({ tscFilterFile: "src/mod.ts" }),
		);
	});

	it("does NOT apply smart-tsc filtering when the export surface changed", async () => {
		const ctx = makeCtx({
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
		});
		await call({ ctx, structuralConfig: sc({ smart_tsc: true }), exportChanged: true });
		const opts = nonNull(mRunQualityChecks.mock.calls[0])[3];
		expect(opts.tscFilterFile).toBeUndefined();
	});

	it("falls back to CWD when findProjectRoot returns null for the smart-tsc relative path", async () => {
		mFindProjectRoot.mockReturnValue(null);
		const ctx = makeCtx({
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
		});
		await call({ ctx, structuralConfig: sc({ smart_tsc: true }), exportChanged: false });
		// relative(CWD, FILE) === "src/mod.ts" because the root fell back to CWD.
		expect(mRunQualityChecks).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			CWD,
			expect.objectContaining({ tscFilterFile: "src/mod.ts" }),
		);
	});

	it("threads a pre-edit baseline (+ its suppressionCount) and clears it after", async () => {
		const baseline = { suppressionCount: 4, fileHash: "h" };
		const preEditBaselines = new Map([[FILE, baseline]]);
		const ctx = makeCtx({
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
			preEditBaselines,
		});
		const { ret } = await call({ ctx });
		expect(ret).toBe(4); // previousSuppressionCount read from baseline
		expect(mRunQualityChecks).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			CWD,
			expect.objectContaining({ baseline }),
		);
		// Consumed baseline is deleted.
		expect(preEditBaselines.has(FILE)).toBe(false);
	});

	it("shares one ChangeSet batch while preserving each file's own pre-edit baseline", async () => {
		const secondFile = "/repo/src/other.ts";
		const firstBaseline = { suppressionCount: 4, fileHash: "first" };
		const secondBaseline = { suppressionCount: 9, fileHash: "second" };
		const preEditBaselines = new Map([
			[FILE, firstBaseline],
			[secondFile, secondBaseline],
		]);
		const ctx = makeCtx({
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
			preEditBaselines,
		});
		const acc = makeAcc({ editedFilePaths: [FILE, secondFile] });
		const event = ev({
			change_set: {
				source: "filesystem-observation",
				complete: true,
				before_captured_at: "2026-08-31T00:00:00.000Z",
				after_captured_at: "2026-08-31T00:00:01.000Z",
				files: [
					{ path: FILE, kind: "modified", before_sha256: "a", after_sha256: "b" },
					{ path: secondFile, kind: "modified", before_sha256: "c", after_sha256: "d" },
				],
			},
		});

		await call({ ctx, acc, event, file: FILE });
		await call({
			ctx,
			acc,
			event: ev({ ...event, tool_input: { file_path: secondFile } }),
			file: secondFile,
		});

		expect(createChangeSetExternalBatch).toHaveBeenCalledTimes(1);
		expect(batchResultsForFile.mock.calls.map((callArgs) => callArgs[0])).toEqual([
			FILE,
			secondFile,
		]);
		expect(mRunQualityChecks).toHaveBeenCalledTimes(2);
		expect(mRunQualityChecks.mock.calls[0]?.[3]).toEqual(
			expect.objectContaining({ baseline: firstBaseline, skipMultiFileExternalChecks: true }),
		);
		expect(mRunQualityChecks.mock.calls[1]?.[3]).toEqual(
			expect.objectContaining({ baseline: secondBaseline, skipMultiFileExternalChecks: true }),
		);
		expect(preEditBaselines.size).toBe(0);
	});

	it("resolves a relative editedFilePath against CWD for the baseline key", async () => {
		const baseline = { suppressionCount: 9 };
		const preEditBaselines = new Map([[FILE, baseline]]);
		const ctx = makeCtx({
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
			preEditBaselines,
		});
		// pass a CWD-relative path; resolve(CWD, "src/mod.ts") === FILE
		const { ret } = await call({ ctx, file: "src/mod.ts" });
		expect(ret).toBe(9);
	});

	it("passes diffAware through when rules.diff_aware is defined", async () => {
		const diffAware = { enabled: true };
		const ctx = makeCtx({
			rules: makeRules({
				quality_checks: { typescript: { enabled: true, file_types: [".ts"] } },
				diff_aware: diffAware,
			}),
		});
		await call({ ctx });
		expect(mRunQualityChecks).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			CWD,
			expect.objectContaining({ diffAware }),
		);
	});

	it("records only check names the quality runner reports as completed", async () => {
		const ctx = makeCtx({
			rules: makeRules({
				quality_checks: {
					typescript: { enabled: true, file_types: [".ts"] },
					rust: { enabled: true, file_types: [".rs"] },
					biome_disabled: { enabled: false, file_types: [".ts"] },
				},
			}),
		});
		mRunQualityChecks.mockImplementation(async (_event, _checks, _cwd, options) => {
			options.outChecksRan.push("typescript");
			return [];
		});
		const { acc } = await call({ ctx });
		expect(acc.checksRan).toContain("typescript");
		expect(acc.checksRan).not.toContain("rust");
		expect(acc.checksRan).not.toContain("biome_disabled");
	});

	it("does not infer checks_ran from config when a configured check defers", async () => {
		mRunQualityChecks.mockResolvedValue([
			qres({
				name: "external_check_deferred",
				message: `External check deferred for ${FILE} (typescript)`,
				detail: "No check verdict was produced: compiler capacity is busy",
			}),
		]);
		const { acc } = await call();
		expect(acc.checksRan).not.toContain("typescript");
	});

	it("filters out acknowledged warnings but keeps acknowledged errors", async () => {
		mRunQualityChecks.mockResolvedValue([
			qres({ name: "warn_ack", severity: "warning" }),
			qres({ name: "err_ack", severity: "error" }),
		]);
		// Both are "acknowledged" — the warning should drop, the error survive.
		mIsAck.mockReturnValue(true);
		const { acc, decision } = await call();
		const names = acc.allCheckResults.map((r) => r.name);
		expect(names).toEqual(["err_ack"]);
		expect(decision.warnings).toEqual(["[q] err_ack"]);
	});

	it("keeps acknowledged deferrals structured and compacts same-file no-verdict warnings", async () => {
		mRunQualityChecks.mockResolvedValue([
			qres({
				name: "external_check_deferred",
				message: `External check deferred for ${FILE} (typescript)`,
				detail: "No check verdict was produced: compiler capacity is busy",
			}),
			qres({
				name: "external_check_deferred",
				message: `External check deferred for ${FILE} (biome_lint)`,
				detail: "No check verdict was produced: linter capacity is busy",
			}),
			qres({
				name: "affected_tests_deferred",
				message: `Affected tests deferred for ${FILE} (another test check is running)`,
				detail: "No test verdict was produced.",
			}),
		]);
		mIsAck.mockReturnValue(true);

		const { acc, decision } = await call();

		expect(acc.allCheckResults.map((result) => result.name)).toEqual([
			"external_check_deferred",
			"external_check_deferred",
			"affected_tests_deferred",
		]);
		expect(decision.warnings).toHaveLength(1);
		const warning = nonNull(decision.warnings)[0] ?? "";
		expect(warning).toContain("[interlinked:checks-deferred] [proven] NOT CHECKED");
		expect(warning).toContain("typescript");
		expect(warning).toContain("biome_lint");
		expect(warning).toContain("affected tests");
		expect(warning).toContain("another test check is running");
		expect(warning).toContain("Retry each deferred check");
		expect(warning).not.toContain("all clean");
		expect(decision.summary).toBeUndefined();
	});

	it("pushes quality findings into allCheckResults with source=quality and resolved determinism", async () => {
		mRunQualityChecks.mockResolvedValue([qres({ name: "secrets", severity: "error" })]);
		const { acc } = await call();
		expect(acc.allCheckResults).toEqual([
			expect.objectContaining({
				source: "quality",
				name: "secrets",
				severity: "error",
				message: "loose type",
				file: FILE,
				determinism: expect.any(String),
			}),
		]);
	});

	it("falls back to fully_deterministic determinism for an unknown check name", async () => {
		mRunQualityChecks.mockResolvedValue([qres({ name: "totally_unknown_check_xyz" })]);
		const { acc } = await call();
		expect(nonNull(acc.allCheckResults[0]).determinism).toBe("fully_deterministic");
	});

	it("resolves a library-footgun check to heuristic determinism (matches the agent tag)", async () => {
		// Regression: the sink used to default footgun checks to fully_deterministic
		// ("proven") while the agent-facing tag classified them heuristic. They must
		// agree — node_fetch_no_timeout is a regex-shape footgun, so: heuristic.
		mRunQualityChecks.mockResolvedValue([qres({ name: "node_fetch_no_timeout" })]);
		const { acc } = await call();
		expect(nonNull(acc.allCheckResults[0]).determinism).toBe("heuristic");
	});

	it("composes the block reason with blocking findings first and the advisory tail demoted", async () => {
		mRunQualityChecks.mockResolvedValue([
			qres({ name: "strong_typing", severity: "warning" }),
			qres({ name: "typescript", severity: "error" }),
		]);
		const { decision } = await call();
		expect(decision.decision).toBe("block");
		// Lead blocking check's name becomes the rule id — block telemetry
		// aggregates by cause instead of the null-id bucket.
		expect(decision.rule_id).toBe("typescript");
		const reason = nonNull(decision.reason);
		expect(reason).toContain("— Advisory findings");
		// Blocking (typescript) leads; the advisory (strong_typing) sits after the
		// separator — one deterministic error no longer buries it.
		expect(reason.indexOf("[q] typescript")).toBeLessThan(reason.indexOf("— Advisory findings"));
		expect(reason.indexOf("— Advisory findings")).toBeLessThan(reason.indexOf("[q] strong_typing"));
	});

	it("omits the advisory separator from the block reason when every finding blocks", async () => {
		mRunQualityChecks.mockResolvedValue([qres({ name: "typescript", severity: "error" })]);
		const { decision } = await call();
		expect(decision.decision).toBe("block");
		expect(nonNull(decision.reason)).not.toContain("— Advisory findings");
	});

	it("appends formatted warnings onto pre-existing decision.warnings", async () => {
		mRunQualityChecks.mockResolvedValue([qres({ name: "a" }), qres({ name: "b" })]);
		const decision: HarnessDecision = { decision: "allow", warnings: ["pre"] };
		await call({ decision });
		expect(decision.warnings).toEqual(["pre", "[q] a", "[q] b"]);
	});

	it("does NOT block on a heuristic error (non fully_deterministic)", async () => {
		// strong_typing is heuristic in the metadata — error severity but not blocking.
		mRunQualityChecks.mockResolvedValue([qres({ name: "strong_typing", severity: "error" })]);
		const { decision } = await call();
		expect(decision.decision).toBe("allow");
	});

	it("blocks on a fully_deterministic error (typescript)", async () => {
		mRunQualityChecks.mockResolvedValue([qres({ name: "typescript", severity: "error" })]);
		const { decision } = await call();
		expect(decision.decision).toBe("block");
	});

	it("blocks on software_version_regression as a post-tool attention channel even at warning severity", async () => {
		mRunQualityChecks.mockResolvedValue([qres({ name: "software_version_regression", severity: "warning" })]);
		const { decision } = await call();
		expect(decision.decision).toBe("block");
	});

	it("leaves decision=allow when only advisory warnings are present", async () => {
		mRunQualityChecks.mockResolvedValue([qres({ name: "strong_typing", severity: "warning" })]);
		const { decision } = await call();
		expect(decision.decision).toBe("allow");
	});

	it("expands siblings when a trigger finding fires and the trigram index is present", async () => {
		const trigramIndex = { fake: "index" };
		const ctx = makeCtx({
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
			trigramIndex,
		});
		mRunQualityChecks.mockResolvedValue([qres({ name: "as_any_ratchet", severity: "warning" })]);
		mExpandSiblings.mockReturnValue([
			{ triggerName: "as_any_ratchet", siblingRuleId: "as_any_sibling", file: "/repo/src/other.ts", line: 3, message: "sibling cast" },
		]);
		const { acc, decision } = await call({ ctx });
		// expandSiblings called with the trigger derived from the finding.
		expect(mExpandSiblings).toHaveBeenCalledWith(
			expect.objectContaining({
				triggers: [{ name: "as_any_ratchet", file: FILE }],
				index: trigramIndex,
				cwd: CWD,
			}),
		);
		// The sibling row joins the results + warnings.
		const names = acc.allCheckResults.map((r) => r.name);
		expect(names).toContain("as_any_sibling");
		expect(decision.warnings).toEqual(expect.arrayContaining(["[q] as_any_ratchet", "[q] as_any_sibling"]));
	});

	it("uses the finding's own file for the sibling trigger when present", async () => {
		const ctx = makeCtx({
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
			trigramIndex: {},
		});
		mRunQualityChecks.mockResolvedValue([qres({ name: "as_any_ratchet", severity: "warning", file: "/repo/src/specific.ts" })]);
		await call({ ctx });
		expect(mExpandSiblings).toHaveBeenCalledWith(
			expect.objectContaining({ triggers: [{ name: "as_any_ratchet", file: "/repo/src/specific.ts" }] }),
		);
	});

	it("falls back to the edited file for the sibling trigger when the finding has no file", async () => {
		const ctx = makeCtx({
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
			trigramIndex: {},
		});
		// A trigger finding with `file` omitted — the `?? editedFilePath` fallback fires.
		mRunQualityChecks.mockResolvedValue([
			{ name: "as_any_ratchet", severity: "warning", message: "cast" },
		]);
		await call({ ctx });
		expect(mExpandSiblings).toHaveBeenCalledWith(
			expect.objectContaining({ triggers: [{ name: "as_any_ratchet", file: FILE }] }),
		);
	});

	it("sibling reader.read returns file content via readFileSync, undefined on throw", async () => {
		const ctx = makeCtx({
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
			trigramIndex: {},
		});
		mRunQualityChecks.mockResolvedValue([qres({ name: "as_any_ratchet", severity: "warning" })]);
		let captured: { read: (p: string) => string | undefined } | undefined;
		mExpandSiblings.mockImplementation((args: { reader: { read: (p: string) => string | undefined } }) => {
			captured = args.reader;
			return [];
		});
		await call({ ctx });
		mReadFileSync.mockReturnValueOnce("content-ok");
		expect(captured?.read("rel/a.ts")).toBe("content-ok");
		mReadFileSync.mockImplementationOnce(() => {
			throw new Error("nope");
		});
		expect(captured?.read("rel/b.ts")).toBeUndefined();
	});

	it("does not crash and logs when sibling expansion throws", async () => {
		const ctx = makeCtx({
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
			trigramIndex: {},
		});
		mRunQualityChecks.mockResolvedValue([qres({ name: "as_any_ratchet", severity: "warning" })]);
		mExpandSiblings.mockImplementation(() => {
			throw new Error("index corrupt");
		});
		const { acc } = await call({ ctx });
		// the trigger finding still recorded; no sibling rows.
		expect(acc.allCheckResults.map((r) => r.name)).toEqual(["as_any_ratchet"]);
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("Sibling expansion failed: index corrupt"));
	});

	it("stringifies a non-Error sibling-expansion throw via String(e)", async () => {
		const ctx = makeCtx({
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
			trigramIndex: {},
		});
		mRunQualityChecks.mockResolvedValue([qres({ name: "as_any_ratchet", severity: "warning" })]);
		mExpandSiblings.mockImplementation(() => {
			throw "string-failure"; // non-Error throw → String(e) branch
		});
		await call({ ctx });
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("Sibling expansion failed: string-failure"));
	});

	it("skips sibling expansion entirely when there is no trigram index", async () => {
		mRunQualityChecks.mockResolvedValue([qres({ name: "as_any_ratchet", severity: "warning" })]);
		await call(); // default ctx has trigramIndex: null
		expect(mExpandSiblings).not.toHaveBeenCalled();
	});

	it("skips sibling expansion when no finding matches a trigger name", async () => {
		const ctx = makeCtx({
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
			trigramIndex: {},
		});
		mRunQualityChecks.mockResolvedValue([qres({ name: "strong_typing", severity: "warning" })]);
		await call({ ctx });
		expect(mExpandSiblings).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 2. runProjectWideSweepPhase
// ===========================================================================

describe("runProjectWideSweepPhase", () => {
	function ctxWithSweep(over: Record<string, unknown> = {}): ServerRuntime {
		return makeCtx({
			rules: makeRules({ project_wide_checks: { enabled: true } }),
			projectWideSweepState: {
				recordFileChecked: vi.fn(),
				recordEdit: vi.fn(() => false),
			},
			...over,
		});
	}

	it("does nothing (only the phase mark) when project_wide_checks disabled", async () => {
		const ctx = makeCtx();
		const acc = makeAcc();
		const decision: HarnessDecision = { decision: "allow" };
		await runProjectWideSweepPhase(ctx, FILE, true, false, decision, acc);
		expect(mRunProjectWide).not.toHaveBeenCalled();
		expect(acc.markPhase).toHaveBeenCalledWith("project_wide_sweep");
	});

	it("skips the sweep for an out-of-tree file but still marks the phase", async () => {
		const ctx = ctxWithSweep();
		const acc = makeAcc();
		await runProjectWideSweepPhase(ctx, FILE, false, false, { decision: "allow" }, acc);
		expect((ctx.projectWideSweepState.recordFileChecked as unknown as Mock)).not.toHaveBeenCalled();
		expect(mRunProjectWide).not.toHaveBeenCalled();
		expect(acc.markPhase).toHaveBeenCalledWith("project_wide_sweep");
	});

	it("records the checked file and does not sweep when the interval is not reached", async () => {
		const ctx = ctxWithSweep();
		const acc = makeAcc();
		await runProjectWideSweepPhase(ctx, FILE, true, false, { decision: "allow" }, acc);
		expect(ctx.projectWideSweepState.recordFileChecked).toHaveBeenCalledWith(FILE);
		expect(ctx.projectWideSweepState.recordEdit).toHaveBeenCalledOnce();
		expect(mRunProjectWide).not.toHaveBeenCalled();
		expect(acc.projectWideSweepFired).toBe(false);
	});

	it("sweeps when the edit interval is reached and reports clean", async () => {
		const ctx = ctxWithSweep({
			projectWideSweepState: { recordFileChecked: vi.fn(), recordEdit: vi.fn(() => true) },
		});
		mRunProjectWide.mockResolvedValue({ findings: [], toolsRun: ["tsc"], elapsedMs: 12 });
		const acc = makeAcc();
		const decision: HarnessDecision = { decision: "allow" };
		await runProjectWideSweepPhase(ctx, FILE, true, false, decision, acc);
		expect(mRunProjectWide).toHaveBeenCalledOnce();
		expect(acc.projectWideSweepFired).toBe(true);
		expect(decision.warnings).toBeUndefined(); // clean → no warnings
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("clean"));
	});

	it("surfaces a deferred sweep as no verdict and never calls it clean", async () => {
		const ctx = ctxWithSweep({
			projectWideSweepState: { recordFileChecked: vi.fn(), recordEdit: vi.fn(() => true) },
		});
		mRunProjectWide.mockResolvedValue({
			findings: [],
			toolsRun: [],
			deferredReasons: ["tsc: external-tool capacity is busy"],
			elapsedMs: 0,
		});
		const decision: HarnessDecision = { decision: "allow" };
		await runProjectWideSweepPhase(ctx, FILE, true, false, decision, makeAcc());
		expect(decision.warnings).toHaveLength(1);
		expect(decision.warnings?.[0]).toContain("[interlinked:checks-deferred] [proven] NOT CHECKED");
		expect(decision.warnings?.[0]).toContain("external checks for /repo/src/mod.ts");
		expect(decision.warnings?.[0]?.split("\n")).toHaveLength(1);
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("deferred without a verdict"));
		expect(ctx.log).not.toHaveBeenCalledWith(expect.stringContaining("clean"));
	});

	it("does not repeat a project-wide deferral when this file already has one", async () => {
		const ctx = ctxWithSweep({
			projectWideSweepState: { recordFileChecked: vi.fn(), recordEdit: vi.fn(() => true) },
		});
		mRunProjectWide.mockResolvedValue({
			findings: [],
			toolsRun: [],
			deferredReasons: ["tsc: external-tool capacity is busy"],
			elapsedMs: 0,
		});
		const perFileDeferral: CheckResultEntry = {
			source: "quality",
			name: "affected_tests_deferred",
			severity: "warning",
			message: "Affected tests deferred",
			file: FILE,
			determinism: "fully_deterministic",
		};
		const acc = makeAcc({ allCheckResults: [perFileDeferral] });
		const decision: HarnessDecision = {
			decision: "allow",
			warnings: ["PER-FILE NOT CHECKED"],
		};

		await runProjectWideSweepPhase(ctx, FILE, true, false, decision, acc);

		expect(decision.warnings).toEqual(["PER-FILE NOT CHECKED"]);
		expect(mFormatQuality).not.toHaveBeenCalled();
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("deferred without a verdict"));
		expect(ctx.log).not.toHaveBeenCalledWith(expect.stringContaining("clean"));
	});

	it("sweeps on export-surface change (on_export_change) even without interval", async () => {
		const ctx = ctxWithSweep({
			rules: makeRules({ project_wide_checks: { enabled: true, on_export_change: true } }),
			projectWideSweepState: { recordFileChecked: vi.fn(), recordEdit: vi.fn(() => false) },
		});
		mRunProjectWide.mockResolvedValue({ findings: [], toolsRun: ["biome"], elapsedMs: 5 });
		const acc = makeAcc();
		await runProjectWideSweepPhase(ctx, FILE, true, /*exportChanged*/ true, { decision: "allow" }, acc);
		expect(mRunProjectWide).toHaveBeenCalledOnce();
		expect(acc.projectWideSweepFired).toBe(true);
	});

	it("appends formatted sweep warnings when cross-file findings exist", async () => {
		const ctx = ctxWithSweep({
			projectWideSweepState: { recordFileChecked: vi.fn(), recordEdit: vi.fn(() => true) },
		});
		mRunProjectWide.mockResolvedValue({
			findings: [{ name: "typescript", severity: "error", message: "cross-file" }],
			toolsRun: ["tsc"],
			elapsedMs: 30,
		});
		const acc = makeAcc();
		const decision: HarnessDecision = { decision: "allow", warnings: ["pre"] };
		await runProjectWideSweepPhase(ctx, FILE, true, false, decision, acc);
		expect(decision.warnings).toEqual(["pre", "[q] typescript"]);
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("1 cross-file issue"));
	});

	it("initializes decision.warnings from [] when sweep findings exist and none were set", async () => {
		const ctx = ctxWithSweep({
			projectWideSweepState: { recordFileChecked: vi.fn(), recordEdit: vi.fn(() => true) },
		});
		mRunProjectWide.mockResolvedValue({
			findings: [{ name: "biome", severity: "warning", message: "x" }],
			toolsRun: ["biome"],
			elapsedMs: 8,
		});
		const acc = makeAcc();
		const decision: HarnessDecision = { decision: "allow" }; // no warnings yet
		await runProjectWideSweepPhase(ctx, FILE, true, false, decision, acc);
		expect(decision.warnings).toEqual(["[q] biome"]);
	});

	it("does not sweep a second time when projectWideSweepFired is already set", async () => {
		const ctx = ctxWithSweep({
			projectWideSweepState: { recordFileChecked: vi.fn(), recordEdit: vi.fn(() => true) },
		});
		const acc = makeAcc({ projectWideSweepFired: true });
		await runProjectWideSweepPhase(ctx, FILE, true, false, { decision: "allow" }, acc);
		// recordFileChecked still fires (it runs before the once-guard), but no sweep.
		expect(ctx.projectWideSweepState.recordFileChecked).toHaveBeenCalledOnce();
		expect(ctx.projectWideSweepState.recordEdit).not.toHaveBeenCalled();
		expect(mRunProjectWide).not.toHaveBeenCalled();
	});

	it("skips the whole block for an empty edited file path", async () => {
		const ctx = ctxWithSweep();
		const acc = makeAcc();
		await runProjectWideSweepPhase(ctx, "", true, false, { decision: "allow" }, acc);
		expect(ctx.projectWideSweepState.recordFileChecked).not.toHaveBeenCalled();
		expect(acc.markPhase).toHaveBeenCalledWith("project_wide_sweep");
	});
});

// ===========================================================================
// 3. runScoredSuggestionsPhase
// ===========================================================================

describe("runScoredSuggestionsPhase", () => {
	function callSugg(over: {
		ctx?: ServerRuntime;
		event?: HarnessEvent;
		file?: string;
		session?: SessionTrajectory;
		decision?: HarnessDecision;
		acc?: PerFileCheckCtx;
	} = {}): { decision: HarnessDecision; acc: PerFileCheckCtx } {
		const decision = over.decision ?? { decision: "allow" };
		const acc = over.acc ?? makeAcc();
		runScoredSuggestionsPhase(
			over.ctx ?? makeCtx(),
			over.event ?? ev(),
			over.file ?? FILE,
			over.session ?? makeSession(),
			decision,
			acc,
		);
		return { decision, acc };
	}

	it("does nothing when the edited file path is empty", () => {
		const { acc } = callSugg({ file: "" });
		expect(mCollectSuggestions).not.toHaveBeenCalled();
		expect(acc.allCheckResults).toEqual([]);
	});

	it("does nothing when the file does not exist on disk", () => {
		mExistsSync.mockReturnValue(false);
		const { acc } = callSugg();
		expect(mCollectSuggestions).not.toHaveBeenCalled();
		expect(acc.allCheckResults).toEqual([]);
	});

	it("collects suggestion + deletion-hygiene findings and reads the file once", () => {
		mExistsSync.mockReturnValue(true);
		mReadFileSync.mockReturnValue("line1\nline2\n");
		callSugg();
		expect(mReadFileSync).toHaveBeenCalledWith(FILE, "utf-8");
		expect(mCollectSuggestions).toHaveBeenCalledWith("line1\nline2\n", FILE);
		expect(mDeletionHygiene).toHaveBeenCalledOnce();
	});

	it("returns early without scoring when there are zero findings", () => {
		mExistsSync.mockReturnValue(true);
		mCollectSuggestions.mockReturnValue([]);
		mDeletionHygiene.mockReturnValue([]);
		callSugg();
		expect(mScoreFindings).not.toHaveBeenCalled();
		expect(mWriteTelemetry).not.toHaveBeenCalled();
	});

	it("scores findings, pushes scored rows and warnings, writes telemetry", () => {
		mExistsSync.mockReturnValue(true);
		mReadFileSync.mockReturnValue("const x = 1\n");
		mCollectSuggestions.mockReturnValue([{ check: "magic-number", severity: "warning", line: 1, message: "magic" }]);
		mScoreFindings.mockReturnValue([{ check: "magic-number", severity: "warning", line: 1, message: "magic", score: 0.81 }]);
		const { acc, decision } = callSugg();
		expect(acc.allCheckResults).toEqual([
			expect.objectContaining({
				source: "suggestion",
				name: "magic-number",
				severity: "warning",
				message: "magic",
				file: FILE,
				score: 0.81,
				line: 1,
				determinism: "heuristic",
			}),
		]);
		expect(decision.warnings).toEqual(["[sugg] magic-number"]);
		expect(mWriteTelemetry).toHaveBeenCalledOnce();
	});

	it("computes the edit region (start/end line) from old_string position", () => {
		mExistsSync.mockReturnValue(true);
		mReadFileSync.mockReturnValue("aaa\nbbb\nccc\nddd\n");
		mCollectSuggestions.mockReturnValue([{ check: "c", severity: "warning", line: 1, message: "m" }]);
		const event = ev({ tool_input: { file_path: FILE, old_string: "bbb\nccc" } });
		callSugg({ event });
		// idx of "bbb\nccc" is after "aaa\n" → line 2; old spans 2 lines → end line 4.
		expect(mScoreFindings).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ editStartLine: 2, editEndLine: 4 }),
		);
	});

	it("omits editStartLine/editEndLine when old_string is not found in content", () => {
		mExistsSync.mockReturnValue(true);
		mReadFileSync.mockReturnValue("aaa\nbbb\n");
		mCollectSuggestions.mockReturnValue([{ check: "c", severity: "warning", line: 1, message: "m" }]);
		const event = ev({ tool_input: { file_path: FILE, old_string: "ZZZ-not-present" } });
		callSugg({ event });
		const opts = nonNull(mScoreFindings.mock.calls[0])[1];
		expect(opts.editStartLine).toBeUndefined();
		expect(opts.editEndLine).toBeUndefined();
	});

	it("filters out acknowledged scored suggestions before surfacing", () => {
		mExistsSync.mockReturnValue(true);
		mReadFileSync.mockReturnValue("x\n");
		mCollectSuggestions.mockReturnValue([{ check: "ack-me", severity: "warning", line: 1, message: "m" }]);
		mScoreFindings.mockReturnValue([{ check: "ack-me", severity: "warning", line: 1, message: "m", score: 0.9 }]);
		mIsAck.mockReturnValue(true); // acknowledged → dropped from `scored`
		const { acc, decision } = callSugg();
		expect(acc.allCheckResults).toEqual([]);
		expect(decision.warnings).toBeUndefined();
		// Telemetry still fires (it gets the unfiltered findings + the post-ack scored=[]).
		expect(mWriteTelemetry).toHaveBeenCalledOnce();
	});

	it("passes suggestion_limit/threshold from rules into scoreFindings", () => {
		const ctx = makeCtx({ rules: makeRules({ suggestion_limit: 7, suggestion_threshold: 0.25 }) });
		mExistsSync.mockReturnValue(true);
		mCollectSuggestions.mockReturnValue([{ check: "c", severity: "warning", line: 1, message: "m" }]);
		callSugg({ ctx });
		expect(mScoreFindings).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ limit: 7, threshold: 0.25 }),
		);
	});

	it("swallows errors thrown inside the suggestion block", () => {
		mExistsSync.mockReturnValue(true);
		mReadFileSync.mockImplementation(() => {
			throw new Error("disk gone");
		});
		// Must not throw.
		expect(() => callSugg()).not.toThrow();
	});

	it("uses 'unknown' as the telemetry agentName when the session has no agent_name", () => {
		mExistsSync.mockReturnValue(true);
		mCollectSuggestions.mockReturnValue([{ check: "c", severity: "warning", line: 1, message: "m" }]);
		const session = makeSession({ agent_name: "" }); // falsy → "unknown" fallback
		callSugg({ session });
		expect(mWriteTelemetry).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ agentName: "unknown" }),
		);
	});
});

// ===========================================================================
// 4. runShotgunSurgeryPhase
// ===========================================================================

describe("runShotgunSurgeryPhase", () => {
	function filesWritten(n: number): Set<string> {
		const s = new Set<string>();
		for (let i = 0; i < n; i++) s.add(`/repo/f${i}.ts`);
		return s;
	}

	it("does not fire below the 40-file threshold", () => {
		const session = makeSession({ files_written: filesWritten(39) });
		const acc = makeAcc();
		const decision: HarnessDecision = { decision: "allow" };
		runShotgunSurgeryPhase(session, decision, acc);
		expect(acc.checksRan).not.toContain("shotgun-surgery");
		expect(decision.warnings).toBeUndefined();
	});

	it("fires the 40-key warning at exactly 40 files", () => {
		const session = makeSession({ files_written: filesWritten(40) });
		const acc = makeAcc();
		const decision: HarnessDecision = { decision: "allow" };
		runShotgunSurgeryPhase(session, decision, acc);
		expect(acc.checksRan).toContain("shotgun-surgery");
		expect(acc.allCheckResults).toEqual([
			expect.objectContaining({ source: "suggestion", name: "shotgun-surgery", severity: "warning", determinism: "heuristic" }),
		]);
		expect(decision.warnings?.[0]).toContain("40 files edited");
		// acknowledged under the 40-key.
		expect(mAck).toHaveBeenCalledWith(session, "__session__", ["shotgun-surgery-40"]);
	});

	it("uses the 60-key once the high threshold is crossed", () => {
		const session = makeSession({ files_written: filesWritten(61) });
		const acc = makeAcc();
		runShotgunSurgeryPhase(session, { decision: "allow" }, acc);
		expect(mAck).toHaveBeenCalledWith(session, "__session__", ["shotgun-surgery-60"]);
	});

	it("does not re-fire when the threshold key is already acknowledged", () => {
		mIsAck.mockReturnValue(true);
		const session = makeSession({ files_written: filesWritten(45) });
		const acc = makeAcc();
		const decision: HarnessDecision = { decision: "allow" };
		runShotgunSurgeryPhase(session, decision, acc);
		expect(acc.checksRan).not.toContain("shotgun-surgery");
		expect(decision.warnings).toBeUndefined();
		expect(mAck).not.toHaveBeenCalled();
	});

	it("appends onto an existing decision.warnings array", () => {
		const session = makeSession({ files_written: filesWritten(42) });
		const acc = makeAcc();
		const decision: HarnessDecision = { decision: "allow", warnings: ["earlier"] };
		runShotgunSurgeryPhase(session, decision, acc);
		expect(decision.warnings?.[0]).toBe("earlier");
		expect(decision.warnings).toHaveLength(2);
	});
});

// ===========================================================================
// 5. runStructureChecksPhase
// ===========================================================================

describe("runStructureChecksPhase", () => {
	function callStruct(over: {
		ctx?: ServerRuntime;
		file?: string;
		inRepo?: boolean;
		session?: SessionTrajectory;
		decision?: HarnessDecision;
		acc?: PerFileCheckCtx;
	} = {}): { decision: HarnessDecision; acc: PerFileCheckCtx; ctx: ServerRuntime } {
		const ctx = over.ctx ?? makeCtx();
		const decision = over.decision ?? { decision: "allow" };
		const acc = over.acc ?? makeAcc();
		runStructureChecksPhase(
			ctx,
			over.file ?? FILE,
			over.inRepo ?? true,
			over.session ?? makeSession(),
			decision,
			acc,
		);
		return { decision, acc, ctx };
	}

	it("always fires the scored_suggestions phase mark", () => {
		const { acc } = callStruct();
		expect(acc.markPhase).toHaveBeenCalledWith("scored_suggestions");
	});

	it("skips the structure build for an out-of-tree file", () => {
		const { acc } = callStruct({ inRepo: false });
		expect(mRunStructure).not.toHaveBeenCalled();
		expect(acc.markPhase).toHaveBeenCalledWith("scored_suggestions");
	});

	it("skips the cold build when the time budget is blown and no cached graph", () => {
		// postStartMs far in the past → structElapsed >> 12s budget; structureGraph null.
		const ctx = makeCtx({ structureGraph: null });
		const acc = makeAcc({ postStartMs: Date.now() - 60_000 });
		callStruct({ ctx, acc });
		expect(mRunStructure).not.toHaveBeenCalled();
	});

	it("STILL runs when over budget but a cached graph exists", () => {
		const ctx = makeCtx({ structureGraph: { cached: true } });
		const acc = makeAcc({ postStartMs: Date.now() - 60_000 });
		callStruct({ ctx, acc });
		expect(mRunStructure).toHaveBeenCalledOnce();
	});

	it("runs structure checks, updates the graph cache, and loads the config when absent", () => {
		const ctx = makeCtx({ structureGraph: null, structureConfigCache: null });
		mRunStructure.mockReturnValue({ results: [], findings: [], graph: { id: "built" }, pendingCompletions: [] });
		callStruct({ ctx });
		expect(ctx.structureGraph).toEqual({ id: "built" });
		expect(mLoadStructureConfig).toHaveBeenCalledOnce();
		expect(ctx.structureConfigCache).toEqual({ loaded: true });
	});

	it("does not reload the structure config when already cached", () => {
		const ctx = makeCtx({ structureGraph: { x: 1 }, structureConfigCache: { existing: true } });
		callStruct({ ctx });
		expect(mLoadStructureConfig).not.toHaveBeenCalled();
		expect(ctx.structureConfigCache).toEqual({ existing: true });
	});

	it("pushes structure results into allCheckResults", () => {
		const r: CheckResultEntry = { source: "structure", name: "public_symbol_companions", severity: "warning", message: "needs companion", determinism: "heuristic" };
		mRunStructure.mockReturnValue({ results: [r], findings: [], graph: { id: "g" }, pendingCompletions: [] });
		const { acc } = callStruct();
		expect(acc.allCheckResults).toEqual([r]);
	});

	it("records the structure check + appends formatted warnings when findings exist", () => {
		mRunStructure.mockReturnValue({
			results: [],
			findings: [{ name: "env_key_companions" }],
			graph: { id: "g" },
			pendingCompletions: [],
		});
		const { acc, decision } = callStruct();
		expect(acc.checksRan).toContain("structure");
		expect(decision.warnings).toEqual(["[struct] env_key_companions"]);
	});

	it("records structure pending completions into session state", () => {
		const session = makeSession();
		mRunStructure.mockReturnValue({
			results: [],
			findings: [],
			graph: { id: "g" },
			pendingCompletions: [
				{
					source_artifact_ref: "module:foo",
					source_file: "/repo/src/foo.ts",
					finding_class: "public_symbol_companions",
					required_companion_files: ["/repo/docs/foo.md"],
					resolved_companion_files: new Set(["/repo/docs/done.md"]),
				},
			],
		});
		callStruct({ session });
		const pc = session.pending_completions.get("struct:module:foo");
		expect(pc).toBeDefined();
		expect(pc?.source_file).toBe("/repo/src/foo.ts");
		expect(pc?.affected_files).toEqual(["/repo/docs/foo.md"]);
		expect(pc?.resolved_files).toEqual(new Set(["/repo/docs/done.md"]));
		expect(pc?.recorded_at_tool_call).toBe(session.tool_call_count);
		expect(pc?.description).toContain("public_symbol_companions");
	});

	it("falls back to CWD as the repo root when findProjectRoot returns null", () => {
		mFindProjectRoot.mockReturnValue(null);
		const ctx = makeCtx();
		callStruct({ ctx });
		// runStructureChecks gets CWD as the resolved repo root (2nd positional arg).
		expect(mRunStructure).toHaveBeenCalledWith(FILE, CWD, null, null, expect.anything());
	});

	it("appends structure warnings onto a pre-existing decision.warnings array", () => {
		mRunStructure.mockReturnValue({
			results: [],
			findings: [{ name: "glossary_residue" }],
			graph: { id: "g" },
			pendingCompletions: [],
		});
		const decision: HarnessDecision = { decision: "allow", warnings: ["earlier"] };
		callStruct({ decision });
		expect(decision.warnings).toEqual(["earlier", "[struct] glossary_residue"]);
	});


	it("logs and does not throw when runStructureChecks throws", () => {
		const ctx = makeCtx();
		mRunStructure.mockImplementation(() => {
			throw new Error("graph blew up");
		});
		expect(() => callStruct({ ctx })).not.toThrow();
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("Structure check error: graph blew up"));
		// the phase mark still fires after the catch.
		expect((ctx.log as unknown as Mock)).toHaveBeenCalled();
	});

	it("stringifies a non-Error structure throw via String(structErr)", () => {
		const ctx = makeCtx();
		mRunStructure.mockImplementation(() => {
			throw "struct-string-fail"; // non-Error throw → String(structErr) branch
		});
		callStruct({ ctx });
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("Structure check error: struct-string-fail"));
	});

	it("skips the build for an empty file path but still marks the phase", () => {
		const { acc } = callStruct({ file: "" });
		expect(mRunStructure).not.toHaveBeenCalled();
		expect(acc.markPhase).toHaveBeenCalledWith("scored_suggestions");
	});
});

// ===========================================================================
// 6. runBehavioralPhase
// ===========================================================================

describe("runBehavioralPhase", () => {
	function callBehav(over: {
		event?: HarnessEvent;
		file?: string;
		prevSuppress?: number;
		session?: SessionTrajectory | null;
		decision?: HarnessDecision;
		acc?: PerFileCheckCtx;
	} = {}): { decision: HarnessDecision; acc: PerFileCheckCtx } {
		const decision = over.decision ?? { decision: "allow" };
		const acc = over.acc ?? makeAcc();
		runBehavioralPhase(
			over.event ?? ev(),
			over.file ?? FILE,
			over.prevSuppress ?? 0,
			(over.session === undefined ? makeSession() : over.session) as SessionTrajectory,
			decision,
			acc,
		);
		return { decision, acc };
	}

	it("does nothing when the edited file path is empty", () => {
		callBehav({ file: "" });
		expect(mRunBehavioral).not.toHaveBeenCalled();
	});

	it("reads file content + suppression count when the file exists, threading them through", () => {
		mExistsSync.mockReturnValue(true);
		mReadFileSync.mockReturnValue("file body\n");
		mCountSuppressions.mockReturnValue(3);
		callBehav({ prevSuppress: 1 });
		expect(mCountSuppressions).toHaveBeenCalledWith("file body\n");
		// runBehavioralChecks gets previousSuppressionCount (1) and currentSuppressionCount (3).
		expect(mRunBehavioral).toHaveBeenCalledWith(
			expect.anything(),
			FILE,
			expect.any(Array),
			1,
			3,
			undefined,
		);
	});

	it("uses currentSuppressionCount=0 when the file does not exist", () => {
		mExistsSync.mockReturnValue(false);
		callBehav({ prevSuppress: 2 });
		expect(mCountSuppressions).not.toHaveBeenCalled();
		expect(mRunBehavioral).toHaveBeenCalledWith(
			expect.anything(),
			FILE,
			expect.any(Array),
			2,
			0,
			undefined,
		);
	});

	it("swallows a readFileSync error and proceeds with 0 suppressions", () => {
		mExistsSync.mockReturnValue(true);
		mReadFileSync.mockImplementation(() => {
			throw new Error("io");
		});
		expect(() => callBehav()).not.toThrow();
		expect(mRunBehavioral).toHaveBeenCalledWith(expect.anything(), FILE, expect.any(Array), 0, 0, undefined);
	});

	it("derives edited line numbers and threads them into runBehavioralChecks", () => {
		mExistsSync.mockReturnValue(true);
		mReadFileSync.mockReturnValue("x\n");
		const lines = new Set([10, 11, 12]);
		mDeriveLines.mockReturnValue(lines);
		callBehav();
		expect(mDeriveLines).toHaveBeenCalledWith("Edit", expect.any(Object), "x\n");
		expect(mRunBehavioral).toHaveBeenCalledWith(expect.anything(), FILE, expect.any(Array), 0, 0, lines);
	});

	it("appends the assertion-density result when the file content is available", () => {
		mExistsSync.mockReturnValue(true);
		mReadFileSync.mockReturnValue("test body\n");
		mAssertionDensity.mockReturnValue({ source: "suggestion", name: "assertion-density", severity: "warning", message: "thin tests", determinism: "heuristic" });
		const { acc, decision } = callBehav();
		expect(mAssertionDensity).toHaveBeenCalledWith(expect.anything(), FILE, "test body\n");
		expect(acc.allCheckResults.map((r) => r.name)).toContain("assertion-density");
		expect(decision.warnings?.some((w) => w.includes("assertion-density"))).toBe(true);
	});

	it("does NOT call assertion-density when the file content is undefined (file missing)", () => {
		mExistsSync.mockReturnValue(false);
		callBehav();
		expect(mAssertionDensity).not.toHaveBeenCalled();
	});

	it("surfaces a warning with a [heuristic] tag for non-deterministic findings", () => {
		mRunBehavioral.mockReturnValue([
			{ source: "suggestion", name: "repeated-edit", severity: "warning", message: "edit churn", determinism: "heuristic" },
		]);
		const { acc, decision } = callBehav();
		expect(acc.allCheckResults).toHaveLength(1);
		expect(decision.warnings).toEqual(["[heuristic] repeated-edit: edit churn"]);
	});

	it("tags fully_deterministic findings as [proven]", () => {
		mRunBehavioral.mockReturnValue([
			{ source: "quality", name: "tsc-derived", severity: "error", message: "broke", determinism: "fully_deterministic" },
		]);
		const { decision } = callBehav();
		expect(decision.warnings).toEqual(["[proven] tsc-derived: broke"]);
	});

	it("records info-level findings without surfacing them as warnings", () => {
		mRunBehavioral.mockReturnValue([
			{ source: "suggestion", name: "tdd-green", severity: "info", message: "green", determinism: "heuristic" },
		]);
		const { acc, decision } = callBehav();
		expect(acc.allCheckResults.map((r) => r.name)).toEqual(["tdd-green"]);
		// `decision.warnings` is initialized to [] once any behavioral result
		// exists, but the info-level row contributes no surfaced string.
		expect(decision.warnings).toEqual([]);
	});

	it("suppresses an acknowledged warning but always surfaces errors", () => {
		mRunBehavioral.mockReturnValue([
			{ source: "suggestion", name: "ack-warn", severity: "warning", message: "w", determinism: "heuristic" },
			{ source: "quality", name: "always-err", severity: "error", message: "e", determinism: "fully_deterministic" },
		]);
		mIsAck.mockReturnValue(true);
		const { acc, decision } = callBehav();
		// ack-warn dropped from both surfaced warnings AND allCheckResults; error survives.
		expect(acc.allCheckResults.map((r) => r.name)).toEqual(["always-err"]);
		expect(decision.warnings).toEqual(["[proven] always-err: e"]);
	});

	it("appends behavioral warnings onto a pre-existing decision.warnings array", () => {
		mRunBehavioral.mockReturnValue([
			{ source: "suggestion", name: "n", severity: "warning", message: "m", determinism: "heuristic" },
		]);
		const decision: HarnessDecision = { decision: "allow", warnings: ["earlier"] };
		callBehav({ decision });
		expect(decision.warnings).toEqual(["earlier", "[heuristic] n: m"]);
	});
});
