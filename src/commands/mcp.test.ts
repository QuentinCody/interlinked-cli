import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRunMcpStdioProxy } = vi.hoisted(() => ({
    mockRunMcpStdioProxy: vi.fn(),
}));

vi.mock("../lib/mcp-recorder/stdio-proxy.js", () => ({
    runMcpStdioProxy: mockRunMcpStdioProxy,
}));

import { DEFAULT_MCP_INLINE_LIMIT_BYTES } from "../lib/mcp-recorder/writer.js";
import { mcpStdioCommand } from "./mcp.js";

describe("mcpStdioCommand", () => {
    const originalExitCode = process.exitCode;

    beforeEach(() => {
        vi.clearAllMocks();
        process.exitCode = undefined;
        mockRunMcpStdioProxy.mockResolvedValue(0);
    });

    afterEach(() => {
        process.exitCode = originalExitCode;
    });

    it("falls back to the default inline-limit byte count when --inline-limit is omitted", async () => {
        await mcpStdioCommand("node", ["server.js"], {
            server: "filesystem",
        });

        const [call] = mockRunMcpStdioProxy.mock.calls;
        expect(call?.[0]?.inlineLimitBytes).toBe(DEFAULT_MCP_INLINE_LIMIT_BYTES);
    });

    it("rejects with a descriptive error for a non-numeric --inline-limit", async () => {
        await expect(
            mcpStdioCommand("node", ["server.js"], {
                server: "filesystem",
                inlineLimit: "not-a-number",
            }),
        ).rejects.toThrow('invalid --inline-limit "not-a-number"; expected a non-negative integer');
        expect(mockRunMcpStdioProxy).not.toHaveBeenCalled();
    });

    it("rejects with a descriptive error for a negative --inline-limit", async () => {
        await expect(
            mcpStdioCommand("node", ["server.js"], {
                server: "filesystem",
                inlineLimit: "-1",
            }),
        ).rejects.toThrow('invalid --inline-limit "-1"; expected a non-negative integer');
    });

    it("writes the proxy's failure message to stderr and sets a non-zero exit code", async () => {
        mockRunMcpStdioProxy.mockRejectedValue(new Error("stdio proxy handshake failed"));
        const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        await mcpStdioCommand("node", ["server.js"], { server: "filesystem" });

        expect(stderrWrite).toHaveBeenCalledWith(
            "[interlinked] MCP stdio recorder failed: stdio proxy handshake failed\n",
        );
        expect(process.exitCode).toBe(1);

        stderrWrite.mockRestore();
    });
});
