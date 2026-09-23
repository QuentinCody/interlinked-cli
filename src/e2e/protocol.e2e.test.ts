import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

describe.each(["raw", "framed", "dual"] as const)("%s daemon boundary", (mode) => {
    let fixture: E2eFixture;
    beforeAll(async () => { fixture = await createFixture({ protocol: mode }); });
    afterAll(async () => { await fixture?.close(); });
    const protocols = mode === "dual" ? ["raw", "framed"] as const : [mode];
    for (const protocol of protocols) {
        it(`${protocol} serves an allowed read through the built hook`, async () => {
            const result = await fixture.hook({ protocol, tool: "Read", input: { file_path: "README.md" } });
            fixture.assertServed(result);
            expect(result.code).toBe(0);
            expect(result.stdout).not.toContain('"deny"');
        });
        it(`${protocol} blocks a destructive command and records daemon activity`, async () => {
            const result = await fixture.hook({ protocol, tool: "Bash", input: { command: "rm -rf /" } });
            fixture.assertServed(result);
            expect(result.stdout).toContain('"deny"');
            expect(fixture.ledger("activity.jsonl")).toEqual(expect.arrayContaining([
                expect.objectContaining({ writer: "daemon", session: result.sessionId }),
            ]));
        });
        it(`${protocol} suppresses a repeated Stop without claiming daemon service`, async () => {
            const result = await fixture.hook({ protocol, event: "Stop", payload: { stop_hook_active: true } });
            expect(result.receipt?.outcome).toBe("suppressed");
            expect(() => fixture.assertServed(result)).toThrow();
            expect(result.code).toBe(0);
            expect(result.stdout).toBe("");
        });
        it(`${protocol} records cold fallback when its socket is unreachable`, async () => {
            const result = await fixture.hook({ protocol, cold: true, tool: "Bash", input: { command: "rm -rf /" } });
            expect(result.fellBack).toBe(true);
            expect(() => fixture.assertServed(result)).toThrow();
            expect(result.receipt?.outcome).toBe("cold");
            expect(result.stdout).toContain('"deny"');
        });
    }
});
