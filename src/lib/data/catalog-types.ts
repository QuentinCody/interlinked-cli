import { DATA_TIME_FIELDS, type DataTimeField } from "../data-time.js";

export type DataCategory = "agent" | "quality" | "coordination" | "usage" | "runtime" | "audit" | "corpus" | "transport" | "unknown";
export type DataRole = "events" | "state-ledger" | "corpus" | "diagnostic";
export type DataRetention = "archive" | "preserve" | "diagnostic";

/** One logical source; physical segments retain their independent identities. */
export interface DataSource {
    name: string;
    path: string;
    category: DataCategory;
    role: DataRole;
    description: string;
    producer: string;
    trigger: string;
    readers: string[];
    schema: string | null;
    timestamps: readonly DataTimeField[];
    sessionFields: string[];
    actorFields: string[];
    callFields: string[];
    fields: string[];
    retention: DataRetention;
}

interface SourceDefinition {
    name: string;
    path?: string;
    category: DataCategory;
    role?: DataRole;
    description: string;
    producer: string;
    trigger?: string;
    fields?: string[];
    readers?: string[];
    schema?: string;
    retention?: DataRetention;
}

export function defineDataSource(input: SourceDefinition): DataSource {
    const role = input.role ?? "events";
    return {
        name: input.name, path: input.path ?? `${input.name}.jsonl`,
        category: input.category, role,
        description: input.description, producer: input.producer,
        trigger: input.trigger ?? "producer event; absence alone does not prove a failure",
        readers: input.readers ?? ["query", "data search"],
        schema: input.schema ?? null, timestamps: DATA_TIME_FIELDS,
        sessionFields: ["session_id", "session", "sessionId"],
        actorFields: ["subagent_id", "agent_id", "agent_name", "agent"],
        callFields: ["tool_use_id", "usage_id", "finding_id", "event_id", "uuid", "id"],
        fields: input.fields ?? ["kind", "type", "session_id"],
        retention: input.retention ?? (role === "state-ledger" || role === "corpus" ? "preserve" : "archive"),
    };
}
