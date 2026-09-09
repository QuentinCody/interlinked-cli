import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCoworkBridge } from "./bridge.js";
import { runCoworkHook } from "./runtime.js";
import { DEFAULT_COWORK_POLICY } from "./policy.js";

const servers: Server[] = [], roots: string[] = [];
const TOKEN = "synthetic-cowork-token-for-local-tests-only";
afterEach(async () => {
    for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(decision: "allow" | "ask" = "allow") {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cowork-bridge-"))); roots.push(root);
    const calls: Record<string, unknown>[] = [];
    const server = createCoworkBridge({ token: TOKEN, workspace: { id: "synthetic", hostRoot: root, runtimeRoot: "/native" },
        evaluate: async event => { calls.push(event); return { decision, checks: ["test_external_evaluator"], unmeasured: ["native_enforcement"] }; } });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing bridge listener");
    return { url: `http://127.0.0.1:${address.port}/hook`, root, calls };
}
function request(path = "/native/test.txt", workspace = "synthetic") {
    return JSON.stringify({ schema: 1, workspace, fileState: { exists: false, sha256: null }, event: { hook_event_name: "PreToolUse", session_id: "s", tool_use_id: "call", tool_name: "Write", cwd: "/native", tool_input: { file_path: path, content: "test" } } });
}
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
describe("Cowork authenticated bridge", () => {
    it("rejects unauthenticated requests without evaluating their content", async () => {
        const state = await fixture();
        const response = await fetch(state.url, { method: "POST", body: request() });
        expect(response.status).toBe(401);
        expect(state.calls).toHaveLength(0);
    });
    it("maps only the configured workspace before evaluation", async () => {
        const state = await fixture();
        const response = await fetch(state.url, { method: "POST", headers, body: request() });
        expect(response.status).toBe(200);
        expect(state.calls).toEqual([expect.objectContaining({ cwd: state.root, tool_input: { file_path: join(state.root, "test.txt"), content: "test" } })]);
    });
    it.each([["/native/../outside", "synthetic"], ["/native/test.txt", "different-workspace"]])("rejects path/workspace mismatch %s %s", async (path, workspace) => {
        const state = await fixture();
        const response = await fetch(state.url, { method: "POST", headers, body: request(path, workspace) });
        expect(response.status).toBe(422);
        expect(state.calls).toHaveLength(0);
    });
    it("rejects browser-origin requests even with a token", async () => {
        const state = await fixture();
        const response = await fetch(state.url, { method: "POST", headers: { ...headers, Origin: "https://example.invalid" }, body: request() });
        expect(response.status).toBe(404);
        expect(state.calls).toHaveLength(0);
    });
    it("refuses mismatched file versions before host evaluation", async () => {
        const state = await fixture();
        writeFileSync(join(state.root, "test.txt"), "host has an existing version");
        const response = await fetch(state.url, { method: "POST", headers, body: request() });
        expect(response.status).toBe(422);
        expect(state.calls).toHaveLength(0);
    });
    it("refuses requests without native file evidence", async () => {
        const state = await fixture();
        const body = JSON.parse(request());
        delete body.fileState;
        const response = await fetch(state.url, { method: "POST", headers, body: JSON.stringify(body) });
        expect(response.status).toBe(422);
        expect(state.calls).toHaveLength(0);
    });
    it("preserves host ask through the runtime HTTP round trip", async () => {
        const state = await fixture("ask");
        const name = "INTERLINKED_COWORK_BRIDGE_TEST_TOKEN", prior = process.env[name];
        process.env[name] = TOKEN;
        try {
            writeFileSync(join(state.root, "policy.json"), JSON.stringify({ ...DEFAULT_COWORK_POLICY, bridge: { url: state.url, workspace: "synthetic", tokenEnv: name } }));
            const event = JSON.parse(request()).event;
            const output = await runCoworkHook(state.root, event, "PreToolUse");
            expect(output).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
            expect(state.calls).toHaveLength(1);
        } finally {
            if (prior === undefined) delete process.env[name];
            else process.env[name] = prior;
        }
    });
});
