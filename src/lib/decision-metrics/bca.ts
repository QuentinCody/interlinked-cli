import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { object } from "./answers.js";
import { digest } from "./store.js";
import { runCommand } from "./transport.js";
import type { Json } from "./types.js";

interface BcaFunction {
    name: string;
    startLine: number;
    endLine: number;
    metrics: Record<string, Json>;
}

export function bcaFunctions(value: unknown): BcaFunction[] {
    const row = object(value);
    const result: BcaFunction[] = [];
    if (row.kind === "function") {
        if (
            typeof row.name !== "string" ||
            !Number.isInteger(row.start_line) ||
            !Number.isInteger(row.end_line)
        )
            throw new Error("invalid bca function span");
        // SAFETY: bca output came from JSON; metrics preserve raw JSON values after an object check.
        result.push({
            name: row.name,
            startLine: Number(row.start_line),
            endLine: Number(row.end_line),
            metrics: object(row.metrics) as Record<string, Json>,
        });
    }
    if (row.spaces !== undefined && !Array.isArray(row.spaces))
        throw new Error("invalid bca spaces");
    for (const child of row.spaces ?? []) result.push(...bcaFunctions(child));
    return result;
}

export async function measureBca(
    source: { file: string; content: string },
    options: { command: string; expectedVersion: string; deadline: number },
) {
    const version = await runCommand(options.command, ["--version"], {
        timeoutMs: Math.max(1, options.deadline - Date.now()),
    });
    if (version.exitCode !== 0 || version.stdout.trim() !== options.expectedVersion)
        throw new Error("bca version mismatch or unavailable");
    const folder = mkdtempSync(join(tmpdir(), "interlinked-bca-"));
    try {
        const file = join(folder, basename(source.file));
        writeFileSync(file, source.content, { mode: 0o600 });
        const args = ["metrics", "--no-config", "-O", "json", file];
        const result = await runCommand(options.command, args, {
            timeoutMs: Math.max(1, options.deadline - Date.now()),
        });
        if (result.exitCode !== 0 || result.timedOut) throw new Error("bca measurement failed");
        const raw: unknown = JSON.parse(result.stdout);
        return {
            tool: "bca",
            version: options.expectedVersion,
            config: args.slice(0, -1),
            sourceHash: digest(source.content),
            functions: bcaFunctions(raw),
            raw,
        };
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}
