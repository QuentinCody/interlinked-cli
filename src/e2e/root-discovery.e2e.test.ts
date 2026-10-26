import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

describe("built hook project-root discovery", () => {
    let fixture: E2eFixture;
    beforeAll(async () => { fixture = await createFixture({ protocol: "raw" }); });
    afterAll(async () => { await fixture?.close(); });

    // test-contract: bug — receipt-only .interlinked folders below a configured project must not shadow its daemon.
    it("finds the configured ancestor and guards a command beneath a stray receipt folder", async () => {
        const sentinel = '{"sentinel":"preexisting receipt"}\n';
        const receiptPath = fixture.file("scratch/.interlinked/hook-transport.jsonl", sentinel);
        const cwd = dirname(fixture.file("scratch/nested/README.md", "Nested fixture\n"));
        const result = await fixture.hook({ cwd, discoverSocket: true, tool: "Bash", input: { command: "rm -rf /" } });

        fixture.assertServed(result);
        expect(result.receipt.socket_path).toBe(fixture.paths.raw);
        expect(result.stdout).toContain('"deny"');
        // Activity attribution follows event.cwd; daemon transport receipts belong to the discovered project root.
        await vi.waitFor(() => {
            const rows = readFileSync(join(cwd, ".interlinked/activity.jsonl"), "utf8").trim().split("\n").map((line): unknown => JSON.parse(line));
            expect(rows).toEqual(expect.arrayContaining([
                expect.objectContaining({ writer: "daemon", event_id: result.receipt.event_id, session: result.sessionId }),
            ]));
        }, { timeout: 5000 });
        expect(readFileSync(receiptPath, "utf8")).toBe(sentinel);
        expect(readdirSync(dirname(receiptPath))).toEqual(["hook-transport.jsonl"]);
    });
});
