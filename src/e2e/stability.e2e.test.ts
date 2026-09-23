import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

describe("daemon sustained traffic", () => {
    let fixture: E2eFixture;
    beforeAll(async () => { fixture = await createFixture({ protocol: "dual" }); });
    afterAll(async () => { await fixture?.close(); });
    it("serves a built hook and 100 socket events within the one-second p99 budget", async () => {
        const result = await fixture.hook({ tool: "Read", input: { file_path: "README.md" } });
        fixture.assertServed(result);
        const elapsed: number[] = [];
        for (let index = 0; index < 100; index++) {
            const start = performance.now();
            await fixture.readOverSocket(`${fixture.sessionPrefix}-${index % 10}`, index % 2 ? "raw" : "framed");
            elapsed.push(performance.now() - start);
        }
        expect(elapsed.sort((a, b) => a - b)[98]).toBeLessThan(1_000);
    });
    it.skipIf(process.env.E2E_STABILITY !== "1")("survives 5000 events across 100 sessions without a restart or excessive RSS", async () => {
        const pid = fixture.pid;
        const elapsed: number[] = [];
        for (let index = 0; index < 5_000; index++) {
            const start = performance.now();
            await fixture.readOverSocket(`${fixture.sessionPrefix}-stress-${index % 100}`, index % 2 ? "raw" : "framed");
            elapsed.push(performance.now() - start);
        }
        expect(fixture.pid).toBe(pid);
        fixture.assertOwner("raw");
        fixture.assertOwner("framed");
        expect(elapsed.sort((a, b) => a - b)[4_949]).toBeLessThan(2_000);
        const rssKb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
        expect(rssKb).toBeGreaterThan(0);
        expect(rssKb / 1024).toBeLessThan(2_000);
    }, 180_000);
});
