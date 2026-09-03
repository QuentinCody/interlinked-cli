// Behavioral companion tests for lifecycle-stop-warnings.ts.
//
// Strategy: the module under test is pure orchestration — every branch is
// driven by (a) config flags on `ctx.rules`, (b) the null/string return of
// an imported formatter/detector, or (c) the presence/absence of a session
// field consumed through `??`. We `vi.mock` each imported helper module so
// every formatter outcome is controllable, then assert the module's real
// outputs (returned strings, pushed warnings, log lines, mutated session
// state). No timers, network, or fs are touched; the mocks make the suite
// fully deterministic.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock every imported helper module ------------------------------------

vi.mock("../commit-cadence.js", () => ({
	collectWipCommitSubjects: vi.fn(),
	formatStopNudge: vi.fn(),
	formatWipCommitsNudge: vi.fn(),
	readSessionTokens: vi.fn(),
}));
// `checkDeadOnArrival` and `checkFixtureLeaks` were relocated INTO these two
// modules alongside their own detect/format pair (line-cap pressure — see
// each module's own history comment), so `buildVerificationStopWarnings` now
// imports and calls them directly instead of composing the mocked leaves
// itself. The old two-export factory left checkX as `undefined`, which every
// test reaching either call path threw on ("No \"checkDeadOnArrival\"/
// \"checkFixtureLeaks\" export is defined on the mock") — the drift this
// repo's own vitest.stryker.config.ts run surfaces as a whole-file dry-run
// failure, not a timeout.
//
// Tried `importOriginal` (vitest's own suggested fix) first and it does NOT
// work here: the real checkX's internal calls to detectX/formatX are
// same-module references that never route through vi.mock's external-import
// interception, so `mDetectDeadOnArrival.mockReturnValue(...)` etc. below
// would silently never reach it (proven live: the aggregation-order test's
// "W5"/"W8" entries went missing — the real detect/format ran against fake
// paths and found nothing). Hand-composing checkX to call THESE SAME vi.fn()
// leaves instead reproduces the real function body exactly (cwd resolution,
// log line, null short-circuit) while staying controllable by every existing
// mDetectX/mFormatX assertion, unchanged.
vi.mock("../dead-on-arrival.js", () => {
	const detectDeadOnArrival = vi.fn();
	const formatDeadOnArrivalWarning = vi.fn();
	return {
		detectDeadOnArrival,
		formatDeadOnArrivalWarning,
		checkDeadOnArrival: vi.fn(
			(ctx: ServerRuntime, event: HarnessEvent, session: SessionTrajectory) => {
				const cwd = event.cwd || ctx.cwd;
				const doaHits = detectDeadOnArrival(session.files_written, cwd);
				const warning = formatDeadOnArrivalWarning(doaHits, cwd);
				if (warning === null) return null;
				ctx.log(`Verify-before-stop: dead-on-arrival (${doaHits.length})`);
				return warning;
			},
		),
	};
});
vi.mock("../fixture-leak.js", () => {
	const detectFixtureLeaks = vi.fn();
	const formatFixtureLeakWarning = vi.fn();
	return {
		detectFixtureLeaks,
		formatFixtureLeakWarning,
		checkFixtureLeaks: vi.fn((ctx: ServerRuntime, event: HarnessEvent) => {
			const leaks = detectFixtureLeaks(event.cwd || ctx.cwd);
			const warning = formatFixtureLeakWarning({ leaks });
			if (warning === null) return null;
			ctx.log(`Verify-before-stop: fixture-leaks (${leaks.length})`);
			return warning;
		}),
	};
});
vi.mock("../slow-test-stop-check.js", () => {
	const detectSlowTests = vi.fn();
	const formatSlowTestsWarning = vi.fn();
	return {
		detectSlowTests,
		formatSlowTestsWarning,
		checkSlowTests: vi.fn(
			(ctx: ServerRuntime, event: HarnessEvent, session: SessionTrajectory) => {
				// Mirrors the real function's self-gating contract: the config
				// read lives in checkSlowTests, not in the wiring file.
				if (ctx.rules.verification_stop_checks?.warn_slow_tests === false) return null;
				const cwd = event.cwd || ctx.cwd;
				const hits = detectSlowTests({ cwd, sessionStartedAt: session.started_at });
				const warning = formatSlowTestsWarning({ hits });
				if (warning === null) return null;
				ctx.log(`Verify-before-stop: slow-tests (${hits.length})`);
				return warning;
			},
		),
	};
});
vi.mock("../untested-exports-stop-check.js", () => ({
	detectUntestedExports: vi.fn(),
	formatUntestedExportsWarning: vi.fn(),
}));
vi.mock("../verification-stop-checks.js", () => ({
	countCodeFilesEdited: vi.fn(),
	countDocFactSourcesEdited: vi.fn(),
	countUiFilesEdited: vi.fn(),
	// Default 0 verify commands; `vi.clearAllMocks()` in beforeEach preserves
	// this implementation. Override per-test via vi.mocked() if a case needs it.
	countVerifyCommands: vi.fn(() => 0),
	formatBisectNotResetWarning: vi.fn(),
	formatDeferredCoverageWarning: vi.fn(),
	formatDocMarkerDriftWarning: vi.fn(),
	formatStubsIntroducedWarning: vi.fn(),
	formatTddRegressionWarning: vi.fn(),
	formatUiNotInteractedWarning: vi.fn(),
	formatUnresolvedRedWarning: vi.fn(),
	formatUnverifiedCodeWarning: vi.fn(),
	formatVerifyNotRunWarning: vi.fn(),
	readDeferredCoverageObligations: vi.fn(),
}));

import {
	collectWipCommitSubjects,
	formatStopNudge,
	formatWipCommitsNudge,
	readSessionTokens,
} from "../commit-cadence.js";
import {
	detectDeadOnArrival,
	formatDeadOnArrivalWarning,
} from "../dead-on-arrival.js";
import { detectFixtureLeaks, formatFixtureLeakWarning } from "../fixture-leak.js";
import { ALL_TESTS_SENTINEL } from "../server-tdd-cycle.js";
import { detectSlowTests, formatSlowTestsWarning } from "../slow-test-stop-check.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import {
	detectUntestedExports,
	formatUntestedExportsWarning,
} from "../untested-exports-stop-check.js";
import {
	countCodeFilesEdited,
	countDocFactSourcesEdited,
	countUiFilesEdited,
	formatBisectNotResetWarning,
	formatDeferredCoverageWarning,
	formatDocMarkerDriftWarning,
	formatStubsIntroducedWarning,
	formatTddRegressionWarning,
	formatUiNotInteractedWarning,
	formatUnresolvedRedWarning,
	formatUnverifiedCodeWarning,
	formatVerifyNotRunWarning,
	readDeferredCoverageObligations,
} from "../verification-stop-checks.js";
import {
	buildCommitCadenceNudge,
	buildStaleBaselineNudge,
	buildVerificationStopWarnings,
} from "./lifecycle-stop-warnings.js";
// pushIfNotNull's only external consumer is this test file, so it's imported
// directly from its home module (line-cap split, 2026-09) rather than kept
// re-exported from the parent barrel for no external reader.
import { pushIfNotNull } from "./lifecycle-stop-warnings-code-file-verification.js";
import type { ServerRuntime } from "./runtime-context.js";

// Typed handles to the mocked functions.
const mFormatStopNudge = vi.mocked(formatStopNudge);
const mReadSessionTokens = vi.mocked(readSessionTokens);
const mCollectWipCommitSubjects = vi.mocked(collectWipCommitSubjects);
const mFormatWipCommitsNudge = vi.mocked(formatWipCommitsNudge);
const mDetectUntestedExports = vi.mocked(detectUntestedExports);
const mFormatUntestedExportsWarning = vi.mocked(formatUntestedExportsWarning);
const mDetectDeadOnArrival = vi.mocked(detectDeadOnArrival);
const mFormatDeadOnArrivalWarning = vi.mocked(formatDeadOnArrivalWarning);
const mDetectFixtureLeaks = vi.mocked(detectFixtureLeaks);
const mFormatFixtureLeakWarning = vi.mocked(formatFixtureLeakWarning);
const mDetectSlowTests = vi.mocked(detectSlowTests);
const mFormatSlowTestsWarning = vi.mocked(formatSlowTestsWarning);
const mCountCodeFilesEdited = vi.mocked(countCodeFilesEdited);
const mCountDocFactSourcesEdited = vi.mocked(countDocFactSourcesEdited);
const mCountUiFilesEdited = vi.mocked(countUiFilesEdited);
const mFormatBisectNotResetWarning = vi.mocked(formatBisectNotResetWarning);
const mFormatDeferredCoverageWarning = vi.mocked(formatDeferredCoverageWarning);
const mReadDeferredCoverageObligations = vi.mocked(readDeferredCoverageObligations);
const mFormatDocMarkerDriftWarning = vi.mocked(formatDocMarkerDriftWarning);
const mFormatStubsIntroducedWarning = vi.mocked(formatStubsIntroducedWarning);
const mFormatTddRegressionWarning = vi.mocked(formatTddRegressionWarning);
const mFormatUnresolvedRedWarning = vi.mocked(formatUnresolvedRedWarning);
const mFormatUiNotInteractedWarning = vi.mocked(formatUiNotInteractedWarning);
const mFormatUnverifiedCodeWarning = vi.mocked(formatUnverifiedCodeWarning);
const mFormatVerifyNotRunWarning = vi.mocked(formatVerifyNotRunWarning);

// ---- Fixtures --------------------------------------------------------------

const logLines: string[] = [];

function makeCtx(over: Record<string, unknown> = {}): ServerRuntime {
	const base = {
		cwd: "/repo",
		rules: {},
		log: (msg: string) => {
			logLines.push(msg);
		},
		logAlways: () => {},
	};
	return { ...base, ...over } as unknown as ServerRuntime;
}

function makeEvent(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "Stop",
		session_id: "s1",
		agent_source: "claude",
		timestamp: "2026-06-05T00:00:00.000Z",
		...over,
	};
}

/** Minimal SessionTrajectory carrying only the fields the module reads. The
 *  cast lets us omit the ~40 unrelated fields. */
function makeSession(over: Record<string, unknown> = {}): SessionTrajectory {
	const base = {
		stop_nudge_emitted: false,
		non_doc_files_edited_since_commit: new Set<string>(),
		doc_files_edited_since_commit: 0,
		verification_observed: new Set<string>(),
		stubs_introduced: [],
		tdd_cycles: new Map(),
		commands_run: [],
		files_written: new Set<string>(),
	};
	return { ...base, ...over } as unknown as SessionTrajectory;
}

beforeEach(() => {
	logLines.length = 0;
	vi.clearAllMocks();
	// Safe defaults: every formatter returns null (no warning) and every
	// detector returns an empty array unless a test overrides it. This makes
	// each branch test isolate a single firing path.
	mFormatStopNudge.mockReturnValue(null);
	mReadSessionTokens.mockReturnValue(null);
	mCollectWipCommitSubjects.mockReturnValue([]);
	mFormatWipCommitsNudge.mockReturnValue(null);
	mDetectUntestedExports.mockReturnValue([]);
	mFormatUntestedExportsWarning.mockReturnValue(null);
	mDetectDeadOnArrival.mockReturnValue([]);
	mFormatDeadOnArrivalWarning.mockReturnValue(null);
	mDetectFixtureLeaks.mockReturnValue([]);
	mFormatFixtureLeakWarning.mockReturnValue(null);	mDetectSlowTests.mockReturnValue([]);
	mFormatSlowTestsWarning.mockReturnValue(null);
	mCountCodeFilesEdited.mockReturnValue(0);
	mCountDocFactSourcesEdited.mockReturnValue(0);
	mCountUiFilesEdited.mockReturnValue(0);
	mFormatBisectNotResetWarning.mockReturnValue(null);
	mReadDeferredCoverageObligations.mockReturnValue([]);
	mFormatDeferredCoverageWarning.mockReturnValue(null);
	mFormatDocMarkerDriftWarning.mockReturnValue(null);
	mFormatStubsIntroducedWarning.mockReturnValue(null);
	mFormatTddRegressionWarning.mockReturnValue(null);
	mFormatUnresolvedRedWarning.mockReturnValue(null);
	mFormatUiNotInteractedWarning.mockReturnValue(null);
	mFormatUnverifiedCodeWarning.mockReturnValue(null);
	mFormatVerifyNotRunWarning.mockReturnValue(null);
});

// ===========================================================================
// pushIfNotNull
// ===========================================================================
describe("pushIfNotNull", () => {
	it("pushes a non-null string", () => {
		const arr: string[] = [];
		pushIfNotNull(arr, "x");
		expect(arr).toEqual(["x"]);
	});

	it("pushes an empty string (only null is excluded)", () => {
		const arr: string[] = [];
		pushIfNotNull(arr, "");
		expect(arr).toEqual([""]);
	});

	it("does not push null", () => {
		const arr: string[] = ["existing"];
		pushIfNotNull(arr, null);
		expect(arr).toEqual(["existing"]);
	});
});

// ===========================================================================
// buildCommitCadenceNudge
// ===========================================================================
describe("buildCommitCadenceNudge", () => {
	it("returns null when commit_cadence config is absent (cadenceCfg?.enabled undefined)", () => {
		const ctx = makeCtx({ rules: {} });
		expect(buildCommitCadenceNudge(ctx, makeEvent(), makeSession())).toBeNull();
		expect(mFormatStopNudge).not.toHaveBeenCalled();
	});

	it("returns null when commit_cadence.enabled is false", () => {
		const ctx = makeCtx({ rules: { commit_cadence: { enabled: false } } });
		expect(buildCommitCadenceNudge(ctx, makeEvent(), makeSession())).toBeNull();
	});

	it("returns null when session is falsy", () => {
		const ctx = makeCtx({ rules: { commit_cadence: { enabled: true } } });
		// session arg null exercises the `!session` short-circuit.
		expect(
			buildCommitCadenceNudge(ctx, makeEvent(), null as unknown as SessionTrajectory),
		).toBeNull();
	});

	it("returns null when the nudge was already emitted this session", () => {
		const ctx = makeCtx({ rules: { commit_cadence: { enabled: true } } });
		const session = makeSession({ stop_nudge_emitted: true });
		expect(buildCommitCadenceNudge(ctx, makeEvent(), session)).toBeNull();
		expect(mFormatStopNudge).not.toHaveBeenCalled();
	});

	it("returns null (without mutating state) when formatStopNudge returns null", () => {
		const ctx = makeCtx({
			rules: {
				commit_cadence: {
					enabled: true,
					stop_threshold: 5,
					token_band_low: 10,
					token_band_high: 20,
				},
			},
		});
		const session = makeSession();
		mFormatStopNudge.mockReturnValue(null);
		expect(buildCommitCadenceNudge(ctx, makeEvent(), session)).toBeNull();
		expect(session.stop_nudge_emitted).toBe(false);
		expect(logLines).toHaveLength(0);
	});

	it("returns the nudge, marks stop_nudge_emitted, and logs on success", () => {
		const ctx = makeCtx({
			rules: {
				commit_cadence: {
					enabled: true,
					stop_threshold: 3,
					token_band_low: 100,
					token_band_high: 200,
				},
			},
		});
		const session = makeSession({
			non_doc_files_edited_since_commit: new Set(["a.ts", "b.ts"]),
			doc_files_edited_since_commit: 4,
		});
		mReadSessionTokens.mockReturnValue({ total: 1234 } as ReturnType<
			typeof readSessionTokens
		>);
		mFormatStopNudge.mockReturnValue("NUDGE-TEXT");

		const result = buildCommitCadenceNudge(ctx, makeEvent(), session);

		expect(result).toBe("NUDGE-TEXT");
		expect(session.stop_nudge_emitted).toBe(true);
		// The cumulative-tokens-defined branch passes cumulativeTokens through.
		expect(mFormatStopNudge).toHaveBeenCalledWith({
			uncommittedNonDocCount: 2,
			docFilesExcluded: 4,
			threshold: 3,
			cumulativeTokens: 1234,
			tokenBandLow: 100,
			tokenBandHigh: 200,
		});
		expect(logLines[0]).toContain("Commit-cadence Stop nudge: 2 uncommitted code files");
		expect(logLines[0]).toContain("4 doc files excluded");
		expect(logLines[0]).toContain("tokens=1234");
	});

	it("omits cumulativeTokens when readSessionTokens returns null and logs tokens=n/a", () => {
		const ctx = makeCtx({
			rules: {
				commit_cadence: {
					enabled: true,
					stop_threshold: 0,
					token_band_low: 1,
					token_band_high: 2,
				},
			},
		});
		const session = makeSession();
		mReadSessionTokens.mockReturnValue(null);
		mFormatStopNudge.mockReturnValue("N");

		buildCommitCadenceNudge(ctx, makeEvent(), session);

		// The spread `...(cumulativeTokens !== undefined ? {...} : {})` must omit
		// the key entirely when tokens are absent.
		const arg = mFormatStopNudge.mock.calls[0]?.[0];
		expect(arg).toBeDefined();
		expect(Object.hasOwn(arg as object, "cumulativeTokens")).toBe(false);
		expect(logLines[0]).toContain("tokens=n/a");
	});

	it("passes the provider so the token reader rejects Codex before filesystem I/O", () => {
		const ctx = makeCtx({
			rules: {
				commit_cadence: {
					enabled: true,
					stop_threshold: 0,
					token_band_low: 1,
					token_band_high: 2,
				},
			},
		});
		mFormatStopNudge.mockReturnValue("N");

		buildCommitCadenceNudge(
			ctx,
			makeEvent({ agent_source: "codex", transcript_path: "/huge/codex-rollout.jsonl" }),
			makeSession(),
		);

		expect(mReadSessionTokens).toHaveBeenCalledWith(
			"/huge/codex-rollout.jsonl",
			"codex",
		);
		expect(mFormatStopNudge).toHaveBeenCalledWith(
			expect.not.objectContaining({ cumulativeTokens: expect.anything() }),
		);
	});

	it("treats a tokens object without a total as undefined cumulativeTokens", () => {
		const ctx = makeCtx({
			rules: {
				commit_cadence: {
					enabled: true,
					stop_threshold: 0,
					token_band_low: 1,
					token_band_high: 2,
				},
			},
		});
		const session = makeSession();
		// tokens defined but .total undefined -> cumulativeTokens === undefined.
		mReadSessionTokens.mockReturnValue({ total: undefined } as unknown as ReturnType<
			typeof readSessionTokens
		>);
		mFormatStopNudge.mockReturnValue("N");

		buildCommitCadenceNudge(ctx, makeEvent(), session);

		const arg = mFormatStopNudge.mock.calls[0]?.[0];
		expect(Object.hasOwn(arg as object, "cumulativeTokens")).toBe(false);
		// `tokens?.total ?? "n/a"` -> total is undefined -> "n/a".
		expect(logLines[0]).toContain("tokens=n/a");
	});

	it("defaults counts to 0 when the session count fields are absent (?? fallbacks)", () => {
		const ctx = makeCtx({
			rules: {
				commit_cadence: {
					enabled: true,
					stop_threshold: 0,
					token_band_low: 1,
					token_band_high: 2,
				},
			},
		});
		// Omit non_doc_files_edited_since_commit and doc_files_edited_since_commit.
		const session = makeSession({
			non_doc_files_edited_since_commit: undefined,
			doc_files_edited_since_commit: undefined,
		});
		mFormatStopNudge.mockReturnValue("N");

		buildCommitCadenceNudge(ctx, makeEvent(), session);

		expect(mFormatStopNudge).toHaveBeenCalledWith(
			expect.objectContaining({ uncommittedNonDocCount: 0, docFilesExcluded: 0 }),
		);
	});
});

// ===========================================================================
// buildVerificationStopWarnings
// ===========================================================================
describe("buildVerificationStopWarnings", () => {
	function vscRules(over: Record<string, unknown> = {}) {
		return {
			verification_stop_checks: {
				enabled: true,
				warn_unverified_code: false,
				warn_verify_not_run: false,
				warn_ui_not_interacted: false,
				warn_stubs_introduced: false,
				warn_fixture_leaks: false,
				warn_unresolved_red: false,
				...over,
			},
		};
	}

	it("returns [] when verification_stop_checks config is absent", () => {
		const ctx = makeCtx({ rules: {} });
		expect(buildVerificationStopWarnings(ctx, makeEvent(), makeSession())).toEqual([]);
	});

	it("returns [] when verification_stop_checks.enabled is false", () => {
		const ctx = makeCtx({ rules: { verification_stop_checks: { enabled: false } } });
		expect(buildVerificationStopWarnings(ctx, makeEvent(), makeSession())).toEqual([]);
	});

	it("returns [] when session is falsy", () => {
		const ctx = makeCtx({ rules: vscRules() });
		expect(
			buildVerificationStopWarnings(
				ctx,
				makeEvent(),
				null as unknown as SessionTrajectory,
			),
		).toEqual([]);
	});

	it("returns [] when all flag-gated checks are off and the always-on checks find nothing", () => {
		const ctx = makeCtx({ rules: vscRules() });
		expect(buildVerificationStopWarnings(ctx, makeEvent(), makeSession())).toEqual([]);
		// Flag-gated formatters must NOT be invoked when their flag is false.
		expect(mFormatUnverifiedCodeWarning).not.toHaveBeenCalled();
		expect(mFormatVerifyNotRunWarning).not.toHaveBeenCalled();
		expect(mFormatUiNotInteractedWarning).not.toHaveBeenCalled();
		expect(mFormatStubsIntroducedWarning).not.toHaveBeenCalled();
		expect(mFormatFixtureLeakWarning).not.toHaveBeenCalled();
		// warn_unresolved_red defaults off in vscRules → its formatter must not run.
		expect(mFormatUnresolvedRedWarning).not.toHaveBeenCalled();
		// per_edit_coverage absent in vscRules → the deferred-coverage gate is off.
		expect(mReadDeferredCoverageObligations).not.toHaveBeenCalled();
		expect(mFormatDeferredCoverageWarning).not.toHaveBeenCalled();
		// Always-on checks still run.
		expect(mFormatTddRegressionWarning).toHaveBeenCalled();
		expect(mFormatBisectNotResetWarning).toHaveBeenCalled();
		expect(mFormatDeadOnArrivalWarning).toHaveBeenCalled();
		expect(mFormatDocMarkerDriftWarning).toHaveBeenCalled();
	});

	it("defaults verification_observed to an empty Set when the session field is absent", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unverified_code: true }) });
		const session = makeSession({ verification_observed: undefined });
		mCountCodeFilesEdited.mockReturnValue(2);
		mFormatUnverifiedCodeWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent(), session);

		const arg = mFormatUnverifiedCodeWarning.mock.calls[0]?.[0];
		expect(arg?.verificationObserved).toBeInstanceOf(Set);
		expect(arg?.verificationObserved.size).toBe(0);
	});

	// --- individual flag-gated checks fire when their formatter returns text ---

	it("includes the unverified-code warning when its flag is on and formatter fires (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unverified_code: true }) });
		const session = makeSession({ verification_observed: new Set(["tsc"]) });
		mCountCodeFilesEdited.mockReturnValue(3);
		mFormatUnverifiedCodeWarning.mockReturnValue("UNVERIFIED");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("UNVERIFIED");
		expect(mFormatUnverifiedCodeWarning).toHaveBeenCalledWith({
			codeFilesEdited: 3,
			verifyCommandCount: 0,
			verificationObserved: session.verification_observed,
		});
		expect(logLines.some((l) => l.includes("unverified-code (3 files, signals=tsc)"))).toBe(
			true,
		);
	});

	it("includes the verify-not-run warning when its flag is on and formatter fires", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_verify_not_run: true }) });
		const session = makeSession();
		mCountCodeFilesEdited.mockReturnValue(1);
		mFormatVerifyNotRunWarning.mockReturnValue("VERIFY-NOT-RUN");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("VERIFY-NOT-RUN");
		// signals=none branch of the log join (empty Set -> "" -> "none").
		expect(logLines.some((l) => l.includes("verify-suite-not-run") && l.includes("signals=none"))).toBe(true);
	});

	// --- single-nudge invariant: the two verify-before-stop cadence nudges never co-emit ---

	it("suppresses verify-not-run when unverified-code already fired (no double nudge)", () => {
		const ctx = makeCtx({
			rules: vscRules({ warn_unverified_code: true, warn_verify_not_run: true }),
		});
		const session = makeSession({ verification_observed: new Set(["typecheck"]) });
		mCountCodeFilesEdited.mockReturnValue(20);
		mFormatUnverifiedCodeWarning.mockReturnValue("UNVERIFIED");
		mFormatVerifyNotRunWarning.mockReturnValue("VERIFY-NOT-RUN");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("UNVERIFIED");
		expect(out).not.toContain("VERIFY-NOT-RUN");
		// The stronger nudge fired, so verify-not-run must not even be computed.
		expect(mFormatVerifyNotRunWarning).not.toHaveBeenCalled();
	});

	it("still runs verify-not-run when unverified-code did NOT fire", () => {
		const ctx = makeCtx({
			rules: vscRules({ warn_unverified_code: true, warn_verify_not_run: true }),
		});
		const session = makeSession({ verification_observed: new Set(["typecheck"]) });
		mCountCodeFilesEdited.mockReturnValue(5);
		mFormatUnverifiedCodeWarning.mockReturnValue(null); // unverified-code stays quiet
		mFormatVerifyNotRunWarning.mockReturnValue("VERIFY-NOT-RUN");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("VERIFY-NOT-RUN");
		expect(mFormatVerifyNotRunWarning).toHaveBeenCalled();
	});

	it("includes the ui-not-interacted warning when its flag is on and formatter fires (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_ui_not_interacted: true }) });
		const session = makeSession();
		mCountUiFilesEdited.mockReturnValue(2);
		mFormatUiNotInteractedWarning.mockReturnValue("UI-NOT-INTERACTED");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("UI-NOT-INTERACTED");
		expect(mFormatUiNotInteractedWarning).toHaveBeenCalledWith({
			uiFilesEdited: 2,
			verificationObserved: session.verification_observed,
		});
		expect(logLines.some((l) => l.includes("ui-not-interacted (2 files)"))).toBe(true);
	});

	it("does not include / log ui-not-interacted when its formatter returns null", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_ui_not_interacted: true }) });
		mCountUiFilesEdited.mockReturnValue(5);
		mFormatUiNotInteractedWarning.mockReturnValue(null);

		const out = buildVerificationStopWarnings(ctx, makeEvent(), makeSession());

		expect(out).toEqual([]);
		expect(logLines.some((l) => l.includes("ui-not-interacted"))).toBe(false);
	});

	it("includes the stubs-introduced warning when its flag is on and formatter fires (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_stubs_introduced: true }) });
		const session = makeSession({ stubs_introduced: [{ x: 1 }, { x: 2 }] });
		mFormatStubsIntroducedWarning.mockReturnValue("STUBS");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("STUBS");
		expect(mFormatStubsIntroducedWarning).toHaveBeenCalledWith({
			stubs: session.stubs_introduced,
		});
		expect(logLines.some((l) => l.includes("stubs-introduced (2)"))).toBe(true);
	});

	it("defaults stubs to [] when stubs_introduced is absent", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_stubs_introduced: true }) });
		const session = makeSession({ stubs_introduced: undefined });
		mFormatStubsIntroducedWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(mFormatStubsIntroducedWarning).toHaveBeenCalledWith({ stubs: [] });
	});

	it("includes the fixture-leak warning when its flag is on and formatter fires (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_fixture_leaks: true }) });
		mDetectFixtureLeaks.mockReturnValue([{ a: 1 }, { b: 2 }, { c: 3 }] as never);
		mFormatFixtureLeakWarning.mockReturnValue("FIXTURE-LEAK");

		const out = buildVerificationStopWarnings(
			ctx,
			makeEvent({ cwd: "/event-cwd" }),
			makeSession(),
		);

		expect(out).toContain("FIXTURE-LEAK");
		// event.cwd is preferred over ctx.cwd.
		expect(mDetectFixtureLeaks).toHaveBeenCalledWith("/event-cwd");
		expect(logLines.some((l) => l.includes("fixture-leaks (3)"))).toBe(true);
	});

	it("falls back to ctx.cwd for fixture leaks when event.cwd is absent", () => {
		const ctx = makeCtx({ cwd: "/ctx-cwd", rules: vscRules({ warn_fixture_leaks: true }) });
		mFormatFixtureLeakWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent({}), makeSession());

		expect(mDetectFixtureLeaks).toHaveBeenCalledWith("/ctx-cwd");
	});

	it("includes the slow-test warning when its flag is on and formatter fires (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_slow_tests: true }) });
		mDetectSlowTests.mockReturnValue([{ file: "a.test.ts" }] as never);
		mFormatSlowTestsWarning.mockReturnValue("SLOW-TEST");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), makeSession());

		expect(out).toContain("SLOW-TEST");
		expect(logLines.some((l) => l.includes("slow-tests (1)"))).toBe(true);
	});

	it("omits the slow-test warning when warn_slow_tests is explicitly false", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_slow_tests: false }) });
		mFormatSlowTestsWarning.mockReturnValue("SLOW-TEST");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), makeSession());

		expect(out).not.toContain("SLOW-TEST");
		expect(mDetectSlowTests).not.toHaveBeenCalled();
	});

	// --- always-on checks ---

	it("includes the tdd-regression warning, counting only regression-state cycles (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules() });
		const tdd = new Map<string, unknown>([
			["a", { state: "regression", source_file: "/a.ts" }],
			["b", { state: "green", source_file: "/b.ts" }],
			["c", { state: "regression", source_file: "/c.ts" }],
		]);
		const session = makeSession({ tdd_cycles: tdd });
		mFormatTddRegressionWarning.mockReturnValue("TDD-REGRESSION");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("TDD-REGRESSION");
		// Only the two regression cycles are forwarded.
		expect(mFormatTddRegressionWarning).toHaveBeenCalledWith({
			regressions: [{ sourceFile: "/a.ts" }, { sourceFile: "/c.ts" }],
		});
		expect(logLines.some((l) => l.includes("tdd-regression (2)"))).toBe(true);
	});

	it("forwards an empty regressions list when no cycle is in regression state", () => {
		const ctx = makeCtx({ rules: vscRules() });
		const tdd = new Map<string, unknown>([["b", { state: "green", source_file: "/b.ts" }]]);
		mFormatTddRegressionWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent(), makeSession({ tdd_cycles: tdd }));

		expect(mFormatTddRegressionWarning).toHaveBeenCalledWith({ regressions: [] });
		expect(logLines.some((l) => l.includes("tdd-regression"))).toBe(false);
	});

	it("does not report suite-sourced fan-out as per-file regressions", () => {
		const ctx = makeCtx({ rules: vscRules() });
		const tdd = new Map<string, unknown>([
			[
				"a",
				{
					state: "regression",
					source_file: "/a.ts",
					test_file: "/a.test.ts",
					red_at: 10,
				},
			],
			[
				"b",
				{
					state: "regression",
					source_file: "/b.ts",
					test_file: "/b.test.ts",
					red_at: 11,
				},
			],
		]);
		const testRuns = new Map([
			[ALL_TESTS_SENTINEL, { status: "fail" as const, at_step: 10 }],
			["/b.test.ts", { status: "fail" as const, at_step: 11 }],
		]);
		mFormatTddRegressionWarning.mockReturnValue("TDD-REGRESSION");

		buildVerificationStopWarnings(
			ctx,
			makeEvent(),
			makeSession({ tdd_cycles: tdd, test_runs: testRuns }),
		);

		expect(mFormatTddRegressionWarning).toHaveBeenCalledWith({
			regressions: [{ sourceFile: "/b.ts" }],
		});
		expect(logLines.some((l) => l.includes("tdd-regression (1)"))).toBe(true);
	});

	it("includes the bisect-not-reset warning when its formatter fires (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules() });
		const session = makeSession({ commands_run: ["git bisect start"] });
		mFormatBisectNotResetWarning.mockReturnValue("BISECT");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("BISECT");
		expect(mFormatBisectNotResetWarning).toHaveBeenCalledWith({
			commandsRun: session.commands_run,
		});
		expect(logLines.some((l) => l.includes("bisect-not-reset"))).toBe(true);
	});

	it("includes the dead-on-arrival warning, preferring event.cwd (+logs)", () => {
		const ctx = makeCtx({ cwd: "/ctx", rules: vscRules() });
		const session = makeSession({ files_written: new Set(["/x.ts"]) });
		mDetectDeadOnArrival.mockReturnValue([{ file: "/x.ts" }, { file: "/y.ts" }] as never);
		mFormatDeadOnArrivalWarning.mockReturnValue("DOA");

		const out = buildVerificationStopWarnings(ctx, makeEvent({ cwd: "/ev" }), session);

		expect(out).toContain("DOA");
		expect(mDetectDeadOnArrival).toHaveBeenCalledWith(session.files_written, "/ev");
		expect(mFormatDeadOnArrivalWarning).toHaveBeenCalledWith(
			[{ file: "/x.ts" }, { file: "/y.ts" }],
			"/ev",
		);
		expect(logLines.some((l) => l.includes("dead-on-arrival (2)"))).toBe(true);
	});

	it("falls back to ctx.cwd for dead-on-arrival when event.cwd is absent", () => {
		const ctx = makeCtx({ cwd: "/ctx-doa", rules: vscRules() });
		mFormatDeadOnArrivalWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent({}), makeSession());

		expect(mDetectDeadOnArrival).toHaveBeenCalledWith(expect.any(Set), "/ctx-doa");
	});

	it("includes the doc-marker-drift warning when its formatter fires (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules() });
		const session = makeSession({ commands_run: ["docs:build"] });
		mCountDocFactSourcesEdited.mockReturnValue(4);
		mFormatDocMarkerDriftWarning.mockReturnValue("DOC-DRIFT");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("DOC-DRIFT");
		expect(mFormatDocMarkerDriftWarning).toHaveBeenCalledWith({
			docSourcesEdited: 4,
			commandsRun: session.commands_run,
		});
		expect(logLines.some((l) => l.includes("doc-marker-drift (4 source files)"))).toBe(true);
	});

	it("aggregates every warning in registration order when all checks fire", () => {
		const ctx = makeCtx({
			rules: vscRules({
				warn_unverified_code: true,
				warn_verify_not_run: true,
				warn_ui_not_interacted: true,
				warn_stubs_introduced: true,
				warn_fixture_leaks: true,
			}),
		});
		const session = makeSession({
			verification_observed: new Set(["lint"]),
			stubs_introduced: [{ x: 1 }],
			tdd_cycles: new Map([["a", { state: "regression", source_file: "/a.ts" }]]),
			files_written: new Set(["/f.ts"]),
		});
		mCountCodeFilesEdited.mockReturnValue(1);
		mCountUiFilesEdited.mockReturnValue(1);
		mCountDocFactSourcesEdited.mockReturnValue(1);
		mDetectFixtureLeaks.mockReturnValue([{ a: 1 }] as never);
		mDetectDeadOnArrival.mockReturnValue([{ f: 1 }] as never);
		mFormatUnverifiedCodeWarning.mockReturnValue("W1");
		mFormatVerifyNotRunWarning.mockReturnValue("W2");
		mFormatUiNotInteractedWarning.mockReturnValue("W3");
		mFormatStubsIntroducedWarning.mockReturnValue("W4");
		mFormatFixtureLeakWarning.mockReturnValue("W5");
		mFormatTddRegressionWarning.mockReturnValue("W6");
		mFormatBisectNotResetWarning.mockReturnValue("W7");
		mFormatDeadOnArrivalWarning.mockReturnValue("W8");
		mFormatDocMarkerDriftWarning.mockReturnValue("W9");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		// Order matches the pushIfNotNull call sequence in the source.
		// warn_unresolved_red is off (vscRules default) so it's absent here.
		// W2 (verify-not-run) is absent by the single-nudge invariant: W1
		// (unverified-code) fired, which suppresses verify-not-run so the two
		// verify-before-stop cadence nudges never co-emit (see the dedicated
		// mutual-exclusion tests above).
		expect(out).toEqual(["W1", "W3", "W4", "W5", "W6", "W7", "W8", "W9"]);
	});

	// --- warn_unresolved_red gated wrapper (checkUnresolvedRed) -------------

	it("does not invoke the unresolved-red formatter when the flag is off", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: false }) });
		const session = makeSession({
			observed_checks: new Map([["typecheck", { kind: "typecheck", status: "red" }]]),
		});
		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);
		expect(mFormatUnresolvedRedWarning).not.toHaveBeenCalled();
		expect(out).toEqual([]);
	});

	it("forwards a red observed-check (kind + detail) when the flag is on (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: true }) });
		const session = makeSession({
			observed_checks: new Map([
				["typecheck", { kind: "typecheck", status: "red", detail: "tsc --noEmit" }],
				["lint", { kind: "lint", status: "green" }],
			]),
		});
		mFormatUnresolvedRedWarning.mockReturnValue("UNRESOLVED-RED");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("UNRESOLVED-RED");
		// Only the red check is forwarded; the green one is filtered out.
		expect(mFormatUnresolvedRedWarning).toHaveBeenCalledWith({
			redChecks: [{ kind: "typecheck", detail: "tsc --noEmit" }],
			redTests: [],
		});
		expect(logLines.some((l) => l.includes("unresolved-red (1 checks, 0 tests)"))).toBe(true);
	});

	it("forwards a stayed-red TDD cycle but EXCLUDES regression-state cycles", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: true }) });
		const tdd = new Map<string, unknown>([
			// stayed-red: state red, never went green → forwarded.
			["a", { state: "red", source_file: "/a.ts", red_at: 5 }],
			// regression (green→red): owned by checkTddRegression → excluded.
			["b", { state: "regression", source_file: "/b.ts", red_at: 7, green_at: 3 }],
		]);
		mFormatUnresolvedRedWarning.mockReturnValue("UNRESOLVED-RED");

		buildVerificationStopWarnings(ctx, makeEvent(), makeSession({ tdd_cycles: tdd }));

		expect(mFormatUnresolvedRedWarning).toHaveBeenCalledWith({
			redChecks: [],
			redTests: [{ sourceFile: "/a.ts" }],
		});
	});

	it("forwards a stayed-red cycle whose green_at predates red_at (green_at < red_at)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: true }) });
		const tdd = new Map<string, unknown>([
			// An earlier green followed by a later red still counts as stayed-red:
			// green_at(2) < red_at(10) -> the comparison operand is true.
			["a", { state: "red", source_file: "/a.ts", red_at: 10, green_at: 2 }],
		]);
		mFormatUnresolvedRedWarning.mockReturnValue("UNRESOLVED-RED");

		buildVerificationStopWarnings(ctx, makeEvent(), makeSession({ tdd_cycles: tdd }));

		expect(mFormatUnresolvedRedWarning).toHaveBeenCalledWith({
			redChecks: [],
			redTests: [{ sourceFile: "/a.ts" }],
		});
	});

	it("collapses suite-sourced stayed-red fan-out into one aggregate suite failure", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: true }) });
		const tdd = new Map<string, unknown>([
			[
				"a",
				{
					state: "red",
					source_file: "/a.ts",
					test_file: "/a.test.ts",
					red_at: 974,
				},
			],
		]);
		const testRuns = new Map([
			[ALL_TESTS_SENTINEL, { status: "fail" as const, at_step: 974 }],
		]);
		mFormatUnresolvedRedWarning.mockReturnValue("UNRESOLVED-RED");

		buildVerificationStopWarnings(
			ctx,
			makeEvent(),
			makeSession({
				tdd_cycles: tdd,
				test_runs: testRuns,
				observed_checks: undefined,
			}),
		);

		expect(mFormatUnresolvedRedWarning).toHaveBeenCalledWith({
			redChecks: [{ kind: "test-suite" }],
			redTests: [],
		});
		expect(
			logLines.some((line) => line.includes("unresolved-red (1 checks, 0 tests)")),
		).toBe(true);
	});

	it("defaults a missing red_at to 0 when comparing against green_at (?? fallback)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: true }) });
		const tdd = new Map<string, unknown>([
			// red_at is absent -> (cycle.red_at ?? 0) -> 0; green_at(0) < 0 is false,
			// so this cycle is excluded — exercises the ?? fallback being taken.
			["a", { state: "red", source_file: "/a.ts", green_at: 0 }],
		]);
		mFormatUnresolvedRedWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent(), makeSession({ tdd_cycles: tdd }));

		expect(mFormatUnresolvedRedWarning).toHaveBeenCalledWith({ redChecks: [], redTests: [] });
	});

	it("EXCLUDES a red cycle whose red was later cleared by a green (green_at >= red_at)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: true }) });
		const tdd = new Map<string, unknown>([
			// red_at 4 then green_at 9 cleared it — must NOT be forwarded.
			["a", { state: "red", source_file: "/a.ts", red_at: 4, green_at: 9 }],
		]);
		mFormatUnresolvedRedWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent(), makeSession({ tdd_cycles: tdd }));

		expect(mFormatUnresolvedRedWarning).toHaveBeenCalledWith({ redChecks: [], redTests: [] });
	});

	it("does not push / log when the unresolved-red formatter returns null", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: true }) });
		mFormatUnresolvedRedWarning.mockReturnValue(null);

		const out = buildVerificationStopWarnings(ctx, makeEvent(), makeSession());

		expect(out).toEqual([]);
		expect(logLines.some((l) => l.includes("unresolved-red"))).toBe(false);
	});

	it("tolerates an absent observed_checks map (defaults to empty)", () => {
		const ctx = makeCtx({ rules: vscRules({ warn_unresolved_red: true }) });
		const session = makeSession({ observed_checks: undefined });
		mFormatUnresolvedRedWarning.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(mFormatUnresolvedRedWarning).toHaveBeenCalledWith({ redChecks: [], redTests: [] });
	});

	// --- WIP-commit cleanup nudge wiring (checkWipCommits, backlog 3B) ------

	/** Session that committed this session: baseline sha + a git-commit command. */
	function wipSession(over: Record<string, unknown> = {}): SessionTrajectory {
		return makeSession({
			git_session_baseline: { head_sha: "abc123" },
			commands_run: ["git commit -m 'wip'"],
			...over,
		});
	}

	it("includes the wip-commits nudge when the session committed and WIP subjects exist (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules() });
		mCollectWipCommitSubjects.mockReturnValue(["wip: parser", "tmp checkpoint"]);
		mFormatWipCommitsNudge.mockReturnValue("WIP-COMMITS");

		const out = buildVerificationStopWarnings(ctx, makeEvent({ cwd: "/ev" }), wipSession());

		expect(out).toContain("WIP-COMMITS");
		// event.cwd is preferred over ctx.cwd; range starts at the baseline sha.
		expect(mCollectWipCommitSubjects).toHaveBeenCalledWith("/ev", "abc123");
		expect(mFormatWipCommitsNudge).toHaveBeenCalledWith({
			wipSubjects: ["wip: parser", "tmp checkpoint"],
		});
		expect(logLines.some((l) => l.includes("wip-commits (2)"))).toBe(true);
	});

	it("falls back to ctx.cwd for wip-commits when event.cwd is absent", () => {
		const ctx = makeCtx({ cwd: "/ctx-wip", rules: vscRules() });
		mFormatWipCommitsNudge.mockReturnValue(null);

		buildVerificationStopWarnings(ctx, makeEvent({}), wipSession());

		expect(mCollectWipCommitSubjects).toHaveBeenCalledWith("/ctx-wip", "abc123");
	});

	it("never shells out when the session has no git_session_baseline", () => {
		const ctx = makeCtx({ rules: vscRules() });
		const session = wipSession({ git_session_baseline: undefined });

		expect(buildVerificationStopWarnings(ctx, makeEvent(), session)).toEqual([]);
		expect(mCollectWipCommitSubjects).not.toHaveBeenCalled();
	});

	it("never shells out when no git-commit-shaped command ran this session (read-only Stop)", () => {
		const ctx = makeCtx({ rules: vscRules() });
		const session = wipSession({ commands_run: ["git status", "npx vitest run"] });

		expect(buildVerificationStopWarnings(ctx, makeEvent(), session)).toEqual([]);
		expect(mCollectWipCommitSubjects).not.toHaveBeenCalled();
	});

	it("does not push / log when the wip-commits formatter returns null (no WIP subjects)", () => {
		const ctx = makeCtx({ rules: vscRules() });
		mCollectWipCommitSubjects.mockReturnValue([]);
		mFormatWipCommitsNudge.mockReturnValue(null);

		const out = buildVerificationStopWarnings(ctx, makeEvent(), wipSession());

		expect(out).toEqual([]);
		expect(logLines.some((l) => l.includes("wip-commits"))).toBe(false);
	});

	// --- untested-exports nudge wiring (checkUntestedExports, backlog 3D) ---

	it("includes the untested-exports warning when detector + formatter fire (+logs)", () => {
		const ctx = makeCtx({ rules: vscRules() });
		const hits = [{ sourcePath: "/ev/src/thing.ts", symbols: ["doThing"] }];
		mDetectUntestedExports.mockReturnValue(hits);
		mFormatUntestedExportsWarning.mockReturnValue("UNTESTED-EXPORTS");

		const session = makeSession({ files_written: new Set(["/ev/src/thing.ts"]) });
		const out = buildVerificationStopWarnings(ctx, makeEvent({ cwd: "/ev" }), session);

		expect(out).toContain("UNTESTED-EXPORTS");
		// event.cwd is preferred; files_written + a lazy graph provider are passed.
		expect(mDetectUntestedExports).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/ev",
				filesWritten: session.files_written,
				getGraph: expect.any(Function),
				readFile: expect.any(Function),
			}),
		);
		expect(mFormatUntestedExportsWarning).toHaveBeenCalledWith(hits, "/ev");
		expect(logLines.some((l) => l.includes("untested-exports (1 files)"))).toBe(true);
	});

	it("falls back to ctx.cwd for untested-exports when event.cwd is absent", () => {
		const ctx = makeCtx({ cwd: "/ctx-untested", rules: vscRules() });

		buildVerificationStopWarnings(ctx, makeEvent({}), makeSession());

		expect(mDetectUntestedExports).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/ctx-untested" }),
		);
	});

	it("does not push / log when the untested-exports formatter returns null", () => {
		const ctx = makeCtx({ rules: vscRules() });
		mDetectUntestedExports.mockReturnValue([]);
		mFormatUntestedExportsWarning.mockReturnValue(null);

		const out = buildVerificationStopWarnings(ctx, makeEvent(), makeSession());

		expect(out).toEqual([]);
		expect(logLines.some((l) => l.includes("untested-exports"))).toBe(false);
	});

	it("wires readFile to succeed on a real file and fail-open (null) on an unreadable one", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const evCwd = mkdtempSync(join(tmpdir(), "untested-exports-readfile-"));
		try {
			const realFile = join(evCwd, "dependent.test.ts");
			writeFileSync(realFile, "import './thing.js';\n");
			const ctx = makeCtx({ rules: vscRules(), graphCache: new Map() });
			mFormatUntestedExportsWarning.mockReturnValue(null);

			buildVerificationStopWarnings(ctx, makeEvent({ cwd: evCwd }), makeSession());

			const arg = mDetectUntestedExports.mock.calls[0]?.[0];
			expect(arg).toBeDefined();
			// Success path: real content comes back verbatim (try branch, line 421).
			expect(arg?.readFile(realFile)).toBe("import './thing.js';\n");
			// Fail-open path: a nonexistent path is caught and yields null (line 423),
			// not a thrown exception.
			expect(arg?.readFile(join(evCwd, "does-not-exist.ts"))).toBeNull();
		} finally {
			rmSync(evCwd, { recursive: true, force: true });
		}
	});

	it("wires getGraph to lazily build a real ProjectGraph via getGraphForFile", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const evCwd = mkdtempSync(join(tmpdir(), "untested-exports-getgraph-"));
		try {
			writeFileSync(join(evCwd, "package.json"), "{}");
			const graphCache = new Map();
			const ctx = makeCtx({ rules: vscRules(), graphCache });
			mFormatUntestedExportsWarning.mockReturnValue(null);

			buildVerificationStopWarnings(ctx, makeEvent({ cwd: evCwd }), makeSession());

			const arg = mDetectUntestedExports.mock.calls[0]?.[0];
			expect(arg).toBeDefined();
			const graph = arg?.getGraph();
			expect(graph).toBeDefined();
			// getGraphForFile caches by resolved project root — calling again hits
			// the cache and returns the identical instance.
			expect(arg?.getGraph()).toBe(graph);
		} finally {
			rmSync(evCwd, { recursive: true, force: true });
		}
	});

	// --- per_edit_coverage-gated wrapper (checkDeferredCoverage) ------------

	/** vscRules merged with a `per_edit_coverage` block so the deferred-coverage
	 *  wrapper's gate can be toggled. The producer flag is `enabled`. */
	function coverageRules(peEnabled: boolean, vscOver: Record<string, unknown> = {}) {
		return {
			...vscRules(vscOver),
			per_edit_coverage: { enabled: peEnabled, mode: "block", budget_ms: 25_000, languages: [] },
		};
	}

	it("does not read the ledger or invoke the formatter when per_edit_coverage is absent", () => {
		// vscRules() has no per_edit_coverage block → gate off → no read, no call.
		const ctx = makeCtx({ rules: vscRules() });
		const out = buildVerificationStopWarnings(ctx, makeEvent(), makeSession());
		expect(mReadDeferredCoverageObligations).not.toHaveBeenCalled();
		expect(mFormatDeferredCoverageWarning).not.toHaveBeenCalled();
		expect(out).toEqual([]);
	});

	it("does not read the ledger or invoke the formatter when per_edit_coverage.enabled is false", () => {
		const ctx = makeCtx({ rules: coverageRules(false) });
		const out = buildVerificationStopWarnings(ctx, makeEvent(), makeSession());
		expect(mReadDeferredCoverageObligations).not.toHaveBeenCalled();
		expect(mFormatDeferredCoverageWarning).not.toHaveBeenCalled();
		expect(out).toEqual([]);
	});

	it("reads the ledger by ctx.cwd + session_id and includes the warning when it fires (+logs)", () => {
		const ctx = makeCtx({ cwd: "/cov-root", rules: coverageRules(true) });
		const session = makeSession({ session_id: "sess-7" });
		const obligations = [
			{ kind: "coverage", file: "src/a.ts", session_id: "sess-7" },
			{ kind: "coverage", file: "src/b.ts", session_id: "sess-7" },
		];
		mReadDeferredCoverageObligations.mockReturnValue(obligations as never);
		mFormatDeferredCoverageWarning.mockReturnValue("DEFERRED-COVERAGE");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toContain("DEFERRED-COVERAGE");
		// Read scoped to the daemon cwd and the session's own id.
		expect(mReadDeferredCoverageObligations).toHaveBeenCalledWith("/cov-root", "sess-7");
		expect(mFormatDeferredCoverageWarning).toHaveBeenCalledWith({ obligations });
		expect(logLines.some((l) => l.includes("deferred-coverage (2 unmet)"))).toBe(true);
	});

	it("does not push / log when the deferred-coverage formatter returns null (no obligations)", () => {
		const ctx = makeCtx({ rules: coverageRules(true) });
		mReadDeferredCoverageObligations.mockReturnValue([]);
		mFormatDeferredCoverageWarning.mockReturnValue(null);

		const out = buildVerificationStopWarnings(ctx, makeEvent(), makeSession());

		expect(out).toEqual([]);
		expect(mFormatDeferredCoverageWarning).toHaveBeenCalledWith({ obligations: [] });
		expect(logLines.some((l) => l.includes("deferred-coverage"))).toBe(false);
	});

	it("fires INDEPENDENTLY of the vsc warn flags — all warn_* off, coverage on still nudges", () => {
		// Proves the deferred-coverage gate is per_edit_coverage.enabled, not a
		// vsc warn flag: every warn_* is false here yet the nudge still appears.
		const ctx = makeCtx({ rules: coverageRules(true) });
		mReadDeferredCoverageObligations.mockReturnValue([
			{ kind: "coverage", file: "src/a.ts", session_id: "s1" },
		] as never);
		mFormatDeferredCoverageWarning.mockReturnValue("DEFERRED-COVERAGE");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), makeSession());

		expect(out).toEqual(["DEFERRED-COVERAGE"]);
	});

	it("still fires the existing red nudge unchanged alongside the deferred-coverage nudge", () => {
		// Regression guard: adding the deferred-coverage wrapper must not disturb
		// the sibling unresolved-red nudge. Both on → both present, in source order
		// (unresolved-red is pushed before deferred-coverage).
		const ctx = makeCtx({ rules: coverageRules(true, { warn_unresolved_red: true }) });
		const session = makeSession({
			observed_checks: new Map([["typecheck", { kind: "typecheck", status: "red" }]]),
		});
		mFormatUnresolvedRedWarning.mockReturnValue("UNRESOLVED-RED");
		mReadDeferredCoverageObligations.mockReturnValue([
			{ kind: "coverage", file: "src/a.ts", session_id: "s1" },
		] as never);
		mFormatDeferredCoverageWarning.mockReturnValue("DEFERRED-COVERAGE");

		const out = buildVerificationStopWarnings(ctx, makeEvent(), session);

		expect(out).toEqual(["UNRESOLVED-RED", "DEFERRED-COVERAGE"]);
	});
});

// ===========================================================================
// buildStaleBaselineNudge — real fs, no mocks (baseline-staleness.js untouched)
// ===========================================================================
describe("buildStaleBaselineNudge", () => {
	it("fires on a fresh cwd (no baselines, no marker) and writes the nudge marker", async () => {
		const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const cwd = mkdtempSync(join(tmpdir(), "stale-baseline-"));
		try {
			// No .interlinked dir exists yet: shouldNudge -> true (no marker),
			// formatStaleBaselineWarning -> non-null (every tracked baseline is
			// "never generated" = stale), and the marker writeFileSync throws
			// (parent dir absent) — exercised via the catch { void err }.
			const ctx = makeCtx({ cwd });
			const warning = buildStaleBaselineNudge(ctx, makeEvent());
			expect(warning).not.toBeNull();
			expect(warning).toContain("[interlinked:baseline-staleness]");
			expect(existsSync(join(cwd, ".interlinked"))).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("stays silent for a read-only session (sessionWroteFiles=false) even when every baseline is stale — repo-housekeeping nudges address sessions doing repo work (2026-08-23 operator report)", async () => {
		const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const cwd = mkdtempSync(join(tmpdir(), "stale-baseline-readonly-"));
		try {
			// Same maximally-stale fixture as the positive case above; the only
			// difference is the read-only flag, so silence here pins the guard.
			const ctx = makeCtx({ cwd });
			expect(buildStaleBaselineNudge(ctx, makeEvent(), false)).toBeNull();
			// The throttle marker must NOT be consumed by a silent skip.
			expect(existsSync(join(cwd, ".interlinked"))).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("fires and successfully writes the marker when .interlinked/ already exists", async () => {
		const { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } = await import(
			"node:fs"
		);
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const cwd = mkdtempSync(join(tmpdir(), "stale-baseline-write-"));
		try {
			mkdirSync(join(cwd, ".interlinked"), { recursive: true });
			const ctx = makeCtx({ cwd });
			const warning = buildStaleBaselineNudge(ctx, makeEvent());
			expect(warning).not.toBeNull();
			const markerPath = join(cwd, ".interlinked", ".baseline-staleness-nudged");
			expect(existsSync(markerPath)).toBe(true);
			expect(readFileSync(markerPath, "utf-8").trim().length).toBeGreaterThan(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("returns null (shouldNudge=false) when the marker was written moments ago", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const cwd = mkdtempSync(join(tmpdir(), "stale-baseline-throttled-"));
		try {
			mkdirSync(join(cwd, ".interlinked"), { recursive: true });
			writeFileSync(
				join(cwd, ".interlinked", ".baseline-staleness-nudged"),
				`${new Date().toISOString()}\n`,
			);
			const ctx = makeCtx({ cwd });
			expect(buildStaleBaselineNudge(ctx, makeEvent())).toBeNull();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("returns null (formatter=null) when every tracked baseline file is fresh", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const cwd = mkdtempSync(join(tmpdir(), "stale-baseline-fresh-"));
		try {
			const dir = join(cwd, ".interlinked");
			mkdirSync(dir, { recursive: true });
			for (const f of [
				"coverage-baseline.json",
				"coverage-edit-baseline.json",
				"mutation-baseline.json",
				"untested-files-baseline.json",
			]) {
				writeFileSync(join(dir, f), "{}");
			}
			const ctx = makeCtx({ cwd });
			expect(buildStaleBaselineNudge(ctx, makeEvent())).toBeNull();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("resolves interlinkedDir from event.cwd, preferring it over ctx.cwd", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const eventCwd = mkdtempSync(join(tmpdir(), "stale-baseline-eventcwd-"));
		try {
			const dir = join(eventCwd, ".interlinked");
			mkdirSync(dir, { recursive: true });
			for (const f of [
				"coverage-baseline.json",
				"coverage-edit-baseline.json",
				"mutation-baseline.json",
				"untested-files-baseline.json",
			]) {
				writeFileSync(join(dir, f), "{}");
			}
			// ctx.cwd points somewhere else entirely (never used since event.cwd wins).
			const ctx = makeCtx({ cwd: "/nonexistent-ctx-cwd" });
			expect(buildStaleBaselineNudge(ctx, makeEvent({ cwd: eventCwd }))).toBeNull();
		} finally {
			rmSync(eventCwd, { recursive: true, force: true });
		}
	});
});

// ===========================================================================
// checkReviewFindings — open ingested review findings (real corpus, unmocked)
// ===========================================================================
describe("checkReviewFindings", () => {
	it("surfaces open ingested findings at Stop and honors the off switch", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { ingestReviewReport } = await import("../../commands/findings.js");
		const { resetReviewReconcileCacheForTesting } = await import(
			"./review-reconcile-phase.js"
		);
		const cwd = mkdtempSync(join(tmpdir(), "stop-review-"));
		// `ingestReviewReport` → `recordFinding` mirrors into
		// `~/.interlinked/findings-corpus.jsonl` unless INTERLINKED_HOME redirects
		// it. The tmp `cwd` covers only the per-repo corpus; the global mirror
		// resolves its own path and swallows every error, so the leak is silent
		// and this test passed while appending a row to the real user corpus on
		// every run (measured 2026-08-09). Same fix as `src/commands/findings.test.ts`.
		const fakeHome = mkdtempSync(join(tmpdir(), "stop-review-home-"));
		const prevInterlinkedHome = process.env.INTERLINKED_HOME;
		process.env.INTERLINKED_HOME = fakeHome;
		try {
			resetReviewReconcileCacheForTesting();
			writeFileSync(
				join(cwd, "r.md"),
				"1. [high] [docs/plan.md:5] Ordering is wrong.\nTOTAL: 1\n",
			);
			ingestReviewReport(join(cwd, "r.md"), "sol", cwd);
			const ctx = makeCtx({
				cwd,
				rules: { verification_stop_checks: { enabled: true } },
			});
			const out = buildVerificationStopWarnings(ctx, makeEvent(), makeSession());
			expect(out.some((w) => w.includes("[interlinked:review-findings]"))).toBe(true);

			const off = makeCtx({
				cwd,
				rules: {
					verification_stop_checks: { enabled: true, warn_review_findings: false },
				},
			});
			expect(
				buildVerificationStopWarnings(off, makeEvent(), makeSession()).some((w) =>
					w.includes("review-findings"),
				),
			).toBe(false);
		} finally {
			resetReviewReconcileCacheForTesting();
			rmSync(cwd, { recursive: true, force: true });
			rmSync(fakeHome, { recursive: true, force: true });
			if (prevInterlinkedHome === undefined) delete process.env.INTERLINKED_HOME;
			else process.env.INTERLINKED_HOME = prevInterlinkedHome;
		}
	});
});

// ===========================================================================
// checkSpecDrift — outstanding cross-file spec drift (real formatter, unmocked)
// ===========================================================================
describe("checkSpecDrift", () => {
	const drift = [
		{ file: "README.md", line: 2, message: '"six bets" vs the B census: 7 ids' },
	];

	it("surfaces the spec-drift stash at Stop", () => {
		const ctx = makeCtx({
			rules: { verification_stop_checks: { enabled: true } },
		});
		const out = buildVerificationStopWarnings(
			ctx,
			makeEvent(),
			makeSession({ spec_drift_outstanding: drift }),
		);
		const line = out.find((w) => w.includes("[interlinked:spec-drift]"));
		expect(line).toBeDefined();
		expect(line).toContain("README.md:2");
	});

	it("stays silent when the stash is empty or warn_spec_drift is false", () => {
		const ctx = makeCtx({
			rules: { verification_stop_checks: { enabled: true } },
		});
		expect(
			buildVerificationStopWarnings(
				ctx,
				makeEvent(),
				makeSession({ spec_drift_outstanding: [] }),
			).some((w) => w.includes("spec-drift")),
		).toBe(false);

		const off = makeCtx({
			rules: {
				verification_stop_checks: { enabled: true, warn_spec_drift: false },
			},
		});
		expect(
			buildVerificationStopWarnings(
				off,
				makeEvent(),
				makeSession({ spec_drift_outstanding: drift }),
			).some((w) => w.includes("spec-drift")),
		).toBe(false);
	});
});
