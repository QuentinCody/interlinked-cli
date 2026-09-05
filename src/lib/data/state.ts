import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileRange } from "../bounded-file-io.js";
import { getDataDir } from "../config.js";
import { withFileMutationLock } from "../file-mutation-lock.js";
import { isJsonObject, type JsonObject } from "../json-types.js";
import { dataRecordHash } from "./normalize.js";

const STATE_BYTES = 8 * 1024 * 1024;
export function readCaptureState(cwd: string, key: string): JsonObject {
    return readState(join(getDataDir(cwd), "capture", "state", `${dataRecordHash(key)}.json`));
}
function readState(path: string): JsonObject {
    if (!existsSync(path)) return {};
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("capture state is not a regular file");
    if (stat.size > STATE_BYTES) throw new Error("capture state exceeds its materialization budget");
    const bytes = readFileRange(path, 0, stat.size, STATE_BYTES);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isJsonObject(value)) throw new Error("invalid capture state");
    return value;
}

/** Derived state updates are serialized; raw event streams remain authoritative. */
export function updateCaptureState<T>(cwd: string, key: string, update: (state: JsonObject) => { state: JsonObject; result: T }): T {
    return updateCaptureStateAt(getDataDir(cwd), key, update);
}

export function updateCaptureStateAt<T>(dataDir: string, key: string, update: (state: JsonObject) => { state: JsonObject; result: T }): T {
    const path = join(dataDir, "capture", "state", `${dataRecordHash(key)}.json`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return withFileMutationLock(path, () => {
        const next = update(readState(path));
        const body = JSON.stringify(next.state);
        if (Buffer.byteLength(body) > STATE_BYTES) throw new Error("capture state exceeds its serialization budget");
        const temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
        return next.result;
    }, { waitMs: 0 });
}
