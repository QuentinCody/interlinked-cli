import { expect, it } from "vitest";
import { deliverNovelAdvisories, novelCoverageLines } from "./advisory-delivery.js";
import { makeServerRuntime } from "./__tests__/fixtures.js";

it("hides ticking coverage counts, announces new reasons, and rearms after recovery", () => {
    const owner = {};
    const event = { hook_event: "PostToolBatch", session_id: "a" };
    const first = "[interlinked:hook-coverage] NOT CHECKED: 100 protected/reserved file version(s)";
    expect(novelCoverageLines(owner, event, [first])).toEqual([first]);
    expect(novelCoverageLines(owner, event, [first.replace("100", "101")])).toEqual([]);
    expect(novelCoverageLines(owner, event, [first, "watcher offline"])).toEqual(["watcher offline"]);
    novelCoverageLines(owner, event, []);
    expect(novelCoverageLines(owner, event, [first])).toEqual([first]);
});

it("deduplicates pre-edit content advice per file and session, ignoring line drift", () => {
    const ctx = makeServerRuntime();
    const event = { hook_event: "PreToolUse", session_id: "a", tool_input: { file_path: "a.ts" } };
    const first = { decision: "allow" as const, warnings: ["[interlinked:content-quality] helper at line 3 in a.ts"] };
    expect(deliverNovelAdvisories(ctx, event, first).warnings).toHaveLength(1);
    expect(deliverNovelAdvisories(ctx, event, { ...first, warnings: ["[interlinked:content-quality] helper at line 9 in a.ts"] }).warnings).toEqual([]);
    expect(first.warnings).toHaveLength(1); // Delivery never mutates captured evidence.
    expect(deliverNovelAdvisories(ctx, { ...event, session_id: "b" }, first).warnings).toHaveLength(1);
    deliverNovelAdvisories(ctx, event, { decision: "allow" });
    expect(deliverNovelAdvisories(ctx, event, first).warnings).toHaveLength(1);
});

it("says the same test-evidence limitation once and always retains security messages and blocks", () => {
    const ctx = makeServerRuntime();
    const event = { hook_event: "PostToolUse", session_id: "a" };
    const decision = { decision: "block" as const, reason: "security block", warnings: ["[interlinked:test-evidence] no summary", "[interlinked:secrets] found secret"] };
    deliverNovelAdvisories(ctx, event, decision);
    const repeated = deliverNovelAdvisories(ctx, event, decision);
    expect(repeated.warnings).toEqual(["[interlinked:secrets] found secret"]);
    expect(repeated.decision).toBe("block");
    expect(repeated.reason).toBe("security block");
    expect(deliverNovelAdvisories(ctx, event, { ...decision, warnings: ["[interlinked:test-evidence] transport gap"] }).warnings).toHaveLength(1);
});
