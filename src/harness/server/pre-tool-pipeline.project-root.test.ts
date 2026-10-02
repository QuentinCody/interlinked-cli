import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeServerRuntime, makeServerRules } from "./__tests__/fixtures.js";
import { makeSession as makeSessionFixture } from "../__tests__/fixtures/evaluator.js";
import type { HarnessDecision, HarnessEvent, PolicyClassification, SessionTrajectory } from "../types.js";
import { runPreToolPipeline } from "./pre-tool-pipeline.js";

// The module mocks below are the same import-boundary set the pipeline's integration suite uses, so
// the orchestrator runs without a real repo, graph or git.

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

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return { hook_event: "PreToolUse", session_id: "s", agent_source: "claude", timestamp: "2026-04-23T00:00:00.000Z", ...partial };
}

function makeSession(partial: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return { ...makeSessionFixture(), agent_name: "session-agent", acknowledged_checks: new Set(["shell-sandbox-evidence"]), ...partial };
}

function makeCtx(): ReturnType<typeof makeServerRuntime> {
	return makeServerRuntime({
		cwd: "/daemon-cwd",
		interlinkedDir: "/daemon-cwd/.interlinked",
		rules: makeServerRules({}),
		cohort: {},
		sessions: {},
		reservations: {},
		errorHistory: {},
		routeMap: {},
		serverBridge: null,
		asyncFindings: { drain: vi.fn(() => []) },
		learnedRules: { has: vi.fn(() => false), observe: vi.fn(() => null) },
		asyncAnalysis: { consume: vi.fn(() => []) },
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
	});
}

beforeEach(() => { vi.clearAllMocks(); });

describe("session project root — positive (must fire)", () => {
	it("P1: the event's cwd becomes the session's project root", async () => {
		// test-contract: public-api — anything persisted for the session lands in the project the event names, not the daemon's own cwd
		const session = makeSession();
		await runPreToolPipeline(makeCtx(), ev({ tool_name: "Read", tool_input: { file_path: "src/x.ts" }, cwd: "/work/project-b" }), session);
		expect(session.project_root).toBe("/work/project-b");
	});

	it("P2: a later event naming another project moves the session's project root", async () => {
		// test-contract: invariant — the root follows the most recent event, so a session that changes directory persists to the new project
		const session = makeSession();
		await runPreToolPipeline(makeCtx(), ev({ tool_name: "Read", tool_input: { file_path: "a.ts" }, cwd: "/work/one" }), session);
		await runPreToolPipeline(makeCtx(), ev({ tool_name: "Read", tool_input: { file_path: "b.ts" }, cwd: "/work/two" }), session);
		expect(session.project_root).toBe("/work/two");
	});
});

describe("session project root — negative (must not fire)", () => {
	it("N1: an event without a cwd leaves the session's project root unchanged", async () => {
		// test-contract: invariant — a cwd-less event must not erase or replace a root an earlier event established
		const session = makeSession({ project_root: "/work/established" });
		await runPreToolPipeline(makeCtx(), ev({ tool_name: "Read", tool_input: { file_path: "src/x.ts" } }), session);
		expect(session.project_root).toBe("/work/established");
	});

	it("N2: an empty cwd is treated as absent", async () => {
		// test-contract: boundary — an empty string names no project and must not overwrite the root
		const session = makeSession({ project_root: "/work/established" });
		await runPreToolPipeline(makeCtx(), ev({ tool_name: "Read", tool_input: { file_path: "src/x.ts" }, cwd: "" }), session);
		expect(session.project_root).toBe("/work/established");
	});
});
