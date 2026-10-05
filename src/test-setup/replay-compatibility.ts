import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __version } from "fast-check";
import { wireNullable, wireObject, wireString } from "../lib/value-validation.js";

export interface ReplayBinding {
    engine: string; runtime: string; test: string | null; dependencies: string | null; generator: string | null;
}
export const isReplayBinding = wireObject<ReplayBinding>({ engine: wireString, runtime: wireString,
    test: wireNullable(wireString), dependencies: wireNullable(wireString), generator: wireNullable(wireString) });
function digestFile(file: string): string | null {
    try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return null; }
}
/** A candidate replay binding, not proof of arbitrary helper/environment closure. */
export function replayBinding(root: string, testId: string | null, generator?: string): ReplayBinding {
    return { engine: "fast-check@" + __version, runtime: process.version,
        test: testId ? digestFile(join(root, testId.split("::")[0] ?? "")) : null,
        dependencies: digestFile(join(root, "package-lock.json")), generator: generator ?? null };
}
export function canReplay(stored: ReplayBinding | undefined, current: ReplayBinding): boolean {
    if (!stored || (!current.test && !current.generator)) return false;
    return (["engine", "runtime", "test", "dependencies", "generator"] as const).every(key => stored[key] === current[key]);
}
