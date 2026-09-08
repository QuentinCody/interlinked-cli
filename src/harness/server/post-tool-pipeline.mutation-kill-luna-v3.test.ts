import { describe, expect, it, vi } from "vitest";
import type { HarnessDecision, HarnessEvent } from "../types.js";

const mocks = vi.hoisted(() => ({
    scan: vi.fn<() => Promise<{ warnings: string[] }>>(async () => ({ warnings: [] })),
    channels: vi.fn<() => { warnings: string[] }>(() => ({ warnings: [] })),
    skipPath: vi.fn<() => boolean>(() => false),
    workspace: vi.fn<() => { files: Array<{ path: string }> } | null>(() => null),
    baseline: vi.fn<() => string | null>(() => null),
    paths: vi.fn(() => ({
        editedFilePath: "src/example.ts",
        editedFilePaths: ["src/example.ts"],
        isDirectFileEdit: true,
        shouldRunChecks: true,
    })),
}));

vi.mock("../check-engine/index.js", () => ({
    getOrCreateEngine: () => ({ isToolAvailable: () => true }),
}));
vi.mock("../content-scanner/post-scan.js", () => ({ runPostToolScan: mocks.scan }));
vi.mock("../evaluator.js", () => ({
    evaluatePostToolUse: vi.fn(() => ({ decision: "allow", warnings: [] })),
}));
vi.mock("../evaluator/baseline-effect-guard.js", () => ({
    baselineCallKey: vi.fn(() => "key"),
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
    isWorkspaceControlPath: vi.fn(() => false),
}));
vi.mock("./post-tool-pipeline-paths.js", () => ({ resolveEditedPaths: mocks.paths }));
vi.mock("./post-tool-file-checks.js", () => ({
    runPerFileChecks: vi.fn(async (
        _ctx: unknown,
        _event: HarnessEvent,
        _session: unknown,
        _path: string,
        _decision: HarnessDecision,
        acc: { checksRan: string[] },
    ) => {
        acc.checksRan.push("structural", "typescript", "biome_lint", "secrets_in_source", "affected_tests");
    }),
}));
vi.mock("./post-tool-flake-phase.js", () => ({ appendFlakeCheckWarning: vi.fn(async () => undefined) }));
vi.mock("./post-tool-mutation-harvest.js", () => ({ appendMutationHarvestWarning: vi.fn(async () => undefined) }));
vi.mock("./post-tool-pipeline-tracking.js", () => ({
    dischargeCoverageOnGreenRun: vi.fn(),
    pushWarnings: vi.fn((decision: HarnessDecision, ...warnings: string[]) => {
        decision.warnings = [...(decision.warnings ?? []), ...warnings];
    }),
    trackTestRun: vi.fn(() => null),
    trackVerificationOutcome: vi.fn(),
    updateTrigramDirtyLayer: vi.fn(),
}));
vi.mock("./spec-ledger-phase.js", () => ({ prerefreshSpecLedger: vi.fn() }));

import { runPostToolPipeline } from "./post-tool-pipeline.js";

function context(): Parameters<typeof runPostToolPipeline>[0] {
    return {
        cwd: "/repo",
		interlinkedDir: "/repo/.interlinked",
        rules: { rules: [{ id: "rule" }], content_scanner: { enabled: true } },
        contentScanner: {},
        compiledAllowlist: [],
        reservations: new Map(),
        cohort: undefined,
        log: vi.fn(),
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

describe("post-tool pipeline contracts", () => {
    // test-contract: all supported check families retain their exact compact summary labels.
    it("uses compact labels for every supported check family", async () => {
        const decision = await runPostToolPipeline(context(), event(), session());
        expect(decision.summary).toContain("structural, tsc, biome, secrets, tests");
    });

    // test-contract: a scanner warning is forwarded, while an empty warning list adds nothing.
    it("forwards only nonempty scanner output", async () => {
        mocks.scan.mockResolvedValueOnce({ warnings: ["scan warning"] });
        const ctx = context();
        const currentEvent = event();
        const currentSession = session();
        const decision = await runPostToolPipeline(ctx, currentEvent, currentSession);
        expect(decision.warnings).toContain("scan warning");
        expect(mocks.scan).toHaveBeenCalledWith({
            event: currentEvent,
            session: currentSession,
            rules: ctx.rules,
            scanner: ctx.contentScanner,
            compiledAllowlist: ctx.compiledAllowlist,
        });
    });

    // test-contract: failure-channel warnings are forwarded only for an error with actual warnings.
    it("forwards only nonempty failure-channel output", async () => {
        mocks.channels.mockReturnValueOnce({ warnings: ["failure warning"] });
        const ctx = context();
        const currentEvent = event({ tool_outcome: "error" });
        const currentSession = session();
        const decision = await runPostToolPipeline(ctx, currentEvent, currentSession);
        expect(decision.warnings).toContain("failure warning");
        expect(mocks.channels).toHaveBeenCalledWith({
            event: currentEvent,
            session: currentSession,
            cwd: ctx.cwd,
        });
    });

    // test-contract: a named skipped path returns the exact nonblocking allow decision.
    it("short-circuits a skipped named path", async () => {
        mocks.skipPath.mockReturnValueOnce(true);
        const decision = await runPostToolPipeline(context(), event(), session());
        expect(decision.decision).toBe("allow");
        expect(decision.summary).toContain("src/example.ts");
    });

    // test-contract: an observed all-skipped filesystem effect returns an allow summary naming its count.
    it("short-circuits an observed skipped path", async () => {
        mocks.workspace.mockReturnValueOnce({ files: [{ path: "src/skip.ts" }] });
        mocks.skipPath.mockReturnValueOnce(true);
        const decision = await runPostToolPipeline(context(), event(), session());
        expect(decision.summary).toContain("all 1 observed filesystem effect");
    });

    // test-contract: dry-run baseline effects are ignored, while real effects append their warning.
    it("honors baseline dry-run gating", async () => {
        mocks.baseline.mockReturnValueOnce("baseline warning");
        const dry = await runPostToolPipeline(context(), event({ dry_run: true }), session());
        expect(dry.warnings ?? []).not.toContain("baseline warning");
        mocks.baseline.mockReturnValueOnce("baseline warning");
        const real = await runPostToolPipeline(context(), event(), session());
        expect(real.warnings).toContain("baseline warning");
    });

    // test-contract: observed workspace effects are attached before downstream routing.
    it("attaches an observed change set", async () => {
        mocks.workspace.mockReturnValueOnce({ files: [{ path: "src/observed.ts" }] });
        const observed = event();
        await runPostToolPipeline(context(), observed, session());
        expect(observed.files_modified).toEqual(["src/observed.ts"]);
        expect(observed.change_set?.files[0]?.path).toBe("src/observed.ts");
    });

    // test-contract: absent observations and empty path lists still complete the pipeline with phase data.
    it("handles absent observations and empty paths", async () => {
        mocks.workspace.mockReturnValueOnce(null);
        mocks.paths.mockReturnValueOnce({
            editedFilePath: "",
            editedFilePaths: [],
            isDirectFileEdit: true,
            shouldRunChecks: true,
        });
        const decision = await runPostToolPipeline(context(), event(), session());
        expect(decision.phase_breakdown).toHaveProperty("recurrence_aggregate");
        expect(decision.phase_breakdown).toHaveProperty("session_persist");
    });

    // test-contract: timing fields expose nonnegative elapsed and phase measurements.
    it("reports nonnegative timing", async () => {
        const decision = await runPostToolPipeline(context(), event(), session());
        expect(decision.checks_timing_ms).toBeGreaterThanOrEqual(0);
        expect(decision.phase_breakdown?.pre_tool_response).toBeGreaterThanOrEqual(0);
    });
});
