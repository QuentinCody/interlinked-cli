import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../config.js";
import { isJsonObject, type JsonObject } from "../json-types.js";
import { readCaptureState } from "./state.js";
import { readDataLines } from "./stream.js";

/** The latest inventory is separate from historical incident/scan observation counts. */
export async function recurrenceInventory(cwd: string): Promise<JsonObject> {
    const path = join(getDataDir(cwd), "recurrence-scans.jsonl");
    if (!existsSync(path)) return { state: "not-recorded", scopes: [], action: "interlinked recurrence scan-codebase" };
    const latest = new Map<string, JsonObject>();
    for await (const line of readDataLines(path)) {
        if (!line.complete || line.text === undefined) throw new Error(`incomplete scan receipt at ${line.start}`);
        const row: unknown = JSON.parse(line.text);
        if (isJsonObject(row) && row.kind === "scan" && typeof row.scope_id === "string") latest.set(row.scope_id, row);
    }
    const scopes = [...latest].map(([id, receipt]) => {
        const state = readCaptureState(cwd, `recurrence-scan:${id}`);
        const available = state.scan_id === receipt.scan_id;
        const findings = available && Array.isArray(state.findings) ? state.findings : [];
        return { scope_id: id, receipt, state: available ? "available" : "unavailable", findings: findings.slice(0, 1000),
            more: findings.length > 1000, total: available ? findings.length : null };
    });
    return { state: "observed", scopes, scope: "latest observed inventory per scan scope; best-effort detectors; overlapping scopes are not additive" };
}
