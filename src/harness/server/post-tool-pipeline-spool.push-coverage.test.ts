import { expect, it, vi } from "vitest";
import { makeServerRuntime } from "./__tests__/fixtures.js";
import { completePostToolWarningSpool } from "./post-tool-warning-spool.js";
import { withPostToolWarningSpool } from "./post-tool-pipeline-spool.js";

vi.mock("./post-tool-warning-spool.js", () => ({
    beginPostToolWarningSpool: vi.fn(() => ({
        token: "legacy", sessionId: "", markerPath: "", readyPath: "",
        requested: false, ownsMarker: false, closed: false,
    })),
    completePostToolWarningSpool: vi.fn(),
}));

it("completes a legacy sessionless request without inventing late warnings", async () => {
    const decision = { decision: "allow" as const };
    const result = await withPostToolWarningSpool(makeServerRuntime(), {
        hook_event: "PostToolUse", session_id: "", agent_source: "claude",
        timestamp: "2026-10-08T00:00:00Z",
    }, async () => decision);
    expect(result).toBe(decision);
    expect(completePostToolWarningSpool).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ requested: false, ownsMarker: false }), [],
    );
});
