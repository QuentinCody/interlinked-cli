import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

/** One newline-delimited JSON request over the raw socket, answered by one newline-delimited JSON reply. */
function rawRequest(socketPath: string, event: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let buffer = "";
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("raw socket reply timed out")); }, 10_000);
        socket.on("error", (error) => { clearTimeout(timer); reject(error); });
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            const newline = buffer.indexOf("\n");
            if (newline < 0) return;
            clearTimeout(timer);
            socket.end();
            // SAFETY: the raw protocol answers each request line with exactly one JSON object line.
            resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
        });
        socket.write(`${JSON.stringify(event)}\n`);
    });
}

describe("raw socket client without a working directory", () => {
    let fixture: E2eFixture;
    beforeAll(async () => { fixture = await createFixture({ protocol: "raw" }); });
    afterAll(async () => { await fixture?.close(); });

    // test-contract: boundary — the raw protocol accepts the legacy event shape, which carries no `cwd` (the documented
    // `nc -U` probe); such an event is still gated, and the session simply keeps whatever project root it already had
    it("gates a destructive command from a client that omits cwd", async () => {
        const reply = await rawRequest(fixture.paths.raw, {
            hook_event: "PreToolUse", session_id: "raw-no-cwd", agent_source: "claude", tool_name: "Bash",
            tool_input: { command: "rm -rf /" }, timestamp: "2026-03-17T00:00:00Z",
        });
        expect(reply.decision).toBe("block");
        expect(String(reply.reason)).toContain("BLOCKED");
    });
});
