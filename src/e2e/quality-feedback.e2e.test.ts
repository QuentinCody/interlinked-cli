import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_QUALITY_CHECKS } from "../harness/rules/default-config-quality-checks.js";
import { createClaudeCodeAdapter } from "../harness/adapters/claude-code.js";
import { callHookDaemon } from "../hook-entry-transport.js";
import { createFixture, type E2eFixture, PROJECT_ROOT } from "./fixture.js";

let fixture: E2eFixture;
beforeAll(async () => {
    const quality_checks = Object.fromEntries(Object.entries(DEFAULT_QUALITY_CHECKS).map(([name, config]) => [name, { ...config, enabled: name === "typescript" }]));
    fixture = await createFixture({ rules: { quality_checks, per_edit_coverage: { enabled: false },
        structural_checks: { enabled: false, smart_tsc: false }, project_wide_checks: { enabled: false } } });
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(fixture.cwd, "node_modules"));
    fixture.file("package.json", '{"type":"module"}');
    fixture.file("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ["src"] }));
    fixture.file("src/a.ts", "export const answer = 42;\n");
    fixture.file("src/a.test.ts", 'import { answer } from "./a"; void answer;\n');
});
afterAll(async () => { await fixture?.close(); });

async function reportEdit(name: string) {
    const file_path = fixture.file("src/a.ts", "export const answer = 42;\n");
    const sessionId = `${fixture.sessionPrefix}-${name}`;
    const input = { file_path, old_string: "42", new_string: "43" };
    const pre = await fixture.hook({ sessionId, tool: "Edit", input, payload: { tool_use_id: name } });
    fixture.assertServed(pre);
    expect(pre.stdout, pre.stderr).not.toContain('"deny"');
    fixture.file("src/a.ts", "export const answer = 43;\n");
    const result = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Edit",
        input, payload: { tool_use_id: name, tool_response: "success" } });
    fixture.assertServed(result);
    return result.stdout + result.stderr;
}

it("retains the clean compiler summary in the daemon verdict", async () => {
    await reportEdit("clean"); // Delivers the once-per-session contract guidance.
    const event = createClaudeCodeAdapter().parseHookInput({ cwd: fixture.cwd, session_id: `${fixture.sessionPrefix}-clean`,
        tool_name: "Edit", tool_input: { file_path: join(fixture.cwd, "src/a.ts"), old_string: "42", new_string: "43" }, tool_response: "success" }, "PostToolUse");
    const reply = await callHookDaemon({ socketPath: fixture.paths.framed, method: "hook.post_tool_use", event, timeoutMs: 10_000, env: { INTERLINKED_HOOK_PROTOCOL: "framed" } });
    expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, decision: { decision: "allow", summary: expect.stringContaining("tsc — all clean") } });
});

it("keeps an unrelated pre-existing compiler error advisory and does not report all-clean", async () => {
    fixture.file("src/unrelated.ts", 'export const broken: number = "wrong";\n');
    const introduced = await reportEdit("introduced");
    expect(introduced).toContain("TS2322");
    const output = await reportEdit("existing");
    expect(output).toContain("pre-existing");
    expect(output).not.toContain("all clean");
    expect(output).not.toContain('"decision":"block"');
});
