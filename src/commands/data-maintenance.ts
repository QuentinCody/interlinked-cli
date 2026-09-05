import type { OptionValues } from "commander";
import { dataConfigPath, readDataConfig, updateDataConfig, type DataConfig } from "../lib/data/config.js";
import { maintainData } from "../lib/data/maintenance.js";
import { outputError } from "../lib/output.js";

function configChanges(options: OptionValues): Partial<DataConfig> {
    const changes: Partial<DataConfig> = {};
    for (const [option, key] of [["autoIndex", "auto_index"], ["autoCompact", "auto_compact"]] as const) {
        const value = options[option];
        if (value === undefined) continue;
        if (value !== "on" && value !== "off") throw new Error(`${option} must be on or off`);
        changes[key] = value === "on";
    }
    for (const [option, key] of [["indexMb", "index_max_mb"], ["indexRecords", "index_max_records"], ["keepLiveMb", "keep_live_mb"], ["compactAtMb", "compact_at_mb"]] as const) {
        if (options[option] !== undefined) changes[key] = Number(options[option]);
    }
    return changes;
}

export async function dataMaintenanceCommand(operation: "configure" | "maintain", options: OptionValues): Promise<void> {
    try {
        const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
        if (operation === "maintain") {
            console.log(JSON.stringify(await maintainData(cwd, { execute: options.execute === true, compact: options.compact === true }), null, 2));
            return;
        }
        const changes = configChanges(options);
        const config = Object.keys(changes).length ? updateDataConfig(cwd, changes) : readDataConfig(cwd);
        console.log(JSON.stringify({ path: dataConfigPath(cwd), config }, null, 2));
    } catch (error) {
        outputError(options.json ? "json" : "normal", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
