import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { explainHarness } from "./harness-explain.js";
it("separates registered implementation, local policy, static client support and observation", async () => {
    const root = mkdtempSync(join(tmpdir(), "explain-"));
    try {
        mkdirSync(join(root, ".interlinked"));
        writeFileSync(join(root, ".interlinked/check-policy.local.json"), JSON.stringify({ overrides: { nan_comparison: { action: "silent" } } }));
        const result = await explainHarness({ cwd: root, topic: "nan_comparison", client: "claude" });
        expect(result.matches[0]).toMatchObject({ id: "nan_comparison", implemented: true, enabled_here: false, recently_observed: "unknown" });
        expect(result.matches[0]?.client_support).toHaveProperty("enforcement", "unmeasured");
        expect((await explainHarness({ cwd: root, topic: "tests_passed_recently" })).matches).toEqual([]);
        const predicate = await explainHarness({ cwd: root, topic: "active_agent_count_at_least" });
        expect(predicate.matches[0]).toMatchObject({ kind: "predicate", implemented: true, enabled_here: "conditional" });
    } finally { rmSync(root, { recursive: true, force: true }); }
});
