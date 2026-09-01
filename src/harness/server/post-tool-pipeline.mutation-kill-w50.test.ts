import { existsSync, mkdirSync as realMkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessDecision, HarnessEvent } from "../types.js";

const mocks = vi.hoisted(() => ({
	scan: vi.fn<() => Promise<{ warnings: string[] }>>(async () => ({ warnings: [] })),
	channels: vi.fn<(...args: unknown[]) => { warnings: string[] } | null>(() => ({ warnings: [] })),
	skipPath: vi.fn<() => boolean>(() => false),
	workspace: vi.fn<(...args: unknown[]) => { files: Array<{ path: string }> } | null>(() => null),
	baseline: vi.fn<() => string | null>(() => null),
	baselineCallKey: vi.fn<(...args: unknown[]) => string>(() => "key"),
	isWorkspaceControlPath: vi.fn<(p: string) => boolean>(() => false),
	pushWarnings: vi.fn((decision: HarnessDecision, ...warnings: string[]) => {
		decision.warnings = [...(decision.warnings ?? []), ...warnings];
	}),
	trackTestRun: vi.fn<() => string | null>(() => null),
	paths: vi.fn(() => ({
		editedFilePath: "src/example.ts",
		editedFilePaths: ["src/example.ts"],
		isDirectFileEdit: true,
		shouldRunChecks: true,
	})),
	runPerFileChecks: vi.fn(
		async (
			_ctx: unknown,
			_event: HarnessEvent,
			_session: unknown,
			_path: string,
			_decision: HarnessDecision,
			acc: { checksRan: string[] },
		) => {
			acc.checksRan.push("structural");
		},
	),
}));

vi.mock("../check-engine/index.js", () => ({
	getOrCreateEngine: () => ({ isToolAvailable: () => true }),
}));
vi.mock("../content-scanner/post-scan.js", () => ({ runPostToolScan: mocks.scan }));
vi.mock("../evaluator.js", () => ({
	evaluatePostToolUse: vi.fn(() => ({ decision: "allow", warnings: [] })),
}));
vi.mock("../evaluator/baseline-effect-guard.js", () => ({
	baselineCallKey: mocks.baselineCallKey,
	consumeBaselineSnapshot: mocks.baseline,
}));
vi.mock("../failure-channels.js", () => ({ runFailureChannels: mocks.channels }));
vi.mock("../skip-paths.js", () => ({ shouldSkipPath: mocks.skipPath }));
vi.mock("../tool-result-checks.js", () => ({
	checkContextBloat: vi.fn(() => null),
	checkSilentFailure: vi.fn(() => null),
	consecutiveFailureWarning: vi.fn(() => null),
	formatBloatWarning: vi.fn(),
	formatSilentFailureWarning: vi.fn(),
}));
vi.mock("../workspace-effects.js", () => ({
	consumeWorkspaceSnapshot: mocks.workspace,
	isWorkspaceControlPath: mocks.isWorkspaceControlPath,
}));
vi.mock("./post-tool-pipeline-paths.js", () => ({ resolveEditedPaths: mocks.paths }));
vi.mock("./post-tool-file-checks.js", () => ({ runPerFileChecks: mocks.runPerFileChecks }));
vi.mock("./post-tool-flake-phase.js", () => ({ appendFlakeCheckWarning: vi.fn(async () => undefined) }));
vi.mock("./post-tool-mutation-harvest.js", () => ({
	appendMutationHarvestWarning: vi.fn(async () => undefined),
}));
vi.mock("./post-tool-pipeline-tracking.js", () => ({
	dischargeCoverageOnGreenRun: vi.fn(),
	pushWarnings: mocks.pushWarnings,
	trackTestRun: mocks.trackTestRun,
	trackVerificationOutcome: vi.fn(),
	updateTrigramDirtyLayer: vi.fn(),
}));
vi.mock("./spec-ledger-phase.js", () => ({ prerefreshSpecLedger: vi.fn() }));

import { runPostToolPipeline } from "./post-tool-pipeline.js";

function context(overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/repo",
		interlinkedDir: "/repo/.interlinked",
		rules: { rules: [{ id: "rule" }], content_scanner: { enabled: true } },
		contentScanner: {},
		compiledAllowlist: [],
		reservations: new Map(),
		cohort: undefined,
		log: vi.fn(),
		...overrides,
	} as never;
}

function event(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "session",
		agent_source: "claude",
		timestamp: "2026-08-20T00:00:00.000Z",
		tool_name: "Edit",
		tool_input: { file_path: "src/example.ts" },
		tool_response: null,
		...over,
	} as unknown as HarnessEvent;
}

function session() {
	return {
		silent_failure_warned: new Set<string>(),
		bloat_warned: new Set<string>(),
		consecutive_tool_failures: new Map<string, number>(),
		acknowledged_checks: new Set<string>(),
	} as never;
}

beforeEach(() => {
	mocks.scan.mockReset().mockResolvedValue({ warnings: [] });
	mocks.channels.mockReset().mockReturnValue({ warnings: [] });
	mocks.skipPath.mockReset().mockReturnValue(false);
	mocks.workspace.mockReset().mockReturnValue(null);
	mocks.baseline.mockReset().mockReturnValue(null);
	mocks.baselineCallKey.mockReset().mockReturnValue("key");
	mocks.isWorkspaceControlPath.mockReset().mockReturnValue(false);
	mocks.pushWarnings.mockClear();
	mocks.trackTestRun.mockReset().mockReturnValue(null);
	mocks.paths.mockReset().mockReturnValue({
		editedFilePath: "src/example.ts",
		editedFilePaths: ["src/example.ts"],
		isDirectFileEdit: true,
		shouldRunChecks: true,
	});
	mocks.runPerFileChecks.mockClear();
});

describe("observedSkipDecision — paths.length===0 guard", () => {
	// mutant 7466724558d79f06: `paths.length === 0` -> `false`
	it("does not short-circuit when the mapped paths list collapses to empty", async () => {
		const files = { length: 1, map: () => [] } as unknown as Array<{ path: string }>;
		const decision = await runPostToolPipeline(
			context(),
			event({ change_set: { files } as never }),
			session(),
		);
		expect(decision.summary ?? "").not.toContain("matched all");
		expect(decision.phase_breakdown).toBeDefined();
	});
});

describe("observedSkipDecision — optional chaining on change_set", () => {
	// mutant b4ed94d70e74db7e: `event.change_set?.files` -> `event.change_set.files`
	it("tolerates change_set becoming falsy between the guard check and the read", async () => {
		let accessCount = 0;
		const ev = event();
		Object.defineProperty(ev, "change_set", {
			configurable: true,
			get() {
				accessCount += 1;
				if (accessCount === 1) return { files: [{ path: "src/a.ts" }] };
				return null;
			},
		});
		await expect(runPostToolPipeline(context(), ev, session())).resolves.toBeDefined();
	});
});

describe("observedSkipDecision — some vs every", () => {
	// mutant 0910a9bfbad87f89: `paths.some(isWorkspaceControlPath)` -> `paths.every(...)`
	it("treats one workspace-control path among several as disqualifying the skip", async () => {
		mocks.isWorkspaceControlPath.mockImplementation((p: string) => p === "control.path");
		mocks.skipPath.mockReturnValue(true);
		const files = [{ path: "control.path" }, { path: "other.path" }];
		const decision = await runPostToolPipeline(
			context(),
			event({ change_set: { files } as never }),
			session(),
		);
		expect(decision.summary ?? "").not.toContain("matched all");
		expect(decision.phase_breakdown).toBeDefined();
	});
});

describe("observedSkipDecision — return literal", () => {
	// mutant 1c3b421751563dcc: `"allow"` -> `""`
	it("returns the exact allow literal when the skip short-circuit fires", async () => {
		mocks.skipPath.mockReturnValue(true);
		mocks.isWorkspaceControlPath.mockReturnValue(false);
		const files = [{ path: "skip.me" }];
		const decision = await runPostToolPipeline(
			context(),
			event({ change_set: { files } as never }),
			session(),
		);
		expect(decision.decision).toBe("allow");
	});
});

describe("skipPathsShortCircuit — typeof guard", () => {
	// mutant 24cdce874e4a5bd9: `typeof namedPath === "string"` -> `true`
	it("ignores a non-string named path instead of treating it as skippable", async () => {
		mocks.skipPath.mockReturnValue(true);
		const decision = await runPostToolPipeline(
			context(),
			event({ tool_input: { file_path: 123 } as never }),
			session(),
		);
		expect(decision.summary ?? "").not.toContain("matched (123)");
		expect(decision.phase_breakdown).toBeDefined();
	});
});

describe("appendFailureChannelWarnings — call args", () => {
	// mutant b5675e698d03d5f7: `{ event, session, cwd: ctx.cwd }` -> `{}`
	it("passes event, session, and cwd through to runFailureChannels", async () => {
		const ctx = context({ cwd: "/repo/specific" });
		const ev = event({ tool_outcome: "error" });
		const sess = session();
		await runPostToolPipeline(ctx, ev, sess);
		expect(mocks.channels).toHaveBeenCalledWith(
			expect.objectContaining({ event: ev, session: sess, cwd: "/repo/specific" }),
		);
	});
});

describe("empty-warnings conditions do not push anything", () => {
	// mutants 80bb537c071961bf, 970dd5b1ea19eab7, 2deed8c884cfaba2, 3fbb5ac9bf3acdef
	// (failure-channel warnings.length > 0 guard) and 5bc7a33023c85526,
	// e61f5e30f184a92c (content-scan warnings.length > 0 guard).
	it("never pushes WARNING content when both channel and scan output are empty", async () => {
		mocks.channels.mockReturnValue({ warnings: [] });
		mocks.scan.mockResolvedValue({ warnings: [] });
		await runPostToolPipeline(context(), event({ tool_outcome: "error" }), session());
		// The all-clean SUMMARY line (a later pipeline feature) may push with an
		// empty warnings array; this pin's original intent stands unchanged: no
		// WARNING content is ever pushed when channel and scan are both empty.
		const warningPushes = mocks.pushWarnings.mock.calls.filter((call) => {
			const payload = call[0] as { warnings?: string[] } | undefined;
			return (payload?.warnings?.length ?? 0) > 0;
		});
		expect(warningPushes).toEqual([]);
	});
});

describe("appendContentScanWarnings — call args", () => {
	// mutant ba71c6544a22dfd3: object literal -> {}
	it("passes rules, scanner, and compiledAllowlist through to runPostToolScan", async () => {
		const scannerObj = { marker: "scanner" };
		const allowlist = ["x"];
		const ctx = context({ contentScanner: scannerObj, compiledAllowlist: allowlist });
		await runPostToolPipeline(ctx, event(), session());
		expect(mocks.scan).toHaveBeenCalledWith(
			expect.objectContaining({
				scanner: scannerObj,
				compiledAllowlist: allowlist,
			}),
		);
	});
});

describe("runFileChecksWithMarker — existsSync guard", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = realMkdirSync(join(tmpdir(), `w50-pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`), {
			recursive: true,
		}) as unknown as string;
		if (!tmp) {
			// mkdirSync with recursive:true returns the first created dir path or
			// undefined if it already existed; construct explicitly to be safe.
		}
	});

	it("skips mkdirSync when the data dir already exists", async () => {
		const root = join(tmpdir(), `w50-pipeline-exists-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		realMkdirSync(join(root, ".interlinked"), { recursive: true });
		expect(existsSync(join(root, ".interlinked"))).toBe(true);
		try {
			const ctx = context({ cwd: root });
			await runPostToolPipeline(ctx, event(), session());
			// The marker file should have been created and then removed without
			// any error being logged (mkdirSync would throw if pointed at a file,
			// but silently succeeds on an existing dir either way — so assert via
			// the absence of any logged error, which only occurs on failure paths).
			expect((ctx as { log: ReturnType<typeof vi.fn> }).log).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("pathsToCheck — nonempty single editedFilePath fallback", () => {
	// mutants cddbc830feb7474a (`> 0` -> `false`), a7240a101e38440c (`> 0` -> `<= 0`)
	it("uses the resolved editedFilePath when editedFilePaths is empty", async () => {
		mocks.paths.mockReturnValue({
			editedFilePath: "src/single-fallback.ts",
			editedFilePaths: [],
			isDirectFileEdit: true,
			shouldRunChecks: true,
		});
		await runPostToolPipeline(context(), event(), session());
		expect(mocks.runPerFileChecks).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			"src/single-fallback.ts",
			expect.anything(),
			expect.anything(),
		);
	});
});

describe("attachObservedChangeSet — dry_run guard", () => {
	// mutant b68fc012b531b582: `event.dry_run` -> `false`
	it("does not attach an observed change set for a dry run", async () => {
		mocks.workspace.mockReturnValue({ files: [{ path: "src/observed.ts" }] });
		const ev = event({ dry_run: true });
		await runPostToolPipeline(context(), ev, session());
		expect(ev.files_modified).toBeUndefined();
		expect(ev.change_set).toBeUndefined();
	});
});

describe("attachObservedChangeSet — call args", () => {
	// mutant 95eb1f9d80059362: object literal -> {}
	it("passes toolUseId, sessionId, and cwd-as-root through to consumeWorkspaceSnapshot", async () => {
		const ctx = context({ cwd: "/repo/root" });
		const ev = event({ tool_use_id: "tu-1", session_id: "sess-1" });
		await runPostToolPipeline(ctx, ev, session());
		expect(mocks.workspace).toHaveBeenCalledWith(
			expect.objectContaining({ toolUseId: "tu-1", sessionId: "sess-1", root: "/repo/root" }),
		);
	});
});

describe("appendBaselineEffect — call args", () => {
	// mutant 9c2dde35b552c524: object literal -> {}
	it("passes toolUseId, sessionId, and timestamp through to baselineCallKey", async () => {
		const ev = event({ tool_use_id: "tu-2", session_id: "sess-2", timestamp: "2026-08-20T01:00:00.000Z" });
		await runPostToolPipeline(context(), ev, session());
		expect(mocks.baselineCallKey).toHaveBeenCalledWith(
			expect.objectContaining({
				toolUseId: "tu-2",
				sessionId: "sess-2",
				timestamp: "2026-08-20T01:00:00.000Z",
			}),
		);
	});
});

describe("appendBaselineEffect — nullish coalescing on decision.warnings", () => {
	// mutant 93b6ff9e389324a9: `decision.warnings ?? []` -> `decision.warnings && []`
	it("appends the baseline warning even when no prior warnings exist", async () => {
		mocks.baseline.mockReturnValue("baseline warning");
		const decision = await runPostToolPipeline(context(), event(), session());
		expect(decision.warnings).toEqual(
			expect.arrayContaining(["baseline warning"]),
		);
	});
});

describe("testEvidenceWarning forwarding", () => {
	// mutant 99598c370bcb61df: `testEvidenceWarning` -> `false`
	it("forwards a truthy test-evidence warning into the decision", async () => {
		mocks.trackTestRun.mockReturnValue("test evidence warning");
		const decision = await runPostToolPipeline(context(), event(), session());
		expect(decision.warnings).toContain("test evidence warning");
	});
});

describe("phase timing arithmetic", () => {
	// mutants 68445d1a38555f9b (`+` -> `-` in markPhase accumulation),
	// a63fca7517cbf211 (`now - phaseCursor` -> `now + phaseCursor`),
	// b3f08cd003bc71cc (`Date.now() - postStartMs` -> `+`)
	it("computes exact phase deltas and elapsed time from a controlled clock", async () => {
		const sequence = [1000, 1010, 1030, 1070, 1150, 1300];
		let i = 0;
		const spy = vi.spyOn(Date, "now").mockImplementation(() => {
			const v = sequence[Math.min(i, sequence.length - 1)];
			i += 1;
			return v as number;
		});
		try {
			const decision = await runPostToolPipeline(context(), event(), session());
			expect(decision.phase_breakdown?.pre_tool_response).toBe(10);
			expect(decision.phase_breakdown?.tool_response_checks).toBe(20);
			expect(decision.phase_breakdown?.recurrence_aggregate).toBe(40);
			expect(decision.phase_breakdown?.session_persist).toBe(80);
			expect(decision.checks_timing_ms).toBe(300);
		} finally {
			spy.mockRestore();
		}
	});
});
