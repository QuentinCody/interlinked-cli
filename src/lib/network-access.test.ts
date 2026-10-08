import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkNetworkAccess, classifyNetworkFailure, networkOrigins, probeNetworkOrigin } from "./network-access.js";

let server: Server | undefined;
afterEach(async () => {
    vi.unstubAllEnvs();
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
});

async function listen(status = 404, headers: Record<string, string> = {}): Promise<{ origin: string; requests: string[] }> {
    const requests: string[] = [];
    server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        res.writeHead(status, { Location: "http://unrequested.invalid/", ...headers });
        res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    return { origin: `http://127.0.0.1:${address.port}`, requests };
}

describe("runtime network evidence", () => {
    it("treats an HTTP error as transport access and does not request a supplied path", async () => {
        const fixture = await listen();
        const result = await checkNetworkAccess([`${fixture.origin}/paid-inference`], {
            CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1", CODEX_THREAD_ID: "blocked-session",
        });
        expect(result).toMatchObject({ reachable: true, scope: "current-process", runtime: {
            codex_sandbox: "seatbelt", network_disabled: true, thread_id: "blocked-session",
        }, probes: [{ endpoint: fixture.origin, reachable: true, http_status: 404 }] });
        expect(fixture.requests).toEqual(["HEAD /"]);
    });

    it("does not follow redirects to other destinations", async () => {
        const fixture = await listen(302);
        expect(await probeNetworkOrigin(fixture.origin)).toMatchObject({ reachable: true, http_status: 302 });
        expect(fixture.requests).toEqual(["HEAD /"]);
    });

    it("does not count a host proxy denial as service reachability", async () => {
        const fixture = await listen(403, { "x-proxy-error": "blocked-by-allowlist" });
        expect(await probeNetworkOrigin(fixture.origin)).toEqual({ endpoint: fixture.origin, reachable: false, failure: "proxy-policy" });
    });

    it("bounds stalled requests and reports unavailable evidence", async () => {
        server = createServer(() => {});
        await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No fixture port");
        vi.stubEnv("NO_PROXY", "127.0.0.1");
        vi.stubEnv("no_proxy", "127.0.0.1");
        expect(await probeNetworkOrigin(`http://127.0.0.1:${address.port}`, 100)).toMatchObject({ reachable: false, failure: "timeout" });
    });

    it.each([
        [7, "Operation not permitted", "permission-denied"], [6, "", "dns"],
        [7, "", "connection"], [28, "", "timeout"], [60, "", "tls"],
        ["ENOENT", "", "tool-unavailable"], [undefined, "", "other"],
    ])("classifies %s without blaming Interlinked", (code, stderr, expected) => {
        expect(classifyNetworkFailure(code, String(stderr))).toBe(expected);
    });

    it("normalizes and deduplicates origins", () => {
        expect(networkOrigins(["https://EXAMPLE.com/a", "https://example.com/b", "http://[::1]:11434"]))
            .toEqual(["https://example.com", "http://[::1]:11434"]);
    });

    it.each([[], Array(17).fill("https://example.com"), ["file:///tmp/probe"], ["https://user:pass@example.com"],
        ["https://example.com?token=value"], ["https://example.com#fragment"], ["https://*.example.com"], ["--proxy"]].map((endpoints) => [endpoints]))("rejects unsafe or unbounded input: %j", (endpoints) => {
        expect(() => networkOrigins(endpoints)).toThrow();
    });
});
