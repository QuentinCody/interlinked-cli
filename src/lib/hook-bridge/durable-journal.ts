import { isJsonObject, type JsonObject } from "../json-types.js";
import type { HookBridgeJournal, HookToolReceipt, ToolJournalEntry } from "./think.js";

interface JournalTransaction {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
}
/** Structurally compatible with Durable Object storage transactions. */
export interface JournalStorage {
    transaction<T>(work: (transaction: JournalTransaction) => Promise<T>): Promise<T>;
}

function textField(raw: JsonObject, key: string): string {
    const value = raw[key];
    if (typeof value !== "string") throw new Error(`Invalid hook journal ${key}`);
    return value;
}

function literal<T extends string | boolean>(value: unknown, allowed: readonly T[]): T {
    const found = allowed.find(candidate => candidate === value);
    if (found === undefined) throw new Error("Invalid hook journal enum");
    return found;
}

function receiptOf(raw: unknown): HookToolReceipt {
    if (!isJsonObject(raw) || !isJsonObject(raw.outcome)) throw new Error("Invalid hook journal receipt");
    if (!isJsonObject(raw.identity)) throw new Error("Missing hook runtime/policy identity");
    return {
        identity: { runtimeVersion: textField(raw.identity, "runtimeVersion"), policyDigest: textField(raw.identity, "policyDigest"), profileDigest: textField(raw.identity, "profileDigest") },
        id: textField(raw, "id"), provider: literal(raw.provider, ["cloudflare-think"]),
        sessionId: textField(raw, "sessionId"), turnId: textField(raw, "turnId"),
        toolCallId: textField(raw, "toolCallId"), toolName: textField(raw, "toolName"), effectiveInput: raw.effectiveInput,
        outcome: {
            policy: literal(raw.outcome.policy, ["unmeasured", "allow", "deny", "ask", "defer", "substituted"]),
            execution: literal(raw.outcome.execution, ["unknown", "not_started", "running", "succeeded", "failed", "cancelled"]),
            tool_body_executed: literal(raw.outcome.tool_body_executed, [true, false, "unknown"]),
        },
    };
}

function entryOf(raw: unknown): ToolJournalEntry | undefined {
    if (raw === undefined) return undefined;
    if (!isJsonObject(raw)) throw new Error("Invalid hook journal entry");
    return { stage: literal(raw.stage, ["admitting", "admitted", "complete", "identity_conflict"]), delivery: literal(raw.delivery, ["pending", "delivered"]), receipt: receiptOf(raw.receipt) };
}

/** Persist every admission before the native tool can execute. */
export function createDurableHookJournal(storage: JournalStorage): HookBridgeJournal {
    const keyOf = (key: string): string => `interlinked:hooks:${key}`;
    return {
        create: (key, entry) => storage.transaction(async tx => {
            if (await tx.get(keyOf(key)) !== undefined) return false;
            await tx.put(keyOf(key), entry);
            return true;
        }),
        read: key => storage.transaction(async tx => entryOf(await tx.get(keyOf(key)))),
        transition: (key, expected, entry) => storage.transaction(async tx => {
            const previous = entryOf(await tx.get(keyOf(key)));
            if (previous?.stage !== expected) return false;
            await tx.put(keyOf(key), entry);
            return true;
        }),
    };
}
