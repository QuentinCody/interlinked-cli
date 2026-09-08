import { describe, expect, it, vi } from "vitest";
import handler from "./index.js";

type Env = Parameters<typeof handler.fetch>[1];

function fixture() {
    const rows = new Map<string, string>();
    const get = vi.fn<Env["WAITLIST_KV"]["get"]>(async (key) => rows.get(key) ?? null);
    const put = vi.fn<Env["WAITLIST_KV"]["put"]>(async (key, value) => { rows.set(key, value); });
    const list = vi.fn<Env["WAITLIST_KV"]["list"]>(async () => ({
        keys: [...rows.keys()].map((name) => ({ name })), list_complete: true,
    }));
    const assets = vi.fn<Env["ASSETS"]["fetch"]>(async () => new Response("asset"));
    const env: Env = { ASSETS: { fetch: assets }, WAITLIST_KV: { get, put, list }, ADMIN_TOKEN: "test-admin" };
    return { env, rows, get, put, list, assets };
}

function joinRequest(body: unknown): Request {
    return new Request("https://landing.example/api/waitlist", {
        method: "POST", body: JSON.stringify(body),
        headers: { "content-type": "application/json", "user-agent": "test-agent", "cf-ipcountry": "US" },
    });
}

function exportRequest(query = "", token = "test-admin"): Request {
    return new Request(`https://landing.example/api/waitlist/export${query}`, {
        headers: { authorization: `Bearer ${token}` },
    });
}

function storedRow(email: string, joinedAt = "2026-09-01T00:00:00.000Z") {
    return { email, joined_at: joinedAt, source: "landing", user_agent: "test-agent", country: "US" };
}

describe("landing waitlist", () => {
    it("normalizes an address and persists the submitted signup fields", async () => {
        const f = fixture();
        const response = await handler.fetch(joinRequest({ email: " Person@Example.com ", source: "hero" }), f.env);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        const raw = f.rows.get("wl:person@example.com");
        expect(raw).toBeDefined();
        const row: unknown = JSON.parse(raw ?? "null");
        expect(row).toEqual({
            email: "person@example.com", joined_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            source: "hero", user_agent: "test-agent", country: "US",
        });
        expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it.each([null, [], "address@example.com", {}, { email: "bad" }, { email: "a b@example.com" }, { email: 42 }, { email: `${"a".repeat(255)}@example.com` }])(
        "rejects invalid signup data without writing: %j", async (body) => {
            const f = fixture();
            const response = await handler.fetch(joinRequest(body), f.env);
            expect(response.status).toBe(400);
            expect(f.put).not.toHaveBeenCalled();
        },
    );

    it("rejects malformed JSON", async () => {
        const f = fixture();
        const response = await handler.fetch(new Request("https://landing.example/api/waitlist", { method: "POST", body: "{" }), f.env);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "body must be JSON" });
        expect(f.get).not.toHaveBeenCalled();
    });

    it("silently accepts the honeypot without reading or storing an address", async () => {
        const f = fixture();
        const response = await handler.fetch(joinRequest({ email: "bot@example.com", website: "spam" }), f.env);
        expect(await response.json()).toEqual({ ok: true });
        expect(f.get).not.toHaveBeenCalled();
        expect(f.put).not.toHaveBeenCalled();
    });

    it("preserves an existing signup instead of replacing its date", async () => {
        const f = fixture();
        const row = JSON.stringify(storedRow("person@example.com"));
        f.rows.set("wl:person@example.com", row);
        const response = await handler.fetch(joinRequest({ email: "PERSON@example.com" }), f.env);
        expect(await response.json()).toEqual({ ok: true, already: true });
        expect(f.rows.get("wl:person@example.com")).toBe(row);
        expect(f.put).not.toHaveBeenCalled();
    });

    it("returns a retryable JSON failure when storage cannot persist a signup", async () => {
        const f = fixture();
        f.put.mockRejectedValueOnce(new Error("private storage error"));
        const response = await handler.fetch(joinRequest({ email: "person@example.com" }), f.env);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "waitlist temporarily unavailable; try again" });
    });
});

describe("landing export and routing", () => {
    it("requires the admin token before reading stored addresses", async () => {
        const f = fixture();
        const unauthorized = await handler.fetch(exportRequest("", "wrong"), f.env);
        expect(unauthorized.status).toBe(401);
        delete f.env.ADMIN_TOKEN;
        const disabled = await handler.fetch(exportRequest(), f.env);
        expect(disabled.status).toBe(404);
        expect(f.list).not.toHaveBeenCalled();
        expect(f.get).not.toHaveBeenCalled();
    });

    it("exports a bounded page with a continuation cursor and no caching", async () => {
        const f = fixture();
        const earlier = storedRow("early@example.com");
        const later = storedRow("late@example.com", "2026-09-02T00:00:00.000Z");
        f.rows.set("wl:late@example.com", JSON.stringify(later));
        f.rows.set("wl:early@example.com", JSON.stringify(earlier));
        f.list.mockResolvedValueOnce({ keys: [...f.rows.keys()].map((name) => ({ name })), list_complete: false, cursor: "next-page" });
        const response = await handler.fetch(exportRequest("?cursor=previous-page"), f.env);
        expect(f.list).toHaveBeenCalledWith({ prefix: "wl:", limit: 250, cursor: "previous-page" });
        expect(await response.json()).toEqual({ count: 2, entries: [earlier, later], cursor: "next-page" });
        expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("preserves a cursor on an empty intermediate page", async () => {
        const f = fixture();
        f.list.mockResolvedValueOnce({ keys: [], list_complete: false, cursor: "next" });
        const response = await handler.fetch(exportRequest(), f.env);
        expect(await response.json()).toEqual({ count: 0, entries: [], cursor: "next" });
    });

    it("skips entries removed after listing and marks the final page", async () => {
        const f = fixture();
        f.list.mockResolvedValueOnce({ keys: [{ name: "wl:gone@example.com" }], list_complete: true });
        const response = await handler.fetch(exportRequest(), f.env);
        expect(await response.json()).toEqual({ count: 0, entries: [], cursor: null });
    });

    it.each(["{", "null", JSON.stringify({ email: "missing-fields@example.com" })])("reports corrupt persisted data: %s", async (raw) => {
        const f = fixture();
        f.rows.set("wl:broken@example.com", raw);
        const response = await handler.fetch(exportRequest(), f.env);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "stored waitlist entry is invalid" });
    });

    it("does not present a page without a required continuation as complete", async () => {
        const f = fixture();
        f.list.mockResolvedValueOnce({ keys: [], list_complete: false });
        const response = await handler.fetch(exportRequest(), f.env);
        expect(response.status).toBe(503);
    });

    it.each([["/api/waitlist", "GET", "POST"], ["/api/waitlist/export", "POST", "GET"]])(
        "rejects the wrong method for %s", async (path, method, allowed) => {
            const f = fixture();
            const response = await handler.fetch(new Request(`https://landing.example${path}`, { method }), f.env);
            expect(response.status).toBe(405);
            expect(response.headers.get("allow")).toBe(allowed);
            expect(f.assets).not.toHaveBeenCalled();
        },
    );

    it("serves health locally and delegates the landing page to static assets", async () => {
        const f = fixture();
        expect(await (await handler.fetch(new Request("https://landing.example/healthz"), f.env)).text()).toBe("ok");
        const request = new Request("https://landing.example/");
        expect(await (await handler.fetch(request, f.env)).text()).toBe("asset");
        expect(f.assets).toHaveBeenCalledWith(request);
    });
});
