// ===========================================
// MCP Recorder — stdio proxy
// ===========================================
// Launches a real stdio MCP server, forwards stdin/stdout/stderr, and records
// JSON-RPC traffic observed on the protocol streams.

import { spawn } from "node:child_process";
import { McpProtocolRecorder } from "./recorder.js";

export interface McpStdioProxyOptions {
    serverName: string;
    command: string;
    args?: string[] | undefined;
    cwd?: string | undefined;
    serverCwd?: string | undefined;
    sessionId?: string | undefined;
    inlineLimitBytes?: number | undefined;
    env?: NodeJS.ProcessEnv | undefined;
}

export async function runMcpStdioProxy(opts: McpStdioProxyOptions): Promise<number> {
    const cwd = opts.cwd ?? process.cwd();
    const child = spawn(opts.command, opts.args ?? [], {
        cwd: opts.serverCwd ?? cwd,
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const recorder = new McpProtocolRecorder({
        cwd,
        serverName: opts.serverName,
        transport: "stdio",
        sessionId: opts.sessionId,
        inlineLimitBytes: opts.inlineLimitBytes,
    });
    const clientLines = new JsonLineBuffer((line) => {
        recorder.recordJsonLine("client_to_server", line);
    });
    const serverLines = new JsonLineBuffer((line) => {
        recorder.recordJsonLine("server_to_client", line);
    });
    const stderrLines = new JsonLineBuffer((line) => {
        recorder.recordStderrLine(line);
    });

    const onStdinData = (chunk: Buffer): void => {
        clientLines.write(chunk);
        if (child.stdin.writable) {
            child.stdin.write(chunk);
        }
    };
    const onStdinEnd = (): void => {
        clientLines.flush();
        child.stdin.end();
    };
    const onStdinError = (err: Error): void => {
        recorder.recordTransportError(`client stdin error: ${err.message}`);
    };
    process.stdin.on("data", onStdinData);
    process.stdin.on("end", onStdinEnd);
    process.stdin.on("error", onStdinError);

    child.stdout.on("data", (chunk: Buffer) => {
        serverLines.write(chunk);
        process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
        stderrLines.write(chunk);
        process.stderr.write(chunk);
    });
    child.stdin.on("error", (err: Error) => {
        recorder.recordTransportError(`server stdin error: ${err.message}`);
    });

    const forwardSignals = installSignalForwarding((signal) => {
        if (!child.killed) {
            child.kill(signal);
        }
    });

    return await new Promise<number>((resolve) => {
        let settled = false;
        const settle = (exitCode: number): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanupStdinListeners({ onStdinData, onStdinEnd, onStdinError });
            forwardSignals.cleanup();
            resolve(exitCode);
        };

        child.on("error", (err: Error) => {
            clientLines.flush();
            serverLines.flush();
            stderrLines.flush();
            recorder.recordTransportError(`failed to start MCP server: ${err.message}`);
            settle(1);
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
            clientLines.flush();
            serverLines.flush();
            stderrLines.flush();
            recorder.recordTransportClose(code, signal);
            settle(resolveExitCode(code, signal));
        });
    });
}

function cleanupStdinListeners(handlers: {
    onStdinData: (chunk: Buffer) => void;
    onStdinEnd: () => void;
    onStdinError: (err: Error) => void;
}): void {
    process.stdin.off("data", handlers.onStdinData);
    process.stdin.off("end", handlers.onStdinEnd);
    process.stdin.off("error", handlers.onStdinError);
    process.stdin.pause();
}

class JsonLineBuffer {
    private buffer = "";
    private readonly onLine: (line: string) => void;

    constructor(onLine: (line: string) => void) {
        this.onLine = onLine;
    }

    write(chunk: Buffer | string): void {
        this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
        while (true) {
            const newline = this.buffer.indexOf("\n");
            if (newline === -1) {
                return;
            }
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            this.onLine(line);
        }
    }

    flush(): void {
        if (this.buffer.length === 0) {
            return;
        }
        const line = this.buffer;
        this.buffer = "";
        this.onLine(line);
    }
}

function installSignalForwarding(
    onSignal: (signal: NodeJS.Signals) => void,
): { cleanup: () => void } {
    const onSigint = (): void => {
        onSignal("SIGINT");
    };
    const onSigterm = (): void => {
        onSignal("SIGTERM");
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    return {
        cleanup: () => {
            process.off("SIGINT", onSigint);
            process.off("SIGTERM", onSigterm);
        },
    };
}

function resolveExitCode(code: number | null, signal: NodeJS.Signals | null): number {
    if (code !== null) {
        return code;
    }
    if (signal) {
        return 1;
    }
    return 0;
}
