import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveCodexSubagentAttribution } from "./codex-subagent-attribution.js";
import type { HarnessEvent } from "./types.js";

it("still resolves an evicted rollout and never confuses actors when more than sixteen are active", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-attribution-cache-"));
    const event: HarnessEvent = { hook_event: "PostToolUse", agent_source: "codex", session_id: "parent",
        timestamp: "2026-10-08T12:00:00Z", tool_use_id: "exec-finished" };
    try {
        const paths = Array.from({ length: 17 }, (_, i) => {
            const path = join(root, `rollout-${i}.jsonl`);
            writeFileSync(path, [
                { type: "session_meta", payload: { id: `actor-${i}`, source: { subagent: {
                    thread_spawn: { agent_path: `/root/task-${i}`, parent_thread_id: "parent" },
                } } } },
                { type: "event_msg", payload: { item: { id: "exec-finished" } } },
            ].map(row => JSON.stringify(row)).join("\n"));
            return path;
        });
        for (const [i, path] of paths.entries()) {
            expect(resolveCodexSubagentAttribution(event, { rolloutPaths: [path] }))
                .toMatchObject({ subagent_id: `actor-${i}`, agent_name: `/root/task-${i}` });
        }
        expect(resolveCodexSubagentAttribution(event, { rolloutPaths: [paths[0]!] }))
            .toMatchObject({ subagent_id: "actor-0", parent_agent: "parent", model: null });
    } finally { rmSync(root, { recursive: true, force: true }); }
});
