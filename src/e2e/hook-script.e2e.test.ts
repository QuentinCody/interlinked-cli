import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

describe("self-contained generated hook", () => {
    let fixture: E2eFixture;
    beforeAll(async () => { fixture = await createFixture({ protocol: "raw" }); });
    afterAll(async () => { await fixture?.close(); });

    it("blocks through the daemon and correlates the daemon's guard record", async () => {
        const result = await fixture.hook({ runtime: "generated", protocol: "raw", tool: "Bash", input: { command: "rm -rf /" } });
        fixture.assertServed(result);
        expect(result.stdout).toContain('"deny"');
        expect(fixture.ledger("activity.jsonl")).toEqual(expect.arrayContaining([
            expect.objectContaining({ writer: "daemon", event_id: result.receipt.event_id, session: result.sessionId }),
        ]));
    });

    it("records repeated Stop suppression without daemon credit", async () => {
        const result = await fixture.hook({ runtime: "generated", event: "Stop", payload: { stop_hook_active: true } });
        expect(result.receipt.outcome).toBe("suppressed");
        expect(result.stdout).toBe("");
        expect(result.code).toBe(0);
    });

    it("forwards an ordinary Stop to the daemon", async () => {
        const result = await fixture.hook({ runtime: "generated", event: "Stop" });
        fixture.assertServed(result);
        expect(result.code).toBe(0);
    });
});
