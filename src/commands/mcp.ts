// ===========================================
// interlinked mcp — MCP protocol recording helpers
// ===========================================

import { resolve } from "node:path";
import { runMcpStdioProxy } from "../lib/mcp-recorder/stdio-proxy.js";
import { DEFAULT_MCP_INLINE_LIMIT_BYTES } from "../lib/mcp-recorder/writer.js";

export interface McpStdioCommandOptions {
    server: string;
    cwd?: string | undefined;
    serverCwd?: string | undefined;
    session?: string | undefined;
    inlineLimit?: string | undefined;
}

export async function mcpStdioCommand(
    command: string,
    args: string[],
    opts: McpStdioCommandOptions,
): Promise<void> {
    const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
    const serverCwd = opts.serverCwd ? resolve(opts.serverCwd) : cwd;
    const inlineLimitBytes = parseInlineLimit(opts.inlineLimit);

    try {
        process.exitCode = await runMcpStdioProxy({
            serverName: opts.server,
            command,
            args,
            cwd,
            serverCwd,
            sessionId: opts.session,
            inlineLimitBytes,
        });
    } catch (err) {
        process.stderr.write(
            `[interlinked] MCP stdio recorder failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
    }
}

function parseInlineLimit(value: string | undefined): number {
    if (value === undefined) {
        return DEFAULT_MCP_INLINE_LIMIT_BYTES;
    }
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
        throw new Error(`invalid --inline-limit "${value}"; expected a non-negative integer`);
    }
    return parsed;
}

