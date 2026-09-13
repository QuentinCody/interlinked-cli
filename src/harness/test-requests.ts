import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";

export interface PendingTests { ids: string[]; paths: string[]; full: boolean; }
function directory(root: string): string { return join(root, ".interlinked/test-runs/requests"); }
export function hasTestRequest(root: string, id: string): boolean { return existsSync(join(directory(root), `${id}.json`)); }

export function requestTests(root: string, paths: readonly string[], full: boolean): string {
    const dir = directory(root), id = randomUUID();
    mkdirSync(dir, { recursive: true });
    const temporary = join(dir, `${id}.tmp`);
    writeFileSync(temporary, JSON.stringify({ paths, full }), { mode: 0o600 });
    renameSync(temporary, join(dir, `${id}.json`));
    return id;
}

/** Requests preserve edits arriving during an active run or after a timeout. */
export function pendingTests(root: string): PendingTests {
    const dir = directory(root);
    mkdirSync(dir, { recursive: true });
    const ids = readdirSync(dir).filter(path => path.endsWith(".json")).sort().slice(0, 1000);
    const paths = new Set<string>();
    let full = false;
    for (const id of ids) {
        const value: unknown = JSON.parse(readFileSync(join(dir, id), "utf8"));
        if (!isJsonObject(value) || typeof value.full !== "boolean" || !Array.isArray(value.paths) || !value.paths.every((path): path is string => typeof path === "string")) throw new Error(`Malformed pending test request: ${id}`);
        for (const path of value.paths) paths.add(path);
        full ||= value.full;
    }
    return { ids, paths: [...paths].sort(), full };
}

export function completeTestRequests(root: string, ids: string[]): void {
    for (const id of ids) rmSync(join(directory(root), id), { force: true });
}
