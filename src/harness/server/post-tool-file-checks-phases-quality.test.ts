// Behavioral coverage for `./post-tool-file-checks-phases-quality.js` — the
// quality-phase helpers extracted out of the PostToolUse
// per-file check orchestrator (buildSmartTscOpts,
// expandQualitySiblings, collectQualityResultEntries, deferral formatting,
// applyQualityDecision,
// computeEditRegion [private, exercised via runScoredSuggestionsPhase],
// runScoredSuggestionsPhase).
//
// Every collaborator module is mocked at the import boundary (same
// convention as the sibling `post-tool-file-checks-phases.test.ts`) so each
// function's OWN branches are driven deterministically — no tsc spawn, no
// real trigram index, no real filesystem. Assertions use exact values
// (`toEqual`/`toBe`/`toHaveBeenCalledWith`) rather than substring matching.
//
// Three mutants targeting this file were judged structurally equivalent
// (documented inline at their nearest test, not killed by a test):
//   - `blocking[0]?.name` (applyQualityDecision): `blocking[0]` is only read
//     inside `if (blocking.length > 0)`, so it is never undefined — `?.` vs
//     plain `.` never diverges.
//   - the `read()` closure's `catch (e) { void e; return undefined; }`
//     (expandQualitySiblings): an empty catch block still swallows the
//     exception and the arrow function implicitly returns undefined when it
//     falls off the end — byte-identical to the explicit return.
//   - the outer `catch (e) { void e; }` (runScoredSuggestionsPhase): the
//     function returns `void`; an empty catch vs `void e;` then falling off
//     the end are indistinguishable for every input.

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { QualityCheckResult } from "../quality-checks/result-types.js";
import type {
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

// ---------------------------------------------------------------------------
// Module mocks (vitest hoists these above the real-module imports below).
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
}));

// Full replacement, deliberately decoupled from the real (large, shared)
// registry tables: three synthetic check ids give exact, drift-proof control
// over the `??` / determinism-comparison branches under test.
vi.mock("../check-metadata.js", () => ({
	QUALITY_CHECK_META: {
		quality_only_fd: { name: "t", description: "t", tier: 1, determinism: "fully_deterministic" },
		quality_only_heuristic: { name: "t", description: "t", tier: 1, determinism: "heuristic" },
		check_a: { name: "t", description: "t", tier: 1, determinism: "fully_deterministic" },
	},
	GENERIC_CHECK_META: {
		generic_only_partial: { name: "t", description: "t", tier: 1, determinism: "partially_deterministic" },
	},
}));

vi.mock("../quality-checks.js", () => ({
	classifyDeterminism: vi.fn(() => "proven"),
	formatQualityWarnings: vi.fn(() => []),
	findProjectRoot: vi.fn((_f: string, cwd: string) => cwd),
}));

vi.mock("../session-state.js", () => ({
	isAcknowledged: vi.fn(() => false),
}));

// DEFAULT_TRIGGERS must stay real (its "as_any_ratchet" entry seeds the
// fan-out tests below); only expandSiblings itself is mocked.
vi.mock("../sibling-expansion.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../sibling-expansion.js")>()),
	expandSiblings: vi.fn(() => []),
}));

vi.mock("../suggestion-scorer.js", () => ({
	formatScoredFindings: vi.fn(() => []),
	scoreFindings: vi.fn(() => []),
	writeTelemetry: vi.fn(),
}));

vi.mock("../suppressions.js", () => ({
	loadFileSuppressions: vi.fn(() => new Set<string>()),
	scanInlineSuppressions: vi.fn(() => []),
}));

vi.mock("./deletion-hygiene-diff.js", () => ({
	collectDeletionHygieneDiffFindings: vi.fn(() => []),
}));

vi.mock("./suggestion-checks.js", () => ({
	collectSuggestionFindings: vi.fn(() => []),
}));

// Bind to the mocked exports so each test can re-program return values.
import { existsSync, readFileSync } from "node:fs";
import { classifyDeterminism, findProjectRoot, formatQualityWarnings } from "../quality-checks.js";
import { isAcknowledged } from "../session-state.js";
import { expandSiblings } from "../sibling-expansion.js";
import { formatScoredFindings, scoreFindings, writeTelemetry } from "../suggestion-scorer.js";
import { loadFileSuppressions, scanInlineSuppressions } from "../suppressions.js";
import { collectDeletionHygieneDiffFindings } from "./deletion-hygiene-diff.js";
import {
	applyQualityDecision,
	buildSmartTscOpts,
	collectQualityResultEntries,
	expandQualitySiblings,
	runScoredSuggestionsPhase,
} from "./post-tool-file-checks-phases-quality.js";
import { collectSuggestionFindings } from "./suggestion-checks.js";

// SAFETY: every binding below is a `vi.mock`-replaced export (see the mock
// factories above); the real module's typed signature no longer describes
// the runtime value, so each is re-cast to vitest's untyped `Mock` to call
// `.mockReturnValue()` / `.mock.calls` — the same fixture-boundary pattern
// the sibling `post-tool-file-checks-phases.test.ts` uses for its mocks.
const mExistsSync = existsSync as unknown as Mock;
const mReadFileSync = readFileSync as unknown as Mock;
const mClassifyDeterminism = classifyDeterminism as unknown as Mock;
const mFormatQuality = formatQualityWarnings as unknown as Mock;
const mFindProjectRoot = findProjectRoot as unknown as Mock;
const mIsAck = isAcknowledged as unknown as Mock;
const mExpandSiblings = expandSiblings as unknown as Mock;
const mScoreFindings = scoreFindings as unknown as Mock;
const mFormatScored = formatScoredFindings as unknown as Mock;
const mWriteTelemetry = writeTelemetry as unknown as Mock;
const mLoadFileSup = loadFileSuppressions as unknown as Mock;
const mScanInlineSup = scanInlineSuppressions as unknown as Mock;
const mDeletionHygiene = collectDeletionHygieneDiffFindings as unknown as Mock;
const mCollectSuggestions = collectSuggestionFindings as unknown as Mock;

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

// SAFETY: fixture-boundary cast (same pattern as the sibling
// post-tool-file-checks-phases.test.ts's makeSession/makeRules/makeCtx) —
// only the fields the functions under test actually read are populated;
// satisfying every field of the real ~15/~10/~30-field interface would add
// bulk with no behavioral value.
function makeSession(partial: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		agent_name: "agent-x",
		tool_call_count: 7,
		files_written: new Set<string>(),
		failed_files: new Map(),
		pending_completions: new Map(),
		tool_sequence: ["Read", "Edit"],
		...partial,
	} as unknown as SessionTrajectory;
}

// SAFETY: fixture-boundary cast — see makeSession above.
function makeRules(partial: Record<string, unknown> = {}): GuardRulesConfig {
	return {
		quality_checks: {},
		...partial,
	} as unknown as GuardRulesConfig;
}

// SAFETY: fixture-boundary cast — see makeSession above.
function makeCtx(over: Record<string, unknown> = {}): ServerRuntime {
	return {
		cwd: CWD,
		interlinkedDir: `${CWD}/.interlinked`,
		rules: makeRules(),
		trigramIndex: null,
		log: vi.fn(),
		...over,
	} as unknown as ServerRuntime;
}

function makeAcc(partial: Partial<PerFileCheckCtx> = {}): PerFileCheckCtx {
	return {
		// Fixed, not Date.now(): nothing under test reads postStartMs, and a
		// literal keeps this fixture deterministic.
		postStartMs: 0,
		allCheckResults: [],
		checksRan: [],
		postToolMetrics: [],
		markPhase: vi.fn(),
		projectWideSweepFired: false,
		recurrenceCursor: 0,
		...partial,
	};
}

function qr(over: Partial<QualityCheckResult> = {}): QualityCheckResult {
	return { name: "check", severity: "warning", message: "m", ...over };
}

beforeEach(() => {
	vi.resetAllMocks();
	mExistsSync.mockReturnValue(false);
	mReadFileSync.mockReturnValue("");
	mClassifyDeterminism.mockReturnValue("proven");
	mFormatQuality.mockImplementation((rs: { name: string }[]) => rs.map((r) => `[q] ${r.name}`));
	mFindProjectRoot.mockImplementation((_f: string, cwd: string) => cwd);
	mIsAck.mockReturnValue(false);
	mExpandSiblings.mockReturnValue([]);
	mScoreFindings.mockReturnValue([]);
	mFormatScored.mockImplementation((ss: { check: string }[]) => ss.map((s) => `[sugg] ${s.check}`));
	mWriteTelemetry.mockReturnValue(undefined);
	mLoadFileSup.mockReturnValue(new Set<string>());
	mScanInlineSup.mockReturnValue([]);
	mDeletionHygiene.mockReturnValue([]);
	mCollectSuggestions.mockReturnValue([]);
});

// ===========================================================================
// buildSmartTscOpts
// ===========================================================================

describe("buildSmartTscOpts", () => {
	// Removed 2026-09-01: `structuralConfig is absent` and
	// `rules.quality_checks is absent` previously probed `?.` guards on both
	// params. Neither is reachable in practice — `structural_checks` and
	// `quality_checks` are honestly required on GuardRulesConfig, and
	// `loadRules()` (the only production source of a GuardRulesConfig)
	// always populates both; the sole caller of `buildSmartTscOpts`
	// (post-tool-file-checks-phases.ts) forwards `ctx.rules.structural_checks`
	// verbatim, never a substitute. Re-adding the guards would silence the
	// type checker's honest signal for a state that can't occur, so these
	// cases were deleted as impossible rather than reinstating the `?.`.

	// test-contract: public-api — on the happy path the function computes the
	// project-relative filter path and logs it verbatim (agent-visible message).
	it("returns the relative filter path and logs the exact smart-tsc message", () => {
		const ctx = makeCtx({
			cwd: CWD,
			rules: makeRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
		});
		const result = buildSmartTscOpts(
			ctx,
			{ smart_tsc: true } as unknown as GuardRulesConfig["structural_checks"],
			FILE,
			false,
		);
		expect(result).toEqual({ tscFilterFile: "src/mod.ts" });
		expect(ctx.log).toHaveBeenCalledWith("Smart tsc: filtering to src/mod.ts (internal-only edit)");
	});
});

// ===========================================================================
// expandQualitySiblings
// ===========================================================================

describe("expandQualitySiblings", () => {
	function triggerResult(): QualityCheckResult {
		return qr({ name: "as_any_ratchet", file: FILE });
	}

	// test-contract: public-api — a returned sibling becomes a pushed
	// warning-severity finding carrying the SIBLING's own name/message/file
	// (not the triggering finding's), and a non-zero sibling count logs the
	// exact fan-out summary line.
	it("pushes a warning-severity finding per sibling and logs the exact fan-out summary", () => {
		mExpandSiblings.mockReturnValue([
			{
				triggerName: "as_any_ratchet",
				siblingRuleId: "as_any_sibling",
				file: "/repo/src/other.ts",
				line: 3,
				message: "sibling msg",
			},
		]);
		const ctx = makeCtx({ trigramIndex: {} });
		const qualityResults = [triggerResult()];
		expandQualitySiblings(ctx, FILE, qualityResults);
		expect(qualityResults).toEqual([
			triggerResult(),
			{ name: "as_any_sibling", severity: "warning", message: "sibling msg", file: "/repo/src/other.ts" },
		]);
		expect(ctx.log).toHaveBeenCalledWith("Sibling expansion: 1 row(s) across 1 trigger(s)");
	});

	// test-contract: boundary — zero siblings returned must not log the
	// fan-out summary at all (an empty run stays silent, not a "0 rows" line).
	it("does not log when expandSiblings returns zero siblings", () => {
		mExpandSiblings.mockReturnValue([]);
		const ctx = makeCtx({ trigramIndex: {} });
		expandQualitySiblings(ctx, FILE, [triggerResult()]);
		expect(ctx.log).not.toHaveBeenCalled();
	});

	// test-contract: public-api — the injected file reader joins `cwd` and
	// the candidate's relative path with "/" and reads as utf-8 (the exact
	// shape expandSiblings' trigram-candidate scan depends on). Captured from
	// the mocked expandSiblings' own call args since the reader is a closure
	// local to expandQualitySiblings and never itself exported.
	it("wires a reader that reads `${cwd}/${relPath}` as utf-8", () => {
		mExpandSiblings.mockReturnValue([]);
		const ctx = makeCtx({ trigramIndex: {}, cwd: "/repo" });
		expandQualitySiblings(ctx, FILE, [triggerResult()]);
		const callArgs = mExpandSiblings.mock.calls[0]?.[0] as {
			reader: { read(p: string): string | undefined };
		};
		mReadFileSync.mockReturnValueOnce("contents");
		expect(callArgs.reader.read("src/bar.ts")).toBe("contents");
		expect(mReadFileSync).toHaveBeenCalledWith("/repo/src/bar.ts", "utf-8");
	});

	// The read() closure's catch block — `{ void e; return undefined; }` vs
	// an empty `{}` — is judged structurally equivalent (see file header) and
	// intentionally left untested here.
});

// ===========================================================================
// collectQualityResultEntries
// ===========================================================================

describe("collectQualityResultEntries", () => {
	// test-contract: bug — the QUALITY_CHECK_META lookup must fall through to
	// GENERIC_CHECK_META with `??` (present-but-nullish coalescing). Swapping
	// the first `??` for `&&` makes an absent QUALITY_CHECK_META entry
	// short-circuit to `undefined` WITHOUT ever reading GENERIC_CHECK_META,
	// silently losing that lookup and falling to the classifyDeterminism
	// fallback instead — collapsing "partially_deterministic" to "heuristic".
	it("falls through to GENERIC_CHECK_META's raw determinism when QUALITY_CHECK_META has no entry", () => {
		const allCheckResults: PerFileCheckCtx["allCheckResults"] = [];
		collectQualityResultEntries(
			[qr({ name: "generic_only_partial", severity: "warning", message: "m", file: FILE })],
			allCheckResults,
		);
		expect(allCheckResults).toEqual([
			{
				source: "quality",
				name: "generic_only_partial",
				severity: "warning",
				message: "m",
				file: FILE,
				detail: undefined,
				determinism: "partially_deterministic",
			},
		]);
	});
});

// ===========================================================================
// applyQualityDecision
// ===========================================================================

describe("applyQualityDecision", () => {
	function fdResult(name: string, severity: "error" | "warning" = "error"): QualityCheckResult {
		return qr({ name, severity, message: `msg-${name}` });
	}

	// test-contract: bug — an empty results array must be a true no-op: no
	// warnings, no decision flip, no log line. The guard
	// `qualityResults.length === 0` gates every side effect in this function.
	it("is a no-op for an empty qualityResults array", () => {
		const ctx = makeCtx();
		const decision: HarnessDecision = { decision: "allow" };
		applyQualityDecision(ctx, [], decision);
		expect(decision).toEqual({ decision: "allow" });
		expect(ctx.log).not.toHaveBeenCalled();
	});

	// test-contract: bug — isBlockingResult requires severity === "error"; a
	// warning-severity fully-deterministic result must NOT block even though
	// its determinism matches. Also pins the `blocking.length > 0` boundary
	// at exactly 0 (the "advisory" outcome branch) and the "advisory" string.
	it("does not block a fully-deterministic result at warning severity, and reports advisory", () => {
		const ctx = makeCtx();
		const decision: HarnessDecision = { decision: "allow" };
		applyQualityDecision(ctx, [fdResult("quality_only_fd", "warning")], decision);
		expect(decision.decision).toBe("allow");
		expect(decision.rule_id).toBeUndefined();
		expect(decision.reason).toBeUndefined();
		expect(ctx.log).toHaveBeenCalledWith("Quality issues found: quality_only_fd (advisory)");
	});

	// test-contract: public-api — `name === "software_version_regression"` is
	// an escape hatch that blocks regardless of severity/determinism, landing
	// in the softer "post-tool attention required" bucket (hasDeterministicError
	// stays false, but blocking.length > 0). Pins that boundary at exactly 1.
	it("blocks via the software_version_regression name escape hatch at non-error severity", () => {
		const ctx = makeCtx();
		const decision: HarnessDecision = { decision: "allow" };
		applyQualityDecision(
			ctx,
			[qr({ name: "software_version_regression", severity: "warning", message: "m" })],
			decision,
		);
		expect(decision.decision).toBe("block");
		expect(decision.rule_id).toBe("software_version_regression");
		expect(ctx.log).toHaveBeenCalledWith(
			"Quality issues found: software_version_regression (post-tool attention required)",
		);
	});

	// test-contract: bug — right severity, wrong determinism ("heuristic", not
	// "fully_deterministic") must not count as a deterministic error; the `&&`
	// joining the two isBlockingResult/hasDeterministicError conditions must
	// not become `||` (which would block on severity alone).
	it("does not treat an error-severity heuristic result as a deterministic error", () => {
		const ctx = makeCtx();
		const decision: HarnessDecision = { decision: "allow" };
		applyQualityDecision(ctx, [fdResult("quality_only_heuristic", "error")], decision);
		expect(decision.decision).toBe("allow");
		expect(ctx.log).toHaveBeenCalledWith("Quality issues found: quality_only_heuristic (advisory)");
	});

	// test-contract: public-api — hasDeterministicError uses `.some()` over
	// the FULL results array (any one match is enough, not `.every()`), and
	// the composed rule_id/warnings/log line reflect the first blocking
	// result plus every result name in original order.
	it("blocks and reports 'blocking' when any one result is a deterministic error, alongside a non-matching result", () => {
		const ctx = makeCtx();
		const decision: HarnessDecision = { decision: "allow" };
		const results = [fdResult("check_a", "error"), qr({ name: "check_b", severity: "warning", message: "m2" })];
		applyQualityDecision(ctx, results, decision);
		expect(decision.decision).toBe("block");
		expect(decision.rule_id).toBe("check_a");
		expect(decision.warnings).toEqual(["[q] check_a", "[q] check_b"]);
		expect(ctx.log).toHaveBeenCalledWith("Quality issues found: check_a, check_b (blocking)");
	});

	// test-contract: public-api — two blocking messages are joined with a
	// blank line, and (since advisoryText is empty here) the joined text
	// becomes `decision.reason` directly, with no "— Advisory findings —"
	// wrapper.
	it("joins multiple blocking messages with a blank line", () => {
		const ctx = makeCtx();
		const decision: HarnessDecision = { decision: "allow" };
		applyQualityDecision(ctx, [fdResult("check_a", "error"), fdResult("check_a", "error")], decision);
		expect(decision.reason).toBe("[q] check_a\n\n[q] check_a");
	});

	// test-contract: public-api — a non-empty advisory tail is wrapped behind
	// the "— Advisory findings —" marker, and its own 2+ messages are ALSO
	// joined with a blank line (independent join call, independent mutant).
	it("wraps a multi-message advisory tail behind the advisory marker", () => {
		const ctx = makeCtx();
		const decision: HarnessDecision = { decision: "allow" };
		const results = [
			fdResult("check_a", "error"),
			qr({ name: "check_b", severity: "warning", message: "m2" }),
			qr({ name: "check_c", severity: "warning", message: "m3" }),
		];
		applyQualityDecision(ctx, results, decision);
		expect(decision.reason).toBe(
			"[q] check_a\n\n— Advisory findings (not blocking; address when convenient) —\n\n[q] check_b\n\n[q] check_c",
		);
	});

	it("compacts same-file deferrals without collapsing a different file", () => {
		const ctx = makeCtx();
		const decision: HarnessDecision = { decision: "allow" };
		applyQualityDecision(ctx, [
			qr({
				name: "external_check_deferred",
				message: "External check deferred (typescript)",
				file: FILE,
				detail: "No check verdict was produced: busy",
			}),
			qr({
				name: "affected_tests_deferred",
				message: "Affected tests deferred",
				file: FILE,
				detail: "No test verdict was produced.",
			}),
			qr({
				name: "external_check_deferred",
				message: "External check deferred elsewhere",
				file: "/repo/src/other.ts",
			}),
		], decision);

		expect(decision.warnings).toHaveLength(2);
		expect(decision.warnings?.[0]).toContain("[interlinked:checks-deferred]");
		expect(decision.warnings?.[0]).toContain("typescript, affected tests");
		expect(decision.warnings?.[0]?.split("\n")).toHaveLength(1);
		expect(decision.warnings?.[1]).toContain("external checks");
		expect(decision.warnings?.[1]?.split("\n")).toHaveLength(1);
	});

	it("keeps a lone capacity deferral to one concise line", () => {
		const ctx = makeCtx();
		const decision: HarnessDecision = { decision: "allow" };
		applyQualityDecision(ctx, [
			qr({
				name: "external_check_deferred",
				message: "External check deferred for src/a.ts (typescript)",
				file: "src/a.ts",
				detail:
					"No check verdict was produced: external-tool capacity is busy; this check was deferred without a verdict",
			}),
		], decision);

		expect(decision.warnings).toHaveLength(1);
		expect(decision.warnings?.[0]?.split("\n")).toHaveLength(1);
		expect(decision.warnings?.[0]).toContain("typescript for src/a.ts");
		expect(decision.warnings?.[0]).toContain("no clean verdict exists");
		expect(decision.warnings?.[0]).not.toContain("Fix all type errors");
	});

	// test-contract: bug — when formatQualityWarnings(blocking) formats to an
	// empty array (empty join === ""), the `||` fallback must supply the
	// fixed default reason text verbatim, not an empty string.
	it("falls back to the fixed default reason text when the blocking join is empty", () => {
		mFormatQuality.mockReturnValue([]);
		const ctx = makeCtx();
		const decision: HarnessDecision = { decision: "allow" };
		applyQualityDecision(ctx, [fdResult("check_a", "error")], decision);
		expect(decision.reason).toBe("[interlinked] PostToolUse quality checks flagged a deterministic error.");
	});

	// `blocking[0]?.name` — judged structurally equivalent (see file header)
	// and intentionally left untested here: `blocking[0]` is only read inside
	// `if (blocking.length > 0)`, so it can never be undefined at that point.
});

// ===========================================================================
// runScoredSuggestionsPhase (+ computeEditRegion, its unexported helper)
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

	beforeEach(() => {
		mExistsSync.mockReturnValue(true);
		mReadFileSync.mockReturnValue("const x = 1;\n");
		mCollectSuggestions.mockReturnValue([{ check: "c1", severity: "warning", line: 1, message: "m1" }]);
	});

	// test-contract: public-api — loadFileSuppressions must receive the exact
	// `<cwd>/.interlinked` join (not a bare/empty literal) plus the file's
	// cwd-relative path.
	it("loads file suppressions from the exact <cwd>/.interlinked path and threads the result into scoreFindings", () => {
		const fileSup = new Set(["magic-number"]);
		mLoadFileSup.mockReturnValue(fileSup);
		callSugg();
		expect(mLoadFileSup).toHaveBeenCalledWith("/repo/.interlinked", "src/mod.ts");
		expect(mScoreFindings).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ fileSuppressions: fileSup }),
		);
	});

	// test-contract: public-api — telemetry's interlinkedDir must be the same
	// `<cwd>/.interlinked` join as the suppressions lookup above — an
	// independent call site, an independent mutation target.
	it("writes telemetry with the exact <cwd>/.interlinked interlinkedDir", () => {
		callSugg();
		expect(mWriteTelemetry).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ interlinkedDir: "/repo/.interlinked" }),
		);
	});

	// test-contract: boundary — `session` can be undefined at runtime despite
	// its non-optional param type (defensive `session?.agent_name`); losing
	// the `?.` throws inside the try block, which the outer catch swallows —
	// telemetry would then silently never fire instead of using "unknown".
	it("falls back to 'unknown' telemetry agentName without throwing when session is undefined", () => {
		// Calls the SUT directly (not via callSugg's `over.session ??
		// makeSession()` convenience default, which would itself swallow an
		// explicit `undefined` back into a real session and defeat this
		// probe).
		// SAFETY: deliberately violates the SessionTrajectory param type to
		// probe the `session?.agent_name` runtime null-guard the source
		// itself defends against; this is the exact shape that guard exists
		// for, not an unrealistic input.
		const session = undefined as unknown as SessionTrajectory;
		const decision: HarnessDecision = { decision: "allow" };
		expect(() =>
			runScoredSuggestionsPhase(makeCtx(), ev(), FILE, session, decision, makeAcc()),
		).not.toThrow();
		expect(mWriteTelemetry).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ agentName: "unknown" }),
		);
	});

	// test-contract: bug — the telemetry threshold's `?? 0.5` default must use
	// nullish coalescing, not `&&` (which collapses an absent
	// `suggestion_threshold` to `undefined` instead of the documented default).
	it("defaults the telemetry threshold to 0.5 when rules.suggestion_threshold is unset", () => {
		const ctx = makeCtx({ rules: makeRules({ suggestion_threshold: undefined }) });
		callSugg({ ctx });
		expect(mWriteTelemetry).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ threshold: 0.5 }),
		);
	});

	// test-contract: public-api — the deletion-hygiene call receives exactly
	// {oldString, newString, filePath} built from the event's tool_input, not
	// an empty/placeholder object.
	it("passes the exact old_string/new_string/filePath object to deletion-hygiene detection", () => {
		const event = ev({ tool_input: { file_path: FILE, old_string: "OLD", new_string: "NEW" } });
		callSugg({ event });
		expect(mDeletionHygiene).toHaveBeenCalledWith({ oldString: "OLD", newString: "NEW", filePath: FILE });
	});

	// test-contract: public-api — the "Suggestions: ..." log line formats
	// each scored item as `check(score.toFixed(2))` and joins 2+ items with
	// ", " — pins the template, the per-item map callback, and the separator.
	it("logs the exact 'Suggestions: check(score), check(score)' summary for 2+ scored items", () => {
		const ctx = makeCtx();
		mScoreFindings.mockReturnValue([
			{ check: "c1", severity: "warning", line: 1, message: "m1", score: 0.7 },
			{ check: "c2", severity: "warning", line: 2, message: "m2", score: 0.3333 },
		]);
		callSugg({ ctx });
		expect(ctx.log).toHaveBeenCalledWith("Suggestions: c1(0.70), c2(0.33)");
	});

	// computeEditRegion is an unexported helper of this module; it has no
	// import surface of its own, so its branches are pinned indirectly
	// through the `editStartLine`/`editEndLine` options runScoredSuggestionsPhase
	// passes to scoreFindings.
	describe("computeEditRegion boundary (private helper)", () => {
		// test-contract: boundary — an empty `old_string` is falsy, so the
		// guard `!oldStr || !suggContent` must short-circuit to "no region"
		// even though suggContent itself is non-empty. Forcing the guard to
		// `false` (or `&&`) would let `"".indexOf("")` match at position 0 and
		// fabricate a region out of nothing.
		it("omits the edit region when old_string is the empty string", () => {
			mReadFileSync.mockReturnValue("something real");
			const event = ev({ tool_input: { file_path: FILE, old_string: "" } });
			callSugg({ event });
			const opts = mScoreFindings.mock.calls[0]?.[1] as {
				editStartLine?: number;
				editEndLine?: number;
			};
			expect(opts.editStartLine).toBeUndefined();
			expect(opts.editEndLine).toBeUndefined();
		});

		// test-contract: bug — `old_string` found at index 0 (the very start
		// of the file) is a VALID match; `idx < 0` must stay strict, not
		// `<= 0` (which would wrongly treat a match at position 0 as
		// "not found" and drop the region).
		it("computes editStartLine=1/editEndLine=2 when old_string matches at index 0", () => {
			mReadFileSync.mockReturnValue("hello world");
			const event = ev({ tool_input: { file_path: FILE, old_string: "hello" } });
			callSugg({ event });
			const opts = mScoreFindings.mock.calls[0]?.[1] as {
				editStartLine?: number;
				editEndLine?: number;
			};
			expect(opts.editStartLine).toBe(1);
			expect(opts.editEndLine).toBe(2);
		});
	});

	// The outer `catch (e) { void e; }` — judged structurally equivalent (see
	// file header) and intentionally left untested here.
});
