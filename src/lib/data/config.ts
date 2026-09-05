import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileRange } from "../bounded-file-io.js";
import { getDataDir } from "../config.js";
import { withFileMutationLock } from "../file-mutation-lock.js";
import { isJsonObject } from "../json-types.js";

export interface DataConfig {
    version: 1; auto_index: boolean; auto_compact: boolean;
    index_max_mb: number; index_max_records: number; keep_live_mb: number; compact_at_mb: number;
}
export const DEFAULT_DATA_CONFIG: Readonly<DataConfig> = {
    version: 1, auto_index: false, auto_compact: false,
    index_max_mb: 256, index_max_records: 250_000, keep_live_mb: 64, compact_at_mb: 256,
};
const CONFIG_BYTES = 64 * 1024;
const NUMERIC_KEYS = ["index_max_mb", "index_max_records", "keep_live_mb", "compact_at_mb"] as const;

export function parseDataConfig(value: unknown): DataConfig {
    if (!isJsonObject(value)) throw new Error("data config must be an object");
    for (const key of Object.keys(value)) if (!Object.hasOwn(DEFAULT_DATA_CONFIG, key)) throw new Error(`unknown data config key: ${key}`);
    const merged = { ...DEFAULT_DATA_CONFIG, ...value };
    if (merged.version !== 1 || typeof merged.auto_index !== "boolean" || typeof merged.auto_compact !== "boolean") throw new Error("invalid data config version or automation flags");
    for (const key of NUMERIC_KEYS) {
        const number = merged[key];
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || !Number.isSafeInteger(number * 1024 * 1024)) throw new Error(`${key} must be a positive bounded integer`);
    }
    if (merged.keep_live_mb >= merged.compact_at_mb) throw new Error("keep_live_mb must be smaller than compact_at_mb");
    return { version: 1, auto_index: merged.auto_index, auto_compact: merged.auto_compact,
        index_max_mb: Number(merged.index_max_mb), index_max_records: Number(merged.index_max_records),
        keep_live_mb: Number(merged.keep_live_mb), compact_at_mb: Number(merged.compact_at_mb) };
}
export function dataConfigPath(cwd: string): string { return join(getDataDir(cwd), "data.config.json"); }
export function readDataConfig(cwd: string): DataConfig {
    const path = dataConfigPath(cwd);
    if (!existsSync(path)) return { ...DEFAULT_DATA_CONFIG };
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > CONFIG_BYTES) throw new Error("data config is not a bounded regular file");
    const value: unknown = JSON.parse(readFileRange(path, 0, stat.size, CONFIG_BYTES).toString("utf8"));
    return parseDataConfig(value);
}
export function updateDataConfig(cwd: string, changes: Partial<DataConfig>): DataConfig {
    const path = dataConfigPath(cwd);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return withFileMutationLock(path, () => {
        const config = parseDataConfig({ ...readDataConfig(cwd), ...changes });
        const temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        renameSync(temporary, path);
        return config;
    }, { waitMs: 0 });
}
