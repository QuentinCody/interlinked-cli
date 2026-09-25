// Unit E2: the recording proxy the supervisor puts in front of an OWNED app
// so a browser case's requests are observed by the supervisor itself —
// case-correlated boundary evidence that no test can self-declare.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startRecordingProxy, type RecordingProxy } from "./proxy.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function app(): Promise<{ port: number; hits: string[] }> {
    const hits: string[] = [];
    // interlinked-ignore: ubs_hardcoded_localhost — the upstream under test is loopback by construction
    const server: Server = createServer((request, response) => { hits.push(`${request.method} ${request.url}`); response.writeHead(request.url === "/missing" ? 404 : 200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, echo: request.url })); });
    cleanups.push(() => new Promise(resolve => server.close(() => resolve())));
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => { const address = server.address(); resolve({ port: typeof address === "object" && address ? address.port : 0, hits }); }));
}
async function proxyFor(port: number): Promise<RecordingProxy> {
    const proxy = await startRecordingProxy(port);
    cleanups.push(() => proxy.close());
    return proxy;
}

describe("recording proxy — positive (forwards and records)", () => {
    it("P1: forwards method, path, body and status to the owned app and records every request with its instant", async () => {
        const upstream = await app();
        const proxy = await proxyFor(upstream.port);
        const before = Date.now();
        const created = await fetch(`${proxy.baseUrl}/orders`, { method: "POST", body: JSON.stringify({ name: "widget" }), headers: { "content-type": "application/json" } });
        expect(created.status).toBe(200);
        expect(await created.json()).toEqual({ ok: true, echo: "/orders" });
        expect((await fetch(`${proxy.baseUrl}/missing`)).status).toBe(404);
        expect(upstream.hits).toEqual(["POST /orders", "GET /missing"]);
        expect(proxy.requests.map(row => [row.method, row.path, row.status])).toEqual([["POST", "/orders", 200], ["GET", "/missing", 404]]);
        expect(proxy.requests.every(row => row.atMs >= before && row.atMs <= Date.now())).toBe(true);
    });
    it("P2: requestsBetween attributes by instant window and never invents a hit outside it", async () => {
        const upstream = await app();
        const proxy = await proxyFor(upstream.port);
        await fetch(`${proxy.baseUrl}/a`);
        const stamp = proxy.requests[0]!.atMs;
        expect(proxy.requestsBetween(stamp - 10, stamp + 10)).toHaveLength(1);
        expect(proxy.requestsBetween(stamp + 1, stamp + 1000)).toHaveLength(0);
    });
});
describe("recording proxy — negative", () => {
    it("N1: an upstream that is gone answers 502 through the proxy and the failure is recorded, not hidden", async () => {
        const upstream = await app();
        const proxy = await proxyFor(upstream.port);
        await cleanups.shift()!(); // close the upstream only
        const response = await fetch(`${proxy.baseUrl}/orders`);
        expect(response.status).toBe(502);
        expect(proxy.requests).toEqual([expect.objectContaining({ method: "GET", path: "/orders", status: 502 })]);
    });
});
