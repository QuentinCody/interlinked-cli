import { describe, expect, it } from "vitest";
import { createThinkHookBridge, type HookBridgeJournal, type ToolJournalEntry } from "./think.js";

function journal(): HookBridgeJournal {
    const rows = new Map<string, ToolJournalEntry>();
    return {
        async create(key, row) { if (rows.has(key)) return false; rows.set(key, structuredClone(row)); return true; },
        async read(key) { return structuredClone(rows.get(key)); },
        async transition(key, expected, row) {
            if (rows.get(key)?.stage !== expected) return false;
            rows.set(key, structuredClone(row)); return true;
        },
    };
}
const call = { toolName: "write", toolCallId: "call-1", input: { value: 1 } };

describe("Think policy/execution bridge", () => {
    it("refuses an expired policy evaluation without admitting execution", async () => {
        const bridge = createThinkHookBridge({ identity: { runtimeVersion: "test", policyDigest: "policy-1", profileDigest: "profile-1" }, sessionId: "s", turnId: "t", journal: journal(), policyTimeoutMs: 5,
            evaluate: async () => new Promise(() => {}), deliver: async () => {} });
        expect(await bridge.beforeToolCall(call)).toMatchObject({ action: "block", reason: expect.stringContaining("NOT MEASURED") });
    });
    it("requires explicit identities and rejects a missing tool-call identity", async () => {
        const options = { identity: { runtimeVersion: "test", policyDigest: "policy-1", profileDigest: "profile-1" }, sessionId: "s", turnId: "t", journal: journal(), evaluate: async () => ({ action: "allow" } as const), deliver: async () => {} };
        expect(() => createThinkHookBridge({ ...options, turnId: "" })).toThrow("identities");
        expect(await createThinkHookBridge(options).beforeToolCall({ ...call, toolCallId: "" })).toMatchObject({ action: "block" });
    });
    it("cancels a policy call that ignores the supplied abort signal before admission", async () => {
        let signalStarted = (): void => {};
        const started = new Promise<void>(resolve => { signalStarted = resolve; });
        const controller = new AbortController();
        const bridge = createThinkHookBridge({ identity: { runtimeVersion: "test", policyDigest: "policy-1", profileDigest: "profile-1" }, sessionId: "s", turnId: "t", journal: journal(),
            evaluate: async () => { signalStarted(); return new Promise(() => {}); }, deliver: async () => {} });
        const pending = bridge.beforeToolCall({ ...call, abortSignal: controller.signal });
        await started;
        controller.abort();
        expect(await pending).toMatchObject({ action: "block", reason: expect.stringContaining("cancelled") });
    });
    it("does not evaluate or admit when durable creation fails", async () => {
        let evaluations = 0;
        const storage = journal();
        storage.create = async () => { throw new Error("storage offline"); };
        const bridge = createThinkHookBridge({ identity: { runtimeVersion: "test", policyDigest: "policy-1", profileDigest: "profile-1" }, sessionId: "s", turnId: "t", journal: storage,
            evaluate: async () => { evaluations++; return { action: "allow" }; }, deliver: async () => {} });
        await expect(bridge.beforeToolCall(call)).rejects.toThrow("storage offline");
        expect(evaluations).toBe(0);
    });
    it("records a blocked successful result as not executed", async () => {
        const outcomes: unknown[] = [];
        const bridge = createThinkHookBridge({ identity: { runtimeVersion: "test", policyDigest: "policy-1", profileDigest: "profile-1" }, sessionId: "s", turnId: "t", journal: journal(), evaluate: async () => ({ action: "block", reason: "reserved" }), deliver: async outcome => { outcomes.push(outcome); } });
        expect(await bridge.beforeToolCall(call)).toEqual({ action: "block", reason: "reserved" });
        await bridge.afterToolCall({ ...call, success: true, output: "reserved" });
        expect(outcomes).toEqual([expect.objectContaining({ outcome: { policy: "deny", execution: "not_started", tool_body_executed: false } })]);
    });

    it("preserves the rewritten input instead of trusting Think's original after-hook input", async () => {
        const outcomes: unknown[] = [];
        const bridge = createThinkHookBridge({ identity: { runtimeVersion: "test", policyDigest: "policy-1", profileDigest: "profile-1" }, sessionId: "s", turnId: "t", journal: journal(), evaluate: async () => ({ action: "allow", input: { value: 2 } }), deliver: async result => { outcomes.push(result); } });
        expect(await bridge.beforeToolCall(call)).toEqual({ action: "allow", input: { value: 2 } });
        await bridge.afterToolCall({ ...call, success: true, output: "done" });
        expect(outcomes[0]).toMatchObject({ effectiveInput: { value: 2 }, outcome: { policy: "allow", execution: "succeeded", tool_body_executed: true } });
    });

    it("retains undelivered results across bridge instances without re-executing the tool", async () => {
        const storage = journal();
        const bridge = createThinkHookBridge({ identity: { runtimeVersion: "test", policyDigest: "policy-1", profileDigest: "profile-1" }, sessionId: "s", turnId: "t", journal: storage, evaluate: async () => ({ action: "substitute", output: "cached" }), deliver: async () => { throw new Error("offline"); } });
        await bridge.beforeToolCall(call);
        await bridge.afterToolCall({ ...call, success: true, output: "cached" });
        const delivered: unknown[] = [];
        const resumed = createThinkHookBridge({ identity: { runtimeVersion: "test", policyDigest: "policy-1", profileDigest: "profile-1" }, sessionId: "s", turnId: "t", journal: storage, evaluate: async () => { throw new Error("must not evaluate again"); }, deliver: async value => { delivered.push(value); } });
        expect(await resumed.flush(call.toolCallId)).toBe(true);
        expect(delivered[0]).toMatchObject({ outcome: { policy: "substituted", execution: "not_started", tool_body_executed: false } });
        expect(await resumed.beforeToolCall(call)).toMatchObject({ action: "block" });
    });

    it("fails closed on unavailable policy and denies duplicate concurrent admission", async () => {
        const bridge = createThinkHookBridge({ identity: { runtimeVersion: "test", policyDigest: "policy-1", profileDigest: "profile-1" }, sessionId: "s", turnId: "t", journal: journal(), evaluate: async () => { throw new Error("offline"); }, deliver: async () => {} });
        const results = await Promise.all([bridge.beforeToolCall(call), bridge.beforeToolCall(call)]);
        expect(results.every(result => result.action === "block")).toBe(true);
    });

    it("does not mistake a duplicate's synthetic success for execution of an admitted call", async () => {
        const receipts: unknown[] = [];
        const bridge = createThinkHookBridge({ identity: { runtimeVersion: "test", policyDigest: "policy-1", profileDigest: "profile-1" }, sessionId: "s", turnId: "t", journal: journal(), evaluate: async () => ({ action: "allow" }), deliver: async value => { receipts.push(value); } });
        expect((await bridge.beforeToolCall(call)).action).toBe("allow");
        expect((await bridge.beforeToolCall(call)).action).toBe("block");
        await bridge.afterToolCall({ ...call, success: true, output: "duplicate blocked" });
        expect(receipts).toEqual([]);
    });
});
