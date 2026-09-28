import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { isInsideRoot } from "../large-file-policy.js";
import type { HarnessEvent } from "../types.js";

export interface CompilerBatch {
    revision: string;
    paths: string[];
    calls: string[];
    blocking: string[];
}

export function compilerSessionKey(event: HarnessEvent): string {
    return `${event.agent_source}\0${event.session_id}\0${event.subagent_id ?? ""}`;
}

function pathFor(cwd: string, event: HarnessEvent): string {
    const key = createHash("sha256").update(compilerSessionKey(event)).digest("hex");
    return join(cwd, ".interlinked", "compiler-batches", `${key}.json`);
}

function strings(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** Corrupt pending work is an explicit verification failure, never an empty queue. */
export function readCompilerBatch(cwd: string, event: HarnessEvent): CompilerBatch {
    const path = pathFor(cwd, event);
    if (!existsSync(path)) return { revision: "", paths: [], calls: [], blocking: [] };
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(value) || typeof value.revision !== "string" || !strings(value.paths)
        || !strings(value.calls) || !strings(value.blocking)) throw new Error("Invalid pending compiler batch");
    if (!value.paths.every(file => isInsideRoot(cwd, file))) throw new Error("Pending compiler target outside project");
    return { revision: value.revision, paths: value.paths, calls: value.calls, blocking: value.blocking };
}

export function writeCompilerBatch(cwd: string, event: HarnessEvent, batch: CompilerBatch): void {
    const path = pathFor(cwd, event);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...batch, revision: randomUUID() }), { mode: 0o600 });
    renameSync(temporary, path);
}

/** Do not acknowledge edits that arrived while the compiler was running. */
export function completeCompilerBatch(cwd: string, event: HarnessEvent, checked: CompilerBatch, blocking: string[], unavailable: boolean): boolean {
    const current = readCompilerBatch(cwd, event);
    if (current.revision !== checked.revision) {
        writeCompilerBatch(cwd, event, { ...current, blocking: [...new Set([...current.blocking, ...blocking])] });
        return false;
    }
    writeCompilerBatch(cwd, event, { ...checked, paths: blocking.length || unavailable ? checked.paths : [], blocking, calls: [] });
    return true;
}
