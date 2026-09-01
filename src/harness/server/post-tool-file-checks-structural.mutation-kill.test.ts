// Mutation-kill companion tests for post-tool-file-checks-structural.ts.
//
// Every sibling module this file imports is mocked at the boundary (matching
// the pattern in post-tool-file-checks.test.ts) so each of the six exported
// functions is exercised directly, with exact-value assertions on every
// observable output: decision.decision/rule_id/reason/warnings,
// allCheckResults entries, session.failed_files/pending_completions, the log
// callback, and (for the two error-memory functions) the exact opts object
// forwarded to ErrorHistory.buildErrorContext/buildQueryContext — inspected
// via a spy rather than the real string builder, so key-presence mutations
// (ObjectLiteral drop, forced-true Conditional) are caught even when they'd
// produce a value-equal string.
//
// `toStrictEqual` (not `toEqual`) is used for the opts-shape and
// pending-completion assertions specifically because several survivors force
// a conditional spread to fire unconditionally: `{oldString: undefined}` and
// `{}` are `toEqual`-equal (undefined-valued keys are ignored) but
// `toStrictEqual`-different, and that's exactly the distinguishing signal for
// those mutants.
//
// See scratch/fleet-r3/receipts/src_harness_server_post-tool-file-checks-structural.ts.jsonl
// for the mutant-by-mutant kill ledger and
// scratch/fleet-r3/src_harness_server_post-tool-file-checks-structural.ts-shadow-verify.mts
// for empirical verification against the manifest's exact originalLexeme/replacement text.

import { join } from "node:path";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ProjectGraph } from "../project-graph.js";
import type {
	CheckResultEntry,
	ExportedSymbol,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
	StructuralCheckResult,
	StructuralChecksConfig,
} from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

// ---------------------------------------------------------------------------
// Module mocks (vitest hoists these above the real-module imports below).
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
}));

vi.mock("../check-metadata.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../check-metadata.js")>()),
	STRUCTURAL_CHECK_META: {
		"det-check-a": { name: "A", description: "d", tier: 1, determinism: "fully_deterministic" },
		"det-check-c": { name: "C", description: "d", tier: 1, determinism: "fully_deterministic" },
		"heur-check-b": { name: "B", description: "d", tier: 1, determinism: "heuristic" },
	},
}));

vi.mock("../structural-checks.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../structural-checks.js")>()),
	runStructuralChecks: vi.fn(() => []),
	formatStructuralWarnings: vi.fn(() => []),
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

vi.mock("../suppressions.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../suppressions.js")>()),
	loadFileSuppressions: vi.fn(() => new Set<string>()),
}));

vi.mock("../session-state.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../session-state.js")>()),
	isAcknowledged: vi.fn(() => false),
}));

// Bind to the mocked exports so each test can re-program return values.
import { existsSync, readFileSync } from "node:fs";
import { checkOrphanedTests } from "../deletion-hygiene.js";
import { resolveDependencyView } from "../dependency-view.js";
import { ErrorHistory } from "../error-history.js";
import {
	formatImpactWarning,
	recordImpactFollowUps,
	runImpactAnalysis,
} from "../impact-analysis.js";
import { isAcknowledged } from "../session-state.js";
import { formatStructuralWarnings, runStructuralChecks } from "../structural-checks.js";
import { loadFileSuppressions } from "../suppressions.js";
import {
	applyStructuralFindings,
	collectStructuralResults,
	recordStructuralErrorMemory,
	recordStructuralFixMemory,
	runDeletionHygiene,
	runImpactOrFallback,
} from "./post-tool-file-checks-structural.js";

// SAFETY: each binding below is the SAME function object vi.mock() above
// replaced with a vi.fn() factory — the runtime value already IS a Mock, this
// only recovers that at the type level (the vi.mock factory's return type is
// erased to the real module's signature by the `importOriginal` spread).
const mExistsSync = existsSync as unknown as Mock;
const mReadFileSync = readFileSync as unknown as Mock;
const mRunStructural = runStructuralChecks as unknown as Mock;
const mFormatStructural = formatStructuralWarnings as unknown as Mock;
const mRunImpact = runImpactAnalysis as unknown as Mock;
const mFormatImpact = formatImpactWarning as unknown as Mock;
const mRecordImpactFollowUps = recordImpactFollowUps as unknown as Mock;
const mResolveDepView = resolveDependencyView as unknown as Mock;
const mCheckOrphaned = checkOrphanedTests as unknown as Mock;
const mLoadFileSup = loadFileSuppressions as unknown as Mock;
const mIsAck = isAcknowledged as unknown as Mock;

// Spy on the real (unmocked) static context builders so the exact opts object
// each function assembles can be inspected — see file header for why
// toStrictEqual on this object is the load-bearing assertion for several
// survivors (ObjectLiteral drop / forced-true Conditional on the
// old_string/new_string/content spreads).
const buildErrorContextSpy = vi.spyOn(ErrorHistory, "buildErrorContext");
const buildQueryContextSpy = vi.spyOn(ErrorHistory, "buildQueryContext");

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
		timestamp: "2026-08-12T00:00:00.000Z",
		tool_name: "Edit",
		tool_input: {},
		...partial,
	};
}

function makeSession(partial: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		agent_name: "agent-x",
		tool_call_count: 3,
		files_written: new Set<string>(),
		failed_files: new Map(),
		pending_completions: new Map(),
		tool_sequence: ["Read", "Edit"],
		...partial,
		// SAFETY: fixture covers only the SessionTrajectory fields the six
		// functions under test read/write; the real interface has many more.
	} as SessionTrajectory;
}

function makeDecision(partial: Partial<HarnessDecision> = {}): HarnessDecision {
	return { decision: "allow", ...partial };
}

function makeGraph(over: Record<string, unknown> = {}): ProjectGraph {
	return {
		isInitialized: true,
		getExports: vi.fn((): ExportedSymbol[] => []),
		getInterfaceBodies: vi.fn(() => new Map<string, string>()),
		updateFile: vi.fn(),
		toRelative: vi.fn((f: string) => f.replace(`${CWD}/`, "")),
		classifyModule: vi.fn(() => "leaf"),
		getDependents: vi.fn((): string[] => []),
		getDependencies: vi.fn((): unknown[] => []),
		...over,
		// SAFETY: fixture covers only the methods the six functions under test
		// actually call (verified against their source above); the full
		// ProjectGraph interface has many unrelated members this suite never
		// exercises.
	} as unknown as ProjectGraph;
}

function makeCtx(over: Record<string, unknown> = {}): ServerRuntime {
	return {
		cwd: CWD,
		interlinkedDir: join(CWD, ".interlinked"),
		sessions: {},
		errorHistory: {
			recordError: vi.fn(async () => {}),
			recordFix: vi.fn(),
		},
		log: vi.fn(),
		...over,
		// SAFETY: fixture covers only the ServerRuntime fields the six
		// functions under test read (cwd, sessions, errorHistory, log); the
		// interface has ~30 fields this suite never touches.
	} as unknown as ServerRuntime;
}

/** A structural finding fixture; `check` names default to keys present (or
 *  deliberately absent) from the mocked STRUCTURAL_CHECK_META above. */
function sc(
	check: string,
	severity: "error" | "warning" | "info",
	extra: Partial<StructuralCheckResult> = {},
): StructuralCheckResult {
	return { check, severity, message: `msg:${check}`, file: FILE, ...extra };
}

function exp(name: string): ExportedSymbol {
	return { name, kind: "function", isTypeOnly: false, line: 1 };
}

function makeStructuralConfig(over: Partial<StructuralChecksConfig> = {}): StructuralChecksConfig {
	// SAFETY: only `enabled` (+ whatever the caller overrides, e.g.
	// impact_analysis) is read by the functions under test; the real
	// StructuralChecksConfig has many more boolean flags this suite ignores.
	return { enabled: true, ...over } as StructuralChecksConfig;
}

beforeEach(() => {
	// resetAllMocks (not clearAllMocks) so per-test mockImplementation
	// overrides don't leak into later tests — matches
	// post-tool-file-checks.test.ts's own documented reasoning.
	vi.resetAllMocks();
	mExistsSync.mockReturnValue(false);
	mReadFileSync.mockReturnValue("");
	mRunStructural.mockReturnValue([]);
	mFormatStructural.mockReturnValue([]);
	mLoadFileSup.mockReturnValue(new Set<string>());
	mIsAck.mockReturnValue(false);
	mCheckOrphaned.mockReturnValue([]);
	mFormatImpact.mockReturnValue([]);
	mResolveDepView.mockReturnValue({});
	buildErrorContextSpy.mockReturnValue("CTX");
	buildQueryContextSpy.mockReturnValue("QCTX");
});

// ===========================================================================
// collectStructuralResults — 2 survivors
// ===========================================================================

describe("collectStructuralResults", () => {
	it('P1: pushes exactly "structural" onto checksRan', () => {
		const checksRan: string[] = [];
		collectStructuralResults(
			makeCtx(),
			ev(),
			makeSession(),
			FILE,
			makeGraph(),
			makeStructuralConfig(),
			[],
			new Map(),
			checksRan,
		);
		expect(checksRan).toEqual(["structural"]);
	});

	it("P2: loads suppressions from <cwd>/.interlinked (not an empty/blank directory)", () => {
		mRunStructural.mockReturnValue([sc("det-check-a", "warning")]);
		// Only returns a real suppression set for the EXACT expected directory;
		// any other argument (e.g. join(CWD, "") from a StringLiteral mutant)
		// falls back to an empty set, so the assertion below is on the
		// resulting FILTERED OUTPUT, not merely on the call having happened.
		mLoadFileSup.mockImplementation((dir: string) =>
			dir === join(CWD, ".interlinked") ? new Set(["det-check-a"]) : new Set(),
		);
		const out = collectStructuralResults(
			makeCtx({ cwd: CWD }),
			ev(),
			makeSession(),
			FILE,
			makeGraph(),
			makeStructuralConfig(),
			[],
			new Map(),
			[],
		);
		expect(out).toEqual([]);
	});

	it("N1: a result whose check is suppressed via loadFileSuppressions is excluded from the output", () => {
		mRunStructural.mockReturnValue([sc("det-check-a", "warning")]);
		mLoadFileSup.mockReturnValue(new Set(["det-check-a"]));
		const out = collectStructuralResults(
			makeCtx(),
			ev(),
			makeSession(),
			FILE,
			makeGraph(),
			makeStructuralConfig(),
			[],
			new Map(),
			[],
		);
		expect(out).toEqual([]);
	});

	it("N2: an error-severity result survives isAcknowledged=true; a warning-severity one does not", () => {
		mRunStructural.mockReturnValue([sc("det-check-a", "error"), sc("heur-check-b", "warning")]);
		mIsAck.mockReturnValue(true);
		const out = collectStructuralResults(
			makeCtx(),
			ev(),
			makeSession(),
			FILE,
			makeGraph(),
			makeStructuralConfig(),
			[],
			new Map(),
			[],
		);
		expect(out.map((r) => r.check)).toEqual(["det-check-a"]);
	});
});

// ===========================================================================
// applyStructuralFindings (+ nested .some()/.find()/.filter() arrows) — 38
// survivors. See file header for why exact-value assertions are load-bearing
// here: `??=` vs `&&=`, `??` vs `&&`, and the `.some()`/`.every()` swap only
// diverge from the un-mutated code on specific severity/determinism mixes,
// so a single loosely-asserted happy-path test would not distinguish them.
// ===========================================================================

describe("applyStructuralFindings", () => {
	it("P1: known-deterministic check's determinism is looked up from metadata verbatim", () => {
		const allCheckResults: CheckResultEntry[] = [];
		applyStructuralFindings(
			[sc("det-check-a", "info")],
			FILE,
			ev(),
			makeSession(),
			makeDecision(),
			allCheckResults,
			vi.fn(),
		);
		expect(allCheckResults[0]?.determinism).toBe("fully_deterministic");
	});

	it('P2: a check absent from metadata falls back to exactly "heuristic" (not "" and not undefined)', () => {
		const allCheckResults: CheckResultEntry[] = [];
		applyStructuralFindings(
			[sc("totally-unknown-check", "info")],
			FILE,
			ev(),
			makeSession(),
			makeDecision(),
			allCheckResults,
			vi.fn(),
		);
		expect(allCheckResults[0]?.determinism).toBe("heuristic");
	});

	it("P3: block path — leadCheck is the first entry that is BOTH actionable-severity AND fully-deterministic, rule_id/reason/warnings are populated from empty state, failed_files dedupes by check name across every severity-actionable entry, and the log line joins every check name with ', '", () => {
		mFormatStructural.mockReturnValue(["W1", "W2"]);
		const decision = makeDecision();
		const session = makeSession();
		const log = vi.fn();
		const structuralResults = [
			sc("det-check-a", "info"), // deterministic, but wrong severity
			sc("heur-check-b", "error"), // right severity, wrong determinism
			sc("det-check-b-dup", "error", { check: "heur-check-b" }), // duplicate check name — dedup check
			sc("det-check-c", "warning"), // right severity AND deterministic — must be leadCheck
		];
		applyStructuralFindings(
			structuralResults,
			FILE,
			ev({ timestamp: "T1" }),
			session,
			decision,
			[],
			log,
		);

		expect(decision.decision).toBe("block");
		expect(decision.rule_id).toBe("det-check-c");
		expect(decision.reason).toBe("W1\nW2");
		expect(decision.warnings).toEqual(["W1", "W2"]);
		expect(log).toHaveBeenCalledWith(
			"Structural issues: det-check-a, heur-check-b, heur-check-b, det-check-c",
		);
		expect(session.failed_files.get(FILE)).toEqual({
			failure_count: 3,
			checks: ["heur-check-b", "det-check-c"],
			recorded_at: "T1",
			tool_call_count: session.tool_call_count,
		});
	});

	it("N1: severity is present but never error/warning -> allow, rule_id/reason untouched, nothing recorded as failed", () => {
		const decision = makeDecision();
		const session = makeSession();
		applyStructuralFindings(
			[sc("det-check-a", "info")],
			FILE,
			ev(),
			session,
			decision,
			[],
			vi.fn(),
		);
		expect(decision.decision).toBe("allow");
		expect(decision.rule_id).toBeUndefined();
		expect(decision.reason).toBeUndefined();
		expect(session.failed_files.has(FILE)).toBe(false);
	});

	it("N2: severity is actionable but determinism never fully_deterministic -> not blocked, still recorded as failed", () => {
		const decision = makeDecision();
		const session = makeSession();
		applyStructuralFindings(
			[sc("heur-check-b", "error")],
			FILE,
			ev(),
			session,
			decision,
			[],
			vi.fn(),
		);
		expect(decision.decision).toBe("allow");
		expect(decision.rule_id).toBeUndefined();
		expect(session.failed_files.get(FILE)?.checks).toEqual(["heur-check-b"]);
	});

	it("P4: pre-existing decision.warnings is preserved, not clobbered, by the || [] fallback", () => {
		mFormatStructural.mockReturnValue(["NEW"]);
		const decision = makeDecision({ warnings: ["OLD"] });
		applyStructuralFindings(
			[sc("det-check-a", "info")],
			FILE,
			ev(),
			makeSession(),
			decision,
			[],
			vi.fn(),
		);
		expect(decision.warnings).toEqual(["OLD", "NEW"]);
	});

	it("P5: the fallback reason sentence is used only when there are no warnings to join", () => {
		mFormatStructural.mockReturnValue([]);
		const decision = makeDecision();
		applyStructuralFindings(
			[sc("det-check-a", "warning")],
			FILE,
			ev(),
			makeSession(),
			decision,
			[],
			vi.fn(),
		);
		expect(decision.reason).toBe(
			"[interlinked] PostToolUse structural checks flagged a deterministic issue.",
		);
	});

	it("N3: decision.reason/rule_id are never overwritten once already set (??= semantics, not &&=)", () => {
		mFormatStructural.mockReturnValue(["W1"]);
		const decision = makeDecision({ reason: "EXISTING", rule_id: "existing-rule" });
		applyStructuralFindings(
			[sc("det-check-a", "warning")],
			FILE,
			ev(),
			makeSession(),
			decision,
			[],
			vi.fn(),
		);
		expect(decision.reason).toBe("EXISTING");
		expect(decision.rule_id).toBe("existing-rule");
	});

	it("P6: an unknown check name inside the block-decision predicates does not throw (optional chaining) and is excluded from both block and leadCheck", () => {
		const decision = makeDecision();
		const session = makeSession();
		const structuralResults = [
			sc("nonexistent-check", "warning"), // absent from metadata entirely
			sc("det-check-c", "error"), // the real, valid leadCheck
		];
		expect(() =>
			applyStructuralFindings(structuralResults, FILE, ev(), session, decision, [], vi.fn()),
		).not.toThrow();
		expect(decision.decision).toBe("block");
		expect(decision.rule_id).toBe("det-check-c");
	});
});

// ===========================================================================
// runDeletionHygiene (+ two `(e) => e.name` arrows) — 21 survivors
// ===========================================================================

describe("runDeletionHygiene", () => {
	it("P1: nothing actually removed (every old export still present in new exports) -> no-op, no test-file lookup at all", () => {
		const decision = makeDecision();
		const allCheckResults: CheckResultEntry[] = [];
		runDeletionHygiene(
			"/repo/src/mod.ts",
			makeSession(),
			[exp("A"), exp("B")],
			[exp("A"), exp("B")],
			"/repo",
			decision,
			allCheckResults,
		);
		expect(decision.warnings).toBeUndefined();
		expect(allCheckResults).toEqual([]);
		expect(mExistsSync).not.toHaveBeenCalled();
	});

	it("P2: the extension pattern requires end-of-string — 'mod.ts.bak' does not match .ts, so no lookup is performed", () => {
		runDeletionHygiene(
			"/repo/src/mod.ts.bak",
			makeSession(),
			[exp("removedFn")],
			[],
			"/repo",
			makeDecision(),
			[],
		);
		expect(mExistsSync).not.toHaveBeenCalled();
	});

	it("P3: probes all four co-located test-file candidates, sliced from the base path with the extension removed", () => {
		mExistsSync.mockReturnValue(false);
		runDeletionHygiene(
			"/repo/src/mod.ts",
			makeSession(),
			[exp("removedFn")],
			[],
			"/repo",
			makeDecision(),
			[],
		);
		expect(mExistsSync.mock.calls.map((c) => c[0])).toEqual([
			"/repo/src/mod.test.ts",
			"/repo/src/mod.spec.ts",
			"/repo/src/__tests__/mod.test.ts",
			"/repo/src/__tests__/mod.spec.ts",
		]);
	});

	it("P4: an existing co-located test file with a real orphan finding is read as utf-8, mapped to a suggestion/warning/heuristic CheckResultEntry, and appended into decision.warnings", () => {
		mExistsSync.mockImplementation((p: unknown) => p === "/repo/src/mod.test.ts");
		mReadFileSync.mockReturnValue("test file content");
		mCheckOrphaned.mockReturnValue([
			{
				check: "orphaned_test_reference",
				line: 5,
				message: "still references removedFn",
				source: "quality",
			},
		]);
		const decision = makeDecision();
		const allCheckResults: CheckResultEntry[] = [];
		const session = makeSession();

		runDeletionHygiene(
			"/repo/src/mod.ts",
			session,
			[exp("removedFn")],
			[],
			"/repo",
			decision,
			allCheckResults,
		);

		expect(mReadFileSync).toHaveBeenCalledWith("/repo/src/mod.test.ts", "utf-8");
		expect(mCheckOrphaned).toHaveBeenCalledWith(
			["removedFn"],
			"src/mod.test.ts",
			"test file content",
			false,
		);
		expect(allCheckResults).toEqual([
			{
				source: "suggestion",
				name: "orphaned_test_reference",
				severity: "warning",
				message: "still references removedFn",
				file: "/repo/src/mod.test.ts",
				determinism: "heuristic",
			},
		]);
		expect(decision.warnings).toEqual([
			"[deletion-hygiene:orphaned_test_reference] still references removedFn",
		]);
	});

	it("N1: an existing co-located test file with zero orphan findings leaves decision.warnings untouched", () => {
		mExistsSync.mockImplementation((p: unknown) => p === "/repo/src/mod.test.ts");
		mReadFileSync.mockReturnValue("test file content");
		mCheckOrphaned.mockReturnValue([]);
		const decision = makeDecision();
		runDeletionHygiene(
			"/repo/src/mod.ts",
			makeSession(),
			[exp("removedFn")],
			[],
			"/repo",
			decision,
			[],
		);
		expect(decision.warnings).toBeUndefined();
	});
});

// ===========================================================================
// recordStructuralErrorMemory (+ one `(e) => e.name` arrow) — 19 survivors.
//
// Uses buildErrorContextSpy (spies on the REAL ErrorHistory.buildErrorContext
// rather than mocking the whole module) so the exact opts object can be
// inspected with toStrictEqual — the load-bearing assertion for the
// old_string/new_string/content conditional-spread mutants (see file header).
// ===========================================================================

describe("recordStructuralErrorMemory", () => {
	it("P1: old_string+new_string+content all present are all forwarded verbatim, the edited file is re-read as utf-8 to derive a 1-based lineStart when old_string is found, and pre_error_sequence/co_edited_files are taken from session state", async () => {
		const ctx = makeCtx();
		const fileGraph = makeGraph({
			toRelative: vi.fn((f: string) => f.replace("/repo/", "")),
			classifyModule: vi.fn(() => "leaf"),
			getExports: vi.fn(() => [exp("foo"), exp("bar")]),
			getDependents: vi.fn(() => ["/repo/a.ts"]),
			getDependencies: vi.fn(() => ["/repo/b.ts"]),
		});
		mReadFileSync.mockReturnValue("OLD_TEXT tail");
		const checkEvent = ev({
			tool_input: { old_string: "OLD_TEXT", new_string: "NEW_TEXT", content: "IGNORED_CONTENT" },
		});
		const session = makeSession({
			agent_name: "agent-z",
			tool_sequence: ["Read", "Edit"],
			files_written: new Set(["/repo/other.ts", "/repo/mod.ts"]),
		});
		const structuralResults = [sc("export_surface", "error")];

		await recordStructuralErrorMemory(
			ctx,
			checkEvent,
			ev({ session_id: "sess-9" }),
			session,
			"/repo/mod.ts",
			fileGraph,
			structuralResults,
		);

		expect(buildErrorContextSpy).toHaveBeenCalledTimes(1);
		const opts = buildErrorContextSpy.mock.calls[0]?.[0];
		expect(opts).toStrictEqual({
			file: "mod.ts",
			fileRole: "leaf",
			dependentCount: 1,
			dependencyCount: 1,
			exports: ["foo", "bar"],
			result: structuralResults[0],
			oldString: "OLD_TEXT",
			newString: "NEW_TEXT",
			content: "IGNORED_CONTENT",
		});

		expect(mReadFileSync).toHaveBeenCalledWith("/repo/mod.ts", "utf-8");
		expect(ctx.errorHistory.recordError).toHaveBeenCalledTimes(1);
		const call = (ctx.errorHistory.recordError as unknown as Mock).mock.calls[0] as unknown[];
		expect(call[0]).toBe("sess-9");
		expect(call[1]).toBe("agent-z");
		expect(call[2]).toBe("mod.ts");
		expect(call[3]).toBe("leaf");
		expect(call[4]).toBe(structuralResults[0]);
		expect(call[5]).toBe("CTX");
		expect(call[6]).toStrictEqual({
			line_start: 1,
			co_edited_files: ["other.ts"],
			pre_error_sequence: ["Read", "Edit"],
		});
	});

	it("N1: old_string/new_string/content all absent from tool_input are all OMITTED from the context opts (not spread as explicit undefined), and the file is never re-read", async () => {
		const ctx = makeCtx();
		const fileGraph = makeGraph();
		const checkEvent = ev({ tool_input: {} });

		await recordStructuralErrorMemory(
			ctx,
			checkEvent,
			ev(),
			makeSession(),
			"/repo/mod.ts",
			fileGraph,
			[sc("export_surface", "warning")],
		);

		const opts = buildErrorContextSpy.mock.calls[0]?.[0];
		expect(opts).toStrictEqual({
			file: "mod.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: [],
			result: expect.objectContaining({ check: "export_surface" }),
		});
		expect(mReadFileSync).not.toHaveBeenCalled();
	});

	it("P2: old_string not found in the re-read file content leaves lineStart undefined (no line_start key at all)", async () => {
		const ctx = makeCtx();
		mReadFileSync.mockReturnValue("totally different content");
		const checkEvent = ev({ tool_input: { old_string: "NOT_PRESENT" } });
		const session = makeSession({ files_written: new Set<string>() });

		await recordStructuralErrorMemory(
			ctx,
			checkEvent,
			ev(),
			session,
			"/repo/mod.ts",
			makeGraph(),
			[sc("export_surface", "error")],
		);

		const call = (ctx.errorHistory.recordError as unknown as Mock).mock.calls[0] as unknown[];
		expect(call[6]).toStrictEqual({
			co_edited_files: [],
			pre_error_sequence: ["Read", "Edit"],
		});
	});

	it("N2: info-severity findings are skipped entirely — recordError is never called", async () => {
		const ctx = makeCtx();
		await recordStructuralErrorMemory(
			ctx,
			ev(),
			ev(),
			makeSession(),
			"/repo/mod.ts",
			makeGraph(),
			[sc("some-check", "info")],
		);
		expect(ctx.errorHistory.recordError).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// recordStructuralFixMemory (+ one `(e) => e.name` arrow) — 13 survivors.
// Same opts-spread shape as recordStructuralErrorMemory but without the
// lineStart/readFileSync side path — a present/absent pair suffices.
// ===========================================================================

describe("recordStructuralFixMemory", () => {
	it("P1: old_string+new_string+content all present are all forwarded verbatim to buildQueryContext, and exports are name-mapped", () => {
		const ctx = makeCtx();
		const fileGraph = makeGraph({
			toRelative: vi.fn((f: string) => f.replace("/repo/", "")),
			classifyModule: vi.fn(() => "hub"),
			getExports: vi.fn(() => [exp("foo"), exp("bar")]),
			getDependents: vi.fn(() => ["/repo/a.ts", "/repo/c.ts"]),
			getDependencies: vi.fn(() => ["/repo/b.ts"]),
		});
		const checkEvent = ev({
			tool_input: { old_string: "O", new_string: "N", content: "IGNORED" },
		});

		recordStructuralFixMemory(ctx, checkEvent, "/repo/mod.ts", fileGraph);

		expect(buildQueryContextSpy).toHaveBeenCalledTimes(1);
		const opts = buildQueryContextSpy.mock.calls[0]?.[0];
		expect(opts).toStrictEqual({
			file: "mod.ts",
			fileRole: "hub",
			dependentCount: 2,
			dependencyCount: 1,
			exports: ["foo", "bar"],
			oldString: "O",
			newString: "N",
			content: "IGNORED",
		});
		expect(ctx.errorHistory.recordFix).toHaveBeenCalledWith("mod.ts", "QCTX");
	});

	it("N1: old_string/new_string/content all absent from tool_input are all OMITTED from the opts (not spread as explicit undefined)", () => {
		const ctx = makeCtx();
		recordStructuralFixMemory(ctx, ev({ tool_input: {} }), "/repo/mod.ts", makeGraph());

		const opts = buildQueryContextSpy.mock.calls[0]?.[0];
		expect(opts).toStrictEqual({
			file: "mod.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: [],
		});
	});
});

// ===========================================================================
// runImpactOrFallback (+ the .filter() arrow in the fallback branch) — 14
// survivors.
// ===========================================================================

describe("runImpactOrFallback", () => {
	function impact(
		over: Partial<{
			severity: "low" | "medium" | "high" | "critical";
			dependentCount: number;
			breakingFiles: string[];
		}> = {},
	) {
		return {
			file: "/repo/mod.ts",
			severity: "critical" as const,
			moduleRole: "hub" as const,
			dependentCount: 3,
			breakingFiles: ["/repo/a.ts", "/repo/b.ts"],
			testFiles: [],
			followUpFiles: [],
			exportSurfaceChanged: true,
			summary: "s",
			...over,
		};
	}

	it("P1: critical severity blocks, sets rule_id/reason from empty state, appends impact warnings, and logs the severity/dependent/breaking counts", () => {
		mRunImpact.mockReturnValue(impact());
		mFormatImpact.mockReturnValue(["IW1"]);
		const decision = makeDecision();
		const session = makeSession();
		const log = vi.fn();

		runImpactOrFallback(
			makeCtx(),
			"/repo/mod.ts",
			makeGraph(),
			makeStructuralConfig({ impact_analysis: true, impact_high_threshold: 4 }),
			[],
			[],
			session,
			decision,
			log,
		);

		expect(mRecordImpactFollowUps).toHaveBeenCalledTimes(1);
		expect(decision.warnings).toEqual(["IW1"]);
		expect(decision.decision).toBe("block");
		expect(decision.rule_id).toBe("impact-critical");
		expect(decision.reason).toBe("IW1");
		expect(log).toHaveBeenCalledWith("Impact analysis: critical (3 dependents, 2 breaking)");
	});

	it("N1: non-critical severity with zero impact warnings leaves decision entirely untouched (no [] assigned to warnings, no block)", () => {
		mRunImpact.mockReturnValue(impact({ severity: "high", dependentCount: 1, breakingFiles: [] }));
		mFormatImpact.mockReturnValue([]);
		const decision = makeDecision();

		runImpactOrFallback(
			makeCtx(),
			"/repo/mod.ts",
			makeGraph(),
			makeStructuralConfig({ impact_analysis: true }),
			[],
			[],
			makeSession(),
			decision,
			vi.fn(),
		);

		expect(decision.warnings).toBeUndefined();
		expect(decision.decision).toBe("allow");
		expect(decision.rule_id).toBeUndefined();
	});


	it("N3a: the fallback filter requires check === 'export_surface' — a wrong-name entry placed after the real match must not overwrite it", () => {
		const session = makeSession();
		runImpactOrFallback(
			makeCtx(),
			"/repo/mod.ts",
			makeGraph(),
			makeStructuralConfig({ impact_analysis: false }),
			[],
			[
				sc("export_surface", "warning", {
					affectedFiles: ["/repo/dep.ts"],
					message: "the real one",
				}),
				sc("other_check", "warning", {
					affectedFiles: ["/repo/wrong-check.ts"],
					message: "WRONG",
				}),
			],
			session,
			makeDecision(),
			vi.fn(),
		);
		expect(session.pending_completions.get("/repo/mod.ts")?.description).toBe("the real one");
	});

	it("N3b: the fallback filter requires a non-empty affectedFiles — an empty-array entry placed after the real match must not overwrite it", () => {
		const session = makeSession();
		runImpactOrFallback(
			makeCtx(),
			"/repo/mod.ts",
			makeGraph(),
			makeStructuralConfig({ impact_analysis: false }),
			[],
			[
				sc("export_surface", "warning", {
					affectedFiles: ["/repo/dep.ts"],
					message: "the real one",
				}),
				sc("export_surface", "warning", { affectedFiles: [], message: "WRONG" }),
			],
			session,
			makeDecision(),
			vi.fn(),
		);
		expect(session.pending_completions.get("/repo/mod.ts")?.description).toBe("the real one");
	});
});
