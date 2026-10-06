import { expect, it } from "vitest";
import { deliverNovelAdvisories, novelCoverageLines } from "./advisory-delivery.js";
import { makeServerRuntime } from "./__tests__/fixtures.js";

it("keeps deep-audit advice out of edit feedback without deleting evidence or weakening errors", () => {
    const ctx = makeServerRuntime();
    const event = { hook_event: "PostToolUse", session_id: "review-policy" };
    const observed = { source: "quality" as const, name: "expression_size", severity: "warning" as const, message: "long expression", determinism: "heuristic" as const };
    const raw = { decision: "allow" as const, warnings: ["[interlinked:expression_size] long expression", "[interlinked:secrets] unsafe credential"], check_results: [observed] };
    const first = deliverNovelAdvisories(ctx, event, raw);
    expect(first.warnings).toEqual(["[interlinked:secrets] unsafe credential", expect.stringContaining("advisory-review")]);
    expect(first.check_results).toEqual([observed]);
    expect(raw.warnings).toHaveLength(2);
    expect(deliverNovelAdvisories(ctx, event, raw).warnings).toEqual(["[interlinked:secrets] unsafe credential"]);
    const error = { ...raw, check_results: [{ ...observed, severity: "error" as const }] };
    expect(deliverNovelAdvisories(ctx, event, error).warnings).toContain(raw.warnings[0]);
    expect(deliverNovelAdvisories(ctx, event, { ...raw, decision: "block" }).warnings).toContain(raw.warnings[0]);
});

it("does not reissue unchanged guard advice on every edit or across-count changes", () => {
    const ctx = makeServerRuntime();
    const event = { hook_event: "PreToolUse", session_id: "guard-advice" };
    const message = "[interlinked:guard-prediction] Advisory: 1 guard-scope change(s) in a.ts";
    expect(deliverNovelAdvisories(ctx, event, { decision: "allow", warnings: [message] }).warnings).toEqual([message]);
    expect(deliverNovelAdvisories(ctx, event, { decision: "allow", warnings: [message.replace("1 guard", "2 guard")] }).warnings).toEqual([]);
    expect(deliverNovelAdvisories(ctx, { ...event, session_id: "other" }, { decision: "allow", warnings: [message] }).warnings).toEqual([message]);
});

it("preparing late feedback does not consume the synchronous advisory", () => {
    const ctx = makeServerRuntime();
    const event = { hook_event: "PostToolUse", session_id: "two-delivery-paths" };
    const raw = { decision: "allow" as const, warnings: ["[interlinked:complexity] extract helpers"] };
    const late = deliverNovelAdvisories(ctx, event, raw, "late");
    expect(late.warnings).toEqual([expect.stringContaining("advisory-review")]);
    expect(deliverNovelAdvisories(ctx, event, raw).warnings).toEqual(late.warnings);
    expect(deliverNovelAdvisories(ctx, event, raw, "late").warnings).toEqual([]);
    expect(raw.warnings).toEqual(["[interlinked:complexity] extract helpers"]);
});

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
