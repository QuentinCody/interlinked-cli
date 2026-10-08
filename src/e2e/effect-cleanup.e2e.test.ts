import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectCleanupCases } from "../harness/checks/__fixtures__/effect-cleanup-cases.js";
import { createFixture, type E2eFixture } from "./fixture.js";

describe("effect cleanup advisory through the real hook and daemon", () => {
    let fixture: E2eFixture;
    beforeAll(async () => {
        fixture = await createFixture({ rules: { per_edit_coverage: { enabled: false } } });
    });
    afterAll(async () => { await fixture?.close(); });

    // test-contract: bug — the missing timer teardown reaches the agent as an advisory; the paired cleanup remains accepted.
    it.each(effectCleanupCases)("$name", async ({ name, content, path, lines }) => {
        fixture.file(path, "export function PollingWidget() { return <span>Polling</span>; }");
        const sessionId = `${fixture.sessionPrefix}-${name}`;
        const input = { file_path: join(fixture.cwd, path), content };
        const pre = await fixture.hook({ sessionId, tool: "Write", input });
        fixture.assertServed(pre);
        expect(pre.stdout, pre.stderr).not.toContain('"deny"');
        fixture.file(path, content);
        const result = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Write", input,
            payload: { tool_response: "success" } });
        fixture.assertServed(result);
        expect(result.code).toBe(0);
        const output = result.stdout + result.stderr;
        expect(output.includes("[interlinked:missing_effect_cleanup]"), output).toBe(lines.length > 0);
        expect(result.stdout).not.toContain('"deny"');
    });
});
