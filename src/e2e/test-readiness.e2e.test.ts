import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

// Public contract: skills/interlinked-verify/SKILL.md, first authored edit per
// language/session without a test layout reports runner prerequisites.
describe("test readiness across real hook processes", () => {
    let fixture: E2eFixture;
    beforeAll(async () => { fixture = await createFixture({ rules: { per_edit_coverage: { enabled: false } } }); });
    afterAll(async () => { await fixture?.close(); });

    it.each([
        { language: "rust", path: "src/lib.rs", content: "pub fn answer() -> u32 { 42 }\n", manifest: "Cargo.toml" },
        { language: "go", path: "src/main.go", content: "package main\nfunc answer() int { return 42 }\n", manifest: "go.mod" },
    ])("reports missing $language prerequisites once per session", async ({ language, path, content, manifest }) => {
        const sessionId = `${fixture.sessionPrefix}-${language}`;
        const input = { file_path: fixture.file(path, content), content };
        async function post() {
            const result = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Write", input, payload: { tool_response: "success" } });
            fixture.assertServed(result);
            expect(result.code).toBe(0);
            return result.stdout + result.stderr;
        }
        const first = await post();
        expect(first).toContain("[interlinked:test-readiness]");
        expect(first).toContain(manifest);
        expect(first).toContain(`interlinked tests readiness ${language} --json`);
        expect(first).toContain("No test layout was detected");
        expect(await post()).not.toContain("[interlinked:test-readiness]");
    });
});
