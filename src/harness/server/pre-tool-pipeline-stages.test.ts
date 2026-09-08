import { makeServerRuntime } from "./__tests__/fixtures.js";
import { makeGuardRules } from "../evaluator/__tests__/fixtures.js";
import { resolveStructureConfig } from "../structure/schema-validator.js";
const { Stats } = await vi.importActual<typeof import("node:fs")>("node:fs");
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { TddCycle } from "../types.js";
import { makeSession as makeSessionFixture } from "../__tests__/fixtures/evaluator.js";
// Behavioral coverage for the four extracted PreToolUse pipeline stages.
//
// Each stage mutates an in-flight `preDecision` (and/or `ctx.preEditBaselines`)
// in place. We mock every sibling check/baseline module + `node:fs` at the
// module boundary so each branch — every gate, baseline-present/absent,
// fail-open catch, and short-circuit — is driven deterministically and we
// assert the real mutation the stage performs.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckResultEntry, SessionTrajectory } from "../types.js";

// ---- Mock node:fs (full replacement; deterministic) ----
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	readFileSync: vi.fn(() => "pre-edit content"),
	statSync: vi.fn(() => ({ mtimeMs: 12345 })),
}));

// ---- Mock behavioral-checks.js (TDD / prod-delta / ratio / leapfrog) ----
vi.mock("../behavioral-checks.js", () => ({
	checkTddCommitGate: vi.fn(() : CheckResultEntry[] => []),
	checkProdDeltaWithoutTestDelta: vi.fn(() : CheckResultEntry[] => []),
	checkProdTestLocRatio: vi.fn(() : CheckResultEntry[] => []),
	checkTppLeapfrog: vi.fn(() : CheckResultEntry[] => []),
}));

// ---- Mock behavioral-diff-checks.js (batch 3 + batch 4 commit gates) ----
vi.mock("../behavioral-diff-checks.js", () => ({
	checkAssertionCountRegression: vi.fn(() : CheckResultEntry[] => []),
	checkAssertionStrengthWeakening: vi.fn(() : CheckResultEntry[] => []),
	checkAssertionValueSwap: vi.fn(() : CheckResultEntry[] => []),
	checkClockMockAdded: vi.fn(() : CheckResultEntry[] => []),
	checkConventionalCommitCoherence: vi.fn(() : CheckResultEntry[] => []),
	checkDisabledTestDelta: vi.fn(() : CheckResultEntry[] => []),
	checkDoneWithoutVerify: vi.fn(() : CheckResultEntry[] => []),
	checkReintroducesRemovedCode: vi.fn(() : CheckResultEntry[] => []),
	checkTestBlockCountRegression: vi.fn(() : CheckResultEntry[] => []),
	checkTestTimeoutInflation: vi.fn(() : CheckResultEntry[] => []),
	parseCommitMessageFromBash: vi.fn(() => null),
}));

// ---- Mock baseline / coverage / clone modules ----
vi.mock("../checks/crap-baseline.js", () => ({
	snapshotCrap: vi.fn(() => new Map<string, Map<string, number>>()),
}));
vi.mock("../checks/dry-baseline.js", () => ({
	snapshotDryShingles: vi.fn(() => new Map<string, Map<string, number>>()),
}));
vi.mock("../checks/dry-check.js", () => ({
	collectSiblingFunctions: vi.fn(() => []),
}));
vi.mock("../coverage-final-reader.js", () => ({
	loadCoverageFinal: vi.fn(() => null),
	coverageForFile: vi.fn(() => undefined),
}));
vi.mock("../discovered-primitives.js", () => ({
	capturePrimitiveViolations: vi.fn(() : Record<string, number> => ({})),
}));
vi.mock("../generic-checks.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../generic-checks.js")>(),
	checkFunctionComplexity: vi.fn(() : Array<{ text: string }> => []),
	checkMissingReturnTypes: vi.fn(() : Array<{ text: string }> => []),
}));
vi.mock("../project-typecheck-gate.js", () => ({
	checkProjectTypecheckClean: vi.fn(() : CheckResultEntry[] => []),
	checkProjectTypecheckCleanAsync: vi.fn(async () : Promise<CheckResultEntry[]> => []),
	checkProjectTestsClean: vi.fn(() : CheckResultEntry[] => []),
	checkProjectTestsCleanAsync: vi.fn(async () : Promise<CheckResultEntry[]> => []),
}));
const releaseHeavyProcess = vi.fn<() => void>();
vi.mock("../project-heavy-process-lock.js", () => ({
	tryAcquireProjectHeavyProcessLease: vi.fn(() => releaseHeavyProcess),
}));
vi.mock("../structure/structure-loader.js", () => ({
	loadStructureConfig: vi.fn(() => ({ config: null, errors: [], implicit: true })),
}));

// quality-checks.js: keep findProjectRoot real-ish (deterministic stub), stub
// the ratchet counters with distinct sentinels so we can assert they flow into
// the captured baseline.
vi.mock("../quality-checks.js", () => ({
	collectSoftwareVersionReferences: vi.fn(() => []),
	countAmbientSeams: vi.fn(() => ({ clock: 9, random: 10, env: 11 })),
	countAsAnyCasts: vi.fn(() => 1),
	countAssertionStrength: vi.fn(() => ({ weak: 12, exact: 13 })),
	countConsoleStatements: vi.fn(() => 2),
	countNonNullAssertions: vi.fn(() => 3),
	countPublicApiSurface: vi.fn(() => 4),
	countSuppressionDirectives: vi.fn(() => 5),
	countTodoMarkers: vi.fn(() => 6),
	countTypeDensity: vi.fn(() => ({ value: 7 })),
	countUnjustifiedCasts: vi.fn(() => 8),
	findProjectRoot: vi.fn((_fp: string, cwd: string) => cwd),
}));

// runtime-context.js: keep summarizeToolInput real (used by guard reports).
vi.mock("./runtime-context.js", async () => {
	const actual =
		await vi.importActual<typeof import("./runtime-context.js")>("./runtime-context.js");
	return { summarizeToolInput: actual.summarizeToolInput };
});

import { existsSync, readFileSync, statSync } from "node:fs";
import {
	checkProdDeltaWithoutTestDelta,
	checkProdTestLocRatio,
	checkTddCommitGate,
	checkTppLeapfrog,
} from "../behavioral-checks.js";
import {
	checkConventionalCommitCoherence,
	checkTestBlockCountRegression,
	parseCommitMessageFromBash,
} from "../behavioral-diff-checks.js";
import { snapshotCrap } from "../checks/crap-baseline.js";
import { snapshotDryShingles } from "../checks/dry-baseline.js";
import { coverageForFile, loadCoverageFinal } from "../coverage-final-reader.js";
import { capturePrimitiveViolations } from "../discovered-primitives.js";
import { checkFunctionComplexity, checkMissingReturnTypes } from "../generic-checks.js";
import {
	checkProjectTestsClean,
	checkProjectTestsCleanAsync,
	checkProjectTypecheckClean,
	checkProjectTypecheckCleanAsync,
} from "../project-typecheck-gate.js";
import { tryAcquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import { collectSoftwareVersionReferences, countTodoMarkers } from "../quality-checks.js";
import { loadStructureConfig } from "../structure/structure-loader.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import {
	captureDiffAwareBaseline,
	injectStructureContext,
	runProjectWideGitGate,
	runProjectWideGitGateAsync,
	runTddCommitGate,
} from "./pre-tool-pipeline-stages.js";
import type { ServerRuntime } from "./runtime-context.js";

const mExists = vi.mocked(existsSync);
const mReadFile = vi.mocked(readFileSync);
const mStat = vi.mocked(statSync);

// ---- Fixtures ----

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		...partial,
	};
}

function allow(): HarnessDecision {
	return { decision: "allow" };
}

function check(over: Partial<CheckResultEntry> = {}): CheckResultEntry {
	return {
		source: "quality",
		name: "demo_check",
		severity: "warning",
		message: "demo message",
		determinism: "heuristic",
		...over,
	};
}

/** Hydrated trajectory with each case's state changes. */
function makeSession(over: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return ({ ...makeSessionFixture(),
		session_id: "s",
		agent_name: "agent-x",
		tdd_cycles: new Map(),
		pending_completions: new Map(),
		...over,
	} satisfies SessionTrajectory);
}

function makeCtx(over: Partial<ServerRuntime> = {}): ServerRuntime {
	const rules = makeGuardRules();
	rules.diff_aware = { enabled: true };
	rules.structural_checks.test_first_mode = "warn";
	const ctx = makeServerRuntime({ rules, ...over });
	// Error-history fixture hydration is setup, not a pipeline filesystem read.
	mReadFile.mockClear();
	mExists.mockClear();
	return ctx;
}

function bridge(reportGuardEvent: NonNullable<ServerRuntime["serverBridge"]>["reportGuardEvent"]): NonNullable<ServerRuntime["serverBridge"]> {
	return { reportGuardEvent, fetchCoordinationState: vi.fn(async () => null) };
}

function tddCycle(source_file = "src/a.ts"): TddCycle {
	return { source_file, test_file: "src/a.test.ts", state: "green", impl_edits_before_test: 0 };
}

function enforceRules(): ServerRuntime["rules"] {
	const rules = makeGuardRules();
	rules.structural_checks.test_first_mode = "enforce";
	return rules;
}

const fileCoverage: PerFileCoverage = { filePath: "src/a.ts", mtime: 12345, functions: [] };
const coverageCache = new Map([["src/a.ts", fileCoverage]]);

beforeEach(() => {
	vi.clearAllMocks();
	// Re-apply default implementations cleared by clearAllMocks.
	mExists.mockReturnValue(true);
	mReadFile.mockReturnValue("pre-edit content");
	mStat.mockReturnValue(Object.assign(new Stats(), { mtimeMs: 12345 }));
	vi.mocked(checkTddCommitGate).mockReturnValue([]);
	vi.mocked(checkProdDeltaWithoutTestDelta).mockReturnValue([]);
	vi.mocked(checkProdTestLocRatio).mockReturnValue([]);
	vi.mocked(checkTppLeapfrog).mockReturnValue([]);
	vi.mocked(parseCommitMessageFromBash).mockReturnValue(null);
	vi.mocked(checkConventionalCommitCoherence).mockReturnValue([]);
	vi.mocked(checkProjectTypecheckClean).mockReturnValue([]);
	vi.mocked(checkProjectTypecheckCleanAsync).mockResolvedValue([]);
	vi.mocked(checkProjectTestsClean).mockReturnValue([]);
	vi.mocked(checkProjectTestsCleanAsync).mockResolvedValue([]);
	vi.mocked(tryAcquireProjectHeavyProcessLease).mockReturnValue(releaseHeavyProcess);
	vi.mocked(loadCoverageFinal).mockReturnValue(null);
	vi.mocked(snapshotCrap).mockReturnValue(new Map());
	vi.mocked(snapshotDryShingles).mockReturnValue(new Map());
	vi.mocked(checkFunctionComplexity).mockReturnValue([]);
	vi.mocked(checkMissingReturnTypes).mockReturnValue([]);
	vi.mocked(capturePrimitiveViolations).mockReturnValue({});
	vi.mocked(collectSoftwareVersionReferences).mockReturnValue([]);
	vi.mocked(countTodoMarkers).mockReturnValue(6);
	vi.mocked(loadStructureConfig).mockReturnValue({
		config: null,
		errors: [],
		implicit: true,
	});
});

// NOTE: no vi.restoreAllMocks() here — restoreAllMocks() tears the factory
// implementations off module mocks, which would break every subsequent test.
// clearAllMocks() (call history only) + the beforeEach re-init is the correct
// reset for module-level mocks.

// =====================================================================
// runTddCommitGate
// =====================================================================

describe("runTddCommitGate", () => {
	const commitEvent = () => ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } });

	it("does nothing when decision is not 'allow'", () => {
		const pre: HarnessDecision = { decision: "block", reason: "already blocked" };
		runTddCommitGate(makeCtx(), commitEvent(), makeSession(), pre);
		expect(pre.warnings).toBeUndefined();
		expect(checkProdDeltaWithoutTestDelta).not.toHaveBeenCalled();
	});

	it("does nothing for a non-Bash tool", () => {
		const pre = allow();
		runTddCommitGate(makeCtx(), ev({ tool_name: "Read" }), makeSession(), pre);
		expect(checkProdDeltaWithoutTestDelta).not.toHaveBeenCalled();
	});

	it("does not treat a non-Bash git commit as a commit gate", () => {
		const pre = allow();
		runTddCommitGate(
			makeCtx(),
			ev({ tool_name: "Read", tool_input: { command: "git commit -m x" } }),
			makeSession(),
			pre,
		);
		expect(parseCommitMessageFromBash).not.toHaveBeenCalled();
		expect(checkProdDeltaWithoutTestDelta).not.toHaveBeenCalled();
	});

	it("does nothing for a Bash command that is not a git commit", () => {
		const pre = allow();
		runTddCommitGate(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "ls -la" } }),
			makeSession(),
			pre,
		);
		expect(checkProdDeltaWithoutTestDelta).not.toHaveBeenCalled();
	});

	it("requires whitespace between git and commit in the command", () => {
		const pre = allow();
		runTddCommitGate(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "git  commit -m x" } }),
			makeSession(),
			pre,
		);
		expect(parseCommitMessageFromBash).toHaveBeenCalledWith("git  commit -m x");
	});

	it("tolerates a missing command (|| '' fallback) without throwing", () => {
		const pre = allow();
		// tool_input present but command absent → regex tests empty string.
		runTddCommitGate(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: {} }),
			makeSession(),
			pre,
		);
		expect(checkProdDeltaWithoutTestDelta).not.toHaveBeenCalled();
		expect(pre.decision).toBe("allow");
	});

	it("passes the actual command to commit-message parsing", () => {
		const pre = allow();
		const command = "git commit -m x";
		runTddCommitGate(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command } }),
			makeSession(),
			pre,
		);
		expect(parseCommitMessageFromBash).toHaveBeenCalledWith(command);
	});

	it("skips the TDD-cycle gate when there are no tdd_cycles, runs the rest", () => {
		const pre = allow();
		const session = makeSession();
		runTddCommitGate(makeCtx(), commitEvent(), session, pre);
		// tdd_cycles.size === 0 → checkTddCommitGate NOT called…
		expect(checkTddCommitGate).not.toHaveBeenCalled();
		// …but the other gates ARE.
		expect(checkProdDeltaWithoutTestDelta).toHaveBeenCalledOnce();
		expect(checkProdTestLocRatio).toHaveBeenCalledOnce();
		expect(checkTppLeapfrog).toHaveBeenCalledOnce();
		expect(checkProdDeltaWithoutTestDelta).toHaveBeenCalledWith(session);
		expect(checkProdTestLocRatio).toHaveBeenCalledWith(session);
		expect(checkTppLeapfrog).toHaveBeenCalledWith(session);
	});

	it("runs the TDD-cycle gate when tdd_cycles is non-empty", () => {
		const pre = allow();
		const session = makeSession({
			tdd_cycles: new Map([["src/a.ts", tddCycle()]]),
		});
		runTddCommitGate(makeCtx(), commitEvent(), session, pre);
		expect(checkTddCommitGate).toHaveBeenCalledOnce();
		expect(checkTddCommitGate).toHaveBeenCalledWith(session, "warn");
	});

	it("passes the configured test_first_mode through to the gate", () => {
		const pre = allow();
		const ctx = makeCtx({
			rules: enforceRules(),
		});
		const session = makeSession({ tdd_cycles: new Map([["x", tddCycle()]]) });
		runTddCommitGate(ctx, commitEvent(), session, pre);
		expect(checkTddCommitGate).toHaveBeenCalledWith(session, "enforce");
	});

	it("aggregates gate warnings into preDecision.warnings (tagged)", () => {
		vi.mocked(checkProdDeltaWithoutTestDelta).mockReturnValue([
			check({ name: "prod_no_test", message: "added prod without test", severity: "warning" }),
		]);
		const pre = allow();
		runTddCommitGate(makeCtx(), commitEvent(), makeSession(), pre);
		expect(pre.warnings).toEqual([
			"[interlinked:prod_no_test] added prod without test",
		]);
		// Still allow — mode defaults to "warn".
		expect(pre.decision).toBe("allow");
	});

	it("appends to a pre-existing warnings array rather than replacing it", () => {
		vi.mocked(checkProdTestLocRatio).mockReturnValue([
			check({ name: "loc_ratio", message: "ratio off" }),
		]);
		const pre: HarnessDecision = { decision: "allow", warnings: ["pre-existing"] };
		runTddCommitGate(makeCtx(), commitEvent(), makeSession(), pre);
		expect(pre.warnings).toEqual(["pre-existing", "[interlinked:loc_ratio] ratio off"]);
	});

	it("does NOT block in enforce mode when no result is severity 'error'", () => {
		vi.mocked(checkProdDeltaWithoutTestDelta).mockReturnValue([
			check({ name: "soft", message: "soft warn", severity: "warning" }),
		]);
		const ctx = makeCtx({
			rules: enforceRules(),
		});
		const pre = allow();
		runTddCommitGate(ctx, commitEvent(), makeSession(), pre);
		expect(pre.decision).toBe("allow");
		expect(pre.reason).toBeUndefined();
	});

	it("blocks in enforce mode when a result is severity 'error'", () => {
		vi.mocked(checkProdTestLocRatio).mockReturnValue([
			check({ name: "hard", message: "failing test present", severity: "error" }),
			check({ name: "soft", message: "ignored in reason", severity: "warning" }),
		]);
		const ctx = makeCtx({
			rules: enforceRules(),
		});
		const pre = allow();
		runTddCommitGate(ctx, commitEvent(), makeSession(), pre);
		expect(pre.decision).toBe("block");
		expect(pre.reason).toContain("BLOCKED: Tests must pass before committing.");
		expect(pre.reason).toContain("failing test present");
		// Only error-severity messages appear in the reason.
		expect(pre.reason).not.toContain("ignored in reason");
	});

	it("forwards the parsed commit message into the coherence check", () => {
		vi.mocked(parseCommitMessageFromBash).mockReturnValue({
			type: "feat", subject: "x",
		});
		const pre = allow();
		const session = makeSession();
		runTddCommitGate(makeCtx(), commitEvent(), session, pre);
		expect(checkConventionalCommitCoherence).toHaveBeenCalledWith(session, {
			type: "feat", subject: "x",
		});
	});

	it("forwards the parsed commit type to the test-block gate", () => {
		vi.mocked(parseCommitMessageFromBash).mockReturnValue({ type: "feat", subject: "x" });
		const session = makeSession();
		runTddCommitGate(makeCtx(), commitEvent(), session, allow());
		expect(checkTestBlockCountRegression).toHaveBeenCalledWith(session, undefined, "feat");
	});

	it("does not manufacture warnings when all commit gates are clean", () => {
		const pre = allow();
		runTddCommitGate(makeCtx(), commitEvent(), makeSession(), pre);
		expect(pre.warnings).toBeUndefined();
	});

	it("does not block an enforce-mode commit for warning-only results", () => {
		vi.mocked(checkProdDeltaWithoutTestDelta).mockReturnValue([
			check({ severity: "warning", message: "warning only" }),
		]);
		const ctx = makeCtx({
			rules: enforceRules(),
		});
		const pre = allow();
		runTddCommitGate(ctx, commitEvent(), makeSession(), pre);
		expect(pre.decision).toBe("allow");
	});

	it("assigns the stable rule id when no rule id is present", () => {
		vi.mocked(checkProdTestLocRatio).mockReturnValue([
			check({ severity: "error", message: "first" }),
			check({ severity: "error", message: "second" }),
		]);
		const ctx = makeCtx({
			rules: enforceRules(),
		});
		const pre: HarnessDecision = { decision: "allow" };
		runTddCommitGate(ctx, commitEvent(), makeSession(), pre);
		expect(pre.rule_id).toBe("commit-test-first-gate");
		expect(pre.reason).toBe("BLOCKED: Tests must pass before committing. first second");
	});
});

// =====================================================================
// runProjectWideGitGate
// =====================================================================

describe("runProjectWideGitGate", () => {
	const commit = () => ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } });
	const push = () => ev({ tool_name: "Bash", tool_input: { command: "git push origin main" } });

	it("does nothing when decision is not 'allow'", () => {
		const pre: HarnessDecision = { decision: "block" };
		runProjectWideGitGate(makeCtx(), commit(), makeSession(), pre);
		expect(checkProjectTypecheckClean).not.toHaveBeenCalled();
	});

	it("does nothing for a non-Bash tool", () => {
		const pre = allow();
		runProjectWideGitGate(makeCtx(), ev({ tool_name: "Edit" }), makeSession(), pre);
		expect(checkProjectTypecheckClean).not.toHaveBeenCalled();
	});

	it("does nothing for a Bash command that is neither commit nor push", () => {
		const pre = allow();
		runProjectWideGitGate(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "git status" } }),
			makeSession(),
			pre,
		);
		expect(checkProjectTypecheckClean).not.toHaveBeenCalled();
	});

	it("does not treat a non-Bash git command as a project-wide gate", () => {
		const pre = allow();
		runProjectWideGitGate(
			makeCtx(),
			ev({ tool_name: "Read", tool_input: { command: "git commit -m x" } }),
			makeSession(),
			pre,
		);
		expect(checkProjectTypecheckClean).not.toHaveBeenCalled();
		expect(checkProjectTestsClean).not.toHaveBeenCalled();
	});

	it("recognizes multiple spaces in git commit and git push commands", () => {
		const commitPre = allow();
		runProjectWideGitGate(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "git  commit -m x" } }),
			makeSession(),
			commitPre,
		);
		expect(checkProjectTypecheckClean).toHaveBeenCalledOnce();
		expect(checkProjectTypecheckClean).toHaveBeenCalledWith("/repo");

		vi.clearAllMocks();
		const pushPre = allow();
		runProjectWideGitGate(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: { command: "git  push origin main" } }),
			makeSession(),
			pushPre,
		);
		expect(checkProjectTypecheckClean).toHaveBeenCalledOnce();
		expect(checkProjectTestsClean).toHaveBeenCalledOnce();
		expect(checkProjectTypecheckClean).toHaveBeenCalledWith("/repo");
		expect(checkProjectTestsClean).toHaveBeenCalledWith("/repo");
	});

	it("runs the typecheck gate on commit and stays clean when no results", () => {
		const pre = allow();
		runProjectWideGitGate(makeCtx(), commit(), makeSession(), pre);
		expect(checkProjectTypecheckClean).toHaveBeenCalledWith("/repo");
		expect(pre.decision).toBe("allow");
		expect(pre.warnings).toBeUndefined();
		// Commit does not run the push-only test tier.
		expect(checkProjectTestsClean).not.toHaveBeenCalled();
	});

	it("appends typecheck WARNING results without blocking", () => {
		vi.mocked(checkProjectTypecheckClean).mockReturnValue([
			check({ name: "tc_warn", message: "slow types", severity: "warning" }),
		]);
		const pre = allow();
		runProjectWideGitGate(makeCtx(), commit(), makeSession(), pre);
		expect(pre.decision).toBe("allow");
		expect(pre.warnings).toEqual(["[interlinked:tc_warn] slow types"]);
	});

	it("appends typecheck warnings onto a pre-existing array", () => {
		vi.mocked(checkProjectTypecheckClean).mockReturnValue([
			check({ name: "tc_warn", message: "w", severity: "warning" }),
		]);
		const pre: HarnessDecision = { decision: "allow", warnings: ["earlier"] };
		runProjectWideGitGate(makeCtx(), commit(), makeSession(), pre);
		expect(pre.warnings).toEqual(["earlier", "[interlinked:tc_warn] w"]);
	});

	it("blocks on typecheck ERROR results (commit wording, singular)", () => {
		vi.mocked(checkProjectTypecheckClean).mockReturnValue([
			check({ name: "tc", message: "TS1005 missing semi", severity: "error" }),
		]);
		const pre = allow();
		runProjectWideGitGate(makeCtx(), commit(), makeSession(), pre);
		expect(pre.decision).toBe("block");
		expect(pre.rule_id).toBe("commit-typecheck-gate"); // stable id — no more null-id blocks
		expect(pre.reason).toContain("BLOCKED: Project typecheck failed (1 error)");
		expect(pre.reason).toContain("CI will fail on this commit.");
		expect(pre.reason).toContain("- TS1005 missing semi");
		expect(pre.reason).toContain("INTERLINKED_SKIP_PROJECT_TYPECHECK=1");
		expect(pre.reason).toContain("Pre-existing errors in untouched files DO count: every commit must build clean. Fix these first:");
		expect(pre.reason).toContain("\n\nTo bypass (NOT RECOMMENDED — CI will still fail on the PR):");
		// No "...and N more" tail with a single error.
		expect(pre.reason).not.toContain("more");
	});

	it("uses 'push' wording + plural + truncation tail when >10 typecheck errors", () => {
		const errs = Array.from({ length: 12 }, (_, i) =>
			check({ name: "tc", message: `err-${i}`, severity: "error" }),
		);
		vi.mocked(checkProjectTypecheckClean).mockReturnValue(errs);
		const pre = allow();
		runProjectWideGitGate(makeCtx(), push(), makeSession(), pre);
		expect(pre.decision).toBe("block");
		expect(pre.reason).toContain("(12 errors)");
		expect(pre.reason).toContain("CI will fail on this push.");
		expect(pre.reason).toContain("err-9");
		// Only first 10 listed, then a tail counting the remainder.
		expect(pre.reason).not.toContain("- err-10");
		expect(pre.reason).toContain("... and 2 more");
		// Block flipped decision away from allow → push test tier is skipped.
		expect(checkProjectTestsClean).not.toHaveBeenCalled();
	});

	it("reports a guard_block to the server bridge when present (typecheck)", () => {
		vi.mocked(checkProjectTypecheckClean).mockReturnValue([
			check({ name: "tc", message: "boom", severity: "error" }),
		]);
		const reportGuardEvent = vi.fn();
		const ctx = makeCtx({
			serverBridge: bridge(reportGuardEvent),
		});
		const pre = allow();
		runProjectWideGitGate(
			ctx,
			ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" }, agent_name: "bob" }),
			makeSession(),
			pre,
		);
		expect(reportGuardEvent).toHaveBeenCalledOnce();
		const arg = reportGuardEvent.mock.calls[0]?.[0];
		expect(arg).toMatchObject({
			agent_name: "bob",
			event_type: "guard_block",
			decision: "block",
			tool_name: "Bash",
			reason: "project_typecheck_clean: 1 error",
			occurred_at: "2026-04-23T00:00:00.000Z",
		});
		// summarizeToolInput (real) used the command.
		expect(arg.tool_input_summary).toBe("git commit -m x");
	});

	it("keeps typecheck errors out of the warning list", () => {
		vi.mocked(checkProjectTypecheckClean).mockReturnValue([
			check({ name: "tc-error", message: "compile failed", severity: "error" }),
		]);
		const pre = allow();
		runProjectWideGitGate(makeCtx(), commit(), makeSession(), pre);
		expect(pre.warnings).toBeUndefined();
	});

	it("reports an empty session agent name without throwing", () => {
		vi.mocked(checkProjectTypecheckClean).mockReturnValue([
			check({ name: "tc", message: "boom", severity: "error" }),
		]);
		const reportGuardEvent = vi.fn();
		const ctx = makeCtx({
			serverBridge: bridge(reportGuardEvent),
		});
		expect(() =>
			runProjectWideGitGate(ctx, commit(), makeSession({ agent_name: "" }), allow()),
		).not.toThrow();
		expect(reportGuardEvent.mock.calls[0]?.[0].agent_name).toBe("");
	});

	it("falls back to session.agent_name then '' when event.agent_name absent", () => {
		vi.mocked(checkProjectTypecheckClean).mockReturnValue([
			check({ name: "tc", message: "boom", severity: "error" }),
		]);
		const reportGuardEvent = vi.fn();
		const ctx = makeCtx({
			serverBridge: bridge(reportGuardEvent),
		});
		runProjectWideGitGate(ctx, commit(), makeSession({ agent_name: "sess-agent" }), allow());
		expect(reportGuardEvent.mock.calls[0]?.[0].agent_name).toBe("sess-agent");
	});

	// ---- Push-only test tier ----

	it("runs the test tier only on push, not commit", () => {
		const pre = allow();
		runProjectWideGitGate(makeCtx(), push(), makeSession(), pre);
		expect(checkProjectTestsClean).toHaveBeenCalledWith("/repo");
		expect(pre.warnings).toBeUndefined();
	});

	it("appends test WARNING results without blocking", () => {
		vi.mocked(checkProjectTestsClean).mockReturnValue([
			check({ name: "test_warn", message: "flaky?", severity: "warning" }),
		]);
		const pre = allow();
		runProjectWideGitGate(makeCtx(), push(), makeSession(), pre);
		expect(pre.decision).toBe("allow");
		expect(pre.warnings).toEqual(["[interlinked:test_warn] flaky?"]);
	});

	it("appends test warnings onto a pre-existing array", () => {
		vi.mocked(checkProjectTestsClean).mockReturnValue([
			check({ name: "tw", message: "w", severity: "warning" }),
		]);
		const pre: HarnessDecision = { decision: "allow", warnings: ["earlier"] };
		runProjectWideGitGate(makeCtx(), push(), makeSession(), pre);
		expect(pre.warnings).toEqual(["earlier", "[interlinked:tw] w"]);
	});

	it("blocks on test ERROR results (singular, no tail)", () => {
		vi.mocked(checkProjectTestsClean).mockReturnValue([
			check({ name: "t", message: "assert failed in a.test.ts", severity: "error" }),
		]);
		const pre = allow();
		runProjectWideGitGate(makeCtx(), push(), makeSession(), pre);
		expect(pre.decision).toBe("block");
		expect(pre.rule_id).toBe("push-test-gate"); // stable id — no more null-id blocks
		expect(pre.reason).toContain("BLOCKED: Project tests failed (1 failure)");
		expect(pre.reason).toContain("assert failed in a.test.ts");
		expect(pre.reason).toContain("INTERLINKED_SKIP_PROJECT_TESTS=1 git push");
		expect(pre.reason).toContain("Pre-existing test failures DO count: every push must build clean. Failing tests:");
		expect(pre.reason).toContain("\n\nTo bypass (NOT RECOMMENDED — CI will still fail on the PR):");
		expect(pre.reason).not.toContain("more");
	});

	it("plural + truncation tail when >10 test errors", () => {
		const errs = Array.from({ length: 11 }, (_, i) =>
			check({ name: "t", message: `fail-${i}`, severity: "error" }),
		);
		vi.mocked(checkProjectTestsClean).mockReturnValue(errs);
		const pre = allow();
		runProjectWideGitGate(makeCtx(), push(), makeSession(), pre);
		expect(pre.reason).toContain("(11 failures)");
		expect(pre.reason).toContain("... and 1 more");
		expect(pre.reason).not.toContain("- fail-10");
	});

	it("does NOT run the test tier if the typecheck gate already blocked the push", () => {
		vi.mocked(checkProjectTypecheckClean).mockReturnValue([
			check({ name: "tc", message: "boom", severity: "error" }),
		]);
		const pre = allow();
		runProjectWideGitGate(makeCtx(), push(), makeSession(), pre);
		expect(pre.decision).toBe("block");
		// Typecheck flipped decision off allow before the push test tier ran.
		expect(checkProjectTestsClean).not.toHaveBeenCalled();
	});

	it("reports a guard_block to the server bridge for test failures", () => {
		vi.mocked(checkProjectTestsClean).mockReturnValue([
			check({ name: "t", message: "x", severity: "error" }),
			check({ name: "t", message: "y", severity: "error" }),
		]);
		const reportGuardEvent = vi.fn();
		const ctx = makeCtx({
			serverBridge: bridge(reportGuardEvent),
		});
		runProjectWideGitGate(ctx, push(), makeSession(), allow());
		expect(reportGuardEvent).toHaveBeenCalledOnce();
		expect(reportGuardEvent.mock.calls[0]?.[0]).toMatchObject({
			event_type: "guard_block",
			reason: "project_tests_clean: 2 failures",
		});
	});

	it("keeps test errors out of the warning list", () => {
		vi.mocked(checkProjectTestsClean).mockReturnValue([
			check({ name: "test-error", message: "failed", severity: "error" }),
		]);
		const pre = allow();
		runProjectWideGitGate(makeCtx(), push(), makeSession(), pre);
		expect(pre.warnings).toBeUndefined();
	});

	it("does not throw when serverBridge is null on a test-failure block", () => {
		vi.mocked(checkProjectTestsClean).mockReturnValue([
			check({ name: "t", message: "x", severity: "error" }),
		]);
		const pre = allow();
		expect(() =>
			runProjectWideGitGate(makeCtx({ serverBridge: null }), push(), makeSession(), pre),
		).not.toThrow();
		expect(pre.decision).toBe("block");
	});

	it("treats a Bash event with no command as neither commit nor push", () => {
		// Exercises the `(command) || ""` fallback when tool_input lacks a command.
		const pre = allow();
		runProjectWideGitGate(
			makeCtx(),
			ev({ tool_name: "Bash", tool_input: {} }),
			makeSession(),
			pre,
		);
		expect(checkProjectTypecheckClean).not.toHaveBeenCalled();
		expect(pre.decision).toBe("allow");
	});

	it("uses 'push' action wording + empty agent_name in the typecheck guard report", () => {
		// Push + typecheck error + bridge, with no event/session agent_name →
		// hits the `"push"` ternary arm and the `|| ""` agent-name fallback.
		vi.mocked(checkProjectTypecheckClean).mockReturnValue([
			check({ name: "tc", message: "boom", severity: "error" }),
		]);
		const reportGuardEvent = vi.fn();
		const ctx = makeCtx({
			serverBridge: bridge(reportGuardEvent),
		});
		const pre = allow();
		runProjectWideGitGate(
			ctx,
			ev({ tool_name: "Bash", tool_input: { command: "git push origin main" } }),
			makeSession({ agent_name: "" }),
			pre,
		);
		expect(pre.reason).toContain("CI will fail on this push.");
		expect(reportGuardEvent.mock.calls[0]?.[0]).toMatchObject({
			agent_name: "",
			reason: "project_typecheck_clean: 1 error",
		});
	});

	it("uses plural 'errors' wording in the typecheck guard report (>1 error + bridge)", () => {
		// Two typecheck errors + bridge → hits the `=== 1 ? "" : "s"` plural arm
		// inside the guard-report reason string.
		vi.mocked(checkProjectTypecheckClean).mockReturnValue([
			check({ name: "tc", message: "e1", severity: "error" }),
			check({ name: "tc", message: "e2", severity: "error" }),
		]);
		const reportGuardEvent = vi.fn();
		const ctx = makeCtx({
			serverBridge: bridge(reportGuardEvent),
		});
		runProjectWideGitGate(ctx, commit(), makeSession(), allow());
		expect(reportGuardEvent.mock.calls[0]?.[0].reason).toBe(
			"project_typecheck_clean: 2 errors",
		);
	});

	it("uses singular 'failure' wording + empty agent_name in the test guard report", () => {
		// Single test error + bridge + no agent_name → hits the `=== 1 ? "" : "s"`
		// singular arm AND the `|| ""` agent-name fallback in the test block.
		vi.mocked(checkProjectTestsClean).mockReturnValue([
			check({ name: "t", message: "only-one", severity: "error" }),
		]);
		const reportGuardEvent = vi.fn();
		const ctx = makeCtx({
			serverBridge: bridge(reportGuardEvent),
		});
		const pre = allow();
		runProjectWideGitGate(ctx, push(), makeSession({ agent_name: "" }), pre);
		expect(reportGuardEvent.mock.calls[0]?.[0]).toMatchObject({
			agent_name: "",
			reason: "project_tests_clean: 1 failure",
		});
	});

	it("uses only bounded async gates on the daemon push path", async () => {
		const pre = allow();
		await runProjectWideGitGateAsync(makeCtx(), push(), makeSession(), pre);
		expect(checkProjectTypecheckCleanAsync).toHaveBeenCalledWith("/repo");
		expect(checkProjectTestsCleanAsync).toHaveBeenCalledWith("/repo", {
			admissionAlreadyHeld: true,
		});
		expect(checkProjectTypecheckClean).not.toHaveBeenCalled();
		expect(checkProjectTestsClean).not.toHaveBeenCalled();
		expect(pre.decision).toBe("allow");
		expect(releaseHeavyProcess).toHaveBeenCalledTimes(1);
	});

	it("defers the whole git gate before spawning work when the project lane is busy", async () => {
		vi.mocked(tryAcquireProjectHeavyProcessLease).mockReturnValueOnce(null);
		const pre = allow();

		await runProjectWideGitGateAsync(makeCtx(), push(), makeSession(), pre);

		expect(checkProjectTypecheckCleanAsync).not.toHaveBeenCalled();
		expect(checkProjectTestsCleanAsync).not.toHaveBeenCalled();
		expect(pre.decision).toBe("allow");
		expect(pre.warnings).toEqual([
			"[interlinked:project_git_gate_deferred] Project-wide typecheck/tests were NOT CHECKED because another heavyweight project check is active. Retry before committing or pushing.",
		]);
	});

	it("surfaces an async test-capacity deferral without claiming clean or blocking", async () => {
		vi.mocked(checkProjectTestsCleanAsync).mockResolvedValue([
			check({
				name: "project_tests_deferred",
				message: "Project tests were NOT CHECKED (busy). Retry before pushing.",
				severity: "warning",
			}),
		]);
		const pre = allow();
		await runProjectWideGitGateAsync(makeCtx(), push(), makeSession(), pre);
		expect(pre.decision).toBe("allow");
		expect(pre.warnings).toEqual([
			"[interlinked:project_tests_deferred] Project tests were NOT CHECKED (busy). Retry before pushing.",
		]);
	});

	it("blocks a push on failures returned by the bounded async test gate", async () => {
		vi.mocked(checkProjectTestsCleanAsync).mockResolvedValue([
			check({ name: "project_tests_clean", message: "suite > failure", severity: "error" }),
		]);
		const pre = allow();
		await runProjectWideGitGateAsync(makeCtx(), push(), makeSession(), pre);
		expect(pre.decision).toBe("block");
		expect(pre.rule_id).toBe("push-test-gate");
		expect(pre.reason).toContain("suite > failure");
	});
});

// =====================================================================
// captureDiffAwareBaseline
// =====================================================================

describe("captureDiffAwareBaseline", () => {
	it("skips when diff_aware is explicitly disabled", () => {
		const ctx = makeCtx({
			rules: { ...makeGuardRules(), diff_aware: { enabled: false } },
		});
		captureDiffAwareBaseline(ctx, ev({ tool_name: "Edit" }), "src/a.ts");
		expect(ctx.preEditBaselines.size).toBe(0);
		expect(mReadFile).not.toHaveBeenCalled();
	});

	it("captures when diff_aware is undefined (default-on, !== false)", () => {
		const ctx = makeCtx({ rules: makeGuardRules() });
		captureDiffAwareBaseline(ctx, ev({ tool_name: "Edit" }), "src/a.ts");
		expect(ctx.preEditBaselines.size).toBe(1);
	});

	it("skips when filePath is empty", () => {
		const ctx = makeCtx();
		captureDiffAwareBaseline(ctx, ev({ tool_name: "Edit" }), "");
		expect(ctx.preEditBaselines.size).toBe(0);
	});

	it("skips for a non-file-write tool even if the file exists", () => {
		const ctx = makeCtx();
		captureDiffAwareBaseline(ctx, ev({ tool_name: "Read" }), "src/a.ts");
		expect(ctx.preEditBaselines.size).toBe(0);
		expect(mReadFile).not.toHaveBeenCalled();
	});

	it("skips when the target file does not exist on disk", () => {
		mExists.mockReturnValue(false);
		const ctx = makeCtx();
		captureDiffAwareBaseline(ctx, ev({ tool_name: "Write" }), "src/a.ts");
		expect(ctx.preEditBaselines.size).toBe(0);
		expect(mReadFile).not.toHaveBeenCalled();
	});

	it("tolerates a missing tool_name (|| '' fallback) → not a file write", () => {
		const ctx = makeCtx();
		captureDiffAwareBaseline(ctx, ev({}), "src/a.ts");
		expect(ctx.preEditBaselines.size).toBe(0);
	});

	it("resolves a relative path against cwd before stat/read", () => {
		const ctx = makeCtx();
		captureDiffAwareBaseline(ctx, ev({ tool_name: "Edit" }), "src/a.ts");
		// Keyed by the resolved absolute path.
		expect([...ctx.preEditBaselines.keys()]).toEqual(["/repo/src/a.ts"]);
		expect(mReadFile).toHaveBeenCalledWith("/repo/src/a.ts", "utf-8");
	});

	it("uses an absolute path as-is (no re-resolution)", () => {
		const ctx = makeCtx();
		captureDiffAwareBaseline(ctx, ev({ tool_name: "Write" }), "/abs/b.ts");
		expect([...ctx.preEditBaselines.keys()]).toEqual(["/abs/b.ts"]);
	});

	it("fires for every recognised file-write tool alias", () => {
		const aliases = [
			"Write",
			"Edit",
			"Update",
			"WriteFile",
			"EditFile",
			"write_file",
			"edit_file",
		];
		for (const tool of aliases) {
			const ctx = makeCtx();
			captureDiffAwareBaseline(ctx, ev({ tool_name: tool }), "src/a.ts");
			expect(ctx.preEditBaselines.size, tool).toBe(1);
		}
	});

	// --- F2: apply_patch carries no top-level file_path; resolve from the body ---

	it("captures a baseline for an apply_patch target file (no top-level file_path)", () => {
		const ctx = makeCtx();
		const patch = "*** Begin Patch\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** End Patch";
		captureDiffAwareBaseline(
			ctx,
			ev({ tool_name: "apply_patch", tool_input: { command: patch } }),
			"",
		);
		expect([...ctx.preEditBaselines.keys()]).toEqual(["/repo/src/x.ts"]);
	});

	it("captures baselines for every file in a multi-file apply_patch", () => {
		const ctx = makeCtx();
		const patch =
			"*** Begin Patch\n" +
			"*** Update File: src/x.ts\n@@\n-a\n+b\n" +
			"*** Update File: src/y.ts\n@@\n-c\n+d\n" +
			"*** End Patch";
		captureDiffAwareBaseline(
			ctx,
			ev({ tool_name: "apply_patch", tool_input: { command: patch } }),
			"",
		);
		expect([...ctx.preEditBaselines.keys()].sort()).toEqual([
			"/repo/src/x.ts",
			"/repo/src/y.ts",
		]);
	});

	it("populates the baseline from the per-content counters (sentinels flow through)", () => {
		const ctx = makeCtx();
		vi.mocked(checkMissingReturnTypes).mockReturnValue([
			{ line: 1, text: "fn a()" },
			{ line: 1, text: "fn b()" },
		]);
		vi.mocked(checkFunctionComplexity).mockReturnValue([{ line: 1, text: "fn c()" }]);
		captureDiffAwareBaseline(ctx, ev({ tool_name: "Edit" }), "src/a.ts");
		const baseline = ctx.preEditBaselines.get("/repo/src/a.ts");
		expect(baseline).toBeDefined();
		expect(baseline?.missingReturnTypes).toEqual(new Set(["fn a()", "fn b()"]));
		expect(baseline?.complexFunctions).toEqual(new Set(["fn c()"]));
		// Sentinels from the mocked quality-checks counters.
		expect(baseline?.suppressionCount).toBe(5);
		expect(baseline?.asAnyCastCount).toBe(1);
		expect(baseline?.nonNullAssertionCount).toBe(3);
		expect(baseline?.todoMarkerCount).toBe(6);
		expect(baseline?.consoleStatementCount).toBe(2);
		expect(baseline?.publicApiSurfaceCount).toBe(4);
		expect(baseline?.typeDensity).toEqual({ value: 7 });
		expect(baseline?.discoveredPrimitiveViolations).toEqual({});
		expect(baseline?.ambientSeams).toEqual({ clock: 9, random: 10, env: 11 });
		expect(baseline?.assertionStrength).toEqual({ weak: 12, exact: 13 });
		expect(typeof baseline?.capturedAt).toBe("number");
		// Coverage absent → CRAP fail-open leaves crapScores undefined.
		expect(baseline?.crapScores).toBeUndefined();
		expect(checkMissingReturnTypes).toHaveBeenCalledWith("pre-edit content", "/repo/src/a.ts");
	});

	it("captures the CRAP snapshot when coverage data is present", () => {
		const crap = new Map([["src/a.ts", new Map([["fn@1", 42]])]]);
		vi.mocked(loadCoverageFinal).mockReturnValue(coverageCache);
		vi.mocked(coverageForFile).mockReturnValue(fileCoverage);
		vi.mocked(snapshotCrap).mockReturnValue(crap);
		const ctx = makeCtx();
		captureDiffAwareBaseline(ctx, ev({ tool_name: "Edit" }), "src/a.ts");
		const baseline = ctx.preEditBaselines.get("/repo/src/a.ts");
		expect(baseline?.crapScores).toBe(crap);
		expect(loadCoverageFinal).toHaveBeenCalledWith("/repo/coverage/coverage-final.json", "/repo");
		expect(coverageForFile).toHaveBeenCalledWith(
			coverageCache,
			"src/a.ts",
		);
		// snapshotCrap got the resolved coverage + mtime + threshold.
		expect(snapshotCrap).toHaveBeenCalledWith(
			expect.objectContaining({
				filePath: "src/a.ts",
				fileMtime: 12345,
				threshold: 30,
			}),
		);
	});

	it("fails open (crapScores undefined) when the CRAP snapshot throws", () => {
		vi.mocked(loadCoverageFinal).mockReturnValue(coverageCache);
		vi.mocked(coverageForFile).mockReturnValue(fileCoverage);
		vi.mocked(snapshotCrap).mockImplementation(() => {
			throw new Error("crap boom");
		});
		const ctx = makeCtx();
		// Whole capture must still succeed.
		expect(() =>
			captureDiffAwareBaseline(ctx, ev({ tool_name: "Edit" }), "src/a.ts"),
		).not.toThrow();
		const baseline = ctx.preEditBaselines.get("/repo/src/a.ts");
		expect(baseline).toBeDefined();
		expect(baseline?.crapScores).toBeUndefined();
	});

	it("fails open (dryCloneBaseline undefined) when the clone snapshot throws", () => {
		vi.mocked(snapshotDryShingles).mockImplementation(() => {
			throw new Error("dry boom");
		});
		const ctx = makeCtx();
		expect(() =>
			captureDiffAwareBaseline(ctx, ev({ tool_name: "Edit" }), "src/a.ts"),
		).not.toThrow();
		const baseline = ctx.preEditBaselines.get("/repo/src/a.ts");
		expect(baseline).toBeDefined();
		expect(baseline?.dryCloneBaseline).toBeUndefined();
	});

	it("stores the clone baseline when the snapshot succeeds", () => {
		const dry = new Map([["sig", new Map([["x", 1]])]]);
		vi.mocked(snapshotDryShingles).mockReturnValue(dry);
		const ctx = makeCtx();
		captureDiffAwareBaseline(ctx, ev({ tool_name: "Edit" }), "src/a.ts");
		expect(ctx.preEditBaselines.get("/repo/src/a.ts")?.dryCloneBaseline).toBe(dry);
		expect(snapshotDryShingles).toHaveBeenCalledWith({
			preContent: "pre-edit content",
			filePath: "/repo/src/a.ts",
			candidates: [],
		});
	});

	it("fails open (no baseline stored) when readFileSync throws", () => {
		mReadFile.mockImplementation(() => {
			throw new Error("read boom");
		});
		const ctx = makeCtx();
		expect(() =>
			captureDiffAwareBaseline(ctx, ev({ tool_name: "Edit" }), "src/a.ts"),
		).not.toThrow();
		expect(ctx.preEditBaselines.size).toBe(0);
	});
});

// =====================================================================
// injectStructureContext
// =====================================================================

describe("injectStructureContext", () => {
	const editEvent = () => ev({ tool_name: "Edit" });

	function pendingStruct(over: Partial<{
		description: string;
		affected: string[];
		resolved: string[];
	}> = {}) {
		const description = over.description ?? "rename foo()";
		const affected = over.affected ?? ["a.ts", "b.ts"];
		const resolved = over.resolved ?? [];
		return {
			source_file: "src/foo.ts",
			affected_files: affected,
			resolved_files: new Set(resolved),
			recorded_at_tool_call: 1,
			description,
		};
	}

	it("does nothing when filePath is empty", () => {
		const pre = allow();
		injectStructureContext(makeCtx(), editEvent(), makeSession(), pre, "");
		expect(loadStructureConfig).not.toHaveBeenCalled();
		expect(pre.warnings).toBeUndefined();
	});

	it("does nothing for a non-file-write tool", () => {
		const pre = allow();
		injectStructureContext(makeCtx(), ev({ tool_name: "Read" }), makeSession(), pre, "src/a.ts");
		expect(loadStructureConfig).not.toHaveBeenCalled();
	});

	it("does nothing when tool_name is absent (|| '' fallback misses the allow-list)", () => {
		const pre = allow();
		injectStructureContext(makeCtx(), ev({}), makeSession(), pre, "src/a.ts");
		expect(loadStructureConfig).not.toHaveBeenCalled();
		expect(pre.warnings).toBeUndefined();
	});

	it("loads structure config for a file-write tool", () => {
		const pre = allow();
		injectStructureContext(makeCtx(), editEvent(), makeSession(), pre, "src/a.ts");
		// findProjectRoot (mocked) returns cwd → config loaded for "/repo".
		expect(loadStructureConfig).toHaveBeenCalledWith("/repo");
	});

	it("emits no warning when config is null (implicit mode)", () => {
		const pre = allow();
		const session = makeSession({
			pending_completions: new Map([["struct:1", pendingStruct()]]),
		});
		injectStructureContext(makeCtx(), editEvent(), session, pre, "src/a.ts");
		expect(pre.warnings).toBeUndefined();
	});

	it("ignores pending_completions whose key is not a struct: follow-up", () => {
		vi.mocked(loadStructureConfig).mockReturnValue({
			config: resolveStructureConfig({ version: 1, mode: "strict" }),
			errors: [],
			implicit: false,
		});
		const session = makeSession({
			pending_completions: new Map([["export:1", pendingStruct()]]),
		});
		const pre = allow();
		injectStructureContext(makeCtx(), editEvent(), session, pre, "src/a.ts");
		expect(pre.warnings).toBeUndefined();
	});

	it("emits no warning when all affected files are already resolved", () => {
		vi.mocked(loadStructureConfig).mockReturnValue({
			config: resolveStructureConfig({ version: 1, mode: "strict" }),
			errors: [],
			implicit: false,
		});
		const session = makeSession({
			pending_completions: new Map([
				["struct:1", pendingStruct({ affected: ["a.ts"], resolved: ["a.ts"] })],
			]),
		});
		const pre = allow();
		injectStructureContext(makeCtx(), editEvent(), session, pre, "src/a.ts");
		expect(pre.warnings).toBeUndefined();
	});

	it("emits a structure warning listing unresolved companion files", () => {
		vi.mocked(loadStructureConfig).mockReturnValue({
			config: resolveStructureConfig({ version: 1, mode: "strict" }),
			errors: [],
			implicit: false,
		});
		const session = makeSession({
			pending_completions: new Map([
				[
					"struct:1",
					pendingStruct({
						description: "rename foo()",
						affected: ["a.ts", "b.ts"],
						resolved: ["a.ts"],
					}),
				],
			]),
		});
		const pre = allow();
		injectStructureContext(makeCtx(), editEvent(), session, pre, "src/a.ts");
		expect(pre.warnings).toHaveLength(1);
		expect(pre.warnings?.[0]).toContain("[interlinked:structure]");
		expect(pre.warnings?.[0]).toContain("rename foo(): b.ts");
		// Resolved file is not listed.
		expect(pre.warnings?.[0]).not.toContain("a.ts,");
	});

	it("appends the structure warning onto a pre-existing warnings array", () => {
		vi.mocked(loadStructureConfig).mockReturnValue({
			config: resolveStructureConfig({ version: 1, mode: "strict" }),
			errors: [],
			implicit: false,
		});
		const session = makeSession({
			pending_completions: new Map([
				["struct:1", pendingStruct({ affected: ["b.ts"], resolved: [] })],
			]),
		});
		const pre: HarnessDecision = { decision: "allow", warnings: ["earlier"] };
		injectStructureContext(makeCtx(), editEvent(), session, pre, "src/a.ts");
		expect(pre.warnings?.[0]).toBe("earlier");
		expect(pre.warnings?.[1]).toContain("[interlinked:structure]");
	});

	it("aggregates multiple unresolved struct: completions into one warning", () => {
		vi.mocked(loadStructureConfig).mockReturnValue({
			config: resolveStructureConfig({ version: 1, mode: "strict" }),
			errors: [],
			implicit: false,
		});
		const session = makeSession({
			pending_completions: new Map([
				["struct:1", pendingStruct({ description: "d1", affected: ["x.ts"] })],
				["struct:2", pendingStruct({ description: "d2", affected: ["y.ts"] })],
			]),
		});
		const pre = allow();
		injectStructureContext(makeCtx(), editEvent(), session, pre, "src/a.ts");
		expect(pre.warnings).toHaveLength(1);
		expect(pre.warnings?.[0]).toContain("d1: x.ts");
		expect(pre.warnings?.[0]).toContain("d2: y.ts");
		expect(pre.warnings?.[0]).toBe(
			"[interlinked:structure] Unresolved companion follow-ups from previous edits:\n  - d1: x.ts\n  - d2: y.ts",
		);
	});

	it("separates multiple unresolved companion files with commas", () => {
		vi.mocked(loadStructureConfig).mockReturnValue({
			config: resolveStructureConfig({ version: 1, mode: "strict" }),
			errors: [],
			implicit: false,
		});
		const session = makeSession({
			pending_completions: new Map([
				[
					"struct:1",
					pendingStruct({ affected: ["a.ts", "b.ts", "c.ts"], resolved: ["a.ts"] }),
				],
			]),
		});
		const pre = allow();
		injectStructureContext(makeCtx(), editEvent(), session, pre, "src/a.ts");
		expect(pre.warnings?.[0]).toContain("rename foo(): b.ts, c.ts");
	});

	it("falls back to cwd when findProjectRoot returns null", async () => {
		const qc = await import("../quality-checks.js");
		vi.mocked(qc.findProjectRoot).mockReturnValue(null);
		const pre = allow();
		injectStructureContext(makeCtx(), editEvent(), makeSession(), pre, "src/a.ts");
		expect(loadStructureConfig).toHaveBeenCalledWith("/repo");
	});

	it("fails open (no warning, no throw) when loadStructureConfig throws", () => {
		vi.mocked(loadStructureConfig).mockImplementation(() => {
			throw new Error("structure boom");
		});
		const pre = allow();
		expect(() =>
			injectStructureContext(makeCtx(), editEvent(), makeSession(), pre, "src/a.ts"),
		).not.toThrow();
		expect(pre.warnings).toBeUndefined();
	});
});
