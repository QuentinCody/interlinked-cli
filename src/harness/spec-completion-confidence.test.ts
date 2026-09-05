import { describe, expect, it } from "vitest";
import { buildTrajectoryFixture } from "./__tests__/sequence-fixtures.js";
import { signatureChangeCallersNotUpdated, unusedHelperIntroduced } from "./sequence-checks/quality.js";
import { preCheckCompletionTracking, type PreToolContext } from "./structural-checks-pre-context.js";

describe("retained spec findings cannot become code-change obligations", () => {
    it.each(["count_claim_drift", "range_claim_drift"])("keeps a legacy %s completion without nudging an edit", (kind) => {
        const { session, lastEvent } = buildTrajectoryFixture([
            { tool_name: "Edit", tool_input: { file_path: "README.md" } },
        ]);
        session.tool_call_count = 20;
        const key = `spec:${kind}:review.md:2`;
        session.pending_completions.set(key, {
            source_file: "README.md", affected_files: ["review.md"], resolved_files: new Set(),
            recorded_at_tool_call: 1, description: "Inferred prose comparison",
        });
        // SAFETY: this helper reads only these config fields and graph.toRelative.
        const context = {
            config: { completion_tracking: true, completion_reminder_threshold: 2 },
            graph: { toRelative: (file: string) => file },
        } as unknown as PreToolContext;
        expect(preCheckCompletionTracking(context, session)).toEqual([]);
        expect(signatureChangeCallersNotUpdated.fn(session, lastEvent)).toEqual([]);
        expect(session.pending_completions.has(key)).toBe(true);
    });

    it("does not turn a retained spec entry with no affected paths into an unused helper", () => {
        const { session, lastEvent } = buildTrajectoryFixture([
            { tool_name: "Edit", tool_input: { file_path: "README.md" } },
        ]);
        session.pending_completions.set("spec:range_claim_drift:review.md:2", {
            source_file: "README.md", affected_files: [], resolved_files: new Set(),
            recorded_at_tool_call: 1, description: "Retained example comparison",
        });
        expect(unusedHelperIntroduced.fn(session, lastEvent)).toEqual([]);
        expect(session.pending_completions.size).toBe(1);
    });
});
