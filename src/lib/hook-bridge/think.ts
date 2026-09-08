import type { HookOutcome } from "../../harness/adapters/hook-contract.js";

export interface ThinkToolCall {
    toolName: string;
    toolCallId: string;
    input: unknown;
    abortSignal?: AbortSignal;
}
export type ToolPolicyDecision =
    | { action: "allow"; input?: unknown }
    | { action: "block"; reason: string }
    | { action: "ask"; reason: string }
    | { action: "substitute"; output: unknown };
export type ThinkToolDecision = Exclude<ToolPolicyDecision, { action: "ask" }>;
export interface HookBridgeIdentity { runtimeVersion: string; policyDigest: string; profileDigest: string }
export interface HookToolReceipt {
    identity: HookBridgeIdentity;
    id: string;
    provider: "cloudflare-think";
    sessionId: string;
    turnId: string;
    toolCallId: string;
    toolName: string;
    effectiveInput: unknown;
    outcome: HookOutcome;
}
export interface ToolJournalEntry {
    stage: "admitting" | "admitted" | "complete" | "identity_conflict";
    receipt: HookToolReceipt;
    delivery: "pending" | "delivered";
}
/** Application-owned durable storage. Creation and stage transitions MUST be
 * atomic and persist before resolving. A plain get-then-put is insufficient. */
export interface HookBridgeJournal {
    create(key: string, entry: ToolJournalEntry): Promise<boolean>;
    read(key: string): Promise<ToolJournalEntry | undefined>;
    transition(key: string, expected: ToolJournalEntry["stage"], entry: ToolJournalEntry): Promise<boolean>;
}
export interface BridgeOptions {
    identity: HookBridgeIdentity;
    sessionId: string;
    turnId: string;
    journal: HookBridgeJournal;
    evaluate: (call: ThinkToolCall, signal: AbortSignal) => Promise<ToolPolicyDecision>;
    /** Idempotent receiver: retries retain receipt.id. Throwing leaves delivery pending. */
    deliver: (receipt: HookToolReceipt) => Promise<void>;
    policyTimeoutMs?: number;
}

export interface ThinkHookBridge {
    beforeToolCall(call: ThinkToolCall): Promise<ThinkToolDecision>;
    afterToolCall(call: ThinkToolCall & { success: boolean; output?: unknown; error?: unknown }): Promise<void>;
    flush(toolCallId: string): Promise<boolean>;
}

function callKey(options: BridgeOptions, toolCallId: string): string {
    return JSON.stringify([options.sessionId, options.turnId, toolCallId]);
}

function initialEntry(options: BridgeOptions, call: ThinkToolCall): ToolJournalEntry {
    return { stage: "admitting", delivery: "pending", receipt: {
        id: callKey(options, call.toolCallId), identity: { ...options.identity }, provider: "cloudflare-think", sessionId: options.sessionId,
        turnId: options.turnId, toolCallId: call.toolCallId, toolName: call.toolName, effectiveInput: structuredClone(call.input),
        outcome: { policy: "unmeasured", execution: "not_started", tool_body_executed: false },
    } };
}

async function evaluateWithDeadline(options: BridgeOptions, call: ThinkToolCall): Promise<ToolPolicyDecision> {
    const controller = new AbortController();
    const signal = call.abortSignal ? AbortSignal.any([call.abortSignal, controller.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener = (): void => {};
    try {
        signal.throwIfAborted();
        return await Promise.race([
            options.evaluate(call, signal),
            new Promise<never>((_resolve, reject) => {
                const abort = (): void => reject(new Error("policy evaluation cancelled"));
                signal.addEventListener("abort", abort, { once: true });
                removeAbortListener = () => signal.removeEventListener("abort", abort);
                if (signal.aborted) abort();
            }),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Error("policy deadline exceeded")); }, options.policyTimeoutMs ?? 2000);
            }),
        ]);
    } finally { clearTimeout(timer); removeAbortListener(); }
}

function applyPolicy(entry: ToolJournalEntry, decision: ToolPolicyDecision): ThinkToolDecision {
    entry.stage = "admitted";
    if (decision.action === "ask") {
        entry.receipt.outcome.policy = "ask";
        return { action: "block", reason: `Approval required: ${decision.reason}` };
    }
    if (decision.action === "block") entry.receipt.outcome.policy = "deny";
    if (decision.action === "substitute") entry.receipt.outcome.policy = "substituted";
    if (decision.action === "allow") {
        entry.receipt.outcome.policy = "allow";
        entry.receipt.outcome.execution = "unknown";
        entry.receipt.outcome.tool_body_executed = "unknown";
        if (Object.hasOwn(decision, "input")) entry.receipt.effectiveInput = structuredClone(decision.input);
    }
    return decision;
}

/** Own these hooks in a Think subclass. Client-executed tools are outside this
 * boundary. Session and turn IDs must come from the application, not the model. */
export function createThinkHookBridge(options: BridgeOptions): ThinkHookBridge {
    validateBridgeOptions(options);
    options = { ...options, identity: { ...options.identity } };
    async function beforeToolCall(call: ThinkToolCall): Promise<ThinkToolDecision> {
        if (!call.toolCallId?.trim() || !call.toolName?.trim()) return { action: "block", reason: "Missing native tool-call identity" };
        const key = callKey(options, call.toolCallId);
        const entry = initialEntry(options, call);
        if (!await options.journal.create(key, entry)) return refuseDuplicate(options.journal, key);
        let result: ThinkToolDecision;
        try { result = applyPolicy(entry, await evaluateWithDeadline(options, call)); }
        catch (error) {
            entry.stage = "admitted";
            result = { action: "block", reason: `Policy NOT MEASURED: ${String(error)}` };
        }
        if (!await options.journal.transition(key, "admitting", entry)) return { action: "block", reason: "Admission identity changed; execution refused." };
        return result;
    }

    async function flush(toolCallId: string): Promise<boolean> {
        const key = callKey(options, toolCallId);
        const entry = await options.journal.read(key);
        if (!entry || entry.stage !== "complete") return false;
        if (entry.delivery === "delivered") return true;
        try { await options.deliver(entry.receipt); }
        catch { return false; }
        return options.journal.transition(key, "complete", { ...entry, delivery: "delivered" });
    }

    async function afterToolCall(call: ThinkToolCall & { success: boolean; output?: unknown; error?: unknown }): Promise<void> {
        const key = callKey(options, call.toolCallId);
        const entry = await options.journal.read(key);
        if (!entry || entry.stage !== "admitted") return;
        if (entry.receipt.toolName !== call.toolName) { await invalidateUnfinished(options.journal, key); return; }
        if (entry.receipt.outcome.policy === "allow") {
            entry.receipt.outcome.execution = call.success ? "succeeded" : "failed";
            entry.receipt.outcome.tool_body_executed = true;
        }
        entry.stage = "complete";
        if (await options.journal.transition(key, "admitted", entry)) await flush(call.toolCallId);
    }
    return { beforeToolCall, afterToolCall, flush };
}

function validateBridgeOptions(options: BridgeOptions): void {
    const fields = [options.sessionId, options.turnId, options.identity.runtimeVersion, options.identity.policyDigest, options.identity.profileDigest];
    if (fields.some(value => typeof value !== "string" || !value.trim())) throw new Error("Runtime, session, turn and policy identities must be explicit and nonempty");
    const timeout = options.policyTimeoutMs ?? 2000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) throw new Error("Policy timeout must be a positive timer interval");
}

async function refuseDuplicate(journal: HookBridgeJournal, key: string): Promise<ThinkToolDecision> {
    // Only admitting -> admitted -> complete can race this transition.
    for (let attempt = 0; attempt < 3; attempt++) {
        if (await invalidateUnfinished(journal, key)) break;
    }
    return { action: "block", reason: "Duplicate tool-call identity; execution admission refused." };
}

async function invalidateUnfinished(journal: HookBridgeJournal, key: string): Promise<boolean> {
    const previous = await journal.read(key);
    if (!previous || previous.stage === "complete" || previous.stage === "identity_conflict") return true;
    return journal.transition(key, previous.stage, { ...previous, stage: "identity_conflict", receipt: {
            ...previous.receipt, outcome: { policy: "unmeasured", execution: "unknown", tool_body_executed: "unknown" },
    } });
}
