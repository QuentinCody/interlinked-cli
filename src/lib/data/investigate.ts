import type { JsonObject } from "../json-types.js";
import { searchData, type DataSearchOptions } from "./search.js";
import { dataIndexStatus } from "./health.js";
import { dataOpenObligations } from "./obligation-view.js";

function evidenceStage(row: JsonObject): string {
    if (["check-results", "check-executions"].includes(String(row.source))) return "checks";
    if (row.source === "suggestion-outcomes") return "subsequent-observation";
    if (String(row.kind).startsWith("guard_")) return "guard-verdict";
    if (["pre", "PreToolUse", "BeforeTool"].includes(String(row.phase))) return "tool-attempt";
    if (["post", "PostToolUse", "AfterTool", "PostToolUseFailure"].includes(String(row.phase))) return "tool-completion";
    return "context";
}
function correlatedCalls(rows: JsonObject[]): JsonObject[] {
    const groups = new Map<string, JsonObject[]>();
    for (const row of rows) {
        if (row.call_id === null) continue;
        const key = JSON.stringify([row.provider, row.session, row.actor, row.call_id]);
        const values = groups.get(key) ?? []; values.push(row); groups.set(key, values);
    }
    return [...groups.values()].map((records) => {
        const first = records[0] ?? {};
        const stages = [...new Set(records.map(evidenceStage))];
        return { provider: first.provider, session: first.session, actor: first.actor, call_id: first.call_id,
            stages_observed: stages, not_observed_in_result: ["tool-attempt", "guard-verdict", "tool-completion", "checks", "subsequent-observation"].filter((stage) => !stages.includes(stage)),
            evidence_ids: records.map((record) => record.id) };
    });
}

/** Correlate exact identities only. Missing phases stay explicitly unobserved. */
export async function investigateData(cwd: string, options: DataSearchOptions): Promise<JsonObject> {
    if (!options.session && !options.file && !options.call) throw new Error("investigate requires --session, --file, or --call");
    const result = searchData(cwd, { ...options, limit: options.limit ?? 200 });
    const records = [...result.rows].reverse();
    return { records, calls: correlatedCalls(records), more: result.more,
        open_obligations: options.file ? await dataOpenObligations(cwd, options.file) : null,
        index: dataIndexStatus(cwd), scope: "bounded indexed observations in event-time order; call identity is provider/session/actor/id; missing identity is never guessed; opens via data show <id>" };
}
