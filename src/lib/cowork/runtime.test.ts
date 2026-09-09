import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCoworkHook } from "./runtime.js";
import { DEFAULT_COWORK_POLICY } from "./policy.js";
import { summarizeCoworkReceipts } from "./receipts.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "cowork-runtime-")); roots.push(root);
    writeFileSync(join(root, "policy.json"), JSON.stringify(DEFAULT_COWORK_POLICY));
    return root;
}
const raw = { hook_event_name: "PreToolUse", session_id: "private-session-id", tool_use_id: "native-call", tool_name: "Write", cwd: "/tmp", tool_input: { file_path: "/tmp/allowed.txt", content: "PRIVATE_CONTENT_DO_NOT_LOG" } };

describe("packaged Cowork hook runtime", () => {
    it("records metadata without private input, ids, or claimed native enforcement", async () => {
        const root = fixture();
        expect(await runCoworkHook(root, raw, "PreToolUse")).toBeNull();
        const text = readFileSync(join(root, "evidence/events.jsonl"), "utf8");
        expect(text).not.toContain("PRIVATE_CONTENT_DO_NOT_LOG");
        expect(text).not.toContain("private-session-id");
        expect(summarizeCoworkReceipts(text)).toMatchObject({ records: 1, enforcement: "unmeasured" });
    });
    it("does not silently allow malformed policy or a configured unavailable bridge", async () => {
        const root = fixture();
        writeFileSync(join(root, "policy.json"), "{}");
        await expect(runCoworkHook(root, raw, "PreToolUse")).rejects.toThrow("policy");
        writeFileSync(join(root, "policy.json"), JSON.stringify({ ...DEFAULT_COWORK_POLICY, bridge: { url: "https://example.invalid/hook", tokenEnv: "INTERLINKED_COWORK_TEST_UNSET", workspace: "test" } }));
        await expect(runCoworkHook(root, raw, "PreToolUse")).rejects.toThrow("credential");
    });
    it("refuses an allow when the evidence journal cannot be written", async () => {
        const root = fixture();
        mkdirSync(join(root, "evidence"));
        mkdirSync(join(root, "evidence/events.jsonl"));
        await expect(runCoworkHook(root, raw, "PreToolUse")).rejects.toThrow();
    });
    it("fault injection is inert in guard mode", async () => {
        expect(await runCoworkHook(fixture(), { ...raw, tool_input: { file_path: "/tmp/interlinked-probe-crash.txt", content: "safe" } }, "PreToolUse")).toBeNull();
    });
});
