import { expect, it, vi } from "vitest";
import { emitAllCleanSummary, appendTestReadinessGuidance } from "./post-tool-pipeline-tail.js";
import { testReadiness } from "../test-readiness.js";
vi.mock("../repo-profile.js", () => ({ getRepoProfile: () => ({ testLayout: "none" }) }));
vi.mock("../test-readiness.js", async original => ({ ...await original<typeof import("../test-readiness.js")>(), testReadiness: vi.fn() }));
import { makeServerRules } from "./__tests__/fixtures.js";
import type { HarnessDecision } from "../types.js";

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
