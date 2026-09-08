import { readJsonRecord, jsonRecords } from "./__tests__/json.js";
import { makeServerRuntime } from "./__tests__/fixtures.js";
import { makeGuardRules } from "../evaluator/__tests__/fixtures.js";
import { getDefaultConfig } from "../rules-loader.js";
import { buildTestIndex } from "../__tests__/fixtures/trigram.js";
import { createClassifierSessionState } from "../policy-classifier.js";
import { createAutoCoordinationState } from "../auto-coordinate.js";
import type { CohortAgent, TurnEndSummary } from "../types.js";
import type { CapturedPlan } from "../types/plan.js";
import type { FilePriority } from "../file-priority.js";
import { makeSession as makeSessionFixture } from "../__tests__/fixtures/evaluator.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { CohortManager } from "../cohort.js";
import { SessionTracker } from "../session-state.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import { rememberWorkspaceSnapshot } from "../workspace-effects.js";
import { handleLifecycleEvent, resolveParentSessionId } from "./lifecycle-events.js";
import type { ServerRuntime } from "./runtime-context.js";

// ─────────────────────────────────────────────────────────────────────────
// Helper-module mocks for the BEHAVIORAL branch suites appended at the bottom
// of this file.
//
// These mocks are hoisted to module top by vitest. They cover ONLY the
// imported helper modules that lifecycle-events delegates to — deliberately
// NOT `../cohort.js` / `../session-state.js` / `../session-paths.js`, which
// the real-collaborator suites above depend on (and which the behavioral
// suites also drive for real, asserting effects rather than calls).
//
// `node:fs/promises` is mocked so the trajectory-write path runs without disk
// I/O; the sync `node:fs` primitives used by the tmpdir fixtures above come
// from a different module and are untouched.
// ─────────────────────────────────────────────────────────────────────────
vi.mock("node:fs/promises", () => ({
	mkdir: vi.fn(async () => undefined),
	writeFile: vi.fn(async () => undefined),
}));
vi.mock("../../lib/settings-validator.js", () => ({
	autoStripAllScopes: vi.fn(() => ({ totalStripped: 0, entries: [] })),
	defaultStripAuditLogPath: vi.fn(() => "/repo/.interlinked/permission-rule-strips.jsonl"),
	describeReason: vi.fn((r: string) => `reason:${r}`),
}));
vi.mock("../recurrence.js", () => ({
	recordHarnessMissed: vi.fn(),
}));
vi.mock("./agent-event-capture.js", () => ({
	captureAgentEvent: vi.fn(),
}));
vi.mock("../gate-reach-collect.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../gate-reach-collect.js")>();
	return {
		...actual,
		buildGateReachStopWarning: vi.fn(actual.buildGateReachStopWarning),
	};
});
vi.mock("./stop-nudge-throttle.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./stop-nudge-throttle.js")>();
	return { ...actual, suppressRepeatedNudges: vi.fn(actual.suppressRepeatedNudges) };
});
vi.mock("./session-end-batch.js", () => ({
	runSessionEndJobs: vi.fn(),
	runSessionEndResourcePlan: vi.fn(() => ({
		maxJobs: 1,
		background: false,
		commandPrefix: "",
		defer: false,
		reason: "test",
	})),
}));
vi.mock("./session-end-heavy-jobs.js", () => ({
	runSessionEndHeavyJobs: vi.fn(),
}));
vi.mock("../content-scanner/prompt-scan.js", () => ({
	// scanUserPrompt resolves to `PromptScanResult | undefined` (never null);
	// `undefined` is the "no spans found" signal the SUT branches on.
	scanUserPrompt: vi.fn(async () => undefined),
}));
vi.mock("../plan-drift.js", () => ({
	detectPlanDrift: vi.fn(() => null),
	formatPlanDriftWarning: vi.fn(() => null),
}));
vi.mock("../evaluator/pre-tool.js", () => ({
	resetProjectSetupWarningsCache: vi.fn(),
}));
vi.mock("../feedback-effectiveness.js", () => ({
	computeEffectivenessSummary: vi.fn(() => ({ summary: "fx" })),
}));
vi.mock("../file-priority.js", () => ({
	refreshPriorityIfStale: vi.fn(() => new Map()),
}));
vi.mock("../grep-accelerator.js", () => ({
	findRipgrep: vi.fn(() => "/usr/bin/rg"),
}));
vi.mock("../live-snapshot.js", () => ({
	deleteLiveSnapshot: vi.fn(),
}));
vi.mock("../plan-capture.js", () => ({
	maybeCaptureFromPreToolUse: vi.fn(async () => null),
	maybeCaptureFromUserPromptSubmit: vi.fn(async () => null),
}));
vi.mock("../sequence-checks/index.js", () => ({
	formatSequenceFinding: vi.fn((f: unknown) => `seq:${JSON.stringify(f)}`),
	runSequenceDetectorsForPhase: vi.fn(() => []),
}));
vi.mock("../stop-rescan.js", () => ({
	buildPatternRescanWarnings: vi.fn(() => []),
}));
vi.mock("../turn-end.js", () => ({
	buildTurnEndSummary: vi.fn(() => ({ turn_patterns: [] })),
	formatTurnEndWarnings: vi.fn(() => []),
}));
vi.mock("./lifecycle-stop-warnings.js", () => ({
	buildCommitCadenceNudge: vi.fn(() => null),
	buildStaleBaselineNudge: vi.fn(() => null),
	buildVerificationStopWarnings: vi.fn(() => []),
}));
// Partial mock: keep the REAL sanitizeSessionId for every test (the
// real-collaborator suites and the happy-path trajectory write rely on its
// genuine charset whitelisting), but make it overridable so the
// defense-in-depth containment-throw branch — which the real sanitizer can
// never reach by construction — can be forced in one targeted test.
vi.mock("../session-paths.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../session-paths.js")>();
	return { ...actual, sanitizeSessionId: vi.fn(actual.sanitizeSessionId) };
});

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-lc-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "SessionStart",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		...partial,
	};
}

function makeCtx(over: Partial<ServerRuntime> = {}): ServerRuntime {
 return makeServerRuntime({ cwd: tmp, ...over });
}

describe("resolveParentSessionId", () => {
	it("returns undefined when no parent linkage is present", () => {
		const cohort = new CohortManager();
		const sessions = new SessionTracker();
		expect(
			resolveParentSessionId(ev({ hook_event: "SubagentStop" }), cohort, sessions),
		).toBeUndefined();
	});

	it("resolves the parent session_id directly when the linkage is a session id", () => {
		const cohort = new CohortManager();
		const sessions = new SessionTracker();
		sessions.recordEvent(ev({ session_id: "parent-sess" }));
		const out = resolveParentSessionId(
			ev({
				hook_event: "SubagentStop",
				tool_input: { parent_agent: "parent-sess" },
			}),
			cohort,
			sessions,
		);
		expect(out).toBe("parent-sess");
	});

	it("maps a parent agent name back to its session id via the cohort", () => {
		const cohort = new CohortManager();
		const sessions = new SessionTracker();
		cohort.agentJoined(ev({ session_id: "p-sess", agent_name: "parent-agent" }));
		sessions.recordEvent(ev({ session_id: "p-sess", agent_name: "parent-agent" }));
		const out = resolveParentSessionId(
			ev({ hook_event: "SubagentStop", parent_agent: "parent-agent" }),
			cohort,
			sessions,
		);
		expect(out).toBe("p-sess");
	});
});

describe("handleLifecycleEvent", () => {
	it("returns null (fall-through) for SubagentStart", async () => {
		const ctx = makeCtx();
		const session = ctx.sessions.recordEvent(ev({ hook_event: "SubagentStart" }));
		const out = await handleLifecycleEvent(
			ctx,
			ev({ hook_event: "SubagentStart" }),
			session,
		);
		expect(out).toBeNull();
	});

	it("surfaces SessionEnd fuzz-smoke failures at SessionStart", async () => {
		const dir = join(tmp, ".interlinked", "fuzz-reports");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "prev.json"),
			JSON.stringify({ numFailedTests: 1, testResults: [{ status: "failed", name: "p.test.ts" }] }),
		);
		const ctx = makeCtx();
		const session = ctx.sessions.recordEvent(ev({ hook_event: "SessionStart" }));
		const out = await handleLifecycleEvent(ctx, ev({ hook_event: "SessionStart" }), session);
		expect(out?.warnings?.some((w) => w.includes("[interlinked:fuzz]"))).toBe(true);
		expect(mRecordHarnessMissed).toHaveBeenCalledWith(
			expect.objectContaining({
				signature: "fuzz_smoke_failure",
				check_id: "fuzz_smoke",
				cwd: tmp,
			}),
		);
	});

	it("returns null (fall-through) for an unrecognized non-tool event", async () => {
		const ctx = makeCtx();
		const session = ctx.sessions.recordEvent(ev({ hook_event: "Notification" }));
		const out = await handleLifecycleEvent(
			ctx,
			ev({ hook_event: "Notification" }),
			session,
		);
		expect(out).toBeNull();
	});

	it("SkillList returns an allow decision with JSON additional_context", async () => {
		const ctx = makeCtx();
		const session = ctx.sessions.recordEvent(ev({ hook_event: "SkillList" }));
		const out = await handleLifecycleEvent(
			ctx,
			ev({ hook_event: "SkillList" }),
			session,
		);
		expect(out?.decision).toBe("allow");
		expect(() => JSON.parse(out?.additional_context ?? "")).not.toThrow();
	});

	it("SkillEnter without a name returns an allow decision carrying a warning", async () => {
		const ctx = makeCtx();
		const session = ctx.sessions.recordEvent(ev({ hook_event: "SkillEnter" }));
		const out = await handleLifecycleEvent(
			ctx,
			ev({ hook_event: "SkillEnter", tool_input: {} }),
			session,
		);
		expect(out?.decision).toBe("allow");
		expect(out?.warnings?.[0]).toMatch(/missing tool_input\.name/);
	});

	it("SessionEnd returns an allow decision and removes the session", async () => {
		const drain = vi.fn(async () => undefined);
		const ctx = makeCtx();
		vi.spyOn(ctx.asyncAnalysis, "drain").mockImplementation(drain);
		const session = ctx.sessions.recordEvent(ev({ hook_event: "SessionEnd" }));
		const out = await handleLifecycleEvent(
			ctx,
			ev({ hook_event: "SessionEnd" }),
			session,
		);
		expect(out?.decision).toBe("allow");
		expect(ctx.sessions.get("s")).toBeUndefined();
		expect(drain).not.toHaveBeenCalled();
		expect(readFileSync(join(tmp, ".interlinked", "evidence", "s.json"), "utf8")).toContain(
			'"session_id": "s"',
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL BRANCH SUITES (mocked-helper style)
//
// The real-collaborator suites above pin the high-level contracts and the
// lifecycle behavior. The suites below exercise
// each lifecycle handler — file-priority refresh, trigram refresh,
// permission-rule auto-strip, the full Stop reflection/persist/cleanup chain,
// the content-scanner + plan-capture arms of UserPromptSubmit, subagent
// roll-ups, skill enter/leave/list broadcast vs scoped, and the
// persistSessionTrajectory error/containment branches — using the helper
// mocks declared at the top of this file.
// ═══════════════════════════════════════════════════════════════════════════

import { mkdir, writeFile } from "node:fs/promises";
import {
	autoStripAllScopes,
	defaultStripAuditLogPath,
} from "../../lib/settings-validator.js";
import { recordHarnessMissed } from "../recurrence.js";
import { captureAgentEvent } from "./agent-event-capture.js";
import { buildGateReachStopWarning } from "../gate-reach-collect.js";
import { scanUserPrompt } from "../content-scanner/prompt-scan.js";
import { resetProjectSetupWarningsCache } from "../evaluator/pre-tool.js";
import { refreshPriorityIfStale } from "../file-priority.js";
import { findRipgrep } from "../grep-accelerator.js";
import { deleteLiveSnapshot } from "../live-snapshot.js";
import {
	maybeCaptureFromPreToolUse,
	maybeCaptureFromUserPromptSubmit,
} from "../plan-capture.js";
import { detectPlanDrift, formatPlanDriftWarning } from "../plan-drift.js";
import { runSequenceDetectorsForPhase } from "../sequence-checks/index.js";
import { sanitizeSessionId } from "../session-paths.js";
import { buildPatternRescanWarnings } from "../stop-rescan.js";
import { buildTurnEndSummary, formatTurnEndWarnings } from "../turn-end.js";
import {
	buildCommitCadenceNudge,
	buildStaleBaselineNudge,
	buildVerificationStopWarnings,
} from "./lifecycle-stop-warnings.js";
import {
	runSessionEndJobs,
	runSessionEndResourcePlan,
} from "./session-end-batch.js";
import { runSessionEndHeavyJobs } from "./session-end-heavy-jobs.js";
import { suppressRepeatedNudges } from "./stop-nudge-throttle.js";
import { peekTrajectoryState, trajectoryShadowWarnings } from "./trajectory-shadow.js";

const mMkdir = vi.mocked(mkdir);
const mWriteFile = vi.mocked(writeFile);
const mAutoStrip = vi.mocked(autoStripAllScopes);
const mDefaultAudit = vi.mocked(defaultStripAuditLogPath);
const mScanUserPrompt = vi.mocked(scanUserPrompt);
const mResetSetupCache = vi.mocked(resetProjectSetupWarningsCache);
const mRefreshPriority = vi.mocked(refreshPriorityIfStale);
const mFindRipgrep = vi.mocked(findRipgrep);
const mDeleteSnapshot = vi.mocked(deleteLiveSnapshot);
const mCapturePre = vi.mocked(maybeCaptureFromPreToolUse);
const mCaptureUser = vi.mocked(maybeCaptureFromUserPromptSubmit);
const mDetectPlanDrift = vi.mocked(detectPlanDrift);
const mFormatPlanDrift = vi.mocked(formatPlanDriftWarning);
const mRunSeq = vi.mocked(runSequenceDetectorsForPhase);
const mBuildRescan = vi.mocked(buildPatternRescanWarnings);
const mBuildTurnSummary = vi.mocked(buildTurnEndSummary);
const mFormatTurnEnd = vi.mocked(formatTurnEndWarnings);
const mBuildCadence = vi.mocked(buildCommitCadenceNudge);
const mBuildStaleBaseline = vi.mocked(buildStaleBaselineNudge);
const mBuildVsc = vi.mocked(buildVerificationStopWarnings);
const mSanitize = vi.mocked(sanitizeSessionId);
const mRecordHarnessMissed = vi.mocked(recordHarnessMissed);
const mCaptureAgentEvent = vi.mocked(captureAgentEvent);
const mBuildGateReach = vi.mocked(buildGateReachStopWarning);
const mRunSessionEndJobs = vi.mocked(runSessionEndJobs);
const mRunSessionEndResourcePlan = vi.mocked(runSessionEndResourcePlan);
const mRunSessionEndHeavyJobs = vi.mocked(runSessionEndHeavyJobs);
const mSuppressRepeatedNudges = vi.mocked(suppressRepeatedNudges);

const bLog: string[] = [];
const bLogAlways: string[] = [];

function bCohort(over: Partial<CohortManager> = {}): CohortManager {
 const cohort = new CohortManager();
 vi.spyOn(cohort, "agentJoined").mockImplementation(() => agent());
 vi.spyOn(cohort, "agentLeft").mockImplementation(() => {});
 vi.spyOn(cohort, "subagentJoined").mockImplementation(() => agent());
 vi.spyOn(cohort, "subagentLeft").mockImplementation(() => {});
 vi.spyOn(cohort, "recordActivity").mockImplementation(() => {});
 vi.spyOn(cohort, "findAgentByIdentity").mockReturnValue(undefined);
 return Object.assign(cohort, over);
}

function bSessions(over: Partial<SessionTracker> = {}): SessionTracker {
 const sessions = new SessionTracker();
 vi.spyOn(sessions, "get").mockReturnValue(undefined);
 vi.spyOn(sessions, "getAll").mockReturnValue([]);
 vi.spyOn(sessions, "remove").mockImplementation(() => {});
 vi.spyOn(sessions, "serialize").mockReturnValue(null);
 vi.spyOn(sessions, "rollUpVerificationSignals").mockReturnValue(false);
 vi.spyOn(sessions, "rollUpFileTracking").mockReturnValue(false);
 return Object.assign(sessions, over);
}

function bCtx(over: Partial<ServerRuntime> = {}): ServerRuntime {
 const ctx = makeServerRuntime({ cwd: "/repo", cohort: bCohort(), sessions: bSessions(),
  log: m => bLog.push(m), logAlways: m => bLogAlways.push(m), ...over });
 vi.spyOn(ctx.asyncFindings, "clearSession");
 return ctx;
}

function bEvent(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "SessionStart",
		session_id: "s1",
		agent_source: "claude",
		timestamp: "2026-06-05T00:00:00.000Z",
		...over,
	};
}

function bSession(over: Partial<SessionTrajectory> = {}): SessionTrajectory {
	// files_written non-empty by default: gate-reach only reports for sessions
	// that wrote something, and most Stop-path tests assume an editing session.
	return ({ ...makeSessionFixture(),
		session_id: "s1",
		agent_name: "agent-a",
		files_written: new Set(["src/a.ts"]),
		...over,
	} satisfies SessionTrajectory);
}

function agent(over: Partial<CohortAgent> = {}): CohortAgent {
 return { name: "agent", session_id: "s1", source: "claude", status: "active", joined_at: "2026-06-05T00:00:00.000Z", last_event_at: "2026-06-05T00:00:00.000Z", files_reserved: [], ...over };
}
function summary(turn_patterns: string[] = []): TurnEndSummary {
 return { session_id: "s1", agent_name: "agent-a", tool_call_count: 0, files_written: [], files_read: [], commands_run: [], warning_count: 0, block_count: 0, turn_patterns, sensitivity_level: "Public", turn_duration_ms: 0 };
}
function captured(source: CapturedPlan["source"], intents: string[]): CapturedPlan {
 return { source, session_id: "s1", agent_name: "agent-a", created_at_iso: "2026-06-05T00:00:00.000Z", created_at_step: 0, steps: intents.map(intent => ({ intent, status: "pending" })) };
}
function trigram(update: NonNullable<ServerRuntime["trigramIndex"]>["incrementalUpdate"]): NonNullable<ServerRuntime["trigramIndex"]> {
 const index = buildTestIndex({});
 vi.spyOn(index, "incrementalUpdate").mockImplementation(update);
 return index;
}
function scanner(): NonNullable<ServerRuntime["contentScanner"]> {
 return { name: "fixture", runtime: "http", ready: vi.fn(async () => true), scan: vi.fn(async () => []), shutdown: vi.fn(async () => {}) };
}
const driftReport: NonNullable<ReturnType<typeof detectPlanDrift>> = { declared_count: 1, matched_count: 0, missing_steps: [{ intent: "Edit src/a.ts", status: "pending" }], unexpected_actions: [], drift_pct: 1 };
const fnOf = vi.mocked;

beforeEach(() => {
	bLog.length = 0;
	bLogAlways.length = 0;
	vi.clearAllMocks();
	mMkdir.mockResolvedValue(undefined);
	mWriteFile.mockResolvedValue(undefined);
	mRefreshPriority.mockReturnValue(new Map());
	mFindRipgrep.mockReturnValue("/usr/bin/rg");
	mDefaultAudit.mockReturnValue("/repo/.interlinked/permission-rule-strips.jsonl");
	mAutoStrip.mockReturnValue({ totalStripped: 0, entries: [] });
	mCapturePre.mockResolvedValue(null);
	mCaptureUser.mockResolvedValue(null);
	// scanUserPrompt's "no spans" sentinel is `undefined`, not `null`.
	mScanUserPrompt.mockResolvedValue(undefined);
	mDetectPlanDrift.mockReturnValue(null);
	mFormatPlanDrift.mockReturnValue(null);
	mBuildTurnSummary.mockReturnValue(summary());
	mFormatTurnEnd.mockReturnValue([]);
	mBuildRescan.mockReturnValue([]);
	mRunSeq.mockReturnValue([]);
	mBuildCadence.mockReturnValue(null);
	mBuildStaleBaseline.mockReturnValue(null);
	mBuildVsc.mockReturnValue([]);
	mRunSessionEndResourcePlan.mockReturnValue({
		maxJobs: 1,
		background: false,
		commandPrefix: "",
		defer: false,
		reason: "test",
	});
	mSuppressRepeatedNudges.mockImplementation((_key, warnings) => [...warnings]);
	// Restore the genuine sanitize behavior after clearAllMocks wiped the
	// wrapped implementation. Mirrors session-paths.ts::sanitizeSessionId
	// (whitelist charset + 64-char cap); the one branch-forcing test overrides
	// this per-call with mockReturnValueOnce.
	mSanitize.mockImplementation((id: string) =>
		id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
	);
});

// ───────────────────────────── resolveParentSessionId (extra branches) ────
describe("resolveParentSessionId — branch coverage", () => {
	it("derives subName from agent_name → parent via cohort, mapping back to a live session", () => {
		const findAgentByIdentity = vi.fn((name: string) => {
			if (name === "sub") return agent({ parent_agent: "parent" });
			if (name === "parent") return agent({ session_id: "psess" });
			return undefined;
		});
		const cohort = bCohort({ findAgentByIdentity });
		const sessions = bSessions({
			get: vi.fn((id: string) => (id === "psess" ? bSession() : undefined)),
		});
		expect(
			resolveParentSessionId(bEvent({ agent_name: "sub" }), cohort, sessions),
		).toBe("psess");
	});

	it("derives subName from tool_input.subagent_id and parent from tool_input.parent_agent_name", () => {
		const findAgentByIdentity = vi.fn((name: string) => (name === "pname" ? agent({ session_id: "ps" }) : undefined));
		const cohort = bCohort({ findAgentByIdentity });
		const sessions = bSessions({
			get: vi.fn((id: string) => (id === "ps" ? bSession() : undefined)),
		});
		expect(
			resolveParentSessionId(
				bEvent({ tool_input: { subagent_id: "sub", parent_agent_name: "pname" } }),
				cohort,
				sessions,
			),
		).toBe("ps");
	});

	it("derives subName from tool_input.agent_id and resolves parent via the direct-session arm", () => {
		const cohort = bCohort({ findAgentByIdentity: vi.fn(() => undefined) });
		const sessions = bSessions({
			get: vi.fn((id: string) => (id === "pdirect" ? bSession() : undefined)),
		});
		expect(
			resolveParentSessionId(
				bEvent({ tool_input: { agent_id: "sub2", parent_agent: "pdirect" } }),
				cohort,
				sessions,
			),
		).toBe("pdirect");
	});

	it("returns undefined when a parent name exists but no session matches either path", () => {
		const cohort = bCohort({ findAgentByIdentity: vi.fn(() => undefined) });
		const sessions = bSessions({ get: vi.fn(() => undefined) });
		expect(
			resolveParentSessionId(bEvent({ parent_agent: "ghost" }), cohort, sessions),
		).toBeUndefined();
	});

	it("ignores non-string tool_input subagent/agent ids (typeof guards)", () => {
		expect(
			resolveParentSessionId(
				bEvent({ tool_input: { subagent_id: 42, agent_id: { x: 1 } } }),
				bCohort(),
				bSessions(),
			),
		).toBeUndefined();
	});
});

// ───────────────────────────── dispatch + pre-switch plan capture ─────────
describe("handleLifecycleEvent — dispatch branches", () => {
	it("PreToolUse: runs plan capture (default enabled), logs the capture, falls through to null", async () => {
		mCapturePre.mockResolvedValue(captured("TaskCreate", ["Read src/a.ts", "Edit src/a.ts"]));
		const ctx = bCtx();
		const out = await handleLifecycleEvent(ctx, bEvent({ hook_event: "PreToolUse" }), bSession());
		expect(out).toBeNull();
		expect(mCapturePre.mock.calls[0]?.[0].enabled).toBe(true);
		expect(bLog.some((l) => l.includes("Plan capture: TaskCreate → 2 step(s)"))).toBe(true);
		expect(fnOf(ctx.cohort.recordActivity)).toHaveBeenCalled();
	});

	it("PreToolUse: honors plan_capture.enabled === false and does not log on no-capture", async () => {
		mCapturePre.mockResolvedValue(null);
		const ctx = bCtx({ rules: { ...makeGuardRules(), plan_capture: { enabled: false, parse_userprompt: false } } });
		await handleLifecycleEvent(ctx, bEvent({ hook_event: "PreToolUse" }), bSession());
		expect(mCapturePre.mock.calls[0]?.[0].enabled).toBe(false);
		expect(bLog.some((l) => l.includes("Plan capture:"))).toBe(false);
	});

	it("does not run PreToolUse plan capture for a lifecycle event", async () => {
		const ctx = bCtx();
		await handleLifecycleEvent(ctx, bEvent({ hook_event: "SessionStart" }), bSession());
		expect(mCapturePre).not.toHaveBeenCalled();
	});

	it("SubagentStart: joins cohort, logs the name, returns null", async () => {
		const ctx = bCtx();
		const out = await handleLifecycleEvent(
			ctx,
			bEvent({ hook_event: "SubagentStart", agent_name: "sub-x" }),
			bSession(),
		);
		expect(out).toBeNull();
		expect(fnOf(ctx.cohort.subagentJoined)).toHaveBeenCalled();
		expect(bLog.some((l) => l.includes("Subagent joined: sub-x"))).toBe(true);
	});

	it("SubagentStart: logs 'unnamed' when agent_name is absent", async () => {
		const ctx = bCtx();
		await handleLifecycleEvent(ctx, bEvent({ hook_event: "SubagentStart" }), bSession());
		expect(bLog.some((l) => l.includes("Subagent joined: unnamed"))).toBe(true);
	});

	it("default arm: records activity and returns null for an unhandled event", async () => {
		const ctx = bCtx();
		const event = bEvent({ hook_event: "Notification" });
		const out = await handleLifecycleEvent(
			ctx,
			event,
			bSession(),
		);
		expect(out).toBeNull();
		expect(fnOf(ctx.cohort.recordActivity)).toHaveBeenCalledWith(event);
	});

	it("TaskCompleted: records cohort activity and falls through to null", async () => {
		const ctx = bCtx();
		const out = await handleLifecycleEvent(
			ctx,
			bEvent({ hook_event: "TaskCompleted", agent_name: "sub-x" }),
			bSession(),
		);
		expect(out).toBeNull();
		expect(fnOf(ctx.cohort.recordActivity)).toHaveBeenCalledWith(
			expect.objectContaining({ hook_event: "TaskCompleted", agent_name: "sub-x" }),
		);
		expect(mCaptureAgentEvent).toHaveBeenCalledWith(
			expect.objectContaining({ hook_event: "TaskCompleted", agent_name: "sub-x" }),
			ctx.cwd,
			ctx.log,
		);
	});
});

// ───────────────────────────── handleSessionStart ─────────────────────────
describe("SessionStart handler — branch coverage", () => {
	function start(ctx: ServerRuntime, over: Partial<HarnessEvent> = {}) {
		return handleLifecycleEvent(ctx, bEvent({ hook_event: "SessionStart", ...over }), bSession());
	}

	it("joins the cohort, logs the agent line, returns null on the clean path", async () => {
		const ctx = bCtx();
		const out = await start(ctx, { agent_name: "alpha", agent_source: "claude" });
		expect(out).toBeNull();
		expect(fnOf(ctx.cohort.agentJoined)).toHaveBeenCalled();
		expect(bLog.some((l) => l.includes("Agent joined: alpha (claude)"))).toBe(true);
	});

	it("logs session_id when agent_name is absent in the join line", async () => {
		const ctx = bCtx();
		await start(ctx, { session_id: "sess-fallback" });
		expect(bLog.some((l) => l.includes("Agent joined: sess-fallback"))).toBe(true);
	});

	it("assigns the refreshed file-priority map and logs when non-empty", async () => {
		const refreshed = new Map<string, FilePriority>([["a.ts", { ageDays: 1, tier: "hot" }]]);
		mRefreshPriority.mockReturnValue(refreshed);
		const ctx = bCtx();
		await start(ctx);
		expect(ctx.filePriorityMap).toBe(refreshed);
		expect(bLog.some((l) => l.includes("File-priority map refreshed: 1 entries"))).toBe(true);
	});

	it("does not reassign the priority map when the refresh is empty", async () => {
		mRefreshPriority.mockReturnValue(new Map());
		const ctx = bCtx();
		const before = ctx.filePriorityMap;
		await start(ctx);
		expect(ctx.filePriorityMap).toBe(before);
	});

	it("swallows a file-priority refresh error non-fatally", async () => {
		mRefreshPriority.mockImplementation(() => {
			throw new Error("git boom");
		});
		const ctx = bCtx();
		expect(await start(ctx)).toBeNull();
		expect(bLog.some((l) => l.includes("File-priority refresh failed (non-fatal)"))).toBe(true);
	});

	it("refreshes the trigram index and logs when files were updated", async () => {
		const trigramIndex = trigram(() => 7);
		await start(bCtx({ trigramIndex }));
		expect(trigramIndex.incrementalUpdate).toHaveBeenCalled();
		expect(bLog.some((l) => l.includes("Trigram index refreshed: 7 files updated"))).toBe(true);
	});

	it("does not log a trigram refresh when zero files updated", async () => {
		const trigramIndex = trigram(() => 0);
		await start(bCtx({ trigramIndex }));
		expect(bLog.some((l) => l.includes("Trigram index refreshed"))).toBe(false);
	});

	it("swallows a trigram refresh error non-fatally", async () => {
		const trigramIndex = trigram(() => { throw new Error("index boom"); });
		await start(bCtx({ trigramIndex }));
		expect(bLog.some((l) => l.includes("Trigram index refresh failed (non-fatal)"))).toBe(true);
	});

	it("warns via logAlways when an index exists but ripgrep is missing", async () => {
		mFindRipgrep.mockReturnValue(null);
		await start(bCtx({ trigramIndex: trigram(() => 0) }));
		expect(bLogAlways.some((l) => l.includes("ripgrep (rg) not found"))).toBe(true);
	});

	it("does NOT warn about ripgrep when rg is present", async () => {
		mFindRipgrep.mockReturnValue("/usr/bin/rg");
		await start(bCtx({ trigramIndex: trigram(() => 0) }));
		expect(bLogAlways.some((l) => l.includes("ripgrep"))).toBe(false);
	});

	it("does NOT touch the trigram path when trigramIndex is null", async () => {
		await start(bCtx({ trigramIndex: null }));
		expect(mFindRipgrep).not.toHaveBeenCalled();
	});

	it("returns a strip warning, resets the setup cache, and logs when rules were stripped", async () => {
		mAutoStrip.mockReturnValue({
			totalStripped: 2,
			entries: [
				{
					timestamp: "2026-06-05T00:00:00.000Z",
					file: "/repo/.claude/settings.json",
					bucket: "allow",
					index: 0,
					rule: "Bash(-d *)",
					reason: "paren_imbalance",
				},
				{
					timestamp: "2026-06-05T00:00:00.000Z",
					file: "/repo/.claude/settings.local.json",
					bucket: "deny",
					index: 1,
					rule: "",
					reason: "empty_rule",
				},
			],
		});
		const ctx = bCtx();
		const out = await start(ctx);
		expect(out?.decision).toBe("allow");
		const warning = out?.warnings?.[0] ?? "";
		expect(warning).toContain("Auto-stripped 2 malformed permission rule(s)");
		expect(warning).toContain(
			'  - .claude/settings.json permissions.allow[0] = "Bash(-d *)" (reason:paren_imbalance)',
		);
		expect(warning).toContain(
			"These rules came from Claude Code's permission UI; the upstream extractor occasionally emits bad parens / empty / missing-Tool() entries.",
		);
		expect(warning).toContain("\nThese rules came from Claude Code's permission UI");
		expect(warning).toContain(".interlinked/permission-rule-strips.jsonl");
		expect(mResetSetupCache).toHaveBeenCalledTimes(1);
		expect(bLog.some((l) => l.includes("Auto-stripped 2 malformed permission rule(s)"))).toBe(true);
	});

	it("appends '...and N more' when more than five entries are stripped", async () => {
		const entries = Array.from({ length: 7 }, (_v, i) => ({
			timestamp: "2026-06-05T00:00:00.000Z",
			file: "/repo/.claude/settings.json",
			bucket: "allow" as const,
			index: i,
			rule: `Bash(r${i})`,
			reason: "paren_imbalance" as const,
		}));
		mAutoStrip.mockReturnValue({ totalStripped: 7, entries: entries });
		const out = await start(bCtx());
		expect(out?.warnings?.[0]).toContain("...and 2 more");
	});

	it("does not append an empty or fabricated remainder for exactly five entries", async () => {
		const entries = Array.from({ length: 5 }, (_v, i) => ({
			timestamp: "2026-06-05T00:00:00.000Z",
			file: "/repo/.claude/settings.json",
			bucket: "allow" as const,
			index: i,
			rule: `Bash(r${i})`,
			reason: "paren_imbalance" as const,
		}));
		mAutoStrip.mockReturnValue({ totalStripped: 5, entries: entries });
		const warning = (await start(bCtx()))?.warnings?.[0] ?? "";
		expect(warning).toContain("\nThese rules came from Claude Code's permission UI");
		expect(warning).not.toContain("...and");
	});

	it("uses the audit path verbatim when it is not under cwd", async () => {
		mDefaultAudit.mockReturnValue("/elsewhere/audit.jsonl");
		mAutoStrip.mockReturnValue({
			totalStripped: 1,
			entries: [
				{
					timestamp: "2026-06-05T00:00:00.000Z",
					file: "/x/.claude/settings.json",
					bucket: "allow",
					index: 0,
					rule: "bad",
					reason: "missing_tool_prefix",
				},
			],
		});
		const out = await start(bCtx({ cwd: "/repo" }));
		expect(out?.warnings?.[0]).toContain("/elsewhere/audit.jsonl");
	});

	it("renders a cwd-relative audit path for the warning receipt", async () => {
		mDefaultAudit.mockReturnValue("/repo/.interlinked/audit.jsonl");
		mAutoStrip.mockReturnValue({
			totalStripped: 1,
			entries: [
				{
					timestamp: "2026-06-05T00:00:00.000Z",
					file: "/repo/.claude/settings.json",
					bucket: "allow",
					index: 0,
					rule: "bad",
					reason: "missing_tool_prefix",
				},
			],
		});
		const warning = (await start(bCtx({ cwd: "/repo" })))?.warnings?.[0] ?? "";
		expect(warning).toContain("(full audit at .interlinked/audit.jsonl)");
		expect(warning).not.toContain("(full audit at /repo/.interlinked/audit.jsonl)");
	});

	it("returns null and skips the cache reset when nothing was stripped", async () => {
		mAutoStrip.mockReturnValue({ totalStripped: 0, entries: [] });
		expect(await start(bCtx())).toBeNull();
		expect(mResetSetupCache).not.toHaveBeenCalled();
	});

	it("swallows an auto-strip error non-fatally and returns null", async () => {
		mAutoStrip.mockImplementation(() => {
			throw new Error("strip boom");
		});
		expect(await start(bCtx())).toBeNull();
		expect(bLog.some((l) => l.includes("Permission-rule auto-strip failed (non-fatal)"))).toBe(true);
	});
});

// ───────────────────────────── handleSessionEnd ───────────────────────────
describe("SessionEnd handler — branch coverage", () => {
	it("runs the planned background lanes before removing the session", async () => {
		const event = bEvent({ hook_event: "SessionEnd", session_id: "s1" });
		const plan = {
			maxJobs: 2,
			background: true,
			commandPrefix: "nice -n 19 ",
			defer: false,
			reason: "quiet",
		};
		mRunSessionEndResourcePlan.mockReturnValue(plan);
		const ctx = bCtx({ sessions: bSessions({ get: vi.fn(() => bSession()) }) });
		await handleLifecycleEvent(ctx, event, bSession());
		expect(mRunSessionEndJobs).toHaveBeenCalledWith(ctx, plan);
		expect(mRunSessionEndHeavyJobs).toHaveBeenCalledWith(ctx, event, plan);
	});

	it("runs every defensive cleanup primitive and returns allow", async () => {
		const sessions = bSessions();
		const ctx = bCtx({
			sessions,
			classifierSessions: new Map([["s1", createClassifierSessionState()]]),
			autoCoordStates: new Map([["s1", createAutoCoordinationState()]]),
		});
		const out = await handleLifecycleEvent(
			ctx,
			bEvent({ hook_event: "SessionEnd", session_id: "s1" }),
			bSession(),
		);
		expect(out).toEqual({ decision: "allow" });
		expect(fnOf(sessions.remove)).toHaveBeenCalledWith("s1");
		expect(fnOf(ctx.asyncFindings.clearSession)).toHaveBeenCalledWith("s1");
		expect(mDeleteSnapshot).toHaveBeenCalledWith("/repo", "s1");
		expect((ctx.classifierSessions).has("s1")).toBe(false);
		expect((ctx.autoCoordStates).has("s1")).toBe(false);
	});
});

// ───────────────────────────── handleStop ─────────────────────────────────
describe("Stop handler — branch coverage", () => {
	function stop(ctx: ServerRuntime, event: Partial<HarnessEvent> = {}, session = bSession()) {
		return handleLifecycleEvent(ctx, bEvent({ hook_event: "Stop", ...event }), session);
	}

	it("returns allow with undefined warnings when nothing is reported, after running cleanup", async () => {
		const ctx = bCtx();
		const out = await stop(ctx);
		expect(out).toEqual({ decision: "allow", warnings: undefined });
		expect(fnOf(ctx.cohort.agentLeft)).toHaveBeenCalled();
		expect(fnOf(ctx.asyncAnalysis.drain)).toHaveBeenCalled();
		expect(bLog).toContain("Agent left: s1");
	});

	// Stop output now passes through the digest (stop-digest.ts): the head of
	// each category prints in full and the rest collapse to one count line, so
	// these assertions check the head plus the count rather than every string.
	it("logs turn patterns and surfaces turn-end warnings when present", async () => {
		mBuildTurnSummary.mockReturnValue(summary(["churn", "thrash"]));
		mFormatTurnEnd.mockReturnValue(["TE-1", "TE-2"]);
		const out = await stop(bCtx());
		expect(out?.warnings).toEqual(expect.arrayContaining(["TE-1"]));
		expect(out?.warnings?.some((w) => w.includes("other x2"))).toBe(true);
		expect(bLog.some((l) => l.includes("Turn-end patterns: churn, thrash"))).toBe(true);
	});

	it("merges buildStopWarnings output (cadence + verification + rescan + sequence), preferring event.cwd", async () => {
		mBuildCadence.mockReturnValue("CADENCE");
		mBuildVsc.mockReturnValue(["VSC-1"]);
		mBuildRescan.mockReturnValue(["RESCAN-1"]);
		mRunSeq.mockReturnValue([{ detector_id: "seq-a", family: "quality", phase: "stop", match: { message: "sequence warning" } }]);
		const ctx = bCtx();
		const out = await stop(ctx, { cwd: "/event-cwd", session_id: "session-123" });
		// All four are untagged, so the digest treats them as one category:
		// the head prints in full, the remaining three become a count line.
		expect(out?.warnings).toEqual(expect.arrayContaining(["CADENCE"]));
		expect(out?.warnings?.some((w) => w.includes("other x4"))).toBe(true);
		expect(mBuildRescan).toHaveBeenCalledWith(
			expect.anything(),
			"/event-cwd",
			expect.objectContaining({ sessionId: "session-123" }),
		);
		expect(mRunSeq).toHaveBeenCalledWith({
			phase: "stop",
			trajectory: expect.anything(),
			candidate: expect.objectContaining({ hook_event: "Stop", cwd: "/event-cwd" }),
		});
		expect(mBuildGateReach).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "session-123",
				perEditCoverageEnabled: true,
			}),
		);
		expect(mSuppressRepeatedNudges).toHaveBeenCalledWith(
			{ projectRoot: ctx.cwd, sessionId: "session-123" },
			expect.any(Array),
		);
	});

	it("falls back to ctx.cwd for the rescan cwd when event.cwd is absent", async () => {
		await stop(bCtx({ cwd: "/ctx-cwd" }), {});
		expect(mBuildRescan).toHaveBeenCalledWith(
			expect.anything(),
			"/ctx-cwd",
			expect.any(Object),
		);
	});

	// test-contract: boundary — Stop reconciliation stays rooted at the daemon workspace when event.cwd is a nested runner directory
	it("reconciles workspace residue against ctx.cwd, not a nested event.cwd", async () => {
		const nested = join(tmp, "nested");
		mkdirSync(nested);
		writeFileSync(join(tmp, "baseline.ts"), "baseline\n");
		const ctx = bCtx({ cwd: tmp });

		// No filesystem effect occurred. Comparing against event.cwd would make
		// the daemon workspace file look deleted and fabricate residue.
		rememberWorkspaceSnapshot({ sessionId: "no-effect", root: tmp });
		const clean = await stop(
			ctx,
			{ session_id: "no-effect", cwd: nested },
			bSession({ session_id: "no-effect", files_written: new Set<string>() }),
		);
		expect(clean?.warnings ?? []).not.toContainEqual(expect.stringContaining("effect-residue"));

		// A real write after the pre-call snapshot must still be surfaced even
		// though the Stop payload reports the nested directory.
		rememberWorkspaceSnapshot({ sessionId: "real-effect", root: tmp });
		writeFileSync(join(tmp, "unreconciled.ts"), "real\n");
		const residue = await stop(
			ctx,
			{ session_id: "real-effect", cwd: nested },
			bSession({ session_id: "real-effect", files_written: new Set<string>() }),
		);
		expect(residue?.warnings ?? []).toContainEqual(
			expect.stringContaining("created:unreconciled.ts"),
		);
	});

	it("surfaces the gate-reach meta-metric when a quality gate is disabled", async () => {
		// End-to-end wiring pin (plan 16 §4): a real tree with one product-code
		// file plus `per_edit_coverage.enabled: false` must make the Stop verdict
		// carry the loud disabled-gate figure. This is the whole point of the
		// meta-metric — a gate that is off must never be a silent zero.
		const repo = mkdtempSync(join(tmpdir(), "lifecycle-gate-reach-"));
		try {
			mkdirSync(join(repo, "src"), { recursive: true });
			writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf-8");
			const ctx = bCtx({ cwd: repo, rules: { ...makeGuardRules(), per_edit_coverage: { ...nonNull(getDefaultConfig().per_edit_coverage), enabled: false } } });
			const out = await stop(ctx, { cwd: repo });
			const warnings = out?.warnings ?? [];
			expect(warnings.some((w) => w.includes("[interlinked:gate-reach]"))).toBe(true);
			expect(warnings.some((w) => w.includes("gate=per_edit_coverage"))).toBe(true);
			expect(warnings.some((w) => w.includes("disabled=true"))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("suppresses the gate-reach meta-metric for a read-only session (zero files_written)", async () => {
		// The disabled-gate figure is about THIS session's edits; a session that
		// wrote nothing must not be nagged on its first turn (2026-08-23 report).
		const repo = mkdtempSync(join(tmpdir(), "lifecycle-gate-reach-ro-"));
		try {
			mkdirSync(join(repo, "src"), { recursive: true });
			writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf-8");
			const ctx = bCtx({ cwd: repo, rules: { ...makeGuardRules(), per_edit_coverage: { ...nonNull(getDefaultConfig().per_edit_coverage), enabled: false } } });
			const out = await stop(ctx, { cwd: repo }, bSession({ files_written: new Set() }));
			const warnings = out?.warnings ?? [];
			expect(warnings.some((w) => w.includes("[interlinked:gate-reach]"))).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("records the Stop session identity and enabled-gate state in the reach ledger", async () => {
		const repo = mkdtempSync(join(tmpdir(), "lifecycle-gate-ledger-"));
		try {
			mkdirSync(join(repo, "src"), { recursive: true });
			writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf-8");
			const ctx = bCtx({
				cwd: repo,
				rules: { ...makeGuardRules(), per_edit_coverage: { ...nonNull(getDefaultConfig().per_edit_coverage), enabled: true } },
			});
			await stop(ctx, { cwd: repo, session_id: "ledger-session" });
			const rows = readFileSync(join(repo, ".interlinked", "gate-reach.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => readJsonRecord(line));
			const snapshot = rows.at(-1);
			expect(snapshot?.session_id).toBe("ledger-session");
			expect(snapshot?.gates).toEqual(
				expect.arrayContaining([expect.objectContaining({ gate: "per_edit_coverage" })]),
			);
			const perEdit = jsonRecords(snapshot?.gates).find((gate) => gate.gate === "per_edit_coverage");
			expect(perEdit?.status).toBe("source_unavailable");
			expect(perEdit?.disabled).toBeUndefined();
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("surfaces the edit-mechanics reflection once the doomed-edit threshold is met", async () => {
		// buildEditMechanicsStopNudge is the REAL (unmocked) implementation —
		// drive it with a session shape that clears its threshold (doomed >= 3)
		// and assert the actual rendered text, not just that something fired.
		const session = bSession({
			edit_mechanics: { doomed: 4, rescued: 1, stale_reads: 2, blind_edits: 0, stale_warned: new Set() },
		});
		const out = await stop(bCtx(), {}, session);
		const warnings = out?.warnings ?? [];
		const nudge = warnings.find((w) => w.includes("[interlinked:edit-mechanics]"));
		expect(nudge).toContain("4 edit(s) this session were dead on arrival");
		expect(nudge).toContain("1 recovered in one round trip");
		expect(nudge).toContain("2 targeted file(s) that drifted");
	});

	it("omits the edit-mechanics reflection below the doomed-edit threshold", async () => {
		const session = bSession({
			edit_mechanics: { doomed: 2, rescued: 0, stale_reads: 0, blind_edits: 0, stale_warned: new Set() },
		});
		const out = await stop(bCtx(), {}, session);
		const warnings = out?.warnings ?? [];
		expect(warnings.some((w) => w.includes("[interlinked:edit-mechanics]"))).toBe(false);
	});

	it("surfaces the stale-baseline nudge when the ratchet water-line is old", async () => {
		mBuildStaleBaseline.mockReturnValue("STALE-BASELINE-NUDGE");
		const ctx = bCtx();
		const event = bEvent({ hook_event: "Stop" });
		const session = bSession({ files_written: new Set(["src/changed.ts"]) });
		const out = await stop(ctx, event, session);
		expect(out?.warnings).toContain("STALE-BASELINE-NUDGE");
		expect(mBuildStaleBaseline).toHaveBeenCalledWith(ctx, event, true);
	});

	it("does not fabricate a session-rework nudge for a freshly-folded (empty) trajectory", async () => {
		// Seed a real (unmocked) trajectory-shadow entry for this session via the
		// engine's own exported entry point, so `peekTrajectoryState` returns a
		// genuine — but edit-empty — TrajectoryState. With zero recorded edits the
		// rework ratio is 0, below MIN_EDITS_FOR_NUDGE, so no nudge should fire.
		trajectoryShadowWarnings(
			bEvent({ hook_event: "PreToolUse", session_id: "rework-empty" }),
			{ decision: "allow" },
			{ trajectory_shadow: { enabled: true } },
		);
		expect(peekTrajectoryState("rework-empty")).not.toBeNull();
		const out = await stop(bCtx(), { session_id: "rework-empty" });
		const warnings = out?.warnings ?? [];
		expect(warnings.some((w) => w.includes("[interlinked:session-rework]"))).toBe(false);
	});

	it("surfaces the session-rework nudge once the session's edits are mostly revisits", async () => {
		trajectoryShadowWarnings(
			bEvent({ hook_event: "PreToolUse", session_id: "rework-full" }),
			{ decision: "allow" },
			{ trajectory_shadow: { enabled: true } },
		);
		const state = nonNull(peekTrajectoryState("rework-full"));
		// 8 edits alternating between two known contents: every edit from the
		// 3rd onward returns the file to content already seen this session, so
		// 6/8 (75%) clears both MIN_EDITS_FOR_NUDGE (8) and REWORK_RATIO_FLOOR
		// (0.25).
		state.fileShaHistory.set(
			"src/churny.ts",
			Array.from({ length: 8 }, (_v, i) => ({
				sha: i % 2 === 0 ? "sha-a" : "sha-b",
				normSha: i % 2 === 0 ? "sha-a" : "sha-b",
				atStep: i,
			})),
		);
		const out = await stop(bCtx(), { session_id: "rework-full" });
		const warnings = out?.warnings ?? [];
		const nudge = warnings.find((w) => w.includes("[interlinked:session-rework]"));
		expect(nudge).toContain("6/8 edits");
		expect(nudge).toContain("src/churny.ts");
	});

	it("pushes a plan-drift warning when a drift report formats to text", async () => {
		const report = driftReport;
		mDetectPlanDrift.mockReturnValue(report);
		mFormatPlanDrift.mockReturnValue("PLAN-DRIFT");
		const out = await stop(bCtx());
		expect(out?.warnings).toContain("PLAN-DRIFT");
		expect(mFormatPlanDrift).toHaveBeenCalledWith({ report });
	});

	it("does not push a plan-drift warning when the report formats to null", async () => {
		mDetectPlanDrift.mockReturnValue(driftReport);
		mFormatPlanDrift.mockReturnValue(null);
		const out = await stop(bCtx());
		expect(out).toEqual({ decision: "allow", warnings: undefined });
	});

	it("does not call the drift formatter when detectPlanDrift returns null", async () => {
		mDetectPlanDrift.mockReturnValue(null);
		await stop(bCtx());
		expect(mFormatPlanDrift).not.toHaveBeenCalled();
	});

	it("releases reservations for the event agent name, falling back to the session agent name", async () => {
		const reservations = makeServerRuntime().reservations;
		vi.spyOn(reservations, "releaseAllForAgent").mockImplementation(() => {});
		const ctx = bCtx({ reservations });
		await stop(ctx, {}, bSession({ agent_name: "session-agent" }));
		expect(reservations.releaseAllForAgent).toHaveBeenCalledWith("session-agent", ctx.cohort);
	});

	it("prefers event.agent_name for reservation release when present", async () => {
		const reservations = makeServerRuntime().reservations;
		vi.spyOn(reservations, "releaseAllForAgent").mockImplementation(() => {});
		const ctx = bCtx({ reservations });
		await stop(ctx, { agent_name: "event-agent" }, bSession({ agent_name: "session-agent" }));
		expect(reservations.releaseAllForAgent).toHaveBeenCalledWith("event-agent", ctx.cohort);
		expect(bLog).toContain("Agent left: event-agent");
	});

	// persistSessionTrajectory branches
	it("skips the trajectory write when serialize returns null", async () => {
		const ctx = bCtx({ sessions: bSessions({ serialize: vi.fn(() => null) }) });
		await stop(ctx);
		expect(mWriteFile).not.toHaveBeenCalled();
	});

	it("throws (and logs non-fatally) when the sanitized session_id is empty", async () => {
		// An empty session_id sanitizes to "" -> the `!safeId` guard throws,
		// which the surrounding try/catch logs as non-fatal.
		const ctx = bCtx({
			sessions: bSessions({ serialize: vi.fn(() => ({ session_id: "" })) }),
		});
		await stop(ctx, { session_id: "" });
		expect(mWriteFile).not.toHaveBeenCalled();
		expect(
			bLog.some(
				(l) => l.includes("Failed to save trajectory") && l.includes("no safe characters"),
			),
		).toBe(true);
	});

	it("refuses (and logs) a trajectory path that escapes the sessions dir", async () => {
		// The real sanitizer can never emit traversal, so force a containment
		// violation to exercise the defense-in-depth resolve()/sep check.
		mSanitize.mockReturnValueOnce("../../escape");
		const ctx = bCtx({
			sessions: bSessions({ serialize: vi.fn(() => ({ session_id: "x" })) }),
		});
		await stop(ctx, { session_id: "x" });
		expect(mWriteFile).not.toHaveBeenCalled();
		expect(
			bLog.some(
				(l) =>
					l.includes("Failed to save trajectory") &&
					l.includes("refusing to write trajectory outside sessions dir"),
			),
		).toBe(true);
	});

	it("writes the trajectory (mkdir + writeFile) and logs on the happy path", async () => {
		const ctx = bCtx({
			sessions: bSessions({ serialize: vi.fn(() => ({ session_id: "s1", agent_name: "a" })) }),
		});
		await stop(ctx, { session_id: "s1" });
		expect(mMkdir).toHaveBeenCalledWith("/repo/.interlinked/sessions", { recursive: true });
		const [target, body] = mWriteFile.mock.calls[0] ?? [];
		expect(target).toBe("/repo/.interlinked/sessions/s1.trajectory.json");
		expect(JSON.parse(String(body)).feedback_effectiveness).toEqual({ summary: "fx" });
		expect(bLog.some((l) => l.includes("Session trajectory saved: s1"))).toBe(true);
	});

	it("catches a writeFile rejection (Error) and logs its message", async () => {
		mWriteFile.mockRejectedValue(new Error("disk full"));
		const ctx = bCtx({ sessions: bSessions({ serialize: vi.fn(() => ({ session_id: "s1" })) }) });
		await stop(ctx);
		expect(bLog.some((l) => l.includes("Failed to save trajectory") && l.includes("disk full"))).toBe(true);
	});

	it("catches a non-Error writeFile rejection via the String(err) arm", async () => {
		mWriteFile.mockRejectedValue("string failure");
		const ctx = bCtx({ sessions: bSessions({ serialize: vi.fn(() => ({ session_id: "s1" })) }) });
		await stop(ctx);
		expect(
			bLog.some((l) => l.includes("Failed to save trajectory") && l.includes("string failure")),
		).toBe(true);
	});

	it("runs cleanupSessionState removals (sessions.remove, snapshot delete, state maps)", async () => {
		const sessions = bSessions();
		const ctx = bCtx({
			sessions,
			classifierSessions: new Map([["s1", createClassifierSessionState()]]),
			autoCoordStates: new Map([["s1", createAutoCoordinationState()]]),
		});
		await stop(ctx, { session_id: "s1" }, bSession({ session_id: "s1" }));
		expect(fnOf(sessions.remove)).toHaveBeenCalledWith("s1");
		expect(mDeleteSnapshot).toHaveBeenCalledWith("/repo", "s1");
		expect((ctx.classifierSessions).has("s1")).toBe(false);
		expect((ctx.autoCoordStates).has("s1")).toBe(false);
	});
});

// ───────────────────────────── handleUserPromptSubmit ─────────────────────
describe("UserPromptSubmit handler — branch coverage", () => {
	function ups(ctx: ServerRuntime, event: Partial<HarnessEvent> = {}, session = bSession()) {
		return handleLifecycleEvent(ctx, bEvent({ hook_event: "UserPromptSubmit", ...event }), session);
	}

	it("records cohort activity and returns allow on the bare path", async () => {
		const ctx = bCtx();
		expect(await ups(ctx)).toEqual({ decision: "allow" });
		expect(fnOf(ctx.cohort.recordActivity)).toHaveBeenCalled();
	});

	it("runs user-prompt plan capture (with parse_userprompt) and logs when captured", async () => {
		mCaptureUser.mockResolvedValue(captured("structured_userprompt", ["Edit src/a.ts"]));
		const ctx = bCtx({ rules: { ...makeGuardRules(), plan_capture: { enabled: true, parse_userprompt: true } } });
		await ups(ctx);
		expect(mCaptureUser.mock.calls[0]?.[0]).toMatchObject({ enabled: true, parseUserPrompt: true });
		expect(bLog.some((l) => l.includes("Plan capture (user-prompt): 1 step(s)"))).toBe(true);
	});

	it("defaults parseUserPrompt to false and enabled to true when plan_capture is absent", async () => {
		mCaptureUser.mockResolvedValue(null);
		await ups(bCtx({ rules: { ...makeGuardRules(),} }));
		expect(mCaptureUser.mock.calls[0]?.[0]).toMatchObject({ enabled: true, parseUserPrompt: false });
	});

	it("passes an explicitly disabled plan-capture setting through", async () => {
		await ups(bCtx({ rules: { ...makeGuardRules(), plan_capture: { enabled: false, parse_userprompt: false } } }));
		expect(mCaptureUser.mock.calls[0]?.[0]).toMatchObject({
			enabled: false,
			parseUserPrompt: false,
		});
	});

	it("returns a redacted prompt when the content scanner finds spans", async () => {
		mScanUserPrompt.mockResolvedValue({ findings: [{ label: "secret", start: 0, end: 7, text: "leak me", source: "UserPromptSubmit.prompt" }], redacted: "<REDACTED>" });
		const ctx = bCtx({
			rules: { ...makeGuardRules(), content_scanner: { ...nonNull(getDefaultConfig().content_scanner), enabled: true } },
			contentScanner: scanner(),
		});
		const out = await ups(ctx, { prompt: "leak me" });
		expect(out).toEqual({ decision: "allow", redacted_prompt: "<REDACTED>" });
		expect(bLog.some((l) => l.includes("Content scanner: UserPromptSubmit"))).toBe(true);
	});

	it("uses an empty-string prompt fallback for the scanner when event.prompt is absent", async () => {
		mScanUserPrompt.mockResolvedValue(undefined);
		const ctx = bCtx({
			rules: { ...makeGuardRules(), content_scanner: { ...nonNull(getDefaultConfig().content_scanner), enabled: true } },
			contentScanner: scanner(),
		});
		await ups(ctx, {});
		expect(mScanUserPrompt).toHaveBeenCalledWith("", expect.anything(), expect.anything());
	});

	it("skips the scanner when content_scanner is enabled but no scanner is wired", async () => {
		const ctx = bCtx({ rules: { ...makeGuardRules(), content_scanner: { ...nonNull(getDefaultConfig().content_scanner), enabled: true } }, contentScanner: undefined });
		expect(await ups(ctx, { prompt: "hi" })).toEqual({ decision: "allow" });
		expect(mScanUserPrompt).not.toHaveBeenCalled();
	});
});

// ───────────────────────────── handleSubagentStop ─────────────────────────
describe("SubagentStop handler — branch coverage", () => {
	function subStop(ctx: ServerRuntime, event: Partial<HarnessEvent> = {}) {
		return handleLifecycleEvent(ctx, bEvent({ hook_event: "SubagentStop", ...event }), bSession());
	}

	it("records cohort departure, logs the leave line, returns null", async () => {
		const ctx = bCtx();
		expect(await subStop(ctx, { agent_name: "sub-z" })).toBeNull();
		expect(fnOf(ctx.cohort.subagentLeft)).toHaveBeenCalled();
		expect(bLog.some((l) => l.includes("Subagent left: sub-z"))).toBe(true);
	});

	it("logs 'unnamed' on leave when agent_name is absent", async () => {
		await subStop(bCtx(), {});
		expect(bLog.some((l) => l.includes("Subagent left: unnamed"))).toBe(true);
	});

	it("rolls up verification + file tracking and logs both when a parent session resolves", async () => {
		const sessions = bSessions({
			get: vi.fn((id: string) => (id === "psess" ? bSession() : undefined)),
			rollUpVerificationSignals: vi.fn(() => true),
			rollUpFileTracking: vi.fn(() => true),
		});
		const getAgent = vi.fn((name: string) => {
			if (name === "sub") return agent({ parent_agent: "parent" });
			if (name === "parent") return agent({ session_id: "psess" });
			return undefined;
		});
		const ctx = bCtx({ sessions, cohort: bCohort({ findAgentByIdentity: getAgent }) });
		await subStop(ctx, { agent_name: "sub", session_id: "subsess" });
		expect(fnOf(sessions.rollUpVerificationSignals)).toHaveBeenCalledWith("subsess", "psess");
		expect(bLog.some((l) => l.includes("verification rolled up into parent session psess"))).toBe(true);
		expect(bLog.some((l) => l.includes("file-tracking rolled up into parent session psess"))).toBe(true);
	});

	it("does not log roll-ups when the helpers return false", async () => {
		const sessions = bSessions({
			get: vi.fn(() => bSession()),
			rollUpVerificationSignals: vi.fn(() => false),
			rollUpFileTracking: vi.fn(() => false),
		});
		const ctx = bCtx({ sessions, cohort: bCohort({ findAgentByIdentity: vi.fn(() => agent({ session_id: "p" })) }) });
		await subStop(ctx, { agent_name: "sub" });
		expect(bLog.some((l) => l.includes("rolled up into parent"))).toBe(false);
	});

	it("skips roll-ups entirely when no parent session resolves", async () => {
		const sessions = bSessions({ get: vi.fn(() => undefined) });
		const ctx = bCtx({ sessions });
		await subStop(ctx, { agent_name: "orphan" });
		expect(fnOf(sessions.rollUpVerificationSignals)).not.toHaveBeenCalled();
		expect(fnOf(sessions.rollUpFileTracking)).not.toHaveBeenCalled();
	});
});

// ───────────────────────────── handleSkillEnter ───────────────────────────
describe("SkillEnter handler — branch coverage", () => {
	function enter(ctx: ServerRuntime, event: Partial<HarnessEvent> = {}, session = bSession()) {
		return handleLifecycleEvent(ctx, bEvent({ hook_event: "SkillEnter", ...event }), session);
	}

	it("returns a warning when tool_input.name is missing", async () => {
		const out = await enter(bCtx(), { tool_input: {} });
		expect(out).toEqual({
			decision: "allow",
			warnings: ["SkillEnter: missing tool_input.name"],
		});
	});

	it("treats a whitespace-only name as missing", async () => {
		const out = await enter(bCtx(), { tool_input: { name: "   " } });
		expect(out?.warnings).toEqual(["SkillEnter: missing tool_input.name"]);
	});

	it("scopes to a single session, applies the ttl + hook source, logs the singular form", async () => {
		const session = bSession();
		const out = await enter(
			ctx0(),
			{ session_id: "s1", tool_input: { name: "deep-research", ttl_seconds: 120, source: "hook" } },
			session,
		);
		expect(out).toEqual({ decision: "allow" });
		// Real recordSkillEnter ran against the session.
		expect(session.active_skills?.get("deep-research")?.source).toBe("hook");
		expect(bLog.some((l) => l.includes("SkillEnter: deep-research (hook, 1 session)"))).toBe(true);
	});

	it("accepts the 'manual' source and a default ttl when ttl_seconds is omitted", async () => {
		const session = bSession();
		await enter(ctx0(), { session_id: "s1", tool_input: { name: "verify", source: "manual" } }, session);
		expect(session.active_skills?.get("verify")?.source).toBe("manual");
	});

	it("degrades an unknown source to 'cli'", async () => {
		const session = bSession();
		await enter(ctx0(), { session_id: "s1", tool_input: { name: "x", source: "bogus" } }, session);
		expect(session.active_skills?.get("x")?.source).toBe("cli");
	});

	it("broadcasts to all live sessions (plural log) when session_id is absent", async () => {
		const all = [bSession({ session_id: "a" }), bSession({ session_id: "b" })];
		const ctx = ctx0({ sessions: bSessions({ getAll: vi.fn(() => all) }) });
		await enter(ctx, { session_id: "", tool_input: { name: "broad" } });
		expect(nonNull(all[0]).active_skills?.has("broad")).toBe(true);
		expect(nonNull(all[1]).active_skills?.has("broad")).toBe(true);
		expect(bLog.some((l) => l.includes("SkillEnter: broad (cli, 2 sessions)"))).toBe(true);
	});
});

// ───────────────────────────── handleSkillLeave ───────────────────────────
describe("SkillLeave handler — branch coverage", () => {
	function leave(ctx: ServerRuntime, event: Partial<HarnessEvent> = {}, session = bSession()) {
		return handleLifecycleEvent(ctx, bEvent({ hook_event: "SkillLeave", ...event }), session);
	}

	it("returns a warning when the name is missing", async () => {
		const out = await leave(bCtx(), { tool_input: {} });
		expect(out).toEqual({
			decision: "allow",
			warnings: ["SkillLeave: missing tool_input.name"],
		});
	});

	it("removes from the scoped session and logs the singular count when one is removed", async () => {
		// Seed an active skill so the real recordSkillLeave returns true.
		const session = bSession({
			active_skills: new Map([
				["x", { name: "x", entered_at: 0, expires_at: Date.now() + 60_000, source: "cli" }],
			]),
		});
		const out = await leave(ctx0(), { session_id: "s1", tool_input: { name: "x" } }, session);
		expect(out).toEqual({ decision: "allow" });
		expect(session.active_skills?.has("x")).toBe(false);
		expect(bLog.some((l) => l.includes("SkillLeave: x (removed from 1 session)"))).toBe(true);
	});

	it("broadcasts and logs the plural count, only counting successful removals", async () => {
		const future = Date.now() + 60_000;
		const withSkill = (id: string) =>
			bSession({
				session_id: id,
				active_skills: new Map([["y", { name: "y", entered_at: 0, expires_at: future, source: "cli" }]]),
			});
		// Third session lacks the skill, so its removal returns false.
		const all = [withSkill("a"), withSkill("b"), bSession({ session_id: "c" })];
		const ctx = ctx0({ sessions: bSessions({ getAll: vi.fn(() => all) }) });
		await leave(ctx, { session_id: "", tool_input: { name: "y" } });
		expect(bLog.some((l) => l.includes("SkillLeave: y (removed from 2 sessions)"))).toBe(true);
	});
});

// ───────────────────────────── handleSkillList ────────────────────────────
describe("SkillList handler — branch coverage", () => {
	function list(ctx: ServerRuntime, event: Partial<HarnessEvent> = {}, session = bSession()) {
		return handleLifecycleEvent(ctx, bEvent({ hook_event: "SkillList", ...event }), session);
	}

	it("serializes active skills for the scoped session into additional_context", async () => {
		const future = Date.now() + 60_000;
		const session = bSession({
			session_id: "s1",
			agent_name: "agent-a",
			active_skills: new Map([
				["verify", { name: "verify", entered_at: 1, expires_at: future, source: "cli" }],
			]),
		});
		const out = await list(ctx0(), { session_id: "s1" }, session);
		expect(out?.decision).toBe("allow");
		const parsed = jsonRecords(JSON.parse(nonNull(out?.additional_context)));
		expect(parsed).toHaveLength(1);
		expect(nonNull(parsed[0]).session_id).toBe("s1");
		expect(jsonRecords(nonNull(parsed[0]).skills).map((s) => s.name)).toEqual(["verify"]);
	});

	it("collects across all live sessions when session_id is absent", async () => {
		const all = [
			bSession({ session_id: "a", agent_name: "A" }),
			bSession({ session_id: "b", agent_name: "B" }),
		];
		const ctx = ctx0({ sessions: bSessions({ getAll: vi.fn(() => all) }) });
		const out = await list(ctx, { session_id: "" });
		const parsed = jsonRecords(JSON.parse(nonNull(out?.additional_context)));
		expect(parsed.map((p) => p.session_id)).toEqual(["a", "b"]);
	});
});

/** Skill suites use the REAL session-state helpers (recordSkillEnter /
 *  recordSkillLeave / getActiveSkills are not mocked), so the ctx just needs
 *  the collaborator surface; `bCtx` already provides it. Aliased for intent. */
function ctx0(over: Partial<ServerRuntime> = {}): ServerRuntime {
	return bCtx(over);
}
