import { makeEventLoopDeps, makeServerRuntime } from "./server/__tests__/fixtures.js";
import { readJsonRecord } from "./server/__tests__/json.js";
import { makeSession, makeEvent } from "./__tests__/fixtures/evaluator.js";
// Behavioral tests for the harness server event loop (`createEventLoop`).
//
// The factory closes over a bag of sibling-module functions and `deps`
// callbacks. Most sibling imports are mocked so each branch (parse failure,
// lazy hydrate, lifecycle early-return, Pre/Post dispatch, non-tool allow,
// latency-append failure, snapshot write/serialize failure, framed error
// rethrow) can be driven deterministically and asserted on real outputs +
// real call effects — no source-text scraping anywhere, and no network.
//
// TWO deliberate exceptions, because the wiring under test IS the effect:
//   * `./replay/harness-clock.js` (G4) — the frozen-clock branch is asserted
//     on the real millisecond value `harnessNow()` returns INSIDE the
//     pipeline, so these tests read the real wall clock.
//   * `./replay/tree-snapshot.js` (G2) — the snapshot branch is asserted on
//     real rows written by real `git` subprocesses into a throwaway repo
//     under `tmpdir()`, so these tests do real fs + spawn real `git`.
//
// Ambient-state hygiene (both exceptions read process state directly):
//   * INTERLINKED_REPLAY_CLOCK / INTERLINKED_REPLAY_TREE_SNAPSHOTS are
//     shipped daemon operating modes read straight off `process.env` by the
//     SUT. A root beforeEach clears both, and every test that needs one sets
//     it explicitly through `withEnv` — running the suite under either mode
//     must not change a verdict.
//   * git inherits `process.env` and the user's global/system config in BOTH
//     the fixture and the SUT, so both go through `HERMETIC_GIT_ENV`
//     (config neutralized, GIT_DIR/GIT_INDEX_FILE/... cleared, identity
//     pinned) — the fixture repo cannot be reached by ambient git state.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../lib/json-types.js";
import { readLocalActivity } from "../lib/local-activity.js";
import { nonNull } from "../lib/non-null.js";
import { createCodexAdapter } from "./adapters/codex.js";
import { writeLifecycleActivityRecord } from "./server/activity-writer.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "./types.js";

// ---- mock every sibling module the loop imports ---------------------------

vi.mock("./cloud-forward.js", () => ({
	forwardCloudPreToolUse: vi.fn(),
}));
vi.mock("./latency-log.js", () => ({
	appendLatencyLog: vi.fn(),
}));
vi.mock("./legacy-client.js", () => ({
	toLegacyHarnessEvent: vi.fn(),
}));
vi.mock("./live-snapshot.js", () => ({
	readLiveSnapshot: vi.fn(),
	writeLiveSnapshot: vi.fn(),
}));
vi.mock("./server/latency-record.js", () => ({
	buildLatencyRecord: vi.fn(),
}));
vi.mock("./server/lifecycle-events.js", () => ({
	handleLifecycleEvent: vi.fn(),
}));
vi.mock("./server/post-tool-pipeline.js", () => ({
	POST_TOOL_PIPELINE_FAILURE_WARNING:
		"[interlinked:post-tool-pipeline] [proven] NOT CHECKED: PostToolUse checks failed before producing a verdict; run 'interlinked verify' before treating this edit as clean.",
	runPostToolPipeline: vi.fn(),
}));
vi.mock("./server/pre-tool-pipeline.js", () => ({
	runPreToolPipeline: vi.fn(),
}));
vi.mock("./server/protocol-status.js", () => ({
	recordProtocolEvent: vi.fn(),
	writeProtocolStatus: vi.fn(),
}));

// `isPreToolUse` / `isPostToolUse` are pure — use the real impls so the
// hook_event → branch mapping is exercised end-to-end.


// Pull the mocked references so individual tests can program return values.
import { forwardCloudPreToolUse } from "./cloud-forward.js";
import { appendLatencyLog } from "./latency-log.js";
import { toLegacyHarnessEvent } from "./legacy-client.js";
import { readLiveSnapshot, writeLiveSnapshot } from "./live-snapshot.js";
// The G4 clock and the G2 replay-snapshot writers are NOT mocked — the loop's
// clock-freeze and snapshot-wiring branches are asserted through their real
// effects (a frozen `harnessNow()` reading; snapshot rows on disk).
import { harnessNow } from "./replay/harness-clock.js";
import { buildLatencyRecord } from "./server/latency-record.js";
import { handleLifecycleEvent } from "./server/lifecycle-events.js";
import { runPostToolPipeline } from "./server/post-tool-pipeline.js";
import { runPreToolPipeline } from "./server/pre-tool-pipeline.js";
import {
	recordProtocolEvent as bumpProtocolEvent,
	writeProtocolStatus as persistProtocolStatus,
} from "./server/protocol-status.js";
import { createEventLoop } from "./server-event-loop.js";

const mForward = vi.mocked(forwardCloudPreToolUse);
const mAppendLatency = vi.mocked(appendLatencyLog);
const mToLegacy = vi.mocked(toLegacyHarnessEvent);
const mReadSnap = vi.mocked(readLiveSnapshot);
const mWriteSnap = vi.mocked(writeLiveSnapshot);
const mBuildLatency = vi.mocked(buildLatencyRecord);
const mLifecycle = vi.mocked(handleLifecycleEvent);
const mPostPipeline = vi.mocked(runPostToolPipeline);
const mPrePipeline = vi.mocked(runPreToolPipeline);
const mBump = vi.mocked(bumpProtocolEvent);
const mPersist = vi.mocked(persistProtocolStatus);

const ALLOW: HarnessDecision = { decision: "allow" };
const { buildLatencyRecord: actualBuildLatency } = await vi.importActual<typeof import("./server/latency-record.js")>("./server/latency-record.js");
const { toLegacyHarnessEvent: actualToLegacy } = await vi.importActual<typeof import("./legacy-client.js")>("./legacy-client.js");

// ---- fakes for ctx + deps -------------------------------------------------

function makeHarness(cwd = "/repo") {
 const log = vi.fn();
 const sessionMap = new Map<string, SessionTrajectory>();
 const sessions = { get: vi.fn((id: string) => sessionMap.get(id)), hydrate: vi.fn((_snap: JsonObject): SessionTrajectory | null => null), recordEvent: vi.fn((event: HarnessEvent) => ({ ...makeSession(), session_id: event.session_id })), nextSeq: vi.fn((_id: string) => 1), serialize: vi.fn((_id: string): JsonObject | null => ({ snap: true })) };
 const ctx = makeServerRuntime({ cwd, interlinkedDir: cwd + "/.interlinked", log, sessions });
 const deps = makeEventLoopDeps({ ctx });
 return { deps, ctx, sessions, sessionMap, log, protocolStatus: deps.protocolStatus };
}

function preEvent(extra: Partial<HarnessEvent> = {}): string {
	return JSON.stringify({
		hook_event: "PreToolUse",
		session_id: "s1",
		tool_name: "Bash",
		tool_input: { command: "ls" },
		...extra,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	// Sensible defaults: no lifecycle short-circuit, pipelines allow, cloud
	// passthrough, snapshot writes succeed, latency record is a stub object.
	mLifecycle.mockResolvedValue(null);
	mPrePipeline.mockResolvedValue(ALLOW);
	mPostPipeline.mockResolvedValue(ALLOW);
	mForward.mockImplementation(async (_e, local) => local);
	mWriteSnap.mockReturnValue({ ok: true });
	mReadSnap.mockReturnValue(null);
	mBuildLatency.mockImplementation(actualBuildLatency);
	mToLegacy.mockImplementation(actualToLegacy);
});

// ---- ambient replay-env neutralization ------------------------------------
// `replayClockFor` and `maybeRecordReplaySnapshots` read these two straight
// off `process.env`, and both are documented, shipped daemon modes — so a
// developer (or a CI lane) running with `INTERLINKED_REPLAY_CLOCK=event` set
// would otherwise silently change what this file asserts. Cleared before
// every test, restored after; the tests that need a value set it via
// `withEnv`, which nests correctly on top of this cleared baseline.
const REPLAY_ENV_KEYS = [
	"INTERLINKED_REPLAY_CLOCK",
	"INTERLINKED_REPLAY_TREE_SNAPSHOTS",
] as const;
const savedReplayEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of REPLAY_ENV_KEYS) {
		savedReplayEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of REPLAY_ENV_KEYS) {
		const prior = savedReplayEnv[key];
		if (prior === undefined) delete process.env[key];
		else process.env[key] = prior;
	}
});

describe("createEventLoop — public surface", () => {
	it("returns the three entry points", () => {
		const loop = createEventLoop(makeHarness().deps);
		expect(typeof loop.evaluateEventLine).toBe("function");
		expect(typeof loop.evaluateUnifiedViaRuntime).toBe("function");
		expect(typeof loop.writeProtocolStatus).toBe("function");
	});

	it("writeProtocolStatus persists the in-memory status to its path", () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);
		loop.writeProtocolStatus();
		expect(mPersist).toHaveBeenCalledWith(h.deps.protocolStatusPath, h.protocolStatus);
	});
});

describe("processEvent — parse + dispatch (via evaluateEventLine)", () => {
	it("blocks on malformed JSON and logs the parse failure", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine("{not json", "raw");

		expect(decision).toEqual({
			decision: "block",
			reason: "Malformed event — cannot evaluate safety.",
		});
		expect(h.log).toHaveBeenCalledWith(expect.stringContaining("Event parse failed:"));
		// Even a parse failure still counts as a processed protocol event +
		// writes a latency record.
		expect(mBump).toHaveBeenCalledWith(h.protocolStatus, "raw");
		expect(mAppendLatency).toHaveBeenCalledTimes(1);
		// Malformed payload never reached recordEvent / pipelines.
		expect(h.sessions.recordEvent).not.toHaveBeenCalled();
		expect(mPrePipeline).not.toHaveBeenCalled();
	});

	it("surfaces the non-Error cause via String() in the parse-failure log", async () => {
		const h = makeHarness();
		// Force every JSON.parse to throw a non-Error. evaluateEventLine's
		// up-front session_id parse throws first (swallowed by `void e`), then
		// processEvent's parse throws the same non-Error and exercises the
		// `String(cause)` branch of the parse-failure log.
		const spy = vi.spyOn(JSON, "parse").mockImplementation(() => {
			throw "boom-string";
		});
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(preEvent(), "raw");

		expect(decision.decision).toBe("block");
		expect(h.log).toHaveBeenCalledWith("Event parse failed: boom-string");
		spy.mockRestore();
	});

	it("resets the idle timer and records the event for a valid payload", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.deps.resetIdleTimer).toHaveBeenCalledOnce();
		expect(h.sessions.recordEvent).toHaveBeenCalledOnce();
		expect(h.sessions.recordEvent).toHaveBeenCalledWith(
			expect.objectContaining({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }),
		);
		expect(h.deps.syncRuntimeIn).toHaveBeenCalledTimes(1);
		expect(h.deps.syncRuntimeOut).toHaveBeenCalledTimes(1);
	});

	it("PreToolUse: runs pre-pipeline, writes collection record, forwards to cloud", async () => {
		const h = makeHarness();
		const blocked: HarnessDecision = { decision: "block", reason: "cloud" };
		mForward.mockResolvedValueOnce(blocked);
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(preEvent(), "raw");

		expect(mPrePipeline).toHaveBeenCalledTimes(1);
		expect(h.deps.writeCollectionRecord).toHaveBeenCalledTimes(1);
		expect(h.deps.writeLifecycleActivityRecord).not.toHaveBeenCalled();
		expect(mForward).toHaveBeenCalledWith(expect.objectContaining({ hook_event: "PreToolUse" }), ALLOW);
		expect(decision).toBe(blocked);
		expect(mPostPipeline).not.toHaveBeenCalled();
	});

	it("PostToolUse: runs post-pipeline, writes collection record, returns its decision", async () => {
		const h = makeHarness();
		const warn: HarnessDecision = { decision: "allow", warnings: ["w"] };
		mPostPipeline.mockResolvedValueOnce(warn);
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(
			preEvent({ hook_event: "PostToolUse" }),
			"framed",
		);

		expect(mPostPipeline).toHaveBeenCalledTimes(1);
		expect(h.deps.writeCollectionRecord).toHaveBeenCalledTimes(1);
		expect(h.deps.writeLifecycleActivityRecord).not.toHaveBeenCalled();
		expect(decision).toBe(warn);
		expect(mForward).not.toHaveBeenCalled();
	});

	it("PostToolUse: fails OPEN (allow) when the post-pipeline throws", async () => {
		// A thrown PostToolUse check used to propagate into a reason-less block
		// (surfaced to users as a spurious "harness bug"). The action already
		// happened, so blocking is wrong — fail open with a warning instead.
		const h = makeHarness();
		mPostPipeline.mockRejectedValueOnce(new Error("check boom"));
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(
			preEvent({ hook_event: "PostToolUse" }),
			"framed",
		);

		expect(decision.decision).toBe("allow");
		expect(decision.warnings?.join(" ")).toContain("NOT CHECKED");
		expect(decision.warnings?.join(" ")).toContain("interlinked verify");
		expect(h.log).toHaveBeenCalledWith(expect.stringContaining("PostToolUse pipeline threw"));
	});

	it("non-tool event (no Pre/Post match) returns a bare allow", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(
			preEvent({ hook_event: "Notification", tool_name: undefined, tool_input: undefined }),
			"raw",
		);

		expect(decision).toEqual({ decision: "allow" });
		expect(mPrePipeline).not.toHaveBeenCalled();
		expect(mPostPipeline).not.toHaveBeenCalled();
		expect(h.deps.writeCollectionRecord).not.toHaveBeenCalled();
		expect(h.deps.writeLifecycleActivityRecord).toHaveBeenCalledWith(
			expect.objectContaining({ hook_event: "Notification" }),
			undefined,
		);
	});

	it("lifecycle decision short-circuits before Pre/Post dispatch", async () => {
		const h = makeHarness();
		const lc: HarnessDecision = { decision: "block", reason: "lifecycle" };
		mLifecycle.mockResolvedValueOnce(lc);
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(
			preEvent({
				hook_event: "UserPromptSubmit",
				tool_name: undefined,
				tool_input: undefined,
				prompt: "hello",
			}),
			"raw",
		);

		expect(decision).toBe(lc);
		expect(mPrePipeline).not.toHaveBeenCalled();
		expect(mPostPipeline).not.toHaveBeenCalled();
		expect(h.deps.writeLifecycleActivityRecord).toHaveBeenCalledWith(
			expect.objectContaining({ hook_event: "UserPromptSubmit", prompt: "hello" }),
			lc,
		);
		// finally still ran.
		expect(h.deps.syncRuntimeOut).toHaveBeenCalledTimes(1);
	});

	it("runs syncRuntimeOut in finally even when a pipeline throws", async () => {
		const h = makeHarness();
		mPrePipeline.mockRejectedValueOnce(new Error("pipeline blew up"));
		const loop = createEventLoop(h.deps);

		await expect(loop.evaluateEventLine(preEvent(), "raw")).rejects.toThrow(
			"pipeline blew up",
		);
		expect(h.deps.syncRuntimeIn).toHaveBeenCalledTimes(1);
		expect(h.deps.syncRuntimeOut).toHaveBeenCalledTimes(1);
	});
});

describe("processEvent — lazy hydrate branch", () => {
	it("hydrates from a live snapshot and logs when restore succeeds", async () => {
		const h = makeHarness();
		mReadSnap.mockReturnValueOnce({ restored: true });
		h.sessions.hydrate.mockReturnValueOnce({ ...makeSession(),
			tool_call_count: 4,
			files_written: new Set(["a.ts", "b.ts"]),
		});
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(mReadSnap).toHaveBeenCalledWith("/repo", "s1");
		expect(h.sessions.hydrate).toHaveBeenCalledWith({ restored: true });
		expect(h.log).toHaveBeenCalledWith(
			expect.stringContaining("Hydrated session s1 from live snapshot (4 tool calls, 2 files written)"),
		);
	});

	it("does not log when a snapshot exists but hydrate returns null", async () => {
		const h = makeHarness();
		mReadSnap.mockReturnValueOnce({ restored: true });
		h.sessions.hydrate.mockReturnValueOnce(null);
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.sessions.hydrate).toHaveBeenCalledTimes(1);
		expect(h.log).not.toHaveBeenCalledWith(expect.stringContaining("Hydrated session"));
	});

	it("skips hydrate entirely when no snapshot is on disk", async () => {
		const h = makeHarness();
		mReadSnap.mockReturnValueOnce(null);
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(mReadSnap).toHaveBeenCalledTimes(1);
		expect(h.sessions.hydrate).not.toHaveBeenCalled();
	});

	it("skips the hydrate lookup when the session is already tracked", async () => {
		const h = makeHarness();
		h.sessionMap.set("s1", makeSession());
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(mReadSnap).not.toHaveBeenCalled();
	});

	it("skips the hydrate lookup when the event has no session_id", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		// session_id "" is falsy → hydrate guard short-circuits.
		await loop.evaluateEventLine(preEvent({ session_id: "" }), "raw");

		expect(mReadSnap).not.toHaveBeenCalled();
	});
});

describe("evaluateEventLine — protocol counter + latency + snapshot durability", () => {
	it("records a framed protocol event and appends the latency record", async () => {
		const h = makeHarness();
		const latency = actualBuildLatency(preEvent(), ALLOW);
		mBuildLatency.mockReturnValueOnce(latency);
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "framed");

		expect(mBump).toHaveBeenCalledWith(h.protocolStatus, "framed");
		// recordProtocolEvent also persists the status after bumping.
		expect(mPersist).toHaveBeenCalled();
		expect(mBuildLatency).toHaveBeenCalledWith(preEvent(), ALLOW);
		expect(mAppendLatency).toHaveBeenCalledWith("/repo/.interlinked", latency);
	});

	it("swallows a latency-append failure without affecting the decision", async () => {
		const h = makeHarness();
		mAppendLatency.mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(preEvent(), "raw");

		expect(decision).toEqual(ALLOW);
		// snapshot durability still ran afterward.
		expect(mWriteSnap).toHaveBeenCalledTimes(1);
	});

	it("writes a live snapshot in the finally block when session_id parses", async () => {
		const h = makeHarness();
		h.sessions.serialize.mockReturnValueOnce({ persisted: true });
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.sessions.serialize).toHaveBeenCalledWith("s1");
		expect(mWriteSnap).toHaveBeenCalledWith("/repo", "s1", { persisted: true });
	});

	it("logs (non-fatal) when the snapshot write reports !ok", async () => {
		const h = makeHarness();
		mWriteSnap.mockReturnValueOnce({ ok: false, error: new Error("EACCES") });
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.log).toHaveBeenCalledWith("Live snapshot write failed (non-fatal): EACCES");
	});

	it("does not write a snapshot when serialize returns null", async () => {
		const h = makeHarness();
		h.sessions.serialize.mockReturnValueOnce(null);
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.sessions.serialize).toHaveBeenCalledWith("s1");
		expect(mWriteSnap).not.toHaveBeenCalled();
	});

	it("logs when serialize throws an Error inside the durability finally", async () => {
		const h = makeHarness();
		h.sessions.serialize.mockImplementationOnce(() => {
			throw new Error("serialize boom");
		});
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.log).toHaveBeenCalledWith("Live snapshot write threw: serialize boom");
	});

	it("stringifies a non-Error throw inside the durability finally", async () => {
		const h = makeHarness();
		h.sessions.serialize.mockImplementationOnce(() => {
			throw "plain-string-throw";
		});
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.log).toHaveBeenCalledWith("Live snapshot write threw: plain-string-throw");
	});

	it("skips the snapshot write when the line has no string session_id", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		// session_id is numeric here → typeof !== "string" → sessionIdForSnap stays null.
		await loop.evaluateEventLine(
			JSON.stringify({ hook_event: "Notification", session_id: 123 }),
			"raw",
		);

		expect(mWriteSnap).not.toHaveBeenCalled();
		expect(h.sessions.serialize).not.toHaveBeenCalled();
	});

	it("P1: skips the snapshot-peek fields but still allows when the line is a valid JSON object", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(preEvent(), "raw");

		expect(decision).toEqual(ALLOW);
		expect(mWriteSnap).toHaveBeenCalledWith("/repo", "s1", { snap: true });
	});

	it("N1: a line that parses to a non-object JSON value (array) never throws and skips the peek", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine("[1,2,3]", "raw");

		expect(decision).toEqual({ decision: "allow" });
		expect(mWriteSnap).not.toHaveBeenCalled();
		expect(h.sessions.serialize).not.toHaveBeenCalled();
	});

	it("swallows a malformed line during the up-front session_id parse (catch void e)", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		// Malformed line: the up-front parse throws (caught), processEvent then
		// blocks. sessionIdForSnap stays null so no snapshot write is attempted.
		const decision = await loop.evaluateEventLine("####", "raw");

		expect(decision.decision).toBe("block");
		expect(mWriteSnap).not.toHaveBeenCalled();
	});

	it("still writes the snapshot in finally when processEvent throws (session captured up-front)", async () => {
		const h = makeHarness();
		mPrePipeline.mockRejectedValueOnce(new Error("kaboom"));
		const loop = createEventLoop(h.deps);

		await expect(loop.evaluateEventLine(preEvent(), "raw")).rejects.toThrow("kaboom");
		// session_id was parsed before the try, so the finally still persists.
		expect(mWriteSnap).toHaveBeenCalledWith("/repo", "s1", { snap: true });
	});
});

describe("evaluateUnifiedViaRuntime", () => {
	it("translates a unified event to legacy and evaluates it as framed", async () => {
		const h = makeHarness();
		const legacy = makeEvent({ hook_event: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
		mToLegacy.mockReturnValueOnce(legacy);
		const loop = createEventLoop(h.deps);

		const unified = createCodexAdapter().parseHookInput({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }, "PreToolUse");
		const decision = await loop.evaluateUnifiedViaRuntime(unified);

		expect(mToLegacy).toHaveBeenCalledWith(unified);
		expect(decision).toEqual(ALLOW);
		// Routed through the framed protocol counter.
		expect(mBump).toHaveBeenCalledWith(h.protocolStatus, "framed");
	});

	it("on translation failure: bumps framed_error_count, persists, and rethrows", async () => {
		const h = makeHarness();
		const err = new Error("legacy convert failed");
		mToLegacy.mockImplementationOnce(() => {
			throw err;
		});
		const loop = createEventLoop(h.deps);

		await expect(loop.evaluateUnifiedViaRuntime(createCodexAdapter().parseHookInput({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }, "PreToolUse"))).rejects.toBe(err);
		expect(h.protocolStatus.framed_error_count).toBe(1);
		expect(mPersist).toHaveBeenCalledWith(h.deps.protocolStatusPath, h.protocolStatus);
		// The error path short-circuits before any event processing.
		expect(h.sessions.recordEvent).not.toHaveBeenCalled();
	});

	it("propagates an error thrown by the inner evaluateEventLine and counts it", async () => {
		const h = makeHarness();
		mToLegacy.mockReturnValueOnce(makeEvent({ hook_event: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }));
		// Make the inner pipeline throw so evaluateEventLine rejects after
		// translation succeeded — exercises the catch wrapping the await.
		mPrePipeline.mockRejectedValueOnce(new Error("inner reject"));
		const loop = createEventLoop(h.deps);

		await expect(loop.evaluateUnifiedViaRuntime(createCodexAdapter().parseHookInput({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }, "PreToolUse"))).rejects.toThrow(
			"inner reject",
		);
		expect(h.protocolStatus.framed_error_count).toBe(1);
	});
});

describe("Codex hook-entry normalization → event loop → lifecycle activity", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codex-prompt-activity-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("appends one redacted UserPromptSubmit row without a tool-stream duplicate", async () => {
		const rawPrompt = "Email alice@example.com with the incident notes";
		const redactedPrompt = "Email <EMAIL> with the incident notes";
		const unified = createCodexAdapter().parseHookInput(
			{ session_id: "codex-prompt-session", cwd: dir, prompt: rawPrompt },
			"UserPromptSubmit",
		);
		const realLegacy = await vi.importActual<typeof import("./legacy-client.js")>(
			"./legacy-client.js",
		);
		mToLegacy.mockImplementationOnce(realLegacy.toLegacyHarnessEvent);
		mLifecycle.mockResolvedValueOnce({ decision: "allow", redacted_prompt: redactedPrompt });
		const h = makeHarness(dir);
		vi.mocked(h.deps.writeLifecycleActivityRecord).mockImplementation((event, decision) => {
			writeLifecycleActivityRecord(event, dir, decision);
		});

		const decision = await createEventLoop(h.deps).evaluateUnifiedViaRuntime(unified);

		expect(decision).toEqual({ decision: "allow", redacted_prompt: redactedPrompt });
		expect(mLifecycle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				agent_source: "codex",
				hook_event: "UserPromptSubmit",
				prompt: rawPrompt,
			}),
			expect.anything(),
		);
		expect(h.deps.writeCollectionRecord).not.toHaveBeenCalled();
		const events = readLocalActivity({ cwd: dir });
		expect(events).toHaveLength(1);
		expect(nonNull(events[0])).toMatchObject({
			agent: "codex",
			hook: "UserPromptSubmit",
			prompt: redactedPrompt,
			scrubbed: true,
			session: "codex-prompt-session",
			type: "user_prompt",
		});
		expect(readFileSync(join(dir, ".interlinked", "activity.jsonl"), "utf8")).not.toContain(
			rawPrompt,
		);
	});
});

describe("PostToolUse fail-open — non-Error rejection", () => {
	it("stringifies a non-Error rejection in the fail-open log and still allows", async () => {
		// Symmetric with the Error case above: a check that rejects with a bare
		// string (a `throw "…"` anywhere under the post pipeline) must produce
		// the same allow-with-warning, not an unhandled rejection or a block.
		const h = makeHarness();
		mPostPipeline.mockRejectedValueOnce("plain-string-post-throw");
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(
			preEvent({ hook_event: "PostToolUse" }),
			"raw",
		);

		expect(decision).toEqual({
			decision: "allow",
			warnings: [
				"[interlinked:post-tool-pipeline] [proven] NOT CHECKED: PostToolUse checks failed before producing a verdict; run 'interlinked verify' before treating this edit as clean.",
			],
		});
		expect(h.log).toHaveBeenCalledWith(
			"PostToolUse pipeline threw (failing open): plain-string-post-throw",
		);
	});
});

// ---- G4 replay clock ------------------------------------------------------
// `replayClockFor` decides whether this event's evaluation runs inside a
// frozen-clock scope. The observable consequence is what `harnessNow()` reads
// DOWNSTREAM of the loop (reservation expiry, marker freshness, frequency
// windows all call it), so each case reads the real clock from inside the
// pre-tool pipeline and asserts frozen-vs-live.

/** Set env vars for the duration of `fn`, restoring prior values after. */
async function withEnv<T>(
	vars: Record<string, string | undefined>,
	fn: () => Promise<T>,
): Promise<T> {
	const prev: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(vars)) {
		prev[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return await fn();
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** Run one event and report the clock reading observed inside the pipeline. */
async function clockSeenDuring(line: string): Promise<number> {
	const h = makeHarness();
	let seen = -1;
	mPrePipeline.mockImplementationOnce(async () => {
		seen = harnessNow();
		return ALLOW;
	});
	const loop = createEventLoop(h.deps);
	await loop.evaluateEventLine(line, "raw");
	return seen;
}

describe("replayClockFor — G4 frozen evaluation clock", () => {
	const FROZEN_TS = "2020-05-04T03:02:01.000Z";
	const FROZEN_MS = Date.parse(FROZEN_TS);
	// A second, DIFFERENT recorded timestamp: asserting the second event reads
	// this one (not FROZEN_MS) is what discriminates a per-event freeze from a
	// freeze that sticks at whatever value it saw first.
	const SECOND_TS = "2021-06-07T08:09:10.000Z";
	const SECOND_MS = Date.parse(SECOND_TS);

	it("freezes harnessNow() at the event timestamp under INTERLINKED_REPLAY_CLOCK=event", async () => {
		const seen = await withEnv({ INTERLINKED_REPLAY_CLOCK: "event" }, () =>
			clockSeenDuring(preEvent({ timestamp: FROZEN_TS })),
		);

		expect(seen).toBe(FROZEN_MS);
	});

	it("re-freezes per event, and an event evaluated with the clock OFF reads real time", async () => {
		// WHAT THIS PINS: (1) each event enters its OWN freeze — event 2 reads
		// ITS timestamp, not event 1's, which kills a freeze that sticks at the
		// first value it saw; (2) an event that never enters a clock scope at
		// all reads the real clock, which kills a freeze parked in a
		// never-cleared module global.
		// WHAT IT DOES NOT PIN: AsyncLocalStorage scope isolation. The third
		// call has the env var unset, so `replayClockFor` returns null and
		// `runWithClock` is never entered — that arm cannot tell an ALS
		// implementation from any other. The interleaving test below pins the
		// loop-level isolation; the module-level property is pinned in
		// ./replay/harness-clock.test.ts.
		const frozen = await withEnv({ INTERLINKED_REPLAY_CLOCK: "event" }, () =>
			clockSeenDuring(preEvent({ timestamp: FROZEN_TS })),
		);
		const second = await withEnv({ INTERLINKED_REPLAY_CLOCK: "event" }, () =>
			clockSeenDuring(preEvent({ timestamp: SECOND_TS, session_id: "s2" })),
		);
		const before = Date.now();
		// Explicit `undefined` ⇒ delete. The live arm must not rely on the
		// ambient var happening to be unset: `INTERLINKED_REPLAY_CLOCK=event`
		// is a shipped daemon mode and this assertion failed under it before.
		const live = await withEnv({ INTERLINKED_REPLAY_CLOCK: undefined }, () =>
			clockSeenDuring(preEvent({ timestamp: FROZEN_TS })),
		);

		expect(frozen).toBe(FROZEN_MS);
		expect(second).toBe(SECOND_MS);
		expect(second).not.toBe(FROZEN_MS);
		expect(live).toBeGreaterThanOrEqual(before);
		expect(live).toBeLessThanOrEqual(Date.now());
	});

	it("interleaved events keep their own frozen clocks (per-event scope, no bleed)", async () => {
		// The daemon holds no global mutex across socket connections, so two
		// evaluations can interleave at any await point. Here event A parks
		// inside its pipeline until event B has entered and read from ITS
		// frozen scope, then reads the clock a second time. Under a per-event
		// AsyncLocalStorage scope A still sees A's timestamp; under a
		// module-global freeze (even one restored in a `finally`) A's second
		// read would see B's value or real time.
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		let signalAEntered: () => void = () => {};
		const aHasEntered = new Promise<void>((resolve) => {
			signalAEntered = resolve;
		});
		let signalBRead: () => void = () => {};
		const bHasRead = new Promise<void>((resolve) => {
			signalBRead = resolve;
		});

		const readings: Array<{ id: string; first: number; second: number }> = [];
		mPrePipeline.mockImplementation(async (_ctx, event) => {
			const id = event.session_id;
			const first = harnessNow();
			if (id === "sA") {
				signalAEntered();
				await bHasRead; // A resumes only after B has read inside B's scope
			} else {
				await aHasEntered; // B runs only once A is parked mid-evaluation
			}
			const second = harnessNow();
			readings.push({ id, first, second });
			if (id === "sB") signalBRead();
			return ALLOW;
		});

		await withEnv({ INTERLINKED_REPLAY_CLOCK: "event" }, async () => {
			await Promise.all([
				loop.evaluateEventLine(preEvent({ session_id: "sA", timestamp: FROZEN_TS }), "raw"),
				loop.evaluateEventLine(preEvent({ session_id: "sB", timestamp: SECOND_TS }), "raw"),
			]);
		});

		expect(readings).toHaveLength(2);
		expect(readings.find((r) => r.id === "sA")).toEqual({
			id: "sA",
			first: FROZEN_MS,
			second: FROZEN_MS,
		});
		expect(readings.find((r) => r.id === "sB")).toEqual({
			id: "sB",
			first: SECOND_MS,
			second: SECOND_MS,
		});
	});

	// Every way the replay clock can decline to engage. In all of them the
	// pipeline must read real wall-clock time.
	const liveCases: ReadonlyArray<{ name: string; env?: string; line: string }> = [
		{
			name: "env unset (the live daemon path)",
			line: preEvent({ timestamp: FROZEN_TS }),
		},
		{
			name: "env set to something other than 'event'",
			env: "1",
			line: preEvent({ timestamp: FROZEN_TS }),
		},
		{
			name: "no timestamp field at all",
			env: "event",
			line: preEvent(),
		},
		{
			name: "non-string timestamp",
			env: "event",
			line: JSON.stringify({
				hook_event: "PreToolUse",
				session_id: "s1",
				tool_name: "Bash",
				timestamp: 1588561321000,
			}),
		},
		{
			name: "unparseable timestamp string",
			env: "event",
			line: preEvent({ timestamp: "not-a-timestamp" }),
		},
	];

	for (const c of liveCases) {
		it(`falls back to real time — ${c.name}`, async () => {
			const before = Date.now();
			const seen = await withEnv({ INTERLINKED_REPLAY_CLOCK: c.env }, () =>
				clockSeenDuring(c.line),
			);
			const afterCall = Date.now();

			expect(seen).not.toBe(FROZEN_MS);
			expect(seen).toBeGreaterThanOrEqual(before);
			expect(seen).toBeLessThanOrEqual(afterCall);
		});
	}
});

// ---- G2 replay snapshot wiring -------------------------------------------
// The durability `finally` also feeds `maybeRecordReplaySnapshots` three
// fields it lifts off the RAW line / serialized snapshot: the tool-use id, the
// phase (derived from `hook_event`), and the seq (from `snap.last_seq`). With
// INTERLINKED_REPLAY_TREE_SNAPSHOTS=1 those land verbatim in
// `.interlinked/replay/snapshots/index.jsonl`, so the wiring is checked
// against real rows on disk rather than a mock's argument list.

const replayFixtures: string[] = [];
afterEach(() => {
	for (const dir of replayFixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Ambient git state that would otherwise reach the fixture repo AND the
 *  SUT's own `git` calls (`recordTreeSnapshot` spawns with `...process.env`).
 *  `undefined` ⇒ delete. Global/system config is neutralized so a developer's
 *  `commit.gpgsign` / `core.hooksPath` / `init.templateDir` cannot break or
 *  redirect the fixture, GIT_DIR & friends are cleared so the fixture cannot
 *  be pointed at another repo, and the commit identity is pinned so the
 *  fixture commit does not depend on a configured user. */
const HERMETIC_GIT_ENV: Record<string, string | undefined> = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_DIR: undefined,
	GIT_WORK_TREE: undefined,
	GIT_INDEX_FILE: undefined,
	GIT_COMMON_DIR: undefined,
	GIT_OBJECT_DIRECTORY: undefined,
	GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
	GIT_TEMPLATE_DIR: undefined,
	GIT_AUTHOR_NAME: "probe",
	GIT_AUTHOR_EMAIL: "t@t.local",
	GIT_COMMITTER_NAME: "probe",
	GIT_COMMITTER_EMAIL: "t@t.local",
};

/** `HERMETIC_GIT_ENV` applied to a copy of `base`, for `execFileSync`. */
function hermeticGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const [key, value] of Object.entries(HERMETIC_GIT_ENV)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

/** Env for a G2 test: the snapshot gate plus the git insulation the SUT needs
 *  (it reads `process.env` at call time, so this must be set on the process,
 *  not just handed to the fixture's `execFileSync`). */
function replayEnv(gate: string | undefined): Record<string, string | undefined> {
	return { INTERLINKED_REPLAY_TREE_SNAPSHOTS: gate, ...HERMETIC_GIT_ENV };
}

/** A minimal real git repo — `recordTreeSnapshot` seeds its temp index from
 *  HEAD, so at least one commit must exist. */
function makeRepoFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-evloop-"));
	replayFixtures.push(dir);
	const env = hermeticGitEnv(process.env);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf-8", env });
	git("init", "-q");
	git("config", "user.email", "t@t.local");
	git("config", "user.name", "probe");
	writeFileSync(join(dir, ".gitignore"), ".interlinked/\n");
	writeFileSync(join(dir, "a.txt"), "a\n");
	git("add", ".gitignore", "a.txt");
	git("commit", "-qm", "init");
	return dir;
}

function snapshotRows(dir: string): JsonObject[] {
	const path = join(dir, ".interlinked", "replay", "snapshots", "index.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => readJsonRecord(l));
}

describe("evaluateEventLine — G2 replay snapshot wiring", () => {
	it("records seq / tool_use_id / phase lifted off the raw line at a Pre boundary", async () => {
		const dir = makeRepoFixture();
		const h = makeHarness(dir);
		h.sessions.serialize.mockReturnValue({ last_seq: 7 });
		const loop = createEventLoop(h.deps);

		await withEnv(replayEnv("1"), () =>
			loop.evaluateEventLine(preEvent({ tool_use_id: "toolu_abc" }), "raw"),
		);

		const rows = snapshotRows(dir);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			session_id: "s1",
			seq: 7,
			tool_use_id: "toolu_abc",
			phase: "pre",
		});
	});

	it("maps a PostToolUse event to the post phase and null seq / tool_use_id", async () => {
		// No `tool_use_id` on the line and a snapshot whose `last_seq` is not a
		// number — both fields must degrade to an explicit null, never to
		// `undefined` or a coerced value.
		const dir = makeRepoFixture();
		const h = makeHarness(dir);
		h.sessions.serialize.mockReturnValue({ last_seq: "not-a-number" });
		const loop = createEventLoop(h.deps);

		await withEnv(replayEnv("1"), () =>
			loop.evaluateEventLine(preEvent({ hook_event: "PostToolUse" }), "raw"),
		);

		const rows = snapshotRows(dir);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ seq: null, tool_use_id: null, phase: "post" });
	});

	// The two negatives below each carry their OWN positive control on the same
	// fixture, because `recordTreeSnapshot` is fail-open: ANY git failure logs
	// "tree snapshot failed (non-fatal)" and appends no row, so a bare
	// `expect(rows).toEqual([])` would pass just as green on a broken fixture as
	// on a correctly-suppressed one. Control first (proves the recipe writes a
	// row HERE), then the suppressed case must leave that row untouched, and
	// neither may have logged a snapshot failure.

	it("records nothing when hook_event is not a string (no resolvable phase)", async () => {
		const dir = makeRepoFixture();
		const h = makeHarness(dir);
		h.sessions.serialize.mockReturnValue({ last_seq: 3 });
		const loop = createEventLoop(h.deps);

		// Control: same fixture, same env, a line that DOES resolve a phase.
		await withEnv(replayEnv("1"), () =>
			loop.evaluateEventLine(preEvent({ tool_use_id: "toolu_ctl" }), "raw"),
		);
		const afterControl = snapshotRows(dir);
		expect(afterControl).toHaveLength(1);

		const decision = await withEnv(replayEnv("1"), () =>
			loop.evaluateEventLine(
				JSON.stringify({ hook_event: 42, session_id: "s1", tool_use_id: "toolu_x" }),
				"raw",
			),
		);

		// Not a tool boundary → no NEW row, and the event itself still allows.
		expect(snapshotRows(dir)).toEqual(afterControl);
		expect(decision).toEqual({ decision: "allow" });
		expect(h.log).not.toHaveBeenCalledWith(expect.stringContaining("tree snapshot failed"));
	});

	it("records nothing when the tree-snapshot env gate is off", async () => {
		const dir = makeRepoFixture();
		const h = makeHarness(dir);
		h.sessions.serialize.mockReturnValue({ last_seq: 7 });
		const loop = createEventLoop(h.deps);

		// Control: identical event, gate ON.
		await withEnv(replayEnv("1"), () =>
			loop.evaluateEventLine(preEvent({ tool_use_id: "toolu_abc" }), "raw"),
		);
		const afterControl = snapshotRows(dir);
		expect(afterControl).toHaveLength(1);

		await withEnv(replayEnv(undefined), () =>
			loop.evaluateEventLine(preEvent({ tool_use_id: "toolu_abc" }), "raw"),
		);

		expect(snapshotRows(dir)).toEqual(afterControl);
		expect(h.log).not.toHaveBeenCalledWith(expect.stringContaining("tree snapshot failed"));
	});
});
