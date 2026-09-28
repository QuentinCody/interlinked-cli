import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeHookMetrics } from "./native-hook-metrics.mjs";

test("counts rendered context once, excluding terminal-only output and undelivered tail", () => {
    const hook = { uuid: "one", type: "attachment", attachment: { type: "hook_additional_context", hookEvent: "PostToolUse" }, rendered: [{ content: "[interlinked] hello" }] };
    const rows = [hook, hook, { uuid: "terminal", type: "attachment", attachment: { type: "hook_success", stdout: "[interlinked] hello", durationMs: 3 } },
        { type: "assistant", message: { content: [] } }, { ...hook, uuid: "tail" }];
    const measured = nativeHookMetrics(rows);
    assert.equal(measured.rendered_hook_bytes, Buffer.byteLength("[interlinked] hello"));
    assert.equal(measured.rendered_hook_messages, 1);
    assert.equal(measured.hook_durations_ms.length, 1);
});
