import { DATA_CATALOG } from "../lib/data/catalog.js";
import { discoverDataFiles } from "../lib/data/discovery.js";
import { readDataEvidence } from "../lib/data/evidence.js";
import { dataHealth, dataIndexStatus } from "../lib/data/health.js";
import { indexData } from "../lib/data/indexer.js";
import { readDataConfig } from "../lib/data/config.js";
import { searchData, type DataSearchOptions } from "../lib/data/search.js";
import { dataView, type DataView } from "../lib/data/views.js";
import { investigateData } from "../lib/data/investigate.js";
import { recurrenceInventory } from "../lib/data/recurrence-inventory.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { resolveTimeBound } from "./query/filters.js";
import { isJsonObject } from "../lib/json-types.js";

export interface DataCommandOptions {
    call?: string;
    rebuild?: boolean;
    cwd?: string; json?: boolean; short?: boolean; full?: boolean;
    source?: string; category?: string; session?: string; actor?: string;
    provider?: string; model?: string; file?: string; check?: string;
    kind?: string; decision?: string; origin?: string; fts?: boolean;
    since?: string; until?: string; limit?: string; offset?: string;
    archives?: boolean; maxMb?: string; maxRecords?: string;
}
export type DataOperation = "catalog" | "health" | "status" | "index" | "search" | "show" | "investigate" | "recurrence-inventory" | DataView;
const MIB = 1024 * 1024;

function numericOption(raw: string | undefined, label: string): number | undefined {
    if (raw === undefined) return undefined;
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a nonnegative number`);
    return number;
}

function searchOptions(options: DataCommandOptions, text?: string): DataSearchOptions {
    return { ...options, text,
        sinceMs: options.since === undefined ? undefined : resolveTimeBound(options.since),
        untilMs: options.until === undefined ? undefined : resolveTimeBound(options.until),
        limit: numericOption(options.limit, "limit"), offset: numericOption(options.offset, "offset") };
}

async function runDataOperation(operation: DataOperation, options: DataCommandOptions, argument?: string): Promise<unknown> {
    const cwd = options.cwd ?? process.cwd();
    if (operation === "catalog") return { sources: DATA_CATALOG, discovery: discoverDataFiles(cwd) };
    if (operation === "health") return dataHealth(cwd);
    if (operation === "recurrence-inventory") return recurrenceInventory(cwd);
    if (operation === "status") return dataIndexStatus(cwd);
    if (operation === "show") return readDataEvidence(cwd, argument ?? "");
    if (operation === "index") {
        return runIndexOperation(cwd, options);
    }
    if (operation === "search") return searchData(cwd, searchOptions(options, argument));
    if (operation === "investigate") return investigateData(cwd, searchOptions(options));
    return dataView(cwd, operation, searchOptions(options));
}

function runIndexOperation(cwd: string, options: DataCommandOptions) {
    const config = readDataConfig(cwd);
    const megabytes = numericOption(options.maxMb, "max-mb") ?? config.index_max_mb;
    return indexData(cwd, { source: options.source, archives: options.archives, rebuild: options.rebuild,
        maxRecords: numericOption(options.maxRecords, "max-records") ?? config.index_max_records,
        maxBytes: Math.floor(megabytes * MIB) });
}

/** JSON is also the full human view: it exposes scope and health without hiding fields. */
function hasIndexErrors(result: unknown): boolean {
    return isJsonObject(result) && Array.isArray(result.errors) && result.errors.length > 0;
}

export async function dataCommand(operation: DataOperation, options: DataCommandOptions, argument?: string): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const result = await runDataOperation(operation, options, argument);
        output(mode, result, { json: () => result, normal: () => JSON.stringify(result, null, 2), short: () => JSON.stringify(result) });
        if (hasIndexErrors(result)) process.exitCode = 1;
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
