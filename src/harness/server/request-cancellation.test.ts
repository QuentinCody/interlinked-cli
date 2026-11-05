import { describe, expect, it } from "vitest";
import { currentRequestSignal, withRequestCancellation } from "./request-cancellation.js";

describe("request cancellation — positive (must fire)", () => {
    // test-contract: public-api — work started under a request sees that request's signal, across awaits
    it("P1: exposes the request signal to nested asynchronous work", async () => {
        const controller = new AbortController();
        const seen = await withRequestCancellation(controller.signal, async () => {
            await Promise.resolve();
            const inner = await (async () => { await Promise.resolve(); return currentRequestSignal(); })();
            return [currentRequestSignal(), inner];
        });
        expect(seen).toEqual([controller.signal, controller.signal]);
        controller.abort();
        expect(seen[0]?.aborted).toBe(true);
    });

    // test-contract: public-api — two concurrent requests keep their own signals
    it("P2: keeps concurrent requests apart", async () => {
        const first = new AbortController(), second = new AbortController();
        const [a, b] = await Promise.all([
            withRequestCancellation(first.signal, async () => { await new Promise(resolve => setTimeout(resolve, 5)); return currentRequestSignal(); }),
            withRequestCancellation(second.signal, async () => currentRequestSignal()),
        ]);
        expect(a).toBe(first.signal);
        expect(b).toBe(second.signal);
    });
});

describe("request cancellation — negative (must not fire)", () => {
    // test-contract: invariant — outside a transport-owned request there is no signal, so durable work cannot be cancelled by accident
    it("N1: reports no signal outside a request", () => {
        expect(currentRequestSignal()).toBeUndefined();
    });
});
