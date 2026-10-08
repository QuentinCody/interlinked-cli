import { expect, it } from "vitest";
import { makeSession } from "../__tests__/fixtures/evaluator.js";
import { evaluatePermissionPatternDetection, evaluatePreChecksTail } from "./pre-tool-phases.js";
import type { HarnessEvent } from "../types.js";

it("suggests a repeated WebFetch domain and deduplicates the observation without shell text", () => {
    const session = makeSession();
    const warnings: string[] = [];
    for (let i = 0; i < 3; i++) {
        evaluatePermissionPatternDetection(session, "WebFetch", { url: "https://example.com/docs" }, warnings);
    }
    expect(warnings).toEqual([
        '[interlinked:permissions] Repeated request "WebFetch(domain:example.com)": review "WebFetch(domain:example.com)" (suggestion only). Observations are not proof of approval or execution; permissions were not changed.',
    ]);
    expect(session.suggested_permissions).toEqual(new Set(["WebFetch(domain:example.com)"]));
    expect(session.consecutive_pattern).toBeNull();
    evaluatePermissionPatternDetection(session, "WebFetch", { url: "https://example.com/other" }, warnings);
    expect(warnings).toHaveLength(1);
});

it("tolerates a metadata-only event without inventing a test edit", () => {
    const event: HarnessEvent = { hook_event: "PreToolUse", session_id: "empty-event", agent_source: "codex", timestamp: "t" };
    const session = makeSession();
    const warnings: string[] = [];
    expect(evaluatePreChecksTail(event, session, undefined, "Read", {}, warnings)).toBeNull();
    expect(warnings).toEqual([]);
    expect(session.assertion_counts.size).toBe(0);
});
