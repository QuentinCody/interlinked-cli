import { expect, it, vi } from "vitest";
import { emitAllCleanSummary, appendTestReadinessGuidance, appendBaselineEffect } from "./post-tool-pipeline-tail.js";
import { testReadiness } from "../test-readiness.js";
vi.mock("../repo-profile.js", () => ({ getRepoProfile: () => ({ testLayout: "none" }) }));
vi.mock("../test-readiness.js", async original => ({ ...await original<typeof import("../test-readiness.js")>(), testReadiness: vi.fn() }));
vi.mock("../evaluator/baseline-effect-guard.js", () => ({ baselineCallKey: () => "key", consumeBaselineSnapshot: vi.fn() }));
import { consumeBaselineSnapshot } from "../evaluator/baseline-effect-guard.js";
import { makeServerRules } from "./__tests__/fixtures.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";

function event(over: Partial<HarnessEvent> = {}): HarnessEvent {
    return { hook_event: "PostToolUse", session_id: "session", agent_source: "claude",
        timestamp: "2026-08-20T00:00:00.000Z", tool_name: "Edit", tool_input: { file_path: "src/example.ts" },
        tool_response: null, ...over };
}

it("does not turn a deduplicated deferral into an all-clean summary", () => {
    const postDecision: HarnessDecision = { decision: "allow", warnings: [], check_results: [{ source: "quality", name: "affected_tests_deferred", severity: "warning", determinism: "fully_deterministic", message: "pytest missing" }] };
    emitAllCleanSummary({ postDecision, rules: makeServerRules(), checksRan: ["structural"], elapsedMs: 1 });
    expect(postDecision.summary).toBeUndefined();
    postDecision.check_results = [];
    emitAllCleanSummary({ postDecision, rules: makeServerRules(), checksRan: ["structural"], elapsedMs: 1 });
    expect(postDecision.summary).toContain("all clean");
});

it("delivers concrete readiness once during editing and never for docs", async () => {
    vi.mocked(testReadiness).mockResolvedValue({ status: "unavailable", interpreter: "/project/.venv/bin/python", missing: ["pytest"], reason: "missing", behavioralEvidence: "not-run", requiresApproval: [], install: { command: "/project/.venv/bin/python", args: ["-m", "pip", "install", "pytest==8.4.2"] } });
    // Contract-review intro pre-acknowledged: this pin is readiness only.
    const session = { acknowledged_checks: new Set<string>(["contract-review:intro"]) };
    const decision: HarnessDecision = { decision: "allow" };
    await appendTestReadinessGuidance({ cwd: "/project" }, session, ["notes.md"], decision);
    expect(testReadiness).not.toHaveBeenCalled();
    await appendTestReadinessGuidance({ cwd: "/project" }, session, ["code.py"], decision);
    await appendTestReadinessGuidance({ cwd: "/project" }, session, ["code.py"], decision);
    expect(testReadiness).toHaveBeenCalledTimes(1);
    expect(decision.warnings).toHaveLength(1);
    expect(decision.warnings?.[0]).toContain("pytest==8.4.2");
    expect(decision.warnings?.[0]).toContain("public contract");
    expect(decision.decision).toBe("allow");
});

// test-contract: invariant — a mixed-language edit batch must classify Rust,
// Go, and typescript-family paths independently, and an unmatched extension
// (present because the outer gate only needs ONE matching path) must yield no
// language rather than a false readiness probe.
it("classifies rust, go, and typescript paths independently within one batch and skips unmatched extensions", async () => {
    vi.mocked(testReadiness).mockReset();
    vi.mocked(testReadiness).mockResolvedValue({ status: "unavailable", interpreter: "n/a", missing: [], reason: "missing",
        behavioralEvidence: "not-run", requiresApproval: [], install: null });
    const session = { acknowledged_checks: new Set<string>(["contract-review:intro"]) };
    const decision: HarnessDecision = { decision: "allow" };
    await appendTestReadinessGuidance({ cwd: "/project" }, session, ["feature.rs", "feature.go", "notes.md", "feature.ts"], decision);
    expect(testReadiness).toHaveBeenCalledWith("/project", "rust");
    expect(testReadiness).toHaveBeenCalledWith("/project", "go");
    expect(testReadiness).toHaveBeenCalledWith("/project", "typescript");
    expect(testReadiness).toHaveBeenCalledTimes(3);
});

// test-contract: invariant — the loosening warning must be appended onto any
// existing warnings, never replacing them (the `??` fallback only applies
// when decision.warnings is absent).
it("appends a baseline-loosening warning onto existing warnings without clobbering them", () => {
    vi.mocked(consumeBaselineSnapshot).mockReturnValue("baseline loosened");
    const decision: HarnessDecision = { decision: "allow", warnings: ["earlier warning"] };
    appendBaselineEffect(event(), decision, "/project");
    expect(decision.warnings).toEqual(["earlier warning", "baseline loosened"]);
});

// test-contract: invariant — when the call produced no detectable loosening,
// the decision's warnings array must be left untouched.
it("leaves warnings untouched when the call produced no baseline loosening", () => {
    vi.mocked(consumeBaselineSnapshot).mockReturnValue(null);
    const decision: HarnessDecision = { decision: "allow", warnings: ["earlier warning"] };
    appendBaselineEffect(event(), decision, "/project");
    expect(decision.warnings).toEqual(["earlier warning"]);
});
