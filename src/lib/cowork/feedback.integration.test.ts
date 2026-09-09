import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createCoworkBridge } from "./bridge.js";
import { DEFAULT_COWORK_POLICY } from "./policy.js";
import { runCoworkHook } from "./runtime.js";

const roots: string[] = [], servers: Server[] = [];
const HOST_CONTEXT = "Host advisory: review the repository policy before proceeding.";
afterEach(async () => {
    vi.unstubAllEnvs();
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(content: string) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cowork-feedback-"))); roots.push(root);
    const token = "synthetic-cowork-feedback-credential";
    vi.stubEnv("INTERLINKED_COWORK_FEEDBACK_TOKEN", token);
    const server = createCoworkBridge({ token, workspace: { id: "feedback", hostRoot: root, runtimeRoot: root },
        evaluate: async () => ({ decision: "allow", context: HOST_CONTEXT, checks: ["host_advisory"], unmeasured: [] }) });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing bridge address");
    writeFileSync(join(root, "policy.json"), JSON.stringify({ ...DEFAULT_COWORK_POLICY,
        bridge: { url: `http://127.0.0.1:${address.port}/hook`, tokenEnv: "INTERLINKED_COWORK_FEEDBACK_TOKEN", workspace: "feedback" } }));
    const path = join(root, "report.md"); writeFileSync(path, content);
    return { root, raw: { session_id: "feedback-session", tool_name: "Write", tool_use_id: "feedback-call", cwd: root,
        tool_input: { file_path: path, content } } };
}

it("delivers allowed pre-tool host guidance without granting permission or logging its text", async () => {
    const { root, raw } = await fixture("A finished report.");
    const output = await runCoworkHook(root, { ...raw, hook_event_name: "PreToolUse" }, "PreToolUse");
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: HOST_CONTEXT } });
    expect(readFileSync(join(root, "evidence/events.jsonl"), "utf8")).not.toContain(HOST_CONTEXT);
});

it.each([{ content: "A finished report.", expected: "listed artifact checks completed" }, { content: "TODO: finish the report.", expected: "placeholder_text" }])("preserves host findings alongside post-write artifact feedback: $expected", async ({ content, expected }) => {
    const { root, raw } = await fixture(content);
    const output = await runCoworkHook(root, { ...raw, hook_event_name: "PostToolUse" }, "PostToolUse");
    expect(output).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringMatching(/^Host advisory:.*\n\[interlinked:cowork\] Artifact /) } });
    expect(output).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining(expected) } });
    expect(readFileSync(join(root, "evidence/events.jsonl"), "utf8")).not.toContain(HOST_CONTEXT);
});
