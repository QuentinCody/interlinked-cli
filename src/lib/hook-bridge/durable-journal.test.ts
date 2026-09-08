import { describe, expect, it } from "vitest";
import { createDurableHookJournal, type JournalStorage } from "./durable-journal.js";
import type { ToolJournalEntry } from "./think.js";

function storage(): JournalStorage {
    const rows = new Map<string, unknown>();
    let previous: Promise<unknown> = Promise.resolve();
    return { transaction(work) {
        const next = previous.then(() => work({ get: async key => rows.get(key), put: async (key, value) => { rows.set(key, structuredClone(value)); } }));
        previous = next.catch(() => {});
        return next;
    } };
}
const entry: ToolJournalEntry = { stage: "admitting", delivery: "pending", receipt: { id: "k", provider: "cloudflare-think", identity: { runtimeVersion: "test", policyDigest: "policy-1", profileDigest: "profile-1" }, sessionId: "s", turnId: "t", toolCallId: "c", toolName: "write", effectiveInput: {}, outcome: { policy: "unmeasured", execution: "not_started", tool_body_executed: false } } };

describe("transactional hook journal", () => {
    it("admits only one concurrent creator and rejects stale transitions", async () => {
        const journal = createDurableHookJournal(storage());
        expect(await Promise.all([journal.create("k", entry), journal.create("k", entry)])).toEqual([true, false]);
        expect(await journal.transition("k", "admitting", { ...entry, stage: "admitted" })).toBe(true);
        expect(await journal.transition("k", "admitting", { ...entry, stage: "complete" })).toBe(false);
        expect((await journal.read("k"))?.stage).toBe("admitted");
    });

    it("refuses corrupt stored records", async () => {
        const backend = storage();
        await backend.transaction(async tx => { await tx.put("interlinked:hooks:k", { stage: "admitted" }); });
        await expect(createDurableHookJournal(backend).read("k")).rejects.toThrow();
    });
});
